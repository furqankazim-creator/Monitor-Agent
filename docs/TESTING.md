# Testing

```bash
npm test          # 64 automated tests, ~10 s, no external services required (uses local sockets only)
```
Tests run against real network sockets: local HTTP/TLS/TCP targets, a real SMTP sink, and a self-signed TLS endpoint (needs `openssl` on PATH; that one assertion is skipped without it). Only Meta's WhatsApp endpoint is mocked. Every test file uses an isolated temp data directory.

## Mapping to the required scenarios

| # | Scenario | Test (file → name) |
|---|---|---|
| 1 | Register website → operational | monitoring → *1. register a website…* |
| 2 | Disconnect → downtime detected (after verification) | monitoring → *2/3. downtime is VERIFIED…*, *a single transient failure never creates an incident* |
| 3 | Restore → recovery detected | same test (resolves after N good checks, timeline has detected/verified/recovered/resolved) |
| 4 | 404 / 500 / 502 / 503 | monitoring → *4. HTTP errors…* (+ expected-status override, missing content) |
| 5 | API authentication failure | monitoring → *5. API authentication failure…* |
| 6 | Incorrect JSON | monitoring → *6.* (invalid JSON, missing field, schema, assertions; bodies not stored) |
| 7 | Slow API | monitoring → *7.* (Slow status; Medium incident only when sustained) |
| 8 | CPU / RAM threshold breaches | monitoring → *8.* and *custom thresholds…* (severity, escalation, clearing) |
| 9 | Server offline | monitoring → *9.* and *server never reported → Unknown* |
| 10 | Expired / invalid SSL (controlled) | monitoring → *10.* (expiry schedule 30/14/7/3/0, expired = Critical, self-signed over a real TLS handshake) |
| 11 | Database connection failure | monitoring → *11.* (refused port, non-DB port, healthy Redis/MySQL responders) |
| 12 | WhatsApp delivery | notify → *12.* (template payload, consent gating, delivery webhooks, signature, permanent failure) – **mocked Meta endpoint**; run *Integrations → Send test* for live proof |
| 13 | Email delivery | notify → *13.* (real SMTP; branded content; recovery email; unconfigured provider never silent) |
| 14 | Duplicate-alert prevention | notify → *14.* |
| 15 | Escalation | notify → *15.* (L1 → L2 at 5 min → L3 at 15 min; ack stops L2; idempotent) + alert rules/quiet hours |
| 16 | Report generation | notify → *16.*, *16b.* and api → *report & export endpoints* (PDF/CSV/HTML, once-per-day scheduled email, gaps vs downtime) |
| 17 | User permissions | api → *17. role permissions…* |
| 18 | Project isolation (admins/technicians only see assigned projects) | api → *18.* and *secrets are masked everywhere…* |
| 19 | Worker restart → scheduler recovery | api → *19/20.* (stale lease cleared, overdue check run, gap recorded, no duplicate run) |
| 20 | Monitoring while dashboard closed | api → *19/20.* (scheduler runs with no session/HTTP client; heartbeat updates) |

Additional security tests: CSRF header, lockout, unauthenticated access, SSRF (registration, runtime IP-literal, redirect hop), secret masking/encryption, CSV formula injection, webhook verification, one-time agent tokens and revocation.

## Bugs the tests found during development (now fixed)
* Async route errors hung the request (Express 4 does not catch async rejections) → `src/async-errors.js`.
* IP-literal redirect targets bypassed the DNS SSRF guard → `guardLiteral()` on every connection path.
* Scheduler shutdown leaked timers.
A mutation check (weakening the verification threshold) is caught by 5 tests.

## Manual / environment-specific verification you should still do
1. **Integrations → Send test** for email and WhatsApp with your real credentials.
2. Install the agent on a real server and watch metrics and a stopped service raise incidents.
3. Register a Playwright workflow after `npm i playwright && npx playwright install chromium` (untested here).
4. Docker: `docker compose up -d`, then kill the `worker` container and confirm it restarts, `/healthz` flips to 503 then recovers, and gaps (not downtime) are recorded.
5. Restore drill from a backup.

## Load / soak test
A 150-asset soak (130 healthy + 20 put through a 50 s outage, 15 s interval, real server process) verified: every asset checked on schedule with zero duplicate runs and zero gaps, exactly one incident per outage, all 20 auto-recovered with a complete timeline, every GET endpoint healthy under load, ~170 MB RSS. It also found a real bug (URL-list bulk import ignored the chosen interval), now fixed with a regression test.

## UI verification
The dashboard is exercised in a real headless Chromium against a running server: login, all 15 pages, project/asset/recipient/user creation through the real forms, a live outage → incident → acknowledgement → notes → auto-recovery, reports/PDF download, live activity feed and sparklines, mobile viewport, technician role limits (25 steps, all passing).
