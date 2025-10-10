// src/middleware/auth.js
const supabase = require('../supabase')

// helpers
function getToken(req) {
  const h = req.headers.authorization || req.headers.Authorization || ''
  return h.startsWith('Bearer ') ? h.slice(7).trim() : null
}

async function requireAuth(req, res, next) {
  try {
    const token = getToken(req)
    if (!token) return res.status(401).json({ error: 'Unauthorized' })

    const { data, error } = await supabase.auth.getUser(token)
    if (error || !data?.user) {
      console.warn('[auth] invalid token:', error?.message)
      return res.status(401).json({ error: 'Invalid token' })
    }

    req.user = data.user
    next()
  } catch (e) {
    console.error('[auth] unexpected error', e)
    return res.status(401).json({ error: 'Auth failed' })
  }
}

async function isAdminUser(userId) {
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', userId)
      .single()
    if (error || !data) return false
    return data.role === 'admin'
  } catch (e) {
    console.warn('[isAdminUser] error', e)
    return false
  }
}

async function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' })
  const ok = await isAdminUser(req.user.id)
  if (!ok) return res.status(403).json({ error: 'Forbidden' })
  next()
}

module.exports = { getToken, requireAuth, requireAdmin, isAdminUser }
