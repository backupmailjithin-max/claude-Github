const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
// A `//` comment placed mid-line swallows everything after it (this once hid diagnosedDate / receivedDate from the Issue Tracker pipeline).
test('no object-literal field is hidden behind a trailing // comment on the same line', () => {
  for (const f of ['server.js', 'app-compiled.js']) {
    fs.readFileSync(path.join(__dirname, '..', f), 'utf8').split('\n').forEach((l, n) => {
      const m = l.match(/[,;{(]\s*\/\/(.*)$/);
      if (m && !/https?:/.test(l) && /\b\w+:\s*(toDate\w*|r\.|req\.|i\.|a\.)\w*[(.\w]/.test(m[1])) assert.fail(`${f}:${n + 1} has code after a // comment: ${l.trim().slice(0, 120)}`);
    });
  }
});
