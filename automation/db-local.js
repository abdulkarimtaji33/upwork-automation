'use strict';

const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, '..', 'data', 'jobs_db.json');

function load() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { return {}; }
}

function persist(db) {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function upsertJob(job, analysis, emailSent = false) {
  const db = load();
  const old = db[job.jobUid] || {};
  db[job.jobUid] = {
    jobUid: job.jobUid,
    title: job.title,
    link: job.link,
    postedAt: job.postedAt,
    jobType: job.jobType,
    experienceLevel: job.experienceLevel,
    duration: job.duration,
    skills: job.skills,
    proposals: job.proposals,
    clientLocation: job.clientLocation,
    clientRating: job.clientRating,
    paymentVerified: job.paymentVerified,
    totalSpent: job.totalSpent,
    totalHires: job.totalHires,
    hireRate: job.hireRate,
    memberSince: job.memberSince,
    clientInfo: job.clientInfo,
    fullDescription: job.fullDescription,
    score: analysis.relevanceScore,
    isRelevant: analysis.isRelevant,
    clientTrust: analysis.clientTrust,
    hasPreviousPayments: analysis.hasPreviousPayments,
    reasoning: analysis.reasoning,
    proposalDraft: analysis.proposalDraft,
    milestones: analysis.milestones || [],
    emailSent: emailSent || old.emailSent || false,
    proposalSent: old.proposalSent || false,
    proposalSentAt: old.proposalSentAt || null,
    notes: old.notes || '',
    evidencePath: old.evidencePath || null,
    createdAt: old.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  persist(db);
  return db[job.jobUid];
}

function markProposalSent(jobUid, opts = {}) {
  const db = load();
  if (!db[jobUid]) return null;
  const sent = opts.sent !== false;
  db[jobUid].proposalSent = sent;
  db[jobUid].proposalSentAt = sent ? (db[jobUid].proposalSentAt || new Date().toISOString()) : null;
  if (opts.notes !== null && opts.notes !== undefined) db[jobUid].notes = opts.notes;
  if (opts.evidencePath !== null && opts.evidencePath !== undefined) db[jobUid].evidencePath = opts.evidencePath;
  if (!sent) db[jobUid].evidencePath = null;
  db[jobUid].updatedAt = new Date().toISOString();
  persist(db);
  return db[jobUid];
}

function updateNotes(jobUid, notes) {
  const db = load();
  if (!db[jobUid]) return null;
  db[jobUid].notes = notes;
  db[jobUid].updatedAt = new Date().toISOString();
  persist(db);
  return db[jobUid];
}

function getJobs(opts = {}) {
  const { onlyRelevant = true, onlyProposalSent = false, limit = 300 } = opts;
  let jobs = Object.values(load());
  if (onlyRelevant) jobs = jobs.filter((j) => j.isRelevant);
  if (onlyProposalSent) jobs = jobs.filter((j) => j.proposalSent);
  return jobs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, limit);
}

function getJob(jobUid) {
  return load()[jobUid] || null;
}

function getStats() {
  const jobs = Object.values(load());
  return {
    total: jobs.length,
    relevant: jobs.filter((j) => j.isRelevant).length,
    emailSent: jobs.filter((j) => j.emailSent).length,
    proposalSent: jobs.filter((j) => j.proposalSent).length,
  };
}

module.exports = {
  upsertJob,
  markProposalSent,
  updateNotes,
  getJobs,
  getJob,
  getStats,
  isRemote: false,
};
