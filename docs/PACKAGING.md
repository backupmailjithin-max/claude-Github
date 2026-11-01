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
  `install.js`'s schema-import step piped `schema.sql` straight into
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

## Architecture round: single-download Distribution Kit, embedded database, DR hardening

Following an architecture review (separate platform installers vs. a single
unified package), the decision was: keep the native per-platform installers
as the actual install mechanism (no new cross-platform install engine), but
wrap them in one outer "kit" so the customer downloads a single archive and
a thin OS-detecting dispatcher invokes the right native installer
underneath. Everything below is additive to the Gap-closure round above;
nothing already shipped was changed in behavior except where a real bug was
found (noted explicitly).

### DCIM Enterprise Offline Distribution Kit

`packaging/kit/build-kit.sh` assembles `DCIM-Enterprise-Offline-Kit-v<version>.{tar.gz,zip}`
from the four already-built, already-tested artifacts:

```
DCIM-Enterprise-Offline-Kit-v3.2.2/
├── install                  POSIX dispatcher: reads /etc/os-release, installs
│                             the matching .deb (dpkg) or .rpm (dnf/yum), or
│                             falls back to the self-contained .run appliance
│                             for anything it doesn't recognize (also
│                             selectable explicitly via --appliance)
├── install.ps1               Windows dispatcher: logs the detected Windows
│                             edition, launches windows\DCIM-Setup*.exe
├── VERSION
├── CHECKSUMS.sha256
├── windows/
│   ├── DCIM-Setup-<ver>.exe        the main installer (unchanged)
│   ├── DCIM-Upgrade-<ver>.exe      carries a NEW payload, forces -Mode upgrade
│   └── DCIM-Repair-<ver>.exe       carries a NEW payload, forces -Mode repair
├── linux/
│   ├── deb/*.deb
│   ├── rpm/*.rpm
│   ├── appliance/*.run
│   ├── dcim-upgrade            thin wrapper over install.sh --mode upgrade
│   └── dcim-repair             thin wrapper over install.sh --mode repair
└── common/{docs,branding,templates,release-notes}/
```

The dispatchers contain **no install logic of their own** — they only detect
the OS and hand off to the same native artifact that was already built and
tested individually. `windows-2019` support evidence could not be produced:
three separate CI runs confirmed GitHub no longer offers that hosted runner
image at all (jobs stayed queued indefinitely, never assigned a runner) —
this was removed from `test-lifecycle.yml`'s matrix rather than left to
silently stall every future run.

**Windows Upgrade/Repair utilities**: `dcim-upgrade-utility.iss` /
`dcim-repair-utility.iss` are two more Inno Setup scripts sharing
`dcim-installer.iss`'s payload and AppId, differing only in forcing
`install.js -Mode upgrade` / `-Mode repair` instead of auto-detecting. This
fixed a real, previously-undetected gap: the existing "DCIM Upgrade Utility"
Start Menu shortcut re-syncs `install.js`'s own already-installed webapp
folder over itself, so it never actually carries a newer version — it was
only ever equivalent to Repair. The kit's `DCIM-Upgrade.exe` carries the new
payload with it, the same way running a newer `DCIM-Setup.exe` already does,
just without the full installer wizard.

### Embedded MariaDB (Database Strategy "Option 1")

`--embedded-db` (Linux) / `-EmbeddedDb` (Windows) bring up a **private**
MariaDB instance instead of requiring an external one — Option 2 (external
MySQL/MariaDB, the `--db-*`/`-Db*` flags) is unchanged and remains the
default.

- `fetch-mariadb-runtime.sh` / `.ps1` download a generic MariaDB server
  build at package-build time (same pattern as the Node runtime/NSSM
  fetchers) — not committed to git, not run by the installer itself.
- On install: initializes a private data directory under
  `$InstallDir/mariadb/data`, runs the engine as its **own** service
  (`dcim-mariadb.service` on Linux, `DCIMMariaDB` via NSSM on Windows),
  bound to `127.0.0.1` on port **3307** (deliberately not 3306, to avoid
  colliding with any existing system MySQL/MariaDB), and creates the app's
  database/user/random-password through the bundled engine — no system
  package manager involved.
