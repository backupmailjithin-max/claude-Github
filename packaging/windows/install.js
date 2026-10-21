#!/usr/bin/env node
// DCIM installer for Windows - Node.js rewrite of install.ps1.
//
// Replaced PowerShell entirely: real execution on real hardware kept
// surfacing PowerShell-environment problems that had nothing to do with
// this script's own logic - a Win32-escaping-vs-PowerShell-script-syntax
// mismatch, MsgBox() hanging forever under /SILENT, robocopy refusing to
// /MIR a directory onto itself, and (the one that finally forced this
// rewrite) Windows PowerShell 5.1's module auto-loading throwing a
// "TerminatingError(Import-Module)" over duplicate ObjectSecurity type
// data, which then made the built-in Get-FileHash cmdlet itself report as
// "not recognized". None of that is CODE this project can fix - it is the
// hosting shell. Node.js is already a required bundled runtime dependency
// of this app regardless, so running the installer under the exact same
// node.exe removes an entire layer (and an entire class of bugs) rather
// than working around it script by script.
//
// Supports fresh install, upgrade, and repair. Registers the app as a
// Windows Service (via bundled NSSM) with auto-start on boot.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const net = require('net');
const { spawnSync, execFileSync } = require('child_process');

const SERVICE_NAME = 'DCIM';
const EMBEDDED_DB_SERVICE_NAME = 'DCIMMariaDB';
const MIN_NODE_MAJOR = 18;
const MIN_FREE_MB = 500;

let LOG_PATH = null;

function writeLog(line) {
  if (!LOG_PATH) return;
  try { fs.appendFileSync(LOG_PATH, line + '\n'); } catch { /* best effort */ }
}
function log(msg) { const l = `[dcim-install] ${msg}`; console.log(l); writeLog(l); }
function die(msg) {
  const l = `[dcim-install] ERROR: ${msg}`;
  console.error(l);
  writeLog(l);
  process.exit(1);
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function isElevated() {
  // The standard Windows trick: "net session" succeeds silently when
  // elevated and fails otherwise. No PowerShell involved.
  const res = spawnSync('net', ['session'], { stdio: 'ignore' });
  return res.status === 0;
}

function findOnPath(exe) {
  try {
    // stdio explicitly ignored on stdin/stderr: found via real execution -
    // where.exe's "INFO: Could not find files for the given pattern(s)."
    // leaked straight into the installer's own console even though nothing
    // here prints it, on a miss (the expected, harmless case whenever
    // mysql.exe/mysqldump.exe aren't on PATH). Looked like a real error.
    const out = execFileSync('where', [exe], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const first = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    return first || null;
  } catch { return null; }
}

function serviceExists(name) {
  const res = spawnSync('sc.exe', ['query', name], { stdio: 'ignore' });
  return res.status === 0;
}
function startService(name) {
  // sc.exe start only hands the request to the Service Control Manager and
  // returns - it does not block until the service is actually Running (the
  // way PowerShell's Start-Service does). Every caller of startService()
  // already polls afterward (Wait-ForHealth / the embedded-MariaDB ping
  // loop), so that polling absorbs the difference.
  const res = spawnSync('sc.exe', ['start', name], { stdio: 'pipe' });
  if (res.status !== 0) die(`Could not start service '${name}' (sc.exe exit ${res.status}): ${(res.stderr || res.stdout || '').toString().trim()}`);
}
function stopService(name) {
  spawnSync('sc.exe', ['stop', name], { stdio: 'ignore' });
}

// ---------- Argument parsing ----------

const STRING_OPTS = new Set(['Mode', 'InstallDir', 'DbHost', 'DbUser', 'DbPassword', 'DbName', 'CorsOrigin', 'AdminUser', 'AdminPassword', 'CspMode']);
const INT_OPTS = new Set(['Port', 'DbPort', 'EmbeddedDbPort', 'AuditRetentionDays']);
const SWITCH_OPTS = new Set(['EmbeddedDb', 'Yes']);

function defaultOpts() {
  return {
    Mode: null,
    InstallDir: 'C:\\DCIM',
    Port: 8974,
    DbHost: 'localhost',
    DbPort: 3306,
    DbUser: 'dcim',
    DbPassword: '',
    DbName: 'dcim',
    EmbeddedDb: false,
    EmbeddedDbPort: 3307,
    CorsOrigin: '',
    AdminUser: '',
    AdminPassword: '',
    CspMode: 'enforce',
    AuditRetentionDays: 365,
    Yes: false,
  };
}

function parseArgs(argv) {
  const opts = defaultOpts();
  const explicitParams = new Set();
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith('-')) continue;
    const name = tok.slice(1);
    if (SWITCH_OPTS.has(name)) { opts[name] = true; explicitParams.add(name); continue; }
    if (STRING_OPTS.has(name) || INT_OPTS.has(name)) {
      const value = argv[++i];
      opts[name] = INT_OPTS.has(name) ? parseInt(value, 10) : value;
      explicitParams.add(name);
    }
  }
  if (opts.Mode && !['install', 'upgrade', 'repair'].includes(opts.Mode)) die(`Invalid -Mode '${opts.Mode}'.`);
  if (!['enforce', 'report-only', 'off'].includes(opts.CspMode)) die(`Invalid -CspMode '${opts.CspMode}'.`);
  return { opts, explicitParams };
}

// ---------- Validation ----------

