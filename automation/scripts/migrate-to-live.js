'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');

const REMOTE_DB_URL = (process.env.REMOTE_DB_URL || '').replace(/\/$/, '');
const REMOTE_DB_API_KEY = process.env.REMOTE_DB_API_KEY || '';
const DB_FILE = path.join(__dirname, '..', '..', 'data', 'jobs_db.json');
const SKIP_BACKFILL = process.env.SKIP_BACKFILL === '1';

if (!REMOTE_DB_URL) {
  console.error('Set REMOTE_DB_URL in automation/.env');
  process.exit(1);
}

function headers(json = true) {
  const h = {};
  if (json) h['Content-Type'] = 'application/json';
  if (REMOTE_DB_API_KEY) h['X-API-Key'] = REMOTE_DB_API_KEY;
  return h;
}

function rowToPayload(row) {
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
      budgetType: row.budgetType || '',
      clientBudget: row.clientBudget || '',
      quotedTotal: row.quotedTotal || '',
      milestones: row.milestones || [],
    };
  return { job, analysis, emailSent: !!row.emailSent };
}

async function main() {
  if (!SKIP_BACKFILL) {
    console.log('Step 1: backfill milestone prices locally…');
    require('child_process').execSync('node scripts/backfill-milestones.js prices', {
      cwd: path.join(__dirname, '..'),
      stdio: 'inherit',
      env: process.env,
    });
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (err) {
    console.error('No jobs_db.json:', err.message);
    process.exit(1);
  }

  const jobs = Object.values(data).filter((j) => j.isRelevant);
  console.log(`\nStep 2: migrating ${jobs.length} relevant jobs to ${REMOTE_DB_URL}`);

  let ok = 0;
  for (const row of jobs) {
    const { job, analysis, emailSent } = rowToPayload(row);
    const r = await fetch(`${REMOTE_DB_URL}/api/jobs`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ job, analysis, emailSent }),
    });
    if (!r.ok) {
      console.error('Failed', row.jobUid, await r.text());
      continue;
    }
    ok++;

    if (row.proposalSent) {
      await fetch(`${REMOTE_DB_URL}/api/jobs/${row.jobUid}/proposal-sent`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ sent: true, notes: row.notes || '' }),
      });
    }

    if (row.milestones?.length) {
      const hasPrices = row.milestones.every((m) => m.quotedPrice);
      const path = hasPrices ? 'milestones/prices' : 'milestones';
      const body = hasPrices
        ? { milestones: row.milestones, quotedTotal: row.quotedTotal || '' }
        : { milestones: row.milestones, force: true };
      await fetch(`${REMOTE_DB_URL}/api/jobs/${row.jobUid}/${path}`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(body),
      }).catch(() => {});
    }
  }

  console.log(`Done: ${ok}/${jobs.length} synced to live DB`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
