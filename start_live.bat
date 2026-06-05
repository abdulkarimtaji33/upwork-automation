@echo off
echo Starting Live DB server (proposal tracking only)...
cd /d c:\n8n\live-server
if not exist node_modules npm install
start "Upwork Live" cmd /k "node server.js"
timeout /t 2 /nobreak >nul
echo.
echo  Live UI  ^>  http://localhost:3340
echo.
start "" "http://localhost:3340"
pause