function resolveNodeBinary(paths) {
  if (fs.existsSync(path.join(paths.payloadRuntime, 'node.exe'))) {
    log('Using bundled Node.js runtime.');
    return path.join(paths.payloadRuntime, 'node.exe');
  }
  const sys = findOnPath('node.exe');
  if (sys) { log(`No bundled runtime found; using system Node.js at ${sys}`); return sys; }
  die(`No Node.js runtime found (bundled or system). Install Node.js ${MIN_NODE_MAJOR}+ or use the packaged installer that bundles it.`);
}

function testNodeVersion(nodeBin) {
  const ver = execFileSync(nodeBin, ['--version'], { encoding: 'utf8' }).trim();
  const major = parseInt(ver.replace(/^v/, '').split('.')[0], 10);
  if (major < MIN_NODE_MAJOR) die(`Node.js ${ver} found, but DCIM requires >= v${MIN_NODE_MAJOR}.`);
  log(`Node.js version check passed (${ver}).`);
}

function testDiskSpace(installDir) {
  const drive = path.parse(path.resolve(installDir)).root;
  try {
    const st = fs.statfsSync(drive);
    const freeMB = (st.bfree * st.bsize) / (1024 * 1024);
    if (freeMB < MIN_FREE_MB) die(`Only ${freeMB.toFixed(0)}MB free on ${drive}; at least ${MIN_FREE_MB}MB required.`);
    log(`Disk space check passed (${freeMB.toFixed(0)}MB available).`);
  } catch (e) {
    log(`Disk space check skipped (could not query free space: ${e.message}).`);
  }
}

function testPortAvailable(port, mode) {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        if (mode === 'install') die(`Port ${port} is already in use. Choose a different -Port or stop the conflicting process.`);
        log(`Port ${port} is in use (expected: the existing DCIM service).`);
      } else {
        log(`Port ${port} check skipped (${err.message}).`);
      }
      resolve();
    });
    tester.once('listening', () => { tester.close(() => { log(`Port ${port} check passed (available).`); resolve(); }); });
    tester.listen(port, '127.0.0.1');
  });
}

function testWritePermission(installDir) {
  const parent = path.dirname(path.resolve(installDir));
  // Only create it when it doesn't already exist: Windows' CreateDirectory
  // throws (EPERM) on a drive root like "C:\" even with recursive:true,
  // since there's nothing to actually create - unconditionally calling
  // mkdirSync here regressed this exact case (installDir "C:\DCIM" ->
  // parent "C:\", which obviously already exists).
  if (!fs.existsSync(parent)) {
    try { fs.mkdirSync(parent, { recursive: true }); } catch { die(`No write permission under ${parent}.`); }
  }
  const probe = path.join(parent, `.dcim-install-write-test-${crypto.randomUUID()}`);
  try { fs.writeFileSync(probe, 'x'); fs.rmSync(probe); } catch { die(`No write permission under ${parent}.`); }
  log(`Write permission check passed (${parent}).`);
}

async function invokeValidations(opts, paths) {
  log('Running pre-flight validation...');
  paths.resolvedNodeBin = resolveNodeBinary(paths);
  testNodeVersion(paths.resolvedNodeBin);
  testDiskSpace(opts.InstallDir);
  await testPortAvailable(opts.Port, opts.Mode);
  testWritePermission(opts.InstallDir);
  if (!fs.existsSync(paths.payloadNssm)) die(`nssm.exe not found at ${paths.payloadNssm} (required to register the Windows service). Run fetch-nssm.ps1 first.`);
  log('All validation checks passed.');
}

// ---------- Mode selection ----------

function testExistingInstall(installDir) {
  return fs.existsSync(path.join(installDir, 'webapp', '.env'));
}
function testRepairTargetPresent(installDir) {
  return fs.existsSync(path.join(installDir, 'webapp')) || serviceExists(SERVICE_NAME);
}

function promptSync(question) {
  process.stdout.write(question);
  const buf = Buffer.alloc(1024);
  const bytes = fs.readSync(0, buf, 0, 1024, null);
  return buf.toString('utf8', 0, bytes).trim();
}

function selectMode(opts) {
  if (opts.Mode) return opts.Mode;
  if (opts.Yes) return testExistingInstall(opts.InstallDir) ? 'upgrade' : 'install';
  console.log('');
  console.log('  DCIM Setup');
  console.log('  ----------');
  console.log('  1) Install DCIM');
  console.log('  2) Upgrade Existing DCIM');
  console.log('  3) Repair Existing DCIM');
  console.log('');
  if (testExistingInstall(opts.InstallDir)) log(`Existing installation detected at ${opts.InstallDir}.`);
  else log('No existing installation detected.');
  const choice = promptSync('Select an option [1-3]: ');
  if (choice === '1') return 'install';
  if (choice === '2') return 'upgrade';
  if (choice === '3') return 'repair';
  die('Invalid selection.');
}

// ---------- Actions ----------

function newRandomSecret() { return crypto.randomBytes(48).toString('hex'); }

function randomPassword(len) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += chars[bytes[i] % chars.length];
  return out;
}

