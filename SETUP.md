# Upwork n8n automation

## Stack (Node.js)

| Component | Command |
|-----------|---------|
| Fetch service | `npm run upwork:fetch` or `start_upwork_fetch.bat` |
| n8n | `start.bat` or `start_all.bat` (both) |
| Test | `npm run upwork:test` |

Cookies auto-save to `C:\n8n\data\upwork_cookies.json` when Chrome passes Cloudflare.

## n8n workflow URLs

- Jobs: `http://127.0.0.1:9877/fetch/jobs`
- Details: `http://127.0.0.1:9877/fetch?url=...`

Do **not** paste cookies into n8n HTTP nodes — use the fetch service only.

## First-time Chrome profile

Log into Upwork once in the automation Chrome window (`C:\n8n\chrome-profile`).

## If Cloudflare blocks again

```powershell
curl -X POST http://127.0.0.1:9877/refresh
```

Or restart `start_upwork_fetch.bat`.

The service includes a watchdog that restarts Chrome if CDP disconnects.
