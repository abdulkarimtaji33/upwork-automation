# Local automation + live database

Upwork fetching only works on your PC (Cloudflare). Jobs and AI analysis run **locally** and sync to a **live SQLite database**. The VPS only hosts the database UI for marking proposals sent.

## Architecture

| Where | What runs |
|-------|-----------|
| **Your PC** | Chrome bridge (`:9877`), automation dashboard (`:4000`), cron, OpenAI, email |
| **VPS** | Live server (`:3340`) — SQLite DB, proposal-sent UI, evidence uploads |

## 1. Live server (VPS)

```bash
cd /var/www/upwork-live   # or clone live-server folder
cp .env.example .env
# Set LIVE_API_KEY to a long random string
npm ci
npm start
```

Nginx example (port **3340**, isolated from other apps):

```nginx
server {
    listen 3340;
    server_name _;
    location / {
        proxy_pass http://127.0.0.1:3340;
        client_max_body_size 16M;
    }
}
```

PM2: `pm2 start server.js --name upwork-live --cwd /var/www/upwork-live`

## 2. Local automation

In `c:\n8n\automation\.env`:

```env
REMOTE_DB_URL=http://72.60.223.25:3340
REMOTE_DB_API_KEY=same-as-LIVE_API_KEY-on-server

BRIDGE_URL=http://127.0.0.1:9877
OPENAI_API_KEY=...
# Gmail OAuth vars unchanged
```

Settings → **Email mode**: use `db` or `both` so relevant jobs sync to live.

Start locally:

```bat
c:\n8n\start_all.bat
```

- Local dashboard: http://localhost:4000 — run cycles, settings, view jobs  
- Live dashboard: http://72.60.223.25:3340 — **mark proposal sent** + evidence only  

## 3. Migrate existing local JSON jobs to live (once)

```bash
cd c:\n8n\automation
set REMOTE_DB_URL=http://72.60.223.25:3340
set REMOTE_DB_API_KEY=your-key
node scripts/migrate-to-live.js
```

## Security

- `LIVE_API_KEY` protects **writes from your PC** (`POST /api/jobs`).
- Browser UI on live does not need the key for reading jobs or marking proposals sent.
- Use a strong random key and HTTPS in production if exposed publicly.
