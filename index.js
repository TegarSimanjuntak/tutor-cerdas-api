require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');

/* ==========================================
 *  Basic App & Config
 * ========================================== */
const app = express();

// ---- CORS (whitelist dari ENV, + preflight OPTIONS)
const allowedOrigins = process.env.WEB_ORIGIN
  ? process.env.WEB_ORIGIN.split(',').map(s => s.trim())
  : true; // dev: allow all

const corsOptions = {
  origin: allowedOrigins,
  credentials: true,
  methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400,
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json({ limit: '10mb' }));

// ---- Supabase client (gunakan SERVICE KEY di backend)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  // Jangan crash; tapi beri warning jelas di log
  console.warn('[startup] SUPABASE_URL / SUPABASE_SERVICE_KEY belum di-set.');
}
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

// ---- Konstanta
const BUCKET = 'documents';
const TABLE  = 'documents';
const INDEXER_URL = process.env.INDEXER_URL; // ex: https://<indexer>.up.railway.app
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-flash';

// ---- Upload config (30MB)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024 },
});

// ---- util fetch (Node18 punya fetch)
const _fetch = (...args) => (
  global.fetch ? global.fetch(...args) : import('node-fetch').then(({ default: f }) => f(...args))
);

/* ==========================================
 *  Helpers
 * ========================================== */
const clampInt = (v, min, max, def) => {
  const n = Number.parseInt(v ?? def, 10);
  if (Number.isNaN(n)) return def;
  return Math.min(Math.max(n, min), max);
};

const jsonOk = (res, obj = {}) => res.json({ ok: true, ...obj });
const jsonErr = (res, code, msg, extra) => res.status(code).json({ error: msg, ...(extra || {}) });

async function getDocumentById(id, columns = 'id, title, storage_path, size, status, created_at') {
  const { data, error } = await supabase.from(TABLE).select(columns).eq('id', id).single();
  if (error || !data) return { error: error || new Error('document not found') };
  return { data };
}

/* ==========================================
 *  Health & Meta
 * ========================================== */
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    env: process.env.NODE_ENV || 'dev',
    indexer: !!INDEXER_URL,
    supabase: !!(SUPABASE_URL && SUPABASE_SERVICE_KEY),
    model: GEMINI_MODEL,
    ts: new Date().toISOString(),
  });
});

app.head('/', (_req, res) => res.status(204).end());

/* ==========================================
 *  Documents: Upload / List / Get / Signed URL / Delete / Preview / Chunks / Rebuild
 * ========================================== */

// ---- Upload PDF
app.post('/documents/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return jsonErr(res, 400, 'file is required');

    const title = req.body?.title || req.file.originalname;
    // Pastikan PDF (opsional: longgarkan jika perlu)
    if (req.file.mimetype && !/pdf/i.test(req.file.mimetype)) {
      return jsonErr(res, 400, 'only PDF is supported');
    }

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
        upsert: false,
      });
    if (upErr) return jsonErr(res, 500, upErr.message);

    const { data, error: insErr } = await supabase
      .from(TABLE)
      .insert({ title, storage_path, size: req.file.size, status: 'uploaded' })
      .select()
      .single();
    if (insErr) return jsonErr(res, 500, insErr.message);

    return jsonOk(res, { document: data });
  } catch (e) {
    return jsonErr(res, 500, String(e));
  }
});

// ---- List Documents
app.get('/documents', async (_req, res) => {
  try {
    let { data, error } = await supabase
      .from(TABLE)
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50);

    // fallback jika kolom created_at belum ada
    if (error && /created_at/i.test(error.message)) {
      const resp = await supabase.from(TABLE).select('*').limit(50);
      data = resp.data; error = resp.error;
    }

    if (error) return jsonErr(res, 500, error.message);
    return res.json({ items: data || [] });
  } catch (e) {
    return jsonErr(res, 500, String(e));
  }
});

