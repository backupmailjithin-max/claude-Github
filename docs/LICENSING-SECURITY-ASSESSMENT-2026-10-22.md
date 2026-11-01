# DCIM Licensing Security Assessment — 2026-10-22

Scope: `lib/license.js`, `lib/license-public-key.js`, activation / validation / trial / licence storage and their integration in `server.js`. Review only; no licensing or business code was changed. Attacks were run against an isolated copy with throwaway keys (the vendor private key is not in the repo, history or any package).

## Verdict
| Item | Rating |
|---|---|
| **Keygen risk** | **LOW** |
| **Bypass risk** | **HIGH for an attacker with write access to the install / service environment; MEDIUM overall** (no remote or config-only bypass found) |
| **Security score** | **70 / 100** |

## 1. Architecture
```
VENDOR (offline)                          CUSTOMER INSTALL
 private key (never shipped)               lib/license-public-key.js (Ed25519 public key)
   │ sign(payloadJson)                        │
   ▼                                          ▼
 license.lic = {payloadJson, sig, alg}  ──►  lib/license.js
   payload: customer, expiresAt,               verify sig over exact payloadJson
   maxUsers, optional machineId                check alg, expiry (Date.now), machineId
                                               │
 Activation: POST /api/license/activate        ▼
  (Global Admin; file or base64url code)   getLicenseStatus → off | licensed | trial | locked
                                               │
 Trial: 10 days, .trial-state + app_settings   ▼
  HMAC(sha256('dcim-trial-v1'|fingerprint))   server.js authenticateToken → licenseBlocked()
  clock high-water mark                        → HTTP 402 except LICENSE_ALLOWED routes
```
Fingerprint = sha256(machine-id / MachineGuid + first sorted MAC + hostname), 32 hex.

## 2. Signature verification — sound
Ed25519 detached signature over the exact payload string. Tested and rejected: unknown-key signature, altered payload (any byte), altered signature, `alg` downgrade/none, expired, wrong machine, malformed JSON/base64, oversize upload. Verification is the native `crypto.verify`; no custom crypto.

## 3. Keygen feasibility — LOW
Without the private key, a valid licence cannot be produced (Ed25519, 128-bit security). Private key and generator material: absent from repo, git history, deb payload, Windows installers. Only `license-public-key.js` ships. Residual: vendor tooling (`tools/license-*.js`, wizard, template) **is** present in the repo and in the **appliance build** (see G10); it contains no key but should not ship. RPM contents could not be listed in this sandbox (no rpm tooling); `build-rpm.sh` applies the same stripping as the deb.

## 4. Bypass assessment — HIGH (local) / LOW (remote)
No remote, API, environment-variable or setting-only bypass was found; `LICENSE_FILE` only changes the path. Local bypasses by anyone who can edit app files or the service environment:
1. Replace the embedded public key and self-sign.
2. Patch `isLicensingConfigured` / `licenseBlocked` (source is plain JS, unobfuscated, no integrity check).
3. `NODE_OPTIONS=--require` hook in the service unit.
4. Forge the trial record (see G4).
This is inherent to a readable Node.js product; it is a deterrent against casual and remote misuse, not against a determined local admin.

## 5. Tamper resistance — MEDIUM-LOW
Payload/signature tamper: strong. Code/key tamper: none (no hash check of `license.js`, key file or `server.js`, no signed bundle). Backup/restore correctly excludes `license.%` settings, so restore cannot import or reset licence state.

## 6. Trial protection
- Expiry: 10 days; invalid or missing signature ⇒ trial ended (fail closed). Earliest valid copy of start wins across file + DB.
- Clock rollback: hourly high-water mark, enforced.
- Reset: deleting only one store does not reset (other copy wins); deleting **both** stores resets (G4); forging requires the fingerprint-derived HMAC key, which is computable from source.
- Machine binding: HMAC keyed by fingerprint ⇒ trial record moved to another host is invalid. Company / environment binding: none (G9).

## 7. Offline activation, validation, renewal — works
Offline code or file upload; validation fully offline; renewal = activate a new licence (no phone-home). Activation is Global-Admin only and size-limited.

## 8. Findings
| ID | Sev | Finding |
|---|---|---|
| G1 | Medium | Activation writes the new file **before** validating; a bad upload overwrites and locks a working licence. |
| G2 | Medium | Licence expiry has no clock-rollback high-water mark (trial does). |
| G3 | Medium | Fingerprint includes hostname and MAC: rename/NIC change breaks machine-bound licence and trial (false lockout). |
| G4 | Medium | Trial HMAC key derivable from source + fingerprint; deleting both stores resets the trial. |
| G5 | Low | No product/version claim in payload. |
| G6 | Low | Unparseable `expiresAt` accepted (issuer-side guard missing). |
| G7 | Low | Failed activations not audited. |
| G8 | Low | `license.lic` stored world-readable (0644). |
| G9 | Low | No company/environment binding. |
| G10 | Low | Appliance build copies the whole webapp, including vendor licence tools (no key). |

## 9. Recommendations (not implemented)
1. G1: validate to a temp file, then atomic rename. 
2. G2: persist a licence-clock high-water mark like the trial.
3. G3: fingerprint from machine-id only (keep hostname/MAC as soft factors); add an admin "re-bind" path with a vendor-reissued licence.
4. G4: store trial start inside a vendor-signed or server-side-secret structure; accept that offline trial reset is not fully preventable.
5. G5/G6: add `product` and `minVersion` claims; make issuer reject unparseable dates.
6. G7/G8: audit failed activations; write `license.lic` mode 600.
7. G10: strip `tools/license-*` in `build-appliance.sh`; add a CI check that no package contains them.
8. Hardening for bypass: ship a minified/bytenode-compiled licence module, add a startup self-hash of `license.js` + public key verified against a signed manifest, and set the service unit `ReadOnlyPaths` for app code. Document honestly that this raises effort but is not tamper-proof; contractual / audit controls complement it.

## Not verified
Windows execution, rpm contents, behaviour on a real systemd host with a real hostname/NIC change (simulated only).
