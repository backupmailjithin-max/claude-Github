const test = require('node:test'); const assert = require('node:assert');
const path = require('path'); const mod = path.join(__dirname, '..', 'lib', 'tls-config.js');
function fresh(env) { for (const k of ['ENABLE_STRICT_TLS', 'INTERNAL_CA_FILE', 'TLS_RELAXED_HOSTS']) delete process.env[k]; Object.assign(process.env, env); delete require.cache[require.resolve(mod)]; const t = require(mod); t.load(null); return t; }
test('default is relaxed (unchanged behaviour)', () => { const t = fresh({}); assert.equal(t.status().active, false); assert.deepEqual(t.tlsOptionsFor('x'), { rejectUnauthorized: false }); });
test('strict without CA uses default roots and verifies', () => { const t = fresh({ ENABLE_STRICT_TLS: 'true' }); assert.equal(t.tlsOptionsFor('x').rejectUnauthorized, true); });
test('unusable CA file falls back to relaxed', () => { const t = fresh({ ENABLE_STRICT_TLS: 'true', INTERNAL_CA_FILE: '/nonexistent.pem' }); assert.equal(t.status().active, false); assert.equal(t.tlsOptionsFor('x').rejectUnauthorized, false); });
test('relaxed hosts stay relaxed in strict mode', () => { const t = fresh({ ENABLE_STRICT_TLS: 'true', TLS_RELAXED_HOSTS: 'Old.Host' }); assert.equal(t.tlsOptionsFor('old.host').rejectUnauthorized, false); assert.equal(t.tlsOptionsFor('new.host').rejectUnauthorized, true); });
