require('dotenv').config()
const express = require('express')
const cors = require('cors')
const multer = require('multer')
const crypto = require('crypto')
const path = require('path')
const { createClient } = require('@supabase/supabase-js')

// ==== [Gemini SDK] ====
// Kompatibel dengan SDK lama (@google/generative-ai) & baru (google-genai).
let getGenModel = null
let usingNewGenAi = false
try {
  // SDK baru
  const { GoogleGenerativeAI } = require('google-genai')
  usingNewGenAi = true
  getGenModel = (apiKey, model) => new GoogleGenerativeAI({ apiKey }).getGenerativeModel({ model })
} catch {
  // SDK lama (deprecated, tapi masih banyak dipakai)
  try {
    const { GoogleGenerativeAI } = require('@google/generative-ai')
    getGenModel = (apiKey, model) => new GoogleGenerativeAI(apiKey).getGenerativeModel({ model })
  } catch {}
}

/* ==========================================
 *  Basic App & Config
 * ========================================== */
const app = express()

// ---- CORS (whitelist dari ENV, + preflight OPTIONS)
const allowedOrigins = process.env.WEB_ORIGIN
  ? process.env.WEB_ORIGIN.split(',').map(s => s.trim()).filter(Boolean)
  : ['*'] // dev: allow all

const corsOptions = allowedOrigins.includes('*')
  ? { origin: true, credentials: true }
  : {
      origin(origin, cb) {
        if (!origin) return cb(null, true) // curl/postman
        cb(null, allowedOrigins.includes(origin))
      },
      credentials: true
    }

app.use(cors(corsOptions))
app.options('*', cors(corsOptions))
app.use(express.json({ limit: '10mb' }))

// (opsional) keamanan tambahan
// const helmet = require('helmet')
// app.use(helmet({
//   crossOriginResourcePolicy: { policy: 'cross-origin' },
//   contentSecurityPolicy: false
// }))

// (opsional) rate limit
// const rateLimit = require('express-rate-limit')
// app.use(rateLimit({ windowMs: 60_000, max: 120 }))

/* ==========================================
 *  Supabase Admin client (service role)
 * ========================================== */
const SUPABASE_URL = process.env.SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.warn('[startup] SUPABASE_URL / SERVICE_KEY belum di-set.')
}
const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
})

/* ==========================================
 *  Konstanta
 * ========================================== */
const BUCKET = process.env.DOCS_BUCKET || 'documents'
const TABLE  = process.env.DOCS_TABLE  || 'documents'
const INDEXER_URL = process.env.INDEXER_URL // ex: https://<indexer>.up.railway.app
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash' // disarankan model aktif

// ---- Upload config (PDF s/d 30MB)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    // longgarkan kalau perlu selain PDF
    if (!file.mimetype || !/pdf/i.test(file.mimetype)) {
      return cb(new Error('only PDF is supported'))
    }
    cb(null, true)
  }
})

// ---- util fetch + timeout
const _fetch = (...args) => (
  global.fetch ? global.fetch(...args) : import('node-fetch').then(({ default: f }) => f(...args))
)
async function fetchWithTimeout(resource, options = {}, ms = 25_000) {
  const { AbortController } = global
  const ctl = new AbortController()
  const id = setTimeout(() => ctl.abort(), ms)
  try {
    return await _fetch(resource, { ...options, signal: ctl.signal })
  } finally {
    clearTimeout(id)
  }
}

/* ==========================================
 *  Helpers
 * ========================================== */
const clampInt = (v, min, max, def) => {
  const n = Number.parseInt(v ?? def, 10)
  if (Number.isNaN(n)) return def
  return Math.min(Math.max(n, min), max)
}

const jsonOk  = (res, obj = {}) => res.json({ ok: true, ...obj })
const jsonErr = (res, code, msg, extra) => res.status(code).json({ error: msg, ...(extra || {}) })

function safeExt(name, fallback = 'pdf') {
  const ext = (name?.split('.').pop() || fallback).toLowerCase()
  return ext.replace(/[^a-z0-9]/g, '') || fallback
}
function randomKey(bytes = 6) {
  return crypto.randomBytes(bytes).toString('hex')
}

// ---- Auth helpers (Bearer token dari Supabase)
function getToken(req) {
  const h = req.headers.authorization || ''
  return h.startsWith('Bearer ') ? h.slice(7) : null
}