function testDbConnection(opts) {
  const mysql = findOnPath('mysql.exe');
  if (!mysql) { log('mysql client not found on PATH; skipping live connection test (server will validate on first start).'); return; }
  const args = ['-h', opts.DbHost, '-P', String(opts.DbPort), '-u', opts.DbUser];
  if (opts.DbPassword) args.push(`-p${opts.DbPassword}`);
  args.push('-e', 'SELECT 1;');
  const res = spawnSync(mysql, args, { stdio: 'ignore' });
  if (res.status !== 0) die(`Could not connect to MySQL/MariaDB at ${opts.DbHost}:${opts.DbPort} as ${opts.DbUser}. Check the DB is running and credentials are correct.`);
  log(`Database connection test passed (${opts.DbHost}:${opts.DbPort} as ${opts.DbUser}).`);
}

function writeEnvFile(opts) {
  if (opts.AuditRetentionDays < 0) die('-AuditRetentionDays must be a non-negative whole number.');
  const secret = newRandomSecret();
  const envPath = path.join(opts.InstallDir, 'webapp', '.env');
  const content = [
    `PORT=${opts.Port}`,
    `DB_HOST=${opts.DbHost}`,
    `DB_PORT=${opts.DbPort}`,
    `DB_USER=${opts.DbUser}`,
    `DB_PASSWORD=${opts.DbPassword}`,
    `DB_NAME=${opts.DbName}`,
    `JWT_SECRET=${secret}`,
    `CORS_ORIGIN=${opts.CorsOrigin}`,
    `CSP_MODE=${opts.CspMode}`,
    `AUDIT_RETENTION_DAYS=${opts.AuditRetentionDays}`,
    'NODE_ENV=production',
    '',
  ].join('\n');
  fs.writeFileSync(envPath, content, { encoding: 'ascii' });
  log(`Wrote ${envPath} with a freshly generated JWT secret.`);
}

// True recursive mirror (src -> dest): copies everything from src into
// dest, and deletes anything in dest that isn't in src, except names in
// excludeTopNames (checked only at the top level of this call, matching
// robocopy's /XD and /XF usage here - these only ever apply at the top of
// the webapp folder).
function mirrorTree(src, dest, excludeTopNames) {
  fs.mkdirSync(dest, { recursive: true });
  const exclude = excludeTopNames || new Set();
  const srcNames = new Set(fs.existsSync(src) ? fs.readdirSync(src) : []);
  const destNames = fs.existsSync(dest) ? fs.readdirSync(dest) : [];

  for (const name of srcNames) {
    if (exclude.has(name)) continue;
    const s = path.join(src, name);
    const d = path.join(dest, name);
    const st = fs.statSync(s);
    if (st.isDirectory()) {
      fs.rmSync(d, { recursive: true, force: true });
      fs.cpSync(s, d, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(d), { recursive: true });
      fs.copyFileSync(s, d);
    }
  }
  for (const name of destNames) {
    if (exclude.has(name)) continue;
    if (!srcNames.has(name)) fs.rmSync(path.join(dest, name), { recursive: true, force: true });
  }
}

function syncPayload(opts, paths) {
  log(`Syncing application files to ${opts.InstallDir}\\webapp ...`);
  fs.mkdirSync(opts.InstallDir, { recursive: true });
  const dest = path.join(opts.InstallDir, 'webapp');
  fs.mkdirSync(dest, { recursive: true });
  // When install.js runs from inside the install directory itself - which
  // is how every real customer runs it, since Inno Setup places install.js
  // at {app} alongside the webapp payload it already deployed via [Files] -
  // the payload source and dest resolve to the literal same folder. Skip
  // the copy entirely in that case: the files are already exactly where
  // they need to be (this is the same self-copy case install.ps1's final
  // version had to guard against with robocopy).
  const srcFull = fs.realpathSync(paths.payloadWebapp).toLowerCase();
  const destFull = fs.realpathSync(dest).toLowerCase();
  if (srcFull === destFull) {
    log(`Application payload is already staged directly at ${dest}; nothing to copy.`);
  } else {
    mirrorTree(paths.payloadWebapp, dest, new Set(['uploads', 'backups', 'logs', '.env', 'license.lic', '.trial-state']));
  }
  for (const d of ['uploads', 'backups', 'logs']) {
    fs.mkdirSync(path.join(dest, d), { recursive: true });
  }
  if (fs.existsSync(paths.payloadRuntime)) {
    const rtDest = path.join(opts.InstallDir, 'runtime', 'node');
    fs.mkdirSync(rtDest, { recursive: true });
    const rtSrcFull = fs.realpathSync(paths.payloadRuntime).toLowerCase();
    const rtDestFull = fs.realpathSync(rtDest).toLowerCase();
    if (rtSrcFull === rtDestFull) {
      log(`Node.js runtime is already staged directly at ${rtDest}; nothing to copy.`);
    } else {
      mirrorTree(paths.payloadRuntime, rtDest, new Set());
    }
  }
}

