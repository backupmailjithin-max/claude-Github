# DCIM Support Contact Guide

## Your vendor's support details

The vendor fills in this table before delivering the kit to the customer.

| Item | Detail |
|---|---|
| Vendor company | ______________________________ |
| Support email | ______________________________ |
| Support phone | ______________________________ |
| Support hours and time zone | ______________________________ |
| Licence requests / renewals | ______________________________ |
| Emergency escalation | ______________________________ |
| Customer account / contract reference | ______________________________ |

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
