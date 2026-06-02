'use strict';

require('dotenv').config();
const cron = require('node-cron');
const OpenAI = require('openai');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

// ─── Config ───────────────────────────────────────────────────────────────────

const BRIDGE_URL          = process.env.BRIDGE_URL          || 'http://127.0.0.1:9877';
const OPENAI_KEY          = process.env.OPENAI_API_KEY;
const EMAIL_FROM          = process.env.EMAIL_FROM;
const EMAIL_TO            = process.env.EMAIL_TO            || 'abdulkareemmain@gmail.com';
const GOOGLE_CLIENT_ID    = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
const SEEN_FILE           = process.env.SEEN_FILE           || path.join(__dirname, '..', 'data', 'seen_jobs.json');
const CRON_SCHEDULE       = process.env.CRON_SCHEDULE       || '*/5 * * * *';
const FETCH_TIMEOUT       = 120_000;

if (!OPENAI_KEY)           { console.error('[config] OPENAI_API_KEY is required');      process.exit(1); }
if (!EMAIL_FROM)           { console.error('[config] EMAIL_FROM is required');           process.exit(1); }
if (!GOOGLE_CLIENT_ID)     { console.error('[config] GOOGLE_CLIENT_ID is required');    process.exit(1); }
if (!GOOGLE_CLIENT_SECRET) { console.error('[config] GOOGLE_CLIENT_SECRET is required'); process.exit(1); }
if (!GOOGLE_REFRESH_TOKEN) { console.error('[config] GOOGLE_REFRESH_TOKEN is required'); process.exit(1); }

const openai = new OpenAI({ apiKey: OPENAI_KEY });

const mailer = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    type:         'OAuth2',
    user:         EMAIL_FROM,
    clientId:     GOOGLE_CLIENT_ID,
    clientSecret: GOOGLE_CLIENT_SECRET,
    refreshToken: GOOGLE_REFRESH_TOKEN,
  },
});

// ─── Seen-jobs deduplication ──────────────────────────────────────────────────

