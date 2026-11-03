'use strict';
// Optional strict TLS verification with a trusted internal CA (improvement P1.1).
//
// DEFAULT = unchanged behaviour: certificate verification stays relaxed for the appliance calls
// (Dell OME / HPE OneView / Redfish) and SMTP, exactly as before. Strict mode is only active when
//   ENABLE_STRICT_TLS=true   (in .env)
// Optional extras (all in .env):
//   INTERNAL_CA_FILE=/path/internal-ca.pem   one or more PEM certificates (a bundle is fine)
//   TLS_RELAXED_HOSTS=10.1.1.5,ome2.local    hosts that stay relaxed even in strict mode (staged roll-out)
//
// Fallback rules (a bad setting must never take an integration down):
//   * INTERNAL_CA_FILE set but unreadable / not PEM  -> strict is NOT applied, relaxed behaviour continues, warning logged
//   * strict on and no INTERNAL_CA_FILE              -> the normal public CA list is used (strict, no internal CA)
//   * TLS version / cipher age is not a verification setting; the old-firmware compatibility stays in both modes.
const fs = require('fs');
const tls = require('tls');
const net = require('net');
const crypto = require('crypto');

const state = { loaded: false, enabled: false, caFile: '', caPems: [], caError: '', relaxedHosts: [], active: false, certs: [] };

function splitPems(text) {
  const out = []; const re = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g; let m;
  while ((m = re.exec(text))) out.push(m[0]);
  return out;
}

function load(log) {
  const env = process.env;
  state.enabled = /^(1|true|yes|on)$/i.test(String(env.ENABLE_STRICT_TLS || '').trim());
  state.caFile = String(env.INTERNAL_CA_FILE || '').trim();
  state.relaxedHosts = String(env.TLS_RELAXED_HOSTS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  state.caPems = []; state.caError = ''; state.certs = [];
  if (state.caFile) {
    try {
      const pems = splitPems(fs.readFileSync(state.caFile, 'utf8'));
      if (!pems.length) throw new Error('no PEM certificate found in the file');
      state.caPems = pems;
      state.certs = pems.map((p) => {
        try { const x = new crypto.X509Certificate(p); return { subject: x.subject.replace(/\n/g, ', '), validTo: x.validTo, expired: new Date(x.validTo) < new Date() }; }
        catch (e) { return { subject: '(unreadable certificate)', validTo: '', expired: false }; }
      });
    } catch (e) { state.caError = e.message; }
  }
  state.active = state.enabled && !state.caError;
  state.loaded = true;
  if (log) {
    if (state.enabled && state.caError) log.warn(`[tls] ENABLE_STRICT_TLS=true but INTERNAL_CA_FILE could not be used (${state.caError}) - keeping the current relaxed behaviour`);
    else if (state.active) log.info(`[tls] strict certificate verification ON (${state.caPems.length} internal CA certificate(s); ${state.relaxedHosts.length} relaxed host(s))`);
  }
  return state;
}

function ensure() { if (!state.loaded) load(null); return state; }

function isRelaxedHost(host) { return ensure().relaxedHosts.includes(String(host || '').toLowerCase()); }

// Options to merge into tls.connect / undici connect options for a given host.
function tlsOptionsFor(host) {
  const s = ensure();
  if (!s.active || isRelaxedHost(host)) return { rejectUnauthorized: false };
  const opts = { rejectUnauthorized: true };
  if (s.caPems.length) opts.ca = [...tls.rootCertificates, ...s.caPems];
  return opts;
}

function status() {
  const s = ensure();
  return {
    requested: s.enabled, active: s.active, caFile: s.caFile || null, caLoaded: s.caPems.length, caError: s.caError || null,
    certificates: s.certs, relaxedHosts: s.relaxedHosts,
    processWideVerifyDisabled: process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0',
    mode: s.active ? 'strict' : 'relaxed (current default)',
  };
}

// Compatibility probe: would a strict handshake with the internal CA succeed against host:port?
function probe(host, port, timeoutMs = 6000) {
  const s = ensure();
  return new Promise((resolve) => {
    const started = Date.now();
    const opts = { host, port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: false, timeout: timeoutMs, minVersion: 'TLSv1', ciphers: 'DEFAULT:@SECLEVEL=0' };
    if (s.caPems.length) opts.ca = [...tls.rootCertificates, ...s.caPems];
    let done = false; const finish = (r) => { if (done) return; done = true; resolve({ host, port, ms: Date.now() - started, ...r }); };
    const sock = tls.connect(opts, () => {
      const verified = sock.authorized; const err = sock.authorizationError ? String(sock.authorizationError) : '';
      let peer = null; try { const c = sock.getPeerCertificate(); peer = { subject: (c.subject && (c.subject.CN || c.subject.O)) || '', issuer: (c.issuer && (c.issuer.CN || c.issuer.O)) || '', validTo: c.valid_to || '' }; } catch (e) { /* ignore */ }
      sock.end();
      finish({ reachable: true, strictOk: !!verified, reason: verified ? '' : err, peer });
    });
    sock.once('error', (e) => finish({ reachable: false, strictOk: false, reason: e.code || e.message }));
    sock.once('timeout', () => { sock.destroy(); finish({ reachable: false, strictOk: false, reason: 'timeout' }); });
  });
}

module.exports = { load, status, tlsOptionsFor, isRelaxedHost, probe };
