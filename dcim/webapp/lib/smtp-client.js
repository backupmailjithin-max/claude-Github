// Minimal SMTP client (connect / EHLO / STARTTLS / AUTH LOGIN / send) used only
// by the infra-configuration wizard's "Test Connection" / "Test Email" actions.
// Deliberately dependency-free (no nodemailer) so the offline package doesn't
// need a new vendored npm dependency for one feature.
'use strict';
const net = require('net');
const tls = require('tls');

const LINE_RE = /\r\n/;

function readResponse(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => { cleanup(); reject(new Error('SMTP server timed out')); }, timeoutMs);
    function onData(chunk) {
      buf += chunk.toString('utf8');
      const lines = buf.split(LINE_RE).filter(Boolean);
      const last = lines[lines.length - 1];
      // A multi-line reply's final line has a space after the code ("250 "); continuation lines use a dash ("250-").
      if (last && /^\d{3} /.test(last)) { cleanup(); resolve({ code: Number(last.slice(0, 3)), text: lines.join('\n') }); }
    }
    function onError(err) { cleanup(); reject(err); }
    function cleanup() { clearTimeout(timer); socket.removeListener('data', onData); socket.removeListener('error', onError); }
    socket.on('data', onData);
    socket.on('error', onError);
  });
}

function sendCmd(socket, line, timeoutMs) {
  socket.write(line + '\r\n');
  return readResponse(socket, timeoutMs);
}

async function connectPlain(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port, timeout: timeoutMs }, () => { socket.setTimeout(0); resolve(socket); });
    socket.once('error', reject);
    socket.once('timeout', () => { socket.destroy(); reject(new Error(`Connection to ${host}:${port} timed out`)); });
  });
}

async function connectTls(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, timeout: timeoutMs, rejectUnauthorized: false }, () => { socket.setTimeout(0); resolve(socket); });
    socket.once('error', reject);
    socket.once('timeout', () => { socket.destroy(); reject(new Error(`TLS connection to ${host}:${port} timed out`)); });
  });
}

function upgradeToTls(socket, host, timeoutMs) {
  return new Promise((resolve, reject) => {
    const secure = tls.connect({ socket, host, rejectUnauthorized: false, timeout: timeoutMs }, () => { secure.setTimeout(0); resolve(secure); });
    secure.once('error', reject);
  });
}

/**
 * Connects, authenticates (if credentials given), and optionally sends a test
 * message. Returns { ok: true, steps: [...] } or throws with a message that
 * names which SMTP step failed.
 */
async function testSmtp({ host, port, secure, user, pass, fromAddress, toAddress, timeoutMs = 10000 }) {
  const steps = [];
  let socket = secure ? await connectTls(host, port, timeoutMs) : await connectPlain(host, port, timeoutMs);
  try {
    let greet = await readResponse(socket, timeoutMs);
    if (greet.code !== 220) throw new Error(`Unexpected greeting: ${greet.text}`);
    steps.push('connected');

    let ehlo = await sendCmd(socket, `EHLO dcim-setup-wizard`, timeoutMs);
    if (ehlo.code !== 250) throw new Error(`EHLO rejected: ${ehlo.text}`);
    steps.push('ehlo');

    if (!secure && /STARTTLS/i.test(ehlo.text)) {
      const sr = await sendCmd(socket, 'STARTTLS', timeoutMs);
      if (sr.code !== 220) throw new Error(`STARTTLS rejected: ${sr.text}`);
      socket = await upgradeToTls(socket, host, timeoutMs);
      ehlo = await sendCmd(socket, `EHLO dcim-setup-wizard`, timeoutMs);
      if (ehlo.code !== 250) throw new Error(`EHLO (after STARTTLS) rejected: ${ehlo.text}`);
      steps.push('starttls');
    }

    if (user) {
      const authStart = await sendCmd(socket, 'AUTH LOGIN', timeoutMs);
      if (authStart.code !== 334) throw new Error(`AUTH LOGIN not accepted: ${authStart.text}`);
      const userResp = await sendCmd(socket, Buffer.from(user, 'utf8').toString('base64'), timeoutMs);
      if (userResp.code !== 334) throw new Error(`Username rejected: ${userResp.text}`);
      const passResp = await sendCmd(socket, Buffer.from(pass || '', 'utf8').toString('base64'), timeoutMs);
      if (passResp.code !== 235) throw new Error(`Authentication failed: ${passResp.text}`);
      steps.push('authenticated');
    }

    if (fromAddress && toAddress) {
      const mailFrom = await sendCmd(socket, `MAIL FROM:<${fromAddress}>`, timeoutMs);
      if (mailFrom.code !== 250) throw new Error(`MAIL FROM rejected: ${mailFrom.text}`);
      const rcptTo = await sendCmd(socket, `RCPT TO:<${toAddress}>`, timeoutMs);
      if (rcptTo.code !== 250 && rcptTo.code !== 251) throw new Error(`RCPT TO rejected: ${rcptTo.text}`);
      const data = await sendCmd(socket, 'DATA', timeoutMs);
      if (data.code !== 354) throw new Error(`DATA rejected: ${data.text}`);
      const body = [
        `From: ${fromAddress}`,
        `To: ${toAddress}`,
        `Subject: DCIM test email`,
        `Date: ${new Date().toUTCString()}`,
        '',
        'This is a test email sent from the DCIM infrastructure configuration wizard.',
        '.',
      ].join('\r\n');
      const sent = await sendCmd(socket, body, timeoutMs);
      if (sent.code !== 250) throw new Error(`Message not accepted: ${sent.text}`);
      steps.push('sent');
    }

    await sendCmd(socket, 'QUIT', timeoutMs).catch(() => {});
    return { ok: true, steps };
  } finally {
    socket.destroy();
  }
}

module.exports = { testSmtp };
