'use strict';
// Content checks for the branding uploads (logo / favicon). The browser-declared type is not trusted on its own: the bytes
// must really be that kind of image, and an SVG may not carry anything executable.

function detectImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return null;
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] === 0x00) return 'ico';
  const head = buf.subarray(0, Math.min(buf.length, 4096)).toString('utf8').replace(/^﻿/, '').trimStart();
  if (/^(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(head)) return 'svg';
  return null;
}

// Returns null when the SVG is plain drawing markup, otherwise the reason it is refused.
function svgProblem(buf) {
  const t = buf.toString('utf8');
  if (/<\s*script\b/i.test(t)) return 'it contains a script';
  if (/<\s*(foreignObject|iframe|object|embed|audio|video|canvas|animate|set)\b/i.test(t)) return 'it contains an embedded or animated element that is not allowed';
  if (/\son[a-z]+\s*=/i.test(t)) return 'it contains an event handler';
  if (/(?:href|src)\s*=\s*["']?\s*(?:javascript|vbscript|data:text)/i.test(t)) return 'it contains a script link';
  if (/<!ENTITY|<!DOCTYPE[^>]*\[/i.test(t)) return 'it contains an entity definition';
  if (/(?:xlink:)?href\s*=\s*["']\s*https?:/i.test(t)) return 'it loads content from another address';
  return null;
}

// kinds: array of allowed formats, e.g. ['png','jpg','svg','ico']. Returns { ext } or { error }.
function checkImageUpload(buf, kinds, declaredMime) {
  const ext = detectImage(buf);
  if (!ext || !kinds.includes(ext)) return { error: `The file is not a valid ${kinds.map((k) => k.toUpperCase().replace('JPG', 'JPEG')).join(', ')} image.` };
  const declared = { png: 'png', jpeg: 'jpg', 'svg+xml': 'svg', 'x-icon': 'ico', 'vnd.microsoft.icon': 'ico' }[String(declaredMime || '').replace(/^image\//, '')];
  if (declared && declared !== ext) return { error: `The file content (${ext.toUpperCase()}) does not match its declared type.` };
  if (ext === 'svg') { const p = svgProblem(buf); if (p) return { error: `This SVG cannot be used: ${p}. Export a plain SVG, or use PNG.` }; }
  return { ext };
}

module.exports = { detectImage, svgProblem, checkImageUpload };
