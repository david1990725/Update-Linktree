@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Install Node.js and try again.
  pause
  exit /b 1
)
call npm install
if errorlevel 1 goto failed
call npx playwright install chromium
if errorlevel 1 goto failed
call npm run setup
if errorlevel 1 goto failed
pause
exit /b 0
:failed
echo Setup failed. See the messages above.
pause
exit /b 1
