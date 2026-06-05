@echo off
setlocal
echo.
echo Starting Chrome with remote debugging (port 9222).
echo Close all Chrome windows first, then press any key...
pause >nul

set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" (
  echo Chrome not found.
  pause
  exit /b 1
)

set "PROFILE=%LOCALAPPDATA%\Google\Chrome\User Data"
start "" "%CHROME%" --remote-debugging-port=9222 --remote-allow-origins=* --user-data-dir="%PROFILE%" --profile-directory=Default "https://www.upwork.com/nx/s/universal-search/jobs/"
echo.
echo Chrome started. Run: python c:\n8n\refresh_upwork_cookies.py
echo.
pause
