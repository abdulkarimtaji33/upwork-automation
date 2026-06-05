'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.LIVE_DB_PATH || path.join(__dirname, 'data', 'jobs.db');

let db;

function getDb() {
  if (!db) {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        job_uid TEXT PRIMARY KEY,
        title TEXT,
        link TEXT,
        posted_at TEXT,
        job_type TEXT,
        experience_level TEXT,
        duration TEXT,
        skills TEXT,
        proposals TEXT,
        client_location TEXT,
        client_rating TEXT,
        payment_verified INTEGER DEFAULT 0,
        total_spent TEXT,
        total_hires TEXT,
        hire_rate TEXT,
        member_since TEXT,
        client_info TEXT,
        full_description TEXT,
        score REAL,
        is_relevant INTEGER DEFAULT 0,
        client_trust TEXT,
        has_previous_payments INTEGER DEFAULT 0,
        reasoning TEXT,
        proposal_draft TEXT,
        milestones TEXT,
        email_sent INTEGER DEFAULT 0,
        proposal_sent INTEGER DEFAULT 0,
        proposal_sent_at TEXT,
        notes TEXT DEFAULT '',
        evidence_path TEXT,
        created_at TEXT,
        updated_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_jobs_relevant ON jobs(is_relevant);
      CREATE INDEX IF NOT EXISTS idx_jobs_proposal_sent ON jobs(proposal_sent);
      CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at);
    `);
  }
  return db;
}

function rowToJob(row) {
  if (!row) return null;
  return {
    jobUid: row.job_uid,
    title: row.title,
    link: row.link,
    postedAt: row.posted_at,
    jobType: row.job_type,
    experienceLevel: row.experience_level,
    duration: row.duration,
    skills: row.skills,
    proposals: row.proposals,
    clientLocation: row.client_location,
    clientRating: row.client_rating,
    paymentVerified: !!row.payment_verified,
    totalSpent: row.total_spent,
    totalHires: row.total_hires,
    hireRate: row.hire_rate,
    memberSince: row.member_since,
    clientInfo: row.client_info,
    fullDescription: row.full_description,
    score: row.score,
    isRelevant: !!row.is_relevant,
    clientTrust: row.client_trust,
    hasPreviousPayments: !!row.has_previous_payments,
    reasoning: row.reasoning,
    proposalDraft: row.proposal_draft,
    milestones: row.milestones ? JSON.parse(row.milestones) : [],
    emailSent: !!row.email_sent,
    proposalSent: !!row.proposal_sent,
    proposalSentAt: row.proposal_sent_at,
    notes: row.notes || '',
    evidencePath: row.evidence_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function upsertJob(job, analysis, emailSent = false) {
  const d = getDb();
  const existing = d.prepare('SELECT * FROM jobs WHERE job_uid = ?').get(job.jobUid);
  const now = new Date().toISOString();

  const record = {
    job_uid: job.jobUid,
    title: job.title,
    link: job.link,
    posted_at: job.postedAt,
    job_type: job.jobType,
    experience_level: job.experienceLevel,
    duration: job.duration,
    skills: job.skills,
    proposals: job.proposals,
    client_location: job.clientLocation,
    client_rating: job.clientRating,
    payment_verified: job.paymentVerified ? 1 : 0,
    total_spent: job.totalSpent,
    total_hires: job.totalHires,
    hire_rate: job.hireRate,
    member_since: job.memberSince,
    client_info: job.clientInfo,
    full_description: job.fullDescription,
    score: analysis.relevanceScore,
    is_relevant: analysis.isRelevant ? 1 : 0,
    client_trust: analysis.clientTrust,
    has_previous_payments: analysis.hasPreviousPayments ? 1 : 0,
    reasoning: analysis.reasoning,
    proposal_draft: analysis.proposalDraft,
    milestones: JSON.stringify(analysis.milestones || []),
    email_sent: emailSent || (existing?.email_sent ?? 0),
    proposal_sent: existing?.proposal_sent ?? 0,
    proposal_sent_at: existing?.proposal_sent_at ?? null,
    notes: existing?.notes ?? '',
    evidence_path: existing?.evidence_path ?? null,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };

  d.prepare(`
    INSERT INTO jobs (
      job_uid, title, link, posted_at, job_type, experience_level, duration, skills,
      proposals, client_location, client_rating, payment_verified, total_spent,
      total_hires, hire_rate, member_since, client_info, full_description,
      score, is_relevant, client_trust, has_previous_payments, reasoning,
      proposal_draft, milestones, email_sent, proposal_sent, proposal_sent_at,
      notes, evidence_path, created_at, updated_at
    ) VALUES (
      @job_uid, @title, @link, @posted_at, @job_type, @experience_level, @duration, @skills,
      @proposals, @client_location, @client_rating, @payment_verified, @total_spent,
      @total_hires, @hire_rate, @member_since, @client_info, @full_description,
      @score, @is_relevant, @client_trust, @has_previous_payments, @reasoning,
      @proposal_draft, @milestones, @email_sent, @proposal_sent, @proposal_sent_at,
      @notes, @evidence_path, @created_at, @updated_at
    )
    ON CONFLICT(job_uid) DO UPDATE SET
      title = excluded.title,
      link = excluded.link,
      posted_at = excluded.posted_at,
      job_type = excluded.job_type,
      experience_level = excluded.experience_level,
      duration = excluded.duration,
      skills = excluded.skills,
      proposals = excluded.proposals,
      client_location = excluded.client_location,
      client_rating = excluded.client_rating,
      payment_verified = excluded.payment_verified,
      total_spent = excluded.total_spent,
      total_hires = excluded.total_hires,
      hire_rate = excluded.hire_rate,
      member_since = excluded.member_since,
      client_info = excluded.client_info,
      full_description = excluded.full_description,
      score = excluded.score,
      is_relevant = excluded.is_relevant,
      client_trust = excluded.client_trust,
      has_previous_payments = excluded.has_previous_payments,
      reasoning = excluded.reasoning,
      proposal_draft = excluded.proposal_draft,
      milestones = excluded.milestones,
      email_sent = CASE WHEN excluded.email_sent = 1 THEN 1 ELSE jobs.email_sent END,
      updated_at = excluded.updated_at
  `).run(record);

  return rowToJob(d.prepare('SELECT * FROM jobs WHERE job_uid = ?').get(job.jobUid));
}

function markProposalSent(jobUid, { sent = true, notes = null, evidencePath = null } = {}) {
  const d = getDb();
  const existing = d.prepare('SELECT * FROM jobs WHERE job_uid = ?').get(jobUid);
  if (!existing) return null;

  const proposalSent = sent ? 1 : 0;
  const proposalSentAt = sent ? (existing.proposal_sent_at || new Date().toISOString()) : null;
  const evidence = sent ? evidencePath : null;
  const notesVal = notes !== null ? notes : existing.notes;

  d.prepare(`
    UPDATE jobs SET
      proposal_sent = ?,
      proposal_sent_at = ?,
      notes = ?,
      evidence_path = ?,
      updated_at = ?
    WHERE job_uid = ?
  `).run(proposalSent, proposalSentAt, notesVal, evidence, new Date().toISOString(), jobUid);

  return rowToJob(d.prepare('SELECT * FROM jobs WHERE job_uid = ?').get(jobUid));
}

function updateNotes(jobUid, notes) {
  const d = getDb();
  const existing = d.prepare('SELECT job_uid FROM jobs WHERE job_uid = ?').get(jobUid);
  if (!existing) return null;
  d.prepare('UPDATE jobs SET notes = ?, updated_at = ? WHERE job_uid = ?')
    .run(notes, new Date().toISOString(), jobUid);
  return rowToJob(d.prepare('SELECT * FROM jobs WHERE job_uid = ?').get(jobUid));
}

function getJobs({ onlyRelevant = true, onlyProposalSent = false, limit = 300 } = {}) {
  const d = getDb();
  let sql = 'SELECT * FROM jobs WHERE 1=1';
  const params = {};
  if (onlyRelevant) sql += ' AND is_relevant = 1';
  if (onlyProposalSent) sql += ' AND proposal_sent = 1';
  sql += ' ORDER BY created_at DESC LIMIT @limit';
  params.limit = limit;
  return d.prepare(sql).all(params).map(rowToJob);
}

function getJob(jobUid) {
  return rowToJob(getDb().prepare('SELECT * FROM jobs WHERE job_uid = ?').get(jobUid));
}

function getStats() {
  const d = getDb();
  const row = d.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN is_relevant = 1 THEN 1 ELSE 0 END) AS relevant,
      SUM(CASE WHEN email_sent = 1 THEN 1 ELSE 0 END) AS email_sent,
      SUM(CASE WHEN proposal_sent = 1 THEN 1 ELSE 0 END) AS proposal_sent
    FROM jobs
  `).get();
  return {
    total: row.total || 0,
    relevant: row.relevant || 0,
    emailSent: row.email_sent || 0,
    proposalSent: row.proposal_sent || 0,
  };
}

module.exports = { upsertJob, markProposalSent, updateNotes, getJobs, getJob, getStats };
