# DCIM Enterprise Offline Kit – Open Gap Closure
Date: 2026-10-22 · Branch `trial-autolock-expand-packaging` · Version 3.2.2
No application behaviour was changed (only installer/uninstall/rollback scripts).

## Decision
**READY FOR UAT cannot be issued yet.** The decision rules require Windows and real-systemd certification, which need machines this environment does not have. Everything that could be executed here passed, and the Linux build is ready to hand to a UAT team.
**READY FOR PRODUCTION: no** (needs UAT, real OME/OneView/PDU and all platforms).

## Gap status
| Gap | Status | Notes |
|---|---|---|
| 1 Windows certification | **OPEN – not executed** | No Windows host. Installer source patched (DB snapshot port) and syntax-checked only. The Windows `.exe` built successfully in CI but was never run. Runbook below. |
| 2 Real systemd | **OPEN – not executed** | Only a test stand-in for service control was available. Auto-start on boot, `Restart=always`, recovery after kill/reboot are unproven. |
| 3 Real appliances (OME, OneView Gen10–12, PDU) | **OPEN – not executed** | Only mock appliances/SNMP simulator: OME+OneView 16/16, PDU 32/32. |
| 4 UAT sign-off | **OPEN – needs people** | Role matrix automated (below); human sign-off sheet provided. |
| 5 Packaging hardening | **CLOSED (Linux)** | Fresh clone → build → install → start passes with no manual steps. Windows install of the fresh build not executed. |
| 6 Backup coverage | **CLOSED with one finding (F8)** | Exact recovery proven; coverage list below. |
| PKG-001 rollback cleanup | **DONE + tested** | Files added by a newer version are removed; `.env`, uploads, backups, logs, licence/trial and node_modules preserved. Linux only. |
| PKG-002 uninstall messaging | **DONE + tested** | Embedded DB wording correct for purge / non-purge. Linux only. |

## Platform certification
| Platform | Status |
|---|---|
| Windows 10 / 11 / Server 2019 / Server 2022 | NOT EXECUTED |
| Ubuntu (24.04-class host, real `.deb`, embedded DB, no live systemd) | PASS for install, upgrade, repair, rollback, uninstall; systemd behaviours NOT proven. Ubuntu 22.04 not run. |
| Rocky 9 / AlmaLinux 9 / RHEL 9 | NOT EXECUTED (`.rpm` built in CI, never installed) |

## Packaging report (Linux, this run)
| Step | Result |
|---|---|
| Install (clean, embedded DB) | PASS – health ok, version API, `.env` 600, OCR, 23/23 new-customer checks |
| Upgrade | PASS – database snapshot now taken (after F1–F3 fixes), data intact |
| Repair | PASS – removed file restored, data intact |
| Rollback | PASS – files and database back to the exact snapshot; newer-version files removed |
| Backup / Restore | PASS – 24 tables, row counts and checksums identical after delete + restore |
| Uninstall | PASS – app and embedded DB services removed, no process left |

## Backup coverage (F8)
Included: users, assets (this includes store inventory), asset movements (transfers), locations, zones, racks, floor plans, rack/hardware types, issues, DC activities, material movements and documents, firmware targets and model targets, connectivity, hardware details, app_settings (except machine-bound licence/trial keys).
**Not included: PDU inventory (`pdus`) and power readings, audit logs, firmware jobs/compliance cache.** Monitoring connection settings (OME/OneView host/user/password) live in `.env`, which is deliberately outside the backup (secrets). No separate branding or security-settings table exists in this build.
**F8 (Medium):** after a restore onto a new machine the PDU list would have to be re-created. Fixing it means adding `pdus` to the backup table list, which changes the backup format; not done without your approval.

## UAT role matrix (automated, 44 checks, all behave as designed)
| Check | Viewer | Operator | Site Admin | Global Admin |
|---|---|---|---|---|
| View assets | allow | allow | allow | allow |
| Create asset | deny | allow | allow | allow |
| List / create users | deny | deny | deny | allow |
| Run backup / restore | deny | deny | deny | allow |
| Monitoring read | allow | allow | allow | allow |
| Firmware sync | deny | allow | allow | allow |
| OCR extract | deny | allow | allow | allow |
| Audit log | deny | deny | deny | allow |
| No token | 401 | 401 | 401 | 401 |

Human sign-off sheet (to be completed by named testers):
| Module | Viewer | Operator | Site Admin | Global Admin |
|---|---|---|---|---|
| Authentication, User Management, Inventory, Lifecycle, Transfers, Store, OCR, Similarity, Monitoring, OME, OneView, Firmware Compliance, Reports, Exports, Backups, Restore, Rollback | ☐ | ☐ | ☐ | ☐ |
Tester / date / signature: ______________________

## Appliance validation report
| System | Status |
|---|---|
| Dell OME | NOT VALIDATED on real hardware (mock 16/16) |
| HPE OneView (Gen10, Gen10 Plus, Gen11, Gen12) | NOT VALIDATED on real hardware (mock) |
| PDU (SNMP, capacity, power metrics) | NOT VALIDATED on real hardware (simulator 32/32) |

## Findings
| # | Severity | Finding | Status |
|---|---|---|---|
| F1–F5 | High/Medium | Embedded-DB snapshot and rollback, uninstall, `.env` permissions (see CERTIFICATION-2026-10-22) | Fixed, retested on Linux |
| F6 | Low | Rollback left newer files | Fixed (PKG-001) |
| F7 | Low | Uninstall embedded-DB wording | Fixed (PKG-002) |
| F8 | Medium | PDU inventory not in backup | Open, awaiting approval |
| F9 | Info | Windows copies of the F1/F2 fixes are untested | Open until Gap 1 |

## Scores
| Score | /10 |
|---|---|
| Packaging readiness | 8.2 |
| Operational readiness | 8.3 |
| Security readiness | 8.8 |
| UAT readiness | 8.5 |
| Production readiness | 7.5 |

## Runbooks for the open gaps
**Windows (each OS):** run `dcim-setup-3.2.2.exe` → confirm service `dcim` (NSSM) Running and Automatic, embedded DB service Running, `curl http://localhost:8974/api/health`, `/api/version`, a log file in `webapp\logs`; then `DCIM-Upgrade`, `DCIM-Repair`, rollback script, uninstall. Capture `sc query`, `nssm status`, installer log, health JSON.
**Real systemd (each distro):** `sudo dcim-setup --mode install --embedded-db`; `systemctl is-enabled dcim`; `sudo kill -9 $(systemctl show -p MainPID --value dcim)` and confirm it returns in ~3 s; `sudo reboot` and confirm health afterwards; repeat for upgrade/repair/rollback.
