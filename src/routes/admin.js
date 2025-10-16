// routes/admin.js
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const fetch = global.fetch || require('node-fetch');

const router = express.Router();

/* --------- Supabase config (server-side only) --------- */
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || 'documents';
const SUPABASE_INCLUDE_PATH = (process.env.SUPABASE_INCLUDE_PATH || 'true') === 'true';
const SUPABASE_PUBLIC = (process.env.SUPABASE_PUBLIC || 'true') === 'true';

let supabase = null;
if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  console.log('Supabase client configured for admin routes.');
} else {
  console.warn('Supabase not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env to enable DB/Storage integration.');
}

/* --------- Multer (memory) --------- */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

/* --------- In-memory docs for dev/debug UI --------- */
const uploadsDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

let docs = [
  { id: 1, title: 'Sample Doc A', uploadedBy: 'admin', created_at: new Date().toISOString(), filename: null, path: null, storage_path: null, local_filename: null, supabase_row: null, supabase_error: null, status: 'uploaded', chunk_count: 0 },
  { id: 2, title: 'Sample Doc B', uploadedBy: 'user', created_at: new Date().toISOString(), filename: null, path: null, storage_path: null, local_filename: null, supabase_row: null, supabase_error: null, status: 'uploaded', chunk_count: 0 },
];

function nextId() {
  return docs.length ? Math.max(...docs.map(d => (typeof d.id === 'number' ? d.id : 0))) + 1 : 1;
}

function sanitizeFilename(name) {
  return (name || '').replace(/[^a-zA-Z0-9.\-_]/g, '_');
}

function isUuid(val) {
  return typeof val === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val);
}

/* --------- Helpers: robust insert to supabase --------- */
async function insertMetadataToSupabase(insertObj) {
  if (!supabase) return { inserted: null, error: new Error('Supabase not configured') };

  try {
    const { data, error } = await supabase
      .from('documents')
      .insert([insertObj])
      .select()
      .limit(1);

    if (error) {
      // handle missing 'path' column by retrying without it
      const msg = (error && (error.message || JSON.stringify(error))).toLowerCase();
      if (msg.includes("'path'") || msg.includes('could not find the') || (msg.includes('column') && msg.includes('path'))) {
        const fallback = Object.assign({}, insertObj);
        delete fallback.path;
        const { data: df, error: ef } = await supabase
          .from('documents')
          .insert([fallback])
          .select()
          .limit(1);
        if (ef) return { inserted: null, error: ef };
        return { inserted: df && df[0] ? df[0] : null, error: null };
      }
      return { inserted: null, error };
    }

    return { inserted: data && data[0] ? data[0] : null, error: null };
  } catch (e) {
    return { inserted: null, error: e };
  }
}

/* --------- Helper: normalize a supabase row to frontend doc shape --------- */
function normalizeRowToDoc(row) {
  return {
    id: row.id,
    title: row.title || row.filename || row.storage_path || 'untitled',
    uploadedBy: row.uploaded_by || null,
    created_at: row.created_at,
    filename: row.filename || null,
    path: row.path || null,
    storage_path: row.storage_path || null,
    file_size: row.file_size || null,
    pages: row.pages || null,
    status: row.status || 'uploaded',
    supabase_row: row,
    supabase_error: null,
    chunk_count: 0
  };
}

/* --------- Helper: resolve a doc by param (uuid or numeric or storage_path/filename) --------- */
async function resolveDocByParam(idParam) {
  // if UUID-like, try Supabase document id
  if (isUuid(idParam)) {
    if (supabase) {
      try {
        const { data, error } = await supabase
          .from('documents')
          .select('*')
          .eq('id', idParam)
          .limit(1)
          .single();

        if (error) {
          return null;
        }
        return normalizeRowToDoc(data);
      } catch (e) {
        return null;
      }
    }
    return null;
  }

  // not UUID: maybe numeric in-memory id
  const num = Number(idParam);
  if (!Number.isNaN(num)) {
    const mem = docs.find(d => typeof d.id === 'number' && d.id === num);
    if (mem) return mem;
  }

  // fallback: if supabase, try find by storage_path or filename
  if (supabase) {
    try {
      // try storage_path
      let q = await supabase.from('documents').select('*').eq('storage_path', idParam).limit(1).single();
      if (!q.error && q.data) return normalizeRowToDoc(q.data);
      // try filename
      q = await supabase.from('documents').select('*').eq('filename', idParam).limit(1).single();
      if (!q.error && q.data) return normalizeRowToDoc(q.data);
    } catch (e) {
      // ignore
    }
  }

  return null;
}

