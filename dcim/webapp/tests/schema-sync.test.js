'use strict';
// schema.sql must describe the schema the application really creates (audit finding L3). This is a static check: every table
// created by CREATE TABLE in server.js / lib/*.js, and every column added by ALTER TABLE ... ADD COLUMN, has to be in schema.sql.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const schema = fs.readFileSync(path.join(root, 'schema.sql'), 'utf8');
const sources = [path.join(root, 'server.js'), ...fs.readdirSync(path.join(root, 'lib')).filter((f) => f.endsWith('.js')).map((f) => path.join(root, 'lib', f))]
  .map((f) => ({ f: path.basename(f), t: fs.readFileSync(f, 'utf8') }));

function schemaTables() {
  const out = {};
  const re = /CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n\) ENGINE/g; let m;
  while ((m = re.exec(schema))) out[m[1]] = m[2];
  return out;
}

test('schema.sql defines every table the application creates', () => {
  const have = schemaTables(); const missing = [];
  for (const { f, t } of sources) {
    const re = /CREATE TABLE IF NOT EXISTS\s+`?(\w+)`?\s*\(/g; let m;
    while ((m = re.exec(t))) if (!have[m[1]]) missing.push(`${m[1]} (${f})`);
  }
  assert.deepStrictEqual([...new Set(missing)], [], 'tables created by the application but absent from schema.sql');
});

test('schema.sql has every column the application adds with ALTER TABLE ... ADD COLUMN', () => {
  const have = schemaTables(); const missing = [];
  for (const { f, t } of sources) {
    const re = /ALTER TABLE\s+`?(\w+)`?\s+ADD COLUMN\s+`?(\w+)`?/gi; let m;
    while ((m = re.exec(t))) {
      const body = have[m[1]];
      if (body === undefined) { missing.push(`${m[1]}.${m[2]} (${f}: table missing)`); continue; }
      if (!new RegExp('^\\s*`?' + m[2] + '`?\\s', 'm').test(body)) missing.push(`${m[1]}.${m[2]} (${f})`);
    }
  }
  assert.deepStrictEqual([...new Set(missing)], [], 'columns added by the application but absent from schema.sql');
});

test('schema.sql does not carry the removed duplicate index and keeps the single foreign key', () => {
  assert.ok(!/idx_movements_site_alt/.test(schema));
  assert.ok(!/idx_movements_site_alt/.test(sources.find((s) => s.f === 'server.js').t.replace(/\/\/.*$/gm, '').replace(/DROP INDEX idx_movements_site_alt[^;]*;/, '')), 'server.js only drops it, never creates it');
  assert.match(schema, /CONSTRAINT \w+ FOREIGN KEY \(pdu_id\) REFERENCES pdus\(id\)/);
});
