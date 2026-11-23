'use strict';
// Material Movement Gate Pass (two-column Sender / Receiver blocks): fields must come from the right column.
// The fixture is real OCR word output of a phone photo, with names, numbers and places replaced by test values.
const test = require('node:test');
const assert = require('node:assert');
const { parseDocument } = require('../ocr/doc-types');
const lines = require('./fixtures/ocr-gatepass-lines.json');

test('gate pass: receiver, phone, address, tracking id and movement type are read from the Receiver block', () => {
  const r = parseDocument(lines, {});
  assert.strictEqual(r.documentType.id, 'gate-pass');
  const f = r.fields;
  assert.strictEqual(f.movementType.value, 'Outward');
  assert.strictEqual(f.dcNumber.value, 'OTST261125003');
  assert.strictEqual(f.receiver.value, 'Testperson');
  assert.strictEqual(f.sender.value, 'ACMECORP');
  assert.strictEqual(f.contactMobile.value, '9000000001');
  assert.match(f.partyAddress.value, /Testpark IT park Testville Testcity/);
  assert.match(f.partyAddress.value, /Tamil Nadu/);
  assert.strictEqual(f.documentDate.value, '2026-11-23');
  assert.strictEqual(f.itemDescription.value, 'Barcode Scanner');
  assert.strictEqual(f.quantity.value, '1');
});

test('gate pass: "Security" / "Checked By" text is never offered as a serial number', () => {
  const r = parseDocument(lines, {});
  assert.deepStrictEqual(r.serialNumbers.map((x) => x.value), []);
});

test('gate pass: sender block phone is not used for an outward pass', () => {
  const r = parseDocument(lines, {});
  assert.notStrictEqual(r.fields.contactMobile.value, '9000000002');
});