function fileHash(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function ensureNssmBinary(opts, payloadNssm) {
  // Setup-EmbeddedDb and Install-WindowsService each register their own
  // NSSM service, and both need nssm.exe staged under $InstallDir\tools. If
  // embedded-DB mode runs first, its nssm.exe copy becomes the live process
  // image of the DCIMMariaDB service it just registered, so a second
  // unconditional copy from Install-WindowsService would fail with the file
  // in use - tolerate that specific case only when the staged copy is
  // already byte-identical to the payload.
  const nssm = path.join(opts.InstallDir, 'tools', 'nssm.exe');
  fs.mkdirSync(path.dirname(nssm), { recursive: true });
  if (fs.existsSync(nssm) && fileHash(payloadNssm) === fileHash(nssm)) return nssm;
  try {
    fs.copyFileSync(payloadNssm, nssm);
  } catch (e) {
    if (fs.existsSync(nssm) && fileHash(payloadNssm) === fileHash(nssm)) {
      log('nssm.exe already staged and in use by a just-registered service; reusing it.');
    } else {
      throw e;
    }
  }
  return nssm;
}

function invokeNssm(nssmPath, ...args) {
  const res = spawnSync(nssmPath, args, { encoding: 'utf8' });
  if (res.status !== 0) {
    // Found via real execution: a bare exit code alone ("exit 6") gave no
    // way to tell what actually went wrong without another round-trip -
    // nssm usually prints a human-readable reason to stdout/stderr.
    const detail = [res.stdout, res.stderr].filter(Boolean).join('\n').trim();
    die(`nssm ${args.join(' ')} failed (exit ${res.status})${detail ? `: ${detail}` : '.'}`);
  }
}

function setServiceDependency(serviceName, dependsOnServiceName) {
  // DependOnService is a standard Windows Service Control Manager concept
  // (the same registry value sc.exe and nssm both read/write) - not
  // something NSSM-specific, so there's no real reason to go through nssm
  // for it. Found via real execution: "nssm set DCIM DependOnService
  // DCIMMariaDB" failed with a bare "exit 6" on a real machine (during an
  // Upgrade, with DCIMMariaDB already running) while the exact same call
  // succeeded reliably in CI - switched to sc.exe, which we already use
  // for every other service operation here, to remove nssm from a code
  // path that was never really nssm's job to begin with.
  const res = spawnSync('sc.exe', ['config', serviceName, 'depend=', dependsOnServiceName], { encoding: 'utf8' });
  if (res.status !== 0) {
    const detail = [res.stdout, res.stderr].filter(Boolean).join('\n').trim();
    die(`sc config ${serviceName} depend= ${dependsOnServiceName} failed (exit ${res.status})${detail ? `: ${detail}` : '.'}`);
  }
}

async function waitForEmbeddedDb(engineDir, port) {
  log('Waiting for embedded MariaDB to become available...');
  const mysqladminExe = path.join(engineDir, 'bin', 'mysqladmin.exe');
  // 90s, not 30s: a first-ever start right after mariadb-install-db.exe has
  // to initialize the data directory, and on real hardware (antivirus
  // scanning every new file, a slower disk than a CI runner) that can take
  // well over 30s even though the service does come up fine.
  for (let i = 0; i < 90; i++) {
    const res = spawnSync(mysqladminExe, ['-h', '127.0.0.1', '-P', String(port), '-u', 'root', 'ping'], { stdio: 'ignore' });
    if (res.status === 0) return true;
    await sleep(1000);
  }
  return false;
}

async function setupEmbeddedDb(opts, paths) {
  // "root" is reserved for the embedded engine's own admin account, which
  // this function re-passwords for its own maintenance bookkeeping
  // (ALTER USER 'root'@'localhost', saved to .root-password) - found via
  // real execution: when -DbUser is also "root", a TCP connection to
  // 127.0.0.1 gets authenticated by MariaDB against 'root'@'localhost'
  // instead of 'root'@'127.0.0.1' (reverse-hostname resolution of the
  // loopback address matches 'localhost'), so the app ends up using the
  // maintenance account's password, not its own, and every DB connection
  // fails with Access Denied no matter how carefully the two accounts'
  // passwords are set. Rejecting it outright avoids relying on MariaDB's
  // own host-matching precedence working out in our favor.
  if (opts.DbUser.toLowerCase() === 'root') {
    die('-DbUser cannot be "root" for the embedded database - that name is reserved for the engine\'s own admin account. Choose a different username.');
  }
  const mariadbdExe = path.join(paths.payloadMariadb, 'bin', 'mariadbd.exe');
  if (!fs.existsSync(mariadbdExe)) die('-EmbeddedDb requires a bundled MariaDB runtime (run fetch-mariadb-runtime.ps1 at package-build time).');
  const dbDir = path.join(opts.InstallDir, 'mariadb');
  const engineDir = path.join(dbDir, 'engine');
  const dataDir = path.join(dbDir, 'data');
  const marker = path.join(dbDir, '.initialized');

  if (fs.existsSync(engineDir)) fs.rmSync(engineDir, { recursive: true, force: true });
  fs.mkdirSync(engineDir, { recursive: true });
  mirrorTree(paths.payloadMariadb, engineDir, new Set());

  let firstInit = false;
  if (!fs.existsSync(dataDir)) {
    firstInit = true;
    fs.mkdirSync(dataDir, { recursive: true });
    log('Initializing embedded MariaDB data directory...');
    let installDbExe = path.join(engineDir, 'bin', 'mariadb-install-db.exe');
    if (!fs.existsSync(installDbExe)) installDbExe = path.join(engineDir, 'bin', 'mysql_install_db.exe');
    if (!fs.existsSync(installDbExe)) die('Could not find mariadb-install-db.exe in the bundled MariaDB runtime.');
    // The Windows mariadb-install-db.exe (11.4.4) rejects
    // --auth-root-authentication-method outright; its Windows default
    // already creates root with no password, which is the same end state.
    const res = spawnSync(installDbExe, [`--datadir=${dataDir}`], { encoding: 'utf8' });
    if (res.status !== 0) die(`mariadb-install-db.exe failed (exit ${res.status}).`);
  }

  const nssm = ensureNssmBinary(opts, paths.payloadNssm);
  if (serviceExists(EMBEDDED_DB_SERVICE_NAME)) {
    spawnSync(nssm, ['stop', EMBEDDED_DB_SERVICE_NAME]);
    spawnSync(nssm, ['remove', EMBEDDED_DB_SERVICE_NAME, 'confirm']);
  }
  invokeNssm(nssm, 'install', EMBEDDED_DB_SERVICE_NAME, mariadbdExe, `--datadir="${dataDir}" --port=${opts.EmbeddedDbPort} --bind-address=127.0.0.1`);
  invokeNssm(nssm, 'set', EMBEDDED_DB_SERVICE_NAME, 'Start', 'SERVICE_AUTO_START');
  invokeNssm(nssm, 'set', EMBEDDED_DB_SERVICE_NAME, 'AppExit', 'Default', 'Restart');
  startService(EMBEDDED_DB_SERVICE_NAME);

  const up = await waitForEmbeddedDb(engineDir, opts.EmbeddedDbPort);
  if (!up) die(`Embedded MariaDB did not start within 90s. Check: sc query ${EMBEDDED_DB_SERVICE_NAME}`);

  const mysqlExe = path.join(engineDir, 'bin', 'mysql.exe');
  if (firstInit) {
    // Respect a password the installer's wizard (or -DbPassword directly)
    // actually supplied for the embedded DB's app user - only generate one
    // when the caller left it blank.
    opts.DbPassword = opts.DbPassword || randomPassword(32);
    const rootPw = randomPassword(32);
    // SQL-escape anything that can come from the wizard (DbName/DbUser/
    // DbPassword): an unescaped apostrophe would otherwise close the SQL
    // string literal early and fail with a syntax error that gives a
    // non-technical admin no clue what went wrong.
    const esc = (s) => String(s).replace(/'/g, "''");
    const sql = `ALTER USER 'root'@'localhost' IDENTIFIED BY '${esc(rootPw)}';\n` +
      `CREATE DATABASE IF NOT EXISTS \`${esc(opts.DbName)}\` CHARACTER SET utf8mb4;\n` +
      `CREATE USER IF NOT EXISTS '${esc(opts.DbUser)}'@'127.0.0.1' IDENTIFIED BY '${esc(opts.DbPassword)}';\n` +
      // CREATE USER IF NOT EXISTS is a no-op when the account already
      // exists - which it reliably does for a name like "root"
      // (mariadb-install-db's own bootstrap pre-creates 'root'@'127.0.0.1'
      // with no password on Windows), silently leaving that account's REAL
      // password unrelated to the one just generated and written to .env.
      // The app then fails every DB connection with Access Denied, and
      // since server.js waits on a working DB connection before it starts
      // listening, the whole site comes back ERR_CONNECTION_REFUSED with no
      // error visible anywhere install.js itself prints - found via a real
      // install that chose "root" as the embedded DB username. Force the
      // password unconditionally so .env is always correct, whether the
      // account is brand new or pre-existing.
      `ALTER USER '${esc(opts.DbUser)}'@'127.0.0.1' IDENTIFIED BY '${esc(opts.DbPassword)}';\n` +
      `GRANT ALL PRIVILEGES ON \`${esc(opts.DbName)}\`.* TO '${esc(opts.DbUser)}'@'127.0.0.1';\n` +
      'FLUSH PRIVILEGES;\n';
    const res = spawnSync(mysqlExe, ['-h', '127.0.0.1', '-P', String(opts.EmbeddedDbPort), '-u', 'root'], { input: sql, encoding: 'utf8' });
    if (res.status !== 0) die(`Could not create the embedded database/user (mysql exited ${res.status}).`);
    fs.writeFileSync(path.join(dbDir, '.root-password'), rootPw);
    fs.writeFileSync(marker, '');
    log(`Embedded MariaDB initialized: database '${opts.DbName}', user '${opts.DbUser}'. Root password saved to ${dbDir}\\.root-password (needed only for advanced maintenance).`);
  } else {
    // Repair / re-run: reuse the existing DB_PASSWORD from .env rather than
    // generating a new one, since generating one here without also
    // updating MariaDB's own stored password would just lock the app out.
    const envPath = path.join(opts.InstallDir, 'webapp', '.env');
    if (fs.existsSync(envPath)) {
      const m = fs.readFileSync(envPath, 'utf8').match(/^DB_PASSWORD=(.*)$/m);
      if (m) opts.DbPassword = m[1];
    }
    if (!opts.DbPassword) die(`Embedded MariaDB data already exists but no existing DB_PASSWORD was found in .env to reuse. Restore it from backup, or remove ${dbDir} to reinitialize (data loss).`);
    log('Embedded MariaDB already initialized; reusing the existing database and credentials.');
  }
  opts.DbHost = '127.0.0.1';
  opts.DbPort = opts.EmbeddedDbPort;
}

function installWindowsService(opts, paths) {
  const nodeBin = fs.existsSync(path.join(opts.InstallDir, 'runtime', 'node', 'node.exe'))
    ? path.join(opts.InstallDir, 'runtime', 'node', 'node.exe')
    : paths.resolvedNodeBin;
  const appDir = path.join(opts.InstallDir, 'webapp');
  const nssm = ensureNssmBinary(opts, paths.payloadNssm);

  if (serviceExists(SERVICE_NAME)) {
    spawnSync(nssm, ['stop', SERVICE_NAME]);
    spawnSync(nssm, ['remove', SERVICE_NAME, 'confirm']);
  }
  invokeNssm(nssm, 'install', SERVICE_NAME, nodeBin, 'server.js');
  invokeNssm(nssm, 'set', SERVICE_NAME, 'AppDirectory', appDir);
  invokeNssm(nssm, 'set', SERVICE_NAME, 'AppStdout', path.join(appDir, 'logs', 'service-stdout.log'));
  invokeNssm(nssm, 'set', SERVICE_NAME, 'AppStderr', path.join(appDir, 'logs', 'service-stderr.log'));
  invokeNssm(nssm, 'set', SERVICE_NAME, 'AppRotateFiles', '1');
  invokeNssm(nssm, 'set', SERVICE_NAME, 'Start', 'SERVICE_AUTO_START');
  invokeNssm(nssm, 'set', SERVICE_NAME, 'AppExit', 'Default', 'Restart');
  // If an embedded MariaDB instance is in use, tell the Windows Service
  // Control Manager to start it before DCIM.
  if (fs.existsSync(path.join(opts.InstallDir, 'mariadb', 'data'))) {
    setServiceDependency(SERVICE_NAME, EMBEDDED_DB_SERVICE_NAME);
  }
  startService(SERVICE_NAME);
  log(`Installed Windows service '${SERVICE_NAME}' (auto-start on boot).`);
}

function syncPortsFromEnv(opts, explicitParams) {
  // On Upgrade/Repair, the caller frequently doesn't know or re-pass
  // -Port/-EmbeddedDbPort (the Start Menu Upgrade/Repair utilities never
  // do). Re-derive both from the real .env when the caller didn't
  // explicitly override them, so health checks and the embedded DB's
  // service registration use the port actually in use, not the default.
  const envPath = path.join(opts.InstallDir, 'webapp', '.env');
  if (!fs.existsSync(envPath)) return;
  const envText = fs.readFileSync(envPath, 'utf8');
  if (!explicitParams.has('Port')) {
    const m = envText.match(/^PORT=(.+)$/m);
    if (m) opts.Port = parseInt(m[1], 10);
  }
  if (!explicitParams.has('EmbeddedDbPort')) {
    const m = envText.match(/^DB_PORT=(.+)$/m);
    if (m) opts.EmbeddedDbPort = parseInt(m[1], 10);
  }
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function backupBeforeChange(opts) {
  const backupDir = path.join('C:\\ProgramData\\dcim-backups', timestamp());
  fs.mkdirSync(backupDir, { recursive: true });
  const envPath = path.join(opts.InstallDir, 'webapp', '.env');
  if (fs.existsSync(envPath)) fs.copyFileSync(envPath, path.join(backupDir, '.env'));

  const dump = findOnPath('mysqldump.exe');
  if (dump && fs.existsSync(envPath)) {
    const env = {};
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m) env[m[1]] = m[2];
    }
    const args = ['-h', env.DB_HOST, '-u', env.DB_USER];
    if (env.DB_PASSWORD) args.push(`-p${env.DB_PASSWORD}`);
    let gtidFlag = [];
    try {
      // MySQL 8 attempts to record GTID state (needing a FLUSH TABLES
      // privilege a least-privilege app DB user won't have) unless told
      // not to; MariaDB's mysqldump doesn't recognize this flag at all -
      // feature-detect instead of assuming either engine.
      const help = execFileSync(dump, ['--help'], { encoding: 'utf8' });
      if (help.includes('--set-gtid-purged')) gtidFlag = ['--set-gtid-purged=OFF'];
    } catch { /* ignore */ }
    args.push('--single-transaction', ...gtidFlag, '--routines', '--triggers', env.DB_NAME);
    const sqlPath = path.join(backupDir, 'database.sql');
    try {
      const res = spawnSync(dump, args, { maxBuffer: 1024 * 1024 * 1024 });
      if (res.status !== 0) {
        if (res.stderr) fs.writeFileSync(path.join(backupDir, 'mysqldump.err'), res.stderr);
        throw new Error(`mysqldump exited with code ${res.status} - see ${backupDir}\\mysqldump.err`);
      }
      fs.writeFileSync(sqlPath, res.stdout);
      log(`Database snapshot saved to ${sqlPath}`);
    } catch (e) {
      log(`WARNING: mysqldump failed (${e.message}); only config snapshot was taken. Consider running the app's own Backup/Restore before continuing.`);
    }
  } else {
    log("mysqldump.exe not found; only config snapshot was taken. Consider running the app's own Backup/Restore before continuing.");
  }
  fs.writeFileSync(path.join(opts.InstallDir, '.last-pre-change-backup'), backupDir);
  log(`Pre-change snapshot saved to ${backupDir}`);
}

async function fetchJson(url, init, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function waitForHealth(opts) {
  log('Waiting for the service to report healthy ...');
  for (let i = 0; i < 30; i++) {
    try {
      const resp = await fetchJson(`http://127.0.0.1:${opts.Port}/api/health`, {}, 2000);
      if (resp && resp.status === 'ok') { log(`Health check passed: http://127.0.0.1:${opts.Port}/api/health`); return; }
    } catch { /* retry */ }
    await sleep(1000);
  }
  console.warn(`[dcim-install] WARNING: Service did not report healthy within 30s. Check Windows Event Viewer / ${opts.InstallDir}\\webapp\\logs\\service-stderr.log`);
}

async function setAdminAccount(opts) {
  if (!opts.AdminUser && !opts.AdminPassword) return;
  let login;
  try {
    login = await fetchJson(`http://127.0.0.1:${opts.Port}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin' }),
    }, 10000);
  } catch {
    log('Skipping -AdminUser/-AdminPassword: the default admin/admin login no longer works (already customized on a previous run, or this is an Upgrade/Repair, not a fresh install).');
    return;
  }
  const body = {};
  if (opts.AdminUser) body.newUsername = opts.AdminUser;
  if (opts.AdminPassword) body.newPassword = opts.AdminPassword;
  try {
    await fetchJson(`http://127.0.0.1:${opts.Port}/api/setup/admin-account`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login.token}` }, body: JSON.stringify(body),
    }, 10000);
    log('Admin account customized (username/password applied as requested).');
  } catch {
    console.warn('[dcim-install] WARNING: Could not apply -AdminUser/-AdminPassword; the seeded admin/admin account is still in place. Re-run with -Mode repair or sign in and change it via the Setup Wizard.');
  }
}

async function showHealthValidation(opts) {
  const loginUser = opts.AdminUser || 'admin';
  const loginPass = opts.AdminPassword || 'admin';
  let login;
  try {
    login = await fetchJson(`http://127.0.0.1:${opts.Port}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: loginUser, password: loginPass }),
    }, 10000);
  } catch {
    log(`Health validation skipped (could not sign in as '${loginUser}' - expected if the admin password was already changed). View it at: http://127.0.0.1:${opts.Port}/api/health/validate (after signing in via the dashboard).`);
    return;
  }
  let report;
  try {
    report = await fetchJson(`http://127.0.0.1:${opts.Port}/api/health/validate`, { headers: { Authorization: `Bearer ${login.token}` } }, 15000);
  } catch {
    log('Health validation: could not reach /api/health/validate.');
    return;
  }
  console.log('');
  console.log('  Health Validation');
  console.log('  -----------------');
  for (const c of report.checks || []) {
    console.log(`  ${String(c.status).padEnd(8)}${String(c.name).padEnd(18)}${c.detail}`);
  }
  console.log('');
  console.log(`  Overall: ${report.overall}`);
  console.log('');
}

function getLocalIPv4() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const n of nets[name] || []) {
      if (n.family === 'IPv4' && !n.internal) return n.address;
    }
  }
  return null;
}

