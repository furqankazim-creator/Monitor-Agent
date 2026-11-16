#!/usr/bin/env bash
# Restore a backup. STOP the app first:  docker compose stop web worker
set -euo pipefail
[ $# -eq 1 ] || { echo "usage: restore.sh backups/monitor-XXXX.db.gz"; exit 1; }
DATA_DIR="${DATA_DIR:-./data}"; mkdir -p "$DATA_DIR"
[ -f "$DATA_DIR/monitor.db" ] && cp "$DATA_DIR/monitor.db" "$DATA_DIR/monitor.db.pre-restore.$(date +%s)"
rm -f "$DATA_DIR/monitor.db-wal" "$DATA_DIR/monitor.db-shm"
gunzip -c "$1" > "$DATA_DIR/monitor.db" && echo "restored $1 -> $DATA_DIR/monitor.db"
