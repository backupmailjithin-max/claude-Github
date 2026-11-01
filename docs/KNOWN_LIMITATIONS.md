# DCIM v3.2.2 - Known Limitations

These are documented, accepted limitations as of this release - not silent
gaps. Each one has a clear workaround where applicable.

| # | Limitation | Scope | Workaround |
|---|---|---|---|
| 1 | RPM packaging requires a system Node.js >= 18 and does not yet support `--embedded-db` (no bundled runtime/MariaDB for this format). | Linux (RHEL/Rocky/Alma via `.rpm`) | Use the `.deb` or the offline appliance (`.run`) for a fully bundled, embedded-DB-capable install on Debian/Ubuntu or any distro, respectively. |
| 2 | Windows Server 2019 has no automated CI validation evidence - GitHub-hosted runners no longer offer that image. The installer itself has no code path that excludes Server 2019. | Windows | Validate Server 2019 manually in your own environment before relying on it, or deploy to Server 2022. |
| 3 | The Disaster Recovery files-archive export is export-only; restoring the exported files onto a new environment is a manual unzip into `webapp/uploads/`, not an automated import. | All platforms | Documented step-by-step in the Disaster Recovery Guide. |
| 4 | No package signing (Windows Authenticode / GPG) yet on the `.exe`/`.deb`/`.rpm` artifacts. | All platforms | Verify artifact integrity via the kit's `CHECKSUMS.sha256` instead; plan to add signing before a signed-package requirement applies to your deployment. |
| 5 | Standalone (non-`.deb`/`.rpm`) installs of `dcim-upgrade` re-apply the *cached* version of the webapp rather than fetching a newer one automatically - see the Upgrade Guide for how to upgrade to a genuinely newer release in that scenario. | Linux standalone/appliance installs | Re-run the new version's `install.sh --mode upgrade` directly from its own extracted source; `.deb`/`.rpm` upgrades are unaffected. |
| 6 | Dell OME / HPE OneView connectivity and SMTP send require a reachable target; there is no mock/simulation mode. | All platforms | Use the Setup Wizard's **Test Connection** / **Test Email** buttons against your real environment before relying on monitoring features. |
| 7 | Multi-tenant branding, license tiers, automated online update checks, and high-availability/clustered deployment are not implemented in this release. | All platforms | Tracked as future scope; single-tenant, single-instance deployment is the supported model today. |

## Accepted risks and mitigations

Each risk below is understood, accepted for this release and has a mitigation.

| # | Accepted risk | What it means | Mitigation |
|---|---|---|---|
| A1 | Offline VM clone behaviour | A copied virtual machine keeps the same machine ID, so the licence also validates on the copy. | Licence terms forbid running two copies. Seat limit and expiry still apply. Move servers through the [Machine Rebind Procedure](guides/machine-rebind-procedure.md), with written decommission confirmation. |
| A2 | Offline licensing limitations | Licence changes need a file or code from the vendor; there is no online check. | Renew 30 days ahead ([Renewal Guide](guides/license-renewal-guide.md)); keep the activation code with your records. |
| A3 | No remote revocation | A licence cannot be cancelled once issued. | Licences carry expiry dates; the vendor register marks superseded licences; replacements for lost servers can be given a shorter expiry until decommissioning is confirmed. |
| A4 | No remote disable capability | The vendor cannot lock a running installation. | Expiry is the control. Contract terms cover non-payment. |
| A5 | Notification retry limitations | A failed email is not retried and is only written to the log. | Use the Setup Wizard's **Test Email** after any SMTP change and monitor the service log. Approvals remain visible in the application whether or not the email arrived. |
| A6 | SMTP certificate validation | The mail connection does not verify the server's certificate. | Use an internal relay on a trusted network. Do not send mail through an untrusted network. |
| A7 | Real hardware dependency for OME, OneView and PDU | These features need a reachable appliance or device; there is no simulation mode. | Run the Setup Wizard's **Test Connection** against your own environment during acceptance, and follow the vendor UAT scenarios before relying on them. |
| A8 | Audit log is not in backups | `audit_logs` is not backed up and is not restored. | Keep the audit retention setting suitable for your policy and export audit data separately if you must keep it past a restore. |
| A9 | Rollback can restore an older licence file | A rollback restores the files captured at snapshot time, which can include an older `license.lic`. | After a rollback, check **Settings → License** and re-activate the current licence if needed. |

## Deviations from the originally requested validation scope

- **Windows Server 2019** (see #2 above) could not be exercised in this
  release's automated Release Gate for the stated infrastructure reason
  (not a product defect).
- The grep-based secrets-in-source scan used by the Security Validation
  gate is a floor, not a replacement for a dedicated secret-scanning
  service - it catches common high-confidence patterns (cloud provider
  keys, private key headers, chat-platform tokens) but should not be your
  only line of defense against committed secrets.
