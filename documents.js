import express from "express";
import multer from "multer";
import pdfParse from "pdf-parse";
import { supabase } from "../supabase.js";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

const BUCKET = "documents";
const TABLE  = "documents";

/** POST /documents/upload  (multipart: file + optional title) */
router.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "file is required" });

    const title = req.body?.title || req.file.originalname;
    const ext = (req.file.originalname.split(".").pop() || "pdf").toLowerCase();

    const now = new Date();
    const y = now.getUTCFullYear();
    const m = String(now.getUTCMonth() + 1).padStart(2, "0");
    const rand = Math.random().toString(36).slice(2, 10);
    const storage_path = `${y}/${m}/${rand}.${ext}`;

    const { error: upErr } = await supabase
      .storage.from(BUCKET)
      .upload(storage_path, req.file.buffer, {
        contentType: req.file.mimetype || "application/pdf",
        upsert: false
      });
    if (upErr) return res.status(500).json({ error: upErr.message });

    const { data, error: insErr } = await supabase
      .from(TABLE)
      .insert({ title, storage_path, size: req.file.size, status: "uploaded" })
      .select()
      .single();
    if (insErr) return res.status(500).json({ error: insErr.message });

    res.json({ ok: true, document: data });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/** GET /documents  */
router.get("/", async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from(TABLE).select("*")
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ items: data || [] });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/** POST /documents/rebuild/:id  */
router.post("/rebuild/:id", async (req, res) => {
  try {
    const id = req.params.id;

    const { data: doc, error: e1 } = await supabase
      .from(TABLE).select("*").eq("id", id).single();
    if (e1) return res.status(404).json({ error: "document not found" });

    const path = doc.storage_path || doc.file_path; // fallback kalau kamu masih pakai file_path
    if (!path) return res.status(400).json({ error: "no storage_path" });

    const { data: file, error: e2 } = await supabase
      .storage.from(BUCKET).download(path);
    if (e2) return res.status(500).json({ error: e2.message });

    const buf = Buffer.from(await file.arrayBuffer());
    const parsed = await pdfParse(buf);
    const text = parsed.text || "";

    // simple chunking
    const chunks = [];
    const CHUNK = 800;
    for (let i = 0; i < text.length; i += CHUNK) chunks.push(text.slice(i, i + CHUNK));

    // kosongkan chunks lama untuk dokumen ini (opsional)
    await supabase.from("chunks").delete().eq("document_id", id);

    if (chunks.length) {
      const rows = chunks.map((t, idx) => ({
        document_id: id, chunk_index: idx, content: t
      }));
      const { error: e3 } = await supabase.from("chunks").insert(rows);
      if (e3) return res.status(500).json({ error: e3.message });
    }

    await supabase.from(TABLE)
      .update({ status: "indexed", pages: parsed.numpages || null })
      .eq("id", id);

    res.json({ ok: true, pages: parsed.numpages || 0, chunks: chunks.length });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

export default router;
