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

// Gate pass with a ruled item table (Material Name | Serial No | Asset No | Quantity | Unit | Tracking ID)
test('gate pass: item table rows give serials, names, quantity and unit', () => {
  const L = (text, y) => ({ text, conf: 80, words: [{ text, conf: 80, x0: 100, x1: 400, y0: y, y1: y + 20 }] });
  const lines = [L('Material Movement Gate Pass', 10), L('Tracking ID: OCHE261124769', 40), L('Material Name Serial No | unit [Tracking ID|', 100),
    L('ASSY,CRD,RSR4Q, 2X 26H63 Loo Nos', 140), L('8FHHL,2U,16G |', 170), L('ASSY,CRD,PLN,PIB, PJ7CD i 0 Nos', 220), L('RIO,R7615,V4 |', 250),
    L('Total Entry : 3', 400), L('Checked By : Nxtra Security-DC2', 430)];
  const r = require('../ocr/doc-types').parseDocument(lines, {});
  assert.strictEqual(r.documentType.id, 'gate-pass');
  assert.deepStrictEqual(r.serialNumbers.map((s) => s.value), ['26H63', 'PJ7CD']);
  assert.strictEqual(r.fields.quantity.value, '2');
  assert.strictEqual(r.fields.unit.value, 'Nos');
  assert.ok(/RIO,R7615,V4/.test(r.fields.itemDescription.value));
});

test('gate pass: clipped first letter of a part name is restored from sibling rows, spaces removed', () => {
  const L = (text, y) => ({ text, conf: 80, words: [{ text, conf: 80, x0: 100, x1: 400, y0: y, y1: y + 20 }] });
  const lines = [L('Material Movement Gate Pass', 10), L('Material Name Serial No Quantity Unit', 100),
    L('SSY,CRD,RSR4Q, 2X 26H63 1.0 Nos', 140), L('8FHHL,2U,16G |', 170), L('ASSY,CRD,PLN,PIB, PJ7CD 1.0 Nos', 220), L('RIO,R7615,V4 |', 250),
    L('ASSY,CRD,SCTY, TP T9CVK 1.0 Nos', 300), L('M,2.0,15G,V6', 330), L('Total Entry : 3', 400)];
  const r = require('../ocr/doc-types').parseDocument(lines, {});
  assert.ok(r.fields.itemDescription.value.startsWith('ASSY,CRD,RSR4Q,2X8FHHL,2U,16G;'), r.fields.itemDescription.value);
  assert.ok(r.fields.itemDescription.value.endsWith('ASSY,CRD,SCTY,TPM,2.0,15G,V6'));
  assert.deepStrictEqual(r.serialNumbers.map((s) => s.value), ['26H63', 'PJ7CD', 'T9CVK']);
});
