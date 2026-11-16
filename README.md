# TIME GLOBAL TECH MONITOR
**Monitor Everything. Detect Instantly. Stay Operational.**

A self-hosted 24/7 monitoring platform for websites, web apps, mobile backends, APIs, servers, databases, domains and SSL
certificates, with verified incident detection, escalation, WhatsApp + email alerting, and project-scoped access.

Built with **Node.js + Express** (backend, scheduler, workers) and a no-build vanilla-JS single-page dashboard served by Express.

---

## Honest status: what is verified and what is not

| Area | Status |
|---|---|
| Website / API / server-agent / database-liveness / SSL / domain checks | Implemented, covered by automated tests against real sockets |
| Failure verification → incident → recovery, dedupe, escalation, quiet hours, maintenance | Implemented and tested |
| Email alerts | Tested end-to-end against a real SMTP server (local sink). **Not tested against your SES/SMTP provider** – use *Integrations → Send test* |
| WhatsApp Cloud API | Request format, template payload, consent gating, delivery-status webhook and signature verification tested against a **mocked** Meta endpoint. **Never run against Meta's live API** – needs your credentials and an approved template |
| RBAC, client isolation, CSRF, SSRF guards, encrypted secrets | Implemented and tested |
| Reports (JSON/CSV/HTML/PDF, scheduled email) | Implemented and tested |
| Dashboard UI | Written and syntax-checked; see "UI verification" in `docs/TESTING.md` for what was exercised in a browser |
| Playwright synthetic workflows | Implemented, **untested** (Playwright is optional and not installed in the test environment) |
| Docker / nginx / backup scripts | Written, **not executed** (no Docker on the build machine) |
| Multi-location verification | Implemented (`/api/probe` + `REMOTE_PROBE_URLS`), tested only at the endpoint level; default is a single location |

### Deliberate deviations from the original specification
* **Express instead of FastAPI/Next.js** – as requested. UI is plain ES modules (no React/Tailwind build step).
* **SQLite (WAL) instead of PostgreSQL + Redis**; queue/leases are DB-backed. Zero-ops and fully tested, comfortable for hundreds of assets at 1-minute intervals. For much larger fleets, port `src/db.js` to PostgreSQL and move metrics to a TSDB.
* Server metrics are stored in SQLite (not a separate TSDB). `/metrics` exposes the **platform's own** health in Prometheus format.
* Database monitoring is **protocol-level liveness + latency** (PostgreSQL SSLRequest, MySQL handshake, Redis PING, TCP). It deliberately reads no data. Query latency, pool usage, replication and backup-job status need DB drivers/integrations and are **not implemented**.
* Domain expiry uses public RDAP (`rdap.org`) – best effort; when a registry doesn't publish expiry the UI says "unavailable" instead of guessing.
* Windows agent, billing/usage limits and crash-SDK packages are **not implemented**. Mobile apps report crashes/errors to a documented endpoint (`POST /api/mobile/report`).
* There is no separate Client entity or client login: **projects** are the top-level grouping. Access is scoped per project (admins and technicians only see projects they are assigned to; enforced in every query and tested), not with separate databases.

---

## Quick start (local)

```bash
npm install
cp .env.example .env            # set ENCRYPTION_KEY=$(openssl rand -hex 32); for local dev: ALLOW_PRIVATE_TARGETS=true
npm run create-admin -- --email=you@company.com --password='a-long-passphrase'
npm start                       # http://localhost:3000  (web + scheduler + dispatcher in one process)
```
Sign in, then: **Projects → Add asset**. The first check runs within seconds; the asset shows *unverified* until then.
Add alert recipients under **Alerts** and configure providers under **Integrations**.

**Fixed daily check times:** by default assets are checked every 60 s. To check only at set times (e.g. 9am, 12pm, 3pm, 5:30pm), use *Settings → Daily check schedule* (apply to all assets or one project) or the "Check only at these times" field on any asset. A problem found at a scheduled time is verified within seconds, alerted, then re-checked every few minutes (default 5) until it recovers; otherwise the asset sleeps until the next slot.

Roles: run `web` and `worker` separately for production (`npm run web`, `npm run worker`) – monitoring continues when the web process restarts.

## Production deployment (Docker Compose on a Linux VPS)

