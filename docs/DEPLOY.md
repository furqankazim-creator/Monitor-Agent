# Server deployment

## Requirements
Linux VPS (1 vCPU / 1 GB is enough for ~200 assets at 1-minute intervals), Docker 24+ with Compose v2 **or** Node ≥ 22.13, a DNS name, TLS certificate.

## Docker Compose (recommended)
1. `cp .env.example .env` and set at minimum `BASE_URL`, `ENCRYPTION_KEY` (`openssl rand -hex 32`, **back it up separately from the data volume**), `TRUST_PROXY=true`, `COOKIE_SECURE=true`.
2. TLS: `certbot certonly --standalone -d monitor.example.com`, then copy/symlink `fullchain.pem` and `privkey.pem` into `deploy/certs/`.
3. `docker compose build && docker compose up -d`
4. Create the first super administrator: `docker compose run --rm web node src/cli/create-admin.js --email=… --password=…`
5. Verify: `curl -fsS https://monitor.example.com/healthz` → `{"status":"ok",…}`.

`web` and `worker` share the `tgt-data` volume (SQLite WAL, safe for two processes). The worker holds a per-asset lease, so even if you scale to several workers, checks are not duplicated; stale leases expire after the check timeout + 45 s.

## systemd (no Docker)
`/etc/systemd/system/tgt-web.service`
```
[Unit]
Description=Time Global Tech Monitor (web)
After=network.target
[Service]
User=tgt
WorkingDirectory=/opt/tgt
EnvironmentFile=/opt/tgt/.env
ExecStart=/usr/bin/node src/server.js --role=web
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=full
[Install]
WantedBy=multi-user.target
```
`tgt-worker.service` is identical with `--role=worker`. Put nginx (see `deploy/nginx.conf`) in front for TLS.

## Firewall
Expose only 80/443. The app needs **outbound** access to the targets you monitor, SMTP, and `graph.facebook.com`. Keep `ALLOW_PRIVATE_TARGETS=false` unless you intentionally monitor internal hosts; then list them in `ALLOWED_HOSTS` instead of enabling everything where possible.

## Upgrades
`git pull && docker compose build && docker compose up -d`. Migrations in `migrations/*.sql` apply automatically at start and are recorded in `schema_migrations`. Take a backup first (`npm run backup`).

## Multi-location verification
Deploy extra instances in other regions with the same `PROBE_TOKEN`; list them in `REMOTE_PROBE_URLS` on the primary. Before opening an outage incident the primary asks each location; if any can reach the target it is treated as a local network problem and no incident is raised.

## Operational checklist
- External monitor on `/healthz`; alert on non-200.
- Scrape `/metrics` (set `METRICS_TOKEN`) with Prometheus if desired.
- Logs are JSON lines on stdout (`docker compose logs -f worker`).
- Retention: `RETENTION_DAYS` (default 90) prunes checks/metrics daily; incidents and audit log are kept.
