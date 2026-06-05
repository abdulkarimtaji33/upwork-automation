# Upwork automation

Node.js stack: **upwork-bridge** (Chrome / Cloudflare) + **automation** (dashboard, AI, email).

| Local | URL |
|-------|-----|
| Dashboard | http://localhost:4000 |
| Bridge | http://127.0.0.1:9877 |

```bat
start_all.bat
```

See [SETUP.md](SETUP.md) for local setup.

**Local fetch + live database:** see [SETUP-SPLIT.md](SETUP-SPLIT.md) — automation runs on your PC; jobs sync to the VPS; mark proposals sent on the live UI only.