- The app's own service unit is wired to depend on it
  (`Requires=`/`After=` on Linux, NSSM `DependOnService` on Windows),
  auto-detected from the data directory's presence — a repair run doesn't
  need the flag re-passed to keep working.
- Idempotent across repair: a second run reuses the existing data and
  credentials (read back from `.env`) instead of reinitializing, which
  would just lock the app out.
- RPM has no bundled-runtime story at all yet (pre-existing, see *Known
  limitations*) — `--embedded-db` there is a no-op until that's addressed.

Real bugs found only by actually running this (not by reading it), all
fixed:
- A `.gitignore` rule meant for the repo-root build-output directory
  (`dist/`) was unanchored, so it also matched `node_modules/*/dist/`
  anywhere in the tree — silently stripping `bcryptjs`'s required
  `dist/bcrypt.js` (the server couldn't start at all) and
  `wasm-feature-detect`/`idb-keyval` (OCR would have broken on first real
  use). Anchored to `/dist/`; the five stripped directories were restored.
- `mariadb-install-db`'s hostname-resolution check fails in many
  containers/offline hosts with unusual `/etc/hosts` — added `--force`.
- The original `share/` trim step for the bundled runtime deleted
  MariaDB's system-table bootstrap SQL (`mysql_system_tables.sql`,
  `fill_help_tables.sql`, etc.), which live as plain files directly under
  `share/`, not inside a locale subdirectory — `mariadb-install-db` failed
  outright until the trim was narrowed to only non-English locale
  subdirectories.
- A standalone (non-`.deb`/`.rpm`) install's cached CLI copy
  (`$InstallDir/cli`, see *dcim-upgrade/dcim-repair* below) has no bundled
  MariaDB payload next to it on repair — only the scripts are cached
  there, not the multi-hundred-MB engine. Fixed by falling back to the
  already-staged engine instead of requiring a payload that was never
  going to be there.