/* ----------------- Routes ----------------- */

/**
 * GET /api/admin/documents
 * If supabase is configured, read from documents table and return normalized rows with chunk_count.
 * Otherwise return in-memory docs (useful for dev).
 */
router.get('/documents', async (req, res) => {
  if (!supabase) {
    const fallback = docs.map(d => Object.assign({}, d, { chunk_count: d.chunk_count || 0, status: d.status || 'uploaded' }));
    return res.json({ status: 'ok', data: fallback });
  }

  try {
    const { data, error } = await supabase
      .from('documents')
      .select('id, title, filename, storage_path, path, file_size, pages, status, uploaded_by, created_at')
      .order('created_at', { ascending: false });

    if (error) {
      console.warn('Supabase select documents error:', error);
      const fallback = docs.map(d => Object.assign({}, d, { chunk_count: d.chunk_count || 0, status: d.status || 'uploaded' }));
      return res.json({ status: 'ok', data: fallback });
    }

    const normalized = (data || []).map(row => normalizeRowToDoc(row));

    // compute chunk_count for each doc (sequentially)
    for (let doc of normalized) {
      try {
        const docIdKey = doc.supabase_row?.id || doc.storage_path || doc.filename || doc.id;

        // use head:true + count:'exact' to only fetch count
        const q = await supabase
          .from('chunks')
          .select('id', { head: true, count: 'exact' })
          .eq('document_id', docIdKey);

        if (q.error) {
          console.warn('chunk count error for', docIdKey, q.error);
          doc.chunk_count = 0;
        } else {
          doc.chunk_count = typeof q.count === 'number' ? q.count : 0;
        }
      } catch (e) {
        console.warn('exception counting chunks for', doc.storage_path, e && e.message);
        doc.chunk_count = 0;
      }

      if (!doc.path && doc.storage_path && SUPABASE_PUBLIC) {
        try {
          const pub = supabase.storage.from(SUPABASE_BUCKET).getPublicUrl(doc.storage_path);
          if (pub && pub.data && pub.data.publicUrl) doc.path = pub.data.publicUrl;
        } catch (e) {
          // ignore
        }
      }

      if (!doc.status) doc.status = 'uploaded';
    }

    return res.json({ status: 'ok', data: normalized });
  } catch (err) {
    console.error('GET /api/admin/documents exception', err && (err.stack || err.message || err));
    const fallback = docs.map(d => Object.assign({}, d, { chunk_count: d.chunk_count || 0, status: d.status || 'uploaded' }));
    return res.json({ status: 'ok', data: fallback });
  }
});

/**
 * GET /api/admin/documents/:id
 */
router.get('/documents/:id', async (req, res) => {
  const idParam = req.params.id;
  // numeric in-memory
  if (!isUuid(idParam)) {
    const n = Number(idParam);
    if (!Number.isNaN(n)) {
      const mem = docs.find(d => typeof d.id === 'number' && d.id === n);
      if (mem) return res.json({ status: 'ok', data: mem });
    }
  }

  const doc = await resolveDocByParam(idParam);
  if (!doc) return res.status(404).json({ status: 'error', message: 'Not found' });
  return res.json({ status: 'ok', data: doc });
});

/**
 * POST /api/admin/documents
 * Upload and optionally insert metadata to Supabase
 */
