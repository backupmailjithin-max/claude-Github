# DCIM Internal Edition – Safe Improvement Program (2026-11-03)

Principle: additive, optional, off by default. No existing route, table, setting, screen or workflow is changed. New server code lives in `lib/tls-config.js`, `lib/ops-routes.js` (routes under `/api/ops/*`) and `tools/migration-check.js`. Only three small hooks touch existing files: `monitorFetch` / `smtp-client` pick their TLS options from `tls-config` (identical result while the feature is off), `runBackupJob` calls an optional, exception-proof copy step after a successful backup, and `server.js` registers the module and its timers. New settings are stored in `app_settings` (`ops.*`, `backup.replica*`, `dq.*`, `user.views.*`) – no schema change.

Status legend: **Built + tested** = server side done and tested here; **UI pending** = screen waits for your approval of the preview; **Report only** = as you specified.

## 1. Improvement Assessment Report (all 15 items)

| # | Feature | Status |
|---|---|---|
| 1 | Strict TLS with internal CA (`ENABLE_STRICT_TLS`) | Built + tested (env-driven, no UI needed) |
| 2 | Backup replication (SMB/NFS via mounted path, secondary path) | Built + tested; UI pending |
| 3 | Secrets / security health check | Built + tested; UI pending |
| 4 | LDAP / AD / SSO | Report only (section 8) |
| 5 | Hardware Type catalog | Built + tested; UI pending |
| 6 | Device Name status-text flag | Built + tested; UI pending |
| 7 | Data Quality page + Excel/PDF export | API built + tested; UI pending (export uses the app's existing Excel/PDF libraries) |
| 8 | Scheduled H/W sync | Built + tested; UI pending |
| 9 | Migration Health Checker | Built + tested (standalone tool) |
| 10 | Operational Health dashboard | Built + tested; UI pending |
| 11 | Large inventory optimisation | Partly already in place; opt-in paged API built + tested |
| 12 | Code maintainability | Report only (section 9) |
| 13 | Saved Views | API built + tested; UI pending |
| 14 | QR / barcode | API built + tested; label/scan UI pending |
| 15 | Accessibility review | Report only (section 10) |

### Per-feature detail

**1. Strict TLS** – *Existing:* certificate checks are off for OME/OneView/Redfish calls and SMTP (and `NODE_TLS_REJECT_UNAUTHORIZED=0` for the whole service). *New:* `ENABLE_STRICT_TLS=true` verifies against `INTERNAL_CA_FILE` (PEM, one or many certs) plus the normal public CAs; `TLS_RELAXED_HOSTS` keeps chosen hosts relaxed during staged roll-out; a bad/missing CA file falls back to today's behaviour with a log warning. Explicit strict options override the process-wide `=0` flag (tested). `POST /api/ops/tls/probe` shows which configured appliances would pass. *Impact:* none while off. *Dependencies:* the appliance certificate must be signed by the internal CA and match the host/IP used. *Risk:* Low when off / Medium when on (wrong CA breaks that integration – use probe and relaxed-host list first). *Rollback:* set `ENABLE_STRICT_TLS=false` (or remove) and restart. *Performance:* none. *Compatibility:* old-firmware TLS versions/ciphers still negotiated in both modes. Redfish calls use the same `monitorFetch`, so they follow the same switch.

**2. Backup replication** – *Existing:* backups are saved in `/home/webapp/backups` on the same VM. *New:* optional copy of each new backup (+ `.meta.json`) to a folder, checksum-verified, atomic rename, old copies pruned after N days. SMB/NFS: mount the share on the VM once (fstab) and enter the mounted folder; the app reports the filesystem type (cifs/nfs/local) and warns if the "copy" is on the same disk. Failure never affects the backup: recorded in status, audit log, health page, and (optional) one e-mail per 24 h. *Risk:* Low. *Rollback:* switch off. *Performance:* one file copy after the nightly backup. *Compatibility:* backup/restore code path unchanged (hook is try/catch + fire-and-forget).

**3. Secrets check** – Reads only: `.env` mode (warn if group/other readable), JWT length/placeholder, empty DB password, service running as root, world-writable uploads/backups, process-wide TLS switch, NODE_ENV, pending first-login passwords. Nothing is moved or rewritten. *Risk:* none.

**5/6/7. Data Quality** – Adds `GET /api/ops/data-quality`: Missing Manufacturer, Serial, H/W Details (Dell/HPE servers only), Connectivity (servers), PDU Mapping (per rack, only for sites that have PDUs), Location, Rack, plus Hardware Type not in catalog and Device Name holding status text. Site-scoped to the user's permitted locations, `site` filter, rows returned for client-side filter/sort/export. Catalog = Server, Storage, Network, Firewall, Backup Appliance, PDU with suggested category per raw value; "Accept" records a spelling as standard (stored in `dq.hwTypeCatalog`) – asset data is never edited and saves are never blocked. **Device Name:** flags "No Connectivity", "Not in OME/OneView", "Unknown Device", N/A/TBD etc. for information only; your convention stays valid and the screen has a "hide flagged names" filter. *Risk:* Low (read-only). *Performance:* four indexed queries; fine at ~2,000 assets.

**8. Scheduled H/W sync** – *Existing:* manual "Sync H/W details" button and per-asset sync stay unchanged. *New:* Daily / Weekly / Disabled (default Disabled), time of day, optional site; same pull code as the per-asset sync (copied, route untouched); 3 parallel workers; one run at a time; result with success, failed, skipped and failure list (with the reason, e.g. "Dell OME is not configured for Manesar/AZ-1"). *Risk:* Low–Medium (extra load on OME/OneView at the chosen time – pick off-hours). *Rollback:* set Disabled.

**9. Migration Health Checker** – `node tools/migration-check.js [--app DIR] [--service webapp] [--nginx CONF] [--json]`. Read-only. Checks folders, node version, disk, folder owner vs service account, `.env` permissions, JWT secret (.env or systemd), DB settings, DNS of OME/OneView/SMTP hosts, nginx syntax + proxy port + `/branding` path, app health on its port, database connection and tables. PASS / WARNING / FAIL with a fix line; exit code 0/1/2.

**10. Health dashboard** – `GET /api/ops/health` (Global Admin): disk (app + backup), backup age/failure, backup copy, SMTP (configured), OME/OneView (30-min auto-sync age; `?live=1` signs in), PDU status counts, scheduled-sync result, API/DB. Alerts and warnings derived from the checks. Optional e-mail (default off) when a check fails, at most hourly, using the existing notification recipients. The existing 30-min monitoring, `/api/health`, `/api/health/full` and `/api/health/validate` are untouched.

**11. Large inventory** – Finding: the API already gzips JSON, keeps a short-lived server response cache that is invalidated on every write, and serves static files pre-compressed with ETag/304. What remains is that the browser loads the full asset list. Because the screens filter, sort and export in the browser, switching them to server-side paging would change filtering/export behaviour – against your no-regression rule. So: new opt-in `GET /api/ops/assets` (page, limit, search, filters, sort, ETag/304) is available for lazy-loading screens, and `/api/assets` is unchanged. Recommended next step only if load time becomes a problem: measure first.

**13. Saved Views** – `GET/PUT /api/ops/views?screen=assets`, per user, up to 30 views of filters + sort + columns + default. Users who never save a view see exactly what they see today.

**14. QR / barcode** – Payloads `DCIM:A:<serial>`, `DCIM:R:<site>|<zone>|<rack>`, `DCIM:L:<site>`. `GET /api/ops/qr/labels` supplies data for printable labels; `GET /api/ops/qr/resolve?code=` looks up the existing inventory record (also accepts a plain serial or asset tag, so USB/keyboard-wedge scanners work with no camera). Label drawing needs a small offline QR library vendored into `libs/` (UI step). Camera scanning is not planned (offline VM, browser needs HTTPS + camera permission); scanner-as-keyboard is the supported path. No change to the Material Movement workflow – scanning only fills the existing serial field.

## 2. Implementation Plan
1. Done: server modules, hooks, tests (this build).
2. After your approval of the preview: add Settings → Operations (Health, Backup copy, Security, TLS, Scheduled sync), a Data Quality tab, the Saved Views control and QR labels to `app-compiled.js` (+ min rebuild) with filter and sort on every table.
3. Changed-files update package (apply/rollback scripts) → test on `/opt/dcim-next` → production when you approve.
4. Optional: enable features one at a time (replication → scheduled sync → strict TLS last).

## 3. Risk Analysis
| Item | Risk | Why |
|---|---|---|
| Strict TLS when enabled | Medium | A wrong CA/IP-vs-hostname certificate breaks that integration; mitigated by probe, relaxed-host list, automatic fallback on bad CA file |
| Scheduled H/W sync | Low–Medium | Extra OME/OneView load; off by default, off-hours time |
| Backup replication | Low | Post-backup, best-effort, never throws into the backup |
| Others (security check, data quality, health, views, QR, paged API, checker) | Low | Read-only or per-user storage |

## 4. Dependency Matrix
| Feature | Needs | Touches existing |
|---|---|---|
| Strict TLS | `.env` keys, CA file | `monitorFetch` (OME, OneView, Redfish), `smtp-client` |
| Backup copy | mounted share/path | `runBackupJob` (one try/catch line) |
| Security / Health | – | reads backup config, notification settings, `pdus`, `zones` |
| Data Quality | `assets`, `asset_connectivity`, `asset_hw_details`, `pdus` | none (read) |
| Scheduled sync | OME/OneView `.env` entries | uses `hwProviderFor`, same pull functions |
| Saved views / QR | `app_settings`, `assets` | none |
| Migration checker | node, read access to app folder | none |

## 5. Rollback Strategy
Each feature has its own off-switch (see above) and all new routes are inert until used. Full rollback = the update package's `rollback-update.sh` (restores the previous files; no database changes were made, new `app_settings` rows are ignored by older code). Backups and restore are untouched.

## 6. Effort Estimation (remaining)
UI for Operations + Data Quality: 1 day. Saved Views + QR labels + vendored QR library: 0.5–1 day. Regression and packaging: 0.5 day. Strict-TLS roll-out on site (probe, fix certificates, enable): half a day per environment, dependent on your CA.

## 7. Recommended Priority Order
1. Backup copy (real protection against losing the VM) 2. Security/health pages and `chmod 600 .env` 3. Data Quality (finds the 894 Manesar servers without H/W details) 4. Scheduled sync 5. Saved Views 6. QR labels 7. Strict TLS (last; needs certificates) 8. Paging only if measured slow.

## 8. P1.4 Authentication – architecture proposal (no implementation)
Keep local accounts as the always-available fallback (break-glass admin). Add an optional "directory sign-in" provider in front of `/api/auth/login`: (a) **LDAP/AD bind** – server binds as a service account, looks up the user DN by `sAMAccountName`, verifies by re-binding with the user's password over LDAPS (internal CA, reuses `tls-config`), maps AD groups → role (Admin/Operator/Viewer) and location_access; (b) **SSO** (SAML 2.0 or OIDC via ADFS/Entra) later, behind a reverse-proxy or library, issuing the same JWT. Needs: a new `auth_provider` column or `app_settings` mapping table (the only schema candidate), a "directory users" mode where password fields are hidden, group-to-role table, and lockout/audit parity. Risks: offline VM cannot reach cloud IdPs (AD/LDAPS on-prem only); account lifecycle (disable in AD must disable here – check at each login). Recommendation: LDAPS first, 2–3 days, feature-flagged off.

## 9. P4.12 Code maintainability – roadmap (no implementation)
Current state: `server.js` ≈ 10k lines, `app-compiled.js` ≈ 17.5k lines hand-edited with no separate source. *Roadmap:* (1) freeze behaviour with API contract tests (login, assets, movements, backup/restore, health) – extend `tests/`; (2) keep extracting route groups into `lib/*-routes.js` (the pattern already used for setup, PDU, Redfish, visitors, ops); (3) split the client bundle by tab into source modules with a small build (esbuild) that still emits `app-compiled.js`/`.min.js` so deployment stays "copy changed files"; (4) add the Playwright smoke suite (sign-in, each tab opens, add/edit asset, export) to CI; (5) lint + type-check gradually (`// @ts-check`). *Migration plan:* one extraction per release, each guarded by the contract tests and a before/after bundle diff; never combine refactor and feature in one package.

## 10. P5.15 Accessibility review – remediation report (no redesign)
Measured from the code: 36 `aria-label`s, no `role=` attributes, 5 `tabIndex`, 15 `onKeyDown` handlers in the bundle; viewport meta present; responsive breakpoints at 640–1180 px; `prefers-reduced-motion` honoured (5 rules). Findings: (1) **Contrast** – the faint text colour `#94a3b8` on white is about 2.6:1 (AA needs 4.5:1) and is used for hints/column headers; `#64748b` (4.8:1) passes. Fix: use `#64748b` for text, keep `#94a3b8` for decoration only. (2) **Keyboard** – clickable cards/rows built from `div` need `tabIndex=0`, `role="button"` and Enter/Space handling; modals should trap focus and close on Esc. (3) **Screen readers** – no landmark roles; add `role="navigation"/"main"`, `aria-current` on the active tab, `aria-live` for toast messages, `scope` on table headers. (4) **Small screens** – wide tables rely on horizontal scroll with the floating scrollbar; confirm tap targets ≥ 44 px on tablets. (5) **Focus ring** – 25 `outline` rules in the bundle; verify none is `outline:none` without a replacement. Effort: about 1 day for items 1–3 with no visual redesign (colour value + attributes only).

## Test evidence (this build)
`npm test`: 12/12 pass. API run (live MySQL): TLS status/probe, security, data quality, catalog accept, backup copy (success, bad path rejected, failure recorded and shown on health without breaking the backup), scheduled-sync run, health (normal + live), paged assets with ETag/304 and SQL-injection input, saved views, QR labels/resolve, unauthenticated access rejected, existing `/api/assets` unchanged. Strict-TLS matrix against a real internal-CA HTTPS server: off → both servers accepted; strict+CA → CA-signed accepted, self-signed rejected; bad CA file → falls back to relaxed; relaxed host → accepted; works with `NODE_TLS_REJECT_UNAUTHORIZED=0` set.
