require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const { createClient } = require('@supabase/supabase-js');

const app = express();

// --- CORS (boleh longgar dulu). Untuk produksi, ganti origin ke process.env.WEB_ORIGIN
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ------ Supabase client (server-side pakai service key) ------
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
);

// ------ Konfigurasi Storage & Table ------
const BUCKET = 'documents';
const TABLE  = 'documents';

const upload = multer({ storage: multer.memoryStorage() });

// Health check
app.get('/health', (req, res) => {
  res.json({ ok: true, env: process.env.NODE_ENV || 'dev' });
});

// === M2.1 Upload PDF ===
// multipart form: field "file" (required), "title" (optional)
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

    // Upload ke Supabase Storage (bucket: documents)
    const { error: upErr } = await supabase
      .storage.from(BUCKET)
      .upload(storage_path, req.file.buffer, {
        contentType: req.file.mimetype || 'application/pdf',
        upsert: false
      });
    if (upErr) return res.status(500).json({ error: upErr.message });

    // Simpan metadata ke table documents
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

// === M2.2 List documents (terbaru dulu) ===
app.get('/documents', async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from(TABLE)
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ items: data || [] });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// === M2.3 Rebuild: download PDF -> extract text -> chunk -> simpan ke "chunks" ===
app.post('/documents/rebuild/:id', async (req, res) => {
  try {
    const id = req.params.id;

    // Ambil dokumen
    const { data: doc, error: e1 } = await supabase
      .from(TABLE).select('*').eq('id', id).single();
    if (e1) return res.status(404).json({ error: 'document not found' });

    const path = doc.storage_path || doc.file_path; // fallback bila kamu masih punya kolom file_path
    if (!path) return res.status(400).json({ error: 'no storage_path' });

    // Download dari Storage
    const { data: file, error: e2 } = await supabase
      .storage.from(BUCKET).download(path);
    if (e2) return res.status(500).json({ error: e2.message });

    const buf = Buffer.from(await file.arrayBuffer());
    const parsed = await pdfParse(buf);
    const text = parsed.text || '';

    // Simple chunking 800 chars
    const CHUNK = 800;
    const parts = [];
    for (let i = 0; i < text.length; i += CHUNK) {
      parts.push(text.slice(i, i + CHUNK));
    }

    // Hapus chunks lama (opsional)
    await supabase.from('chunks').delete().eq('document_id', id);

    // Insert chunks baru
    if (parts.length) {
      const rows = parts.map((t, idx) => ({
        document_id: id,
        chunk_index: idx,
        content: t
      }));
      const { error: e3 } = await supabase.from('chunks').insert(rows);
      if (e3) return res.status(500).json({ error: e3.message });
    }

    // Update status & pages
    await supabase.from(TABLE)
      .update({ status: 'indexed', pages: parsed.numpages || null })
      .eq('id', id);

    res.json({ ok: true, pages: parsed.numpages || 0, chunks: parts.length });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// --- (M4 nanti gantikan /chat/ask dengan RAG) ---
app.post('/chat/ask', async (req, res) => {
  const { question, role } = req.body || {};
  res.json({
    answer: `Halo (${role || 'user'})! Kamu bertanya: "${question}". Jawaban asli akan muncul setelah RAG di M4.`,
    sources: []
  });
});
// List chunks per dokumen (pagination optional)
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

// (Opsional) gabungkan beberapa chunk jadi teks pratinjau
app.get('/documents/:id/preview', async (req, res) => {
  try {
    const id = req.params.id;
    const n = Number(req.query.n ?? 10); // gabungkan N chunk pertama
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


// Start server
const PORT = process.env.PORT || 8787;
app.listen(PORT, '0.0.0.0', () => {
  console.log('API running on http://localhost:' + PORT);
});
