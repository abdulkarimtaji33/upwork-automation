const { PORT } = require('./config');

async function main() {
  const base = `http://127.0.0.1:${PORT}`;
  const health = await fetch(`${base}/health`).then((r) => r.json());
  console.log('health:', health);
  if (!health.ok) process.exit(1);

  const r = await fetch(`${base}/fetch/jobs`);
  const html = await r.text();
  const jobs = (html.match(/data-ev-job-uid/g) || []).length;
  const blocked = html.includes('Challenge - Upwork');
  console.log('fetch/jobs:', r.status, 'len=', html.length, 'jobs=', jobs, 'blocked=', blocked);
  process.exit(jobs > 0 && !blocked ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
