# DCIM Customer Licensing Guide

This guide explains how licensing works for your DCIM installation. It is written for the person who administers DCIM at your company.

Related guides: [License Activation Guide](license-activation-guide.md) · [License Renewal Guide](license-renewal-guide.md) · [Support Contact Guide](support-contact-guide.md)

## 1. What you receive

Your vendor issues a licence for your company. It contains your company name, the number of active users it allows, an expiry date (unless it is perpetual) and, optionally, the one server it is allowed to run on. The licence is digitally signed, so it cannot be edited or created by anyone except your vendor.

You receive it in either of two equivalent forms:

| Form | What it looks like | When to use it |
|---|---|---|
| Activation code | One long line of text | Paste it into DCIM, or send it by email or chat |
| `.lic` file | A small file | Upload it in DCIM when you prefer an attachment |

## 2. The 10-day free trial

The first time DCIM starts on a new server it begins a **10-day free trial**. Everything works during the trial and a banner shows the days left. On day 11 the application locks itself until a licence is activated. Your data is never touched, deleted or hidden by the lock: once a valid licence is activated, everything is available again immediately, with no restart.

The trial belongs to the server. Reinstalling, repairing or upgrading DCIM does not restart it, and moving the system clock backwards does not extend it.

## 3. What a licence controls

- **Active users.** Creating a user beyond the limit is refused with the message *"This license allows up to N active user(s)"*. Deactivate an existing user or ask your vendor to raise the limit.
- **Expiry.** After the expiry date the application locks as described above until you renew.
- **Server binding.** A server-bound licence works only on the server it was issued for. Copying the `.lic` file or code to another server is rejected there.

## 4. Where to find licence information in DCIM

Sign in as a Global Administrator and open **Settings → License**. The page shows:

- whether the licence is active, in trial, or required
- the company the licence is issued to, the user limit and the expiry date
- **This machine's ID**, which you send to your vendor to request a server-bound licence
- the boxes to activate or replace a licence

When DCIM is locked, an *Application locked* screen shows the same machine ID and the activation boxes.

## 5. Moving to a new server

A server-bound licence cannot be moved by copying files. Send your vendor the new server's machine ID (shown in **Settings → License** on the new server) and ask for a re-issued licence. Restore your data on the new server from a DCIM backup; licence and trial records are intentionally **not** part of backups, because they belong to one machine.

## 6. What survives upgrades, repairs and backups

| Action | Licence and trial |
|---|---|
| Upgrade (`dcim-upgrade`, upgrade utility) | Kept |
| Repair (`dcim-repair`, repair utility) | Kept |
| Rollback | Kept |
| Backup and restore | Not included, and never overwritten by a restore |
| Uninstall and fresh install | Removed, and a new trial starts. Keep your activation code so you can activate again |

## 7. Good practice

- Store your activation code in a password manager or document vault. It is your proof of licence.
- Do not edit `license.lic`, the hidden `.trial-state` and `.license-clock` files, or any file under `webapp/lib`. DCIM detects changes, records them in the audit log and may restrict the application.
- Do not change the server's date and time to an earlier value.
- Keep the server clock accurate (use your normal time synchronisation).

## 8. Messages you may see

| Message | Meaning and action |
|---|---|
| *Free trial: N days left* | Trial in progress. Activate your licence before it ends |
| *Application locked / License required* | Trial ended or licence expired. Activate or renew |
| *License expired on …* | Renew with your vendor |
| *License not applied (your existing license, if any, is unchanged)* | The code or file was not valid. Your current licence was not touched. Check you copied the whole code |
| *…bound to a different machine* | The licence was issued for another server. Request a re-issue using this server's machine ID |
| *This license allows up to N active user(s)* | User limit reached |
