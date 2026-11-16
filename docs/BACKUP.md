# Backup & recovery

**What to back up:** (1) the SQLite database in `DATA_DIR`, (2) your `ENCRYPTION_KEY` (store it in a password manager/secret store – without it stored credentials cannot be decrypted), (3) `.env`.

* Compose: the `backup` service writes a consistent snapshot every 6 h to `./backups/monitor-<UTC>.db.gz`, pruning after 14 days. Copy `./backups` off-host (rsync/S3/restic) – a backup on the same disk is not a backup.
* Manual / cron: `npm run backup` (uses SQLite's online `.backup`, safe while running).
* Restore: `docker compose stop web worker && bash scripts/restore.sh backups/monitor-XXXX.db.gz && docker compose start web worker`. The previous DB is kept as `monitor.db.pre-restore.<ts>`.
* After a restore the scheduler records the outage window as **monitoring gaps** (not downtime) and resumes automatically; stale leases are cleared at start.
* Test a restore quarterly.
