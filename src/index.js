// src/index.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = Number(process.env.PORT || 8787);
const NODE_ENV = process.env.NODE_ENV || 'development';

/**
 * Allowed origins:
 * - set env WEB_ORIGIN to a comma separated list, e.g.
 *   WEB_ORIGIN=http://localhost:5173,http://localhost:3000
 * - if not set and NODE_ENV === 'development', allow http://localhost:5173 by default
 */
const allowedOrigins = (process.env.WEB_ORIGIN || (NODE_ENV === 'development' ? 'http://localhost:5173' : ''))
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// Security & performance middlewares
app.use(helmet({ contentSecurityPolicy: false })); // disable CSP in dev; enable/configure for prod
app.use(compression());
app.use(morgan('dev'));

// CORS options (apply before routes)
const corsOptions = {
  origin: function (origin, callback) {
    // allow non-browser tools (curl/Postman) in dev when origin is undefined
    if (!origin) return callback(null, true);
    if (allowedOrigins.length === 0) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS'), false);
  },
  credentials: true,
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'X-Requested-With']
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // enable preflight for all routes

// Body parsers (JSON + urlencoded)
// Keep after CORS so preflight works fine
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Rate limiting for /api/*
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api', apiLimiter);

// Small request debug logger (keeps previous behaviour)
app.use((req, res, next) => {
  console.log(`REQ: ${new Date().toISOString()} ${req.method} ${req.originalUrl} Origin=${req.headers.origin || ''}`);
  next();
});

/* ---------- Health & info endpoints ---------- */
app.get('/health', (req, res) => res.json({ ok: true, env: NODE_ENV, now: new Date().toISOString() }));
app.get('/api/admin/ping', (req, res) => res.json({ ok: true, now: new Date().toISOString() }));

/* ---------- Static uploads (useful for dev) ---------- */
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
// serve files at /uploads/<filename>
app.use('/uploads', express.static(uploadsDir));

/* ---------- Mount routers (with safe fallbacks) ---------- */
function tryMount(routePath, mountPath) {
  try {
    const r = require(routePath);
    app.use(mountPath, r);
    console.log(`Mounted ${routePath} -> ${mountPath}`);
    return true;
  } catch (e) {
    console.warn(`Could not load ${routePath} — continuing without it.`, e && (e.stack || e.message));
    return false;
  }
}

// Try to mount the real admin router (if present)
const adminMounted = tryMount('./routes/admin', '/api/admin');

// If admin router not present, provide a helpful dev fallback (multipart-capable)
if (!adminMounted && NODE_ENV === 'development') {
  const multer = require('multer');
  const devAdmin = express.Router();

  // basic in-memory/sample store for dev
  const sampleDocs = [
    { id: 1, title: 'Sample Doc A', uploadedBy: 'admin', created_at: new Date().toISOString() },
    { id: 2, title: 'Sample Doc B', uploadedBy: 'user', created_at: new Date().toISOString() },
  ];

  devAdmin.get('/documents', (req, res) => res.json({ status: 'ok', data: sampleDocs }));
  devAdmin.get('/documents/:id', (req, res) => {
    const id = Number(req.params.id);
    const doc = sampleDocs.find(d => d.id === id);
    if (!doc) return res.status(404).json({ status: 'error', message: 'Not found' });
    return res.json({ status: 'ok', data: doc });
  });

  // Multer storage writing to uploadsDir
  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/\s+/g, '_')}`)
  });
  const upload = multer({
    storage,
    limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB for dev
    fileFilter: (req, file, cb) => {
      // accept PDF or any type if you prefer
      if (file.mimetype === 'application/pdf' || true) return cb(null, true);
      return cb(new Error('Only PDF allowed'));
    }
  });

  // endpoint: POST /api/admin/documents (match frontend expectation)
  devAdmin.post('/documents', upload.single('file'), (req, res) => {
    // if frontend expects /documents (without /upload), this handles it
    const file = req.file;
    const body = req.body || {};
    const newDoc = {
      id: sampleDocs.length ? Math.max(...sampleDocs.map(d=>d.id)) + 1 : 1,
      title: body.title || (file && file.originalname) || 'untitled',
      uploadedBy: body.uploadedBy || 'admin',
      created_at: new Date().toISOString(),
      filename: file ? file.filename : null,
      path: file ? `/uploads/${file.filename}` : null
    };
    sampleDocs.push(newDoc);
    return res.status(201).json({ status: 'ok', data: newDoc });
  });

  // also keep a fallback upload route named /documents/upload for older code
  devAdmin.post('/documents/upload', upload.single('file'), (req, res) => {
    const file = req.file;
    return res.json({ status: 'ok', message: 'received (dev fallback)', filename: file ? file.filename : null });
  });

  app.use('/api/admin', devAdmin);
  console.log('Mounted development fallback admin routes at /api/admin (development only).');
}

// Try to mount chat router (similar pattern)
const chatMounted = tryMount('./routes/chat', '/api/chat');
if (!chatMounted) {
  const fallbackChat = express.Router();
  fallbackChat.all('*', (req, res) => res.status(500).json({ error: 'chat router failed to load', message: 'See server logs' }));
  app.use('/api/chat', fallbackChat);
}

/* ---------- Centralized error handler ---------- */
app.use((err, req, res, next) => {
  // Multer-specific errors often come as err.code
  if (err) {
    console.error('Unhandled error:', err && (err.stack || err.message || err));
  }

  // CORS errors handled explicitly
  if (err && err.message && err.message.includes('CORS')) {
    return res.status(403).json({ status: 'error', message: err.message });
  }

  // Multer / file upload errors
  if (err && (err.code === 'LIMIT_FILE_SIZE' || err.code === 'LIMIT_UNEXPECTED_FILE')) {
    return res.status(400).json({ status: 'error', message: err.message || 'File upload error', code: err.code });
  }

  // Default handling
  const status = err && err.status ? err.status : 500;
  if (NODE_ENV === 'production') {
    return res.status(status).json({ status: 'error', message: 'Internal server error' });
  }

  // dev: expose error details
  return res.status(status).json({
    status: 'error',
    message: err && (err.message || 'Internal server error'),
    stack: err && err.stack
  });
});

/* ---------- Start server ---------- */
app.listen(PORT, () => {
  console.log(`Tutor-backend listening on port ${PORT} (env=${NODE_ENV})`);
  if (allowedOrigins.length) console.log('Allowed origins:', allowedOrigins);
});
