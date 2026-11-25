# DCIM Installation Guide

Applies to: DCIM Enterprise Offline Distribution Kit v3.2.2

## 1. Choose how you're installing

The Distribution Kit supports two ways to install, both fully offline (no
internet access is required or used during install):

| Method | When to use |
|---|---|
| **One-step dispatcher** (`./install`) | Recommended for most customers. Detects your Linux distribution and runs the matching native installer below. |
| **Native installer directly** (`.deb`/`.rpm`/`.run`) | Use when your change-management process requires a specific, auditable package format. |

### A formal, guided install, not just flags

A guided setup is also offered for someone installing by hand, instead of
requiring command-line flags:

- **Linux** (`sudo dcim-setup` with no flags, or option **1) Install** from
  the interactive menu): the same choices are asked as a series of prompts
  - rendered as proper boxes via `whiptail` when it's available (the usual
    case; works over SSH, no desktop environment needed), or as plain
    text prompts otherwise. Press Enter at any prompt to accept the shown
    default.

Either path is equivalent to passing the matching `--db-*`/`--admin-*`
flags directly - use whichever fits how you work. Unattended/scripted
installs (`--yes`, or any CI pipeline) are completely unaffected: the
guided prompts only ever appear for a fresh install run interactively.

## 2. System requirements

| | Minimum |
|---|---|
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
| `--sample-data` | Also create demo sites, assets and operator accounts (for evaluation only). Without it a new install starts empty with just your administrator account | off |
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

## 4. Platform support

This edition is supported on Linux only: Ubuntu 22.04 / 24.04, Debian, AlmaLinux 8 / 9, Rocky Linux 9 and RHEL-compatible systemd distributions. There is no Windows installer in this edition.

## 5. Finding your configuration after install

Install, Upgrade, and Repair all end by printing a **Configuration Summary**
with everything you need to actually reach and manage the site: the Web UI
URL (both `localhost` and the server's network address), the administrator
account (or a reminder that `admin`/`admin` needs to be changed), the
database connection details (including the auto-generated password when
you chose the embedded database - that password is shown here and nowhere
else except `.env` itself), the CSP/audit security settings, and where the
install directory, config file, and service name are.

**Write this down before closing the terminal** - the embedded database
password in particular isn't recoverable from anywhere else.

- **Linux**: printed directly to the terminal at the end of
  `install`/`dcim-setup`/`dcim-upgrade`/`dcim-repair`.

## 6. First sign-in

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

## 7. Verifying the install

```bash
# Linux
sudo systemctl status dcim
curl http://127.0.0.1:8974/api/health

```
Expect `{"status":"ok", ...}`. If not, see the **Administrator Guide**'s
troubleshooting section or generate a Support Bundle (same guide).

## 8. Uninstalling

**Linux**
```bash
# .deb (Ubuntu/Debian)             # .rpm (RHEL/Rocky/AlmaLinux)
sudo apt remove dcim               sudo dnf remove dcim

# Appliance (.run) or any install - also removes the app and, with --purge-data, all data:
sudo /opt/dcim/cli/uninstall.sh [--purge-data]
```
Removing the package stops and disables the `dcim` service and the embedded
database service (`dcim-mariadb`) but **keeps your data** in `/opt/dcim`
(uploads, backups, the embedded database). Delete `/opt/dcim` yourself to
remove everything, or run `uninstall.sh --purge-data`, which asks for
confirmation. An external MySQL/MariaDB database is never touched.


Uninstalling resets the 10-day trial for a fresh install - keep your activation
code so you can activate again.
