// src/routes/chat.js
const express = require('express')
const supabase = require('../supabase')
const cfg = require('../config')
const { requireAuth } = require('../middleware/auth')
const { fetchWithTimeout } = require('../utils/fetchWithTimeout')
const { initGenSdkIfNeeded, getGenModel } = require('../utils/genSdk')

const router = express.Router()

const clampInt = (v, min, max, def) => {
  const n = Number.parseInt(v ?? def, 10)
  if (Number.isNaN(n)) return def
  return Math.min(Math.max(n, min), max)
}

router.post('/ask', requireAuth, async (req, res) => {
  try {
    const { question, top_k, session_id: givenSessionId } = req.body || {}
    if (!question) return res.status(400).json({ error: 'question is required' })
    if (!cfg.INDEXER_URL) return res.status(500).json({ error: 'INDEXER_URL not set' })

    const k = clampInt(top_k, 1, 12, 6)
    let sessionId = givenSessionId
    if (!sessionId) {
      const { data: newSess, error: nErr } = await supabase.from('chat_sessions').insert([{ user_id: req.user.id, title: (question||'').slice(0,60) }]).select('id').single()
      if (nErr) return res.status(500).json({ error: nErr.message })
      sessionId = newSess.id
    } else {
      const { data: sess, error: sErr } = await supabase.from('chat_sessions').select('id,user_id').eq('id', sessionId).single()
      if (sErr || !sess) return res.status(404).json({ error: 'session not found' })
      if (sess.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' })
    }

    // save user message best-effort
    supabase.from('messages').insert([{ session_id: sessionId, sender: 'user', content: question }]).then(()=>{}).catch(e=>console.warn('[chat] insert user message warn', e?.message))

    // retrieval
    const r = await fetchWithTimeout(`${cfg.INDEXER_URL}/search`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question, top_k: k })
    }, 30000)
    const search = await r.json().catch(()=>({}))
    if (!r.ok || !search?.ok) return res.status(502).json({ error: 'retrieval_failed', detail: search })
    const contexts = Array.isArray(search.items) ? search.items : []

    // enrich titles
    const ids = Array.from(new Set(contexts.map(c=>c.document_id)))
    const titles = {}
    if (ids.length) {
      const { data: rows } = await supabase.from(cfg.TABLE).select('id, title, storage_path').in('id', ids)
      for (const row of (rows||[])) { titles[row.id] = row.title || row.storage_path || '(untitled)' }
    }

    const sources = contexts.map((c,i)=>({
      id: `${c.document_id}:${c.chunk_index}`, index: i+1, document_id: c.document_id, chunk_index: c.chunk_index,
      similarity: c.similarity, title: titles[c.document_id] || c.document_id, preview: (c.content||'').replace(/\s+/g,' ').slice(0,200)
    }))

    const sourcesText = contexts.map((c,i)=>`[${i+1}] (doc:${c.document_id} #${c.chunk_index})\n${c.content}`).join('\n\n---\n\n')

    // generate via Gemini
    let answerText = 'Tidak ditemukan di materi.'
    if (!cfg.GEMINI_API_KEY) {
      answerText = 'GEMINI_API_KEY/SDK belum di-set. Berikut konteks terdekat.'
    } else {
      try {
        initGenSdkIfNeeded()
        const gm = getGenModel()
        if (!gm) throw new Error('Gemini SDK not available')
        const model = gm(cfg.GEMINI_API_KEY, cfg.GEMINI_MODEL)
        const prompt = [
          `Kamu adalah "Tutor Cerdas". Jawab singkat, jelas, dan dalam Bahasa Indonesia.`,
          `Jawab HANYA berdasarkan "KONTEKS" berikut. Jika tidak ada jawabannya di konteks,`,
          `balas: "Tidak ditemukan di materi." Jangan mengarang.`,
          '',
          `KONTEKS:\n${sourcesText}`,
          '',
          `PERTANYAAN: ${question}`
        ].join('\n')
        const resp = await model.generateContent(prompt)
        answerText = typeof resp?.response?.text === 'function'
          ? resp.response.text()
          : (resp?.response?.candidates?.[0]?.content?.parts?.[0]?.text || 'Tidak ditemukan di materi.')
      } catch (e) {
        console.error('[gemini] error', e)
        answerText = 'Maaf, terjadi kesalahan saat memanggil model.'
      }
    }

    // save assistant message best-effort
    supabase.from('messages').insert([{ session_id: sessionId, sender: 'assistant', content: answerText, sources }]).then(()=>{}).catch(e=>console.warn('[chat] insert assistant message warn', e?.message))

    return res.json({ ok: true, session_id: sessionId, answer: answerText, sources })
  } catch (e) {
    console.error('[chat/ask] error', e)
    return res.status(500).json({ error: 'internal' })
  }
})

module.exports = router
