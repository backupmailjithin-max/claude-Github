'use strict';
// Unit tests for the 10-day trial / auto-lock logic (lib/license.js). Run: npm test
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const license = require('../lib/license');

const DAY = 24 * 3600 * 1000;
function stores() {
  const kv = new Map();
  return { dbGet: async (k, d) => (kv.has(k) ? kv.get(k) : d), dbSet: async (k, v) => { kv.set(k, String(v)); }, kv };
}
function tmpFile() { return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dcim-trial-')), '.trial-state'); }
const quiet = { info() {}, warn() {} };
const realNow = Date.now;
test.afterEach(() => { Date.now = realNow; });

test('licensing is configured in this build', () => assert.ok(license.isLicensingConfigured()));

test('fresh install starts a 10-day trial with full access', async () => {
  const s = stores(); const f = tmpFile();
  const t = await license.initTrial({ filePath: f, dbGet: s.dbGet, dbSet: s.dbSet, log: quiet });
  assert.strictEqual(t.daysLeft, 10); assert.strictEqual(t.active, true);
  const st = license.getLicenseStatus(path.join(os.tmpdir(), 'no-such-license.lic'));
  assert.strictEqual(st.mode, 'trial'); assert.strictEqual(st.valid, true);
});

test('restart keeps the original start; deleting the file does not restart the clock', async () => {
  const s = stores(); const f = tmpFile();
  const a = await license.initTrial({ filePath: f, dbGet: s.dbGet, dbSet: s.dbSet, log: quiet });
  Date.now = () => realNow() + 3 * DAY;
  fs.rmSync(f);
  const b = await license.initTrial({ filePath: f, dbGet: s.dbGet, dbSet: s.dbSet, log: quiet });
  assert.strictEqual(b.startedAt, a.startedAt); assert.strictEqual(b.daysLeft, 7);
});

test('auto-locks on day 11 and a missing license stays locked', async () => {
  const s = stores(); const f = tmpFile();
  await license.initTrial({ filePath: f, dbGet: s.dbGet, dbSet: s.dbSet, log: quiet });
  Date.now = () => realNow() + 11 * DAY;
  const st = license.getLicenseStatus(path.join(os.tmpdir(), 'no-such-license.lic'));
  assert.strictEqual(st.mode, 'locked'); assert.strictEqual(st.valid, false);
  assert.match(st.reason, /trial ended/);
});

test('winding the clock back does not extend the trial', async () => {
  const s = stores(); const f = tmpFile();
  await license.initTrial({ filePath: f, dbGet: s.dbGet, dbSet: s.dbSet, log: quiet });
  Date.now = () => realNow() + 11 * DAY;
  assert.strictEqual(license.getLicenseStatus('/nonexistent.lic').mode, 'locked');
  Date.now = realNow;                       // clock set back to "today"
  assert.strictEqual(license.getLicenseStatus('/nonexistent.lic').mode, 'locked');
  // and after a restart (the high-water mark was saved)
  await new Promise((r) => setTimeout(r, 20));
  await license.initTrial({ filePath: f, dbGet: s.dbGet, dbSet: s.dbSet, log: quiet });
  assert.strictEqual(license.getLicenseStatus('/nonexistent.lic').mode, 'locked');
});

test('an edited or copied trial record counts as an ended trial', async () => {
  const s = stores(); const f = tmpFile();
  await license.initTrial({ filePath: f, dbGet: s.dbGet, dbSet: s.dbSet, log: quiet });
  fs.writeFileSync(f, JSON.stringify({ startedAt: realNow() + DAY, sig: 'deadbeef' }));
  const t = await license.initTrial({ filePath: f, dbGet: s.dbGet, dbSet: s.dbSet, log: quiet });
  assert.strictEqual(t.tampered, true); assert.strictEqual(license.getLicenseStatus('/nonexistent.lic').mode, 'locked');
});

test('a corrupt license file is not a valid license', () => {
  const f = tmpFile(); fs.writeFileSync(f, '{"not":"a license"}');
  assert.strictEqual(license.verifyLicenseFile(f).valid, false);
});
