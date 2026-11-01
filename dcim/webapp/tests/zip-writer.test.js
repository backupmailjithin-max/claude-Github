'use strict';
const test = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');
const { buildZip } = require('../lib/zip-writer');

function readZip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(eocd + 10); let off = buf.readUInt32LE(eocd + 16); const out = {};
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(off + 10), csize = buf.readUInt32LE(off + 20), nlen = buf.readUInt16LE(off + 28), elen = buf.readUInt16LE(off + 30), clen = buf.readUInt16LE(off + 32), lho = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nlen);
    const lnlen = buf.readUInt16LE(lho + 26), lelen = buf.readUInt16LE(lho + 28); const data = buf.subarray(lho + 30 + lnlen + lelen, lho + 30 + lnlen + lelen + csize);
    out[name] = method === 8 ? zlib.inflateRawSync(data) : Buffer.from(data); off += 46 + nlen + elen + clen;
  }
  return out;
}
test('buildZip round-trips names and content', () => {
  const files = { 'a.txt': Buffer.from('hello '.repeat(200)), 'dir/b.bin': Buffer.from([1, 2, 3, 4]), 'ü-name.txt': Buffer.from('unicode') };
  const out = readZip(buildZip(Object.entries(files).map(([name, data]) => ({ name, data }))));
  assert.deepStrictEqual(Object.keys(out).sort(), Object.keys(files).sort());
  for (const k of Object.keys(files)) assert.ok(out[k].equals(files[k]), k);
});
test('buildZip handles an empty list', () => assert.ok(buildZip([]).length >= 22));
