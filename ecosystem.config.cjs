/** PM2 — only Clearearth-adjacent Upwork processes; do not touch other apps. */
module.exports = {
  apps: [
    {
      name: 'upwork-bridge',
      cwd: './upwork-bridge',
      script: 'server.js',
      instances: 1,
      autorestart: true,
      max_memory_restart: '800M',
      env: {
        NODE_ENV: 'production',
        UPWORK_CDP_PORT: '9222',
        UPWORK_FETCH_PORT: '9877',
        UPWORK_CHROME_PROFILE: '/var/www/upwork-automation/chrome-profile',
        N8N_USER_FOLDER: '/var/www/upwork-automation/data',
      },
    },
    {
      name: 'upwork-automation',
      cwd: './automation',
      script: 'dashboard.js',
      instances: 1,
      autorestart: true,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        BRIDGE_URL: 'http://127.0.0.1:9877',
        DASHBOARD_PORT: '4000',
      },
    },
  ],
};
