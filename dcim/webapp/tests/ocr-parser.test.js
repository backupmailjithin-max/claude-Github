'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseDocument, parseDate } = require('../ocr/doc-types');

test('reads DC number, date and serial numbers from a delivery challan', () => {
  const lines = ['DELIVERY CHALLAN', 'DC No: DC-48213', 'Date: 12-Oct-2026', 'Serial No: SRV0231SN882, SRV0247SN117'].map((text) => ({ text }));
  const r = parseDocument(lines, {});
  const serials = r.serialNumbers.map((s) => s.value);
  assert.ok(serials.includes('SRV0231SN882') && serials.includes('SRV0247SN117'), JSON.stringify(serials));
  assert.ok(Object.values(r.fields).some((f) => /48213/.test(f.value)));
});
test('repairs a look-alike letter inside a serial when its siblings agree', () => {
  const lines = ['Tax Invoice', 'Invoice No: INV-2026-77', 'S/N: JAE23410ABC, JAE23410ABD, JAE2341DABE, JAE23410ABF'].map((text) => ({ text }));
  const r = parseDocument(lines, {});
  assert.ok(r.serialNumbers.map((s) => s.value).includes('JAE23410ABE'));
  assert.ok(r.warnings.some((w) => /look-alike/.test(w)));
});
test('parseDate tolerates OCR slips in the month', () => assert.ok(parseDate('11-0ct-2026')));
