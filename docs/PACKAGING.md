# DCIM Packaging (Phase 1 — Portable Deployment Package)

This implements Phase 1 of the DCIM vNext packaging roadmap: converting the
existing DCIM webapp into installable Linux and Windows packages, without
changing application behavior.

## Layout

```
dcim/webapp/                  The application payload (Node/Express + MySQL),
                               unchanged from the source offline build.

packaging/linux/
  install.sh                  Install / Upgrade / Repair, with pre-flight validation.
  uninstall.sh                Stops + disables the service; --purge-data removes files too.
  dcim.service.template       Hardened systemd unit (placeholders filled in by install.sh).
  nginx-dcim.conf             Optional reverse proxy config.
  fetch-node-runtime.sh       Build-time helper: downloads a Node runtime to bundle.
  build-deb.sh                Stages a .deb (supports a bundled runtime).
  build-rpm.sh                Stages a .rpm (requires system Node.js today).
  debian/, rpm/                Control files / spec used by the two build scripts.

packaging/windows/
  install.ps1                 Install / Upgrade / Repair, registers a Windows Service via NSSM.
  uninstall.ps1                Removes the service (and optionally the files).
  fetch-node-runtime.ps1       Build-time helper: downloads a Node runtime to bundle.
  fetch-nssm.ps1               Build-time helper: downloads nssm.exe (service wrapper).
  dcim-installer.iss           Inno Setup script -> compiled to dcim-setup-<version>.exe.

.github/workflows/build-packages.yml
                               CI: builds the .deb, .rpm, and Windows .exe on every
                               tag push (or manual dispatch) and uploads them as artifacts.
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

## Known limitations / explicit follow-ups

- Unattended (`--yes`) installs use blank/default DB credentials unless you
  pass `--db-*` flags; the `.deb`/`.rpm` postinst therefore only auto-runs on
  **upgrade** (where a config already exists) and tells you to run
  `sudo dcim-setup` interactively on a fresh install.
- RPM packaging doesn't support the bundled-runtime path yet (only the `.deb`
  path does) — it currently always requires a system Node.js >= 18.
- First-run configuration (the `.env`/DB/branding wizard), infra wizards
  (Dell OME, HPE OneView, SMTP), and the rest of the roadmap are separate
  phases (2+) and out of scope here — this phase only makes the existing app
  installable, upgradable, and repairable as a service.
