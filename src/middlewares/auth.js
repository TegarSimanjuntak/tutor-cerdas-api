import { supabaseAdmin } from '../supabase.js'

/**
 * ✅ Middleware autentikasi utama
 * - Verifikasi Bearer token
 * - Ambil data user dari Supabase
 * - Sematkan user, role, dan profil ke req
 */
export async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization || req.headers.Authorization
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid Authorization header' })
    }

    const token = authHeader.split(' ')[1]?.trim()
    if (!token) {
      return res.status(401).json({ error: 'Missing Bearer token' })
    }

    // ✅ Verifikasi token dengan Supabase
    const { data, error } = await supabaseAdmin.auth.getUser(token)
    if (error || !data?.user) {
      console.warn('[Auth] Invalid token:', error?.message)
      return res.status(401).json({ error: 'Invalid or expired token' })
    }

    // Simpan user ke request
    req.user = data.user

    // ✅ Ambil profil + role user
    const { data: profile, error: profileErr } = await supabaseAdmin
      .from('profiles')
      .select('id, role, full_name')
      .eq('id', req.user.id)
      .single()

    if (profileErr) {
      console.warn(`[Auth] Failed to fetch profile for ${req.user.id}:`, profileErr.message)
      req.role = 'user'
      req.profile = null
    } else {
      req.role = profile?.role || 'user'
      req.profile = profile || null
    }

    // ✅ Logging minimal (optional)
    // console.log(`[Auth] ${req.user.email} (${req.role}) authenticated`)

    next()
  } catch (err) {
    console.error('[Auth] Unexpected error:', err)
    res.status(500).json({ error: 'Internal authentication error' })
  }
}

/**
 * ✅ Middleware untuk membatasi akses berdasarkan role
 * Contoh: app.get('/admin', requireRole('admin'), handler)
 */
export function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthenticated' })
    }

    if (!req.role || !allowedRoles.includes(req.role)) {
      console.warn(`[Auth] Forbidden: ${req.user.email} (role: ${req.role})`)
      return res.status(403).json({ 
        error: 'Forbidden', 
        message: `Required role: ${allowedRoles.join(', ')}` 
      })
    }

    next()
  }
}
