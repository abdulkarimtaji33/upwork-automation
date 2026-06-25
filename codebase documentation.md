# Upwork Automation — Codebase Documentation

Complete reference for the repository structure, what each file does, how to deploy, and server access.

---

## Overview

This project automates Upwork job discovery on your **local PC** (Chrome + Cloudflare), analyzes jobs with **OpenAI**, optionally sends **email alerts**, and syncs relevant jobs to a **live SQLite database** on a VPS. The live server is read-only for browsing, filtering, and marking proposals sent — it does not scrape Upwork.

```
┌─────────────────────────────────────────────────────────────────┐
│  YOUR PC (Windows)                                              │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────────┐  │
│  │ upwork-bridge│──▶│  automation  │──▶│  OpenAI + Gmail  │  │
│  │  :9877       │   │  dashboard   │   │                  │  │
│  │  Chrome/CDP  │   │  :4000       │   └──────────────────┘  │
│  └──────────────┘   └──────┬───────┘                          │
│                            │ POST /api/jobs (X-API-Key)        │
└────────────────────────────┼────────────────────────────────────┘
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  VPS — Primary server (72.60.223.25)                            │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │  live-server  :3340  — SQLite DB + job browser UI        │ │
│  │  PM2 process: upwork-live                                 │ │
│  └──────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

---

## Git Repository

| Item | Value |
|------|-------|
| **Repository URL** | https://github.com/abdulkarimtaji33/upwork-automation.git |
| **Default branch** | `main` |
| **Local path (dev)** | `C:\n8n` |

```bash
git clone https://github.com/abdulkarimtaji33/upwork-automation.git
cd upwork-automation
```

---

## Servers & URLs

### Primary VPS (Upwork live server)

| Item | Value |
|------|-------|
| **Live UI** | http://72.60.223.25:3340 |
| **Health check** | http://72.60.223.25:3340/health |
| **SSH** | `ssh root@72.60.223.25` |
| **App path on server** | `/var/www/upwork-automation/live-server` |
| **Repo path on server** | `/var/www/upwork-automation` |
| **PM2 process name** | `upwork-live` |
| **Port** | `3340` |
| **Database file** | `/var/www/upwork-automation/live-server/data/jobs.db` |
| **Evidence uploads** | `/var/www/upwork-automation/live-server/data/evidence/` |

### Secondary VPS (other projects — do not touch for Upwork deploy)

| Item | Value |
|------|-------|
| **Host** | http://72.60.222.81 |
| **SSH** | `ssh root@72.60.222.81` |

### Local development

| Service | URL |
|---------|-----|
| Automation dashboard | http://localhost:4000 |
| Upwork bridge (fetch) | http://127.0.0.1:9877 |
| Chrome CDP | http://127.0.0.1:9222 |

---

## Folder Structure

```
C:\n8n\
├── automation/          # Local job bot: AI, cron, dashboard, email
├── upwork-bridge/       # Chrome fetch service (Cloudflare bypass)
├── live-server/         # VPS: SQLite DB + live job browser UI
├── data/                # Runtime data (cookies, jobs JSON, evidence) — gitignored in parts
├── chrome-profile/      # Dedicated Chrome user profile for Upwork
├── *.bat                # Windows startup scripts
├── *.py                 # Cookie / fetch helper scripts (optional)
├── README.md            # Quick start
├── SETUP.md             # Local bridge + n8n notes
├── SETUP-SPLIT.md       # Local automation + live DB architecture
└── codebase documentation.md   # This file
```

---

## Folder & File Reference

### Root (`C:\n8n\`)

| File | Purpose |
|------|---------|
| `package.json` | Root npm scripts (`upwork:fetch`, `upwork:test`) |
| `.env.example` | Example env vars for automation (copy to `automation/.env`) |
| `README.md` | Short overview and `start_all.bat` |
| `SETUP.md` | Bridge URLs, Cloudflare refresh, Chrome profile |
| `SETUP-SPLIT.md` | Local vs live split architecture |
| `start_all.bat` | Starts bridge + automation dashboard (main local entry) |
| `start_upwork_fetch.bat` | Bridge only |
| `start_chrome_debug.bat` | Chrome with CDP on 9222 (real profile option) |
| `start_live.bat` | Local live-server for testing |
| `start.bat` | Legacy n8n launcher |
| `upwork_fetch_service.py` | Python alternative fetch service |
| `refresh_upwork_cookies.py` | Refresh cookies via CDP |
| `update_upwork_cookies.py` | Update cookie files |
| `paste_cookie_header.py` | Paste cookie header helper |
| `test_fetch_service.py` | Test fetch service |
| `test_upwork_cf_clearance.py` | Test Cloudflare clearance |

### `automation/` — Local automation (runs on your PC)

| File | Purpose |
|------|---------|
| `dashboard.js` | Express server on port 4000: dashboard UI, SSE, cron, API routes |
| `core.js` | Main logic: fetch jobs via bridge, parse HTML, OpenAI analysis, email, run cycle |
| `index.js` | Headless CLI runner (no dashboard) |
| `db.js` | DB router: uses `db-remote.js` if `REMOTE_DB_URL` set, else `db-local.js` |
| `db-local.js` | JSON file storage at `data/jobs_db.json` |
| `db-remote.js` | HTTP client to live server API (`POST/GET /api/jobs`) |
| `milestone-utils.js` | Shared milestone schema, pricing prompts, job budget parsing |
| `settings.json` | Persisted dashboard settings (cron, keywords, email mode, etc.) |
| `public/index.html` | Local dashboard UI (job cards, settings drawer, live DB banner) |
| `.env.example` | Required env vars template |
| `.env` | **Secrets** — OpenAI, Gmail OAuth, `REMOTE_DB_URL`, `REMOTE_DB_API_KEY` (not committed) |

#### `automation/scripts/`

| File | Purpose |
|------|---------|
| `migrate-to-live.js` | One-time / bulk sync local JSON jobs → live SQLite |
| `backfill-milestones.js` | AI backfill milestones and/or milestone prices (`prices` or `full` mode) |

### `upwork-bridge/` — Chrome fetch service (local only)

| File | Purpose |
|------|---------|
| `server.js` | Express on port 9877: `/fetch/jobs`, `/fetch?url=`, `/refresh`, `/health` |
| `chrome.js` | Launch Chrome via CDP, Puppeteer fetch, Cloudflare wait, stealth (Linux only) |
| `config.js` | Ports, Chrome paths, profile dir, jobs URL, cookie paths |
| `cookies.js` | Save/load cookies to `data/upwork_cookies.json` |
| `inject-cookies.js` | Inject cookies into Chrome session |
| `test.js` | Bridge smoke test |

**Key endpoints (bridge):**

| Method | Path | Description |
|--------|------|-------------|
| GET | `/fetch/jobs` | Fetch configured Upwork jobs search HTML |
| GET | `/fetch?url=` | Fetch any Upwork URL |
| POST | `/refresh` | Refresh Cloudflare clearance |
| GET | `/health` | CDP alive check |

### `live-server/` — VPS live database + UI

| File | Purpose |
|------|---------|
| `server.js` | Express on port 3340: REST API + static UI + evidence uploads |
| `db.js` | SQLite (better-sqlite3): jobs table, upsert, filters, milestone merge |
| `public/index.html` | **Live job browser UI** — filters, sort, trust, milestones, mark sent |
| `.env.example` | `LIVE_PORT`, `LIVE_API_KEY`, optional DB paths |
| `.env` | **On server only** — API key for local sync writes |
| `scripts/deploy-on-server.sh` | Server-side deploy script (git pull, npm, PM2) |

**Key endpoints (live server):**

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/jobs` | No | List jobs (sort, minScore, limit, sent filter) |
| GET | `/api/jobs/:jobUid` | No | Single job |
| GET | `/api/stats` | No | Counts (total, relevant, sent) |
| GET | `/health` | No | Service health + stats |
| POST | `/api/jobs` | API key | Upsert job from local automation |
| POST | `/api/jobs/:uid/proposal-sent` | No | Mark proposal sent + evidence upload |
| POST | `/api/jobs/:uid/notes` | No | Update notes |
| POST | `/api/jobs/:uid/milestones` | API key | Set milestones |
| POST | `/api/jobs/:uid/milestones/prices` | API key | Merge milestone pricing only |
| DELETE | `/api/jobs/all` | No | Clear all jobs (admin) |

