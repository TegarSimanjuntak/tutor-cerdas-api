// src/supabase.js
const { createClient } = require('@supabase/supabase-js')
const { SUPABASE_URL, SERVICE_KEY } = require('./config')

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.warn('[supabase] WARNING: SUPABASE_URL or SERVICE_KEY missing')
}

const supabase = createClient(SUPABASE_URL || '', SERVICE_KEY || '', {
  auth: { persistSession: false, autoRefreshToken: false }
})

module.exports = supabase
module.exports.supabase = supabase
