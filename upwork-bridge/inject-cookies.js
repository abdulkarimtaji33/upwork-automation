#!/usr/bin/env node
/**
 * Inject Upwork SESSION cookies from data/upwork_cookies.json into Chrome via CDP.
 * Skips Cloudflare cookies (cf_clearance, __cf*, _cfuvid) — the VPS Chrome must
 * earn its own clearance. Waits for any active CF challenge to resolve first.
 * Run on VPS: node inject-cookies.js
 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const { CDP_BASE, COOKIE_JSON, JOBS_URL } = require('./config');

const CF_COOKIE_NAMES = new Set([
  'cf_clearance', '__cf_bm', '__cflb', '_cfuvid', '__cfwaitingroom',
]);

function isCfCookie(name) {
  return CF_COOKIE_NAMES.has(name) || name.startsWith('__cf');
}

async function waitForCfResolved(page, maxMs = 60000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const html = await page.content().catch(() => '');
    const blocked = ['Just a moment', 'Challenge - Upwork', 'cf-browser-verification',
      'Enable JavaScript and cookies', 'Checking your browser'].some(m => html.includes(m));
    if (!blocked) return true;
    console.log('  Waiting for Cloudflare challenge to resolve…');
    await new Promise(r => setTimeout(r, 2000));
  }
  return false;
}

async function main() {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(COOKIE_JSON, 'utf8'));
  } catch (e) {
    console.error('Missing', COOKIE_JSON, e.message);
    process.exit(1);
  }

  const map = data.cookies || {};
  // Only inject Upwork session cookies — skip all CF/Cloudflare cookies
  const puppeteerCookies = Object.entries(map)
    .filter(([name]) => !isCfCookie(name))
    .map(([name, value]) => ({
      name,
      value: String(value),
      domain: '.upwork.com',
      path: '/',
      secure: true,
      httpOnly: false,
    }));

  console.log(`Injecting ${puppeteerCookies.length} session cookies (CF cookies skipped)`);

  const browser = await puppeteer.connect({ browserURL: CDP_BASE, defaultViewport: null });
  const page = (await browser.pages())[0] || (await browser.newPage());

  // If we're already on a CF challenge, wait for it to clear first
  console.log('Current URL:', page.url());
  const alreadyBlocked = await (async () => {
    const h = await page.content().catch(() => '');
    return ['Just a moment', 'cf-browser-verification', 'Enable JavaScript and cookies'].some(m => h.includes(m));
  })();

  if (alreadyBlocked) {
    console.log('CF challenge active — waiting for it to self-resolve (up to 60s)…');
    const resolved = await waitForCfResolved(page, 60000);
    if (!resolved) {
      console.log('CF challenge did not resolve — injecting cookies anyway and retrying…');
    } else {
      console.log('CF challenge resolved!');
    }
  }

  // Navigate to upwork.com root to set cookies for the right domain
  await page.goto('https://www.upwork.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await waitForCfResolved(page, 30000);

  await page.setCookie(...puppeteerCookies);
  console.log('Session cookies set. Navigating to jobs page…');

  await page.goto(JOBS_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await waitForCfResolved(page, 30000);

  try {
    await page.waitForFunction(
      () => document.querySelectorAll('[data-ev-job-uid]').length > 0,
      { timeout: 45000 },
    );
  } catch {
    /* best effort */
  }

  const html = await page.content();
  const jobs = (html.match(/data-ev-job-uid/g) || []).length;
  const blocked = ['Challenge - Upwork', 'Just a moment', 'Enable JavaScript and cookies']
    .some(m => html.includes(m));

  // Save updated cookies (now includes VPS's own cf_clearance)
  const saved = await page.cookies();
  const { saveCookies } = require('./cookies');
  saveCookies(saved);

  console.log('jobs markers:', jobs, 'blocked:', blocked, 'html len:', html.length);
  await browser.disconnect();
  process.exit(jobs > 0 && !blocked ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
