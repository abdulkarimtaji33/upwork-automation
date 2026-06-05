'use strict';

const REMOTE_DB_URL = (process.env.REMOTE_DB_URL || '').replace(/\/$/, '');
const REMOTE_DB_API_KEY = process.env.REMOTE_DB_API_KEY || '';

if (!REMOTE_DB_URL) {
  throw new Error('REMOTE_DB_URL is required for db-remote');
}

function headers(json = true) {
  const h = {};
  if (json) h['Content-Type'] = 'application/json';
  if (REMOTE_DB_API_KEY) h['X-API-Key'] = REMOTE_DB_API_KEY;
  return h;
}

async function request(method, path, body) {
  const opts = { method, headers: headers(!!body) };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(`${REMOTE_DB_URL}${path}`, opts);
  const text = await r.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text }; }
  if (!r.ok) throw new Error(data.error || `Remote DB ${r.status}: ${text.slice(0, 200)}`);
  return data;
}

async function upsertJob(job, analysis, emailSent = false) {
  const data = await request('POST', '/api/jobs', { job, analysis, emailSent });
  return data.job;
}

async function markProposalSent() {
  throw new Error('Proposal tracking runs on the live server only');
}

async function updateNotes() {
  throw new Error('Notes are edited on the live server only');
}

async function getJobs(opts = {}) {
  const q = opts.onlyProposalSent ? '?sent=true' : '';
  return request('GET', `/api/jobs${q}`);
}

async function getJob(jobUid) {
  return request('GET', `/api/jobs/${encodeURIComponent(jobUid)}`);
}

async function getStats() {
  return request('GET', '/api/stats');
}

module.exports = {
  upsertJob,
  markProposalSent,
  updateNotes,
  getJobs,
  getJob,
  getStats,
  isRemote: true,
  remoteUrl: REMOTE_DB_URL,
};
