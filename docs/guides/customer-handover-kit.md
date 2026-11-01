# DCIM Customer Handover Kit

Use this checklist when delivering DCIM to a customer and when the customer accepts it. Print it or keep it with the project file.

## 1. What is in the kit

| Item | Location in the kit |
|---|---|
| Start-here instructions | `README.md` |
| Linux installers (deb, rpm, appliance) | `linux/` |
| Windows installer and upgrade/repair utilities | `windows/` |
| Guides (this folder) | `common/docs/guides/` |
| Release notes, known limitations, upgrade matrix | `common/docs/` |
| Exact bundled versions | `common/docs/VERSION_REPORT.md`, `DEPENDENCY_REPORT.md` |
| File list and checksums | `MANIFEST.txt`, `CHECKSUMS.sha256` |

The kit is complete for an offline install. It contains no vendor licence-signing tools, no demo or seed data utilities, no developer tests and no private keys. The signing key stays with the vendor.

## 2. Guides to hand over

| Guide | For |
|---|---|
| Installation Guide | Installing on Linux or Windows |
| Administrator Guide | Setup Wizard, users, integrations, troubleshooting |
| Customer Licensing Guide | How the licence and the 10-day trial work |
| License Activation Guide | Activating the licence |
| License Renewal Guide | Renewing before expiry |
| Upgrade, Repair, Rollback Guides | Day-2 operations |
| Backup Guide, Disaster Recovery Guide | Protecting data |
| Support Contact Guide | Whom to call and what to send |
| Architecture Overview | How the product is built |

## 3. Vendor checklist before delivery

- [ ] Kit file name and version match the order
- [ ] `CHECKSUMS.sha256` verified: `sha256sum -c CHECKSUMS.sha256` (Linux) before shipping
- [ ] Build was a release build (vendor-signed integrity manifest)
- [ ] Customer licence issued and tested on a clean server (activation code and `.lic` file)
- [ ] Support Contact Guide table filled in with the vendor's real details
- [ ] Customer account / contract reference recorded
- [ ] Release notes and known limitations reviewed with the customer

## 4. Handover session agenda (about 90 minutes)

1. Install (or review the installed system) and save the Configuration Summary.
2. First sign-in: change every default password (`admin`, and any sample accounts) immediately.
3. Setup Wizard: organisation name, sites, zones, hardware types, monitoring integrations, SMTP and notification recipients.
4. Licence: show **Settings → License**, activate the licence, note the expiry date.
5. Backups: confirm the automatic daily backup, run a manual backup, show where files are stored, and explain what a restore does.
6. Users: create the real users, assign roles and sites; explain the user limit.
7. Day-2: show `dcim-upgrade`, `dcim-repair`, rollback, and where the logs are.
8. Support: hand over the Support Contact Guide and explain what to send in a request.

## 5. Customer acceptance

| Check | Done | Initials |
|---|---|---|
| Sign-in works for each role | ☐ | |
| Default passwords changed | ☐ | |
| Licence active, expiry date recorded | ☐ | |
| Test notification email received | ☐ | |
| Manual backup created and located | ☐ | |
| Restore procedure explained | ☐ | |
| Support contact details received | ☐ | |
| Guides received | ☐ | |

Customer name: ______________________  Date: ____________

Vendor representative: ______________________  Signature: ______________________