// ---- Get single document (metadata)
app.get('/documents/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from(TABLE).select('id, title, storage_path, size, status, created_at')
      .eq('id', req.params.id)
      .single();
    if (error || !data) return jsonErr(res, 404, 'document not found');
    return jsonOk(res, { document: data });
  } catch (e) {
    return jsonErr(res, 500, String(e));
  }
});

// ---- Signed URL (open PDF)
app.get('/documents/:id/url', async (req, res) => {
  try {
    const { data: doc, error } = await supabase
      .from(TABLE).select('id, storage_path, title')
      .eq('id', req.params.id)
      .single();
    if (error || !doc) return jsonErr(res, 404, 'document not found');
    if (!doc.storage_path) return jsonErr(res, 400, 'no storage_path');

    // Coba signed URL (bucket private)
    const { data, error: e2 } = await supabase
      .storage.from(BUCKET)
      .createSignedUrl(doc.storage_path, 3600); // 1 jam

    if (!e2 && data?.signedUrl) {
      return jsonOk(res, { url: data.signedUrl, title: doc.title, storage_path: doc.storage_path });
    }

    // Fallback: jika bucket public
    const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${doc.storage_path}`;
    return jsonOk(res, { url: publicUrl, title: doc.title, storage_path: doc.storage_path, public: true });
  } catch (e) {
    return jsonErr(res, 500, String(e));
  }
});

// ---- Delete document (storage + chunks + row dokumen)
app.delete('/documents/:id', async (req, res) => {
  try {
    const id = req.params.id;

    const { data: doc, error: e1 } = await supabase
      .from(TABLE).select('id, storage_path').eq('id', id).single();
    if (e1 || !doc) return jsonErr(res, 404, 'document not found');

    if (doc.storage_path) {
      const { error: eS } = await supabase.storage.from(BUCKET).remove([doc.storage_path]);
      if (eS) console.warn('[delete] storage remove warn:', eS.message);
    }

    const { error: e2 } = await supabase.from('chunks').delete().eq('document_id', id);
    if (e2) return jsonErr(res, 500, e2.message);

    const { error: e3 } = await supabase.from(TABLE).delete().eq('id', id);
    if (e3) return jsonErr(res, 500, e3.message);

    return jsonOk(res, { deleted: id });
  } catch (e) {
    return jsonErr(res, 500, String(e));
  }
});

// ---- Chunks per document
app.get('/documents/:id/chunks', async (req, res) => {
  try {
    const id = req.params.id;
    const limit = clampInt(req.query.limit, 1, 1000, 50);
    const offset = clampInt(req.query.offset, 0, 1e6, 0);

    const q = supabase
      .from('chunks')
      .select('*', { count: 'exact' })
      .eq('document_id', id)
      .order('chunk_index', { ascending: true })
      .range(offset, offset + limit - 1);

    const { data, error, count } = await q;
    if (error) return jsonErr(res, 500, error.message);

    return res.json({ items: data || [], count: count ?? 0, limit, offset });
  } catch (e) {
    return jsonErr(res, 500, String(e));
  }
});

// ---- Preview gabungan N chunk pertama (teks)
app.get('/documents/:id/preview', async (req, res) => {
  try {
    const id = req.params.id;
    const n = clampInt(req.query.n, 1, 100, 10);
    const { data, error } = await supabase
      .from('chunks')
      .select('chunk_index, content')
      .eq('document_id', id)
      .order('chunk_index', { ascending: true })
      .limit(n);

    if (error) return jsonErr(res, 500, error.message);
    const text = (data || []).map(x => x.content).join('\n\n---\n\n');
    return res.type('text/plain').send(text);
  } catch (e) {
    return jsonErr(res, 500, String(e));
  }
});

// ---- Rebuild (proxy ke INDEXER: chunk + embed)
app.post('/documents/rebuild/:id', async (req, res) => {
  try {
    if (!INDEXER_URL) return jsonErr(res, 500, 'INDEXER_URL not set');

    const { data: doc, error } = await supabase
      .from(TABLE).select('id, storage_path').eq('id', req.params.id).single();
    if (error || !doc) return jsonErr(res, 404, 'document not found');
    if (!doc.storage_path) return jsonErr(res, 400, 'no storage_path; re-upload file');

    // endpoint baru
    let r = await _fetch(`${INDEXER_URL}/process/document`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ document_id: req.params.id }),
    });
    // fallback endpoint lama
    if (r.status === 404) {
      r = await _fetch(`${INDEXER_URL}/embed/document`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ document_id: req.params.id }),
      });
    }

    const txt = await r.text();
    let body; try { body = JSON.parse(txt) } catch { body = { raw: txt } }
    console.log('[rebuild] upstream status:', r.status, 'body:', body);
    return res.status(r.status).json(body);
  } catch (e) {
    console.error('[rebuild] error:', e);
    return jsonErr(res, 500, String(e));
  }
});

/* ==========================================
 *  RAG: /chat/ask  (retrieval -> Gemini)
 * ========================================== */
app.post('/chat/ask', async (req, res) => {
  try {
    const { question, role, top_k } = req.body || {};
    if (!question) return jsonErr(res, 400, 'question is required');
    if (!INDEXER_URL) return jsonErr(res, 500, 'INDEXER_URL not set');

    const k = clampInt(top_k, 1, 12, 6);

    // 1) Ambil konteks dari Indexer
    const r = await _fetch(`${INDEXER_URL}/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question, top_k: k }),
    });
    const search = await r.json().catch(() => ({}));
    if (!r.ok || !search?.ok) {
      return jsonErr(res, 502, 'retrieval_failed', { detail: search });
    }
    const contexts = Array.isArray(search.items) ? search.items : [];

    // 2) Perkaya dengan judul dokumen + snippet pendek
    const ids = Array.from(new Set(contexts.map(c => c.document_id)));
    const titles = {};
    if (ids.length) {
      const { data: rows } = await supabase
        .from(TABLE)
        .select('id, title, storage_path')
        .in('id', ids);
      for (const row of (rows || [])) {
        titles[row.id] = row.title || row.storage_path || '(untitled)';
      }
    }

    const sources = contexts.map((c, i) => {
      const title = titles[c.document_id] || c.document_id;
      const preview = (c.content || '').replace(/\s+/g, ' ').slice(0, 120);
      return {
        id: `${c.document_id}:${c.chunk_index}`,
        index: i + 1,
        document_id: c.document_id,
        chunk_index: c.chunk_index,
        similarity: c.similarity,
        title,
        preview,
      };
    });

    // 3) Susun teks sumber untuk prompt (pakai konten apa adanya)
    const sourcesText = contexts.map((c, i) =>
      `[${i + 1}] (doc:${c.document_id} #${c.chunk_index})\n${c.content}`
    ).join('\n\n---\n\n');

    // 4) Jika GEMINI_API_KEY belum ada → fallback (kembalikan konteks enriched)
    if (!process.env.GEMINI_API_KEY) {
      return res.json({
        answer: 'GEMINI_API_KEY belum di-set. Berikut konteks terdekat.',
        sources,
      });
    }

    // 5) Panggil Gemini buat merangkai jawaban
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });

    const prompt = [
      `Kamu adalah "Tutor Cerdas". Jawab singkat, jelas, dan dalam Bahasa Indonesia.`,
      `Jawab HANYA berdasarkan "KONTEKS" berikut. Jika tidak ada jawabannya di konteks,`,
      `balas: "Tidak ditemukan di materi." Jangan mengarang.`,
      '',
      `KONTEKS:\n${sourcesText}`,
      '',
      `PERTANYAAN: ${question}`,
    ].join('\n');

    const resp = await model.generateContent(prompt);
    const text = resp?.response?.text?.() || 'Tidak ditemukan di materi.';

    return res.json({ answer: text, sources });
  } catch (e) {
    console.error('[chat/ask] error', e);
    return jsonErr(res, 500, String(e));
  }
});

/* ==========================================
 *  Start
 * ========================================== */
const PORT = process.env.PORT || 8787;
app.listen(PORT, '0.0.0.0', () => {
  console.log('API running on http://localhost:' + PORT);
});
