# Linux server agent

Zero-dependency Node.js agent (Node ≥ 18). It **pushes** CPU, RAM, available memory, per-disk usage, load, uptime, network and disk I/O deltas, temperature (where exposed) and the state of your registered services to `POST /api/agent/ingest` over HTTPS. It opens no inbound ports, is read-only, uses `execFile` (never a shell) for `df`/`systemctl is-active`/`pgrep` on allow-listed names only, and **never restarts anything**.

## Install
1. In the UI add a **Linux server** asset; copy the one-time agent token (rotate any time from the asset page).
2. On the server:
```bash
sudo useradd --system --no-create-home tgt-agent
sudo mkdir -p /opt/tgt-agent && cd /opt/tgt-agent
sudo curl -fsSL https://monitor.example.com/agent/agent.js -o agent.js
sudo tee /etc/tgt-agent.env >/dev/null <<ENV
TGT_URL=https://monitor.example.com
TGT_TOKEN=tgtm_xxxxxxxxxxxxxxxxxxxxxxxx
TGT_INTERVAL=60
# TGT_INSECURE=1 # Uncomment if using a self-signed SSL certificate
# TGT_SERVICES=nginx,mysql # Initial services (updated dynamically by dashboard)
ENV
sudo chmod 600 /etc/tgt-agent.env
sudo tee /etc/systemd/system/tgt-agent.service >/dev/null <<UNIT
[Unit]
Description=Time Global Tech Monitor agent
After=network-online.target
[Service]
User=tgt-agent
EnvironmentFile=/etc/tgt-agent.env
ExecStart=/usr/bin/node /opt/tgt-agent/agent.js
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload && sudo systemctl enable --now tgt-agent
```
Services to watch are set on the asset (e.g. `nginx, mysql, redis-server`) and delivered to the agent in each reply.

## Detection
* No report for 3× the interval → **Server offline** (verified over consecutive checks) → incident → recovery as soon as the agent reports again.
* Thresholds default: CPU 80/95, RAM 85/95, Disk 80/90 (warning/critical); override per asset. Warnings open **Medium** incidents, critical breaches **Critical**; a worsening resource raises the severity of the open incident and re-notifies.
## Verification & Pre-flight Testing
Before starting the systemd service, verify connectivity and metric gathering with `--test`:
```bash
TGT_URL=https://monitor.example.com TGT_TOKEN=tgtm_xxxxxxxx node /opt/tgt-agent/agent.js --test
```

## Pro Features
* **Top 5 Processes:** Automatically captures the top CPU & RAM processes during spikes so you can diagnose root cause without SSH.
* **CPU Breakdown:** Tracks user, system, idle, I/O wait (disk saturation), and steal time (hypervisor throttling in cloud VMs like AWS EC2/DigitalOcean).
* **Docker Awareness:** Detects `/var/run/docker.sock` to report running and stopped container counts.
* **Pending Reboot:** Checks `/var/run/reboot-required` on Debian/Ubuntu systems to warn when a host needs a restart after security updates.

## Windows Server Agent
A PowerShell script is available at `/agent/agent.ps1` for Windows Server:
```powershell
$env:TGT_URL="https://monitor.example.com"
$env:TGT_TOKEN="tgtm_xxxxxxxxxxxxxxxxxxxxxxxx"
powershell -ExecutionPolicy Bypass -File .\agent.ps1
```
To test first on Windows:
```powershell
powershell -ExecutionPolicy Bypass -File .\agent.ps1 -Test
```
