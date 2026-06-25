'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');
const {
  MILESTONES_ONLY_SCHEMA,
  MILESTONE_PRICES_ONLY_SCHEMA,
  milestonePricingPrompt,
  mergeMilestonePrices,
  parseJobPricing,
} = require('../milestone-utils');

const DB_FILE = path.join(__dirname, '..', '..', 'data', 'jobs_db.json');
const REMOTE_DB_URL = (process.env.REMOTE_DB_URL || '').replace(/\/$/, '');
const REMOTE_DB_API_KEY = process.env.REMOTE_DB_API_KEY || '';
const DRY_RUN = process.env.DRY_RUN === '1';

async function generateMilestones(openai, job) {
  const res = await openai.chat.completions.create({
    model: process.env.AI_MODEL || 'gpt-4o-mini',
    messages: [
      { role: 'system', content: 'You break Upwork projects into practical delivery milestones with pricing. Return JSON only.' },
      {
        role: 'user',
        content: `Create 3-5 project milestones for this job.

Job Title: ${job.title}
Description: ${(job.fullDescription || job.description || '').slice(0, 4000)}
Job Type / Rate: ${job.jobType || 'Unknown'}
Experience: ${job.experienceLevel || 'Unknown'}
${milestonePricingPrompt(job)}`,
      },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'milestones_with_pricing', strict: true, schema: MILESTONES_ONLY_SCHEMA },
    },
    temperature: 0.3,
  });
  return JSON.parse(res.choices[0].message.content);
}

async function generateMilestonePrices(openai, job) {
  const existing = job.milestones || [];
  const res = await openai.chat.completions.create({
    model: process.env.AI_MODEL || 'gpt-4o-mini',
    messages: [
      { role: 'system', content: 'You recommend competitive Upwork pricing. Return JSON only. Do not change milestone titles or descriptions.' },
      {
        role: 'user',
        content: `Add quotedPrice and priceType to each existing milestone (same order, ${existing.length} items).

Job Title: ${job.title}
Job Type / Rate: ${job.jobType || 'Unknown'}
Description excerpt: ${(job.fullDescription || '').slice(0, 2000)}
${milestonePricingPrompt(job)}

Existing milestones:
${existing.map((m, i) => `${i + 1}. ${m.title} (${m.duration}) — ${m.description}`).join('\n')}

Return quotedTotal plus one price entry per milestone in the same order.`,
      },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'milestone_prices', strict: true, schema: MILESTONE_PRICES_ONLY_SCHEMA },
    },
    temperature: 0.3,
  });
  return JSON.parse(res.choices[0].message.content);
}

async function syncPricesToLive(jobUid, milestones, quotedTotal) {
  if (!REMOTE_DB_URL) return;
  const headers = { 'Content-Type': 'application/json' };
  if (REMOTE_DB_API_KEY) headers['X-API-Key'] = REMOTE_DB_API_KEY;
  const r = await fetch(`${REMOTE_DB_URL}/api/jobs/${encodeURIComponent(jobUid)}/milestones/prices`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ milestones, quotedTotal }),
  });
  if (!r.ok) throw new Error(await r.text());
}

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error('OPENAI_API_KEY required in automation/.env');
    process.exit(1);
  }

  const mode = process.argv[2] || 'prices';
  let data;
  try {
    data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (err) {
    console.error('No jobs_db.json:', err.message);
    process.exit(1);
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  let jobs;

  if (mode === 'full') {
    jobs = Object.values(data).filter((j) => j.isRelevant && (!j.milestones || !j.milestones.length));
    console.log(`Backfilling milestones+pricing for ${jobs.length} job(s)`);
  } else {
    jobs = Object.values(data).filter(
      (j) => j.isRelevant && j.milestones?.length && j.milestones.some((m) => !m.quotedPrice),
    );
    console.log(`Backfilling milestone prices for ${jobs.length} job(s)${DRY_RUN ? ' (DRY RUN)' : ''}`);
  }

  let ok = 0;
  for (const job of jobs) {
    try {
      console.log(`  ${job.jobUid} — ${(job.title || '').slice(0, 55)}`);
      if (DRY_RUN) { ok++; continue; }

      if (mode === 'full') {
        const result = await generateMilestones(openai, job);
        data[job.jobUid].milestones = result.milestones;
        data[job.jobUid].budgetType = result.budgetType;
        data[job.jobUid].clientBudget = result.clientBudget;
        data[job.jobUid].quotedTotal = result.quotedTotal;
      } else {
        const result = await generateMilestonePrices(openai, job);
        data[job.jobUid].milestones = mergeMilestonePrices(job.milestones, result.milestones);
        data[job.jobUid].quotedTotal = result.quotedTotal;
        const pricing = parseJobPricing(job.jobType);
        if (!data[job.jobUid].budgetType) data[job.jobUid].budgetType = pricing.budgetType;
        if (!data[job.jobUid].clientBudget) data[job.jobUid].clientBudget = pricing.clientBudget;
        if (REMOTE_DB_URL) {
          await syncPricesToLive(job.jobUid, data[job.jobUid].milestones, result.quotedTotal);
        }
      }

      data[job.jobUid].updatedAt = new Date().toISOString();
      fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
      ok++;
      await new Promise((r) => setTimeout(r, 400));
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
