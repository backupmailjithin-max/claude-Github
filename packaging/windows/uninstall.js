#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
function getArg(name, def) {
  const i = args.indexOf(`-${name}`);
  return i === -1 ? def : args[i + 1];
}
const hasFlag = (name) => args.includes(`-${name}`);

const InstallDir = getArg('InstallDir', 'C:\\DCIM');
const PurgeData = hasFlag('PurgeData');
const SERVICE_NAME = 'DCIM';
const EMBEDDED_DB_SERVICE_NAME = 'DCIMMariaDB';

function log(msg) { console.log(`[dcim-uninstall] ${msg}`); }

function isElevated() {
  return spawnSync('net', ['session'], { stdio: 'ignore' }).status === 0;
}
if (!isElevated()) {
  console.error('[dcim-uninstall] ERROR: Administrator privileges are required.');
  process.exit(1);
}

function serviceExists(name) {
  return spawnSync('sc.exe', ['query', name], { stdio: 'ignore' }).status === 0;
}

function removeDcimService(name, nssmPath) {
  if (!serviceExists(name)) { log(`No '${name}' service found; nothing to remove.`); return; }
  if (fs.existsSync(nssmPath)) {
    spawnSync(nssmPath, ['stop', name]);
    spawnSync(nssmPath, ['remove', name, 'confirm']);
  } else {
    spawnSync('sc.exe', ['stop', name]);
    spawnSync('sc.exe', ['delete', name]);
  }
  log(`Service '${name}' stopped and removed.`);
}

const nssm = path.join(InstallDir, 'tools', 'nssm.exe');
removeDcimService(SERVICE_NAME, nssm);
// The embedded database (if -EmbeddedDb was used at install time) runs as
// its own separate service - must be stopped/removed too, or with
// -PurgeData it keeps its data files open (so the recursive delete below
// silently leaves them behind) and becomes an orphaned service pointing at
// deleted files.
removeDcimService(EMBEDDED_DB_SERVICE_NAME, nssm);

if (PurgeData) {
  log(`Removing ${InstallDir} (application files, uploads, backups, logs, .env, and the embedded database if one was used) ...`);
  try { fs.rmSync(InstallDir, { recursive: true, force: true }); } catch { /* best effort */ }
  log('Note: an EXTERNAL MySQL/MariaDB database (the -DbHost option, not the bundled one) is never touched by this uninstaller. Drop it manually if desired.');
} else {
  log(`Application files left in place at ${InstallDir} (use -PurgeData to remove them too).`);
}

log('Uninstall complete.');
