// src/index.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');

const chatRouter = require('./routes/chat');
const adminRouter = require('./routes/admin');

const app = express();
const PORT = process.env.PORT || 8080;

// Support behind proxies (Railway)
app.set('trust proxy', 1);

// FRONTEND_ORIGIN can be a comma-separated list, e.g. "http://localhost:5173,https://your-prod.frontend"
// Use "*" to allow all origins (dev only; not recommended for production)
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN ?? 'http://localhost:5173';
const allowedOrigins = (FRONTEND_ORIGIN === '*')
  ? ['*']
  : FRONTEND_ORIGIN.split(',').map(s => s.trim()).filter(Boolean);

// CORS options factory
const corsOptions = {
  origin: function(origin, callback) {
    // allow requests with no origin (like curl, server-to-server)
    if (!origin) return callback(null, true);

    // if wildcard '*' is set, allow any origin
    if (allowedOrigins.length === 1 && allowedOrigins[0] === '*') return callback(null, true);

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    // Don't throw; reject by returning false (browser will block request)
    return callback(null, false);
  },
  credentials: true,
  methods: ['GET','HEAD','PUT','PATCH','POST','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','X-Service-Key','x-service-key']
};

// Apply CORS globally
app.use(cors(corsOptions));
// === Explicit OPTIONS handler + debug logging (paste after app.options(...))
app.use((req, res, next) => {
  // log basic info for debugging preflight / CORS issues
  console.log(`REQ: ${new Date().toISOString()} ${req.method} ${req.originalUrl} Origin=${req.headers.origin || ''}`);
  next();
});

// Explicit preflight responder (defensive; ensures headers are returned)
app.use((req, res, next) => {
  if (req.method === 'OPTIONS') {
    // Set CORS response headers explicitly (mirrors corsOptions)
    const origin = req.headers.origin;
    if (!origin) {
      res.setHeader('Access-Control-Allow-Origin', '*');
    } else {
      // allow only configured origins (keep same logic as corsOptions)
      const allowed = (process.env.FRONTEND_ORIGIN === '*')
        ? true
        : (process.env.FRONTEND_ORIGIN || 'http://localhost:5173').split(',').map(s => s.trim()).includes(origin);
      if (allowed) res.setHeader('Access-Control-Allow-Origin', origin);
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Service-Key,x-service-key');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    // arbitrary small body, but 204 is ideal
    return res.status(204).send('');
  }
  next();
});

// Ensure preflight (OPTIONS) returns proper headers
app.options('*', cors(corsOptions));

// Body parser
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

// Optional logging during development
// app.use((req, res, next) => {
//   console.log(`${new Date().toISOString()} ${req.method} ${req.originalUrl}`);
//   next();
// });

// Health
app.get('/health', (req, res) => res.json({ ok: true, env: process.env.NODE_ENV || 'dev' }));

// Mount routers
// IMPORTANT: adminRouter should use middleware that skips OPTIONS (we will ensure below)
app.use('/api/chat', chatRouter);
app.use('/api/admin', adminRouter);

// Error handler — ensure JSON response and avoid leaking stack in prod
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err && (err.stack || err.message || err));
  // If CORS callback returned false earlier, express-cors sets no header; we respond 403
  if (err && err.message && err.message.startsWith('Not allowed by CORS')) {
    return res.status(403).json({ error: 'CORS error', message: err.message });
  }
  const status = err?.status || 500;
  return res.status(status).json({ error: 'server_error', message: err?.message || 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Tutor-backend listening on port ${PORT}`);
});
