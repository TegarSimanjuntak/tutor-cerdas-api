// src/index.js
const express = require('express')
const cors = require('cors')
const cfg = require('./config')

// require routers (may be CommonJS or ESM default interop)
const metaRouter = require('./routes/meta')
const docsRouter = require('./routes/documents')
const chatRouter = require('./routes/chat')

const app = express()

/* -------------------------
   Middleware / security
   ------------------------- */
// CORS
const allowedOrigins = cfg.WEB_ORIGIN ? cfg.WEB_ORIGIN.split(',').map(s => s.trim()).filter(Boolean) : ['*']
const corsOptions = allowedOrigins.includes('*')
  ? { origin: true, credentials: true }
  : {
      origin(origin, cb) {
        if (!origin) return cb(null, true)
        cb(null, allowedOrigins.includes(origin))
      },
      credentials: true
    }

app.use(cors(corsOptions))
app.options('*', cors(corsOptions))
app.use(express.json({ limit: '10mb' }))

// minimal request logger
app.use((req, res, next) => {
  const start = Date.now()
  res.on('finish', () => {
    const ms = Date.now() - start
    console.log(`[req] ${req.method} ${req.originalUrl} ${res.statusCode} - ${ms}ms`)
  })
  next()
})

/* -------------------------
   Router unwrapping helper
   ------------------------- */
function unwrapRouter(r) {
  if (!r) return null
  const candidate = (typeof r === 'object' && r.default) ? r.default : r
  if (typeof candidate !== 'function') {
    // fail fast and produce helpful log
    console.error('[startup] Router is not a function. Check exports of module.', {
      type: typeof candidate,
      hasDefault: typeof r === 'object' && !!r.default
    })
    throw new Error('Router must be a function/middleware')
  }
  return candidate
}

/* -------------------------
   Mount routers (safe)
   ------------------------- */
app.use('/', unwrapRouter(metaRouter))
app.use('/documents', unwrapRouter(docsRouter))
app.use('/chat', unwrapRouter(chatRouter))

/* -------------------------
   Fallback routes & error handling
   ------------------------- */
// If meta router didn't mount GET / (defensive fallback)
app.get('/', (_req, res) => {
  res.status(200).json({ ok: true, service: 'tutor-cerdas-api', ts: new Date().toISOString() })
})

// 404 handler for unknown routes (JSON)
app.use((req, res) => {
  res.status(404).json({ error: 'not_found', path: req.originalUrl })
})

// centralized error handler (must be last `app.use`)
app.use((err, req, res, _next) => {
  console.error('[error] unhandled', err && (err.stack || err.message || String(err)))
  const status = err && err.status && Number.isFinite(err.status) ? err.status : 500
  res.status(status).json({ error: 'internal_error', message: err?.message || 'internal error' })
})

/* -------------------------
   Diagnostics & graceful shutdown
   ------------------------- */
process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaughtException:', err && (err.stack || err.message || String(err)))
  // attempt graceful shutdown
  try { shutdown('uncaughtException') } catch (_) { process.exit(1) }
})
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandledRejection:', reason && (reason.stack || reason.message || String(reason)))
  try { shutdown('unhandledRejection') } catch (_) { process.exit(1) }
})

let shuttingDown = false
let memInterval = null
let server = null

function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  console.warn(`[shutdown] Received ${signal}. Closing server...`)

  // clear interval(s)
  try { if (memInterval) clearInterval(memInterval) } catch (e) {}

  // close server if started
  try {
    if (server) {
      server.close((err) => {
        if (err) {
          console.error('[shutdown] server.close error', err)
          process.exit(1)
        } else {
          console.warn('[shutdown] server closed gracefully')
          process.exit(0)
        }
      })
      // fallback: force exit if not closed in X ms
      setTimeout(() => {
        console.warn('[shutdown] forcing exit after timeout')
        process.exit(0)
      }, 5000).unref()
    } else {
      process.exit(0)
    }
  } catch (e) {
    console.error('[shutdown] fatal', e)
    process.exit(1)
  }
}

process.on('SIGTERM', () => {
  try { process.stderr.write('SIGTERM received\n') } catch (e) {}
  shutdown('SIGTERM')
})
process.on('SIGINT', () => {
  try { process.stderr.write('SIGINT received\n') } catch (e) {}
  shutdown('SIGINT')
})

/* periodic mem log to help spot OOM issues */
memInterval = setInterval(() => {
  try {
    const m = process.memoryUsage()
    console.log(`[mem] rss=${Math.round(m.rss/1024/1024)}MB heapUsed=${Math.round(m.heapUsed/1024/1024)}MB`)
  } catch (e) { /* ignore */ }
}, 5000)

/* -------------------------
   Start server
   ------------------------- */
console.log('---- Startup info ----')
console.log('NODE_ENV:', cfg.NODE_ENV)
console.log('PORT:', cfg.PORT)
console.log('SUPABASE_URL set:', !!cfg.SUPABASE_URL)
console.log('SERVICE_KEY set:', !!cfg.SERVICE_KEY)
console.log('INDEXER_URL set:', !!cfg.INDEXER_URL)
console.log('GEMINI_API_KEY set:', !!cfg.GEMINI_API_KEY)
console.log('WEB_ORIGIN:', cfg.WEB_ORIGIN || '(not set)')
console.log('----------------------')

server = app.listen(cfg.PORT, '0.0.0.0', () => {
  console.log(`API running on port ${cfg.PORT}`)
})
server.on('error', (err) => {
  console.error('[server] error', err && (err.stack || err.message || String(err)))
  // if server fails immediately, exit with failure
  try { process.exit(1) } catch (_) {}
})
