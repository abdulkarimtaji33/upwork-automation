'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');

const REMOTE_DB_URL = (process.env.REMOTE_DB_URL || '').replace(/\/$/, '');
const REMOTE_DB_API_KEY = process.env.REMOTE_DB_API_KEY || '';
const DB_FILE = path.join(__dirname, '..', '..', 'data', 'jobs_db.json');

if (!REMOTE_DB_URL) {
  console.error('Set REMOTE_DB_URL in automation/.env');
  process.exit(1);
}

async function main() {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (err) {
    console.error('No jobs_db.json:', err.message);
    process.exit(1);
  }

  const jobs = Object.values(data).filter((j) => j.isRelevant);
  console.log(`Migrating ${jobs.length} relevant jobs to ${REMOTE_DB_URL}`);

  let ok = 0;
  for (const row of jobs) {
    const job = {
      jobUid: row.jobUid,
      title: row.title,
      link: row.link,
      postedAt: row.postedAt,
      jobType: row.jobType,
      experienceLevel: row.experienceLevel,
      duration: row.duration,
      skills: row.skills,
      proposals: row.proposals,
      clientLocation: row.clientLocation,
      clientRating: row.clientRating,
      paymentVerified: row.paymentVerified,
      totalSpent: row.totalSpent,
      totalHires: row.totalHires,
      hireRate: row.hireRate,
      memberSince: row.memberSince,
      clientInfo: row.clientInfo,
      fullDescription: row.fullDescription,
    };
    const analysis = {
      relevanceScore: row.score,
      isRelevant: row.isRelevant,
      clientTrust: row.clientTrust,
      hasPreviousPayments: row.hasPreviousPayments,
      reasoning: row.reasoning,
      proposalDraft: row.proposalDraft,
      milestones: row.milestones || [],
    };
    const headers = { 'Content-Type': 'application/json' };
    if (REMOTE_DB_API_KEY) headers['X-API-Key'] = REMOTE_DB_API_KEY;
    const r = await fetch(`${REMOTE_DB_URL}/api/jobs`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ job, analysis, emailSent: !!row.emailSent }),
    });
    if (!r.ok) {
      console.error('Failed', row.jobUid, await r.text());
      continue;
    }
    ok++;
    if (row.proposalSent) {
      await fetch(`${REMOTE_DB_URL}/api/jobs/${row.jobUid}/proposal-sent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sent: true,
          notes: row.notes || '',
        }),
      });
    }
  }
  console.log(`Done: ${ok}/${jobs.length} synced`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