### `data/` — Runtime data (local)

| Path | Purpose |
|------|---------|
| `data/jobs_db.json` | Local job store when not using remote DB |
| `data/upwork_cookies.json` | Saved Upwork cookies from Chrome |
| `data/upwork_cookies.txt` | Cookie export (Netscape format) |
| `data/seen_jobs.json` | Job UIDs already processed in a cycle |
| `data/evidence/` | Proposal evidence screenshots (local dashboard) |

### `chrome-profile/`

Dedicated Chrome user data directory for automation. Log into Upwork once here. **Do not commit** session-sensitive files (gitignored where possible).

---

## Environment Variables

### Local — `automation/.env`

```env
OPENAI_API_KEY=sk-...
EMAIL_FROM=your@gmail.com
EMAIL_TO=your@gmail.com
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REFRESH_TOKEN=...

BRIDGE_URL=http://127.0.0.1:9877
REMOTE_DB_URL=http://72.60.223.25:3340
REMOTE_DB_API_KEY=<same as LIVE_API_KEY on server>

DASHBOARD_PORT=4000
```

### Live server — `live-server/.env` (on VPS)

```env
LIVE_PORT=3340
LIVE_API_KEY=<long random hex string>

# Optional:
# LIVE_DB_PATH=/var/www/upwork-automation/live-server/data/jobs.db
# LIVE_EVIDENCE_DIR=/var/www/upwork-automation/live-server/data/evidence
```

