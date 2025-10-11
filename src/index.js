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
// or set to "*" to allow all origins (not recommended for production)
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN ?? 'http://localhost:5173';
const allowedOrigins = FRONTEND_ORIGIN === '*' ? ['*'] : FRONTEND_ORIGIN.split(',').map(s => s.trim()).filter(Boolean);

// cors options factory
const corsOptions = {
  origin: function(origin, callback) {
    // allow requests with no origin (like curl, server-to-server)
    if (!origin) return callback(null, true);
    // if wildcard '*', allow any origin
    if (allowedOrigins.length === 1 && allowedOrigins[0] === '*') return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    // reject other origins
    return callback(new Error('Not allowed by CORS: ' + origin));
  },
  credentials: true,
  methods: ['GET','HEAD','PUT','PATCH','POST','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','X-Service-Key','x-service-key']
};

// apply CORS middleware globally with those options
app.use(cors(corsOptions));
// ensure preflight (OPTIONS) returns proper headers
app.options('*', cors(corsOptions));

// body parser (express built-in)
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

// optional simple request logger (uncomment while debugging)
// app.use((req, res, next) => {
//   console.log(`${new Date().toISOString()} ${req.method} ${req.originalUrl}`);
//   next();
// });

app.get('/health', (req, res) => res.json({ ok: true, env: process.env.NODE_ENV || 'dev' }));

// mount routers (CORS already applied globally)
app.use('/api/chat', chatRouter);
app.use('/api/admin', adminRouter);

// ensure error responses include CORS headers and are JSON
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err && (err.stack || err.message || err));
  // if CORS origin not allowed, reply 403 with message
  if (err && err.message && err.message.startsWith('Not allowed by CORS')) {
    // set CORS allow credentials header for clarity (origin rejected)
    res.status(403).json({ error: 'CORS error', message: err.message });
    return;
  }
  const status = err?.status || 500;
  res.status(status).json({ error: 'server_error', message: err?.message || 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Tutor-backend listening on port ${PORT}`);
});