function showSummary(opts) {
  const ip = getLocalIPv4() || '<this-server-ip>';
  const envPath = path.join(opts.InstallDir, 'webapp', '.env');
  if (fs.existsSync(envPath)) {
    const envText = fs.readFileSync(envPath, 'utf8');
    const get = (name) => { const m = envText.match(new RegExp(`^${name}=(.*)$`, 'm')); return m ? m[1] : null; };
    let v;
    if ((v = get('PORT'))) opts.Port = parseInt(v, 10);
    if ((v = get('DB_HOST'))) opts.DbHost = v;
    if ((v = get('DB_PORT'))) opts.DbPort = parseInt(v, 10);
    if ((v = get('DB_USER'))) opts.DbUser = v;
    if ((v = get('DB_NAME'))) opts.DbName = v;
    opts.DbPassword = get('DB_PASSWORD');
    if ((v = get('CSP_MODE'))) opts.CspMode = v;
    if ((v = get('AUDIT_RETENTION_DAYS'))) opts.AuditRetentionDays = parseInt(v, 10);
  }
  const embeddedDb = opts.EmbeddedDb || fs.existsSync(path.join(opts.InstallDir, 'mariadb', 'data'));
  const dbDesc = embeddedDb ? 'Embedded (bundled private MariaDB)' : 'External MySQL/MariaDB';
  let adminUserShown, adminPassShown;
  if (opts.AdminUser || opts.AdminPassword) {
    adminUserShown = opts.AdminUser || 'admin';
    adminPassShown = '(the password you provided)';
  } else {
    adminUserShown = 'admin';
    adminPassShown = 'admin   <- you MUST change this on first sign-in';
  }
  const lines = [
    '',
    '======================================================================',
    ' DCIM Installation Summary - SAVE THIS INFORMATION',
    '======================================================================',
    ` Web UI (from this machine): http://localhost:${opts.Port}/`,
    ` Web UI (from the network):  http://${ip}:${opts.Port}/`,
    '',
    ' Administrator account:',
    `   Username: ${adminUserShown}`,
    `   Password: ${adminPassShown}`,
    '',
    ` Database (${dbDesc}):`,
    `   Host:Port: ${opts.DbHost}:${opts.DbPort}`,
    `   Database:  ${opts.DbName}`,
    `   DB user:   ${opts.DbUser}`,
  ];
  if (embeddedDb) lines.push(`   DB password: ${opts.DbPassword}   (auto-generated; also saved in ${envPath})`);
  lines.push('');
  lines.push(` Security: CSP mode=${opts.CspMode}, audit log retention=${opts.AuditRetentionDays}d (0=forever)`);
  lines.push('');
  lines.push(` Install directory: ${opts.InstallDir}`);
  lines.push(` Config file:        ${envPath}`);
  lines.push(` Service:            sc query ${SERVICE_NAME}`);
  lines.push('======================================================================');
  lines.push('');
  for (const l of lines) console.log(l);
  try {
    fs.writeFileSync(path.join(opts.InstallDir, 'INSTALL-SUMMARY.txt'), lines.join('\r\n'), 'utf8');
    log(`This summary was also saved to ${opts.InstallDir}\\INSTALL-SUMMARY.txt`);
  } catch { /* best effort */ }
}

