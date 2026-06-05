const path = require('path');

const ROOT = process.env.UPWORK_ROOT || path.resolve(__dirname, '..');
const DATA_DIR = process.env.N8N_USER_FOLDER
  ? path.resolve(process.env.N8N_USER_FOLDER)
  : path.join(ROOT, 'data');

module.exports = {
  PORT: Number(process.env.UPWORK_FETCH_PORT || 9877),
  CDP_PORT: Number(process.env.UPWORK_CDP_PORT || 9222),
  CDP_BASE: `http://127.0.0.1:${process.env.UPWORK_CDP_PORT || 9222}`,
  PROFILE: process.env.UPWORK_CHROME_PROFILE || path.resolve(ROOT, 'chrome-profile'),
  COOKIE_JSON: path.join(DATA_DIR, 'upwork_cookies.json'),
  COOKIE_TXT: path.join(DATA_DIR, 'upwork_cookies.txt'),
  JOBS_URL:
    'https://www.upwork.com/nx/s/universal-search/jobs/' +
    '?category2_uid=531770282580668418&client_hires=1-9&from_recent_search=true' +
    '&per_page=50&q=%28website%20AND%20web%20AND%20app%29%20AND%20NOT%20' +
    '%28wordpress%20OR%20woocommerce%20OR%20shopify%29&sort=recency',
  CHROME_PATHS: [
    process.env.CHROME_BIN,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean),
  WATCHDOG_MS: 30_000,
  FETCH_TIMEOUT_MS: 120_000,
};