async function requireAuth(req, res, next) {
  try {
    const token = getToken(req)
    if (!token) return jsonErr(res, 401, 'Unauthorized')
    const { data, error } = await supabase.auth.getUser(token) // aman, selalu re-validate ke Auth server
    if (error || !data?.user) return jsonErr(res, 401, 'Invalid token')
    req.user = data.user // { id, email, ... }
    next()
  } catch (e) {
    return jsonErr(res, 401, 'Auth failed', { detail: String(e) })
  }
}

// NOTE: di desain kita, kolom PK profiles adalah `id` (FK ke auth.users.id).
async function isAdminUser(userId) {
  const { data, error } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', userId)      // <-- FIX: tadinya `user_id`, harusnya `id`
    .single()
  if (error || !data) return false
  return data?.role === 'admin'
}

async function requireAdmin(req, res, next) {
  if (!req.user) return jsonErr(res, 401, 'Unauthorized')
  const admin = await isAdminUser(req.user.id)
  if (!admin) return jsonErr(res, 403, 'Forbidden')
  next()
}

/* ==========================================
 *  Health & Meta
 * ========================================== */
app.get('/health', async (_req, res) => {
  res.json({
    ok: true,
    env: process.env.NODE_ENV || 'dev',
    indexer: !!INDEXER_URL,
    supabase: !!(SUPABASE_URL && SERVICE_KEY),
    model: GEMINI_MODEL,
    sdk: usingNewGenAi ? 'google-genai' : '@google/generative-ai',
    ts: new Date().toISOString()
  })
})

app.get('/auth/me', requireAuth, async (req, res) => {
  // kirim role sekalian
  let role = 'user'
  try {
    const { data } = await supabase.from('profiles').select('role').eq('id', req.user.id).single()
    role = data?.role || 'user'
  } catch {}
  res.json({ ok: true, user: { id: req.user.id, email: req.user.email, role } })
})

/* (opsional) list model untuk debugging pemilihan model */
app.get('/models', async (_req, res) => {
  if (!process.env.GEMINI_API_KEY || !getGenModel) {
    return jsonErr(res, 400, 'Gemini SDK/API key not configured')
  }
  try {
    // Endpoint list bervariasi; gunakan REST langsung (aman untuk debug)
    const url = 'https://generativelanguage.googleapis.com/v1/models?key=' + encodeURIComponent(process.env.GEMINI_API_KEY)
    const r = await fetchWithTimeout(url, {}, 10_000)
    const body = await r.json().catch(() => ({}))
    res.status(r.status).json(body)
  } catch (e) {
    jsonErr(res, 500, 'list models failed', { detail: String(e) })
  }
})

app.head('/', (_req, res) => res.status(204).end())

/* ==========================================
 *  Documents (ADMIN ONLY)
 * ========================================== */

// Upload PDF
app.post('/documents/upload', requireAuth, requireAdmin, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return jsonErr(res, 400, 'file is required')
    if (req.file.mimetype && !/pdf/i.test(req.file.mimetype)) {
      return jsonErr(res, 400, 'only PDF is supported')
    }

    const title = req.body?.title?.toString().slice(0, 180) || req.file.originalname.slice(0, 180)
    const ext = safeExt(req.file.originalname, 'pdf')

    const now = new Date()
    const y = now.getUTCFullYear()
    const m = String(now.getUTCMonth() + 1).padStart(2, '0')
    const storage_path = `${y}/${m}/${randomKey(8)}.${ext}`

    const { error: upErr } = await supabase
      .storage.from(BUCKET)
      .upload(storage_path, req.file.buffer, {
        contentType: req.file.mimetype || 'application/pdf',
        upsert: false
      })
    if (upErr) return jsonErr(res, 500, upErr.message)

    const { data, error: insErr } = await supabase
      .from(TABLE)
      .insert({ title, storage_path, size: req.file.size, status: 'uploaded' })
      .select()
      .single()
    if (insErr) return jsonErr(res, 500, insErr.message)

    return jsonOk(res, { document: data })
  } catch (e) {
    return jsonErr(res, 500, String(e))
  }
})

// List Documents
app.get('/documents', requireAuth, requireAdmin, async (_req, res) => {
  try {
    let { data, error } = await supabase
      .from(TABLE)
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100)
    if (error && /created_at/i.test(error.message)) {
      const resp = await supabase.from(TABLE).select('*').limit(100)
      data = resp.data; error = resp.error
    }
    if (error) return jsonErr(res, 500, error.message)
    return res.json({ items: data || [] })
  } catch (e) {
    return jsonErr(res, 500, String(e))
  }
})

// Get single document
app.get('/documents/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from(TABLE).select('id, title, storage_path, size, status, created_at')
      .eq('id', req.params.id)
      .single()
    if (error || !data) return jsonErr(res, 404, 'document not found')
    return jsonOk(res, { document: data })
  } catch (e) {
    return jsonErr(res, 500, String(e))
  }
})

