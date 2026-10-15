# DCIM Disaster Recovery Guide

Applies to: DCIM Enterprise Offline Distribution Kit v3.2.2

This guide covers recovering a **complete environment** - not just a
database restore (Backup Guide) or a broken install (Repair Guide), but
standing up a brand-new DCIM instance that matches a previous one exactly:
Locations, Zones, Hardware Types, Branding, Monitoring Settings, Security
Configuration, Firmware Targets, and the uploaded files those settings and
rows reference.

## Two exports, together, make a complete DR set

| Export | Covers | Endpoint |
|---|---|---|
| **Database backup** | Every table listed in the Backup Guide, including all configuration (`app_settings`) | `GET /api/backup/download` |
| **Files archive** | Branding logo/favicon, Material Movement documents - the physical files those database rows/settings reference, not covered by the database export | `GET /api/backup/files-archive` |

Take both together for a complete disaster-recovery set. Neither alone is
sufficient: the database export without the files archive leaves your
branding logo and uploaded documents missing; the files archive alone has
no database to attach them to.

There is also a narrower **Configuration Export** (`GET /api/setup/export`,
Setup Wizard > Export/Import), which exports just the setup-level
configuration (organization, branding settings, monitoring/security
config) as a smaller, portable bundle - useful for replicating *settings*
to a new environment without carrying over all operational data (assets,
users, etc.). Import it with `POST /api/setup/import`.

## Recovery procedure (new environment)

1. **Provision** a fresh target (new VM/server, meeting the requirements in
   the Installation Guide).
2. **Install** DCIM fresh (Installation Guide) - do not skip this step even
   if you're restoring data, since the install creates the service, schema,
   and admin account structure the restore needs.
3. **Restore the database** via `POST /api/backup/restore` with your saved
   database backup and `confirm: RESTORE` (Backup Guide).
4. **Restore the files archive**: extract it into the new environment's
   `webapp/uploads/` directory (the files-archive endpoint is export-only by
   design - see Known Limitations - so this step is a manual unzip onto the
   new server, not an API call).
5. **Verify**: run `GET /api/health/validate` and confirm Branding/logo
   renders, Monitoring connections are intact (re-enter credentials if your
   monitoring targets require fresh secrets - secrets are never included in
   exports, by design), and spot-check a few Locations/Assets/Firmware
   Targets against the source environment.

## What is intentionally excluded from every export

- **Secrets** (JWT secret, database password, SMTP/OME/OneView
  credentials) - these are environment-specific and regenerated/re-entered
  on the new environment, never carried in a portable export. This is a
  security property, not a gap.
- **Audit logs** - these are append-only operational history for the
  *source* environment and are not meant to be replayed onto a new one.

## Recommended DR cadence

- Automatic nightly database backups (Backup Guide) already cover the
  database side.
- Schedule a periodic (e.g. weekly) files-archive export alongside your
  backup rotation, stored in the same offsite/secure location.
- Test the full recovery procedure above at least once per major version,
  in a non-production environment, as part of your own change-management
  process - this Distribution Kit's own Release Gate does exactly this
  (Backup & Restore, Gate 6) on every release candidate, but your specific
  infrastructure (DNS, firewall rules, monitoring credentials) is outside
  what any packaged test can validate for you.
