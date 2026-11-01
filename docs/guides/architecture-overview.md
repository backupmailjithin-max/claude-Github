# DCIM Architecture Overview

DCIM is a self-contained web application for data-centre infrastructure management. It is delivered as an offline kit and needs no internet access to install or run.

## 1. System context

```
 Browsers (staff)  ──HTTPS/HTTP──►  [ nginx, optional ]  ──►  DCIM application (Node.js, port 8974)
                                                                  │            │
                                                                  │            └──► MariaDB / MySQL database
                                                                  │
                                       optional, on your network: ├──► Dell OME / HPE OneView (firmware, power)
                                                                  ├──► Server BMCs via Redfish
                                                                  ├──► PDUs via SNMP
                                                                  └──► SMTP server (email notifications)
```

Everything on the right is optional. The application works with only a browser and a database.

## 2. Components

| Component | What it does |
|---|---|
| Web application (`webapp/server.js`) | Serves the website and the REST API (about 170 routes), enforces roles and site access, runs scheduled jobs |
| Web UI (`app-compiled.js`, `libs/`) | Single-page application. All scripts and fonts are bundled, so no internet is needed |
| Database | Stores assets, racks, locations, issues, activities, material movements, visitors, firmware targets, PDUs, power readings, users, settings, audit log |
| Licensing and integrity (`lib/license.js`, `lib/integrity.js`) | Verifies the signed licence, the 10-day trial, the user limit and the integrity of the protected files |
| Redfish module (`lib/redfish-routes.js`) | Reads hardware health, power and firmware from server BMCs |
| PDU module (`lib/pdu-routes.js`) | Polls PDUs and keeps daily power readings for analytics |
| Visitor module (`lib/visitor-routes.js`) | Visitor access requests and approval workflow |
| Setup module (`lib/setup-routes.js`) | First-run wizard, OME/OneView/SMTP settings, notification recipients, health check |
| Mail (`lib/smtp-client.js`) | Sends approval and report emails directly to your SMTP server |
| Document reading (`ocr/`) | Reads delivery-challan and invoice documents offline |
| Service wrapper | systemd on Linux, a Windows Service on Windows; starts at boot |

## 3. Security model

- **Authentication.** Username and password with enforced password policy; sign-in with a default password forces a change before anything else is allowed.
- **Roles.** Admin, Operator, Viewer. A Global Administrator manages users and settings; other users are limited to their assigned sites.
- **Approver flag.** Approving visitor and material-movement requests requires Admin or the approver flag, and access to the record's site.
- **Audit log.** Sign-ins, changes, deletions (with restorable snapshots) and licence events are recorded, with a configurable retention period.
- **Secrets.** Integration passwords are encrypted before storage.
- **Licence.** Ed25519-signed, verified offline. Only a public key ships in the product.
- **Integrity.** A signed manifest covers the licensing code. Modified files are reported in the audit log and can restrict the application (modes `warn`, `restricted`, `enforce`).

## 4. Data and backups

| Data | Included in application backup | Notes |
|---|---|---|
| Sites, racks, assets, components, movements, issues, activities | Yes | |
| Material movements and their documents | Yes | Uploaded files are included |
| Visitor requests and documents | Yes | |
| PDUs and daily power readings | Yes | Power readings are included from this release |
| Users | Yes | |
| Application settings (organisation, SMTP, integrations, notification recipients) | Yes | Passwords stay encrypted |
| Licence file and trial records | No | Belong to one machine and are never overwritten by a restore |
| `.env` (database credentials, secrets) | No | Back it up separately with your server backup |

A restore runs in a single database transaction, takes a safety backup first, and rolls back completely on any error.

## 5. Deployment layouts

| Layout | Use |
|---|---|
| Linux `.deb` / `.rpm` | Package-managed install, systemd service |
| Linux appliance | Single self-extracting installer |
| Windows installer | Windows Service, optional embedded MariaDB |
| Embedded or external database | Choose at install time |

Install paths, ports and the database connection are printed in the Configuration Summary at the end of install, upgrade and repair.

## 6. Operational lifecycle

| Operation | Tool | Effect on data and licence |
|---|---|---|
| Install | installer | New trial starts |
| Upgrade | `dcim-upgrade` / upgrade utility | Data, `.env`, licence and trial kept |
| Repair | `dcim-repair` / repair utility | Restores application files; data and licence kept |
| Rollback | rollback script | Returns to the pre-upgrade snapshot; licence kept |
| Backup / restore | Settings → Backup & Restore | See section 4 |
| Uninstall | uninstall script | Removes the application |

## 7. Sizing and requirements

See the [Installation Guide](installation-guide.md), section 2, for supported operating systems, disk space and database versions.
