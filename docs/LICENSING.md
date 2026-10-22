# Licensing — setup guide (for you, the vendor)

This covers the offline signed-license mechanism built into the app. It is
**off by default** — a fresh checkout/build behaves exactly as before,
nothing is blocked, until you deliberately turn it on by following the steps
below. This document is for you, not your customers.

## How it works, in short

- You hold a private signing key. The app ships with the matching **public**
  key, which can verify a license but never create one.
- A license is a small signed blob: customer name, max active users,
  optional expiry date, and (optionally) the one machine it's allowed to run
  on. It comes in two equivalent forms — pick whichever is easier to send:
  - **Activation code** — the same license as one line of text (e.g.
    `eyJhbGc-iOiJFZ...`), made for pasting into **Settings → License**
    directly in the app, or into an email.
  - **`.lic` file** — the original JSON form, for uploading if you prefer
    attaching a file instead.
- The app checks the license on every request. Missing/invalid/expired →
  the app still starts and an Admin can still sign in, but everything else
  returns `402 License required` until a valid license is activated from
  **Settings → License** (or via `POST /api/license/activate`).
- A license bound to a machine ID fails immediately if it's copied to a
  different machine — the signature still checks out (it really was issued
  by you), but the machine fingerprint won't match, so the activation is
  rejected there.

See `dcim/webapp/lib/license.js` for the full verification logic and
`docs/guides/` wherever you'd like to fold this into customer-facing docs.

## 10-day free trial and auto-lock

When licensing is on (a public key is configured) and no valid `license.lic`
is present, the app starts a **10-day free trial** the first time the server
runs. Everything works and a banner shows the days left. On day 11 the app
**locks itself**: every API call except sign-out, change-password and the
license routes returns `402 LICENSE_REQUIRED`, and the UI shows an
"Application locked" screen with the machine ID and Activate / Upload .lic.
Activating a valid license unlocks immediately, no restart; data is never
touched.

- The trial start is recorded in two places - `.trial-state` next to
  `server.js` (HMAC-signed with the machine fingerprint) and the
  `license.trialStartedAt` / `license.trialSig` keys in `app_settings`. The
  earliest valid copy wins, so deleting one does not restart the clock.
  An edited or copied record counts as an ended trial.
- The machine ID shown in the app is now derived from the OS **machine-id**
  (Linux `/etc/machine-id`, Windows MachineGuid), so a hostname or network-card
  change no longer breaks a license or trial bound to it. Licenses issued
  earlier against the old ID (machine-id + MAC + hostname) are still accepted
  unchanged; those keep the old sensitivity to hostname/NIC changes until the
  vendor re-issues them against the new ID. If a host has no OS machine-id the
  composite ID is used.
- The latest time the install has ever seen is kept (signed) in `.license-clock`
  and in `app_settings` (`license.clockSeen*`, excluded from backup/restore) and
  is used for license-expiry and trial checks, so winding the system clock back
  does not revive an expired license or trial. Recovery if a wrong future clock
  poisoned it: stop the service, delete `.license-clock`, run
  `DELETE FROM app_settings WHERE k LIKE 'license.clock%';`, start the service.
- **Startup integrity check.** Every package carries `integrity.manifest.json`: SHA-256 of
  `server.js`, `lib/license.js`, `lib/license-public-key.js` and `lib/integrity.js`, signed with a throw-away
  Ed25519 key created during the build (no signing material is stored or shipped). At startup, and when a
  protected file changes (checked once a minute), the app verifies the manifest. A mismatch writes an
  `INTEGRITY_VIOLATION` audit event (`LICENSE_PUBLIC_KEY_REPLACED` when the licence public key differs),
  logs a warning and adds `integrity.warnings` to `GET /api/license/status`. Default mode is `warn` - nothing is
  blocked. Optional: `INTEGRITY_MODE=restricted` in `.env` locks the app on a failed check (activation and
  sign-out stay reachable). Risky service environment overrides (`NODE_OPTIONS` with `--require/--import/--inspect`,
  `NODE_PATH`, `LD_PRELOAD`) are reported the same way. After hand-copying a changed file onto an install, the
  warning stays until a manifest built for that file set is installed (`INTEGRITY_MODE=warn` meanwhile).
- `license.lic` is watched while the service runs: an unexpected change or removal is audited once
  (`LICENSE_FILE_MODIFIED` / `LICENSE_FILE_REMOVED`), a bad signature as `LICENSE_TAMPERED`.
- Known limit: wiping both trial records restarts the trial.
- Activation validates the upload first and only then atomically replaces
  `license.lic` (mode 600); a rejected upload leaves the installed license
  untouched. Rejected uploads, tampered stored licenses, clock rollback and
  tampered trial/clock state are written to the audit log
  (`LICENSE_UPLOAD_INVALID`, `LICENSE_UPLOAD_TAMPERED`, `LICENSE_ACTIVATE_FAILED`,
  `LICENSE_TAMPERED`, `LICENSE_CLOCK_ROLLBACK`, `LICENSE_TRIAL_TAMPERED`).
- Upgrade / repair keep `license.lic`, `.trial-state` and `.license-clock` (excluded from the
  installers' sync/delete step). Do not ship either file in a package.
- To restart the clock on a TEST machine: delete `.trial-state` and run
  `DELETE FROM app_settings WHERE k LIKE 'license.%'`.

### Clock rollback

The server remembers the latest time it has seen (signed, stored next to the trial record and in the database). Setting the system clock back, or deleting one of the two trial copies, does not give extra days: the trial uses the later of "now" and the last time seen.

### What customer packages leave out

The licence generator, key tool and issue template (`tools/license-*.js`, `Run-License-Generator.bat`, `LICENSE-ISSUE-TEMPLATE.txt`) are vendor-only and are not included in the Windows, deb or rpm packages.

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

1. The customer opens **Settings → License** in the app (visible to Global
   Admins) and copies their **machine ID** shown there, and emails it to you.
   (If the app is fully blocked and they can't reach that page for some
   reason, `GET /api/license/fingerprint` or
   `node tools/license-fingerprint.js` on their machine gives the same ID.)
2. On your own machine, with your private key:
   ```bash
   node tools/license-issue.js \
     --private-key /path/to/license-private-key.pem \
     --customer "Acme Corp" \
     --max-users 25 \
     --machine-id <the ID they sent you> \
     --out acme-corp.lic
   ```
   This prints an **activation code** (a single line of text) to the
   terminal, and also writes `acme-corp.lic` (same license, as a file) in
   case you'd rather send that instead.
   Omit `--machine-id` only for an intentionally non-machine-locked license
   (e.g. an evaluation copy) — it will then validate on any machine.
   Add `--expires 2027-10-17` only if you want the license to expire —
   by default licenses never expire.
3. Send the activation code to the customer (paste it straight into the
   email — no attachment needed). They paste it into **Settings → License**
   in the app and click **Activate**. (If they'd rather use the file, the
   same page also has an **Upload .lic file** button — either works.)
   The app unlocks immediately on success — no internet connection needed
   on their end for any of this.

   Scripting the activation instead of using the UI also works:
   ```bash
   curl -X POST http://localhost:8974/api/license/activate \
     -H "Authorization: Bearer <their admin JWT>" \
     -H "Content-Type: application/json" \
     -d '{"code":"<the activation code>"}'
   ```

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