---

## Deployment Guide

### What runs where

| Component | Where | Deploy? |
|-----------|-------|---------|
| `upwork-bridge` | Local PC only | No — Cloudflare requires local Chrome |
| `automation` | Local PC only | No |
| `live-server` | VPS port 3340 | **Yes** |

Other PM2 apps on the same VPS (clearearth-api, astrology-api, lunchboxai-api, etc.) must **not** be restarted when deploying Upwork — only restart `upwork-live`.

---

### Step 1 — Push from your PC

```bash
cd C:\n8n
git add -A
git commit -m "Your message"
git push origin main
```

---

### Step 2 — Deploy live server on primary VPS

**Option A — SSH one-liner (from Git Bash / WSL / PC with SSH key):**

```bash
ssh root@72.60.223.25 "cd /var/www/upwork-automation && git pull origin main && cd live-server && npm ci && pm2 restart upwork-live --update-env && pm2 save"
```

**Option B — SSH in and run deploy script:**

```bash
ssh root@72.60.223.25
bash /var/www/upwork-automation/live-server/scripts/deploy-on-server.sh
```

**Option C — First-time server setup:**

```bash
ssh root@72.60.223.25
git clone https://github.com/abdulkarimtaji33/upwork-automation.git /var/www/upwork-automation
cd /var/www/upwork-automation/live-server
cp .env.example .env
# Edit .env — set LIVE_API_KEY (openssl rand -hex 24)
npm ci
pm2 start server.js --name upwork-live --cwd /var/www/upwork-automation/live-server
pm2 save
ufw allow 3340/tcp
```

Copy `LIVE_API_KEY` from server `.env` into local `automation/.env` as `REMOTE_DB_API_KEY`.

---

### Step 3 — Verify deploy

```bash
ssh root@72.60.223.25
pm2 show upwork-live
pm2 logs upwork-live --lines 20
curl -s http://127.0.0.1:3340/health
```

Open in browser: http://72.60.223.25:3340

---

### Step 4 — Sync local jobs to live (when needed)

```bash
cd C:\n8n\automation
node scripts/migrate-to-live.js
```

Skip milestone backfill if already done:

```bash
set SKIP_BACKFILL=1
node scripts/migrate-to-live.js
```

Backfill milestone prices only:

```bash
node scripts/backfill-milestones.js prices
```

---

## Local Development — Quick Start

```bat
REM 1. Install dependencies
cd C:\n8n\upwork-bridge && npm install
cd C:\n8n\automation && npm install

REM 2. Configure automation/.env (see above)

REM 3. Start everything
C:\n8n\start_all.bat
```

| URL | Use |
|-----|-----|
| http://localhost:4000 | Run cycles, settings, view jobs locally |
| http://127.0.0.1:9877/health | Check bridge / Chrome |
| http://72.60.223.25:3340 | Live UI — filter jobs, mark proposals sent |

---

## Data Flow

1. **Cron** in `dashboard.js` triggers `runCycle()` in `core.js`.
2. **Bridge** fetches Upwork job list + detail pages via Chrome (`chrome.js`).
3. **core.js** parses HTML, calls **OpenAI** for relevance score, proposal draft, milestones with pricing.
4. Relevant jobs are saved via **db.js** → **db-remote.js** → `POST /api/jobs` on live server.
5. **live-server/db.js** upserts into SQLite; existing proposal-sent status and milestones are preserved on conflict.
6. Team uses **live UI** (`live-server/public/index.html`) to browse, filter, and mark proposals sent with optional evidence.

---

## Security Notes

- Never commit `.env` files with real API keys.
- `LIVE_API_KEY` protects write endpoints from unauthorized sync.
- Live UI read + proposal-sent endpoints are open in browser (by design for team access).
- Use HTTPS / reverse proxy in production if exposing publicly beyond trusted team.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Cloudflare loop on fetch | Use minimal Chrome flags (Windows); solve CF manually in automation Chrome window |
| Local jobs not on live | Check `REMOTE_DB_URL` and `REMOTE_DB_API_KEY` in `automation/.env` |
| Live UI stale after deploy | Hard refresh (Ctrl+F5); confirm `pm2 restart upwork-live` |
| Bridge down | Restart `start_upwork_fetch.bat` or `node upwork-bridge/server.js` |
| API 401 on sync | `LIVE_API_KEY` on server must match `REMOTE_DB_API_KEY` locally |

---

## Related Documentation

- [README.md](README.md) — Quick start
- [SETUP.md](SETUP.md) — Bridge and Cloudflare
- [SETUP-SPLIT.md](SETUP-SPLIT.md) — Local + live architecture

---

*Last updated: June 2026*