```bash
git clone <repo> && cd time-global-tech-monitor
cp .env.example .env && nano .env        # BASE_URL, ENCRYPTION_KEY, SMTP_*, TRUST_PROXY=true, COOKIE_SECURE=true
mkdir -p deploy/certs                     # place fullchain.pem + privkey.pem (certbot / your CA)
docker compose build
docker compose run --rm web node src/cli/create-admin.js --email=you@company.com --password='…'
docker compose up -d
curl -fsS https://monitor.example.com/healthz
```
Services: `web` (UI/API), `worker` (scheduler, checks, alert dispatch, escalation, reports; image includes Chromium), `nginx` (TLS, SSE-safe proxy), `backup` (6-hourly consistent SQLite backups, 14-day retention).
**Monitor the monitor:** point an *external* uptime service at `https://your-host/healthz` (returns 503 if the scheduler or dispatcher heartbeat is stale). Also in *Settings → Platform health*.

Without Docker: Node ≥ 22.13, `npm ci --omit=dev`, run `node src/server.js --role=web` and `--role=worker` under systemd (see `docs/DEPLOY.md`).

## Reliable 24/7 on your Mac, phone alerts, and a watchdog

* **Keep it running (macOS):** `bash scripts/autostart-mac.sh install`. It registers a background service that starts at login, restarts within seconds if the app crashes (tested with `kill -9`), and keeps the Mac awake while it runs. `status`, `logs`, `restart`, `uninstall` are also available. A closed laptop lid still sleeps the Mac; for true 24/7 use an always-on machine or server.
* **Phone alerts, free (ntfy):** install the *ntfy* app, then *Alerts → Add recipient → Phone push → Generate a private push topic* and subscribe to that topic in the app. Down, slow, recovered and "monitor started" messages arrive as push notifications. Alert text passes through the ntfy server (public ntfy.sh by default, or your own under *Integrations*), and anyone who knows the topic can read it, so keep it secret.
* **Watchdog (monitor the monitor):** create a free check at healthchecks.io (period 1 min, grace 5 min) and paste its ping URL under *Integrations → Watchdog*. The app pings it every minute while healthy; if the pings stop (sleep, crash, power cut) that service alerts you.
* Once the background service is installed, **do not also run `npm start` / `npm run web`**: the app is already running on port 3000 and a second copy prints "already running" and exits. Use `bash scripts/autostart-mac.sh status|logs|restart|uninstall`.
* **Real-browser page check:** a site can answer HTTP 200 and still show a blank page (for example when its JavaScript crashes). Websites and web apps are therefore also opened in a real browser every 5 minutes: a blank screen or framework error page raises an incident with the cause (JavaScript error, blocked request) and a screenshot of what a visitor sees. Needs the Playwright browser (`npm install` then `npx playwright install chromium`); turn it off per site (Advanced settings) or globally with `RENDER_CHECKS=off`.
* The dashboard shows a red **"Monitoring is NOT running"** banner whenever the checker is stopped (for example if only `npm run web` was started).

## Documentation
* `docs/DEPLOY.md` – server deployment, systemd, TLS, upgrades
* `docs/WHATSAPP.md` – Meta Cloud API setup, templates, consent, webhook
* `docs/EMAIL.md` – SMTP / Amazon SES
* `docs/AGENT.md` – Linux server agent install (systemd)
* `docs/TESTING.md` – test matrix mapped to the 20 required scenarios; how to run
* `docs/BACKUP.md` – backup & recovery
* `docs/ARCHITECTURE.md` – design, data model, security model, API overview

## Security summary
Scrypt password hashing · optional TOTP 2FA · account lockout + IP rate limiting · HttpOnly/SameSite=Strict sessions + CSRF header · strict CSP ·
AES-256-GCM encryption of API credentials, SMTP/WhatsApp secrets · secrets masked in every response · agent tokens stored hashed ·
SSRF protection (private ranges blocked at registration, at connection time via a validating DNS lookup, for IP literals, and on every redirect hop) ·
audit log · per-project data isolation · response bodies never stored · CSV formula-injection guard · signed WhatsApp webhooks.
You must only register systems you are authorised to monitor.


## MongoDB Atlas (optional cloud database)

Set `MONGODB_URI` in `.env` (see `.env.example`). Atlas then becomes the only permanent database:

- On start the app loads everything from Atlas into a fast in-memory working copy; every change is written back to Atlas within about a second (write-behind). On shutdown it flushes the rest.
- First start with an empty Atlas database imports the old `data/monitor.db` once; the file is left untouched as a backup.
- Run it as one process (`npm start`, role=all). Web and worker cannot be split because each would hold its own working copy.
- If Atlas is unreachable at start the app stops with a clear message. If it drops while running, changes queue in memory and are saved when it returns (Settings > System shows "connected / changes waiting").
- Create or reset an admin with `npm run create-admin` while the app is stopped, then start the app.
- Backups are Atlas's own (Atlas > Backup); `npm run backup` only covers the local SQLite mode.