function findLatestBackupEnv() {
  const base = 'C:\\ProgramData\\dcim-backups';
  if (!fs.existsSync(base)) return null;
  const dirs = fs.readdirSync(base)
    .map((d) => path.join(base, d))
    .filter((d) => fs.existsSync(path.join(d, '.env')));
  if (dirs.length === 0) return null;
  dirs.sort((a, b) => fs.statSync(path.join(b, '.env')).mtimeMs - fs.statSync(path.join(a, '.env')).mtimeMs);
  return path.join(dirs[0], '.env');
}

// ---------- Modes ----------

async function invokeInstall(opts, paths) {
  await invokeValidations(opts, paths);
  syncPayload(opts, paths);
  if (opts.EmbeddedDb) await setupEmbeddedDb(opts, paths);
  writeEnvFile(opts);
  testDbConnection(opts);
  installWindowsService(opts, paths);
  await waitForHealth(opts);
  await setAdminAccount(opts);
  await showHealthValidation(opts);
  log('DCIM installed.');
  showSummary(opts);
}

async function invokeUpgrade(opts, paths, explicitParams) {
  if (!testExistingInstall(opts.InstallDir)) die(`No existing installation found at ${opts.InstallDir}; use -Mode install instead.`);
  await invokeValidations(opts, paths);
  syncPortsFromEnv(opts, explicitParams);
  backupBeforeChange(opts);
  stopService(SERVICE_NAME);
  syncPayload(opts, paths);
  installWindowsService(opts, paths);
  await waitForHealth(opts);
  await showHealthValidation(opts);
  log('DCIM upgraded in place. Previous config snapshot kept under C:\\ProgramData\\dcim-backups\\.');
  showSummary(opts);
}

