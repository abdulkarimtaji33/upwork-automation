#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="${REPO_DIR:-/var/www/upwork-automation}"
APP_DIR="${APP_DIR:-${REPO_DIR}/live-server}"
REPO_URL="${REPO_URL:-https://github.com/abdulkarimtaji33/upwork-automation.git}"
BRANCH="${BRANCH:-main}"
PM2_NAME="${PM2_NAME:-upwork-live}"
PORT="${LIVE_PORT:-3340}"

echo "==> Upwork live server deploy"
echo "    Repo: ${REPO_DIR}"
echo "    App:  ${APP_DIR}"

if [[ ! -d "${REPO_DIR}/.git" ]]; then
  git clone --depth 1 -b "${BRANCH}" "${REPO_URL}" "${REPO_DIR}"
else
  cd "${REPO_DIR}"
  git fetch origin "${BRANCH}"
  git reset --hard "origin/${BRANCH}"
fi

cd "${APP_DIR}"
npm ci 2>/dev/null || npm install

if [[ ! -f .env ]]; then
  KEY=$(openssl rand -hex 24)
  cat > .env <<EOF
LIVE_PORT=${PORT}
LIVE_API_KEY=${KEY}
EOF
  echo ""
  echo "Created .env — add to local automation/.env:"
  echo "  REMOTE_DB_URL=http://72.60.223.25:${PORT}"
  echo "  REMOTE_DB_API_KEY=${KEY}"
  echo ""
else
  echo "Using existing ${APP_DIR}/.env"
fi

mkdir -p data/evidence

if pm2 describe "${PM2_NAME}" >/dev/null 2>&1; then
  pm2 restart "${PM2_NAME}" --update-env
else
  pm2 start server.js --name "${PM2_NAME}" --cwd "${APP_DIR}"
fi

pm2 save

if command -v ufw >/dev/null 2>&1; then
  ufw allow "${PORT}/tcp" 2>/dev/null || true
fi

echo "==> Health check"
sleep 2
curl -sf "http://127.0.0.1:${PORT}/health" && echo "" || echo "Health check failed — check pm2 logs ${PM2_NAME}"
