const fetch = globalThis.fetch || require('node-fetch');

const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = 'models/gemini-2.5-flash';

if (!API_KEY) {
  throw new Error('GEMINI_API_KEY is not set');
}

async function generateText(prompt, opts = {}) {
  const body = {
    contents: [
      {
        role: 'user',
        parts: [{ text: prompt }]
      }
    ],
    generationConfig: {
      temperature: opts.temperature ?? 0.2,
      maxOutputTokens: opts.maxTokens ?? 512
    }
  };

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1/${MODEL}:generateContent?key=${API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }
  );

  const json = await res.json().catch(() => null);

  if (!res.ok) {
    throw new Error(
      `Gemini error ${res.status}: ${JSON.stringify(json)}`
    );
  }

  const text =
    json?.candidates?.[0]?.content?.parts?.[0]?.text;

  return text || '';
}

module.exports = { generateText };
