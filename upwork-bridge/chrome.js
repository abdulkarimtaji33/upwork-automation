const { spawn, execSync } = require('child_process');
const fs = require('fs');
const puppeteer = require('puppeteer-core');

let xvfbProcess = null;
const DISPLAY_NUM = process.env.DISPLAY_NUM || '99';
const XVFB_DISPLAY = `:${DISPLAY_NUM}`;

function ensureXvfb() {
  if (process.platform === 'win32') return; // not needed on Windows
  if (xvfbProcess && !xvfbProcess.killed) return;
  // Check if Xvfb is already running on this display
  try { execSync(`xdpyinfo -display ${XVFB_DISPLAY}`, { stdio: 'ignore' }); return; } catch { /* not running */ }
  console.log(`[xvfb] Starting Xvfb on display ${XVFB_DISPLAY}`);
  xvfbProcess = spawn('Xvfb', [XVFB_DISPLAY, '-screen', '0', '1920x1080x24', '-ac'], {
    detached: false, stdio: 'ignore',
  });
  xvfbProcess.on('exit', () => { xvfbProcess = null; });
  // Give Xvfb a moment to start
  const start = Date.now();
  while (Date.now() - start < 3000) {
    try { execSync(`xdpyinfo -display ${XVFB_DISPLAY}`, { stdio: 'ignore' }); break; } catch { /* wait */ }
    const deadline = Date.now() + 200;
    while (Date.now() < deadline) { /* busy-wait */ }
  }
}
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
    try { chromeProcess.kill(); } catch { /* ignore */ }
  }

  ensureXvfb();
  fs.mkdirSync(PROFILE, { recursive: true });
  console.log(`[chrome] Launching with profile ${PROFILE}`);

  const env = { ...process.env };
  if (process.platform !== 'win32') env.DISPLAY = XVFB_DISPLAY;

  chromeProcess = spawn(
    chrome,
    [
      `--remote-debugging-port=${CDP_PORT}`,
      '--remote-allow-origins=*',
      `--user-data-dir=${PROFILE}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
      '--window-size=1920,1080',
      '--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.7778.215 Safari/537.36',
      JOBS_URL,
    ],
    { detached: false, stdio: 'ignore', env },
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

async function applyStealthToPage(page) {
  // Patch runs in ALL frames including cross-origin iframes via CDP worldName
  await page.evaluateOnNewDocument(() => {
    // Hide webdriver
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    // Realistic plugins
    Object.defineProperty(navigator, 'plugins', {
      get: () => {
        const ps = [{ name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
                    { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
                    { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' }];
        ps.__proto__ = PluginArray.prototype;
        return ps;
      }
    });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    // Realistic chrome object
    if (!window.chrome || !window.chrome.app) {
      window.chrome = { app: { isInstalled: false }, webstore: {}, runtime: { onConnect: { addListener: () => {} }, onMessage: { addListener: () => {} } } };
    }
    // Permissions
    try {
      const origQuery = window.navigator.permissions.query.bind(navigator.permissions);
      window.navigator.permissions.__proto__.query = (p) =>
        p.name === 'notifications' ? Promise.resolve({ state: Notification.permission }) : origQuery(p);
    } catch {}
    // Hide CDP artifacts
    delete window.cdc_adoQpoasnfa76pfcZLmcfl_Array;
    delete window.cdc_adoQpoasnfa76pfcZLmcfl_Promise;
    delete window.cdc_adoQpoasnfa76pfcZLmcfl_Symbol;
  });
}

async function getBrowser() {
  await ensureChrome();
  if (browser && browser.isConnected()) return browser;
  browser = await puppeteer.connect({
    browserURL: CDP_BASE,
    defaultViewport: null,
  });
  browser.on('disconnected', () => { browser = null; });
  browser.on('targetcreated', async (target) => {
    try {
      const page = await target.page();
      if (page) await applyStealthToPage(page);
    } catch { /* ignore */ }
  });
  // Apply stealth to already-open pages
  try {
    for (const page of await browser.pages()) await applyStealthToPage(page);
  } catch { /* ignore */ }
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

  // If Chrome is already on a CF challenge for this domain, DON'T navigate —
  // doing so interrupts the user's manual verification. Just wait for it to clear.
  let html = await page.content().catch(() => '');
  const alreadyOnDomain = (page.url() || '').includes('upwork.com');
  const currentlyBlocked = pageLooksBlocked(html);

  if (alreadyOnDomain && currentlyBlocked) {
    console.log('[chrome] CF challenge active — waiting for user to solve (up to 5 min)…');
    // Wait up to 5 minutes for the challenge to clear before navigating
    const deadline = Date.now() + 5 * 60 * 1000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 3000));
      html = await page.content().catch(() => '');
      if (!pageLooksBlocked(html)) {
        console.log('[chrome] CF challenge resolved — proceeding');
        break;
      }
    }
  } else {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: FETCH_TIMEOUT_MS });
  }

  // Wait for at least one job to appear
  html = await page.content().catch(() => '');
  for (let i = 0; i < 25 && !htmlHasJobs(html); i++) {
    await waitForJobs(page);
    html = await page.content().catch(() => '');
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

async function screenshot() {
  const b = await getBrowser();
  const page = await pickPage(b);
  return page.screenshot({ type: 'png', encoding: 'binary', fullPage: false });
}

async function clickAt(x, y) {
  const b = await getBrowser();
  const page = await pickPage(b);
  await page.mouse.move(x, y);
  await new Promise(r => setTimeout(r, 80));
  await page.mouse.click(x, y);
}

module.exports = {
  cdpAlive,
  ensureChrome,
  fetchUrl: (url) => withFetchLock(() => fetchUrl(url)),
  refreshClearance: () => withFetchLock(() => refreshClearance()),
  screenshot,
  clickAt,
  startWatchdog,
  pageLooksBlocked,
  htmlHasJobs,
};