- Windows's `mariadb-install-db.exe` rejects
  `--auth-root-authentication-method` outright (unsupported on that
  platform's build) — removed for the Windows path; its default already
  creates root with no password, the same end state.
- `dcim-upgrade.sh`/`dcim-repair.sh` resolve `install.sh` via
  `dirname "${BASH_SOURCE[0]}"`, but when invoked through a symlink (the
  standalone-install case) that resolves to the *symlink's* directory, not
  the real file's — fixed with `readlink -f` first.

### Session Timeout, Password Policy, branding preview

- **Session Timeout**: `server.js`'s JWT expiry was hardcoded `'8h'` in both
  places it's issued. Parameterized via one `JWT_EXPIRES_IN` constant
  (same "read once from `.env` at startup" pattern as `JWT_SECRET`/
  `CSP_MODE`), exposed as `sessionTimeoutHours` in the Security tab.
- **Password Policy**: a configurable minimum password length
  (`app_settings`-backed, applies immediately) governing the Admin Account
  tool's own password check — deliberately scoped to that one additive
  endpoint; the app's own sign-in/change-password minimum is untouched,
  existing business logic.
- **Branding preview**: logo/favicon inputs show a live local preview
  (`FileReader`, no upload) before saving.

### Structured Health Validation and Support Bundle

- `GET /api/health/validate` (Admin) returns PASS/WARNING/FAIL per
  component — Service, Database, OCR, API Health, Version Endpoint, Upload
  Engine, Backup Engine, SMTP, Dell OME, HPE OneView — composing the same
  checks `/api/health/full` already uses (kept untouched). `install.sh` /
  `install.js` sign in and print this automatically after install/
  upgrade/repair.
- `POST /api/support/bundle` (Admin) downloads a `.zip` (system info, the
  health report, a performance snapshot, redacted `.env`, last 500 log
  lines) for troubleshooting. No new npm dependency: `lib/zip-writer.js`
  is a small self-contained ZIP writer (deflate + central directory),
  round-trip tested against the system `unzip` binary.
- Both endpoints needed adding to `server.js`'s existing
  `MUST_CHANGE_ALLOWED` allowlist — found the same way the earlier
  `/api/setup/admin-account` gap was: the installer signs in with the
  still-default `admin`/`admin` account to print the report, which 403'd
  under the forced-password-change gate otherwise.

### Disaster-recovery file export

Backup/Restore (`BACKUP_TABLES`) and Config Export/Import already cover
every DB table and setting — confirmed by reading `server.js`, not
assumed. The actual gap: two upload directories
(`webapp/uploads/branding` for logo/favicon, `webapp/uploads/movements`
for Material Movement DC/invoice documents) store files on local disk with
only the filename kept in the database. `GET /api/backup/files-archive`
(Admin) zips the entire `uploads/` tree for download — read-only against
the existing upload code, using the same zip-writer as the support bundle.
Scoped to export only: a matching import/extract endpoint would mean
hand-rolling a ZIP *reader* for a lower-value automation of something an
admin can already do with any standard unzip tool.

### Two more real bugs found via CI (Windows-specific)

- The original `rollback.ps1`'s confirmation prompt (`Read-Host`) was not
  satisfied by `echo y | rollback.ps1` the way a POSIX shell's `read` is —
  PowerShell pipeline input and console stdin are different things. Added a
  real `-Yes` switch (carried over unchanged into `rollback.js` when the
  Windows installer was later rewritten from PowerShell to Node.js — see
  "PowerShell retirement" below).
- The database restore step used `cmd /c "mysql ... < file"` without
  checking its exit code, so a failed import was silently logged as
  "Database restored" — replaced with `System.Diagnostics.Process`/
  `ProcessStartInfo` (exit code checked, arguments passed via
  `ArgumentList` instead of a hand-quoted command line, the dump streamed
  as raw bytes instead of through a text pipeline that could re-encode
  it).
- `mysqldump` failed outright against a real MySQL 8 server with "Couldn't
  execute 'FLUSH TABLES': Access denied" — MySQL 8 attempts to record GTID
  state (needing a global privilege) even with `--single-transaction`,
  which a least-privilege DB user scoped to just this app's database (the
  exact grant this installer's own docs ask customers to set up) will
  never have. Added `--set-gtid-purged=OFF` to both platforms' `mysqldump`
  calls, which skips that lookup entirely.
- With `-EmbeddedDb`, `Setup-EmbeddedDb` and `Install-WindowsService` each
  staged their own copy of `nssm.exe` under `$InstallDir\tools`. Confirmed
  via a real `test-windows-embedded-db` CI run: `Setup-EmbeddedDb` runs
  first and its copy of `nssm.exe` becomes the live process image of the
  `DCIMMariaDB` service it just registered, so `Install-WindowsService`'s
  own unconditional `Copy-Item -Force` to the same path then fails with
  "The process cannot access the file ... because it is being used by
  another process" — even though embedded MariaDB itself had already
  initialized and come up correctly. Replaced both copies with a shared
  `Ensure-NssmBinary` helper: it skips the copy when the staged binary is
  already byte-identical to the payload (comparing `Get-FileHash`), and
  only swallows the "in use" exception in that identical case — a
  genuinely different `nssm.exe` (e.g. a version bump shipped by an
  upgrade) still fails loudly instead of silently leaving the old binary
  running.
- The .deb/.rpm both ship `/usr/bin/dcim-setup` as a real symlink to
  `/usr/share/dcim/install.sh`, but `install.sh` computed `SCRIPT_DIR` with
  plain `dirname` on `$BASH_SOURCE[0]` — invoked through that symlink,
  `dirname` resolves to `/usr/bin` (the symlink's own directory), not
  `/usr/share/dcim` (the real script's directory), breaking the webapp
  rsync. No existing test caught this because every earlier test either
  invoked `install.sh` directly or only checked the symlink *existed* —
  the Distribution Kit's own smoke test (`sudo ./install` → `sudo
  dcim-setup`) was the first real execution of that exact entry point.
  Fixed with the same `readlink -f` pattern already used by
  `dcim-upgrade.sh`/`dcim-repair.sh` for the same class of bug.
- `do_repair`/`Invoke-Repair` always preserved `.env` *if it existed*, but
  had no recovery path when `.env` itself was the thing missing (`Lost
  Configuration` in the Release Gate's Gate 5 matrix) — `sync_payload`/
  `Sync-Payload` only ever touch webapp files, never recreate `.env`, so a
  repair run would restart the service with no DB password or JWT secret
  and fail. Both platforms now self-heal `.env` from the most recent prior
  backup that still has one (every `backup_before_change`/
  `Backup-BeforeChange` call has always captured it when it existed at
  backup time); if no such backup exists, repair now fails loudly with a
  clear message instead of silently leaving the service unable to connect.

## Release Gate framework

A mandatory, automated CI/CD governance pipeline sits on top of everything
above: nothing may be promoted to UAT or certified for Production unless a
defined set of real, execution-based checks pass. It adds no application
logic — every job either builds already-existing packaging scripts or
drives the already-shipped HTTP API of a real running instance.

### Workflow files

| File | Role |
|---|---|
| `release-gate.yml` | Orchestrator: Gate 0/1 inline, calls the other workflows below as reusable jobs, runs the Gate 5/8 matrices directly, and aggregates everything into a job summary + UAT/Production promotion decision. |
| `test-lifecycle.yml` | Gate 3 (Installation Validation) and (as a reporting alias) Gate 7 (Rollback) — unchanged from the existing real install/upgrade/repair/rollback suite, now also callable via `workflow_call`. |
| `package-validation.yml` | Gate 2 (Package Build): calls `build-packages.yml` (now also `workflow_call`-able), then verifies every expected artifact exists, generates a release-wide SHA256 manifest, and verifies the Distribution Kit's own internal checksums. |
| `security-gate.yml` | Gate 9 (Security Validation): static checks (JWT sourced from env, must-change-password gate, session timeout, audit logging, upload validation, CSP) plus a real install that proves the default admin/admin account is forced to change its password, unauthenticated requests get 401, and the DB password never leaks into install output or service logs. |
| `backup-restore-gate.yml` | Gate 6 (Backup & Restore): real install → populate Users/Assets/Firmware Targets/Branding/Security Settings via the API → `GET /api/backup/download` → delete every category from the DB → `POST /api/backup/restore` (with the required `confirm: RESTORE`) → verify every category came back. The whole sequence was hand-verified against a locally-run instance before being committed to CI. |
| `upgrade-gate.yml` | Gate 4 (Upgrade Validation): its own dedicated before/after snapshot (not just pass/fail logging) across Users/Locations/Assets/Firmware Targets/Branding, uploaded as artifacts. |

### Gate map

| Gate | Name | Severity | Where |
|---|---|---|---|
| 0 | Source Integrity (YAML/JSON/JS/PowerShell/shell syntax, package manifests, required offline runtime files) | BLOCK RELEASE | `release-gate.yml` → `source-integrity` |
| 1 | Fresh Clone Validation (no `npm install`, no missing files, app starts) | BLOCK RELEASE | `release-gate.yml` → `fresh-clone` |
| 2 | Package Build (artifacts exist, checksums, manifest) | BLOCK RELEASE | `package-validation.yml` |
| 3 | Installation Validation (Windows 2022, Ubuntu 22.04/24.04, Rocky 9, Alma 9) | BLOCK RELEASE | `test-lifecycle.yml` |
| 4 | Upgrade Validation | BLOCK RELEASE | `upgrade-gate.yml` |
| 5 | Repair Validation (missing files / broken service / corrupted runtime / lost config) | HIGH SEVERITY — waivable | `release-gate.yml` → `repair-validation` matrix |
| 6 | Backup & Restore | BLOCK RELEASE | `backup-restore-gate.yml` |
| 7 | Rollback Validation | BLOCK RELEASE | `release-gate.yml` → `rollback-validation` (reports Gate 3's own rollback check — see note below) |
| 8 | Runtime Validation (OCR/PDF/Excel/Health/Version/Firmware route/OME/OneView) | HIGH SEVERITY — waivable | `release-gate.yml` → `runtime-validation` |
| 9 | Security Validation | BLOCK RELEASE | `security-gate.yml` |
| 10 | Offline Appliance (real network isolation via `iptables`, not a code-review claim) | BLOCK RELEASE | `release-gate.yml` → `offline-validation` |

**Gate 7 note:** `test-lifecycle.yml`'s own jobs already delete test data,
run `rollback.sh`/`rollback.js`, and verify the record came back, as part
of their single combined install/upgrade/repair/rollback run — that is the
real rollback test. `rollback-validation` is a thin reporting alias (`needs:
install-validation`) so the aggregator and the promotion rules below have a
dedicated named signal for it, without re-running the same rollback a
second time.

**Gate 5/8 waiver mechanism:** these two jobs run without
`continue-on-error` (so a real failure is still visible as a failed job),
but the `release-gate` aggregator job treats their result as informational,
not blocking — it only affects whether the run gets **PRODUCTION
CERTIFIED**, never **READY FOR UAT**. Re-running `release-gate.yml` via
`workflow_dispatch` with a `waiver_reason` input records a human's reviewed
justification in the job summary and allows Production Promotion to
proceed despite a Gate 5/8 failure.

### UAT and Production Promotion rules

- **READY FOR UAT**: every BLOCK RELEASE gate (0, 1, 2, 3, 4, 6, 7, 9, 10)
  passes. Gate 5 (Repair) and Gate 8 (Runtime) are not required for UAT.
- **PRODUCTION CERTIFIED**: every gate passes, including Gate 5/8, OR a
  `waiver_reason` was supplied for a Gate 5/8 failure (shown as "PRODUCTION
  CERTIFIED (with recorded waiver)" in the summary, so it's never confused
  with an unconditional pass).

Both outcomes are written to the job's `$GITHUB_STEP_SUMMARY` (visible on
the workflow run page) as the **Release-Gate Dashboard** — a Markdown table
of every gate's result, the waiver status, and the final verdict. The
`release-manifest.json` + `RELEASE-CHECKSUMS.sha256` (Gate 2), the
upgrade/backup-restore before/after snapshots (Gates 4/6), and the runtime
health-validate report (Gate 8) are all uploaded as separate downloadable
artifacts on the same run — together these are the Release Readiness
Report / Platform Validation Report / Security Validation Report /
Backup-Restore Validation Report / Rollback Validation Report the roadmap
asked for, rather than a separate hand-written document that would drift
out of sync with what actually ran.

### Known limitations

- **No package signing.** There is no code-signing certificate (Windows
  Authenticode) or GPG key configured in this environment, so Gate 2
  explicitly reports this as a tracked gap via a workflow annotation rather
  than fabricating a signing step. Production Promotion does not yet
  require it, since no prior release shipped signed packages either — this
  should change once signing infrastructure exists.
- **windows-2019 has no CI coverage** (see `test-lifecycle.yml`'s own
  comment) — GitHub-hosted runners no longer assign that image at all.
  Gate 3's Windows coverage is windows-2022 only.
- **The secrets-in-source scan in Gate 9 is a grep-based floor**, not a
  dedicated scanning service (SAST/secret-scanning product) — it catches
  the common high-confidence patterns (AWS keys, private key headers, Slack
  tokens, Google API keys) but is not a substitute for one.
- **Gate 5's waiver and Gate 8's waiver share one `waiver_reason` input** —
  there's no way to waive one but not the other in a single run. Given both
  are "no real hardware/credentials in CI" categories in practice, this
  was judged acceptable rather than building a two-field waiver form.

## What's real vs. what already existed

| Roadmap phase | Status | Where |
|---|---|---|
| 1 — Portable deployment package | **Built here** | `packaging/linux`, `packaging/windows` |
| 2 — First-run configuration wizard | **Built here** (org/branding only — DB config was already handled by Phase 1's installer, and the admin account already auto-seeds) | `dcim/webapp/lib/setup-routes.js`, `setup-wizard.html` |
| 3 — Infrastructure configuration (OME/OneView/SMTP) | **Built here** — OME/OneView *hardware pulling* already existed and was env-only; this adds a DB-backed, UI-driven config layer with real Test Connection/Test Email | `setup-routes.js`, `lib/smtp-client.js` |
| 4 — Initial DC setup wizard | **Mostly already existed** (full CRUD for locations/zones/hardware/rack types); only the one-click "seed standard defaults" step was missing | `setup-routes.js` (`/api/setup/seed-defaults`) |
| 5 — Health verification engine | **Already had `/api/health`**; this adds a deeper `/api/health/full` (DB write test, OCR, backup folder, live OME/OneView reachability, SMTP) | `setup-routes.js` |
| 6 — Upgrade manager | **Already existed at the app level** (full DB backup/restore with checksums); this phase adds a real `mysqldump` snapshot + rollback script around Upgrade/Repair specifically | `install.sh` / `install.js` `backup_before_change`, `rollback.sh` / `rollback.js` |
| 7 — Offline enterprise appliance | **Built here** — one self-extracting file, no internet needed | `packaging/appliance/build-appliance.sh` |
| 8 — Enterprise deployment features | **Mostly already existed** (CSP mode, log/audit retention, JWT secret enforcement were already env-driven); this adds service-control convenience wrappers | `dcim-service.sh` / `dcim-service.js` |
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
  server.js                   Additive: require + register the new module, MUST_CHANGE_ALLOWED
                               entries, JWT_EXPIRES_IN constant. Nothing else changed.
  lib/setup-routes.js         Phase 2/3/4/5/9 + export/import + health-validate + support-bundle +
                               DR files-archive APIs (see above).
  lib/smtp-client.js          Dependency-free raw SMTP client for the SMTP test action.
  lib/zip-writer.js           Dependency-free ZIP writer (deflate + central directory), used by
                               the support bundle and the DR files-archive export.
  setup-wizard.html           Standalone first-run / infra-config admin page.
  deployment-dashboard.html   Standalone deployment status admin page.

packaging/kit/
  install                     POSIX OS-detecting dispatcher for the Distribution Kit.
  install.ps1                 Windows dispatcher for the Distribution Kit.
  build-kit.sh                Assembles DCIM-Enterprise-Offline-Kit-v<version>.{tar.gz,zip}
                               from the four platform artifacts below.

packaging/linux/
  install.sh                  Install / Upgrade / Repair, with pre-flight validation and
                               --embedded-db.
  uninstall.sh                Stops + disables the service; --purge-data removes files too.
  rollback.sh                 Restores files/.env/database from an Upgrade/Repair's pre-change snapshot.
  dcim-service.sh             `dcim-service {start|stop|restart|status|logs}` convenience wrapper.
  dcim-upgrade.sh / dcim-repair.sh
                               Dedicated CLI entry points, installed on PATH (by the package's
                               postinst, or by install.sh itself on a standalone install).
  dcim.service.template       Hardened systemd unit (placeholders filled in by install.sh).
  dcim-mariadb.service.template
                               systemd unit for the embedded MariaDB instance.
  nginx-dcim.conf             Optional reverse proxy config.
  fetch-node-runtime.sh       Build-time helper: downloads a Node runtime to bundle.
  fetch-mariadb-runtime.sh    Build-time helper: downloads a MariaDB server to bundle (--embedded-db).
  build-deb.sh                Stages a .deb (supports bundled Node + bundled MariaDB).
  build-rpm.sh                Stages a .rpm (requires system Node.js today; no --embedded-db).
  debian/, rpm/                Control files / spec used by the two build scripts.

packaging/windows/
  install.js                  Install / Upgrade / Repair, registers a Windows Service via NSSM,
                               supports -EmbeddedDb. Runs under the bundled node.exe, not
                               PowerShell - see "PowerShell retirement" below.
  uninstall.js                 Removes the service (and optionally the files).
  rollback.js                  Restores .env/database from an Upgrade/Repair's pre-change snapshot.
  dcim-service.js              `node dcim-service.js {start|stop|restart|status}` convenience wrapper.
  fetch-node-runtime.ps1       Build-time helper: downloads a Node runtime to bundle (still
                               PowerShell - it only runs once, on the CI build machine, never
                               shipped to or run by a customer).
  fetch-nssm.ps1               Build-time helper: downloads nssm.exe (service wrapper).
  fetch-mariadb-runtime.ps1    Build-time helper: downloads a MariaDB server to bundle (-EmbeddedDb).
  dcim-installer.iss           Inno Setup script -> compiled to dcim-setup-<version>.exe.
  dcim-upgrade-utility.iss / dcim-repair-utility.iss
                               Same payload/AppId as dcim-installer.iss, forcing -Mode upgrade/repair -
                               compiled to standalone DCIM-Upgrade/DCIM-Repair .exe utilities.

packaging/appliance/
  build-appliance.sh           Bundles runtime (+ MariaDB if staged) + webapp + every installer
                                script into ONE self-extracting dcim-appliance-<version>-linux-x64.run.

.github/workflows/build-packages.yml
                               CI: builds the .deb, .rpm, Windows .exe (+ utilities), and the
                               offline appliance, assembles the Distribution Kit, and smoke-tests
                               the kit's dispatcher for real - on every tag push or manual dispatch.
.github/workflows/test-lifecycle.yml
                               CI (manual dispatch only): real install/upgrade/repair/rollback
                               lifecycle on Windows and Ubuntu, for both external-DB and
                               --embedded-db, plus RPM package-layout checks on Rocky/Alma.
```

## Why Node is always bundled, and MySQL/MariaDB is now optional

`fetch-node-runtime.*` downloads a pinned Node build at **package-build
time** (locally or in CI) and the installers prefer it over any system
Node. The runtime itself is never committed to git — only the scripts that
fetch it — so the repository doesn't carry vendored binaries, and bumping
the Node version is a one-line change.

MySQL/MariaDB has two supported paths, selected at install time (see
**Embedded MariaDB** above for the full picture):

- **Option 2 (default, unchanged)**: validate connectivity to an existing
  MySQL 8 / MariaDB 10.6+ instance via `--db-*` / `-Db*` flags.
- **Option 1 (`--embedded-db` / `-EmbeddedDb`)**: bundle and run a private
  MariaDB instance, the same "fetch at build time, never commit the
  binary" pattern as Node. This was a genuinely larger undertaking than
  Phase 1's Node bundling (data directory initialization, its own service
  lifecycle, platform-specific binaries) and was deliberately sequenced
  after the rest of the packaging work for that reason.

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
`install.js`) now runs `mysqldump` (if present) in addition to the config/
file snapshot it always took, and records the snapshot's path. If an upgrade
goes wrong:

```bash
sudo packaging/linux/rollback.sh                # uses the most recent snapshot
sudo packaging/linux/rollback.sh /var/backups/dcim/20260101-120000  # a specific one
```

```powershell
node packaging\windows\rollback.js                  # uses the most recent snapshot
node packaging\windows\rollback.js -SnapshotDir 'C:\ProgramData\dcim-backups\20260101-120000'
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
node packaging\windows\dcim-service.js {start|stop|restart|status}
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
- RPM packaging still always requires a system Node.js >= 18 and does not
  support `--embedded-db` (no bundled-runtime story there at all yet,
  Node included) — a pre-existing gap, unchanged scope. The offline
  appliance and `.deb` both support bundled Node and `--embedded-db` once
  `fetch-node-runtime.sh`/`fetch-mariadb-runtime.sh` have been staged.
- `windows-2019` has no CI coverage: GitHub no longer offers it as a
  hosted runner image (confirmed by three separate runs never getting a
  runner assigned). Genuine Server 2019 execution evidence would require a
  self-hosted runner.
- The DR file export (`/api/backup/files-archive`) is export-only; restoring
  the files on a new server is a manual unzip-and-copy into
  `webapp/uploads/`, documented in the wizard rather than automated.
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


## Production defaults (added in this release)

- `CSP_MODE` now defaults to `enforce` (the Content-Security-Policy is applied, not just reported). The setup wizard and deployment dashboard have their own script hashes, so they keep working. Use `report-only` or `off` only to diagnose.
- `SEED_SAMPLE_DATA=0` skips the demo sites, assets and operator accounts on a new database; only the `admin` account is created. Leave it unset for evaluation installs.
- At start-up the server logs warnings for `CORS_ORIGIN` unset or `*`, `CSP_MODE` other than enforce, and a `.env` file readable by other users.
- `npm test` runs the unit tests (trial/licence logic, ZIP writer, OCR document parser).
