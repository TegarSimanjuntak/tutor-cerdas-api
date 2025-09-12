require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');

const app = express();

/* ===== CORS (whitelist dari ENV, +preflight OPTIONS) ===== */
const allowedOrigins = process.env.WEB_ORIGIN
  ? process.env.WEB_ORIGIN.split(',').map(s => s.trim())
  : true; // dev: reflect any origin

const corsOptions = {
  origin: allowedOrigins,
  credentials: true, // kalau tidak pakai cookie, boleh set false
  methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // penting untuk preflight
app.use(express.json({ limit: '10mb' }));

/* ===== Supabase ===== */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
);

/* ===== Konfigurasi ===== */
const BUCKET = 'documents';
const TABLE  = 'documents';
const INDEXER_URL = process.env.INDEXER_URL; // ex: https://tutor-cerdas-indexer.up.railway.app
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024 } // 30MB
});

/* ===== Util fetch (Node 18 sudah ada fetch) ===== */
const _fetch = (...args) =>
  (global.fetch ? global.fetch(...args) : import('node-fetch').then(({ default: f }) => f(...args)));

/* ===== Health ===== */
app.get('/health', (_req, res) => {
  res.json({ ok: true, env: process.env.NODE_ENV || 'dev' });
});

/* ===== Upload PDF ===== */
app.post('/documents/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'file is required' });
    const title = req.body?.title || req.file.originalname;
    const ext = (req.file.originalname.split('.').pop() || 'pdf').toLowerCase();

    const now = new Date();
    const y = now.getUTCFullYear();
    const m = String(now.getUTCMonth() + 1).padStart(2, '0');
    const rand = Math.random().toString(36).slice(2, 10);
    const storage_path = `${y}/${m}/${rand}.${ext}`;

    const { error: upErr } = await supabase
      .storage.from(BUCKET)
      .upload(storage_path, req.file.buffer, {
        contentType: req.file.mimetype || 'application/pdf',
        upsert: false
      });
    if (upErr) return res.status(500).json({ error: upErr.message });

    const { data, error: insErr } = await supabase
      .from(TABLE)
      .insert({ title, storage_path, size: req.file.size, status: 'uploaded' })
      .select()
      .single();
    if (insErr) return res.status(500).json({ error: insErr.message });

    res.json({ ok: true, document: data });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/* ===== List Documents (fallback jika 'created_at' tidak ada) ===== */
app.get('/documents', async (_req, res) => {
  try {
    let { data, error } = await supabase
      .from(TABLE)
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50);

    if (error && /created_at/i.test(error.message)) {
      // Kolom 'created_at' tidak ada → fallback tanpa order
      const resp = await supabase.from(TABLE).select('*').limit(50);
      data = resp.data; error = resp.error;
    }

    if (error) return res.status(500).json({ error: error.message });
    res.json({ items: data || [] });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/* ===== Rebuild = proxy ke INDEXER (chunk + embed) ===== */
app.post('/documents/rebuild/:id', async (req, res) => {
  try {
    if (!INDEXER_URL) return res.status(500).json({ error: 'INDEXER_URL not set' });

    const { data: doc, error } = await supabase
      .from(TABLE).select('id').eq('id', req.params.id).single();
    if (error || !doc) return res.status(404).json({ error: 'document not found' });

    // coba endpoint baru
    let r = await _fetch(`${INDEXER_URL}/process/document`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ document_id: req.params.id })
    });
    // fallback ke endpoint lama kalau 404
    if (r.status === 404) {
      r = await _fetch(`${INDEXER_URL}/embed/document`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ document_id: req.params.id })
      });
    }

    const txt = await r.text();
    let body; try { body = JSON.parse(txt) } catch { body = { raw: txt } }
    console.log('[rebuild] upstream status:', r.status, 'body:', body);
    return res.status(r.status).json(body);
  } catch (e) {
    console.error('[rebuild] error:', e);
    res.status(500).json({ error: String(e) });
  }
});



/* ===== Lihat chunks per dokumen ===== */
app.get('/documents/:id/chunks', async (req, res) => {
  try {
    const id = req.params.id;
    const limit = Number(req.query.limit ?? 50);
    const offset = Number(req.query.offset ?? 0);

    const q = supabase
      .from('chunks')
      .select('*', { count: 'exact' })
      .eq('document_id', id)
      .order('chunk_index', { ascending: true })
      .range(offset, offset + limit - 1);

    const { data, error, count } = await q;
    if (error) return res.status(500).json({ error: error.message });

    res.json({ items: data || [], count: count ?? 0, limit, offset });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/* ===== Preview gabungan N chunk pertama ===== */
app.get('/documents/:id/preview', async (req, res) => {
  try {
    const id = req.params.id;
    const n = Number(req.query.n ?? 10);
    const { data, error } = await supabase
      .from('chunks')
      .select('chunk_index, content')
      .eq('document_id', id)
      .order('chunk_index', { ascending: true })
      .limit(n);
    if (error) return res.status(500).json({ error: error.message });
    const text = (data || []).map(x => x.content).join('\n\n---\n\n');
    res.type('text/plain').send(text);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/* ===== Placeholder chat (M4) ===== */
app.post('/chat/ask', async (req, res) => {
  const { question, role } = req.body || {};
  res.json({
    answer: `Halo (${role || 'user'})! Kamu bertanya: "${question}". Jawaban asli akan muncul setelah RAG di M4.`,
    sources: []
  });
});

/* ===== Start ===== */
const PORT = process.env.PORT || 8787;
app.listen(PORT, '0.0.0.0', () => {
  console.log('API running on http://localhost:' + PORT);
});
