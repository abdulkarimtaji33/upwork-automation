'use strict';

require('dotenv').config();
const EventEmitter = require('events');
const OpenAI       = require('openai');
const nodemailer   = require('nodemailer');
const fs           = require('fs');
const path         = require('path');

// ─── Shared emitter ───────────────────────────────────────────────────────────
const emitter = new EventEmitter();
emitter.setMaxListeners(100);

// ─── Settings ─────────────────────────────────────────────────────────────────
const SETTINGS_FILE = path.join(__dirname, 'settings.json');

const SETTINGS_DEFAULTS = {
  jobsUrl: 'https://www.upwork.com/nx/s/universal-search/jobs/?category2_uid=531770282580668418&client_hires=1-9&from_recent_search=true&per_page=50&q=%28website%20AND%20web%20AND%20app%29%20AND%20NOT%20%28wordpress%20OR%20woocommerce%20OR%20shopify%29&sort=recency',
  cronSchedule: '*/5 * * * *',
  aiModel: 'gpt-4o-mini',
  minScore: 0,
  emailTo: 'abdulkareemmain@gmail.com',
  aiSystemPrompt: 'You are an expert Upwork job analyst. Evaluate job postings for client trustworthiness, payment history, and job quality. Create professional proposals for relevant opportunities.',
  aiRelevanceKeywords: 'developer, website, application, web app',
  aiExcludeKeywords: 'wordpress, woocommerce, shopify',
  maxPages: 3,
  freelancerName: '',
  freelancerPortfolio: '',
};

function loadSettings() {
  try { return { ...SETTINGS_DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) }; }
  catch { return { ...SETTINGS_DEFAULTS }; }
}

function saveSettings(updates) {
  const current = loadSettings();
  const next = { ...current, ...updates };
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2));
  emitter.emit('settings:saved', next);
  return next;
}

// ─── Config ───────────────────────────────────────────────────────────────────
const BRIDGE_URL           = process.env.BRIDGE_URL           || 'http://127.0.0.1:9877';
const OPENAI_KEY           = process.env.OPENAI_API_KEY;
const EMAIL_FROM           = process.env.EMAIL_FROM;
const EMAIL_TO             = process.env.EMAIL_TO             || 'abdulkareemmain@gmail.com';
const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
const SEEN_FILE            = process.env.SEEN_FILE            || path.join(__dirname, '..', 'data', 'seen_jobs.json');
const FETCH_TIMEOUT        = 120_000;

if (!OPENAI_KEY)           { console.error('[config] OPENAI_API_KEY is required');       process.exit(1); }
if (!EMAIL_FROM)           { console.error('[config] EMAIL_FROM is required');            process.exit(1); }
if (!GOOGLE_CLIENT_ID)     { console.error('[config] GOOGLE_CLIENT_ID is required');     process.exit(1); }
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

// ─── Helpers ──────────────────────────────────────────────────────────────────
function log(type, message, data = {}) {
  const entry = { type, message, data, time: new Date().toISOString() };
  console.log(`[${type}] ${message}`);
  emitter.emit('log', entry);
  return entry;
}

