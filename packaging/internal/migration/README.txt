DCIM internal migration package (older live version -> new internal build)
1. Upload this zip to the server and unzip it, for example in /tmp/dcim-migration
2. Read MIGRATION-RUNBOOK.md (step by step)
3. sudo SERVICE=<service name> ./cutover.sh /home/webapp
4. If anything is wrong: sudo SERVICE=<service name> ./rollback.sh /home/webapp
Contents: webapp/ (complete new application incl. its libraries and OCR), cutover.sh, rollback.sh.
Not for customers.
