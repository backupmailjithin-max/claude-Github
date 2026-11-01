# DCIM License Activation Guide

Follow this guide the first time you license a server, or whenever the application shows *Free trial* or *Application locked*.

You need: a Global Administrator account and the activation code or `.lic` file from your vendor.

## Step 1 - Get your machine ID (only if your licence is server-bound)

1. Sign in to DCIM as a Global Administrator.
2. Open **Settings → License**.
3. Copy the value under **This machine's ID (send this to your vendor to request a license)**. It looks like `424E-0207-8F84-0F30-3DBC-E030-2262-B341`.
4. Send it to your vendor (see the [Support Contact Guide](support-contact-guide.md)).

If the application is already locked, the same machine ID is on the *Application locked* screen.

## Step 2 - Activate with an activation code

1. Open **Settings → License** (or use the *Activate license* button in the trial banner).
2. Paste the code into **Paste the activation code your vendor sent you**. Line breaks and dashes are ignored.
3. Select **Activate**.
4. DCIM validates the code first. On success the page shows **License active** with your company name, and the application reloads.

## Step 3 (alternative) - Activate with a `.lic` file

1. Open **Settings → License**.
2. Select **Upload .lic file** and choose the file.
3. The same validation and confirmation apply.

## Step 4 - Verify

- **Settings → License** shows *License active*, *Licensed to* your company and the expiry date (if any).
- The trial banner is gone.
- Optional: `GET /api/license/status` (signed-in Global Administrator) reports `"mode":"licensed"`.

## If activation fails

| What you see | What to do |
|---|---|
| *That activation code is not valid* | The code was cut off or altered. Copy it again in full, or use the `.lic` file |
| *That is not a recognized license* | The file or code is not a DCIM licence |
| *License not applied … bound to a different machine* | Ask your vendor for a licence for this server's machine ID |
| *License not applied … expired* | Ask your vendor for a renewed licence |
| *Could not load license status* | Check that the DCIM service is running, then reload the page |

A failed activation never changes the licence that is currently installed.

## Offline servers

Activation needs no internet connection. Copy the code or file to the server by any method you normally use (for example from your laptop through the browser that is already connected to DCIM).
