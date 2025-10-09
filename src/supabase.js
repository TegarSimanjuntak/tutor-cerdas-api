import { createClient } from '@supabase/supabase-js'
import { env } from './env.js'

// Client pakai SERVICE ROLE (hanya di server!)
export const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
})
