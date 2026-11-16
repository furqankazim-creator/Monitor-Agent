# Architecture

```
                 ┌────────────── nginx (TLS) ──────────────┐
 browser ──────► │  web (Express: REST + SSE + static SPA) │ ──┐
 agents  ──────► │  POST /api/agent/ingest (token)         │   │ SQLite (WAL)
 mobile  ──────► │  POST /api/mobile/report (app key)      │   │ data volume
                 └─────────────────────────────────────────┘   │
                 ┌──────────── worker (same codebase) ─────┐   │
                 │ scheduler tick (1 s) ─► due assets      │ ◄─┘
                 │   lease → check (http/api/tls/dns/tcp)  │
                 │   → processResult → incident engine     │
                 │ dispatcher (2 s): email / WhatsApp      │
                 │ housekeeping (15 s): escalation, reports│
                 └──────────────────────────────────────────┘
```
`src/server.js --role=web|worker|all`. Web and worker are independent processes; `all` runs both for development.

## Modules
| File | Responsibility |
|---|---|
| `src/monitor.js` | Scheduler (lease-based, concurrency cap, gap recording, restart recovery), per-type check execution, result processing, agent ingest, mobile evaluation |
| `src/incidents.js` | Verification state machine `reportCondition` (N consecutive bad → open, M good → resolve), severity upgrades, SSL/domain expiry schedule |
| `src/notify.js` | Recipient resolution (level, severity, quiet hours, consent), dedupe keys, dispatch with back-off, escalation, WhatsApp webhook |
| `src/checkers/*` | HTTP probe with DNS/TCP/TLS/TTFB timings, API tester (auth, JSON/XML/schema/assertions), TLS/DNS/RDAP, DB protocol liveness |
| `src/synthetic.js` | Optional Playwright workflow runner |
| `src/ssrf.js` | Private-range blocking, validating DNS lookup, IP-literal guard |
| `src/auth.js` | Sessions, CSRF, RBAC, project/tenant scoping, rate limiting |
| `src/reports.js` | Report aggregation, CSV/HTML/PDF, scheduled delivery |
| `src/stats.js` | Uptime (verified failures only; gaps excluded), response averages, downtime windows, series |

## Key behaviours
* **Verification:** failures are retried every `retry_delay_sec` (default 10 s); an incident opens only after `verify_failures` consecutive failures (default 3). Earlier failures in the streak are then retro-marked as confirmed downtime. Optional remote-location confirmation first.
* **Recovery:** `recover_successes` consecutive good checks auto-resolve; recovery notices go only to people who received the alert.
* **Uptime:** `up / (up + verified_down)`; unconfirmed blips and monitoring gaps are excluded.
* **Dedupe / no spam:** one open incident per (asset, category); notification `dedupe_key = incident:kind:channel:address`; escalation levels fire once.
* **Time:** everything is stored as UTC epoch ms; the browser renders in the user's zone.
* **Restart safety:** leases (`assets.lease_until`) prevent duplicate runs across workers; on start all leases are cleared; overdue assets run immediately and the missed span is recorded as a `gap`.

## Roles
`super_admin` (everything) > `admin` (assigned projects only: assets, recipients, users, reports) > `technician` (assigned projects: investigate and update incidents). Projects are the top-level grouping; there is no client entity or client login.

## REST overview (all `/api`, JSON, session cookie + `X-Requested-With: tgt`)
`auth/*` · `projects` · `users` · `assets` (+`/import`, `/:id/check-now|maintenance|archive|agent-token|app-key`) · `incidents` (+`/:id/notes`, exports) · `recipients` · `notifications` · `integrations` · `reports` · `analytics` · `dashboard` · `engine` · `activity` · `system` · `audit` · `stream` (SSE) · machine endpoints `agent/ingest`, `mobile/report`, `probe`, `webhooks/whatsapp` · unauthenticated `/healthz`, `/metrics`.
