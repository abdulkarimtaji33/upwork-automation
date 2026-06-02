const { spawn } = require('child_process');
const fs = require('fs');
const puppeteer = require('puppeteer-core');
const {
  CDP_BASE,
  CDP_PORT,
  PROFILE,
  CHROME_PATHS,
  JOBS_URL,
  FETCH_TIMEOUT_MS,
} = require('./config');
const { saveCookies } = require('./cookies');

const BLOCKED_MARKERS = [
  'Challenge - Upwork',
  'cf-browser-verification',
  'Enable JavaScript and cookies',
  'Just a moment',
  'Checking your browser',
];

let chromeProcess = null;
let browser = null;
let fetchLock = Promise.resolve();

function findChrome() {
  for (const p of CHROME_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function pageLooksBlocked(html) {
  return BLOCKED_MARKERS.some((m) => html.includes(m));
}

function htmlHasJobs(html) {
  return (
    html &&
    !pageLooksBlocked(html) &&
    (html.includes('data-ev-job-uid') || html.includes('job-tile-title-link'))
  );
}

async function cdpAlive() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2000);
    const r = await fetch(`${CDP_BASE}/json/version`, { signal: ctrl.signal });
    clearTimeout(t);
    return r.ok;
  } catch {
    return false;
  }
}

function launchChrome() {
  const chrome = findChrome();
  if (!chrome) throw new Error('Google Chrome not found');

  if (chromeProcess && !chromeProcess.killed) {
    try {
      chromeProcess.kill();
    } catch {
      /* ignore */
    }
  }

  fs.mkdirSync(PROFILE, { recursive: true });
  console.log(`[chrome] Launching with profile ${PROFILE}`);

  chromeProcess = spawn(
    chrome,
    [
      `--remote-debugging-port=${CDP_PORT}`,
      '--remote-allow-origins=*',
      `--user-data-dir=${PROFILE}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
      JOBS_URL,
    ],
    { detached: false, stdio: 'ignore' },
  );

  chromeProcess.on('exit', () => {
    chromeProcess = null;
    browser = null;
  });
}

async function waitForCdp(maxMs = 45000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (await cdpAlive()) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function ensureChrome() {
  if (!(await cdpAlive())) {
    launchChrome();
    const ok = await waitForCdp();
    if (!ok) throw new Error('Chrome debug port did not start');
  }
}

async function getBrowser() {
  await ensureChrome();
  if (browser && browser.isConnected()) return browser;
  browser = await puppeteer.connect({
    browserURL: CDP_BASE,
    defaultViewport: null,
  });
  browser.on('disconnected', () => {
    browser = null;
  });
  return browser;
}

async function pickPage(b) {
  const pages = await b.pages();
  const upwork = pages.find((p) => (p.url() || '').includes('upwork.com'));
  return upwork || pages[0] || (await b.newPage());
}

async function waitForJobs(page) {
  try {
    await page.waitForFunction(
      () => document.querySelectorAll('[data-ev-job-uid]').length > 0,
      { timeout: 45000 },
    );
  } catch {
    /* may still have partial HTML */
  }
}

async function fetchUrl(url) {
  const b = await getBrowser();
  const page = await pickPage(b);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: FETCH_TIMEOUT_MS });

  // Wait for at least one job to appear
  let html = await page.content();
  for (let i = 0; i < 25 && !htmlHasJobs(html); i++) {
    await waitForJobs(page);
    html = await page.content();
    if (htmlHasJobs(html)) break;
    await new Promise((r) => setTimeout(r, 1000));
  }

  // Scroll to trigger React lazy-rendering — keeps scrolling until job count stabilizes
  if (htmlHasJobs(html)) {
    let prevCount = 0;
    let stableRounds = 0;
    for (let i = 0; i < 12; i++) {
      const count = await page.$$eval('[data-ev-job-uid]', (els) => els.length).catch(() => 0);
      if (count === prevCount) {
        stableRounds++;
        if (stableRounds >= 3) break; // stable for 3 consecutive checks
      } else {
        stableRounds = 0;
        prevCount = count;
      }
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await new Promise((r) => setTimeout(r, 1500));
    }
    html = await page.content();
    console.log(`[chrome] ${url.includes('upwork.com') ? 'jobs' : 'page'} — ${prevCount} job tiles after scroll`);
  }

  const cookies = await page.cookies();
  saveCookies(cookies);

  return {
    html,
    length: html.length,
    blocked: pageLooksBlocked(html),
    hasJobs: htmlHasJobs(html),
    hasCfClearance: cookies.some((c) => c.name === 'cf_clearance'),
    cookieCount: cookies.filter((c) => (c.domain || '').includes('upwork.com')).length,
  };
}

async function refreshClearance() {
  const result = await fetchUrl(JOBS_URL);
  const cookies = await (await getBrowser()).cookies();
  const upwork = cookies.filter((c) => (c.domain || '').includes('upwork.com'));
  return {
    ok: result.hasCfClearance,
    hasCfClearance: result.hasCfClearance,
    hasJobs: result.hasJobs,
    cookies: upwork.map((c) => c.name),
  };
}

function withFetchLock(fn) {
  const run = fetchLock.then(fn, fn);
  fetchLock = run.catch(() => {});
  return run;
}

async function watchdog() {
  try {
    if (!(await cdpAlive())) {
      console.log('[watchdog] CDP down — restarting Chrome');
      browser = null;
      launchChrome();
      await waitForCdp();
    } else if (!browser || !browser.isConnected()) {
      browser = await puppeteer.connect({ browserURL: CDP_BASE, defaultViewport: null });
    }
  } catch (err) {
    console.error('[watchdog]', err.message);
  }
}

function startWatchdog() {
  setInterval(watchdog, require('./config').WATCHDOG_MS);
}

module.exports = {
  cdpAlive,
  ensureChrome,
  fetchUrl: (url) => withFetchLock(() => fetchUrl(url)),
  refreshClearance: () => withFetchLock(() => refreshClearance()),
  startWatchdog,
  pageLooksBlocked,
  htmlHasJobs,
};
