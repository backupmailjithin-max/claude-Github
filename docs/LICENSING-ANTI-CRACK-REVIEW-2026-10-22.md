# DCIM Commercial Licensing Hardening - Anti-Crack Review (2026-10-22)

Scope: no change to the licence format, the activation API, existing licences or offline activation. Items 1-3 implemented; item 4 (Bytenode / native module) evaluated with a live test on the bundled Node 20.18.1; items 5-6 verified by executed attacks.

## 1. Design review

| # | Requirement | Result |
|---|---|---|
| 1 | Vendor-signed integrity manifest | **Done.** `integrity.manifest.json` is signed with a vendor integrity key (separate from the licence key). The app verifies with the pinned public key only; a vendor-signed manifest carries no key at all. Private key: created by `packaging/tools/integrity-keygen.js` (mode 600, refused inside the repo), read by the build tool from outside the package tree, held in memory only. Build gate fails if the key file is in the tree, if a pinned build has no key, if the key does not match the pin, or (release mode) if the manifest is not vendor-signed. |
| 2 | Trust-root protection | **Done.** The pin is held in three places that must agree: `lib/integrity-public-key.js`, a fingerprint constant in `lib/integrity.js`, and the same constant in `lib/license.js` (a second, independent check). Removing the pin (downgrade to a self-signed manifest), swapping it, or editing only some of the places is detected (`INTEGRITY_TRUST_ROOT_MISMATCH`). The key file is itself in the signed file list. |
| 3 | Runtime hijack = startup blocker under `INTEGRITY_MODE=enforce` | **Done.** Code-loading `NODE_OPTIONS` (`--require/--import/--loader/--eval/--inspect*/--debug*`), `NODE_PATH`, `LD_PRELOAD`, an open inspector, a SIGUSR1 inspector request, a patched signature primitive (known-answer self-test) and modules loaded from outside the install folder now enforce (refuse normal startup, 503 gate, reference ID, audit, recovery text). Environment is also read from `/proc/self/environ`, so a preload that scrubs `process.env` is still caught. Benign flags (`--max-old-space-size`, `--use-openssl-ca`) are allowed. Re-checked every 60 s and on SIGUSR1; SIGUSR1 is handled so no inspector opens. |
| 4 | Bytenode / native module | **Evaluated, not integrated** (see section 4). |
| 5 | No trusted manifest without the vendor key | **Verified** (section 3). |
| 6 | Reassessment | Section 5. |

## 2. Implementation impact and upgrade compatibility

- Files: `lib/integrity.js`, `lib/license.js` (pin constant + peer check only), new `lib/integrity-public-key.js`; build tools `make-integrity-manifest.js`, `validate-package.js`, `package-gate.sh`, new `integrity-keygen.js`; Windows CI step.
- Licence format, activation API, licence verification code path, existing licences, trial data: **untouched** (regression: unit 51/51, API e2e 40/40, full application suite 173/175 = identical to the unmodified baseline).
- **Dormant until you pin a key.** With no key pinned (as delivered) manifests stay self-signed and everything behaves as before, plus the new runtime checks. Pinning is a deliberate vendor action (section 6 of this note / `LICENSING.md`).
- The protected set grows from 4 to 5 files; the manifest ships with the files, so a normal update is unaffected. A hot-fix that replaces one protected file must ship the matching (vendor-signed) manifest - same rule as before, now signed by you.
- Windows service environment variables named above (`NODE_PATH`, code-loading `NODE_OPTIONS`) now block start-up **only** when the customer opted into `enforce`. Default stays `warn`.
- Rollback: restore the previous `lib/integrity.js`, `lib/license.js`, `integrity.manifest.json` (or set `INTEGRITY_MODE=warn`). No data or licence state is involved.
- Performance: one extra file read + one Ed25519 verify at start-up and on change; runtime re-check once a minute (env read, inspector state, 2 verifies).

## 3. Verification (executed)

Unit/forge tests (42): self-signed legacy mode unchanged; keygen safety (mode 600, no overwrite, refuses repo path); pinned build without/with wrong key fails; vendor manifest carries no key; and the forging attacks, all **rejected** without the vendor key:
patch + re-hash + self-sign with own embedded key; same with `signer` spoofed; patch without touching the manifest; replace the pin file; null the pin and downgrade to self-signed; pin file + `integrity.js` constant changed but `license.js` untouched; delete the pin file; delete the manifest; bad signature; edit signed payload; using the shipped build tool without the key or with another key.

