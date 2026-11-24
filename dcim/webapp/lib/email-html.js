'use strict';
// Helpers for the "Email this report" button of the Data Center Report window (POST /api/reports/email).
// The browser sends the report as an HTML page; this module makes it safe to mail: no scripts, frames, forms or
// event handlers, no embedded font files (large and ignored by mail programs), a bounded size, a clean subject line
// and a validated recipient list.

const EMAIL_RE = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_RECIPIENTS = 10;

function parseRecipients(input) {
  const list = [...new Set([].concat(input || []).join(',').split(/[\s,;]+/).map((x) => String(x || '').trim().toLowerCase()).filter(Boolean))];
  if (!list.length) return { error: 'Enter at least one e-mail address' };
  if (list.length > MAX_RECIPIENTS) return { error: `At most ${MAX_RECIPIENTS} addresses at a time` };
  const badOne = list.find((x) => !EMAIL_RE.test(x));
  if (badOne) return { error: `"${badOne}" is not a valid e-mail address` };
  return { to: list };
}

function cleanSubject(subject, fallback) {
  const s = String(subject == null ? '' : subject).replace(/[\r\n\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150);
  return s || fallback;
}

function sanitizeReportHtml(html) {
  let h = String(html == null ? '' : html);
  h = h.replace(/<!--[\s\S]*?-->/g, '');
  h = h.replace(/@font-face\s*\{[^}]*\}/gi, '');
  h = h.replace(/<\s*(script|iframe|object|embed|applet|form|frame|frameset|noscript|template)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, '');
  h = h.replace(/<\s*\/?\s*(script|iframe|object|embed|applet|form|frame|frameset|link|base|meta|input|button|textarea|select|noscript|template)\b[^>]*>/gi, '');
  h = h.replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  h = h.replace(/(href|src|action|formaction|xlink:href)\s*=\s*("|')?\s*(javascript|vbscript|data)\s*:[^"'>\s]*("|')?/gi, '$1="#"');
  h = h.replace(/expression\s*\(/gi, '(');
  return h;
}

// Puts a plain "sent by" line at the top of the page so a recipient can see who mailed it.
function withSenderBanner(html, senderName) {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
  const banner = `<div style="font:12px Arial,sans-serif;color:#475569;padding:8px 12px;border-bottom:1px solid #CBD5E1">Data Center Report sent by ${esc(senderName || 'a DCIM user')} from the DCIM dashboard.</div>`;
  return /<body[^>]*>/i.test(html) ? html.replace(/(<body[^>]*>)/i, `$1${banner}`) : banner + html;
}

module.exports = { EMAIL_RE, MAX_HTML_BYTES, MAX_RECIPIENTS, parseRecipients, cleanSubject, sanitizeReportHtml, withSenderBanner };
