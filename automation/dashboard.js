'use strict';

const express  = require('express');
const cron     = require('node-cron');
const path     = require('path');
const fs       = require('fs');
const multer   = require('multer');
const { emitter, runCycle, stopCycle, loadSettings, saveSettings, EMAIL_TO, isRunning } = require('./core');
const db = require('./db');

const EVIDENCE_DIR = path.join(__dirname, '..', 'data', 'evidence');
fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: EVIDENCE_DIR,
    filename: (req, _file, cb) => {
      const ext = path.extname(_file.originalname) || '.png';
      cb(null, `${req.params.jobUid}_${Date.now()}${ext}`);
    },
  }),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB
  fileFilter: (_req, file, cb) => {
    const ok = /image\/(png|jpeg|webp|gif)|application\/pdf/.test(file.mimetype);
    cb(null, ok);
  },
});

const app  = express();
const PORT = process.env.DASHBOARD_PORT || 4000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/evidence', express.static(EVIDENCE_DIR));

// ─── In-memory store ──────────────────────────────────────────────────────────
const store = {
  stats: { cycles: 0, totalJobs: 0, relevant: 0, emailsSent: 0 },
  relevantJobs: [],   // newest first, max 100
  log: [],            // newest first, max 300
  lastRun: null,
  nextRun: null,
};

function addLog(entry) {
  store.log.unshift(entry);
  if (store.log.length > 300) store.log.length = 300;
}

// ─── Wire emitter → store + SSE ───────────────────────────────────────────────
const sseClients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch { sseClients.delete(res); }
  }
}

emitter.on('log', (entry) => {
  addLog(entry);
  broadcast('log', entry);
});

emitter.on('cycle:start', (d) => {
  store.lastRun = d.time;
  broadcast('cycle:start', d);
});

emitter.on('cycle:done', (d) => {
  store.stats.cycles++;
  store.stats.emailsSent += d.emailsSent || 0;
  broadcast('cycle:done', { ...d, stats: store.stats });
});

emitter.on('jobs:found', (d) => {
  store.stats.totalJobs += d.count;
  broadcast('jobs:found', { ...d, stats: store.stats });
});

emitter.on('job:analyzed', (d) => {
  if (d.isRelevant) {
    store.stats.relevant++;
    const card = {
      jobUid:          d.jobUid,
      title:           d.title,
      link:            d.link,
      postedAt:        d.postedAt,
      jobType:         d.jobType,
      experienceLevel: d.experienceLevel,
      skills:          d.skills,
      proposals:       d.proposals,
      clientLocation:  d.clientLocation,
      clientRating:    d.clientRating,
      paymentVerified: d.paymentVerified,
      totalSpent:      d.totalSpent,
      totalHires:      d.totalHires,
      hireRate:        d.hireRate,
      memberSince:     d.memberSince,
      score:           d.analysis.relevanceScore,
      clientTrust:     d.analysis.clientTrust,
      reasoning:       d.analysis.reasoning,
      proposalDraft:   d.analysis.proposalDraft,
      time:            new Date().toISOString(),
    };
    store.relevantJobs.unshift(card);
    if (store.relevantJobs.length > 100) store.relevantJobs.length = 100;
    broadcast('job:relevant', { card, stats: store.stats });
  }
  broadcast('job:analyzed', { jobUid: d.jobUid, isRelevant: d.isRelevant, score: d.analysis.relevanceScore, stats: store.stats });
});

emitter.on('job:email', (d) => broadcast('job:email', d));
emitter.on('job:processing', (d) => broadcast('job:processing', d));

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get('/api/state', (_req, res) => {
  res.json({ stats: store.stats, relevantJobs: store.relevantJobs, log: store.log.slice(0, 100),
    lastRun: store.lastRun, isRunning: isRunning(), emailTo: EMAIL_TO, settings: loadSettings(),
    dbStats: db.getStats() });
});