Real-server tests (enforce, AlmaLinux-style service tree, DB-backed): clean start with benign `NODE_OPTIONS` serves normally; each of `NODE_PATH`, `--require` hook that makes `crypto.verify` return true, a hook that scrubs `process.env`, `--inspect`, `LD_PRELOAD`, and a SIGUSR1 sent to a clean running server -> **503 on everything except health/licence/sign-in, reference ID, audit `INTEGRITY_ENFORCED`**, port 9229 never opened; clean restart recovers; `warn` mode with the same overrides is unchanged (audit only). Vendor-pinned tree: the threat-model attack (patch `license.js`, re-forge manifest with own key) is refused at start-up; a legitimate vendor re-sign of a hot-fix is accepted. Existing suites: integrity unit 36/36, enforce unit 81/81 (was 68; the old "env override alone does not enforce" assertion was replaced by the new hijack-blocker assertions).

**Not executed:** Windows service behaviour, real systemd with the new unit, rpm/appliance/Windows package builds, LD_PRELOAD of a real shared object (a benign library was used), Node 20.18.1 end-to-end (unit-level only).

## 4. Priority 3 - Bytenode / native module evaluation (live test, Node 20.18.1)

| Question | Finding |
|---|---|
| Works with the bundled runtime? | Yes. `license`-style module and the real `integrity.js` compile and load; load time 5.8 ms -> 10.3 ms, file 27 KB -> 41 KB. |
| Tied to Node build? | Yes: a `.jsc` built on 20.18.1 is **rejected by Node 22** (`cachedDataRejected`). Fits Windows, appliance and offline kit (bundled Node); the deb/rpm already ship `runtime/node`. Any runtime upgrade requires recompiling and re-releasing. |
| Hides logic? | Partly. Source is gone, but string constants stay readable (`strings` shows `INTEGRITY_ENFORCED`, `trustRootMismatch`). |
| Tamper-proof? | **No.** A same-length edit of a string constant inside the `.jsc` loads without any error (tested: marker changed) - which is exactly how a public-key PEM or the pin fingerprint (fixed length) could be swapped. A wrong-length edit crashes V8. No built-in integrity check. |
| Still hookable from outside? | Yes: a patched `crypto.verify` still affects bytecode modules. |
| Verdict | Worth doing later as a *speed bump* (no readable source, no diff-able patch), **after** the vendor-signed manifest (done) and with the pin constants computed rather than stored as plain strings. Effort 2-3 days incl. build/CI/rollback; gain medium-low on its own. A native addon is the next level (hardest to patch, but per-OS builds and a signing/notarisation burden) and is not recommended until customers justify it. |

## 5. Reassessment

| Risk | Before | After (vendor key pinned + `enforce`) | After (as delivered: no key pinned, `warn`) |
|---|---|---|---|
| Licence keygen (forge a licence) | Low | Low (unchanged; private licence key never shipped) | Low |
| Licence bypass by patching code | Easy: patch + re-hash + re-sign (any customer root) | Moderate: must edit the verifier **and** all three pin locations, re-sign with their own key, and avoid env/inspector/preload routes (all now blocked). Not blocked: a root user who consistently rewrites the verifier files and pin (tested, documented limit) | Unchanged, plus runtime audit |
| Runtime hijack (NODE_OPTIONS, NODE_PATH, LD_PRELOAD, inspector, SIGUSR1, patched crypto) | Undetected under enforce | Blocked at start and while running | Audited only |
| Clone / VM copy of an unbound licence | High | High (unchanged - licence design; issue machine-bound licences) | High |
| Trial reset (wipe both stores) | Medium | Medium (unchanged) | Medium |
| Seat-limit bypass by SQL | Medium | Medium (unchanged) | Medium |

Scores (my judgement, same method as the threat-model review - not a measurement):

| | Threat-model review | Now: key pinned + enforce | Now: as delivered |
|---|---|---|---|
| Security | 74/100 | **80/100** | 76/100 |
| Commercial protection | 38/100 | **47/100** | 40/100 |

Your own 10-point table: Forgery 9, Signature 9, Offline 9 unchanged; Tamper detection 8 -> 9; Commercial anti-crack 6 -> 7 (conditional on pinning the key and shipping `enforce`). The remaining gap is architectural: a customer with root who is willing to rewrite the verifier files can still run unlicensed. Closing that needs compiled/obfuscated licensing code, value-bound entitlements enforced server-side, or a connected licence check - none compatible with a pure offline promise.

## 6. Decisions for you

1. Run `integrity-keygen.js --install` once on your machine and commit the three pinned files (this is what activates the vendor signature).
2. Choose how builds get the key: local signing step, or the GitHub secret `DCIM_INTEGRITY_SIGN_KEY` (Windows job already wired). A secret in CI exposes the key to anyone who can edit workflows - local signing is safer.
3. When to make `INTEGRITY_MODE=enforce` the default in packaged `.env` templates (recommended after one UAT cycle).
4. Whether to schedule the Bytenode speed bump.
