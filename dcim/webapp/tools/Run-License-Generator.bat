@echo off
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo =================================================
  echo   ERROR: Node.js was not found on this machine.
  echo   This tool needs Node.js installed to run.
  echo   Download it from https://nodejs.org and try again.
  echo =================================================
  echo.
  pause >nul
  exit /b 1
)

node "%~dp0license-generator-wizard.js"

echo.
echo =================================================
echo Press any key to close this window...
pause >nul