async function invokeRepair(opts, paths, explicitParams) {
  if (!testRepairTargetPresent(opts.InstallDir)) die(`No existing installation found at ${opts.InstallDir}; use -Mode install instead.`);
  await invokeValidations(opts, paths);
  backupBeforeChange(opts);
  const envPath = path.join(opts.InstallDir, 'webapp', '.env');
  if (!fs.existsSync(envPath)) {
    const latest = findLatestBackupEnv();
    if (latest) {
      log(`No .env found at ${envPath}; restoring the most recent one from backup: ${latest}`);
      fs.mkdirSync(path.dirname(envPath), { recursive: true });
      fs.copyFileSync(latest, envPath);
    } else {
      die(`No .env found at ${envPath} and no prior backup contains one; repair cannot recover the configuration. Restore it manually (e.g. from an external backup) or reinstall with -Mode install.`);
    }
  }
  syncPortsFromEnv(opts, explicitParams);
  stopService(SERVICE_NAME);
  syncPayload(opts, paths);
  if (fs.existsSync(path.join(opts.InstallDir, 'mariadb', 'data')) || opts.EmbeddedDb) await setupEmbeddedDb(opts, paths);
  installWindowsService(opts, paths);
  await waitForHealth(opts);
  await showHealthValidation(opts);
  log('DCIM repaired (files and service re-applied; your .env and data were preserved).');
  showSummary(opts);
}

