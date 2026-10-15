# DCIM Upgrade Matrix

## Supported upgrade paths (this release)

| From | To | Method | Notes |
|---|---|---|---|
| Any 3.x install (external DB) | v3.2.2 | `dcim-upgrade` / `DCIM-Upgrade.exe` | Standard path; full pre-upgrade backup taken automatically. |
| Any 3.x install (embedded DB) | v3.2.2 | `dcim-upgrade` / `DCIM-Upgrade.exe` | Embedded MariaDB instance auto-detected and preserved; no flag re-pass needed. |
| `.deb` install | newer `.deb` | `dpkg -i dcim_<new>_amd64.deb` (postinst auto-runs `install.sh --mode upgrade --yes`) | Always picks up the new package's bundled files. |
| `.rpm` install | newer `.rpm` | `rpm -U dcim-<new>.rpm` | Same auto-upgrade behavior as `.deb`. |
| Standalone (`install.sh` run directly) | newer version | Re-run the **new** version's `install.sh --mode upgrade` from its own extracted source | See Known Limitations #5 - the `dcim-upgrade` shortcut alone re-applies the cached (old) version on this install method. |
| Offline appliance (`.run`) | newer appliance | Run the **new** `.run` file with `--mode upgrade` | Same caveat as standalone above. |

## Platform support matrix (this release)

| Platform | Install | Upgrade | Repair | Rollback | Embedded DB |
|---|---|---|---|---|---|
| Windows Server 2022 | Yes | Yes | Yes | Yes | Yes |
| Windows Server 2019 | Expected to work; no automated CI evidence this release (see Known Limitations #2) | Same | Same | Same | Same |
| Ubuntu 22.04 / 24.04 | Yes | Yes | Yes | Yes | Yes |
| Rocky Linux 9 | Yes (package install verified; see note) | Yes | Yes | Yes | No automated systemd-lifecycle evidence this release - package layout and install verified, not full service-lifecycle (see Known Limitations) |
| AlmaLinux 9 | Yes (same note as Rocky 9) | Yes | Yes | Yes | Same note |

## Minimum version to upgrade from

There is no enforced minimum - the upgrade path reapplies application files
and preserves the existing database schema/data and `.env` unconditionally.
If you are upgrading from a release substantially older than the 3.x line,
take a manual backup first (Backup Guide) as an extra precaution, in
addition to the automatic pre-upgrade snapshot.
