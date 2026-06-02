const fs = require('fs');
const path = require('path');
const { COOKIE_JSON, COOKIE_TXT } = require('./config');

const PRIORITY_KEYS = [
  'cf_clearance',
  'cf_bm',
  '__cf_bm',
  'XSRF-TOKEN',
  'visitor_id',
  'master_access_token',
  'oauth2_global_js_token',
];

function buildCookieString(cookies) {
  const map = typeof cookies[0] === 'object' && cookies[0]?.name
    ? Object.fromEntries(cookies.map((c) => [c.name, c.value]))
    : cookies;

  const ordered = {};
  for (const k of PRIORITY_KEYS) {
    if (map[k]) ordered[k] = map[k];
  }
  for (const [k, v] of Object.entries(map)) {
    if (!(k in ordered)) ordered[k] = v;
  }
  return Object.entries(ordered)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

function saveCookies(cookies) {
  const map = typeof cookies[0] === 'object' && cookies[0]?.name
    ? Object.fromEntries(
        cookies
          .filter((c) => (c.domain || '').includes('upwork.com'))
          .map((c) => [c.name, c.value]),
      )
    : cookies;

  const cookieString = buildCookieString(map);
  fs.mkdirSync(path.dirname(COOKIE_JSON), { recursive: true });
  const payload = {
    cookieString,
    cookies: map,
    updatedAt: new Date().toISOString(),
    hasCfClearance: 'cf_clearance' in map,
    hasSession: ['master_access_token', 'oauth2_global_js_token', 'visitor_id'].some(
      (k) => k in map,
    ),
    source: 'node-upwork-bridge',
  };
  fs.writeFileSync(COOKIE_JSON, JSON.stringify(payload, null, 2), 'utf8');
  fs.writeFileSync(COOKIE_TXT, cookieString, 'utf8');
  return payload;
}

module.exports = { buildCookieString, saveCookies };
