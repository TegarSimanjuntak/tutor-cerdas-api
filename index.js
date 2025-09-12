require('dotenv').config()
const express = require('express')
const cors = require('cors')

const app = express()
app.use(cors())
app.use(express.json({limit:'10mb'}))

// Health check
app.get('/health', (req, res) => {
  res.json({ ok: true, env: process.env.NODE_ENV || 'dev' })
})

// Placeholder chat (M4 nanti diganti RAG + Gemini)
app.post('/chat/ask', async (req, res) => {
  const { question, role } = req.body || {}
  // Untuk M1, jawab dummy:
  res.json({
    answer: `Halo (${role || 'user'})! Kamu bertanya: "${question}". Jawaban asli akan muncul setelah RAG+Gemini di M4.`,
    sources: []
  })
})

// Placeholder admin endpoints (akan diisi M3)
app.post('/admin/upload', (req, res) => {
  res.json({ ok: true, note: 'Upload akan diimplementasi di M3.' })
})

app.post('/admin/rebuild', (req, res) => {
  res.json({ ok: true, note: 'Rebuild akan diimplementasi di M3.' })
})

const PORT = process.env.PORT || 8787
app.listen(PORT, () => {
  console.log('API running on http://localhost:' + PORT)
})