// ---------- Entry point ----------

async function main() {
  const { opts, explicitParams } = parseArgs(process.argv.slice(2));

  fs.mkdirSync(opts.InstallDir, { recursive: true });
  LOG_PATH = path.join(opts.InstallDir, 'install.log');
  writeLog(`\n=== install.js started ${new Date().toISOString()} ===\nArgs: ${process.argv.slice(2).join(' ')}`);

  if (!isElevated()) {
    die('Administrator privileges are required. Right-click and choose "Run as administrator", or run from an elevated Command Prompt.');
  }

  const scriptDir = __dirname;
  let payloadWebapp = path.join(scriptDir, 'webapp');
  if (!fs.existsSync(payloadWebapp)) payloadWebapp = path.join(scriptDir, '..', '..', 'dcim', 'webapp');
  const paths = {
    payloadWebapp,
    payloadRuntime: path.join(scriptDir, 'runtime', 'node'),
    payloadNssm: path.join(scriptDir, 'tools', 'nssm.exe'),
    payloadMariadb: path.join(scriptDir, 'runtime', 'mariadb'),
  };

  opts.Mode = selectMode(opts);
  if (opts.Mode === 'install') await invokeInstall(opts, paths);
  else if (opts.Mode === 'upgrade') await invokeUpgrade(opts, paths, explicitParams);
  else if (opts.Mode === 'repair') await invokeRepair(opts, paths, explicitParams);
}

if (require.main === module) {
  main().catch((e) => {
    const l = `[dcim-install] ERROR: ${e && e.stack ? e.stack : e}`;
    console.error(l);
    writeLog(l);
    process.exit(1);
  });
}

module.exports = { parseArgs, mirrorTree, syncPortsFromEnv, writeEnvFile, showSummary };
