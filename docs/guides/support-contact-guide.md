# DCIM Support Contact Guide

## Vendor support details

| Item | Detail |
|---|---|
| Vendor company | [[FILL IN: vendor company name]] |
| Support email | [[FILL IN: support email address]] |
| Escalation email | [[FILL IN: escalation email address]] |
| Support phone | [[FILL IN: phone number with country code]] |
| Support hours and time zone | [[FILL IN: days, hours and time zone]] |
| Licence requests, renewals, rebinds | [[FILL IN: licence request email address]] |
| Customer account / contract reference | [[FILL IN: filled per customer at handover]] |

> **Vendor only:** every bracketed *FILL IN* value in the table above must be replaced before the kit is delivered. A release build (`DCIM_RELEASE_BUILD=1`) refuses to produce a kit while any remain. Run `packaging/tools/check-doc-placeholders.sh` to check.

## Severity levels and targets

Targets are measured from the time your request is received during the support hours above.

| Severity | Definition | First response | Update interval | Target resolution or workaround |
|---|---|---|---|---|
| 1 - Critical | Production unavailable or *Application locked*, no workaround | 1 hour | every 2 hours | 4 hours |
| 2 - High | Major function unavailable, or a workaround is in use | 4 hours | daily | 2 business days |
| 3 - Medium | A function is degraded; most users can work | 1 business day | every 3 business days | 5 business days |
| 4 - Low | Question, cosmetic issue or enhancement request | 2 business days | on request | next release |

Severity 1 requests are made by phone as well as email. Escalate to the escalation email when a target is missed or the business impact grows.

The same support email and contact can be shown inside DCIM through the Setup Wizard (organisation settings *supportEmail* and *supportContact*), so your own users know whom to ask.

## Before you contact support

Have the following ready. It shortens the resolution time considerably.

1. **Your DCIM version.** Shown by the health check (`GET /api/health`, field `version`).
2. **What you were doing and what you expected**, with the exact message on screen.
3. **Licence status.** Settings → License (mode, company, expiry, machine ID).
4. **Health check output.** `curl http://127.0.0.1:8974/api/health` (Linux) or `Invoke-RestMethod http://127.0.0.1:8974/api/health` (Windows).
5. **Recent logs.** Linux: `sudo journalctl -u dcim -n 500`. Windows and Linux: the files in the `webapp/logs` folder. Review them before sending; they may contain user names and host names.
6. **A recent backup exists** (Settings → Backup & Restore). Do not send backups unless support asks for one.

Never send passwords, the `.env` file, or database passwords.

## What to send for each type of request

| Request | Send |
|---|---|
| New or replacement licence | Company name, machine ID, number of users, expiry required |
| Application locked | Screenshot of the lock screen, machine ID |
| Install, upgrade or repair problem | The configuration summary text and the installer's console output |
| Wrong data or crash | Time of the incident, log extract, steps to reproduce |

## Self-service first

| Problem | Guide |
|---|---|
| Install | [Installation Guide](installation-guide.md) |
| Upgrade / repair / rollback | [Upgrade](upgrade-guide.md) · [Repair](repair-guide.md) · [Rollback](rollback-guide.md) |
| Backup and disaster recovery | [Backup](backup-guide.md) · [Disaster Recovery](disaster-recovery-guide.md) |
| Administration | [Administrator Guide](administrator-guide.md) |
| Licensing | [Licensing](customer-licensing-guide.md) · [Activation](license-activation-guide.md) · [Renewal](license-renewal-guide.md) |
