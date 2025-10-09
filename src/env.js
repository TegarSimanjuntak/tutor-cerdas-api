import { config } from 'dotenv'
import { z } from 'zod'
config()

const Schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(8080),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  ALLOWED_ORIGINS: z.string().default('*') // comma-separated
})

export const env = Schema.parse(process.env)
