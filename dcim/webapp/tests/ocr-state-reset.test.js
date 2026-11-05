'use strict';
// Regression: the shared Tesseract worker must be returned to its default parameters after every scan,
// otherwise a serial/ID re-read (letters+digits whitelist, single-line mode) degrades the NEXT document.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'ocr', 'ocr-engine.js'), 'utf8');

test('every OCR pass clears the character whitelist', () => {
  const block = src.slice(src.indexOf('const PASSES'), src.indexOf('const PASSES') + 2500);
  const passes = block.match(/tessedit_char_whitelist/g) || [];
  assert.ok(passes.length >= 2, 'PASSES / PASS_RESCUE must set tessedit_char_whitelist explicitly');
});
test('recognizeImage always resets the worker parameters in a finally block', () => {
  assert.match(src, /finally\s*\{[^}]*setParameters\(\{\s*\.\.\.PASSES\[0\]\s*\}\)/);
});
