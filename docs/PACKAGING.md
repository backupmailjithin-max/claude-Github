# DCIM Packaging & Deployment

This implements the DCIM vNext packaging roadmap against the actual DCIM
v3.2.2 webapp. **Read this first:** the app already had far more of the
roadmap built in than the phase descriptions assumed — full Locations/Zones/
Hardware Types/Rack Types CRUD, OCR, a complete backup/restore system with
checksums and retention, deep Dell OME/HPE OneView hardware-pull
integration, CSP, audit-log and log retention, and forced default-password
changes all already existed in `server.js` before any of this work started.
What follows deliberately keeps that code untouched and adds only what was
genuinely missing, as thin, additive layers.

## Gap-closure round (post pre-UAT review)

A pre-UAT validation pass found a specific, named list of gaps. All of them
are closed now; two real bugs were also found and fixed along the way
(discovered only by actually running the installer, not by reading it):

- **`app_settings` now included in Backup/Restore** (`BACKUP_TABLES` in
  `server.js`) — a restore used to silently drop org/branding settings and
  the Infrastructure wizard's OME/OneView/SMTP config. Zero changes to the
  restore mechanism itself were needed: it already iterated `BACKUP_TABLES`
  generically, so this was a one-line fix. Verified by a real backup →
  wipe → restore cycle (see **Real execution evidence** below).
- **Department / Organization Unit** fields added to Organization settings.
- **Favicon upload** (`POST /api/setup/favicon`, served at `/favicon.ico` —
  browsers request that path by convention, so it works with zero changes
  to `index.html` or the compiled frontend bundle).
- **Admin account is now configurable** at install time (`--admin-user` /
  `--admin-password` on Linux, `-AdminUser` / `-AdminPassword` on Windows,
  or `POST /api/setup/admin-account` directly) instead of being permanently
  `admin`/`admin`. Force Password Change still applies exactly as before
  when the default is left in place.
