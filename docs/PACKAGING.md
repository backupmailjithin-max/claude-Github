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
  fresh random `JWT_SECRET`, tests the DB connection, imports `schema.sql` if
  the database is empty, installs and starts the systemd service / Windows
  service with auto-start on boot, then polls `/api/health` until it reports
  `"status":"ok"`.
- **Upgrade**: snapshots the current `.env` + a file-list tarball, stops the
  service, re-syncs application files (never touching `.env`, `uploads/`,
  `backups/`, or `logs/`), reinstalls the service unit, restarts, and
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
