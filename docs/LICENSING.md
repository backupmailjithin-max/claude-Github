# Licensing — setup guide (for you, the vendor)

This covers the offline signed-license mechanism built into the app. It is
**off by default** — a fresh checkout/build behaves exactly as before,
nothing is blocked, until you deliberately turn it on by following the steps
below. This document is for you, not your customers.

## How it works, in short

- You hold a private signing key. The app ships with the matching **public**
  key, which can verify a license but never create one.
- A license file (`.lic`) is a small signed JSON blob: customer name, max
  active users, expiry date, and (optionally) the one machine it's allowed
  to run on.
- The app checks the license on every request. Missing/invalid/expired →
  the app still starts and an Admin can still sign in, but everything else
  returns `402 License required` until a valid license is uploaded via
  Settings → License (or `POST /api/license/activate`).
- A license bound to a machine ID fails immediately if the file is copied
  to a different machine — the signature still checks out (it really was
  issued by you), but the machine fingerprint won't match.

See `dcim/webapp/lib/license.js` for the full verification logic and
`docs/guides/` wherever you'd like to fold this into customer-facing docs.

## One-time setup (do this once, ever)

1. **Generate your signing keypair**, on a machine you control — never on a
   customer's machine, never as part of the installer:
   ```bash
   cd dcim/webapp
   node tools/license-keygen.js /somewhere/outside/this/repo
   ```
   This writes two files:
   - `license-private-key.pem` — **secret**. Move it out of this repo
     immediately, back it up somewhere safe (password manager, encrypted
     offline storage). If you lose it, you cannot issue further licenses
     under the same key — you'd have to re-keygen and reissue to everyone.
   - `license-public-key.pem` — safe to share, this is what goes in the app.

2. **Embed the public key in the app.** Open
   `dcim/webapp/lib/license-public-key.js` and replace `null` with the PEM
   contents printed by the keygen command:
   ```js
   module.exports = {
     LICENSE_PUBLIC_KEY_PEM: `-----BEGIN PUBLIC KEY-----
   ...
   -----END PUBLIC KEY-----
   `,
   };
   ```
   Commit this file (it contains no secret). From this point on, every
   build of the app enforces licensing.

3. Rebuild/redeploy (`node tools/build-min.js` if you also ship the
   minified bundle — see its own comments) and push, same as any other
   code change.

## Issuing a license to a customer (do this per customer)

1. Get the customer's machine ID. They can find it one of two ways:
   - From the command line on their machine:
     `node tools/license-fingerprint.js` (run from the installed
     `dcim/webapp` directory).
   - Or, since they're already signed in as Admin to troubleshoot an
     unlicensed install, via the API directly:
     `GET /api/license/fingerprint` (works even before activation,
     precisely so this is possible).
2. On your own machine, with your private key:
   ```bash
   node tools/license-issue.js \
     --private-key /path/to/license-private-key.pem \
     --customer "Acme Corp" \
     --max-users 25 \
     --expires 2027-10-17 \
     --machine-id <the ID they sent you> \
     --out acme-corp.lic
   ```
   Omit `--machine-id` only for an intentionally non-machine-locked license
   (e.g. an evaluation copy) — it will then validate on any machine.
   Omit `--expires` for a license that never expires.
3. Send `acme-corp.lic` to the customer. A Global Admin activates it by
   uploading the file to `POST /api/license/activate` (multipart form
   field name `license`) — e.g.:
   ```bash
   curl -X POST http://localhost:8974/api/license/activate \
     -H "Authorization: Bearer <their admin JWT>" \
     -F "license=@acme-corp.lic"
   ```
   The app unlocks immediately on success — no internet connection needed
   on their end for any of this. There's no dedicated Settings page for
   this yet (ask if you'd like one added — the backend is already fully
   wired for it: `GET /api/license/status`, `GET /api/license/fingerprint`,
   `POST /api/license/activate`).

## What this does and doesn't protect against

**Stops:** casual copying of a license file to another machine or another
customer (machine mismatch → rejected), forging a license without your
private key (signature check), and silently exceeding the purchased user
count (seat-limit check on user creation).

**Doesn't stop:** a sufficiently technical customer cloning a VM/disk image
of the exact licensed machine (a limitation of all offline node-locking,
not specific to this scheme), or you remotely revoking a license once
issued to a fully air-gapped customer (you'd only catch misuse via contact
with them — this is what your license agreement/EULA terms are for, not
the technical mechanism).

**Recommendation:** combine this with an expiry date and periodic renewal
(limits how long a leaked license stays useful) and a EULA clause limiting
the license to one machine/named seats (gives you actual recourse if you
ever do discover abuse).

## Files involved

| File | Committed? | Purpose |
|---|---|---|
| `dcim/webapp/lib/license.js` | Yes | Verification logic, shipped with every install |
| `dcim/webapp/lib/license-public-key.js` | Yes | Your public key (starts as `null` = disabled) |
| `dcim/webapp/tools/license-keygen.js` | Yes | Run once, by you, to create the keypair |
| `dcim/webapp/tools/license-issue.js` | Yes | Run per customer, by you, using your private key |
| `dcim/webapp/tools/license-fingerprint.js` | Yes | Convenience: prints this machine's ID |
| `license-private-key.pem` | **Never** | Your private key — `.gitignore`'d, keep it off this repo entirely |
| `*.lic` files | **Never** | Issued licenses — `.gitignore`'d; customers hold their own copy |
