#!/usr/bin/env node
// Restores application files, .env, and the database from a snapshot taken
// automatically by install.js before an Upgrade or Repair.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function log(msg) { console.log(`[dcim-rollback] ${msg}`); }
function die(msg) { console.error(`[dcim-rollback] ERROR: ${msg}`); process.exit(1); }

const args = process.argv.slice(2);
function getArg(name, def) {
  const i = args.indexOf(`-${name}`);
  return i === -1 ? def : args[i + 1];
}
const hasFlag = (name) => args.includes(`-${name}`);

const InstallDir = getArg('InstallDir', 'C:\\DCIM');
let SnapshotDir = getArg('SnapshotDir', null);
const Yes = hasFlag('Yes');
const SERVICE_NAME = 'DCIM';

function isElevated() {
  return spawnSync('net', ['session'], { stdio: 'ignore' }).status === 0;
}
if (!isElevated()) die('Administrator privileges are required.');

if (!SnapshotDir) {
  const marker = path.join(InstallDir, '.last-pre-change-backup');
  if (!fs.existsSync(marker)) die(`No -SnapshotDir given and no recorded last snapshot at ${marker}.`);
  SnapshotDir = fs.readFileSync(marker, 'utf8').trim();
  log(`Using most recent recorded snapshot: ${SnapshotDir}`);
}
if (!fs.existsSync(SnapshotDir)) die(`Snapshot directory not found: ${SnapshotDir}`);

if (!Yes) {
  process.stdout.write(`This will stop DCIM, restore .env from ${SnapshotDir}, and restore the database if a dump is present. Continue? [y/N] `);
  const buf = Buffer.alloc(16);
  const n = fs.readSync(0, buf, 0, 16, null);
  const answer = buf.toString('utf8', 0, n).trim().toLowerCase();
  if (answer !== 'y') die('Aborted.');
}

spawnSync('sc.exe', ['stop', SERVICE_NAME]);

const envPath = path.join(InstallDir, 'webapp', '.env');
const snapEnv = path.join(SnapshotDir, '.env');
if (fs.existsSync(snapEnv)) { fs.copyFileSync(snapEnv, envPath); log('Restored .env'); }

// Stored uncompressed (database.sql) - install.js's backupBeforeChange
// writes the raw mysqldump output directly rather than zipping it (no
// PowerShell Compress-Archive, and no extra dependency needed for one
// file); nothing else reads this snapshot format.
const sqlPath = path.join(SnapshotDir, 'database.sql');
if (fs.existsSync(sqlPath)) {
  const where = spawnSync('where', ['mysql.exe'], { encoding: 'utf8' });
  const mysqlExe = where.status === 0 ? where.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] : null;
  if (!mysqlExe) {
    log(`WARNING: mysql.exe not found; database was NOT restored. Import ${sqlPath} manually.`);
  } else {
    const envMap = {};
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m) envMap[m[1]] = m[2];
    }
    log(`Restoring database '${envMap.DB_NAME}' ...`);
    const dbArgs = ['-h', envMap.DB_HOST, '-u', envMap.DB_USER];
    if (envMap.DB_PASSWORD) dbArgs.push(`-p${envMap.DB_PASSWORD}`);
    dbArgs.push(envMap.DB_NAME);
    const sqlBytes = fs.readFileSync(sqlPath);
    const res = spawnSync(mysqlExe, dbArgs, { input: sqlBytes, maxBuffer: 1024 * 1024 * 1024 });
    if (res.status !== 0) die(`mysql restore exited with code ${res.status} - the database was NOT restored.`);
    log('Database restored.');
  }
} else {
  log('No database.sql in this snapshot; database was left as-is.');
}

spawnSync('sc.exe', ['start', SERVICE_NAME]);
log(`Rollback complete. Check: sc query ${SERVICE_NAME}`);
