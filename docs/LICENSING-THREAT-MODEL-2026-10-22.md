# DCIM Commercial Offline Licensing — Threat Model Review — 2026-10-22

Assessment only: **no code was changed.** Attacker = a paying customer with full Administrator/root on the machines and database (can edit files, stop services, read packages, set environment, edit startup scripts, restore backups, copy/clone installs, attach debuggers). Every rating below comes from an attack I actually ran against the current build unless marked *reasoned* or *not executed*.

## Final answer
**Can a paying customer realistically continue using the software without purchasing or renewing a valid license?**
**Yes — a technically capable customer with root/Administrator can, and the methods are short and shareable.** A non-technical customer cannot: they cannot forge, edit, extend or replay a license, and an expired license stays expired through restarts, backup restores and a naive clock change. Licensing is a strong *honesty and accident* control and a weak *adversary* control against the stated attacker. This is inherent to a readable Node.js product running on hardware the customer owns; the hardening so far makes it detectable and raises effort, but it cannot make it impossible.

| Practical route (all executed) | Effort (my measurement) | Detected? |
|---|---|---|
| Patch `isLicensingConfigured()` (1 line) **and** re-sign the manifest with a throw-away key (≈12-line script; format is public in `integrity.js`) | Developer: tens of minutes the first time; then a reusable script (minutes) | **No** — integrity reports `ok` even in `enforce` mode |
| `NODE_OPTIONS=--require hook.js` that makes `crypto.verify` return true (one env line in unit / NSSM registry) | Minutes | Audited only (`INTEGRITY_ENV_OVERRIDE`); **not blocked**, even in `enforce`; forged licence → `licensed`, API 200 |
| `kill -USR1 <pid>` → inspector → one `Runtime.evaluate` patching `crypto.verify` in memory (no file, no env change) | Minutes | **No** — integrity stays `ok` |
| Delete `.trial-state` **and** the `license.trialStartedAt/…` DB keys → fresh 10-day trial (repeatable) | Seconds | No (by design) |
| Replace public key + self-signed perpetual licence + re-sign manifest | Tens of minutes | No (without re-signing manifest: caught) |
| Seat limit: insert users directly in MySQL (limit is enforced only in `POST /api/users`) | Minutes | No |
| Use one unbound licence on many installs | Zero | No |

## 1. Commercial threat model (summary)
Assets: (a) who may run the product, until when, for how many users; (b) vendor private key; (c) revenue-bearing renewals. Trust boundary: none — the customer owns the machine, the OS, the Node runtime, the DB and the service config. Therefore the only things the customer **cannot** do locally are those needing the vendor private key (mint/alter licences). Everything enforced by code that runs on their machine is, in principle, removable. Controls are judged by (1) what they stop, (2) how much they raise effort, (3) whether they leave evidence.

## 2. Keygen risk — **LOW**
Ed25519 over the exact payload string; private key absent from the repo, git history (searched for key blocks), tracked files, deb payload and the build gate. Forgery with another key, flipped signature bytes, `alg` none/HS256, and every payload edit (customer, expiry extended/removed, `maxUsers` raised, machine binding removed) all rejected (`BAD_SIGNATURE`/`MALFORMED`). The format has no "feature set" field (only customer, expiry, `maxUsers`, optional `machineId`); an injected `features` field is rejected too. Expired licence → `EXPIRED`. Whitespace outside the signed payload is accepted (harmless; the file monitor audits the change).

## 3. License bypass risk — **HIGH** (difficulty: **LOW for a developer, MEDIUM for a typical IT admin**)
Executed against a freshly built `.deb`:
- Patched one line in `lib/license.js`: `warn` → licensing off, audit `INTEGRITY_VIOLATION`; `enforce` → app refuses to start. **Then re-signed the manifest with the attacker's own key → `integrity=ok, enforced=false, audit none`, licensing off.** The manifest verification key ships *inside* the manifest, so the check is tamper-evidence, not authentication.
- Replaced the public key + self-signed perpetual licence: caught until the manifest is re-signed; afterwards `licensed`, unlimited users, no expiry.
- `licenseBlocked()` and the seat limit live in `server.js` (also re-signable). Source is readable, unobfuscated, with a bundled runtime.
Conclusion: removal of expiry checks, forcing licensed mode, disabling checks are all feasible with a few lines.