- **Database tab** added to the Setup Wizard — shows the live connection and
  lets you test candidate credentials. It cannot hot-swap the live
  connection (that's a `pool` object created once at process startup); the
  tab says so and points at the installer's `--db-*` flags / `.env` instead.
- **Security tab** added — JWT Secret (generate + set), CSP Mode, and Audit
  Retention. Same constraint as the Database tab and for the same reason
  (all three are consts read once from `.env` at startup in the existing
  security code, which was left untouched): changes write to `.env` and
  need a restart, which the UI states plainly.
- **Backup Retention is now truly configurable** (`app_settings`-backed, no
  restart needed) via the existing `/api/backup/settings` endpoint — default
  raised from the old hardcoded 3 days to 7.
- **Config Export/Import now covers Security settings** (CSP Mode, Audit
  Retention, and an optionally-included JWT Secret) as an opt-in, separately
  from the rest of the bundle. The JWT Secret is encrypted under an
  admin-chosen passphrase (not the server's own `JWT_SECRET`, which would
  make it undecryptable on any *other* server — defeating the point of
  exporting it for DR/migration).
- **Dedicated `dcim-upgrade` / `dcim-repair` utilities** (Linux: `/usr/bin/`;
  Windows: Start Menu shortcuts + `.ps1` files) alongside `install.sh
  --mode upgrade/repair`, which they call internally unchanged.
- **Bug fix: `DB_PORT` was silently ignored.** `server.js`'s `DB_CONFIG` never
  read it, so a non-default MySQL port set via the installer's `--db-port`
  flag had no effect — it always connected on 3306. One-line fix
  (`port: Number(process.env.DB_PORT) || 3306`); default behavior unchanged.
- **Bug fix: schema import used the wrong database.** `install.sh`'s /
  `install.ps1`'s schema-import step piped `schema.sql` straight into
  `mysql -D <configured db>`, but `schema.sql` itself starts with its own
  `CREATE DATABASE datacenter_db; USE datacenter_db;` — overriding whatever
  database the installer actually configured and failing with Access Denied
  the moment the DB user wasn't also granted on that literal hardcoded name.
  Fixed by removing the step entirely: `server.js`'s own `ensureDatabase()`/
  `initDB()` already create and populate the schema automatically on first
  start (confirmed by running it, repeatedly, during this work) — the manual
  import was both redundant and broken.
- **Bug fix: a new endpoint was blocked by the existing password-change
  gate.** `/api/setup/admin-account` wasn't in `MUST_CHANGE_ALLOWED`, so the
  installer's own `apply_admin_account` step couldn't reach it right after a
  fresh install (where the seeded account is always flagged
  `must_change_password`). Fixed by adding one path to that existing
  allowlist — the same allowlist `PATCH /api/auth/change-password` is
  already in, for the same reason.

### Real execution evidence

The previous round's audit noted several things were code-reviewed but
never actually run. This round closes that gap as far as this sandbox
allows, and hands the rest to CI:

- **In this sandbox** (no systemd — verified `PID 1` is a container
  supervisor, not `systemd`; `systemctl` fails immediately): installed for
  real against a live MariaDB, with a `systemctl` stub that performs the
  equivalent real action (actually starts/stops the Node process) so the
  *script logic* runs unmodified end to end. Ran, for real: fresh install →
  populate data via the live API → `--mode upgrade` (real `mysqldump`
  snapshot, real file re-sync, real health recheck) → verified the data and
  the customized admin login survived → deleted a row directly in MySQL →
  `rollback.sh` → verified the row came back → `--mode repair` → verified
  health and data again. Also ran, directly against the live API: logo and
  favicon upload/retrieval, the Database tab's test-connection endpoint
  (success and failure), the Security tab's generate/save/test-email flow,
  and Config Export/Import with Security settings (proved the passphrase
  round-trip with a deliberately *different* JWT secret planted first, not
  a no-op self-test).
- **In CI** (`.github/workflows/test-lifecycle.yml`, manually triggered):
  runs the same install → populate → upgrade → verify → repair → verify →
  delete → rollback → verify cycle for real, on a real `windows-latest` VM
  (real Service Control Manager, real NSSM-registered service — the one
  platform this sandbox genuinely cannot touch) and on `ubuntu-latest`
  (a real VM with real `systemd`, unlike this sandbox). A third job installs
  the built `.rpm` into real `rockylinux:9` / `almalinux:9` containers and
  verifies the package layout and utilities land correctly; it does **not**
  test full service lifecycle there, because containers can't run `systemd`
  as PID 1 under GitHub Actions either — the same limitation this project
  was developed under locally. The `ubuntu-latest` job is the evidence for
  the systemd logic shared across every Linux target; the distro jobs are
  evidence the package itself installs cleanly.

## What's real vs. what already existed

| Roadmap phase | Status | Where |
|---|---|---|
| 1 — Portable deployment package | **Built here** | `packaging/linux`, `packaging/windows` |
| 2 — First-run configuration wizard | **Built here** (org/branding only — DB config was already handled by Phase 1's installer, and the admin account already auto-seeds) | `dcim/webapp/lib/setup-routes.js`, `setup-wizard.html` |
| 3 — Infrastructure configuration (OME/OneView/SMTP) | **Built here** — OME/OneView *hardware pulling* already existed and was env-only; this adds a DB-backed, UI-driven config layer with real Test Connection/Test Email | `setup-routes.js`, `lib/smtp-client.js` |
| 4 — Initial DC setup wizard | **Mostly already existed** (full CRUD for locations/zones/hardware/rack types); only the one-click "seed standard defaults" step was missing | `setup-routes.js` (`/api/setup/seed-defaults`) |
| 5 — Health verification engine | **Already had `/api/health`**; this adds a deeper `/api/health/full` (DB write test, OCR, backup folder, live OME/OneView reachability, SMTP) | `setup-routes.js` |
| 6 — Upgrade manager | **Already existed at the app level** (full DB backup/restore with checksums); this phase adds a real `mysqldump` snapshot + rollback script around Upgrade/Repair specifically | `install.sh` / `install.ps1` `backup_before_change`, `rollback.sh` / `rollback.ps1` |
| 7 — Offline enterprise appliance | **Built here** — one self-extracting file, no internet needed | `packaging/appliance/build-appliance.sh` |
| 8 — Enterprise deployment features | **Mostly already existed** (CSP mode, log/audit retention, JWT secret enforcement were already env-driven); this adds service-control convenience wrappers | `dcim-service.sh` / `dcim-service.ps1` |
| 9 — Deployment dashboard | **Built here** | `deployment-dashboard.html`, `/api/deployment/status` |
| 10 — Future enterprise features (multi-tenant, licensing, HA) | **Not implemented**, per the roadmap's own instruction ("not for initial packaging") | — |
| Config Export/Import wizard | **Built here** (the item explicitly called out as commonly missed) | `setup-routes.js` (`/api/setup/export` / `/api/setup/import`) |

## New backend module

`dcim/webapp/lib/setup-routes.js` (plus `lib/smtp-client.js`, a dependency-free
raw SMTP client used only for the "Test Email" action) is required and
registered from `server.js` with a single ~20-line, additive block — nothing
in the existing 8,600-line file was rewritten. It adds:

- `GET /api/setup/status` (public) / `GET+PUT /api/setup/organization`
  (Admin) — company name, app name, footer text, support email/contact.
- `POST /api/setup/logo` (Admin) — logo upload, served from `/branding/*`.
- `GET+PUT /api/settings/integrations` (Admin) — Dell OME / HPE OneView
  entries (host/user/password per site+zone) and SMTP settings. Passwords
  are AES-256-GCM encrypted at rest (key derived from `JWT_SECRET`) and are
  **applied into `process.env`** in exactly the `OME_<SITE>_<ZONE>_HOST/
  _USER/_PASS` shape the pre-existing monitoring code already reads — so the
  wizard activates live hardware pulls with no restart and zero changes to
  that existing code. A real `.env` value always wins; the wizard only fills
  gaps.
- `POST /api/settings/integrations/test` (Admin) — calls the app's own
  `getOmeToken` / `getOneviewSession` for a real login test, or sends an
  actual test email over raw SMTP (connect/EHLO/STARTTLS/AUTH LOGIN/send).
- `POST /api/setup/seed-defaults` (Admin) — idempotently creates the
  standard hardware types (Dell Server, HPE Server, Storage, Switch,
  Firewall, Load Balancer, HSM, PDU, ATS, Others) and rack types (Compute,
  Storage, Network, Backup, Management, Custom) if missing.
- `GET /api/health/full` (Admin) — DB read+write probe, OCR loaded check,
  backup folder writable check, live reachability of every configured OME/
  OneView zone, SMTP configured flag.
- `GET /api/deployment/status` (Admin) — version, uptime, DB/OCR/SMTP/backup
  status, monitoring zone counts, app URL.
- `GET /api/setup/export` / `POST /api/setup/import` (Admin) — portable JSON
  bundle of org settings, locations, zones, hardware types, rack types, and
  monitoring/SMTP config. **Credentials are never exported** — an imported
  monitoring entry carries host/user only and needs its password re-entered
  via the wizard. For DR, UAT-to-prod promotion, or rolling the same setup
  out to a new site.

Two static admin pages (plain HTML/vanilla JS — the offline bundle doesn't
ship React source, so these aren't part of the compiled SPA) are served
alongside the main app: `GET /setup-wizard.html` and
`GET /deployment-dashboard.html`. Both reuse the main app's `dc_token`
`localStorage` key, so an already-logged-in Admin is recognized
automatically.

All of this was boot-tested against a real MariaDB instance during
development: server start, login, forced password change, every new
endpoint (including a save/load round trip against a throwaway local SMTP
server and deliberately-unreachable OME/SMTP hosts to confirm failures are
reported, not swallowed), logo upload/retrieval, and export → import on a
second simulated "new" bundle.

## Layout

```
dcim/webapp/                  The application payload (Node/Express + MySQL).
  server.js                   ~20 lines added (require + register the new module); nothing else changed.
  lib/setup-routes.js         New: Phase 2/3/4/5/9 + export/import APIs (see above).
  lib/smtp-client.js          New: dependency-free raw SMTP client for the SMTP test action.
  setup-wizard.html           New: standalone first-run / infra-config admin page.
  deployment-dashboard.html   New: standalone deployment status admin page.

packaging/linux/
  install.sh                  Install / Upgrade / Repair, with pre-flight validation.
  uninstall.sh                Stops + disables the service; --purge-data removes files too.
  rollback.sh                 Restores files/.env/database from an Upgrade/Repair's pre-change snapshot.
  dcim-service.sh             `dcim-service {start|stop|restart|status|logs}` convenience wrapper.
  dcim.service.template       Hardened systemd unit (placeholders filled in by install.sh).
  nginx-dcim.conf             Optional reverse proxy config.
  fetch-node-runtime.sh       Build-time helper: downloads a Node runtime to bundle.
  build-deb.sh                Stages a .deb (supports a bundled runtime).
  build-rpm.sh                Stages a .rpm (requires system Node.js today).
  debian/, rpm/                Control files / spec used by the two build scripts.

packaging/windows/
  install.ps1                 Install / Upgrade / Repair, registers a Windows Service via NSSM.
  uninstall.ps1                Removes the service (and optionally the files).
  rollback.ps1                 Restores .env/database from an Upgrade/Repair's pre-change snapshot.
  dcim-service.ps1             `dcim-service.ps1 -Action {start|stop|restart|status}` convenience wrapper.
  fetch-node-runtime.ps1       Build-time helper: downloads a Node runtime to bundle.
  fetch-nssm.ps1               Build-time helper: downloads nssm.exe (service wrapper).
  dcim-installer.iss           Inno Setup script -> compiled to dcim-setup-<version>.exe.

packaging/appliance/
  build-appliance.sh           Phase 7: bundles runtime + webapp + every installer script into
                                ONE self-extracting dcim-appliance-<version>-linux-x64.run file.

.github/workflows/build-packages.yml
                               CI: builds the .deb, .rpm, Windows .exe, and the offline appliance
                               on every tag push (or manual dispatch) and uploads them as artifacts.
```

## Why Node is "bundled" but MySQL isn't

Phase 1 calls for bundling the Node.js runtime, which this does: `fetch-node-runtime.*`
downloads a pinned Node build at **package-build time** (locally or in CI) and the
installers prefer it over any system Node. The runtime itself is never committed to
git — only the scripts that fetch it — so the repository doesn't carry vendored
binaries, and bumping the Node version is a one-line change.

MySQL/MariaDB is intentionally **not** bundled. The installers validate connectivity
to an existing MySQL 8 / MariaDB 10.6+ instance instead of vendoring a database
server. Bundling a full DB engine (an "omnibus" style package, as some enterprise
installers do) is a much larger undertaking — embedded data directory
initialization, its own upgrade/rollback story, platform-specific binaries — and
was deliberately deferred so Phase 1 stays focused on packaging the application
itself. If/when that's wanted, it's a follow-on phase, not a tweak to this one.

## Windows .exe

A real `.exe` can't be compiled on Linux. `dcim-installer.iss` is an [Inno
Setup](https://jrsoftware.org/isinfo.php) script; `build-packages.yml` compiles
it into an actual installer on a `windows-latest` GitHub Actions runner (which
ships Inno Setup preinstalled) and uploads it as a build artifact. To compile
it yourself on a Windows machine with Inno Setup installed:

```powershell
packaging\windows\fetch-node-runtime.ps1
packaging\windows\fetch-nssm.ps1
iscc packaging\windows\dcim-installer.iss
```

## Building locally

**Debian package** (works in most Linux dev environments — `dpkg-deb` is
commonly preinstalled):

```bash
packaging/linux/fetch-node-runtime.sh x64 packaging/linux/runtime   # optional: bundle Node
packaging/linux/build-deb.sh
# -> dist/dcim_3.2.2_amd64.deb
sudo dpkg -i dist/dcim_3.2.2_amd64.deb
sudo dcim-setup          # interactive Install/Upgrade/Repair menu
```

**RPM package** (needs `rpm-build`, e.g. on Fedora/RHEL/Alma):

```bash
sudo dnf install rpm-build
packaging/linux/build-rpm.sh
# -> dist/dcim-3.2.2-1.*.rpm
```

**Raw installer** (no OS package, e.g. for testing or air-gapped drop-in):

```bash
sudo packaging/linux/install.sh            # interactive menu
sudo packaging/linux/install.sh --mode install --yes --db-password 'secret'
```

## What the installer validates before touching anything

Matches the Phase 1 spec:

- **Node runtime** — bundled copy if present, else system `node` on PATH, must be >= v18.
- **Free disk space** — at least 500MB available where the app installs.
- **Required port** — the configured HTTP port must be free on a fresh install.
- **Write permissions** — the target parent directory must be writable.
- **Existing installation** — detected via `.env` presence, driving the
  Install / Upgrade / Repair menu and choice of defaults.

## Install / Upgrade / Repair

- **Install**: creates the `dcim` system user, copies the app, generates a
  fresh random `JWT_SECRET`, tests the DB connection (the app creates and
  populates its own schema on first start — the installer doesn't import
  `schema.sql` itself; see the bug-fix note above for why), installs and
  starts the systemd service / Windows service with auto-start on boot, then
  polls `/api/health` until it reports `"status":"ok"`, then applies
  `--admin-user`/`--admin-password` if given.
- **Upgrade**: snapshots the current `.env` + a real `mysqldump` + a
  file-list tarball, stops the service, re-syncs application files (never
  touching `.env`, `uploads/`, `backups/`, or `logs/`), reinstalls the
  service unit, restarts, and
  re-checks health.
- **Repair**: same as upgrade, plus re-creates the system user/service file
  and re-applies file ownership/permissions if they drifted — for a box where
  the service was deleted, permissions got clobbered, etc.

## Upgrade/Repair now take a real rollback point

`backup_before_change` (shared by Upgrade and Repair in both `install.sh` and
`install.ps1`) now runs `mysqldump` (if present) in addition to the config/
file snapshot it always took, and records the snapshot's path. If an upgrade
goes wrong:

```bash
sudo packaging/linux/rollback.sh                # uses the most recent snapshot
sudo packaging/linux/rollback.sh /var/backups/dcim/20260101-120000  # a specific one
```

```powershell
packaging\windows\rollback.ps1                  # uses the most recent snapshot
packaging\windows\rollback.ps1 -SnapshotDir 'C:\ProgramData\dcim-backups\20260101-120000'
```

This stops the service, restores `.env` and application files, restores the
database from the dump if one was taken, and restarts. It's independent of
(and a coarser safety net than) the app's own Backup/Restore feature, which
remains the right tool for routine, scheduled backups.

## Service control

```bash
dcim-service {start|stop|restart|status|logs}      # Linux, installed by the .deb/.rpm
```
```powershell
packaging\windows\dcim-service.ps1 -Action {start|stop|restart|status}
```

## Offline Enterprise Appliance (Phase 7)

```bash
packaging/linux/fetch-node-runtime.sh x64 packaging/linux/runtime
packaging/appliance/build-appliance.sh
# -> dist/dcim-appliance-3.2.2-linux-x64.run
```

The result is **one file** containing the Node runtime, the full webapp, and
every installer script. Copying that one file to an air-gapped host and
running it is the entire install — no package manager, no separate runtime
install, no internet access at any point:

```bash
sudo ./dcim-appliance-3.2.2-linux-x64.run                       # interactive menu
sudo ./dcim-appliance-3.2.2-linux-x64.run --mode install --yes  # unattended
```

(This was verified end-to-end during development: build, self-extract, and
run through every pre-flight check and the DB-connection failure message —
the only thing that doesn't work without a real MySQL/MariaDB reachable, by
design.) The Windows `.exe` built by `dcim-installer.iss` is already the
Windows equivalent of an offline appliance once built with the bundled
runtime and NSSM staged (see **Building locally** above) — it doesn't need a
separate appliance variant.

## Known limitations / explicit follow-ups

- Unattended (`--yes`) installs use blank/default DB credentials unless you
  pass `--db-*` flags; the `.deb`/`.rpm` postinst therefore only auto-runs on
  **upgrade** (where a config already exists) and tells you to run
  `sudo dcim-setup` interactively on a fresh install.
- RPM packaging and the offline appliance both currently require the Linux
  `.deb`-style bundled-runtime path to have been staged; `build-rpm.sh`
  itself still always requires a system Node.js >= 18 (not yet wired to the
  bundled runtime).
- `/api/settings/integrations/test` and the deep health check's monitoring
  probe make a real network call to whatever OME/OneView host is configured;
  there's no mock mode, so testing them end-to-end needs a reachable
  appliance (verified during development against deliberately-unreachable
  hosts to confirm failures surface correctly, and against a local fake SMTP
  server for the send path specifically).
- Phase 10 (multi-tenant branding, license tiers, automated online updates,
  HA mode) is explicitly not implemented, matching the roadmap's own
  instruction that it's future scope, not initial packaging.
- OME/OneView reachability and SMTP send were tested against deliberately
  unreachable hosts and a local fake SMTP server respectively, to confirm
  failures surface correctly end to end. Neither was tested against a real
  Dell OME / HPE OneView appliance — one wasn't available in this sandbox
  or in CI.
- `test-lifecycle.yml` is `workflow_dispatch`-only (not run on every push),
  since it provisions real databases and takes several minutes per OS —
  trigger it deliberately before a release, not as routine CI.
- The `rockylinux:9`/`almalinux:9` jobs in `test-lifecycle.yml` verify package
  *installation*, not service lifecycle (no systemd in a GitHub Actions
  container, on any distro) — `test-ubuntu-systemd-lifecycle` is the real
  systemd evidence, and it exercises the identical install.sh/systemd-unit
  logic those two distros would run.