router.post('/documents', upload.single('file'), async (req, res) => {
  try {
    const file = req.file || null;
    const body = req.body || {};

    if (!file && !body.title) {
      return res.status(400).json({ status: 'error', message: 'No file uploaded and no title provided' });
    }

    const safeOriginal = file ? sanitizeFilename(file.originalname) : null;
    const storageFilename = file ? `${Date.now()}-${safeOriginal}` : null;

    const newDocBase = {
      title: body.title || (file && file.originalname) || 'untitled',
      uploadedBy: body.uploadedBy || body.uploaded_by || 'admin',
      created_at: new Date().toISOString(),
      filename: file ? file.originalname : null,
      storage_path: null,
      path: null,
      local_filename: null,
      supabase_row: null,
      supabase_error: null,
      status: 'uploaded',
      chunk_count: 0
    };

    if (supabase && file) {
      const storagePath = storageFilename;
      try {
        const { error: uploadError } = await supabase
          .storage
          .from(SUPABASE_BUCKET)
          .upload(storagePath, file.buffer, {
            contentType: file.mimetype,
            upsert: false
          });

        if (uploadError) {
          console.error('Supabase storage.upload error:', uploadError);
          newDocBase.supabase_error = uploadError.message || JSON.stringify(uploadError);
        } else {
          newDocBase.storage_path = storagePath;

          // URL generation
          try {
            if (SUPABASE_PUBLIC) {
              const { data: publicData } = supabase.storage.from(SUPABASE_BUCKET).getPublicUrl(storagePath);
              newDocBase.path = publicData?.publicUrl || null;
            } else {
              const { data: signedData, error: signedErr } = await supabase.storage.from(SUPABASE_BUCKET).createSignedUrl(storagePath, 60 * 60);
              if (signedErr) {
                console.warn('createSignedUrl error:', signedErr);
                newDocBase.path = null;
              } else newDocBase.path = signedData?.signedUrl || null;
            }
          } catch (e) {
            console.warn('URL generation failed:', e && (e.message || e));
            newDocBase.path = null;
          }

          // Build insert object
          const insertObj = {
            title: newDocBase.title,
            filename: newDocBase.filename,
            storage_path: newDocBase.storage_path,
            file_size: body.file_size ? Number(body.file_size) : (file ? file.size : null),
            pages: body.pages ? Number(body.pages) : null,
            status: 'uploaded',
            created_at: new Date().toISOString()
          };

          const maybeUploader = body.uploaded_by || body.uploadedBy || (isUuid(newDocBase.uploadedBy) ? newDocBase.uploadedBy : null);
          if (isUuid(maybeUploader)) insertObj.uploaded_by = maybeUploader;
          else insertObj.uploaded_by = null;

          if (SUPABASE_INCLUDE_PATH && newDocBase.path) insertObj.path = newDocBase.path;

          const { inserted, error } = await insertMetadataToSupabase(insertObj);
          if (error) {
            console.error('Supabase insert error:', error && (error.message || error));
            newDocBase.supabase_error = (newDocBase.supabase_error ? newDocBase.supabase_error + '; ' : '') + (error.message || String(error));
          } else if (inserted) {
            newDocBase.supabase_row = inserted;
            // if inserted has id, we might want to fetch initial chunk_count (0)
            newDocBase.chunk_count = 0;
          }
        }
      } catch (e) {
        console.error('Exception during supabase storage/upload:', e && (e.stack || e.message || e));
        newDocBase.supabase_error = (newDocBase.supabase_error ? newDocBase.supabase_error + '; ' : '') + (e.message || String(e));
      }
    } else if (file) {
      const diskFilename = storageFilename || `${Date.now()}-${safeOriginal}`;
      const diskPath = path.join(uploadsDir, diskFilename);
      fs.writeFileSync(diskPath, file.buffer);
      newDocBase.local_filename = diskFilename;
      newDocBase.storage_path = null;
      newDocBase.path = `/uploads/${diskFilename}`;
    }

    // Push into in-memory docs (id numeric) OR if supabase_row exists prefer UUID id
    const memEntry = Object.assign({}, newDocBase);
    if (memEntry.supabase_row && memEntry.supabase_row.id) {
      memEntry.id = memEntry.supabase_row.id; // use uuid
    } else {
      memEntry.id = nextId();
    }
    docs.push(memEntry);

    return res.status(201).json({ status: 'ok', data: memEntry });
  } catch (err) {
    console.error('POST /documents error', err && (err.stack || err.message || err));
    return res.status(500).json({ status: 'error', message: err && (err.message || 'Internal server error') });
  }
});

/**
 * Compatibility: POST /api/admin/documents/upload
 */
router.post('/documents/upload', upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ status: 'error', message: 'No file uploaded' });
    const safeOriginal = sanitizeFilename(file.originalname);
    const storagePath = `${Date.now()}-${safeOriginal}`;

    let publicUrl = null;
    try {
      if (supabase) {
        const { error } = await supabase.storage.from(SUPABASE_BUCKET).upload(storagePath, file.buffer, {
          contentType: file.mimetype,
          upsert: false
        });
        if (!error) {
          if (SUPABASE_PUBLIC) {
            const { data: pub } = supabase.storage.from(SUPABASE_BUCKET).getPublicUrl(storagePath);
            publicUrl = pub?.publicUrl || null;
          } else {
            const { data: signed } = await supabase.storage.from(SUPABASE_BUCKET).createSignedUrl(storagePath, 60 * 60);
            publicUrl = signed?.signedUrl || null;
          }
        } else {
          console.error('Supabase upload (compat) error:', error);
        }
      } else {
        fs.writeFileSync(path.join(uploadsDir, storagePath), file.buffer);
        publicUrl = `/uploads/${storagePath}`;
      }
    } catch (e) {
      console.error('compat upload exception:', e && (e.stack || e.message || e));
    }

    return res.json({ status: 'ok', filename: storagePath, path: publicUrl });
  } catch (e) {
    console.error('documents/upload exception', e && (e.stack || e.message || e));
    return res.status(500).json({ status: 'error', message: e && (e.message || 'Upload failed') });
  }
});

