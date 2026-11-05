DCIM INTERNAL - COMPLETE PACKAGE (full application, licence-free internal edition)
Contents: webapp/ (whole application with its libraries and OCR), install-new.sh, cutover.sh, rollback.sh, branding/, docs, SHA256SUMS.

1. New server with no DCIM:            sudo ./install-new.sh [/home/webapp]
   (needs Node.js 18+ and MariaDB/MySQL running; creates database, user, settings, service; nothing is downloaded)
2. Server running an OLDER version:     sudo SERVICE=<service> ./cutover.sh /home/webapp      (rollback: ./rollback.sh)
3. Server already on this generation:   use the small Internal-Update-Package with apply-update.sh instead.
Check the files first:  sha256sum -c SHA256SUMS | grep -v ": OK"   (must print nothing)
Not for customers.
