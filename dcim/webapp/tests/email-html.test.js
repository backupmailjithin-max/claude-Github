'use strict';
const test = require('node:test');
const assert = require('node:assert');
const e = require('../lib/email-html');

test('recipients: valid list, duplicates removed, limits and bad addresses refused', () => {
  assert.deepStrictEqual(e.parseRecipients('A@x.com; b@y.org ,a@x.com').to, ['a@x.com', 'b@y.org']);
  assert.ok(e.parseRecipients('').error);
  assert.ok(e.parseRecipients(undefined).error);
  assert.match(e.parseRecipients('nope').error, /not a valid/);
  assert.match(e.parseRecipients('a@b').error, /not a valid/);
  const many = Array.from({ length: 11 }, (_, i) => `u${i}@x.com`).join(',');
  assert.match(e.parseRecipients(many).error, /At most 10/);
  assert.deepStrictEqual(e.parseRecipients(['a@x.com', 'b@x.com']).to, ['a@x.com', 'b@x.com']);
});

test('subject: no line breaks (header injection), bounded, falls back when empty', () => {
  assert.strictEqual(e.cleanSubject('Hi\r\nBcc: evil@x.com', 'F'), 'Hi Bcc: evil@x.com');
  assert.strictEqual(e.cleanSubject('', 'Fallback'), 'Fallback');
  assert.strictEqual(e.cleanSubject(null, 'Fallback'), 'Fallback');
  assert.ok(e.cleanSubject('x'.repeat(500), 'F').length <= 150);
});

test('report html: scripts, frames, forms, handlers, script links and font blobs are removed; layout is kept', () => {
  const dirty = '<html><head><style>@font-face{font-family:A;src:url(data:font/woff2;base64,AAAA)} .k{color:red}</style><script>alert(1)</script></head>' +
    '<body onload="x()"><h1 onclick=\'evil()\'>Title</h1><a href="javascript:alert(1)">l</a><iframe src="http://x"></iframe><form action="http://x"><input name=a></form>' +
    '<object data=x></object><img src="data:text/html;base64,AAA"><table><tr><td style="color:#123">ok</td></tr></table><!-- secret --></body></html>';
  const clean = e.sanitizeReportHtml(dirty);
  for (const bad of ['<script', 'alert(1)', 'onload', 'onclick', 'javascript:', '<iframe', '<form', '<input', '<object', 'data:text', '@font-face', 'woff2', 'secret']) assert.ok(!clean.toLowerCase().includes(bad.toLowerCase()), `still contains ${bad}`);
  for (const keep of ['<h1', 'Title', '.k{color:red}', '<table>', 'color:#123', 'ok']) assert.ok(clean.includes(keep), `lost ${keep}`);
});

test('sender banner is inserted and the name is escaped', () => {
  const out = e.withSenderBanner('<html><body><p>x</p></body></html>', '<b>Eve</b>');
  assert.ok(out.includes('sent by &lt;b&gt;Eve&lt;/b&gt;'));
  assert.ok(out.indexOf('sent by') < out.indexOf('<p>x</p>'));
  assert.ok(e.withSenderBanner('plain', 'A').startsWith('<div'));
});
