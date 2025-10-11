// src/routes/admin.js
const express = require('express');
const router = express.Router();
const multer = require('multer');
const { supabaseAdmin } = require('../lib/supabaseClient');
const { fetch } = require('../lib/fetcher');


const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const RAG_WORKER_URL = process.env.RAG_WORKER_URL;
const WORKER_SERVICE_KEY = process.env.WORKER_SERVICE_KEY;

/**
 * Admin upload document (PDF)
 * - This handler uploads PDF bytes to Supabase Storage, creates document row, and returns document id.
 * - Assumes that only admins call this endpoint; you should protect it via middleware or by network-level rules.
 */
router.post('/documents', upload.single('file'), async (req, res) => {
  try {
    // Very basic protection: require WORKER_SERVICE_KEY in header
    const svc = req.headers['x-service-key'] || '';
    if (!svc || svc !== process.env.ADMIN_UPLOAD_KEY) {
      return res.status(403).json({ error: 'forbidden' });
    }

    const { originalname, buffer, mimetype } = req.file || {};
    if (!buffer) return res.status(400).json({ error: 'file required' });
    if (mimetype !== 'application/pdf') return res.status(400).json({ error: 'only pdf allowed' });

    const filename = `${Date.now()}_${originalname.replace(/\s+/g,'_')}`;
    const bucket = process.env.STORAGE_BUCKET || 'documents';
    // upload to supabase storage
    const { data, error } = await supabaseAdmin.storage.from(bucket).upload(filename, buffer, { contentType: mimetype, upsert: false });
    if (error) throw error;

    // create documents row
    const { data: doc, error: docErr } = await supabaseAdmin.from('documents').insert([{
      title: req.body.title || originalname,
      description: req.body.description || '',
      filename: originalname,
      storage_path: `${bucket}/${filename}`,
      file_size: buffer.length,
      status: 'uploaded'
    }]).select().single();
    if (docErr) throw docErr;

    return res.json({ ok: true, document: doc });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || 'upload failed' });
  }
});

/**
 * Trigger processing on RAG worker (chunk + embed)
 * POST /api/admin/process/:document_id
 */
router.post('/process/:document_id', async (req, res) => {
  try {
    const docId = req.params.document_id;
    // basic protection
    if ((req.headers['x-service-key'] || '') !== process.env.ADMIN_UPLOAD_KEY) {
      return res.status(403).json({ error: 'forbidden' });
    }
    const url = `${RAG_WORKER_URL.replace(/\/+$/,'')}/process/document`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-SERVICE-KEY': WORKER_SERVICE_KEY || '' },
      body: JSON.stringify({ document_id: docId })
    });
    const txt = await r.text();
    if (!r.ok) {
      return res.status(500).json({ error: 'worker failed', details: txt });
    }
    return res.json({ ok: true, worker: txt });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || 'process failed' });
  }
});

/**
 * Basic list documents (admin)
 */
router.get('/documents', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin.from('get_document_stats').select('*');
    if (error) throw error;
    return res.json({ items: data });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || 'list failed' });
  }
});

module.exports = router;
