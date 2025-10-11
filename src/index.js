// src/index.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');

const chatRouter = require('./routes/chat');
const adminRouter = require('./routes/admin');

const app = express();
const PORT = process.env.PORT || 8080;

// FRONTEND_ORIGIN can be a comma-separated list, e.g. "http://localhost:5173,https://your-prod.frontend"
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || 'http://localhost:5173';
const allowedOrigins = FRONTEND_ORIGIN.split(',').map(s => s.trim()).filter(Boolean);

// CORS config: allow credentials and required headers; validate origin against allowedOrigins
app.use(cors({
  origin: function(origin, callback) {
    // allow requests with no origin (e.g. curl, server-to-server)
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) !== -1) {
      return callback(null, true);
    }
    return callback(new Error('Not allowed by CORS: ' + origin));
  },
  credentials: true,
  methods: ['GET','HEAD','PUT','PATCH','POST','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','X-Service-Key','x-service-key']
}));

// enable preflight for all routes
app.options('*', cors());

// body parser (tweak limits if needed)
app.use(bodyParser.json({ limit: '5mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '5mb' }));

// simple request logger for debugging (optional — remove in production)
// app.use((req, res, next) => {
//   console.log(`${req.method} ${req.originalUrl}`);
//   next();
// });

app.get('/health', (req, res) => res.json({ ok: true, env: process.env.NODE_ENV || 'dev' }));

// mount routers
app.use('/api/chat', chatRouter);
app.use('/api/admin', adminRouter);

// simple error handler to ensure CORS headers are included even on errors
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err && (err.stack || err.message || err));
  if (err && err.message && err.message.startsWith('Not allowed by CORS')) {
    return res.status(403).json({ error: 'CORS error', message: err.message });
  }
  res.status(err?.status || 500).json({ error: 'server_error', message: err?.message || 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Tutor-backend listening on port ${PORT}`);
});
