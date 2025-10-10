// src/routes/chat.js
const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../lib/supabaseClient');
const { generateText } = require('../lib/gemini');
const { fetch } = require('../lib/fetcher');

const RAG_WORKER_URL = process.env.RAG_WORKER_URL; // e.g., https://tutor-rag-worker.railway.app

if (!RAG_WORKER_URL) {
  console.warn('RAG_WORKER_URL not set. Set to RAG worker base URL.');
}

/**
 * POST /api/chat
 * body: { question, chat_id (optional), filter_document (optional) }
 * Header: Authorization: Bearer <supabase_access_token>  (frontend should forward session access token)
 */
router.post('/', async (req, res) => {
  try {
    const supabaseToken = (req.headers.authorization || '').replace('Bearer ', '');
    const { question, chat_id, filter_document } = req.body;
    if (!question) return res.status(400).json({ error: 'question required' });

    // 1) call RAG worker for top-k chunks (RAG worker should call Supabase using service key)
    const searchUrl = `${RAG_WORKER_URL.replace(/\/+$/,'')}/search`;
    const searchResp = await fetch(searchUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-SERVICE-KEY': process.env.WORKER_SERVICE_KEY || '' },
      body: JSON.stringify({ query: question, k: 6, filter_document })
    });
    if (!searchResp.ok) {
      const t = await searchResp.text();
      console.warn('RAG worker search failed', t);
      // proceed without retrieved context (fallback to pure generation)
    }
    const searchData = await searchResp.json().catch(()=>null);
    const chunks = (searchData && searchData.items) || [];

    // decide out_of_context based on top similarity threshold
    const topSim = (chunks[0] && chunks[0].similarity) || 0;
    const SIMILARITY_THRESHOLD = parseFloat(process.env.SIMILARITY_THRESHOLD || '0.25');
    const out_of_context = topSim < SIMILARITY_THRESHOLD;

    // 2) build prompt
    let systemPrompt = "Kamu adalah tutor cerdas dan sopan yang menjawab dalam Bahasa Indonesia. Gunakan materi yang relevan dari konteks yang disediakan. Jika pertanyaan di luar konteks materi, awali jawaban dengan 'Catatan: pertanyaan ini berada di luar cakupan materi. Jawaban berikut dibuat menggunakan model generatif.'";
    let contextText = chunks.map((c, i) => `---chunk ${i+1} (doc: ${c.document_title||c.document_id} | idx:${c.chunk_index} | sim:${(c.similarity||0).toFixed(3)})---\n${c.text}`).join("\n\n");
    if (!contextText) contextText = '';

    let prompt = `${systemPrompt}\n\nKonteks:\n${contextText}\n\nPertanyaan pengguna:\n${question}\n\nJawab secara ringkas dan sertakan referensi chunk jika relevan.`;

    // if out of context, add explicit note to the user first (Gemini will include it because it's in system prompt)
    // 3) call Gemini
    const genText = await generateText(prompt, { temperature: 0.2, maxTokens: 512 });

    // 4) Save chat & message to Supabase (if token present)
    // ambil user dari access token
    let saved = null;
    try {
    if (supabaseToken) {
        // get user info from token
        const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(supabaseToken);
        if (userErr) throw userErr;
        const userId = userData?.user?.id;

        // create chat if not present
        let chatId = chat_id;
        if (!chatId) {
        const { data: chatData, error: chatErr } = await supabaseAdmin
            .from('chats').insert({ user_id: userId, title: 'Chat' })
            .select().single();
        if (chatErr) throw chatErr;
        chatId = chatData.id;
        }

        // insert messages
        const { error: msgErr } = await supabaseAdmin.from('messages').insert([
        { chat_id: chatId, role: 'user', content: question },
        { chat_id: chatId, role: 'assistant', content: genText, metadata: { chunks, out_of_context } }
        ]);
        if (msgErr) throw msgErr;
        saved = { chat_id: chatId };
    }
    } catch (e) {
    console.warn('saving chat failed', e.message || e);
    }


    return res.json({ reply: genText, chunks, out_of_context, saved });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || 'server error' });
  }
});

module.exports = router;
