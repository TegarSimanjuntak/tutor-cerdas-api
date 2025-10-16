// src/routes/adminDocuments.js
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const router = express.Router();

// Simple storage to ./uploads with original name (add timestamp to avoid collision)
const uploadDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    // safe filename: timestamp-original
    const safeName = `${Date.now()}-${file.originalname.replace(/\s+/g, '_')}`;
    cb(null, safeName);
  }
});

// File filter: only accept PDF
function fileFilter (req, file, cb) {
  if (file.mimetype === 'application/pdf') {
    cb(null, true);
  } else {
    cb(new Error('Only PDF files are allowed'), false);
  }
}

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 } // 10 MB limit
});

// Dummy data store
let docs = [
  { id: 1, title: 'Doc A', uploadedBy: 'admin', created_at: new Date().toISOString(), filename: null },
  { id: 2, title: 'Doc B', uploadedBy: 'user', created_at: new Date().toISOString(), filename: null }
];

// GET list
router.get('/documents', (req, res) => {
  res.json({ status: 'ok', data: docs });
});

// GET detail
router.get('/documents/:id', (req, res) => {
  const id = Number(req.params.id);
  const doc = docs.find(d => d.id === id);
  if (!doc) return res.status(404).json({ status: 'error', message: 'Not found' });
  res.json({ status: 'ok', data: doc });
});

// POST upload PDF -> /api/admin/documents
router.post('/documents', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ status: 'error', message: 'No file uploaded' });

    const newDoc = {
      id: docs.length ? Math.max(...docs.map(d => d.id)) + 1 : 1,
      title: req.body.title || req.file.originalname,
      uploadedBy: req.body.uploadedBy || 'admin',
      created_at: new Date().toISOString(),
      filename: req.file.filename,
      path: `/uploads/${req.file.filename}`
    };
    docs.push(newDoc);

    // respond with created document
    res.status(201).json({ status: 'ok', data: newDoc });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ status: 'error', message: 'Upload failed', detail: err.message });
  }
});

module.exports = router;
