# DCIM Machine Rebind Procedure

A DCIM licence can be bound to one server. The binding is the server's **machine ID**, shown in **Settings → License**. When the server changes, the licence no longer matches and must be re-issued ("rebound") by your vendor. This guide tells you when that is needed, what to send, and what you will get back.

## Do I need a rebind?

DCIM derives the machine ID from the operating system's own machine identifier (Linux `/etc/machine-id`, Windows `MachineGuid`). It does not depend on the host name or the network card.

| Scenario | New machine ID? | Rebind needed? | Notes |
|---|---|---|---|
| Server rebuild (new hardware or new virtual machine, fresh OS) | Yes | **Yes** | Send the new server's machine ID before or just after installing DCIM |
| OS reinstall on the same server | Yes (the OS creates a new identifier) | **Yes** | Restore your data from backup, then request the rebind |
| Host name change | No | No | Nothing to do |
| Network card (NIC) replacement or IP change | No | No | Nothing to do |
| Approved VM migration where the machine keeps its OS disk (live migration, vMotion, Hyper-V move, storage move) | No | No | The OS identifier travels with the disk |
| Approved VM migration to a new virtual machine (new OS install, or an OS image that regenerates its identifier) | Yes | **Yes** | Treat as a server rebuild |
| Licence issued before the machine-ID change, and the host name or NIC has since changed | Possibly | **Yes** | Older licences used a composite of machine-ID, first NIC and host name. Ask your vendor to re-issue it against the current ID |

If you are unsure, open **Settings → License** (or read the lock screen) and compare the machine ID with the one on your licence. If they differ, a rebind is needed.

> A virtual machine **copy** (clone or snapshot restore) keeps the same machine ID. DCIM cannot tell a copy from the original. Running the same licence on two servers breaks your licence terms. When you move to a new server, shut down and decommission the old one.

## What you can do while you wait

A new installation starts a **10-day free trial**. Install DCIM on the new server, restore your data from backup (the restore does not touch licence data), and carry on while the rebind request is processed. Request the rebind on the day you start; do not wait for the trial to run low.

## The process

### 1. Collect the machine ID (customer)

1. Install DCIM on the new server and sign in as a Global Administrator.
2. Open **Settings → License**.
3. Copy the value under **This machine's ID**. It looks like `424E-0207-8F84-0F30-3DBC-E030-2262-B341`. If the application is locked, the same value is on the lock screen.

### 2. Raise the request (customer)

Send the request to the licence address in the [Support Contact Guide](support-contact-guide.md) from an authorised contact on your account. Include:

| Required information | Example |
|---|---|
| Company name as on the licence | Acme Corp |
| Licence ID of the licence being replaced | `LIC-1A2B3C4D5E6F` (on the email or licence document you received; also in the `license.licenseId` field of `GET /api/license/status`, signed in as a Global Administrator) |
| Previous machine ID | the ID of the old server |
| New machine ID | the ID from step 1 |
| Reason | OS reinstall / server rebuild / VM migration |
| Date the old server was or will be switched off | 2026-11-20 |
| Number of users required (if changing) | 25 |

### 3. Vendor validation (vendor)

The vendor does not issue a replacement until each check passes:

1. The requester is a named, authorised contact on the customer account.
2. The company and licence ID match the vendor's licence register.
3. The licence is current (not expired, or a renewal is being processed with it).
4. The reason is one of the scenarios above and the new machine ID is in the correct format.
5. For a migration, the customer confirms in writing that the old server will be decommissioned.

### 4. Licence re-issue (vendor)

1. Issue a new licence for the same company, the same number of users and the same expiry, bound to the **new** machine ID.
2. Keep a copy of every licence issued. Record in the licence register: new licence ID, old licence ID, both machine IDs, date, reason and approver.
3. Send the activation code (or the `.lic` file) to the authorised contact.

### 5. Invalidating the previous licence

DCIM works offline, so a licence cannot be cancelled remotely. The previous licence stops working on the new server because it is bound to the old machine ID. It continues to work on the old server for as long as that server runs. Therefore:

- The customer decommissions the old server (powers it off and removes or wipes it) and confirms this to the vendor.
- The vendor marks the old licence ID as **superseded** in the licence register.
- If the old server cannot be shut down immediately, the vendor may issue the replacement with a shorter expiry date and extend it once the decommissioning is confirmed.

### 6. Customer activation steps

1. Sign in to DCIM as a Global Administrator on the new server.
2. Open **Settings → License** and select **Replace license** (or **Activate**).
3. Paste the activation code, or upload the `.lic` file.
4. Confirm that the page shows **License active**, your company name and the expected expiry date.
5. Confirm that the trial banner has gone.
6. Archive the old activation code with the date of replacement.

A failed activation never changes the licence that is currently installed. If you see *bound to a different machine*, the machine ID on the licence is not the one shown on this server: re-check step 1 and tell your vendor what is shown.

## Expected outputs

| Who | Output |
|---|---|
| Customer | New server running with **License active**, correct company, user limit and expiry |
| Vendor | New licence file or activation code; updated licence register (new ID, old ID superseded) |
| Both | Written confirmation that the old server has been decommissioned |

## Support checklist

- [ ] Requester is an authorised contact on the account
- [ ] Company name and old licence ID match the register
- [ ] Reason falls under a rebind scenario (or the machine ID has not changed and no rebind is needed)
- [ ] New machine ID received as text or a screenshot of Settings → License, and checked character by character
- [ ] Expiry and user count agree with the contract
- [ ] New licence issued and bound to the new machine ID
- [ ] Register updated: new licence ID, old licence ID superseded
- [ ] Decommission confirmation requested for the old server
- [ ] Licence sent to the authorised contact only
- [ ] Customer confirmed **License active** with the correct expiry
- [ ] Ticket closed with the licence IDs recorded
