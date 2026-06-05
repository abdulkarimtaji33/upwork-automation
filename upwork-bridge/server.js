const express = require('express');
const { PORT, JOBS_URL, COOKIE_JSON } = require('./config');
const chrome = require('./chrome');
const fs = require('fs');

const app = express();
app.use(express.json());

app.get('/health', async (_req, res) => {
  try {
    const cdp = await chrome.cdpAlive();
    res.json({ ok: true, cdp, port: PORT, runtime: 'node' });
  } catch (err) {
    res.status(503).json({ ok: false, error: err.message });
  }
});

app.get('/cookies', (_req, res) => {
  try {
    const data = JSON.parse(fs.readFileSync(COOKIE_JSON, 'utf8'));
    res.json(data);
  } catch {
    res.status(404).json({ error: 'Cookie file not found' });
  }
});

app.get('/fetch/jobs', async (_req, res) => {
  try {
    const result = await chrome.fetchUrl(JOBS_URL);
    if (result.blocked || !result.ready) {
      return res.status(403).json({
        error: 'Cloudflare block or jobs page not ready',
        ...result,
        html: undefined,
      });
    }
    res.type('html').send(result.html);
  } catch (err) {
    console.error('[fetch/jobs]', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/fetch', async (req, res) => {
  const url = req.query.url;
  if (!url || !String(url).includes('upwork.com')) {
    return res.status(400).json({ error: 'Missing or invalid ?url= (must be upwork.com)' });
  }
  try {
    const result = await chrome.fetchUrl(String(url));
    if (result.blocked) {
      return res.status(403).json({ error: 'Cloudflare block', ...result, html: undefined });
    }
    if (!result.ready) {
      return res.status(403).json({
        error: 'Page not ready (timeout)',
        ...result,
        html: undefined,
      });
    }
    res.type('html').send(result.html);
  } catch (err) {
    console.error('[fetch]', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/refresh', async (_req, res) => {
  try {
    const result = await chrome.refreshClearance();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/screenshot', async (_req, res) => {
  try {
    const buf = await chrome.screenshot();
    res.type('png').send(buf);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/click', async (req, res) => {
  const { x, y } = req.body;
  if (typeof x !== 'number' || typeof y !== 'number')
    return res.status(400).json({ error: 'x and y required' });
  try {
    await chrome.clickAt(x, y);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function main() {
  console.log(`Upwork bridge (Node.js) http://127.0.0.1:${PORT}`);
  console.log('  GET  /fetch/jobs');
  console.log('  GET  /fetch?url=');
  console.log('  POST /refresh');
  console.log('  GET  /health');

  const server = app.listen(PORT, '127.0.0.1', () => {
    console.log(`[server] Listening on 127.0.0.1:${PORT}`);
  });

  chrome.startWatchdog();
  chrome.ensureChrome().catch((err) => console.error('[startup]', err.message));

  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.keepAliveTimeout = 120_000;

  process.on('SIGINT', () => process.exit(0));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