## 4. Startup tamper risk — **MEDIUM**
Good against accident and casual editing: modified `server.js`, `license.js`, `license-public-key.js`, `integrity.js`, invalid/garbage/missing manifest, in-memory public-key swap are all detected; `enforce` refuses normal startup and issues a reference ID (68/68 + end-to-end tests). Not good against a deliberate attacker: manifest forgeable (above); the guard is loaded by the code it protects; an entry point that never loads it is unprotected. **Environment overrides are audited but are not an `enforce` trigger** (NODE_OPTIONS hook above).

## 5. Environment injection
| Vector | Result |
|---|---|
| `NODE_OPTIONS=--require` | **Works** as a bypass in every mode; audited only. Unit's `UnsetEnvironment` does not include `NODE_OPTIONS` (memory-tuning use); a root user can edit the unit anyway. |
| `NODE_PATH` | **Ineffective**: installed `node_modules` win over `NODE_PATH` (shim package ignored). Audited/unset. |
| `LD_PRELOAD` | *Not executed.* Reasoned LOW–MEDIUM: bundled Node carries its own statically linked crypto, so hooking libcrypto symbols is unlikely to reach signature verification; libc-level hooks (time, file reads) remain possible. Unset by the unit; root can undo. |
| Inspector via SIGUSR1 / `--inspect` | **Works**, in-memory patch invisible to integrity checks. |

## 6. Binary / source exposure
JavaScript is plain text (also in the package), Node runtime bundled and executable, service definition editable by root/admin. Bypass by code modification is **easy**: one-line edits plus a reusable manifest re-signer. No obfuscation, bytecode, or native component exists.

## 7. Clone risk — **HIGH**
(Executed with mount/UTS namespaces and a fake machine-id.)
| Scenario | Unbound licence | Machine-bound licence |
|---|---|---|
| Copy install + licence to a different server | **Valid** | Rejected (`WRONG_MACHINE`) |
| Same, attacker writes the original machine-id into `/etc/machine-id` (one command) | Valid | **Valid** |
| VM copy / disk clone / restored VM (identical machine-id) | Valid | **Valid** (legacy composite-bound licences also need matching hostname/MAC — slightly harder to spoof than machine-id alone) |
| Copied trial record | n/a | Rejected → trial treated as ended |
Machine binding stops *accidental* and casual copying only. The ID is derived from a value the customer controls; binding to machine-id (the false-lockout fix) is easier to spoof than the old composite. Whether licences are bound at all is an issuing policy (`--machine-id` is optional), so an unbound licence is effectively unlimited-install.

## 8. Trial abuse risk — **HIGH for root**, LOW otherwise
| Attack | Result |
|---|---|
| Delete `.trial-state` only / DB keys only | Still ended (the other copy wins) |
| Delete both | **Reset to 10 days** (known, accepted limit; also a fresh install/VM = new trial) |
| Clock set back after expiry, marks intact | Still ended / licence still `EXPIRED` (high-water mark; survives restart) |
| Clock back **and** `.license-clock` + `.trial-state` + DB marks deleted | **Revived** |
| Restore old DB backup | Backups exclude `license.%` keys → no effect; a full DB-dump restore brings an *earlier* trial start (worse for attacker) *(reasoned)* |
| VM snapshot revert | Reverts all stores → trial days return; a paid licence still expires against the real clock unless the clock is also rolled back *(reasoned)* |

## 9. Service hardening
- **Linux (systemd):** `ProtectSystem=strict`, `ProtectHome`, app code `ReadOnlyPaths`, `NoNewPrivileges`, `ProtectClock`, `UnsetEnvironment` — effective against a compromised service process or a non-root service user; **no protection against root** (edit unit/drop-in, remount, signal, ptrace). Unit renders and validates (`systemd-analyze verify`); read-only layout reproduced with mount namespaces; real systemd start *not executed*.
- **Windows (NSSM):** read from `install.js`: service runs as LocalSystem, `AppDirectory`/stdout settings only, parameters live in the registry (admin-editable, so any admin can add `--require`/environment), no ACL or service-account hardening, code writable by Administrators. Effective hardening ≈ none beyond the runtime env/integrity checks. *Windows not executed.*