function loadSeen() {
  try { return new Set(JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'))); }
  catch { return new Set(); }
}

function saveSeen(set) {
  fs.mkdirSync(path.dirname(SEEN_FILE), { recursive: true });
  // keep only the last 2000 UIDs to prevent unbounded growth
  const arr = [...set].slice(-2000);
  fs.writeFileSync(SEEN_FILE, JSON.stringify(arr, null, 2));
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

async function bridgeGet(url, signal) {
  const res = await fetch(url, { signal });
  return res.text();
}

// ─── HTML parsing (ported from n8n Code nodes) ────────────────────────────────

function strip(s) {
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function htmlToText(s) {
  return String(s)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function pick(html, re) {
  const m = re.exec(html);
  return m && m[1] ? String(m[1]).trim() : '';
}

function parseJobListings(html) {
  if (!html || typeof html !== 'string') {
    return { error: 'No HTML received', jobs: [] };
  }

  if (
    html.includes('Challenge - Upwork') ||
    html.includes('cf-browser-verification') ||
    html.includes('Enable JavaScript and cookies')
  ) {
    return { error: 'Cloudflare challenge detected', jobs: [] };
  }

  const jobs = [];
  const articlePattern = /<article[^>]+data-ev-job-uid="(\d+)"[^>]*>([\s\S]*?)(?=<article|<\/section)/g;
  let match;

  while ((match = articlePattern.exec(html)) !== null) {
    const jobUid  = match[1];
    const jobHtml = match[2];

    const titleLinkMatch = /href="(\/jobs\/[^"?]+)[^"]*"[^>]*data-test="job-tile-title-link[^"]*"[^>]*>([^<]+)<\/a>/i.exec(jobHtml);
    if (!titleLinkMatch) continue;

    const link  = 'https://www.upwork.com' + titleLinkMatch[1];
    const tildeMatch = titleLinkMatch[1].match(/~(\d+)/);
    const jobDetailsUrl = tildeMatch
      ? `https://www.upwork.com/nx/s/job-details-viewer/jobs/~${tildeMatch[1]}`
      : link;
    const title = strip(titleLinkMatch[2]);

    const descMatch = /<p[^>]*class="[^"]*rr-mask[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(jobHtml);
    const description = descMatch ? strip(descMatch[1]) : '';

    const postedMatch = /<small[^>]*data-test="job-pubilshed-date"[^>]*>[\s\S]*?<span>([^<]+)<\/span>/i.exec(jobHtml);
    const postedAt = postedMatch ? postedMatch[1].trim() : '';

    const jobInfoMatches = [...jobHtml.matchAll(/<li[^>]*data-test="([^"]+)"[^>]*>[\s\S]*?<strong[^>]*>([^<]+)<\/strong>/gi)];
    const jobInfo = {};
    for (const m2 of jobInfoMatches) jobInfo[m2[1]] = m2[2].trim();

    jobs.push({
      jobUid,
      title,
      link,
      jobDetailsUrl,
      description,
      postedAt,
      jobType:         jobInfo['job-type-label']  || '',
      experienceLevel: jobInfo['experience-level'] || '',
      duration:        jobInfo['duration-label']   || '',
    });
  }

  return { jobs };
}

function parseFullJobDetails(job, html) {
  let { title, postedAt, description: baseDesc, jobType, experienceLevel, duration } = job;

  let fullDescription  = baseDesc || '';
  let paymentVerified  = false;
  let totalSpent       = 'Unknown';
  let hireRate         = 'Unknown';
  let totalHires       = 'Unknown';
  let memberSince      = '';
  let clientLocation   = '';
  let clientRating     = '';
  let jobsPosted       = '';
  let proposals        = '';
  let skills           = [];

  const blocked =
    !html ||
    html.length < 500 ||
    html.includes('Challenge - Upwork') ||
    html.includes('cf-browser-verification') ||
    html.includes('Enable JavaScript and cookies');

  if (!blocked) {
    const isViewer =
      html.includes('job-details-viewer') ||
      html.includes('data-test="job-description-content"');

    if (isViewer) {
      const pageTitle = pick(html, /data-test=["']job-title["'][^>]*>([^<]+)/i);
      if (pageTitle) title = htmlToText(pageTitle);

      const pagePosted = pick(html, /data-test=["']posted-time["'][^>]*>([^<]+)/i);
      if (pagePosted) postedAt = pagePosted;

      const descBlock = pick(
        html,
        /data-test=["']job-description-content["'][\s\S]*?class=["'][^"']*job-description-content[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
      );
      if (descBlock) {
        const cleaned = htmlToText(descBlock);
        if (cleaned.length > fullDescription.length) fullDescription = cleaned;
      }

      const workload = pick(
        html,
        /data-test=["']job-metrics-workload["'][\s\S]*?class=["'][^"']*label-medium[^"']*primary-text-color["'][^>]*>([^<]+)/i,
      );
      const workloadKind = pick(
        html,
        /data-test=["']job-metrics-workload["'][\s\S]*?class=["'][^"']*body-small[^"']*tertiary-text-color["'][^>]*>([^<]+)/i,
      );
      if (workloadKind) jobType = `${workload} · ${workloadKind}`.replace(/^ · /, '').trim();
      else if (workload) jobType = workload;

      duration = pick(
        html,
        /data-test=["']job-metrics-duration["'][\s\S]*?class=["'][^"']*label-medium[^"']*primary-text-color["'][^>]*>([^<]+)/i,
      ) || duration;

      experienceLevel = pick(
        html,
        /data-test=["']job-metrics-experience["'][\s\S]*?class=["'][^"']*label-medium[^"']*primary-text-color["'][^>]*>([^<]+)/i,
      ) || experienceLevel;

      paymentVerified = /data-test=["']about-client-payment-verified["'][\s\S]{0,400}?is-verified/i.test(html);

      const locCountry = pick(
        html,
        /data-test=["']about-client-location["'][\s\S]*?class=["'][^"']*label-medium[^"']*secondary-text-color["'][^>]*>([^<]+)/i,
      );
      const locCity = pick(
        html,
        /data-test=["']about-client-location["'][\s\S]*?class=["'][^"']*body-medium[^"']*tertiary-text-color["'][^>]*>([^<]+)/i,
      );
      clientLocation = [locCity, locCountry].filter(Boolean).join(', ');

      jobsPosted = pick(
        html,
        /data-test=["']about-client-job-stats["'][\s\S]*?class=["'][^"']*label-medium[^"']*secondary-text-color["'][^>]*>([^<]+)/i,
      );
      const hireRateText = pick(
        html,
        /data-test=["']about-client-job-stats["'][\s\S]*?tertiary-text-color["'][^>]*>([^<]*hire rate[^<]*)/i,
      );
      const hireRateMatch = hireRateText.match(/(\d+)%/);
      if (hireRateMatch) hireRate = hireRateMatch[1];

      const spendLine = pick(
        html,
        /data-test=["']about-client-spend-stats["'][\s\S]*?class=["'][^"']*label-medium[^"']*secondary-text-color["'][^>]*>([^<]+)/i,
      );
      const spendAmt = spendLine.match(/\$([0-9.,]+[KkMm]?)/);
      if (spendAmt) totalSpent = spendAmt[1];

      const hiresLine = pick(
        html,
        /data-test=["']about-client-spend-stats["'][\s\S]*?tertiary-text-color["'][^>]*>([^<]+)/i,
      );
      if (hiresLine) totalHires = htmlToText(hiresLine);

      memberSince = pick(html, /data-test=["']about-client-member-since["'][\s\S]*?>([^<]+)/i)
        .replace(/^Member since\s*/i, '');

      clientRating = pick(
        html,
        /data-test=["']about-client-rating["'][\s\S]*?class=["']ngm-rating-minimal-text["'][^>]*>([^<]+)/i,
      );

      proposals = pick(
        html,
        /data-test=["']activity-proposals["'][\s\S]*?client-activity-value[^>]*>([^<]+)/i,
      );

      skills = [...html.matchAll(/data-test=["']skill["'][\s\S]*?ngm-tag-skill["'][^>]*>([^<]+)/gi)]
        .map((m) => m[1].trim())
        .filter(Boolean)
        .slice(0, 25);
    } else {
      const descBlock = pick(
        html,
        /data-test=["']Description["'][\s\S]*?multiline-text[^>]*>([\s\S]*?)<\/p>/i,
      );
      if (descBlock) fullDescription = htmlToText(descBlock);

      paymentVerified =
        /payment\s+verified|is-verified/i.test(html) && !/unverified/i.test(html.slice(0, 8000));

      const spentMatch = /\$([0-9.,]+[KkMm]?)\s*total\s+spent/i.exec(html);
      if (spentMatch) totalSpent = spentMatch[1];

      const hiresMatch = /data-qa=["']client-hires["'][^>]*>([^<]+)/i.exec(html);
      if (hiresMatch) totalHires = htmlToText(hiresMatch[1]);

      clientLocation = pick(html, /data-qa=["']client-location["'][\s\S]*?<strong[^>]*>([^<]+)/i);
      memberSince = pick(html, /Member since\s+([^<\n]+)/i).replace(/^Member since\s*/i, '');

      const hrm = /(\d+)%\s*hire\s*rate/i.exec(html);
      if (hrm) hireRate = hrm[1];
    }
  }

  if (!fullDescription) fullDescription = baseDesc || '';

  const clientInfo = [
    clientLocation && `Location: ${clientLocation}`,
    memberSince    && `Member since: ${memberSince}`,
    jobsPosted     && jobsPosted,
    totalSpent !== 'Unknown' && `Spent: $${totalSpent}`,
    totalHires !== 'Unknown' && `Hires: ${totalHires}`,
    hireRate   !== 'Unknown' && `Hire rate: ${hireRate}%`,
    clientRating   && `Rating: ${clientRating}`,
    proposals      && `Proposals: ${proposals}`,
  ].filter(Boolean).join(', ');

  return {
    jobUid:          job.jobUid,
    title,
    link:            job.link,
    jobDetailsUrl:   job.jobDetailsUrl || job.link,
    description:     baseDesc,
    postedAt,
    jobType,
    experienceLevel,
    duration,
    fullDescription,
    skills:          skills.join(', '),
    proposals,
    clientRating,
    jobsPosted,
    clientInfo,
    paymentVerified,
    totalSpent,
    totalHires,
    hireRate,
    memberSince,
    clientLocation,
    htmlFetched:     !blocked,
    htmlLength:      html ? html.length : 0,
  };
}

// ─── OpenAI analysis ──────────────────────────────────────────────────────────

const ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    isRelevant:          { type: 'boolean' },
    relevanceScore:      { type: 'number' },
    clientTrust:         { type: 'string' },
    hasPreviousPayments: { type: 'boolean' },
    reasoning:           { type: 'string' },
    proposalDraft:       { type: 'string' },
  },
  required: ['isRelevant', 'relevanceScore', 'clientTrust', 'hasPreviousPayments', 'reasoning', 'proposalDraft'],
  additionalProperties: false,
};

async function analyzeJob(job) {
  const prompt = `Analyze this Upwork job posting and determine if it is relevant:

Job Title: ${job.title}
Full Job Description: ${job.fullDescription || job.description}
Job URL: ${job.link}
Posted: ${job.postedAt}
Job Type: ${job.jobType}
Experience Level: ${job.experienceLevel}
Skills: ${job.skills}
Proposals on job: ${job.proposals}
Client rating: ${job.clientRating}

Client Information:
- Payment Verified: ${job.paymentVerified ? 'Yes' : 'No'}
- Total Spent: $${job.totalSpent}
- Total Hires: ${job.totalHires}
- Hire Rate: ${job.hireRate}%
- Member Since: ${job.memberSince || 'Unknown'}
- Location: ${job.clientLocation || 'Unknown'}
- Client Summary: ${job.clientInfo || 'Limited client data from page'}
- Job page HTML fetched: ${job.htmlFetched ? 'Yes' : 'No (using listing description only)'}

Evaluate:
1. Client trustworthiness indicators (payment history, verified status, total spent, hires)
2. Job quality (clear requirements, reasonable budget, professional description)
3. Relevance to keywords: developer, website, application, web app

Provide:
1. isRelevant (boolean): true if job is worth pursuing
2. relevanceScore (number 0-100): overall quality score
3. clientTrust (string): assessment of client reliability
4. hasPreviousPayments (boolean): whether client has spent money on Upwork before
5. reasoning (string): detailed analysis
6. proposalDraft (string): if isRelevant is true, write a compelling personalized proposal`;

  const res = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content:
          'You are an expert Upwork job analyst. Evaluate job postings for client trustworthiness, payment history, and job quality. Create professional proposals for relevant opportunities. Always use the job title and description provided in the prompt.',
      },
      { role: 'user', content: prompt },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'job_analysis', strict: true, schema: ANALYSIS_SCHEMA },
    },
    temperature: 0.4,
  });

  return JSON.parse(res.choices[0].message.content);
}

// ─── Email ────────────────────────────────────────────────────────────────────

async function sendEmail(job, analysis) {
  const subject = `Relevant Upwork Job Found - ${job.title}`;
  const html = `
<h2>Relevant Upwork Job Found</h2>
<p><strong>Job Title:</strong> ${job.title}</p>
<p><strong>Posted:</strong> ${job.postedAt}</p>
<p><strong>Job URL:</strong> <a href="${job.link}">${job.link}</a></p>

<h3>Relevance</h3>
<p><strong>Score:</strong> ${analysis.relevanceScore}%</p>
<p><strong>Job Type:</strong> ${job.jobType} | <strong>Experience Level:</strong> ${job.experienceLevel}</p>

<h3>Client</h3>
<p><strong>Payment Verified:</strong> ${job.paymentVerified ? 'Yes' : 'No'}</p>
<p><strong>Total Spent:</strong> $${job.totalSpent}</p>
<p><strong>Total Hires:</strong> ${job.totalHires}</p>
<p><strong>Location:</strong> ${job.clientLocation || 'Unknown'}</p>
<p><strong>Member Since:</strong> ${job.memberSince || 'Unknown'}</p>
<p><strong>Skills:</strong> ${job.skills || 'N/A'}</p>
<p><strong>Proposals:</strong> ${job.proposals || 'N/A'}</p>
<p><strong>Client Rating:</strong> ${job.clientRating || 'N/A'}</p>
<p><strong>Trust Assessment:</strong> ${analysis.clientTrust}</p>

<h3>Analysis</h3>
<p>${analysis.reasoning}</p>

<h3>Proposal Draft</h3>
<p style="white-space:pre-wrap">${analysis.proposalDraft}</p>
`;

  await mailer.sendMail({ from: EMAIL_FROM, to: EMAIL_TO, subject, html });
  console.log(`[email] Sent: "${job.title}" → ${EMAIL_TO}`);
}

// ─── Main run ─────────────────────────────────────────────────────────────────

let running = false;

async function run() {
  if (running) {
    console.log('[run] Previous cycle still running, skipping.');
    return;
  }
  running = true;
  const seen = loadSeen();
  console.log(`\n[run] ${new Date().toISOString()} — starting cycle`);

  try {
    // 1. Fetch job listings
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT);
    let listingsHtml;
    try {
      listingsHtml = await bridgeGet(`${BRIDGE_URL}/fetch/jobs`, ac.signal);
    } finally {
      clearTimeout(timer);
    }

    const { error: parseError, jobs } = parseJobListings(listingsHtml);
    if (parseError) {
      console.error('[run] Listings parse error:', parseError);
      return;
    }
    console.log(`[run] Found ${jobs.length} jobs in listings`);

    // 2. Process each job
    let newJobs = 0;
    let emailsSent = 0;

    for (const job of jobs) {
      if (seen.has(job.jobUid)) continue;
      seen.add(job.jobUid);
      newJobs++;

      // 3. Fetch full job details
      let detailsHtml = '';
      try {
        const ac2 = new AbortController();
        const t2 = setTimeout(() => ac2.abort(), FETCH_TIMEOUT);
        try {
          const detailsUrl = `${BRIDGE_URL}/fetch?url=${encodeURIComponent(job.jobDetailsUrl || job.link)}`;
          detailsHtml = await bridgeGet(detailsUrl, ac2.signal);
        } finally {
          clearTimeout(t2);
        }
      } catch (err) {
        console.warn(`[run] Failed to fetch details for ${job.jobUid}:`, err.message);
      }

      // 4. Parse full details
      const fullJob = parseFullJobDetails(job, detailsHtml);

      // 5. Analyze with OpenAI
      let analysis;
      try {
        analysis = await analyzeJob(fullJob);
      } catch (err) {
        console.error(`[run] OpenAI error for ${job.jobUid}:`, err.message);
        continue;
      }

      console.log(
        `[run] ${job.title.substring(0, 60)} — relevant=${analysis.isRelevant} score=${analysis.relevanceScore}`,
      );

      // 6. Email if relevant
      if (analysis.isRelevant) {
        try {
          await sendEmail(fullJob, analysis);
          emailsSent++;
        } catch (err) {
          console.error(`[run] Email failed for ${job.jobUid}:`, err.message);
        }
      }
    }

    saveSeen(seen);
    console.log(`[run] Done — ${newJobs} new, ${emailsSent} emails sent`);
  } catch (err) {
    console.error('[run] Fatal error:', err);
  } finally {
    running = false;
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────────

console.log('Upwork Job Automation starting...');
console.log(`  Schedule : ${CRON_SCHEDULE}`);
console.log(`  Bridge   : ${BRIDGE_URL}`);
console.log(`  Email to : ${EMAIL_TO}`);
console.log('');

// Run once immediately, then on schedule
run();
cron.schedule(CRON_SCHEDULE, run);
