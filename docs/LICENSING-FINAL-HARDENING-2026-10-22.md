# DCIM Licensing Final Hardening — 2026-10-22

Unchanged: license format, `POST /api/license/activate` contract, existing licenses, offline activation, Ed25519 verification, all company workflows.

## What was added
| # | Control | Where |
|---|---|---|
| 1 | **Startup integrity verification.** `integrity.manifest.json` = SHA-256 of `server.js`, `lib/license.js`, `lib/license-public-key.js`, `lib/integrity.js` + hash of the licence public key that must be loaded in memory, signed (Ed25519). Verified at startup and re-checked when a protected file changes (stat once a minute). Mismatch ⇒ audit `INTEGRITY_VIOLATION` (+ `LICENSE_PUBLIC_KEY_REPLACED`), log warning, `integrity.warnings` in the license status. `INTEGRITY_MODE=restricted` (opt-in) locks the app; activation/sign-out stay reachable. Default `warn` blocks nothing. | `lib/integrity.js`, `lib/license.js` |
| 2 | **Service hardening (Linux).** `ProtectSystem=strict`, `ProtectHome=true` kept; the webapp directory is the writable state area, and all application code (`server.js`, `lib`, `ocr`, `libs`, `media`, `node_modules`, `tools`, app/HTML files, `package*.json`, `schema.sql`, the manifest) is mounted **ReadOnlyPaths**; `UnsetEnvironment=NODE_PATH LD_PRELOAD LD_LIBRARY_PATH`; `ProtectClock=true`. **Windows / all platforms:** runtime guard reports `NODE_OPTIONS` code-loading/debug flags, `NODE_PATH`, `LD_PRELOAD` (audit + warning; blocks in restricted mode). | `dcim.service.template`, `lib/integrity.js` |
| 3 | **License-file monitoring.** Unexpected modification/removal of `license.lic`, signature failures (`LICENSE_TAMPERED`) and public-key replacement are audited once per distinct event per process. The app's own activation is acknowledged, so it never self-reports. | `lib/integrity.js`, `lib/license.js` |
| 4 | **Build validation.** `packaging/tools/validate-package.js` fails package creation on vendor license tools, `license.lic` / trial / clock state, `.env`, private/signing key files, `PRIVATE KEY` blocks (real key bodies; doc examples such as dotenv's README are ignored), or an unverifiable/mismatching manifest. Wired into deb, rpm, appliance builds and the Windows job (applies each `.iss` Excludes list first). Manifest creation uses an in-memory throw-away key — nothing to leak. | `packaging/tools/*`, build scripts, `build-packages.yml` |

**Finding fixed on the way:** the previous unit (`ProtectSystem=strict` with only `uploads/backups/logs` writable) leaves the webapp directory read-only, which by systemd semantics blocks writing `license.lic`, `.trial-state`, `.license-clock` and `.env` (setup wizard) on a real Linux install. The new unit makes the directory writable and the *code* read-only. Not executed on real systemd (see below).

## Risk assessment
| Risk | Before | After |
|---|---|---|
| **Keygen** | LOW | **LOW** (no new key material; the integrity key is created in memory at build time and discarded) |
| Bypass via compromised/unprivileged app process or service user | HIGH | **LOW** — code is read-only for the service; edits are also detected |
| Bypass via env hook (`NODE_OPTIONS=--require`, `LD_PRELOAD`, `NODE_PATH`) | HIGH | **LOW-MEDIUM** — stripped by the unit (Linux) / audited everywhere / blocked in restricted mode |
| Public-key replacement / patching `license.js` or `server.js` on disk | HIGH, silent | **MEDIUM** — detected and audited; blocked only in restricted mode |
| Root/Administrator who rewrites code **and** the manifest **and** `integrity.js` | HIGH | **HIGH (unchanged)** — the manifest key ships with the package; no offline Node scheme can prevent this. It now needs coordinated edits and leaves audit traces before/while done |

## Performance impact
Measured: startup verification **2.0 ms**; per-request overhead **~1 µs** (cached status); steady-state monitor tick **0.018 ms/minute** (stat of 5 files; hashing only when something changed). No additional I/O on the request path.

## Backward compatibility
- Existing licenses, trial records, activation API, offline activation: untouched (re-ran earlier license suites: 51/51 unit, 40/40 API).
- Installs without a manifest (dev trees, hand-copied hot-fixes) work exactly as before; production logs one warning and one audit row `INTEGRITY_MANIFEST_MISSING`.
- Hand-copying one of the four protected files onto a packaged install now shows the integrity warning until a matching manifest is installed.
- `restricted` mode is opt-in and reversible (set `INTEGRITY_MODE=warn`, restart).
- Windows service hardening beyond the runtime guard (service account, NTFS ACLs) is **not** changed — not testable here; recommended manual step: run the service as a dedicated low-privilege account with read-only ACLs on the program folder.

## Test results
- Integrity unit: **36/36** — clean tree; each of the 4 protected files modified; edited manifest; swapped manifest key; deleted/garbage manifest; in-memory public-key swap (a `--require` hook); env overrides (and legitimate `--max-old-space-size` not flagged); restricted mode incl. "deleting the manifest does not disable it"; license-file monitor (modify/dedupe/remove/acknowledge); edit after startup.
- Server end-to-end (real server, restarts): baseline OK; modified `license.js` → warn mode still serves (200) with audit + warning, restricted → 402 and **activation endpoint still reachable**; public-key replaced → `LICENSE_PUBLIC_KEY_REPLACED`; live edits of `license.lic` and `license.js` while running detected within the 60 s tick (one audit row each); manifest deleted → warn serves, restricted locks.
- Previous license suites against the new code: **51/51 unit, 40/40 API** (activation, binding, clock, audit, mode 600).
- Build gate: **15/15** negative/positive cases (license tool, private key block incl. unterminated/embedded `\n`, generated key file, `*private*.pem`, `license.lic`, `.trial-state`, `.env`, manifest mismatch/missing, doc example not flagged). Real `dpkg` build: succeeds clean, package contains a valid manifest (re-verified after extraction) and no license tools; with a private-key file injected into the tree the build **fails and no .deb is produced**. Windows `.iss` exclude lists validated on the source tree.
- Full 175-check regression: **173/175 — identical to the unmodified-code control** (same 2 fixture-dependent checks).
- Systemd: rendered unit passes `systemd-analyze verify`; the read-only-code / writable-state layout was reproduced with mount namespaces (code edits, new files and rename-replacement denied; atomic `license.lic` replace, `.trial-state` writes allowed).
- **Not executed:** a real systemd start of the new unit, rpm / appliance / Windows installer builds, Windows runtime, upgrade on a real host.

## Rollback plan
1. Code: `git revert` the commit (removes `lib/integrity.js`, restores previous `license.js`/`server.js`, unit, build scripts).
2. On an installed host without reverting: delete `integrity.manifest.json` (⇒ "unsigned", warn-only) or set `INTEGRITY_MODE=warn` in `.env`; restart.
3. Unit: restore `/etc/systemd/system/dcim.service` from the previous render (`dcim-repair` re-renders it from the packaged template), `systemctl daemon-reload && systemctl restart dcim`.
4. A lock caused by `restricted` mode needs no data repair: remove `INTEGRITY_MODE=restricted`, restart. No license, trial or database state is modified by this feature.
