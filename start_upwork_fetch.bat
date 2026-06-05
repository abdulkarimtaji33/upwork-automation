@echo off
title Upwork Fetch Service (Node.js)
cd /d c:\n8n\upwork-bridge
if not exist node_modules (
  echo Installing dependencies...
  call npm install
)
echo.
echo Upwork fetch service: http://127.0.0.1:9877/fetch/jobs
echo Keep this window open while n8n runs.
echo.
node server.js
pause
