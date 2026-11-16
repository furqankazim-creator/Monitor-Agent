#!/usr/bin/env bash
# Consistent online backup of the SQLite database (safe while the app is running).
set -euo pipefail
DATA_DIR="${DATA_DIR:-./data}"; OUT="${1:-./backups}"; mkdir -p "$OUT"
F="$OUT/monitor-$(date -u +%Y%m%dT%H%M%SZ).db"
sqlite3 "$DATA_DIR/monitor.db" ".backup '$F'" && gzip "$F" && echo "backup written: $F.gz"
find "$OUT" -name 'monitor-*.db.gz' -mtime +"${KEEP_DAYS:-14}" -delete
