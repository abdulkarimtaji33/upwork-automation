@echo off
echo Starting Upwork Bridge (Chrome fetcher)...
start "Upwork Bridge" cmd /k "cd /d c:\n8n\upwork-bridge && node server.js"
timeout /t 5 /nobreak >nul

echo Starting Upwork Automation + Dashboard...
start "Upwork Dashboard" cmd /k "cd /d c:\n8n\automation && node dashboard.js"
timeout /t 3 /nobreak >nul

echo.
echo  Dashboard  ^>  http://localhost:4000
echo  Bridge     ^>  http://127.0.0.1:9877
echo.
start "" "http://localhost:4000"
pause
