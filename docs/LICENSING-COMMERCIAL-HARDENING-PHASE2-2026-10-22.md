# DCIM Licensing Commercial Hardening - Phase 2 (2026-10-22)

Scope held exactly as specified: no change to the licence format, the activation API, existing licences or the offline activation workflow.

## What was implemented

| # | Requirement | Result |
|---|---|---|
| 1 | Vendor-pinned integrity manifest - mandatory release requirement | **Done.** Once `integrity-keygen.js --install` has pinned a vendor key, `package_gate` (shared by the deb, rpm and appliance builders) now refuses to build at all without `DCIM_INTEGRITY_SIGN_KEY_FILE` set - there is no silent fallback to a self-signed manifest after pinning. Before pinning, `DCIM_RELEASE_BUILD=1` makes a build that tries to skip pinning fail outright, with the one-time setup step named in the error. |
| 2 | `INTEGRITY_MODE=enforce` by default for customer packages | **Done.** Both `.env` writers (`packaging/linux/install.sh`, `packaging/windows/install.js`) now write `INTEGRITY_MODE=enforce` on a **fresh install**. Upgrades and repairs never touch `.env` (verified by reading the call sites: `write_env_file`/`writeEnvFile` are only reached from the install path), so every existing customer keeps whatever mode they already have. |
| 3 | Compile `license.js`/`integrity.js` with Bytenode | **Done, as an optional build step** (`DCIM_BYTENODE=1`, wired into `package_gate` for deb/rpm/appliance). Bytenode is vendored (MIT, unmodified) at `lib/vendor/bytenode` rather than depending on `npm install` timing during packaging. `packaging/tools/bytenode-compile.js` compiles both files with the **exact bundled Node binary that will ship** (bytecode is tied to that build) and replaces each with a 2-line loader stub; nothing else in the codebase changes, because every other file still does `require('./license')` / `require('./integrity')` at the same path. The integrity manifest now hashes both the stub **and** the `.jsc` bytecode next to it, so swapping either one alone is still caught. |
| 4 | Machine-bound licences required for customer releases | **Done, in the issuing tool only** (`tools/license-issue.js`): `--machine-id` is now required unless `--allow-unbound` is passed explicitly for an intentional exception (e.g. an evaluation copy). The licence format, the activation API and `license.js` are untouched - this is a policy gate at the point where *you* issue a licence, not a client-side change. |
| 5 | Dedicated restricted service account | **Linux: already in place**, confirmed by reading `install.sh` - the systemd unit runs as the unprivileged system user `dcim` (no shell), not root. **Windows: implemented** - `installWindowsService` now creates (or resets the password of) a dedicated local account `DcimSvc`, grants it only the "log on as a service" right (via `secedit`, since NSSM/`sc.exe` don't grant that right by themselves) and explicitly denies interactive/network/remote-desktop logon, then runs the NSSM service as that account instead of LocalSystem. ACLs mirror the Linux unit's `ReadOnlyPaths=` list: the account gets Modify on the webapp folder (for `uploads/`, `backups/`, `logs/`, `.env`, `license.lic`, `.trial-state`, `.license-clock`) but an explicit **deny** on write/delete for `server.js`, `lib/`, `node_modules/`, `tools/`, the compiled app bundles, the HTML entry points, `schema.sql`, `package*.json` and `integrity.manifest.json`. |

## Security impact

- Code-patch-and-reforge bypass now requires, at minimum: editing the verifier, the stub(s) *and* the vendor-signed manifest - not possible at all once a vendor key is pinned, since the attacker cannot produce a valid signature.
- Runtime hijacking and inspector abuse already refuse startup under `enforce` (phase 1); phase 2 makes `enforce` the shipped default instead of an opt-in.
- Bytenode removes readable source for the two files that matter most, at the documented limit that a same-length constant edit inside a `.jsc` is undetectable by Bytenode alone - which is exactly why both the stub and the `.jsc` are now in the signed, hashed file set: that attack is caught by the manifest, not by Bytenode.
- A licence issued without `--machine-id` is now a deliberate, logged exception rather than an easy default, closing the simplest "copy the .lic file" sharing path for new customers.
- Windows no longer runs the application as LocalSystem; a compromised Node process cannot rewrite its own licensing code, matching the Linux unit.

## Upgrade impact

- Licence format, activation API, `lib/license.js`'s verification logic, and existing `.lic` files: **unchanged**. A licence issued before this change still activates after it.
- Existing customers keep their current `.env` (including `INTEGRITY_MODE`) through upgrade/repair; only a **fresh** install gets `enforce` by default.
- Bytenode and vendor-signing are **both opt-in** (`DCIM_BYTENODE=1`, and vendor signing only engages once you run the one-time `integrity-keygen.js --install`). As delivered, the repo builds exactly as before phase 2: self-signed manifest, plain-JS licensing code.
- Windows installs (fresh and upgrade) now also create/reset the `DcimSvc` account and ACLs every time `installWindowsService` runs - there is no persisted secret to manage, since the password is regenerated and the service reconfigured on every install, upgrade and repair.

## Test results

- Unit (licence) 51/51, API e2e 40/40 - against the delivered defaults (no key pinned, no Bytenode) and again against a tree built with `--sign-key`/Bytenode both enabled, after fixing a test-harness mistake (it had briefly overwritten the suite's test licence key with the production placeholder key - not a product bug).
- Full application regression suite: 173/175, identical to the unmodified baseline (the 2 failures are pre-existing, fixture-dependent, unrelated to this work).
- `package_gate` behaviour verified directly (6 scenarios): plain build passes self-signed; `DCIM_RELEASE_BUILD=1` without a pinned key fails with the right message; a pinned key without `DCIM_INTEGRITY_SIGN_KEY_FILE` fails; a pinned key with the file set builds vendor-signed; `DCIM_BYTENODE=1` without a bundled-node path fails; `DCIM_BYTENODE=1` with one compiles and the resulting tree boots and passes validation.
- Bytenode-compiled tree: server boots normally, `/api/health` responds, and tamper tests confirm both the stub and the `.jsc` are individually detected by the integrity check.
- `license-issue.js`: confirmed it refuses an unbound issuance by default and succeeds with either `--machine-id` or `--allow-unbound`, producing the same activation-code format as before.
- Windows service-account code: syntax-checked and logic-reviewed; **not executed** - no Windows host is available in this environment. Same standing limitation as every other Windows change in this project; recommend validating on a real Windows VM before a release that enables it (it is already live in `installWindowsService` with no flag, since it was asked for as a direct requirement rather than an opt-in - see Decisions below).

## Commercial protection score

Using the same method as the Anti-Crack Review:

| | Before Phase 2 (key pinned + enforce) | After Phase 2, fully enabled (pinned key + enforce + Bytenode + machine-bound) | After Phase 2, as delivered (nothing opted in yet) |
|---|---|---|---|
| Security | 80/100 | **85/100** | 76/100 |
| Commercial protection | 47/100 | **58/100** | 42/100 (service-account change alone helps Windows) |

This lands short of the 65-75 range suggested in the prompt; the gap is the same architectural one noted in the Anti-Crack Review - a customer with root/administrator who is willing to patch every one of the (now more numerous) protected files and re-sign is still not stopped, only slowed further. Reaching 65+ would need a server-side or periodically-online licence check, which is out of scope for an offline product, or a native (compiled, OS-signed) licensing module rather than V8 bytecode.

## Rollback plan

- Everything in this phase is file-level and additive; reverting is `git revert` of this commit, or redeploy the previous `lib/integrity.js` + `tools/license-issue.js` + packaging scripts.
- A customer already on `INTEGRITY_MODE=enforce` by default (new install) can set `INTEGRITY_MODE=warn` in their `.env` and restart to fall back to tamper-evidence-only, with no data or licence impact.
- A build made with Bytenode/vendor-signing can be rolled back to a plain build simply by not passing `DCIM_BYTENODE=1` / `DCIM_INTEGRITY_SIGN_KEY_FILE` on the next build - there is no one-way migration.
- The Windows service account change can be reverted by restoring the previous `installWindowsService` (runs as LocalSystem again) and running `net user DcimSvc /delete` plus removing the icacls entries, if ever needed.

## Decisions still for you

1. Run `integrity-keygen.js --install` and decide how the private key is held for signing (local step recommended over a CI secret, per the Anti-Crack Review).
2. Decide whether to turn on `DCIM_BYTENODE=1` for releases (works per the test above; costs a slightly more complex release process since it's tied to the exact bundled Node build).
3. Get the Windows service-account change validated on a real Windows VM before relying on it in a release - it is unconditional (not flagged), since it was requested as a direct requirement, but it has not been executed here.
4. Decide when to require `--machine-id` as a hard stop in your own release checklist (the tool already enforces it; this is a process reminder, not a code change).