/**
 * GET /api/admin/documents/:id/view
 * Redirect to public url / signed url / local uploads
 */
router.get('/documents/:id/view', async (req, res) => {
  const idParam = req.params.id;
  const doc = await resolveDocByParam(idParam);
  if (!doc) return res.status(404).send('Not found');

  // if we have a public http path, redirect there
  if (doc.path && typeof doc.path === 'string' && doc.path.startsWith('http')) return res.redirect(doc.path);

  // if stored in supabase and we have storage_path, generate public or signed url
  if (supabase && doc.storage_path) {
    try {
      if (SUPABASE_PUBLIC) {
        const { data } = supabase.storage.from(SUPABASE_BUCKET).getPublicUrl(doc.storage_path);
        if (data?.publicUrl) return res.redirect(data.publicUrl);
      } else {
        const { data: signed } = await supabase.storage.from(SUPABASE_BUCKET).createSignedUrl(doc.storage_path, 60 * 60);
        if (signed?.signedUrl) return res.redirect(signed.signedUrl);
      }
    } catch (e) {
      console.warn('view redirect supabase error', e && (e.message || e));
    }
  }

  // local fallback (dev)
  if (doc.local_filename) {
    const localPath = `/uploads/${doc.local_filename}`;
    return res.redirect(localPath);
  }

  return res.status(404).send('No file available');
});

/**
 * DELETE /api/admin/documents/:id
 * Remove storage object, DB row, chunks, and in-memory doc
 */
router.delete('/documents/:id', async (req, res) => {
  try {
    const idParam = req.params.id;
    // find mem index by numeric id or uuid
    let idx = docs.findIndex(d => (typeof d.id === 'number' && String(d.id) === String(idParam)) || String(d.id) === String(idParam));
    let removed = null;
    if (idx !== -1) {
      removed = docs.splice(idx, 1)[0];
    } else {
      // not in memory: try resolve via supabase
      const doc = await resolveDocByParam(idParam);
      if (doc) removed = doc;
    }

    if (!removed) return res.status(404).json({ status: 'error', message: 'Not found' });

    // delete storage file if present
    if (supabase && removed && removed.storage_path) {
      try {
        const { error } = await supabase.storage.from(SUPABASE_BUCKET).remove([removed.storage_path]);
        if (error) console.warn('Failed to remove storage object:', error);
      } catch (e) {
        console.warn('Exception removing storage object:', e && (e.message || e));
      }
    }

    // delete DB row by storage_path or filename or id
    if (supabase) {
      try {
        if (removed.storage_path) {
          await supabase.from('documents').delete().eq('storage_path', removed.storage_path).limit(1);
        } else if (removed.filename) {
          await supabase.from('documents').delete().eq('filename', removed.filename).limit(1);
        } else if (removed.supabase_row?.id) {
          await supabase.from('documents').delete().eq('id', removed.supabase_row.id).limit(1);
        } else if (isUuid(removed.id)) {
          await supabase.from('documents').delete().eq('id', removed.id).limit(1);
        }
      } catch (e) {
        console.warn('Supabase delete row error', e && (e.message || e));
      }

      // delete chunks by document_id (try supabase_row.id then storage_path then filename)
      try {
        const docIdKey = removed.supabase_row?.id || removed.storage_path || removed.filename || String(removed.id);
        await supabase.from('chunks').delete().eq('document_id', docIdKey);
      } catch (e) {
        console.warn('Supabase delete chunks error', e && (e.message || e));
      }
    }

    // delete local file if present
    const maybeLocal = removed.local_filename || removed.storage_path;
    if (maybeLocal) {
      try {
        const p = path.join(uploadsDir, maybeLocal);
        if (fs.existsSync(p)) fs.unlinkSync(p);
      } catch (e) {}
    }

    return res.json({ status: 'ok', message: 'deleted', data: removed });
  } catch (err) {
    console.error('DELETE /documents error', err && (err.stack || err.message || err));
    return res.status(500).json({ status: 'error', message: err && err.message });
  }
});

/**
 * GET /api/admin/documents/:id/chunks
 * Query Supabase chunks table by document id (prefers supabase_row.id)
 */
