# DCIM Enterprise Offline Kit – Packaging Completion & Functional Certification
Date: 2026-10-22 · Branch `trial-autolock-expand-packaging` · Version 3.2.2

## Decision
- **CONDITIONALLY READY FOR UAT – Linux (systemd hosts, embedded or external DB).**
- **Windows: NOT CERTIFIED.** No Windows machine was available; the installer was never executed.
- **NOT READY FOR PRODUCTION** – requires UAT sign-off and every platform certified (criteria in the brief).

## What was and was not executed
| Item | Status |
|---|---|
| WP-001 Windows Server 2019/2022, Win 10/11 lifecycle | **NOT EXECUTED** (no Windows host). Source patched, syntax-checked only. |
| WP-002 Ubuntu 22.04 / 24.04 / Rocky 9 / Alma 9 / RHEL 9 | **Partially executed**: one Ubuntu-24.04-class host, real `.deb`, **no live systemd** (service control by a test stand-in, so auto-start-on-boot, `Restart=always` and the unit's sandboxing were not exercised). Other distros and the `.rpm` not executed. |
| WP-003 Fresh clone | **PASS** |

## Gates
| Gate | Result | Evidence |
|---|---|---|
| 0 Source integrity | PASS | all `server.js`/`lib`/`ocr` files syntax-check; 0 unresolved `require()`; dependencies committed |
| 1 Fresh clone | PASS | clean `git clone` → no `npm install` needed, OCR engine + language data vendored (`langPath`/`corePath` local), no runtime download code |
| 2 Package build | PASS (deb) | `.deb` rebuilt from the fresh clone; webapp payload byte-identical to the CI-built package. rpm/exe: built by CI earlier; **rebuild pending for the fixes below** |
| 3 Install | PASS (Linux) | embedded DB, health `ok`, version API, `.env` mode 600, CSP enforced, OCR works, 23/23 new-customer checks |
| 4 Upgrade | PASS (simulated) | payload version bumped 3.2.2→3.2.3→…→3.2.6; data counts unchanged each time |
| 5 Repair | PASS | deleted `app-compiled.min.js` restored; users/assets/issues unchanged |
| 6 Backup/Restore | PASS | backup → deleted assets/issues/targets → restore: **24 tables, row counts and checksums identical** |
| 7 Rollback | PASS after fix | upgrade → delete data → rollback: files back to previous version, DB back to exact counts |
| 8 Runtime | PASS | restart, health, idle sign-out (10 min warning + sign-out) |
| 9 Security | PASS | see below |
| 10 Offline deployment | PASS, limited | everything needed ships in the package; sandbox is network-allowlisted, **not** a true air-gap |

## Findings (all packaging; no application logic changed)
| # | Severity | Finding | Status |
|---|---|---|---|
| F1 | High | With the embedded DB, the pre-upgrade/repair snapshot silently contained **no database dump** (dump targeted port 3306, DB is on 3307), so rollback could not restore data. Rollback restore had the same port omission. | Fixed in `install.sh`, `rollback.sh`, `windows/install.js`, `windows/rollback.js` |
| F2 | High | Even with the right port, MySQL-8 `mysqldump` against the bundled MariaDB aborted (`COLUMN_STATISTICS`). | Fixed: feature-detected `--column-statistics=0` (Linux + Windows) |
| F3 | Medium | Flag detection used `--help \| grep -q` under `pipefail`; early grep exit could drop the GTID flag intermittently. | Fixed: help text captured once |
| F4 | Medium | `uninstall.sh` did not stop/remove the embedded-DB service; on a real systemd host it would leave a running DB with its files deleted and an orphan unit. | Fixed |
| F5 | Medium | Repair/upgrade did not re-assert `.env` mode 600 although the message says permissions are re-applied. | Fixed |
| F6 | Low | Rollback extracts the old file snapshot over the tree; files added by the newer version are not removed (version/behaviour revert, extra files remain). | Open |
| F7 | Low | Uninstall `--purge-data` message says the DB "was NOT touched", which is wrong for the embedded DB (its data lives under `/opt/dcim`). | Open (wording) |

## Functional validation (no regression)
| Area | Result | Evidence |
|---|---|---|
| Authentication, sessions, lockout, forced change, revocation | PASS | 177-check suite 177/177 |
| Inventory, lifecycle, import template, exports | PASS | suite + 19/19 export reports earlier |
| Transfers (accept & install / move to store / reject), Store, rack utilisation | PASS | suite |
| OCR | PASS | PNG, JPG, WEBP, PDF, 3-page PDF (DC + invoice + POD): doc type, per-field confidence, serials; DB counts unchanged after extraction (no auto-save) |
| Similarity | PASS | suite: similar serial saves with warning; exact duplicate → 409 |
| Monitoring / Dell OME / HPE OneView / Firmware compliance | PASS | suite + 16/16 mock-appliance tests (real appliances not available) |
| PDU capacity | PASS | 32/32 against a minimal SNMP simulator (no real PDUs) |
| Reports / Exports / Backups / Restore | PASS | above |
| Security | PASS | JWT tamper/alg=none, revocation, password policy, CSP enforce, upload/MIME/double-extension, SQL error masking, audit log |

## Scores (honest, evidence-weighted)
| Score | /10 |
|---|---|
| Build completeness | 9.0 |
| Packaging readiness | 8.0 (Windows unexecuted, rpm not installed) |
| Security | 8.8 |
| Operational readiness | 8.3 |
| UAT readiness | 8.7 |
| Production readiness | 7.5 |

## To reach production certification
1. Run the Windows installer lifecycle on Server 2019/2022 and Windows 10/11.
2. Run the Linux lifecycle on a host with real systemd for each target distro, including reboot auto-start and `kill -9` restart.
3. Validate against at least one real Dell OME, HPE OneView and PDU.
4. UAT sign-off.
