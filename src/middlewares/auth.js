import { supabaseAdmin } from '../supabase.js'

/** Verifikasi Bearer token & sematkan user + role */
export async function requireAuth(req, res, next) {
  try {
    const auth = req.headers['authorization'] || ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null
    if (!token) return res.status(401).json({ error: 'Missing Bearer token' })

    const { data, error } = await supabaseAdmin.auth.getUser(token)
    if (error || !data?.user) return res.status(401).json({ error: 'Invalid token' })

    req.user = data.user

    // Ambil role dari profiles
    const { data: prof, error: e2 } = await supabaseAdmin
      .from('profiles')
      .select('role, full_name')
      .eq('id', req.user.id)
      .single()

    if (e2) {
      // fallback aman, tapi log
      console.warn('[auth] profiles lookup failed:', e2.message)
      req.role = 'user'
      req.profile = null
    } else {
      req.role = prof?.role || 'user'
      req.profile = prof || null
    }

    next()
  } catch (err) {
    console.error('[requireAuth] fatal', err)
    res.status(500).json({ error: 'Auth middleware error' })
  }
}

/** Batasi akses ke role tertentu (mis. 'admin') */
export function requireRole(...allow) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthenticated' })
    if (!allow.includes(req.role)) {
      return res.status(403).json({ error: 'Forbidden', required: allow })
    }
    next()
  }
}
