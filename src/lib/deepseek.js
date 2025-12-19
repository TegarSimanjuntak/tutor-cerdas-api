const fetch = globalThis.fetch || require('node-fetch');

const API_KEY = process.env.DEEPSEEK_API_KEY;
if (!API_KEY) {
  throw new Error('DEEPSEEK_API_KEY is not set');
}

async function generateText(prompt, opts = {}) {
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: 'Kamu adalah tutor akademik.' },
        { role: 'user', content: prompt }
      ],
      temperature: opts.temperature ?? 0.2,
      max_tokens: opts.maxTokens ?? 512
    })
  });

  const json = await res.json();
  if (!res.ok) {
    throw new Error(`DeepSeek error ${res.status}: ${JSON.stringify(json)}`);
  }

  return json?.choices?.[0]?.message?.content || '';
}

module.exports = { generateText };
