// src/lib/gemini.js
const { fetch } = require('./fetcher');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-1.5';

async function generateText(prompt, opts = {}) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not configured');

  const url = `https://generativelanguage.googleapis.com/v1/models/${encodeURIComponent(GEMINI_MODEL)}:generateText`;
  const body = {
    prompt: { text: prompt },
    temperature: opts.temperature ?? 0.2,
    maxOutputTokens: opts.maxTokens ?? 512
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GEMINI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Gemini API error: ${res.status} ${txt}`);
  }
  const data = await res.json();
  if (data?.candidates && data.candidates[0]?.output) return data.candidates[0].output;
  if (data?.output?.text) return data.output.text;
  return JSON.stringify(data);
}

module.exports = { generateText };
