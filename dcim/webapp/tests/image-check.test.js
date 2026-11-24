'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { checkImageUpload } = require('../lib/image-check');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20)]);
const ICO = Buffer.concat([Buffer.from([0, 0, 1, 0]), Buffer.alloc(20)]);
const ALL = ['png', 'jpg', 'svg', 'ico'];

test('real images are accepted and their type comes from the bytes', () => {
  assert.strictEqual(checkImageUpload(PNG, ALL, 'image/png').ext, 'png');
  assert.strictEqual(checkImageUpload(JPG, ALL, 'image/jpeg').ext, 'jpg');
  assert.strictEqual(checkImageUpload(ICO, ALL, 'image/x-icon').ext, 'ico');
  assert.strictEqual(checkImageUpload(ICO, ['png', 'ico'], 'image/vnd.microsoft.icon').ext, 'ico');
  const svg = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><style>.a{fill:#123}</style><rect class="a" width="10" height="10"/><image href="data:image/png;base64,AAAA"/></svg>');
  assert.strictEqual(checkImageUpload(svg, ALL, 'image/svg+xml').ext, 'svg');
});

test('a file that only claims to be an image is refused', () => {
  assert.ok(checkImageUpload(Buffer.from('<html><script>alert(1)</script></html>'), ALL, 'image/png').error);
  assert.ok(checkImageUpload(Buffer.from('MZ\u0090\u0000 this is an exe'), ALL, 'image/png').error);
  assert.ok(checkImageUpload(PNG, ALL, 'image/jpeg').error, 'declared type must match the content');
  assert.ok(checkImageUpload(JPG, ['png', 'ico'], 'image/png').error, 'favicon must be png or ico');
});

test('an SVG with anything executable or external is refused', () => {
  const wrap = (inner) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg">${inner}</svg>`);
  for (const inner of ['<script>alert(1)</script>', '<rect onload="x()"/>', '<a href="javascript:alert(1)"><rect/></a>', '<foreignObject><div/></foreignObject>',
    '<image href="https://evil.example/x.png"/>', '<animate attributeName="href" values="javascript:alert(1)"/>', '<iframe src="x"/>']) {
    assert.ok(checkImageUpload(wrap(inner), ALL, 'image/svg+xml').error, `accepted: ${inner}`);
  }
  assert.ok(checkImageUpload(Buffer.from('<!DOCTYPE svg [<!ENTITY x "y">]><svg xmlns="http://www.w3.org/2000/svg"/>'), ALL, 'image/svg+xml').error);
});
