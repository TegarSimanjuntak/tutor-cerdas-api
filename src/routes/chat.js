// src/routes/chat.js
const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../lib/supabaseClient');
const { generateText } = require('../lib/gemini');
const { fetch } = require('../lib/fetcher');

const RAG_WORKER_URL = process.env.RAG_WORKER_URL; // e.g., http://localhost:8000 or https://tutor-rag-worker.railway.app

if (!RAG_WORKER_URL) {
  console.warn('RAG_WORKER_URL not set. Set to RAG worker base URL. Chat will work but without retrieval context.');
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

    // 1) call RAG worker for top-k chunks (if configured)
    let chunks = [];
    if (RAG_WORKER_URL) {
      try {
        const searchUrl = `${RAG_WORKER_URL.replace(/\/+$/,'')}/search`;
        const searchResp = await fetch(searchUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-SERVICE-KEY': process.env.WORKER_SERVICE_KEY || '' },
          body: JSON.stringify({ query: question, k: 6, filter_document })
        });

        if (!searchResp.ok) {
          const text = await searchResp.text().catch(()=>'<no-body>');
          console.warn('RAG worker search failed, status=', searchResp.status, 'body=', text);
          // do not throw — proceed without retrieved context
        } else {
          // parse json safely
          const searchData = await searchResp.json().catch(e => {
            console.warn('Failed to parse RAG worker JSON:', e);
            return null;
          });
          // accept both { items: [...] } or plain array
          if (searchData) {
            if (Array.isArray(searchData.items)) {
              chunks = searchData.items;
            } else if (Array.isArray(searchData)) {
              chunks = searchData;
            } else if (Array.isArray(searchData.items?.results)) {
              chunks = searchData.items.results;
            } else {
              chunks = [];
            }
          }
        }
      } catch (e) {
        console.warn('RAG worker call error:', (e && e.message) || e);
        chunks = [];
      }
    } else {
      // No worker configured
      chunks = [];
    }

    // Normalize chunk fields (avoid crashes if some fields missing)
    chunks = (Array.isArray(chunks) ? chunks : []).map((c, idx) => ({
      document_id: c.document_id || c.doc_id || c.document || `doc_${idx}`,
      document_title: c.document_title || c.title || c.name || c.document_id || `doc_${idx}`,
      chunk_index: Number.isFinite(c.chunk_index) ? c.chunk_index : (c.index ?? idx),
      similarity: typeof c.similarity === 'string' ? parseFloat(c.similarity) : (Number.isFinite(c.similarity) ? c.similarity : (c.score ?? 0)),
      text: (typeof c.text === 'string') ? c.text : (c.content || c.body || '')
    }));

    // decide out_of_context based on top similarity threshold
    const topSim = (chunks[0] && Number(chunks[0].similarity)) || 0;
    const SIMILARITY_THRESHOLD = parseFloat(process.env.SIMILARITY_THRESHOLD || '0.25');
    const out_of_context = chunks.length === 0 || topSim < SIMILARITY_THRESHOLD;
    const has_context = !out_of_context; // true if we have at least one chunk with sim >= threshold

    // 2) build prompt
    const systemPrompt =
      "Kamu adalah tutor cerdas dan sopan yang menjawab dalam Bahasa Indonesia. Gunakan materi yang relevan dari konteks yang disediakan. Jika pertanyaan di luar konteks materi, awali jawaban dengan 'Catatan: pertanyaan ini berada di luar cakupan materi. Jawaban berikut dibuat menggunakan model generatif.'";

    // Only include context when has_context === true
    let contextText = '';
    if (has_context && chunks.length > 0) {
      // include up to k chunks (we'll include all retrieved but order is top->down)
      contextText = chunks
        .map((c, i) => `---chunk ${i+1} (doc: ${c.document_title || c.document_id} | idx:${c.chunk_index} | sim:${(c.similarity || 0).toFixed(3)})---\n${c.text}`)
        .join("\n\n");
    }

    let prompt;
    if (has_context && contextText) {
      prompt = `${systemPrompt}\n\nKonteks (ambil hanya yang relevan):\n${contextText}\n\nPertanyaan pengguna:\n${question}\n\nJawab secara ringkas dan sertakan referensi chunk (sebutkan doc & chunk index) jika relevan. Jika jawaban tidak bisa langsung diambil dari konteks, jawab tetapi awali dengan peringatan sesuai instruksi system.`;
    } else {
      // no context found
      prompt = `${systemPrompt}\n\n(Peringatan: tidak ditemukan konteks relevan dari dokumen.)\n\nPertanyaan pengguna:\n${question}\n\nJawab secara ringkas.`;
    }

    // 3) call Gemini (with error handling and informative logs)
    let genText = '';
    try {
      genText = await generateText(prompt, { temperature: 0.2, maxTokens: 512 });
      if (!genText || typeof genText !== 'string') {
        // ensure reply is string
        genText = (typeof genText === 'object') ? JSON.stringify(genText) : String(genText || '');
      }
    } catch (e) {
      // Gemini failed (404 or other). Log full error for debugging and return friendly message.
      console.error('Gemini generation error:', e && e.message ? e.message : e);
      // Return helpful client-side response instead of crashing; include indicator for operator to check env.
      return res.status(502).json({
        error: 'Generation service error. Periksa GEMINI_API_KEY / GEMINI_MODEL. Detail logged di server.',
        detail: (e && e.message) ? e.message : String(e)
      });
    }

    // 4) Save chat & message to Supabase (if token present)
    let saved = null;
    if (supabaseToken) {
      try {
        const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(supabaseToken);
        if (userErr) {
          console.warn('Failed to get user from token:', userErr);
        } else {
          const userId = userData?.user?.id;
          let chatId = chat_id;
          if (!chatId) {
            const { data: chatData, error: chatErr } = await supabaseAdmin
              .from('chats').insert({ user_id: userId, title: 'Chat' })
              .select().single();
            if (chatErr) {
              console.warn('Failed to create chat:', chatErr);
            } else {
              chatId = chatData.id;
            }
          }

          if (chatId) {
            // prepare messages payload
            const messagesPayload = [
              { chat_id: chatId, role: 'user', content: question },
              { chat_id: chatId, role: 'assistant', content: genText, metadata: { chunks, out_of_context } }
            ];
            const { error: msgErr } = await supabaseAdmin.from('messages').insert(messagesPayload);
            if (msgErr) {
              console.warn('Failed to insert messages:', msgErr);
            } else {
              saved = { chat_id: chatId };
            }
          }
        }
      } catch (e) {
        console.warn('saving chat failed', e && e.message ? e.message : e);
      }
    }

    // prepare top_chunks (first 1-3) for frontend convenience
    const top_chunks = (Array.isArray(chunks) && chunks.length > 0)
      ? chunks.slice(0, 3).map(c => ({
          document_id: c.document_id,
          document_title: c.document_title || c.document_id,
          chunk_index: c.chunk_index,
          similarity: Number(c.similarity || 0),
          text: c.text
        }))
      : [];

    // 5) return enriched payload
    return res.json({
      reply: genText,
      chunks,         // full retrieved chunks (useful for debugging / pagination)
      top_chunks,     // 1-3 chunk items with full text (for UI display)
      has_context,    // true if we consider model had relevant context (sim >= threshold)
      out_of_context, // same as before
      saved
    });
  } catch (err) {
    console.error('Unexpected /api/chat error', err);
    return res.status(500).json({ error: err && err.message ? err.message : 'server error' });
  }
});

module.exports = router;
