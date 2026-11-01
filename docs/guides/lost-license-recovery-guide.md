# DCIM Lost Licence Recovery Guide

Use this guide when a DCIM licence has been deleted, damaged or left behind on a server that no longer exists. Your data is never deleted when the licence is missing. DCIM shows a trial banner or the *Application locked* screen until a valid licence is activated again.

## Where the licence lives

| Item | Location | Included in DCIM backups? |
|---|---|---|
| Installed licence | `license.lic` in the `webapp` folder | No |
| Trial and clock records | `.trial-state` and `.license-clock` in the `webapp` folder, plus settings starting `license.` in the database | No |
| Your original activation code or `.lic` file | Your email or file store | No |

Because the licence is not in the backup, **restoring a backup never restores the licence**. Keep the original activation code or `.lic` file with your own records.

## Pick your scenario

| Scenario | What happened | Machine ID changes? | Result |
|---|---|---|---|
| Deleted licence | `license.lic` was removed from the server | No | Re-activate the same licence |
| Corrupted licence | The file was edited, truncated or damaged. DCIM refuses it and records a licence-tamper event | No | Re-activate the same licence with a fresh copy |
| Lost VM | The server was destroyed and rebuilt | Yes | Machine rebind: see the [Machine Rebind Procedure](machine-rebind-procedure.md) |
| Restore after disaster recovery | Data restored onto a new server | Yes (new server) | Machine rebind, then activate |

## A. Deleted or corrupted licence (same server)

1. Check whether you still have the original activation code or `.lic` file from your vendor.
2. **If you do:** sign in as a Global Administrator, open **Settings → License** (or use the *Activate license* button on the lock screen), paste the code or upload the file. See the [License Activation Guide](license-activation-guide.md). Done: no vendor action is needed.
3. **If you do not:** follow "Recovery request" below. Your vendor keeps a record of every licence issued and can send you the same licence again.

If the application will not let you sign in because the licence is missing, the Global Administrator can still sign in and reach **Settings → License**. Other users see *Application locked* until activation.

## B. Lost VM or disaster recovery (new server)

1. Build the new server and install DCIM ([Installation Guide](installation-guide.md)). A new 10-day trial starts automatically.
2. Restore your latest backup ([Disaster Recovery Guide](disaster-recovery-guide.md)). Users, inventory and settings return. The licence does not.
3. Copy the new server's machine ID from **Settings → License**.
4. Request a rebind as described in the [Machine Rebind Procedure](machine-rebind-procedure.md). State that the previous server was lost and cannot be decommissioned by you.
5. Activate the replacement licence.

## Verification required

The vendor sends a licence only after these checks:

| Check | Why |
|---|---|
| The requester is a named, authorised contact on the account | A licence is a purchased asset |
| Company name and old licence ID match the vendor's register | Confirms the right customer |
| For a new server: the new machine ID, copied from the application | Binds the licence to the right server |
| For a lost VM: written statement that the old server is destroyed or will be shut down | The old licence cannot be revoked remotely |
| The licence is within its term | Expired licences go through renewal |

## Recovery request

1. Email the licence address in the [Support Contact Guide](support-contact-guide.md) from your authorised contact.
2. Include: company name, the old licence ID if known (on your licence email), the scenario (deleted / corrupted / lost VM / disaster recovery), the current machine ID shown on the server, and a screenshot of Settings → License or the lock screen.
3. The vendor replies after the checks above, normally using the severity levels in the Support Contact Guide. An *Application locked* production system is Severity 1.

## Replacement process

| Scenario | Vendor action | Customer action |
|---|---|---|
| Deleted or corrupted, same server | Re-send the existing licence (same licence ID, same machine ID) | Activate it |
| Lost VM or disaster recovery | Issue a new licence bound to the new machine ID; supersede the old licence ID in the register | Activate it; confirm the old server is gone |

The replacement keeps the original company, user limit and expiry. A replacement never extends the term.

## Customer communication template

**Subject:** Licence recovery request: [Company name]

Hello,

We need to recover our DCIM licence.

- Company: [Company name]
- Previous licence ID (if known): [LIC-...]
- Situation: [licence file deleted / licence file damaged / server lost and rebuilt / disaster recovery]
- Current machine ID (from Settings → License): [ID]
- DCIM version: [shown on the health check]
- Production system affected: [yes / no]
- Contact for this request: [name, role, phone]

For a lost or rebuilt server we confirm that the previous server [has been destroyed / will be shut down on date].

Regards,
[Name]

## Support engineer checklist

- [ ] Requester is an authorised contact on the account
- [ ] Company and licence ID match the register
- [ ] Scenario identified (deleted / corrupted / lost VM / DR)
- [ ] Same machine ID as on file: re-send the same licence. Different ID: rebind
- [ ] For a different ID: machine ID checked character by character; decommission statement obtained
- [ ] Licence sent only to the authorised contact
- [ ] Register updated: reissue date, new licence ID if any, old ID superseded
- [ ] Customer confirmed **License active**, expiry and user limit correct
- [ ] Customer reminded to keep the activation code with their own records
- [ ] Ticket closed with licence IDs and approver recorded

## Preventing the next incident

- Store the activation code and `.lic` file with your configuration records, not only on the server.
- Record the licence ID and expiry in your asset register.
- Take backups regularly and test a restore ([Backup Guide](backup-guide.md)).
