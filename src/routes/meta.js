// src/routes/meta.js
const express = require('express')
const router = express.Router()
const { initGenSdkIfNeeded, getGenModel, usingNewGenAi } = require('../utils/genSdk')
const { fetchWithTimeout } = require('../utils/fetchWithTimeout')
const supabase = require('../supabase')
const cfg = require('../config')

router.get('/', (_req, res) => {
  res.status(200).json({ ok: true, service: 'tutor-cerdas-api', ts: new Date().toISOString() })
})

router.get('/health', (_req, res) => {
  res.json({
    ok: true,
    env: cfg.NODE_ENV,
    indexer: !!cfg.INDEXER_URL,
    supabase: !!(cfg.SUPABASE_URL && cfg.SERVICE_KEY),
    model: cfg.GEMINI_MODEL,
    sdk: getGenModel() ? (usingNewGenAi() ? 'google-genai' : '@google/generative-ai') : '(not-initialized)',
    ts: new Date().toISOString()
  })
})

router.get('/models', async (_req, res) => {
  if (!cfg.GEMINI_API_KEY) return res.status(400).json({ error: 'GEMINI_API_KEY not configured' })
  try {
    initGenSdkIfNeeded()
    if (!getGenModel()) return res.status(500).json({ error: 'Gemini SDK not available' })
    const url = 'https://generativelanguage.googleapis.com/v1/models?key=' + encodeURIComponent(cfg.GEMINI_API_KEY)
    const r = await fetchWithTimeout(url, {}, 10000)
    const body = await r.json().catch(() => ({}))
    return res.status(r.status).json(body)
  } catch (e) {
    console.error('[models] error', e)
    return res.status(500).json({ error: 'list models failed' })
  }
})

router.get('/auth/me', async (req, res) => {
  // this route will be protected by requireAuth in index.js if desired
  try {
    const token = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7).trim() : null
    if (!token) return res.status(401).json({ error: 'Unauthorized' })
    const { data, error } = await supabase.auth.getUser(token)
    if (error || !data?.user) return res.status(401).json({ error: 'Invalid token' })
    const { data: profile } = await supabase.from('profiles').select('role, full_name').eq('id', data.user.id).single()
    return res.json({ ok: true, user: data.user, profile: profile || null })
  } catch (e) {
    console.error('[auth/me] error', e)
    return res.status(500).json({ error: 'internal' })
  }
})

module.exports = router
