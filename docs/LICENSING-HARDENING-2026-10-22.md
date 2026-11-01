# DCIM Licensing Hardening — 2026-10-22

Scope: security hardening only. Unchanged: Ed25519 scheme, license file format, offline activation, `POST /api/license/activate` contract (same inputs, same `{success,status}` / `{error,status}` shapes), existing licenses, company workflows, business modules.

## Changes
| # | Change | Where |
|---|---|---|
| 1 | Activation **validates first**, writes a private temp file (mode 600, same directory), re-verifies it, then **atomic rename**. A rejected upload never touches the installed license. | `lib/license.js` `installLicense`, `server.js` activate route |
| 2 | **Clock high-water mark** (signed, in `.license-clock` + `app_settings license.clockSeen*`, hourly persist). Expiry of licenses *and* trial uses `max(system clock, mark)`. Deleting one store does not clear it; restore cannot reset it (`license.%` excluded from backup). | `lib/license.js` |
| 3 | **Machine binding**: primary = hash of OS machine-id; the old composite (machine-id+MAC+hostname) remains an *accepted* secondary so every existing license/trial record stays valid. Hostname/NIC changes no longer break licenses bound to the primary ID. | `lib/license.js` |
| 4 | `license.lic` written mode **600**; existing 644 files tightened at startup (content untouched). New state file also 600. | `lib/license.js`, `server.js` |
| 5 | **Audit**: `LICENSE_UPLOAD_INVALID`, `LICENSE_UPLOAD_TAMPERED`, `LICENSE_ACTIVATE_FAILED`, `LICENSE_TAMPERED` (stored file), plus `LICENSE_CLOCK_ROLLBACK`, `LICENSE_TRIAL_TAMPERED`, `LICENSE_CLOCK_STATE_TAMPERED`. Rows hold reason, size, short hash, and licenseId/customer only when the signature was valid — never file contents. Stored-file events are de-duplicated per process. | `lib/license.js`, `server.js` |
| 6 | Appliance build now strips `tools/license-*`, `Run-License-Generator.bat`, `LICENSE-ISSUE-TEMPLATE.txt` and any dev `license.lic` / `.trial-state` / `.license-clock`, and **fails the build** if any remain (deb, rpm, Windows already stripped). `.license-clock` added to upgrade/rollback/Windows preserve lists and package excludes. | `packaging/**` |

## Risk assessment
| Risk | Level | Note |
|---|---|---|
| Valid license destroyed by bad upload | Removed | was Medium |
| Clock rollback revives expired license/trial | Low (was Medium) | Local admin who deletes `.license-clock` **and** the DB keys, or edits code, still can — inherent to offline Node |
| False lockout after hostname/NIC change | Low (was Medium) | Only for licenses bound to the new ID; legacy-bound licenses keep old behaviour until re-issued |
| False lockout from a wrongly-future clock | Low | Recovery documented in `docs/LICENSING.md` |
| Vendor tools reach customers via appliance | Removed | Guarded in build |
| Local code patching / key replacement | **Unchanged (HIGH locally)** | Out of scope; see assessment recommendations (code integrity) |

## Backward compatibility
- License format, signatures, API routes/fields: unchanged. Rejection text on a bad upload is now "License not applied (your existing license, if any, is unchanged): …" (was "License file saved, but is not valid: …"); HTTP 400 and `status` field as before.
- Existing licenses: unbound and legacy-bound both verified valid in test; `status` gains optional field `binding`.
- Fingerprint shown in the UI / `GET /api/license/fingerprint` is now the machine-id based one (same format, 32 hex). Vendors may issue against either value.
- Existing trial records (signed with the composite key) are accepted and silently re-signed with the new key on first start; a forged one is still "trial ended".
- Hosts without an OS machine-id fall back to the composite (identical to old behaviour).
- Downgrade to the previous build: the old code only knows the composite trial key, so a trial record re-signed by this version is read as tampered (trial ended) on hosts that have an OS machine-id. Licensed installs are unaffected (`license.lic` is unchanged). Use the pre-upgrade snapshot (`dcim-rollback`), which restores the old trial record, for a clean rollback.

## Test results (isolated copy, throwaway keys, vendor key never present)
- Unit: **51/51** — verification, tamper/alg-downgrade/foreign-key/garbage rejection, legacy-bound license valid, hostname change (primary stays valid, legacy fails as before), legacy fingerprint byte-identical to original algorithm, 6 bad-upload kinds leave file byte-identical (same inode, no temp files), mode 600, clock rollback (in-process, after restart, file deleted, forged file), legacy-signed trial accepted and migrated, forged trial rejected, event de-duplication, no content in events.
- API end-to-end: **40/40** — 7 bad-upload kinds (pasted code) + multipart tampered file all 400 with installed license intact; multipart valid file; binding via displayed and legacy ID; non-admin denied; stored-file tamper → locked + `LICENSE_TAMPERED`; all audit actions present with status=failure and no file content.
- Clock rollback end-to-end with real server restarts (+3 days, then back): stays locked/expired; `LICENSE_CLOCK_ROLLBACK` audited.
- Earlier activation regression (`act.js`) now passes the former overwrite check (A5).
- Full 175-check regression suite: **173/175 identical to the unmodified-code control run** (the same 2 fixture-dependent checks fail on both: bulk-rows fixture, firmware-compliance mock).
- Packaging: appliance strip block executed on a copy (tools removed; guard fails the build when a tool survives, verified). `bash -n`/`node --check` on all edited scripts.
- **Not executed**: real deb/rpm/appliance/Windows installer builds and installs (no node runtime in this sandbox), upgrade path preserving `.license-clock` on a real host, Windows.

## Rollback plan
1. Application: restore `lib/license.js` and `server.js` from the pre-change commit (`git revert` of this commit), or on a customer host run `dcim-rollback` (snapshot taken by `dcim-upgrade`).
2. `license.lic` is never rewritten by the hardening except on a new activation; no data migration to undo.
3. Optional cleanup after rollback: delete `.license-clock` and `DELETE FROM app_settings WHERE k LIKE 'license.clock%';`.
4. See the downgrade note above for trial records.
