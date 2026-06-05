@echo off
echo Starting n8n...
echo Open http://localhost:5678 in your browser
echo.
set N8N_USER_FOLDER=C:\n8n\data
npx n8n start
pause