function loadSeen() {
  try { return new Set(JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'))); }
  catch { return new Set(); }
}

function saveSeen(set) {
  fs.mkdirSync(path.dirname(SEEN_FILE), { recursive: true });
  fs.writeFileSync(SEEN_FILE, JSON.stringify([...set].slice(-2000), null, 2));
}

async function bridgeGet(url, signal) {
  const res = await fetch(url, { signal });
  return res.text();
}

// ─── HTML parsing ─────────────────────────────────────────────────────────────
function strip(s) {
  return s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

function htmlToText(s) {
  return String(s)
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n').trim();
}

function pick(html, re) {
  const m = re.exec(html);
  return m && m[1] ? String(m[1]).trim() : '';
}

function parseJobListings(html) {
  if (!html || typeof html !== 'string') return { error: 'No HTML received', jobs: [] };
  if (html.includes('Challenge - Upwork') || html.includes('cf-browser-verification') || html.includes('Enable JavaScript and cookies'))
    return { error: 'Cloudflare challenge detected', jobs: [] };

  const jobs = [];
  const articlePattern = /<article[^>]+data-ev-job-uid="(\d+)"[^>]*>([\s\S]*?)(?=<article|<\/section)/g;
  let match;
  while ((match = articlePattern.exec(html)) !== null) {
    const jobUid  = match[1];
    const jobHtml = match[2];
    const titleLinkMatch = /href="(\/jobs\/[^"?]+)[^"]*"[^>]*data-test="job-tile-title-link[^"]*"[^>]*>([^<]+)<\/a>/i.exec(jobHtml);
    if (!titleLinkMatch) continue;
    const link = 'https://www.upwork.com' + titleLinkMatch[1];
    const tildeMatch = titleLinkMatch[1].match(/~(\d+)/);
    const jobDetailsUrl = tildeMatch ? `https://www.upwork.com/nx/s/job-details-viewer/jobs/~${tildeMatch[1]}` : link;
    const title = strip(titleLinkMatch[2]);
    const descMatch = /<p[^>]*class="[^"]*rr-mask[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(jobHtml);
    const description = descMatch ? strip(descMatch[1]) : '';
    const postedMatch = /<small[^>]*data-test="job-pubilshed-date"[^>]*>[\s\S]*?<span>([^<]+)<\/span>/i.exec(jobHtml);
    const postedAt = postedMatch ? postedMatch[1].trim() : '';
    const jobInfoMatches = [...jobHtml.matchAll(/<li[^>]*data-test="([^"]+)"[^>]*>[\s\S]*?<strong[^>]*>([^<]+)<\/strong>/gi)];
    const jobInfo = {};
    for (const m2 of jobInfoMatches) jobInfo[m2[1]] = m2[2].trim();
    jobs.push({ jobUid, title, link, jobDetailsUrl, description, postedAt,
      jobType: jobInfo['job-type-label'] || '', experienceLevel: jobInfo['experience-level'] || '', duration: jobInfo['duration-label'] || '' });
  }
  return { jobs };
}

function parseFullJobDetails(job, html) {
  let { title, postedAt, description: baseDesc, jobType, experienceLevel, duration } = job;
  let fullDescription = baseDesc || '', paymentVerified = false, totalSpent = 'Unknown',
      hireRate = 'Unknown', totalHires = 'Unknown', memberSince = '', clientLocation = '',
      clientRating = '', jobsPosted = '', proposals = '', skills = [];

  const blocked = !html || html.length < 500 ||
    html.includes('Challenge - Upwork') || html.includes('cf-browser-verification') || html.includes('Enable JavaScript and cookies');

  if (!blocked) {
    const isViewer = html.includes('job-details-viewer') || html.includes('data-test="job-description-content"');
    if (isViewer) {
      const pt = pick(html, /data-test=["']job-title["'][^>]*>([^<]+)/i); if (pt) title = htmlToText(pt);
      const pp = pick(html, /data-test=["']posted-time["'][^>]*>([^<]+)/i); if (pp) postedAt = pp;
      const db = pick(html, /data-test=["']job-description-content["'][\s\S]*?class=["'][^"']*job-description-content[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
      if (db) { const c = htmlToText(db); if (c.length > fullDescription.length) fullDescription = c; }
      const wl = pick(html, /data-test=["']job-metrics-workload["'][\s\S]*?class=["'][^"']*label-medium[^"']*primary-text-color["'][^>]*>([^<]+)/i);
      const wk = pick(html, /data-test=["']job-metrics-workload["'][\s\S]*?class=["'][^"']*body-small[^"']*tertiary-text-color["'][^>]*>([^<]+)/i);
      if (wk) jobType = `${wl} · ${wk}`.replace(/^ · /, '').trim(); else if (wl) jobType = wl;
      duration = pick(html, /data-test=["']job-metrics-duration["'][\s\S]*?class=["'][^"']*label-medium[^"']*primary-text-color["'][^>]*>([^<]+)/i) || duration;
      experienceLevel = pick(html, /data-test=["']job-metrics-experience["'][\s\S]*?class=["'][^"']*label-medium[^"']*primary-text-color["'][^>]*>([^<]+)/i) || experienceLevel;
      paymentVerified = /data-test=["']about-client-payment-verified["'][\s\S]{0,400}?is-verified/i.test(html);
      const lc = pick(html, /data-test=["']about-client-location["'][\s\S]*?class=["'][^"']*label-medium[^"']*secondary-text-color["'][^>]*>([^<]+)/i);
      const lci = pick(html, /data-test=["']about-client-location["'][\s\S]*?class=["'][^"']*body-medium[^"']*tertiary-text-color["'][^>]*>([^<]+)/i);
      clientLocation = [lci, lc].filter(Boolean).join(', ');
      jobsPosted = pick(html, /data-test=["']about-client-job-stats["'][\s\S]*?class=["'][^"']*label-medium[^"']*secondary-text-color["'][^>]*>([^<]+)/i);
      const hrt = pick(html, /data-test=["']about-client-job-stats["'][\s\S]*?tertiary-text-color["'][^>]*>([^<]*hire rate[^<]*)/i);
      const hrm = hrt.match(/(\d+)%/); if (hrm) hireRate = hrm[1];
      const sl = pick(html, /data-test=["']about-client-spend-stats["'][\s\S]*?class=["'][^"']*label-medium[^"']*secondary-text-color["'][^>]*>([^<]+)/i);
      const sa = sl.match(/\$([0-9.,]+[KkMm]?)/); if (sa) totalSpent = sa[1];
      const hl = pick(html, /data-test=["']about-client-spend-stats["'][\s\S]*?tertiary-text-color["'][^>]*>([^<]+)/i);
      if (hl) totalHires = htmlToText(hl);
      memberSince = pick(html, /data-test=["']about-client-member-since["'][\s\S]*?>([^<]+)/i).replace(/^Member since\s*/i, '');
      clientRating = pick(html, /data-test=["']about-client-rating["'][\s\S]*?class=["']ngm-rating-minimal-text["'][^>]*>([^<]+)/i);
      proposals = pick(html, /data-test=["']activity-proposals["'][\s\S]*?client-activity-value[^>]*>([^<]+)/i);
      skills = [...html.matchAll(/data-test=["']skill["'][\s\S]*?ngm-tag-skill["'][^>]*>([^<]+)/gi)].map(m => m[1].trim()).filter(Boolean).slice(0, 25);
    } else {
      const db = pick(html, /data-test=["']Description["'][\s\S]*?multiline-text[^>]*>([\s\S]*?)<\/p>/i);
      if (db) fullDescription = htmlToText(db);
      paymentVerified = /payment\s+verified|is-verified/i.test(html) && !/unverified/i.test(html.slice(0, 8000));
      const sm = /\$([0-9.,]+[KkMm]?)\s*total\s+spent/i.exec(html); if (sm) totalSpent = sm[1];
      const hm = /data-qa=["']client-hires["'][^>]*>([^<]+)/i.exec(html); if (hm) totalHires = htmlToText(hm[1]);
      clientLocation = pick(html, /data-qa=["']client-location["'][\s\S]*?<strong[^>]*>([^<]+)/i);
      memberSince = pick(html, /Member since\s+([^<\n]+)/i).replace(/^Member since\s*/i, '');
      const hrm = /(\d+)%\s*hire\s*rate/i.exec(html); if (hrm) hireRate = hrm[1];
    }
  }

  if (!fullDescription) fullDescription = baseDesc || '';
  const clientInfo = [
    clientLocation && `Location: ${clientLocation}`, memberSince && `Member since: ${memberSince}`,
    jobsPosted, totalSpent !== 'Unknown' && `Spent: $${totalSpent}`, totalHires !== 'Unknown' && `Hires: ${totalHires}`,
    hireRate !== 'Unknown' && `Hire rate: ${hireRate}%`, clientRating && `Rating: ${clientRating}`, proposals && `Proposals: ${proposals}`,
  ].filter(Boolean).join(', ');

  return { jobUid: job.jobUid, title, link: job.link, jobDetailsUrl: job.jobDetailsUrl || job.link,
    description: baseDesc, postedAt, jobType, experienceLevel, duration, fullDescription,
    skills: skills.join(', '), proposals, clientRating, jobsPosted, clientInfo,
    paymentVerified, totalSpent, totalHires, hireRate, memberSince, clientLocation,
    htmlFetched: !blocked, htmlLength: html ? html.length : 0 };
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
    milestones: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title:       { type: 'string' },
          description: { type: 'string' },
          duration:    { type: 'string' },
        },
        required: ['title', 'description', 'duration'],
        additionalProperties: false,
      },
    },
  },
  required: ['isRelevant', 'relevanceScore', 'clientTrust', 'hasPreviousPayments', 'reasoning', 'proposalDraft', 'milestones'],
  additionalProperties: false,
};

async function analyzeJob(job) {
  const s = loadSettings();
  const res = await openai.chat.completions.create({
    model: s.aiModel || 'gpt-4o-mini',
    messages: [
      { role: 'system', content: s.aiSystemPrompt },
      { role: 'user', content: `Analyze this Upwork job posting and determine if it is relevant:\n\nJob Title: ${job.title}\nFull Job Description: ${job.fullDescription || job.description}\nJob URL: ${job.link}\nPosted: ${job.postedAt}\nJob Type: ${job.jobType}\nExperience Level: ${job.experienceLevel}\nSkills: ${job.skills}\nProposals on job: ${job.proposals}\nClient rating: ${job.clientRating}\n\nClient Information:\n- Payment Verified: ${job.paymentVerified ? 'Yes' : 'No'}\n- Total Spent: $${job.totalSpent}\n- Total Hires: ${job.totalHires}\n- Hire Rate: ${job.hireRate}%\n- Member Since: ${job.memberSince || 'Unknown'}\n- Location: ${job.clientLocation || 'Unknown'}\n- Client Summary: ${job.clientInfo || 'Limited client data'}\n- Job page HTML fetched: ${job.htmlFetched ? 'Yes' : 'No'}\n\nFreelancer applying:\n- Name: ${s.freelancerName || 'the freelancer'}\n${s.freelancerPortfolio ? `- Portfolio: ${s.freelancerPortfolio}\n` : ''}\nEvaluate client trustworthiness, job quality, and relevance to: ${s.aiRelevanceKeywords}.\n${s.aiExcludeKeywords ? `Exclude or deprioritize jobs about: ${s.aiExcludeKeywords}.\n` : ''}\nWhen writing proposalDraft: address the client directly, introduce the freelancer by name (${s.freelancerName || 'the freelancer'}), reference specific details from the job description to show genuine interest, and${s.freelancerPortfolio ? ` include the portfolio link (${s.freelancerPortfolio}) naturally in context,` : ''} keep it concise and professional.\n\nProvide:\n- isRelevant, relevanceScore (0-100), clientTrust, hasPreviousPayments, reasoning\n- proposalDraft (the cover letter text only — no milestones inside it)\n- milestones: if isRelevant, break the project into 3-5 logical delivery milestones, each with a title, a one-sentence description of what gets delivered, and a realistic duration estimate (e.g. "3 days", "1 week"). If not relevant, return an empty array.` },
    ],
    response_format: { type: 'json_schema', json_schema: { name: 'job_analysis', strict: true, schema: ANALYSIS_SCHEMA } },
    temperature: 0.4,
  });
  return JSON.parse(res.choices[0].message.content);
}

async function sendEmail(job, analysis, recipient) {
  const subject = `Relevant Upwork Job Found - ${job.title}`;
  const html = `<h2>Relevant Upwork Job Found</h2><p><strong>Job Title:</strong> ${job.title}</p><p><strong>Posted:</strong> ${job.postedAt}</p><p><strong>Job URL:</strong> <a href="${job.link}">${job.link}</a></p><h3>Relevance</h3><p><strong>Score:</strong> ${analysis.relevanceScore}%</p><p><strong>Job Type:</strong> ${job.jobType} | <strong>Experience Level:</strong> ${job.experienceLevel}</p><h3>Client</h3><p><strong>Payment Verified:</strong> ${job.paymentVerified ? 'Yes' : 'No'}</p><p><strong>Total Spent:</strong> $${job.totalSpent}</p><p><strong>Total Hires:</strong> ${job.totalHires}</p><p><strong>Location:</strong> ${job.clientLocation || 'Unknown'}</p><p><strong>Member Since:</strong> ${job.memberSince || 'Unknown'}</p><p><strong>Skills:</strong> ${job.skills || 'N/A'}</p><p><strong>Proposals:</strong> ${job.proposals || 'N/A'}</p><p><strong>Client Rating:</strong> ${job.clientRating || 'N/A'}</p><p><strong>Trust Assessment:</strong> ${analysis.clientTrust}</p><h3>Analysis</h3><p>${analysis.reasoning}</p><h3>Proposal Draft</h3><p style="white-space:pre-wrap">${analysis.proposalDraft}</p>`;
  await mailer.sendMail({ from: EMAIL_FROM, to: recipient || EMAIL_TO, subject, html });
}

// ─── DB ───────────────────────────────────────────────────────────────────────
const db = require('./db');

// ─── Main cycle ───────────────────────────────────────────────────────────────
let running       = false;
let stopRequested = false;

function stopCycle() {
  if (running) { stopRequested = true; log('warn', 'Stop requested — finishing current job then stopping…'); }
}

async function runCycle() {
  if (running) { log('warn', 'Previous cycle still running, skipping.'); return false; }
  running = true;
  stopRequested = false;
  const s = loadSettings();
  emitter.emit('cycle:start', { time: new Date().toISOString() });
  const seen = loadSeen();
  let newJobs = 0, emailsSent = 0, totalFound = 0;

  try {
    const maxPages = Math.max(1, Math.min(Number(s.maxPages) || 1, 10));
    const baseUrl  = s.jobsUrl || null;

    // ── Paginated fetch ──────────────────────────────────────────────
    const allJobs   = [];
    const seenUids  = new Set();

    for (let page = 1; page <= maxPages; page++) {
      let pageUrl;
      if (baseUrl) {
        const u = new URL(baseUrl);
        if (page > 1) u.searchParams.set('page', page);
        pageUrl = `${BRIDGE_URL}/fetch?url=${encodeURIComponent(u.toString())}`;
      } else {
        pageUrl = page === 1 ? `${BRIDGE_URL}/fetch/jobs` : null;
        if (!pageUrl) break;
      }

      log('info', `Fetching page ${page}/${maxPages}…`);
      const ac    = new AbortController();
      const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT);
      let html;
      try { html = await bridgeGet(pageUrl, ac.signal); }
      catch (err) { log('warn', `Page ${page} fetch failed: ${err.message}`); break; }
      finally { clearTimeout(timer); }

      const { error: parseError, jobs: pageJobs } = parseJobListings(html);
      if (parseError) { log('warn', `Page ${page} parse error: ${parseError}`); break; }
      if (!pageJobs.length) { log('info', `Page ${page} empty — stopping pagination`); break; }

      let newOnPage = 0;
      for (const job of pageJobs) {
        if (!seenUids.has(job.jobUid)) {
          seenUids.add(job.jobUid);
          allJobs.push(job);
          newOnPage++;
        }
      }
      log('info', `Page ${page}: ${newOnPage} new jobs (${pageJobs.length} on page)`);
      if (newOnPage === 0) { log('info', 'No new jobs on this page — stopping pagination'); break; }
    }

    if (!allJobs.length) { log('error', 'No jobs found across all pages'); emitter.emit('cycle:done', { newJobs: 0, emailsSent: 0, totalFound: 0, error: 'No jobs found' }); return; }

    totalFound = allJobs.length;
    log('info', `Found ${totalFound} total jobs across pages`);
    emitter.emit('jobs:found', { count: totalFound });

    const jobs = allJobs;

    for (const job of jobs) {
      if (stopRequested) { log('warn', 'Cycle stopped by user'); break; }
      if (seen.has(job.jobUid)) { emitter.emit('job:skipped', { jobUid: job.jobUid }); continue; }
      seen.add(job.jobUid);
      newJobs++;

      emitter.emit('job:processing', { jobUid: job.jobUid, title: job.title, index: newJobs, total: totalFound });
      log('info', `Processing: ${job.title.substring(0, 60)}`);

      let detailsHtml = '';
      try {
        const ac2 = new AbortController();
        const t2 = setTimeout(() => ac2.abort(), FETCH_TIMEOUT);
        try { detailsHtml = await bridgeGet(`${BRIDGE_URL}/fetch?url=${encodeURIComponent(job.jobDetailsUrl || job.link)}`, ac2.signal); }
        finally { clearTimeout(t2); }
      } catch (err) { log('warn', `Failed to fetch details for ${job.jobUid}: ${err.message}`); }

      const fullJob = parseFullJobDetails(job, detailsHtml);

      let analysis;
      try { analysis = await analyzeJob(fullJob); }
      catch (err) { log('error', `OpenAI error for ${job.jobUid}: ${err.message}`); continue; }

      emitter.emit('job:analyzed', { ...fullJob, analysis, isRelevant: analysis.isRelevant, score: analysis.relevanceScore });
      log(analysis.isRelevant ? 'success' : 'info', `${job.title.substring(0, 55)} — score=${analysis.relevanceScore} relevant=${analysis.isRelevant}`);

      const minScore  = typeof s.minScore === 'number' ? s.minScore : 0;
      const emailMode = s.emailMode || 'both'; // 'email', 'db', 'both'
      const relevant  = analysis.isRelevant && analysis.relevanceScore >= minScore;

      if (relevant) {
        let emailSent = false;

        // Save to DB
        if (emailMode === 'db' || emailMode === 'both') {
          try { db.upsertJob(fullJob, analysis, false); }
          catch (err) { log('error', `DB save failed: ${err.message}`); }
        }

        // Send email
        if (emailMode === 'email' || emailMode === 'both') {
          const recipient = s.emailTo || EMAIL_TO;
          try {
            await sendEmail(fullJob, analysis, recipient);
            emailSent = true;
            emailsSent++;
            emitter.emit('job:email', { jobUid: job.jobUid, title: job.title });
            log('success', `Email sent: "${job.title}"`);
            if (emailMode === 'both') {
              try { db.upsertJob(fullJob, analysis, true); } catch {}
            }
          } catch (err) { log('error', `Email failed for ${job.jobUid}: ${err.message}`); }
        }
      }
    }

    saveSeen(seen);
    log('success', `Cycle done — ${newJobs} new jobs, ${emailsSent} emails sent`);
    emitter.emit('cycle:done', { newJobs, emailsSent, totalFound, error: null });
  } catch (err) {
    log('error', `Fatal error: ${err.message}`);
    emitter.emit('cycle:done', { newJobs, emailsSent, totalFound, error: err.message });
  } finally {
    running = false;
  }
}

module.exports = { emitter, runCycle, stopCycle, loadSettings, saveSettings, BRIDGE_URL, EMAIL_TO, isRunning: () => running, isStopRequested: () => stopRequested };
