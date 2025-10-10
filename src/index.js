// src/index.js
const express = require('express')
const cors = require('cors')
const cfg = require('./config')
const metaRouter = require('./routes/meta')
const docsRouter = require('./routes/documents')
const chatRouter = require('./routes/chat')

const app = express()

// CORS (same logic as before)
const allowedOrigins = cfg.WEB_ORIGIN ? cfg.WEB_ORIGIN.split(',').map(s=>s.trim()).filter(Boolean) : ['*']
const corsOptions = allowedOrigins.includes('*') ? { origin: true, credentials: true } : {
  origin(origin, cb) { if (!origin) return cb(null, true); cb(null, allowedOrigins.includes(origin)) }, credentials: true
}
app.use(cors(corsOptions))
app.options('*', cors(corsOptions))
app.use(express.json({ limit: '10mb' }))

// request logger
app.use((req, res, next) => {
  const start = Date.now()
  res.on('finish', () => {
    const ms = Date.now() - start
    console.log(`[req] ${req.method} ${req.originalUrl} ${res.statusCode} - ${ms}ms`)
  })
  next()
})

// mount routes
app.use('/', metaRouter)
app.use('/documents', docsRouter)
app.use('/chat', chatRouter)

// diagnostics & graceful shutdown
process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaughtException:', err && (err.stack || err.message || String(err)))
})
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandledRejection:', reason && (reason.stack || reason.message || String(reason)))
})

let shuttingDown = false
async function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  console.warn(`[shutdown] Received ${signal}. Closing server...`)
  setTimeout(()=> { console.warn('[shutdown] Exiting now'); process.exit(0) }, 5000)
}
process.on('SIGTERM', () => { try { process.stderr.write('SIGTERM received\n') } catch {} ; shutdown('SIGTERM') })
process.on('SIGINT', () => { try { process.stderr.write('SIGINT received\n') } catch {} ; shutdown('SIGINT') })

// periodic mem log
setInterval(() => {
  try {
    const m = process.memoryUsage()
    console.log(`[mem] rss=${Math.round(m.rss/1024/1024)}MB heapUsed=${Math.round(m.heapUsed/1024/1024)}MB`)
  } catch(e) {}
}, 5000)

// start
console.log('---- Startup info ----')
console.log('NODE_ENV:', cfg.NODE_ENV)
console.log('PORT:', cfg.PORT)
console.log('SUPABASE_URL set:', !!cfg.SUPABASE_URL)
console.log('SERVICE_KEY set:', !!cfg.SERVICE_KEY)
console.log('INDEXER_URL set:', !!cfg.INDEXER_URL)
console.log('GEMINI_API_KEY set:', !!cfg.GEMINI_API_KEY)
console.log('WEB_ORIGIN:', cfg.WEB_ORIGIN || '(not set)')
console.log('----------------------')

const server = app.listen(cfg.PORT, '0.0.0.0', () => console.log(`API running on port ${cfg.PORT}`))
server.on('error', (err) => console.error('[server] error', err && (err.stack || err.message || String(err))))
