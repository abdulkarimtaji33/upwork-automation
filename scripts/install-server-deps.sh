#!/usr/bin/env bash
# One-time on VPS (Ubuntu/Debian). Does not modify other nginx sites or PM2 apps.
set -euo pipefail

echo "Installing Google Chrome (for Cloudflare / cf_clearance)..."
if ! command -v google-chrome &>/dev/null; then
  apt-get update -qq
  apt-get install -y wget gnupg ca-certificates fonts-liberation
  wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg
  echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" \
    > /etc/apt/sources.list.d/google-chrome.list
  apt-get update -qq
  apt-get install -y google-chrome-stable
fi

mkdir -p /var/www/upwork-automation/data
mkdir -p /var/www/upwork-automation/chrome-profile
chown -R "${SUDO_USER:-root}:${SUDO_USER:-root}" /var/www/upwork-automation 2>/dev/null || true

if [[ ! -f /etc/nginx/sites-enabled/upwork-automation ]]; then
  cp /var/www/upwork-automation/scripts/nginx-upwork.conf /etc/nginx/sites-available/upwork-automation
  ln -sf /etc/nginx/sites-available/upwork-automation /etc/nginx/sites-enabled/upwork-automation
  nginx -t && systemctl reload nginx
  ufw allow 3340/tcp 2>/dev/null || true
  echo "Nginx site upwork-automation enabled on :3340"
fi

echo "Done. Deploy app code with scripts/deploy-production.sh"
