// src/lib/gemini.js
// Robust Gemini caller: handles model id normalization, endpoint differences (generateText vs generateContent),
// Bearer vs API key, full response logging for debugging.

let fetchFn = null;
if (typeof globalThis.fetch === 'function') {
  fetchFn = globalThis.fetch.bind(globalThis);
} else {
  try {
    fetchFn = require('node-fetch');
  } catch (e) {
    throw new Error("Fetch API not found. Install node-fetch v2: `npm install node-fetch@2` or run on Node 18+.");
  }
}
const fetch = fetchFn;

const RAW_KEY = process.env.GEMINI_API_KEY || '';
const ENV_MODEL = process.env.GEMINI_MODEL || 'models/gemini-2.0-flash-lite';

function normalizeModelId(model) {
  if (!model) return model;
  return String(model).replace(/^models\//i, '');
}

function isLikelyBearer(token) {
  return typeof token === 'string' && token.startsWith('ya29');
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = 30000) {
  // minimal timeout wrapper
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const signal = controller ? controller.signal : undefined;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetch(url, Object.assign({}, opts, signal ? { signal } : {}));
    return res;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function callApi(modelId, endpoint, useBearer, cred, bodyObj) {
  // modelId should be normalized (no 'models/' prefix)
  const base = `https://generativelanguage.googleapis.com/v1/models/${encodeURIComponent(modelId)}:${endpoint}`;
  const url = useBearer ? base : `${base}?key=${encodeURIComponent(cred)}`;
  const headers = { 'Content-Type': 'application/json' };
  if (useBearer) headers['Authorization'] = `Bearer ${cred}`;

  try {
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(bodyObj)
    }, 60000);
    const text = await res.text().catch(()=>null);
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
    return { status: res.status, ok: res.ok, text, json };
  } catch (e) {
    return { status: 0, ok: false, text: null, json: null, error: e.message || String(e) };
  }
}

function buildRequestBodyForModel(is25plus, promptText, opts = {}) {
  if (is25plus) {
    // generateContent format
    return {
      contents: [
        {
          role: "user",
          parts: [{ text: promptText }]
        }
      ],
      generationConfig: {
        temperature: opts.temperature ?? 0.2,
        maxOutputTokens: opts.maxTokens ?? (opts.maxTokens === 0 ? 0 : 512),
        topP: opts.topP,
        topK: opts.topK
      }
    };
  } else {
    // generateText format
    return {
      prompt: { text: promptText },
      temperature: opts.temperature ?? 0.2,
      maxOutputTokens: opts.maxTokens ?? 512
    };
  }
}

function extractTextFromResponse(is25plus, respJson, respText) {
  if (!respJson && respText) return respText;
  try {
    if (is25plus) {
      // expected: { candidates: [ { content: { parts: [ { text: "..." } ] } } ] }
      const t = respJson?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (t) return t;
      // fallback: sometimes content.parts is array of strings or other shape
      const alt = respJson?.candidates?.[0]?.content?.parts;
      if (Array.isArray(alt)) {
        // join any text parts
        return alt.map(p => (typeof p === 'string' ? p : p?.text)).filter(Boolean).join("\n");
      }
    } else {
      // expected older shape: { candidates: [ { output: "..." } ] } or { output: { text: "..." } }
      const c1 = respJson?.candidates?.[0]?.output;
      if (typeof c1 === 'string' && c1.length) return c1;
      if (typeof c1 === 'object' && c1?.text) return c1.text;
      const out = respJson?.output;
      if (typeof out === 'string' && out.length) return out;
      if (typeof out === 'object' && out?.text) return out.text;
    }
  } catch (e) {
    // ignore and fallback to raw
  }
  // final fallback: stringify JSON or raw text
  try { return JSON.stringify(respJson || respText); } catch (e) { return String(respText || ''); }
}

async function generateText(prompt, opts = {}) {
  if (!RAW_KEY) throw new Error('GEMINI_API_KEY not configured (set GEMINI_API_KEY to API key or OAuth token)');

  // build normalized fallback model list (keep ENV_MODEL first)
  const rawList = Array.from(new Set([
    ENV_MODEL,
    'models/gemini-2.5-flash',
    'models/gemini-2.5-pro',
    'models/gemini-2.0-flash-001',
    'models/gemini-2.0-flash',
    'models/text-bison-001',
    'text-bison-001'
  ].filter(Boolean)));
  const models = rawList.map(normalizeModelId);

  const tryBearerFirst = isLikelyBearer(RAW_KEY);

  let lastErr = null;

  for (const modelId of models) {
    // decide endpoint based on model version: gemini-2.5* -> generateContent, older -> generateText
    const is25plus = /^gemini-2\.5/i.test(modelId) || /^gemini-2\.5/.test(modelId);
    const endpoint = is25plus ? 'generateContent' : 'generateText';
    const body = buildRequestBodyForModel(is25plus, prompt, opts);

    // Try Bearer if key looks like OAuth token
    if (tryBearerFirst) {
      const r = await callApi(modelId, endpoint, true, RAW_KEY, body);
      if (r.ok) {
        return extractTextFromResponse(is25plus, r.json, r.text);
      } else {
        lastErr = `Bearer call model=${modelId} endpoint=${endpoint} status=${r.status} body=${r.text || JSON.stringify(r.json) || r.error || '<no-body>'}`;
        console.warn(lastErr);
      }
    }

    // Try API key (query param)
    const r2 = await callApi(modelId, endpoint, false, RAW_KEY, body);
    if (r2.ok) {
      return extractTextFromResponse(is25plus, r2.json, r2.text);
    } else {
      lastErr = `API-key call model=${modelId} endpoint=${endpoint} status=${r2.status} body=${r2.text || JSON.stringify(r2.json) || r2.error || '<no-body>'}`;
      console.warn(lastErr);
    }

    // if neither succeeded, continue to next fallback model
  }

  throw new Error(`Gemini API error (all attempts failed). Last: ${lastErr}`);
}

module.exports = { generateText };