// Signed URL
app.get('/documents/:id/url', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { data: doc, error } = await supabase
      .from(TABLE).select('id, storage_path, title')
      .eq('id', req.params.id)
      .single()
    if (error || !doc) return jsonErr(res, 404, 'document not found')
    if (!doc.storage_path) return jsonErr(res, 400, 'no storage_path')

    const { data, error: e2 } = await supabase
      .storage.from(BUCKET)
      .createSignedUrl(doc.storage_path, 3600) // 1 jam

    if (!e2 && data?.signedUrl) {
      return jsonOk(res, { url: data.signedUrl, title: doc.title, storage_path: doc.storage_path })
    }

    // Fallback (bucket public)
    const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${doc.storage_path}`
    return jsonOk(res, { url: publicUrl, title: doc.title, storage_path: doc.storage_path, public: true })
  } catch (e) {
    return jsonErr(res, 500, String(e))
  }
})

// Delete document + chunks
app.delete('/documents/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = req.params.id
    const { data: doc, error: e1 } = await supabase
      .from(TABLE).select('id, storage_path').eq('id', id).single()
    if (e1 || !doc) return jsonErr(res, 404, 'document not found')

    if (doc.storage_path) {
      const { error: eS } = await supabase.storage.from(BUCKET).remove([doc.storage_path])
      if (eS) console.warn('[delete] storage remove warn:', eS.message)
    }

    const { error: e2 } = await supabase.from('chunks').delete().eq('document_id', id)
    if (e2) return jsonErr(res, 500, e2.message)

    const { error: e3 } = await supabase.from(TABLE).delete().eq('id', id)
    if (e3) return jsonErr(res, 500, e3.message)

    return jsonOk(res, { deleted: id })
  } catch (e) {
    return jsonErr(res, 500, String(e))
  }
})

// Chunks per document
app.get('/documents/:id/chunks', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = req.params.id
    const limit = clampInt(req.query.limit, 1, 1000, 50)
    const offset = clampInt(req.query.offset, 0, 1e6, 0)
    const { data, error, count } = await supabase
      .from('chunks')
      .select('*', { count: 'exact' })
      .eq('document_id', id)
      .order('chunk_index', { ascending: true })
      .range(offset, offset + limit - 1)
    if (error) return jsonErr(res, 500, error.message)
    return res.json({ items: data || [], count: count ?? 0, limit, offset })
  } catch (e) {
    return jsonErr(res, 500, String(e))
  }
})

// Preview N chunk pertama
app.get('/documents/:id/preview', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = req.params.id
    const n = clampInt(req.query.n, 1, 100, 10)
    const { data, error } = await supabase
      .from('chunks')
      .select('chunk_index, content')
      .eq('document_id', id)
      .order('chunk_index', { ascending: true })
      .limit(n)
    if (error) return jsonErr(res, 500, error.message)
    const text = (data || []).map(x => x.content).join('\n\n---\n\n')
    return res.type('text/plain').send(text)
  } catch (e) {
    return jsonErr(res, 500, String(e))
  }
})

// Rebuild (chunk+embed) melalui INDEXER
app.post('/documents/rebuild/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    if (!INDEXER_URL) return jsonErr(res, 500, 'INDEXER_URL not set')

    const { data: doc, error } = await supabase
      .from(TABLE).select('id, storage_path').eq('id', req.params.id).single()
    if (error || !doc) return jsonErr(res, 404, 'document not found')
    if (!doc.storage_path) return jsonErr(res, 400, 'no storage_path; re-upload file')

    // endpoint baru
    let r = await fetchWithTimeout(`${INDEXER_URL}/process/document`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ document_id: req.params.id })
    }, 60_000)

    // fallback endpoint lama
    if (r.status === 404) {
      r = await fetchWithTimeout(`${INDEXER_URL}/embed/document`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ document_id: req.params.id })
      }, 60_000)
    }

    const txt = await r.text()
    let body; try { body = JSON.parse(txt) } catch { body = { raw: txt } }
    console.log('[rebuild] upstream status:', r.status, 'body:', body)
    return res.status(r.status).json(body)
  } catch (e) {
    console.error('[rebuild] error:', e)
    return jsonErr(res, 500, String(e))
  }
})

/* ==========================================
 *  RAG Chat: /chat/ask
 * ========================================== */
app.post('/chat/ask', requireAuth, async (req, res) => {
  try {
    const { question, top_k, session_id: givenSessionId } = req.body || {}
    if (!question) return jsonErr(res, 400, 'question is required')
    if (!INDEXER_URL) return jsonErr(res, 500, 'INDEXER_URL not set')

    const k = clampInt(top_k, 1, 12, 6)

    // (A) Pastikan ada chat_session milik user
    let sessionId = givenSessionId
    if (sessionId) {
      const { data: sess, error: sErr } = await supabase
        .from('chat_sessions')
        .select('id, user_id')
        .eq('id', sessionId)
        .single()
      if (sErr || !sess) return jsonErr(res, 404, 'session not found')
      if (sess.user_id !== req.user.id) return jsonErr(res, 403, 'Forbidden')
    } else {
      const title = (question || '').slice(0, 60)
      const { data: newSess, error: nErr } = await supabase
        .from('chat_sessions')
        .insert([{ user_id: req.user.id, title }])
        .select('id')
        .single()
      if (nErr) return jsonErr(res, 500, nErr.message)
      sessionId = newSess.id
    }

    // simpan pertanyaan user (best-effort)
    supabase.from('messages')
      .insert([{ session_id: sessionId, sender: 'user', content: question }])
      .then(() => {}).catch(e => console.warn('[chat] insert user message warn:', e?.message))

    // (B) Retrieval dari Indexer
    const r = await fetchWithTimeout(`${INDEXER_URL}/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question, top_k: k })
    }, 30_000)
    const search = await r.json().catch(() => ({}))
    if (!r.ok || !search?.ok) {
      return jsonErr(res, 502, 'retrieval_failed', { detail: search })
    }
    const contexts = Array.isArray(search.items) ? search.items : []

    // (C) perkaya judul dokumen
    const ids = Array.from(new Set(contexts.map(c => c.document_id)))
    const titles = {}
    if (ids.length) {
      const { data: rows } = await supabase
        .from(TABLE).select('id, title, storage_path').in('id', ids)
      for (const row of (rows || [])) {
        titles[row.id] = row.title || row.storage_path || '(untitled)'
      }
    }

    const sources = contexts.map((c, i) => ({
      id: `${c.document_id}:${c.chunk_index}`,
      index: i + 1,
      document_id: c.document_id,
      chunk_index: c.chunk_index,
      similarity: c.similarity,
      title: titles[c.document_id] || c.document_id,
      preview: (c.content || '').replace(/\s+/g, ' ').slice(0, 200)
    }))

    const sourcesText = contexts.map((c, i) =>
      `[${i + 1}] (doc:${c.document_id} #${c.chunk_index})\n${c.content}`
    ).join('\n\n---\n\n')

    // (D) Jawaban via Gemini
    let answerText = 'Tidak ditemukan di materi.'
    if (!process.env.GEMINI_API_KEY || !getGenModel) {
      answerText = 'GEMINI_API_KEY/SDK belum di-set. Berikut konteks terdekat.'
    } else {
      const model = getGenModel(process.env.GEMINI_API_KEY, GEMINI_MODEL)
      const prompt = [
        `Kamu adalah "Tutor Cerdas". Jawab singkat, jelas, dan dalam Bahasa Indonesia.`,
        `Jawab HANYA berdasarkan "KONTEKS" berikut. Jika tidak ada jawabannya di konteks,`,
        `balas: "Tidak ditemukan di materi." Jangan mengarang.`,
        '',
        `KONTEKS:\n${sourcesText}`,
        '',
        `PERTANYAAN: ${question}`
      ].join('\n')

      try {
        // SDK lama & baru punya antarmuka mirip:
        const resp = await model.generateContent(prompt)
        answerText = typeof resp?.response?.text === 'function'
          ? resp.response.text()
          : (resp?.response?.candidates?.[0]?.content?.parts?.[0]?.text || 'Tidak ditemukan di materi.')
      } catch (e) {
        console.error('[gemini] error:', e)
        answerText = 'Maaf, terjadi kesalahan saat memanggil model.'
      }
    }

    // (E) simpan jawaban (best-effort)
    supabase.from('messages')
      .insert([{ session_id: sessionId, sender: 'assistant', content: answerText, sources }])
      .then(() => {}).catch(e => console.warn('[chat] insert assistant message warn:', e?.message))

    return res.json({ ok: true, session_id: sessionId, answer: answerText, sources })
  } catch (e) {
    console.error('[chat/ask] error', e)
    return jsonErr(res, 500, String(e))
  }
})

/* ==========================================
 *  Start
 * ========================================== */
const PORT = process.env.PORT || 8787
app.listen(PORT, '0.0.0.0', () => {
  console.log('API running on http://localhost:' + PORT)
})
