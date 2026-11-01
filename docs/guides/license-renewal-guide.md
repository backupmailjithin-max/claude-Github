# DCIM License Renewal Guide

Renew before the expiry date. When a licence expires the application locks (data is untouched) until a renewed licence is activated.

## When to renew

Check the expiry date in **Settings → License → Licensed to / Expires**. Start the renewal at least **30 days** before that date, because your purchasing process may take time.

## Renewal steps

1. Contact your vendor (see the [Support Contact Guide](support-contact-guide.md)) and quote your company name and current licence details from **Settings → License**.
2. If you are changing servers, include the new server's machine ID.
3. If you need more users, state the new number.
4. Your vendor sends a new activation code or `.lic` file.
5. Sign in as a Global Administrator, open **Settings → License** and use **Replace license** (paste the code or upload the file).
6. Confirm the new expiry date is shown.

No restart and no downtime are needed. Replacing a licence is atomic: DCIM validates the new licence first and only then replaces the old one. If the new licence is invalid, the old one stays in place.

## If you let it expire

1. The application shows *Application locked*. Users cannot work, but nothing is deleted.
2. Request the renewed licence.
3. Activate it exactly as in the [License Activation Guide](license-activation-guide.md). Everything is available again immediately.

## Upgrading DCIM at renewal time

You can upgrade DCIM before, after or without renewing. Upgrades keep your installed licence. See the [Upgrade Guide](upgrade-guide.md).

## Checklist

- [ ] Expiry date noted in your calendar, with a reminder 30 days before
- [ ] Current user count versus the licensed limit reviewed
- [ ] New server machine ID collected (only if moving servers)
- [ ] New licence activated and the new expiry date confirmed
- [ ] Old activation code archived with the date of replacement
