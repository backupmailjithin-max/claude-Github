# DCIM Installation Guide

Applies to: DCIM Enterprise Offline Distribution Kit v3.2.2

## 1. Choose how you're installing

The Distribution Kit supports two ways to install, both fully offline (no
internet access is required or used during install):

| Method | When to use |
|---|---|
| **One-step dispatcher** (`./install` on Linux, `install.ps1` on Windows) | Recommended for most customers. Auto-detects your OS and runs the matching native installer below. |
| **Native installer directly** (`.deb`/`.rpm`/`.run` on Linux, `DCIM-Setup.exe` on Windows) | Use when your change-management process requires a specific, auditable package format. |

## 2. System requirements

| | Minimum |
|---|---|
| OS (Windows) | Windows Server 2022 (Server 2019 is no longer offered by our CI validation pipeline - see Known Limitations - but the installer itself has no code path that excludes it) |
| OS (Linux) | Ubuntu 22.04 / 24.04, Rocky Linux 9, AlmaLinux 9 (systemd-based) |
| Node.js | v18+ (bundled in the kit - you do not need to install it yourself) |
| Disk space | 500 MB minimum free on the install volume |
| Database | MariaDB/MySQL 5.7+/10.3+, either your own server or the kit's bundled embedded MariaDB (11.4.4) |
| Network | None required during install, upgrade, or repair. Only needed afterward if you connect Dell OME / HPE OneView / SMTP. |

## 3. Linux installation

### 3a. One-step dispatcher
```bash
tar -xzf DCIM-Enterprise-Offline-Kit-v3.2.2.tar.gz
cd DCIM-Enterprise-Offline-Kit-v3.2.2
sudo ./install
sudo dcim-setup
```
`./install` detects Debian/Ubuntu (installs the `.deb` via `dpkg`) or
RHEL/Rocky/AlmaLinux (installs the `.rpm` via `dnf`/`yum`). For an
unrecognized distro, or if you pass `--appliance`, it falls back to the
self-contained `.run` appliance instead (no package manager involved at
all).

### 3b. Direct install with options
```bash
sudo dcim-setup --mode install --yes \
  --port 8974 \
  --db-host localhost --db-port 3306 --db-user dcim --db-password 'YourPassword' --db-name dcim \
  --admin-user myadmin --admin-password 'YourAdminPassword' \
  --csp-mode enforce --audit-retention-days 90
```

Key flags:

| Flag | Meaning | Default |
|---|---|---|
| `--mode install\|upgrade\|repair` | Skips the interactive menu | (interactive) |
| `--port` | HTTP port the app listens on | `8974` |
| `--db-host`, `--db-port`, `--db-user`, `--db-password`, `--db-name` | External database connection | `localhost:3306`, `dcim`/`dcim` |
| `--embedded-db` | Use the kit's own bundled, private MariaDB instance instead of an external one (auto-generates a random DB password) | off |
| `--embedded-db-port` | Port for the embedded instance | `3307` |
| `--admin-user`, `--admin-password` | Replace the seeded `admin`/`admin` account on first install | seeded `admin`/`admin` |
| `--csp-mode` | `enforce` \| `report-only` \| `off` | `report-only` |
| `--audit-retention-days` | Days of audit log to keep (`0` = forever) | `365` |
| `--yes` | Non-interactive; assumes defaults/confirmations | off |

**Database Strategy - pick one:**
- **Option 1 (Embedded):** pass `--embedded-db`. The installer brings up its
  own private MariaDB 11.4.4 instance bound to `127.0.0.1`, auto-creates the
  database/user/password, and registers it as its own systemd service
  (`dcim-mariadb`), wired as a dependency of the main `dcim` service.
- **Option 2 (Existing database):** pass `--db-host`/`--db-user`/
  `--db-password`/`--db-name` for a database you already run. The installer
  validates the connection before continuing - it will not proceed against
  unreachable or misconfigured credentials.

If you skip `--admin-user`/`--admin-password`, sign in with `admin` / `admin`
on first run - you will be **required** to change the password before using
any other part of the app.

## 4. Windows installation

### 4a. One-step dispatcher
```powershell
.\install.ps1
```
Detects your Windows edition and launches the bundled `DCIM-Setup.exe`.

### 4b. Direct install with options
```powershell
.\DCIM-Setup.exe
# or, for scripted/unattended install:
packaging\windows\install.ps1 -Mode install -Yes -InstallDir C:\DCIM -Port 8974 `
  -DbUser dcim -DbPassword 'YourPassword' -DbName dcim `
  -AdminUser myadmin -AdminPassword 'YourAdminPassword'
```

Key parameters mirror the Linux flags above: `-Mode`, `-InstallDir`
(default `C:\DCIM`), `-Port` (default `8974`), `-DbHost`/`-DbPort`/
`-DbUser`/`-DbPassword`/`-DbName`, `-EmbeddedDb`/`-EmbeddedDbPort` (default
`3307`), `-CorsOrigin`, `-AdminUser`/`-AdminPassword`, `-CspMode` (default
`report-only`), `-AuditRetentionDays` (default `365`), `-Yes`.

The Windows service is registered via NSSM under the name `DCIM` (embedded
database, if used, runs as a separate `DCIMMariaDB` service with a
Windows Service Control Manager dependency on it).

## 5. First sign-in

1. Browse to `http://<server>:<port>/` (default port `8974`).
2. Sign in with the admin account you configured (or `admin`/`admin` if you
   didn't customize it - you'll be forced to change it immediately).
3. Open **Setup Wizard** to configure Organization/Branding, Security
   (session timeout, password policy), Monitoring (Dell OME / HPE OneView /
   SMTP, each with a **Test Connection** button), and seed standard
   Infrastructure defaults (Locations/Zones/Rack Types/Hardware Types) if
   you don't already have your own.
4. A structured health report runs automatically after install - view it
   any time at `/api/health/validate` while signed in as an Admin, or via
   the dashboard.

## 6. Verifying the install

```bash
# Linux
sudo systemctl status dcim
curl http://127.0.0.1:8974/api/health

# Windows
Get-Service DCIM
Invoke-RestMethod http://127.0.0.1:8974/api/health
```
Expect `{"status":"ok", ...}`. If not, see the **Administrator Guide**'s
troubleshooting section or generate a Support Bundle (same guide).
