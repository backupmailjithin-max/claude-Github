@echo off
cd /d "%~dp0"

if exist "dcim-license-generator-v2.exe" (
  REM Standalone build exists - no Node.js needed at all, runs anywhere.
  "%~dp0dcim-license-generator-v2.exe"
  goto :done
)

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo =================================================
  echo   ERROR: Node.js was not found on this machine,
  echo   and dcim-license-generator-v2.exe has not been
  echo   built yet.
  echo.
  echo   Either:
  echo     1. Install Node.js from https://nodejs.org, then
  echo        run Build-License-Generator-Exe.bat once to
  echo        create a standalone .exe you can carry to any
  echo        machine (no Node.js needed there), or
  echo     2. Install Node.js here and run this file again.
  echo =================================================
  echo.
  pause >nul
  exit /b 1
)

node "%~dp0license-generator-wizard.js"

:done
echo.
echo =================================================
echo Press any key to close this window...
pause >nul
