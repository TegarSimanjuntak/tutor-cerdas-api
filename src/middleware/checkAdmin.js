// src/middleware/checkAdmin.js
const { supabaseAdmin } = require('../lib/supabaseClient');

async function checkAdmin(req, res, next) {
  try {
    // Allow preflight OPTIONS to pass through without auth checks
    if (req.method === 'OPTIONS') return next();

    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace('Bearer ', '').trim();
    if (!token) return res.status(401).json({ error: 'Missing auth token' });

    const { data: userData, error: getUserError } = await supabaseAdmin.auth.getUser(token);
    if (getUserError || !userData?.user?.id) {
      return res.status(401).json({ error: 'Invalid token' });
    }
    const userId = userData.user.id;

    const { data: profile, error: profErr } = await supabaseAdmin
      .from('profiles')
      .select('role')
      .eq('id', userId)
      .single();

    if (profErr || !profile) {
      return res.status(403).json({ error: 'Profile not found or access denied' });
    }
    if (profile.role !== 'admin') {
      return res.status(403).json({ error: 'Admin role required' });
    }

    // attach user info for downstream handlers
    req.currentUser = { id: userId, role: profile.role };
    return next();
  } catch (err) {
    console.error('checkAdmin err', err);
    return res.status(500).json({ error: 'server error' });
  }
}

module.exports = checkAdmin;
