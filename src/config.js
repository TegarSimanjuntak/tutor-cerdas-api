// src/config.js
require('dotenv').config()

module.exports = {
  NODE_ENV: process.env.NODE_ENV || 'dev',
  PORT: Number(process.env.PORT) || 8080,
  SUPABASE_URL: process.env.SUPABASE_URL || '',
  SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  BUCKET: process.env.DOCS_BUCKET || 'documents',
  TABLE: process.env.DOCS_TABLE || 'documents',
  INDEXER_URL: process.env.INDEXER_URL || '',
  GEMINI_MODEL: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
  WEB_ORIGIN: process.env.WEB_ORIGIN || ''
}
