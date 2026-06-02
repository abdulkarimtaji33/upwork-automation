# Upwork automation — production deploy

Isolated from Clearearth (`:3333`), astrology, lunchboxai, and other PM2 apps. **Only** restarts `upwork-bridge` and `upwork-automation`.

## Server

| | |
|---|---|
| **SSH** | `ssh root@72.60.223.25` |
| **App path** | `/var/www/upwork-automation` |
| **Git** | `https://github.com/abdulkarimtaji33/upwork-automation.git` — branch `main` |
| **PM2** | `upwork-bridge` (port **9877**), `upwork-automation` (port **4000**) |
| **Dashboard URL** | `http://72.60.223.25:3340/` |
| **Bridge** | `http://127.0.0.1:9877` (localhost only — not public) |
| **Port 80 / 3333** | **Do not** use for this project |
| **Nginx** | `/etc/nginx/sites-available/upwork-automation` → proxy `:3340` → `:4000` |

## First-time server setup (once)

```bash
ssh root@72.60.223.25
mkdir -p /var/www/upwork-automation
cd /var/www
git clone https://github.com/abdulkarimtaji33/upwork-automation.git upwork-automation
cd upwork-automation
bash scripts/install-server-deps.sh
cp .env.example automation/.env
nano automation/.env   # fill OPENAI, Gmail OAuth, etc.
bash scripts/deploy-production.sh
```

Log into Upwork once in Chrome on the server (or copy `chrome-profile` from dev) so `cf_clearance` works.

## Deploy (after `git push`)

From your machine:

```bash
cd c:\n8n
git add -A && git commit -m "your message" && git push origin main
```

On the server:

```bash
ssh root@72.60.223.25
cd /var/www/upwork-automation
bash scripts/deploy-production.sh
```

Or from dev (Git Bash / WSL with SSH key):

```bash
cd c:/n8n
npm run deploy:vps
```

## Quick verify

```bash
pm2 show upwork-bridge
pm2 show upwork-automation
curl -s http://127.0.0.1:9877/health
curl -sI http://127.0.0.1:3340/ | head -5
```

## Notes

- `.env`, `data/`, `chrome-profile/` stay on the server only — never commit secrets.
- Other PM2 processes are untouched by `deploy-production.sh`.
- Requires Google Chrome on the VPS for Cloudflare (`install-server-deps.sh`).
