// src/index.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');

const chatRouter = require('./routes/chat');
const adminRouter = require('./routes/admin');

const app = express();
const PORT = process.env.PORT || 8080;

const allowedOrigins = (process.env.FRONTEND_ORIGIN || '').split(',').map(s=>s.trim()).filter(Boolean);
app.use(cors({
  origin: allowedOrigins.length ? allowedOrigins : '*'
}));
app.use(bodyParser.json({ limit: '1mb' }));
app.use(bodyParser.urlencoded({ extended: true }));

app.get('/health', (req,res) => res.json({ ok: true, env: process.env.NODE_ENV || 'dev' }));

app.use('/api/chat', chatRouter);
app.use('/api/admin', adminRouter);

app.listen(PORT, () => {
  console.log(`Tutor-backend listening on port ${PORT}`);
});
