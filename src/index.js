// src/index.js (FALLBACK MINIMAL — temporary)
require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 8080;

// permissive CORS for now (dev / fallback)
app.use(cors({
  origin: true,
  credentials: true,
}));
app.options('*', cors());

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// small request logger to capture hits in Railway logs
app.use((req, res, next) => {
  console.log(`REQ: ${new Date().toISOString()} ${req.method} ${req.originalUrl} Origin=${req.headers.origin || ''}`);
  next();
});

// basic health & ping endpoints
app.get('/health', (req, res) => res.json({ ok: true, env: process.env.NODE_ENV || 'dev' }));
app.get('/api/admin/ping', (req, res) => res.json({ ok: true, now: new Date().toISOString() }));

// Try to mount admin router but don't crash if it fails
try {
  const adminRouter = require('./routes/admin');
  app.use('/api/admin', adminRouter);
} catch (e) {
  console.error('Could not load routes/admin.js — continuing without it', e && (e.stack || e.message));
  const r = express.Router();
  r.all('*', (req, res) => res.status(500).json({ error: 'admin router failed to load', message: e?.message || 'see logs' }));
  app.use('/api/admin', r);
}

// Try to mount chat router but don't crash if it fails
try {
  const chatRouter = require('./routes/chat');
  app.use('/api/chat', chatRouter);
} catch (e) {
  console.error('Could not load routes/chat.js — continuing without it', e && (e.stack || e.message));
  const r = express.Router();
  r.all('*', (req, res) => res.status(500).json({ error: 'chat router failed to load', message: e?.message || 'see logs' }));
  app.use('/api/chat', r);
}

// Final error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error', err && (err.stack || err.message));
  res.status(err?.status || 500).json({ error: 'server_error', message: err?.message || 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Fallback Tutor-backend listening on port ${PORT}`);
});
