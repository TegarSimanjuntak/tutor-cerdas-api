

---

# 🧠 Tutor-Cerdas-API

> **Backend API Gateway & Orchestrator untuk Sistem QA Manajemen Proyek**

Repositori ini berisi kode sumber untuk **Backend Service**, yang bertindak sebagai orkestrator utama dalam arsitektur sistem *Retrieval-Augmented Generation* (RAG). Layanan ini menghubungkan antarmuka pengguna (*Front-end*) dengan *Indexer Service* dan model bahasa besar (LLM) untuk menghasilkan jawaban yang terverifikasi.

---

## ✨ Fitur Utama

* 
**🔗 System Orchestration**: Mengelola komunikasi antara *Front-end* (React), *Indexer* (Python/FastAPI), dan *Vector Database* (Supabase).


* 
**🤖 LLM Integration**: Terintegrasi dengan **DeepSeek API** untuk proses generasi jawaban (*generation stage*).


* 
**🛡️ Session & Chat Management**: Mengelola penyimpanan sesi percakapan, riwayat pesan, dan metadata pengguna ke dalam Supabase.


* 
**📝 Contextual Prompt Engineering**: Menyusun *prompt* terstruktur yang menggabungkan pertanyaan pengguna dengan konteks hasil *retrieval* untuk menekan halusinasi.


* 
**🔐 Authentication Handler**: Mengintegrasikan layanan *Supabase Auth* untuk validasi peran pengguna (*Admin* vs *User*).



---

## 🛠️ Teknologi yang Digunakan

* 
**Runtime**: Node.js.


* 
**Framework**: Express.js.


* 
**Database & Auth**: Supabase (PostgreSQL).


* 
**LLM Provider**: DeepSeek API (melalui integrasi Google AI SDK).


* 
**Architecture**: *Decoupled Microservices*.



---

## ⚙️ Instalasi dan Konfigurasi

### 1. Clone Repositori

```bash
git clone https://github.com/TegarSimanjuntak/tutor-cerdas-api.git
cd tutor-cerdas-api

```

### 2. Install Dependensi

```bash
npm install

```

### 3. Konfigurasi Environment Variables (`.env`)

Buat file `.env` dan lengkapi kredensial berikut:

```env
# Server Configuration
PORT=3000

# Supabase Credentials
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key

# LLM Configuration
DEEPSEEK_API_KEY=your_deepseek_api_key
DEEPSEEK_MODEL=models/DeepSeek-2.0-flash-lite

# Service URL
INDEXER_URL=http://localhost:8000

```

### 4. Menjalankan Server

```bash
# Mode Development
npm run dev

# Mode Production
npm start

```

---

## 🧬 Alur Kerja Backend (Orchestration)

1. 
**Receive Request**: Menerima pertanyaan dari *Front-end*.


2. 
**Context Retrieval**: Memanggil *Indexer Service* (`/search`) untuk mendapatkan potongan dokumen (chunks) yang relevan berdasarkan kesamaan vektor.


3. 
**Prompt Construction**: Menggabungkan instruksi sistem, konteks dokumen, dan pertanyaan pengguna ke dalam format yang dipahami LLM.


4. 
**Answer Generation**: Mengirim *prompt* ke DeepSeek API untuk mendapatkan jawaban akhir.


5. 
**Data Persistence**: Menyimpan pesan dan metadata hasil *retrieval* ke tabel `messages` di Supabase untuk riwayat percakapan.



---

## 👤 Author

**Tegar Posma Diaz Simanjuntak**

* 
**NPM**: 140810220085.


* 
**Program Studi**: Teknik Informatika, Universitas Padjadjaran.



*Repositori ini dikembangkan sebagai bagian dari tugas akhir (Skripsi) tahun 2026*.

---

**Tautan Terkait:**

* 
[Front-end Web Interface](https://github.com/TegarSimanjuntak/trial-web.git).


* 
[Indexer RAG Service](https://github.com/TegarSimanjuntak/indexer.git).



---
