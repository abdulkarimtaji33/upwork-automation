#!/usr/bin/env node
/**
 * Inject cookies from data/upwork_cookies.json into automation Chrome via CDP.
 * Run on VPS: node inject-cookies.js
 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const { CDP_BASE, COOKIE_JSON, JOBS_URL } = require('./config');

async function main() {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(COOKIE_JSON, 'utf8'));
  } catch (e) {
    console.error('Missing', COOKIE_JSON, e.message);
    process.exit(1);
  }

  const map = data.cookies || {};
  const puppeteerCookies = Object.entries(map).map(([name, value]) => ({
    name,
    value: String(value),
    domain: '.upwork.com',
    path: '/',
    secure: true,
    httpOnly: name === 'cf_clearance' || name.startsWith('__cf'),
  }));

  console.log(`Injecting ${puppeteerCookies.length} cookies, cf_clearance=${!!map.cf_clearance}`);

  const browser = await puppeteer.connect({ browserURL: CDP_BASE, defaultViewport: null });
  const page = (await browser.pages())[0] || (await browser.newPage());

  await page.goto('https://www.upwork.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.setCookie(...puppeteerCookies);
  await page.goto(JOBS_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });

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
  const blocked = html.includes('Challenge - Upwork') || html.includes('Just a moment');
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