router.get('/documents/:id/chunks', async (req, res) => {
  try {
    const idParam = req.params.id;
    const doc = await resolveDocByParam(idParam);
    if (!doc) return res.status(404).json({ status: 'error', message: 'Not found' });

    if (!supabase) return res.status(500).json({ status: 'error', message: 'Supabase not configured' });

    const docIdKey = doc.supabase_row?.id || doc.storage_path || doc.filename || String(doc.id);

    const { data, error } = await supabase
      .from('chunks')
      // schema: id, document_id, chunk_index, text, tokens, embedding, created_at
      .select('id,document_id,chunk_index,text,tokens,created_at')
      .eq('document_id', docIdKey)
      .order('chunk_index', { ascending: true });

    if (error) {
      console.error('chunks select error', error);
      return res.status(500).json({ status: 'error', message: error.message || String(error) });
    }

    // map DB 'text' to 'content' for compatibility if frontend expects content
    const rows = (data || []).map(r => ({
      id: r.id,
      document_id: r.document_id,
      chunk_index: r.chunk_index,
      tokens: r.tokens,
      content: r.text,
      text: r.text,
      created_at: r.created_at
    }));

    return res.json({ status: 'ok', data: rows });
  } catch (err) {
    console.error('GET chunks error', err && (err.stack || err.message || err));
    return res.status(500).json({ status: 'error', message: err && err.message });
  }
});

/**
 * POST /api/admin/documents/:id/process
 * Trigger python RAG service to process (chunk & embed).
 * Marks document as 'processing' in DB immediately so UI won't hang.
 */
router.post('/documents/:id/process', async (req, res) => {
  try {
    const idParam = req.params.id;
    const doc = await resolveDocByParam(idParam);
    if (!doc) return res.status(404).json({ status: 'error', message: 'Not found' });

    // prefer DB uuid if available (doc.supabase_row.id) else storage_path/filename/string id
    const document_id = doc.supabase_row?.id || doc.storage_path || doc.filename || String(doc.id);

    // set status 'processing' asap in DB (best-effort)
    if (supabase && doc.supabase_row?.id) {
      try {
        await supabase.from('documents').update({ status: 'processing' }).eq('id', doc.supabase_row.id);
      } catch (e) {
        console.warn('Could not set document status=processing in DB:', e);
      }
    }
    // also update in-memory docs entry for immediate UI feedback
    const memIndex = docs.findIndex(d => String(d.id) === String(doc.id) || String(d.storage_path) === String(doc.storage_path));
    if (memIndex !== -1) {
      docs[memIndex].status = 'processing';
    }

    const payload = {
      document_id,
      public_url: doc.path || null,
      storage_path: doc.storage_path || null,
      filename: doc.filename || null
    };

    const RAG_SERVICE_URL = process.env.RAG_SERVICE_URL;
    if (!RAG_SERVICE_URL) {
      // mark error if no RAG configured
      if (supabase && doc.supabase_row?.id) {
        try { await supabase.from('documents').update({ status: 'error' }).eq('id', doc.supabase_row.id); } catch(e){}
      }
      if (memIndex !== -1) docs[memIndex].status = 'error';
      return res.status(500).json({ status: 'error', message: 'RAG_SERVICE_URL not configured on backend' });
    }

    // fire the RAG worker (don't block UI longer than necessary) -> still wait for response to propagate errors
    try {
      const r = await fetch(RAG_SERVICE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const text = await r.text();
      let j;
      try { j = JSON.parse(text); } catch { j = { raw: text }; }

      if (!r.ok) {
        // mark error
        if (supabase && doc.supabase_row?.id) {
          try { await supabase.from('documents').update({ status: 'error' }).eq('id', doc.supabase_row.id); } catch(e){}
        }
        if (memIndex !== -1) docs[memIndex].status = 'error';
        return res.status(500).json({ status: 'error', message: 'RAG service error', detail: j });
      }

      // success: indexer accepted job. Indexer itself should update documents.status -> 'embedded'
      // We still return success here so frontend can poll DB for final status
      return res.json({ status: 'ok', message: 'processing triggered', rag: j });
    } catch (e) {
      console.error('Failed to call RAG service', e && (e.stack || e.message || e));
      // mark error
      if (supabase && doc.supabase_row?.id) {
        try { await supabase.from('documents').update({ status: 'error' }).eq('id', doc.supabase_row.id); } catch(e){}
      }
      if (memIndex !== -1) docs[memIndex].status = 'error';
      return res.status(500).json({ status: 'error', message: 'Failed to contact RAG service', detail: e && e.message });
    }
  } catch (e) {
    console.error('POST process error', e && (e.stack || e.message || e));
    return res.status(500).json({ status: 'error', message: e && e.message });
  }
});


module.exports = router;
