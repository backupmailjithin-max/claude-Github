@echo off
REM One-time build step. Run this ONCE on any Windows machine that has
REM Node.js installed. It produces dcim-license-generator-v2.exe in this
REM same folder - a single, fully standalone file with no Node.js
REM dependency. Copy that one .exe anywhere (a USB drive, a laptop with
REM no internet, a customer site visit) and it will run with nothing else
REM installed - that is the file Run-License-Generator.bat looks for.
REM
REM You do NOT need to run this again unless license-generator-wizard.js
REM itself changes.

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo =================================================
  echo   ERROR: Node.js was not found on this machine.
  echo   Node.js is needed ONLY for this one-time build step.
  echo   Download it from https://nodejs.org, install it,
  echo   then run this file again.
  echo =================================================
  echo.
  pause >nul
  exit /b 1
)

echo Step 1/3: Preparing the executable blob...
node --experimental-sea-config sea-config.json
if errorlevel 1 goto :fail

echo Step 2/3: Copying the Node.js runtime...
node -e "require('fs').copyFileSync(process.execPath, 'dcim-license-generator-v2.exe')"
if errorlevel 1 goto :fail

echo Step 3/3: Injecting the license generator into the executable...
call npx --yes postject dcim-license-generator-v2.exe NODE_SEA_BLOB sea-prep.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 --overwrite
if errorlevel 1 goto :fail

del sea-prep.blob >nul 2>nul

echo.
echo =================================================
echo   BUILD COMPLETE
echo   dcim-license-generator-v2.exe is ready in this folder.
echo   Copy that single file anywhere - it needs nothing else
echo   installed to run, not even Node.js.
echo =================================================
echo.
pause >nul
exit /b 0

:fail
echo.
echo =================================================
echo   BUILD FAILED - see the error above.
echo =================================================
echo.
pause >nul
exit /b 1