app.post('/api/run', async (_req, res) => {
  if (isRunning()) return res.json({ ok: false, message: 'Already running' });
  res.json({ ok: true, message: 'Cycle started' });
  runCycle();
});

app.post('/api/stop', (_req, res) => {
  if (!isRunning()) return res.json({ ok: false, message: 'Not running' });
  stopCycle();
  res.json({ ok: true, message: 'Stop requested' });
});

// ── DB endpoints ──────────────────────────────────────────────────────────────
app.get('/api/jobs', (req, res) => {
  const onlyProposalSent = req.query.sent === 'true';
  res.json(db.getJobs({ onlyRelevant: true, onlyProposalSent }));
});

app.post('/api/jobs/:jobUid/proposal-sent', upload.single('evidence'), (req, res) => {
  const sent         = req.body.sent !== 'false' && req.body.sent !== false;
  const notes        = req.body.notes || null;
  const evidencePath = req.file ? `/evidence/${req.file.filename}` : null;

  // Delete old evidence file if unsending
  if (!sent) {
    const existing = db.getJob(req.params.jobUid);
    if (existing?.evidencePath) {
      const fullPath = path.join(EVIDENCE_DIR, path.basename(existing.evidencePath));
      try { fs.unlinkSync(fullPath); } catch {}
    }
  }

  const job = db.markProposalSent(req.params.jobUid, { sent, notes, evidencePath });
  if (!job) return res.status(404).json({ ok: false, error: 'Job not found' });
  broadcast('job:proposal-sent', { jobUid: job.jobUid, proposalSent: job.proposalSent, proposalSentAt: job.proposalSentAt, evidencePath: job.evidencePath, notes: job.notes });
  res.json({ ok: true, job });
});

app.post('/api/jobs/:jobUid/notes', (req, res) => {
  const job = db.updateNotes(req.params.jobUid, req.body.notes || '');
  if (!job) return res.status(404).json({ ok: false, error: 'Job not found' });
  res.json({ ok: true, job });
});

app.get('/api/settings', (_req, res) => {
  res.json(loadSettings());
});

app.post('/api/settings', (req, res) => {
  try {
    const updated = saveSettings(req.body);
    // Restart cron if schedule changed
    if (req.body.cronSchedule && req.body.cronSchedule !== currentSchedule) {
      restartCron(req.body.cronSchedule);
    }
    broadcast('settings:updated', updated);
    res.json({ ok: true, settings: updated });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Send current state on connect
  res.write(`event: init\ndata: ${JSON.stringify({ stats: store.stats, isRunning: isRunning(), lastRun: store.lastRun })}\n\n`);

  const heartbeat = setInterval(() => { try { res.write(': ping\n\n'); } catch { cleanup(); } }, 20000);
  sseClients.add(res);

  function cleanup() { clearInterval(heartbeat); sseClients.delete(res); }
  req.on('close', cleanup);
});

// ─── Schedule & start ─────────────────────────────────────────────────────────
let currentSchedule = loadSettings().cronSchedule || '*/5 * * * *';
let cronTask = null;

function restartCron(schedule) {
  if (cronTask) { cronTask.stop(); cronTask = null; }
  if (!cron.validate(schedule)) { console.error(`[cron] Invalid schedule: ${schedule}`); return; }
  currentSchedule = schedule;
  cronTask = cron.schedule(schedule, () => runCycle());
  console.log(`[cron] Schedule updated: ${schedule}`);
  broadcast('log', { type: 'info', message: `Schedule updated: ${schedule}`, time: new Date().toISOString() });
}

app.listen(PORT, () => {
  console.log('');
  console.log(`  Dashboard → http://localhost:${PORT}`);
  console.log(`  Schedule  : ${currentSchedule}`);
  console.log(`  Email to  : ${EMAIL_TO}`);
  console.log('');
  restartCron(currentSchedule);
  runCycle();
});