## 10. Packaging risk — **LOW**
Verified: no private key blocks in tracked files or git history; deb payload has no `license-*` tools, `license.lic`, `.trial-state`, `.license-clock`, `.env`, key files; only the public key ships. Build gate (`validate-package.js`) fails deb/rpm/appliance/Windows builds on tools, state files, `.env`, key files, key bodies or an invalid manifest (15/15 cases; real build fails with an injected key). No activation secrets exist (activation = signature check). Not secret but exposed: trial HMAC derivation and manifest format are readable in source. *rpm, appliance and Windows installer builds not executed here.* Third-party runtime fixtures (e.g. MariaDB test certs) are name-checked only.

## 11. Advanced hardening — feasibility (not implemented)
| Option | What it changes | Effort | Gain vs. root customer | Notes |
|---|---|---|---|---|
| **Bytenode** (V8 bytecode for licensing core) | Edit text → patch/decompile bytecode | Small–medium | **Medium** | Tied to the exact Node/V8 build — we bundle Node so feasible; hides logic not data; decompilers exist; loader hook still patchable. |
| **Node SEA** (single executable) | JS embedded in binary | Medium–high (bundle node_modules, native/wasm assets) | Low–medium | Blob is not encrypted; recoverable; value mostly as signed single artifact. |
| **Native addon** for verify + self-hash | Moves check out of JS | High (Win/Linux build + signing matrix) | Medium–high | Still binary-patchable; best combined with bytecode and with checks that refuse inspector/env hooks. |
| **Startup self-verification** | Done (warn/restricted/enforce) | — | Low–medium | Weakness is the self-hosted trust root. |
| **Signed manifest enforcement** | Make the key non-forgeable | **Small** | Medium *only if* verifier is also hardened | Sign the manifest with an **offline vendor key** (public half embedded); today's ephemeral per-build key is forgeable by anyone. |
| **Read-only code deployment** | Done on Linux for the service user | Small (root-owned code; Windows ACL + virtual service account) | Low for root | Stops compromised-process tampering, not the admin. |
| Value-bound entitlement (reasoned) | Make the paid part not removable by patching | Medium | **High commercially** | E.g. vendor-signed data/catalog/firmware-baseline bundles and updates released only against valid licences, plus EULA audit rights — protects revenue where code protection cannot. |

## Scores (my judgement, derived from the results above)
- **Keygen risk: LOW. Bypass risk: HIGH. Clone risk: HIGH. Trial-abuse risk: HIGH (root) / LOW (others). Startup-tamper risk: MEDIUM. Packaging risk: LOW.**
- **Security Score: 74 / 100** — cryptography, tamper detection, audit, packaging controls and Linux process hardening are solid; the score is capped by the trust-root and environment/debugger gaps and by Windows.
- **Commercial Software Protection Score: 38 / 100** — against *the stated attacker* (root, motivated, capable): stops forging, editing, expiry replay and casual copying; does not stop patching, hooks, debugger, trial wipe, cloning or seat bypass. Against non-technical customers it is well above this figure.

## Recommended next hardening step
Make the cheap, shareable cracks stop being cheap — in this order, smallest first:
1. **Policy (no code):** require `--machine-id` when issuing licences and bind seat counts per install; record issuances.
2. **Treat code-loading `NODE_OPTIONS`, inspector (`inspector.url()`/execArgv) and a non-native `crypto.verify` as `enforce` violations**, and have `enforce` re-check them periodically. Small change; closes the env-hook and (partially) the debugger route.
3. **Sign the release manifest with an offline vendor key** (public half embedded, never an in-package key) and **compile the licensing core with Bytenode** against the bundled Node, so a crack becomes a per-release binary patch rather than a text patch.
4. Longer term: tie value to the licence (vendor-signed catalogs/updates) and run services under a dedicated account with root/Administrator-owned, read-only code.

## Not executed
LD_PRELOAD; Windows (service, NSSM, ACLs); real systemd start of the new unit; rpm, appliance and Windows installer builds; any real customer environment.
