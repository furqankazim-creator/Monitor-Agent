#!/usr/bin/env bash
# Run Time Global Tech Monitor as a macOS background service:
#   starts when you log in, restarts automatically if it crashes, and keeps the Mac awake while it runs.
#
#   bash scripts/autostart-mac.sh install     # set up and start
#   bash scripts/autostart-mac.sh status      # is it running?
#   bash scripts/autostart-mac.sh logs        # follow the log
#   bash scripts/autostart-mac.sh restart
#   bash scripts/autostart-mac.sh uninstall   # remove it (your data is untouched)
set -euo pipefail

LABEL="com.timeglobaltech.monitor"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node || true)"
UIDN="$(id -u)"
DOMAIN="gui/$UIDN"
PORT="$(grep -E '^PORT=' "$DIR/.env" 2>/dev/null | tail -1 | cut -d= -f2 || true)"; PORT="${PORT:-3000}"

health() { curl -s -m 3 "http://localhost:$PORT/healthz" || true; }
is_loaded() { launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; }

case "${1:-status}" in
  install)
    [ -n "$NODE" ] || { echo "Node.js was not found. Install Node 22.13+ first."; exit 1; }
    mkdir -p "$DIR/data" "$HOME/Library/LaunchAgents"
    # a copy started by hand would keep the port busy: stop it cleanly first (SIGTERM saves the database)
    OLD="$(lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null || true)"
    if [ -n "$OLD" ] && ! is_loaded; then echo "Stopping the copy already running on port $PORT (pid $OLD) so the service can take over..."; kill -TERM $OLD || true; sleep 3; fi
    cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/caffeinate</string><string>-i</string><string>-s</string>
    <string>$NODE</string><string>src/server.js</string>
  </array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$(dirname "$NODE"):/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ExitTimeOut</key><integer>20</integer>
  <key>StandardOutPath</key><string>$DIR/data/server.log</string>
  <key>StandardErrorPath</key><string>$DIR/data/server.log</string>
</dict>
</plist>
PLISTEOF
    is_loaded && launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    launchctl bootstrap "$DOMAIN" "$PLIST"
    launchctl kickstart -k "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
    for i in 1 2 3 4 5 6 7 8 9 10; do sleep 1; H="$(health)"; [ -n "$H" ] && break; done
    echo "Installed. Health: ${H:-no answer yet (check: bash scripts/autostart-mac.sh logs)}"
    echo "Open http://localhost:$PORT   |   it now starts at login and restarts itself if it crashes."
    ;;
  uninstall)
    is_loaded && launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"; echo "Removed the background service. Your data in $DIR/data is untouched."
    ;;
  restart) launchctl kickstart -k "$DOMAIN/$LABEL"; sleep 3; echo "Health: $(health)";;
  logs) exec tail -n 40 -f "$DIR/data/server.log";;
  status|*)
    if is_loaded; then launchctl print "$DOMAIN/$LABEL" | grep -E "^\s+(state|pid|runs|last exit code) " | sed 's/^\s*/  /'; else echo "  service not installed"; fi
    echo "  health: $(health || true)"
    ;;
esac
