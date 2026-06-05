'use strict';

require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const db = require('./db');

const PORT = Number(process.env.LIVE_PORT || 3340);
const API_KEY = process.env.LIVE_API_KEY || '';
const EVIDENCE_DIR = process.env.LIVE_EVIDENCE_DIR || path.join(__dirname, 'data', 'evidence');

fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: EVIDENCE_DIR,
    filename: (req, _file, cb) => {
      const ext = path.extname(_file.originalname) || '.png';
      cb(null, `${req.params.jobUid}_${Date.now()}${ext}`);
    },
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /image\/(png|jpeg|webp|gif)|application\/pdf/.test(file.mimetype);
    cb(null, ok);
  },
});

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use('/evidence', express.static(EVIDENCE_DIR));
app.use(express.static(path.join(__dirname, 'public')));

function requireApiKey(req, res, next) {
  if (!API_KEY) return next();
  const key = req.headers['x-api-key'] || req.query.key;
  if (key !== API_KEY) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  next();
}

// ─── Read (browser UI — no API key) ──────────────────────────────────────────
app.get('/api/jobs', (req, res) => {
  const onlyProposalSent = req.query.sent === 'true';
  res.json(db.getJobs({ onlyRelevant: true, onlyProposalSent }));
});

app.get('/api/jobs/:jobUid', (req, res) => {
  const job = db.getJob(req.params.jobUid);
  if (!job) return res.status(404).json({ ok: false, error: 'Job not found' });
  res.json(job);
});

app.get('/api/stats', (_req, res) => {
  res.json(db.getStats());
});

// ─── Write from local automation (requires API key when set) ─────────────────
app.post('/api/jobs', requireApiKey, (req, res) => {
  const { job, analysis, emailSent } = req.body;
  if (!job?.jobUid || !analysis) {
    return res.status(400).json({ ok: false, error: 'job and analysis required' });
  }
  try {
    const saved = db.upsertJob(job, analysis, !!emailSent);
    res.json({ ok: true, job: saved });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Proposal tracking (UI — no API key so team can mark sent in browser) ───
app.post('/api/jobs/:jobUid/proposal-sent', upload.single('evidence'), (req, res) => {
  const sent = req.body.sent !== 'false' && req.body.sent !== false;
  const notes = req.body.notes || null;
  const evidencePath = req.file ? `/evidence/${req.file.filename}` : null;

  if (!sent) {
    const existing = db.getJob(req.params.jobUid);
    if (existing?.evidencePath) {
      const fullPath = path.join(EVIDENCE_DIR, path.basename(existing.evidencePath));
      try { fs.unlinkSync(fullPath); } catch { /* ignore */ }
    }
  }

  const job = db.markProposalSent(req.params.jobUid, { sent, notes, evidencePath });
  if (!job) return res.status(404).json({ ok: false, error: 'Job not found' });
  res.json({ ok: true, job });
});

app.post('/api/jobs/:jobUid/notes', (req, res) => {
  const job = db.updateNotes(req.params.jobUid, req.body.notes || '');
  if (!job) return res.status(404).json({ ok: false, error: 'Job not found' });
  res.json({ ok: true, job });
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'upwork-live', stats: db.getStats() });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log(`  Live DB UI  →  http://0.0.0.0:${PORT}`);
  console.log(`  Database    →  ${process.env.LIVE_DB_PATH || path.join(__dirname, 'data', 'jobs.db')}`);
  if (API_KEY) console.log('  API key     →  set (local sync must send X-API-Key)');
  else console.log('  API key     →  not set (add LIVE_API_KEY in production)');
  console.log('');
});
