'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');

const DB_FILE = path.join(__dirname, '..', '..', 'data', 'jobs_db.json');
const REMOTE_DB_URL = (process.env.REMOTE_DB_URL || '').replace(/\/$/, '');
const REMOTE_DB_API_KEY = process.env.REMOTE_DB_API_KEY || '';
const DRY_RUN = process.env.DRY_RUN === '1';

const MILESTONE_SCHEMA = {
  type: 'object',
  properties: {
    milestones: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          duration: { type: 'string' },
        },
        required: ['title', 'description', 'duration'],
        additionalProperties: false,
      },
    },
  },
  required: ['milestones'],
  additionalProperties: false,
};

async function generateMilestones(openai, job) {
  const res = await openai.chat.completions.create({
    model: process.env.AI_MODEL || 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content: 'You break Upwork projects into practical delivery milestones. Return JSON only.',
      },
      {
        role: 'user',
        content: `Create 3-5 project milestones for this job. Each milestone needs title, one-sentence description, and duration (e.g. "3 days", "1 week").

Job Title: ${job.title}
Description: ${(job.fullDescription || job.description || '').slice(0, 4000)}
Job Type: ${job.jobType || 'Unknown'}
Experience: ${job.experienceLevel || 'Unknown'}`,
      },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'milestones_only', strict: true, schema: MILESTONE_SCHEMA },
    },
    temperature: 0.3,
  });
  return JSON.parse(res.choices[0].message.content).milestones;
}

async function syncMilestonesToLive(jobUid, milestones) {
  if (!REMOTE_DB_URL) return;
  const headers = { 'Content-Type': 'application/json' };
  if (REMOTE_DB_API_KEY) headers['X-API-Key'] = REMOTE_DB_API_KEY;
  const r = await fetch(`${REMOTE_DB_URL}/api/jobs/${encodeURIComponent(jobUid)}/milestones`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ milestones }),
  });
  if (!r.ok) throw new Error(await r.text());
}

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error('OPENAI_API_KEY required in automation/.env');
    process.exit(1);
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (err) {
    console.error('No jobs_db.json:', err.message);
    process.exit(1);
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const jobs = Object.values(data).filter((j) => j.isRelevant && (!j.milestones || !j.milestones.length));
  console.log(`Backfilling milestones for ${jobs.length} job(s)${DRY_RUN ? ' (DRY RUN)' : ''}`);

  let ok = 0;
  for (const job of jobs) {
    try {
      console.log(`  ${job.jobUid} — ${(job.title || '').slice(0, 60)}`);
      if (DRY_RUN) { ok++; continue; }

      const milestones = await generateMilestones(openai, job);
      data[job.jobUid].milestones = milestones;
      data[job.jobUid].updatedAt = new Date().toISOString();
      fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));

      if (REMOTE_DB_URL) {
        // Live sync happens during migrate-to-live.js after jobs exist on server
      }
      ok++;
      await new Promise((r) => setTimeout(r, 500));
    } catch (err) {
      console.error('  Failed:', job.jobUid, err.message);
    }
  }

  console.log(`Done: ${ok}/${jobs.length} updated`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
