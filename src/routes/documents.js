// src/routes/documents.js
const express = require('express')
const multer = require('multer')
const crypto = require('crypto')
const supabase = require('../supabase')
const cfg = require('../config')
const { requireAuth, requireAdmin } = require('../middleware/auth')

const router = express.Router()
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } })

function safeExt(name, fallback = 'pdf') {
  const ext = (name?.split('.').pop() || fallback).toLowerCase()
  return ext.replace(/[^a-z0-9]/g, '') || fallback
}
function randomKey(bytes = 6) {
  return crypto.randomBytes(bytes).toString('hex')
}

// upload
router.post('/upload', requireAuth, requireAdmin, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'file is required' })
    if (req.file.mimetype && !/pdf/i.test(req.file.mimetype)) return res.status(400).json({ error: 'only PDF is supported' })

    const title = req.body?.title?.toString().slice(0, 180) || req.file.originalname.slice(0, 180)
    const ext = safeExt(req.file.originalname, 'pdf')
    const now = new Date()
    const y = now.getUTCFullYear(); const m = String(now.getUTCMonth() + 1).padStart(2, '0')
    const storage_path = `${y}/${m}/${randomKey(8)}.${ext}`

    const { error: upErr } = await supabase.storage.from(cfg.BUCKET).upload(storage_path, req.file.buffer, {
      contentType: req.file.mimetype || 'application/pdf', upsert: false
    })
    if (upErr) return res.status(500).json({ error: upErr.message })

    const { data, error: insErr } = await supabase.from(cfg.TABLE).insert({ title, storage_path, size: req.file.size, status: 'uploaded' }).select().single()
    if (insErr) return res.status(500).json({ error: insErr.message })

    return res.json({ ok: true, document: data })
  } catch (e) {
    console.error('[documents/upload] error', e)
    return res.status(500).json({ error: 'internal' })
  }
})

// list, get, delete, chunks etc — keep your logic but prefixed with router
router.get('/', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase.from(cfg.TABLE).select('*').order('created_at', { ascending: false }).limit(100)
    if (error) return res.status(500).json({ error: error.message })
    return res.json({ items: data || [] })
  } catch (e) {
    console.error('[documents] list error', e)
    return res.status(500).json({ error: 'internal' })
  }
})

router.get('/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase.from(cfg.TABLE).select('id, title, storage_path, size, status, created_at').eq('id', req.params.id).single()
    if (error || !data) return res.status(404).json({ error: 'document not found' })
    return res.json({ document: data })
  } catch (e) {
    console.error('[documents/:id] error', e)
    return res.status(500).json({ error: 'internal' })
  }
})

// export router
module.exports = router
