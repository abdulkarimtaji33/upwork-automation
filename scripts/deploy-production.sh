#!/usr/bin/env bash
# Deploy Upwork automation on VPS — only restarts upwork-bridge + upwork-automation.
set -euo pipefail

APP_ROOT="${APP_ROOT:-/var/www/upwork-automation}"
BRANCH="${BRANCH:-main}"
REPO="${REPO:-https://github.com/abdulkarimtaji33/upwork-automation.git}"

echo "==> Deploy Upwork automation @ ${APP_ROOT}"
cd "${APP_ROOT}"

if [[ -d .git ]]; then
  git pull origin "${BRANCH}"
else
  echo "Clone into ${APP_ROOT} first (see DEPLOY.md)"
  exit 1
fi

echo "==> upwork-bridge"
cd "${APP_ROOT}/upwork-bridge"
npm ci --omit=dev

echo "==> automation"
cd "${APP_ROOT}/automation"
npm ci --omit=dev

if [[ ! -f "${APP_ROOT}/automation/.env" ]]; then
  echo "ERROR: missing ${APP_ROOT}/automation/.env — copy from .env.example"
  exit 1
fi

mkdir -p "${APP_ROOT}/data" "${APP_ROOT}/data/evidence" "${APP_ROOT}/chrome-profile"

cd "${APP_ROOT}"
if pm2 describe upwork-bridge &>/dev/null; then
  pm2 restart upwork-bridge --update-env
  pm2 restart upwork-automation --update-env
else
  pm2 start ecosystem.config.cjs
  pm2 save
fi

pm2 list | grep -E 'upwork-bridge|upwork-automation' || true

if [[ -f /etc/nginx/sites-available/upwork-automation ]]; then
  cp "${APP_ROOT}/scripts/nginx-upwork.conf" /etc/nginx/sites-available/upwork-automation
  nginx -t && systemctl reload nginx
fi

sleep 3
curl -sf "http://127.0.0.1:9877/health" | head -c 200 || echo "WARN: bridge health failed"
echo ""
curl -sfI "http://127.0.0.1:3340/" | head -3 || curl -sfI "http://127.0.0.1:4000/" | head -3 || echo "WARN: dashboard check failed"
echo ""
echo "==> Deploy complete"
