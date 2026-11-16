import './async-errors.js';
import express from 'express';
import path from 'node:path';
import { config, ROOT } from './config.js';
import { db, migrate, heartbeat, closeDb, usingAtlas } from './db.js';
import { sessionMiddleware, csrfGuard, requireAuth } from './auth.js';
import { bus } from './events.js';
import { startScheduler, stopScheduler, schedulerStats } from './monitor.js';
import { integrationStatus } from './notify.js';
import { HttpError, log } from './util.js';
import { auditWeakPasswords } from './weakpw.js';
import { router as authRouter } from './routes/auth.js';
import { router as coreRouter } from './routes/core.js';
import { router as assetsRouter, machineRouter } from './routes/assets.js';
import { router as incidentsRouter } from './routes/incidents.js';
import { router as alertsRouter, webhookRouter } from './routes/alerts.js';
import { router as reportsRouter } from './routes/reports.js';

const roleArg = (process.argv.find((a) => a.startsWith('--role=')) || '').split('=')[1] || process.env.ROLE || 'all'; // all | web | worker
migrate();


/** Explain "port already in use" in plain words, and say whether that is this very app (already running). */
async function explainPortInUse(port) {
  let ours = false;
  try { const r = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(2000) }); const j = await r.json(); ours = !!j && ('scheduler_age_s' in j || 'role' in j); } catch { /* not our app */ }
  const lines = ours
    ? [`\nTime Global Tech Monitor is ALREADY RUNNING on port ${port}, so there is nothing to start.`, `  -> Just open  http://localhost:${port}`, '', 'Useful commands:', '  Is the background service on?   bash scripts/autostart-mac.sh status', '  Watch its log:                  bash scripts/autostart-mac.sh logs', '  Stop it (to run by hand):       bash scripts/autostart-mac.sh uninstall   (then: npm start)']
    : [`\nPort ${port} is already used by another program, so the monitor cannot start here.`, '  Find it:                  lsof -i :' + port, `  Or use a different port:  PORT=${port + 1} npm start`];
  console.error(lines.join('\n') + '\n'); process.exit(1);
}

export function createApp() {
  const app = express();
  if (config.trustProxy) app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    if (config.cookieSecure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  });
  app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
  app.use(sessionMiddleware);

  // ---- unauthenticated operational endpoints (monitor the monitor) ----
  app.get('/healthz', (_req, res) => {
    const t = Date.now(); const hb = Object.fromEntries(db.all('SELECT name, ts FROM heartbeats').map((h) => [h.name, Math.round((t - h.ts) / 1000)]));
    let dbOk = true; try { db.get('SELECT 1'); } catch { dbOk = false; }
    const workerOk = hb.scheduler !== undefined && hb.scheduler < 30 && hb.dispatcher !== undefined && hb.dispatcher < 30;
    const body = { status: dbOk && workerOk ? 'ok' : 'degraded', db: dbOk, scheduler_age_s: hb.scheduler ?? null, dispatcher_age_s: hb.dispatcher ?? null, uptime_s: Math.round(process.uptime()) };
    res.status(body.status === 'ok' ? 200 : 503).json(body);
  });
  app.get('/metrics', (req, res) => { // Prometheus-compatible exposition of platform health
    if (config.metricsToken && req.headers.authorization !== `Bearer ${config.metricsToken}`) return res.sendStatus(401);
    const st = db.all('SELECT status, COUNT(*) n FROM assets WHERE archived=0 AND deleted_at IS NULL GROUP BY status'); const inc = db.get("SELECT COUNT(*) n FROM incidents WHERE status NOT IN ('resolved','closed')").n;
    const pend = db.get("SELECT COUNT(*) n FROM notifications WHERE status='pending'").n; const hb = db.all('SELECT name, ts FROM heartbeats');
    const lines = ['# TYPE tgt_assets gauge', ...st.map((r) => `tgt_assets{status="${r.status}"} ${r.n}`), '# TYPE tgt_open_incidents gauge', `tgt_open_incidents ${inc}`, '# TYPE tgt_notifications_pending gauge', `tgt_notifications_pending ${pend}`, '# TYPE tgt_heartbeat_age_seconds gauge', ...hb.map((h) => `tgt_heartbeat_age_seconds{service="${h.name}"} ${Math.round((Date.now() - h.ts) / 1000)}`), ''];
    res.type('text/plain; version=0.0.4').send(lines.join('\n'));
  });

  app.use('/api/webhooks', webhookRouter);
  app.use(csrfGuard);
  app.use('/api', machineRouter);            // /agent/ingest, /mobile/report, /probe (token auth)
  app.use('/api/auth', authRouter);
  app.use('/api', requireAuth);
  app.get('/api/stream', (req, res) => { // server-sent events for live dashboard updates
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' }); res.flushHeaders();
    res.write('retry: 3000\n\n');
    const h = (e) => res.write(`data: ${JSON.stringify({ type: e.type, id: e.id ?? null })}\n\n`); // no tenant data on the wire: clients refetch through authorised APIs
    bus.on('event', h); const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => { bus.off('event', h); clearInterval(ping); });
  });
  app.use('/api', coreRouter, assetsRouter, incidentsRouter, alertsRouter, reportsRouter);
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found')));

  app.get('/agent/agent.js', (_req, res) => res.sendFile(path.join(ROOT, 'agent', 'agent.cjs')));
  app.get('/agent/agent.ps1', (_req, res) => res.sendFile(path.join(ROOT, 'agent', 'agent.ps1')));
  app.use(express.static(path.join(ROOT, 'public'), { index: 'index.html', etag: true, lastModified: true, setHeaders: (res, file) => {
    // HTML/JS/CSS are revalidated on every load (cheap 304s) so an old cached copy can never mix with new files; fonts are immutable.
    if (/\.woff2$/.test(file)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable'); else res.setHeader('Cache-Control', 'no-cache');
  } }));
  app.use((err, req, res, _next) => {
    const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
    if (status >= 500) log('error', 'request failed', { path: req.path, error: err.message, stack: String(err.stack).split('\n')[1] });
    res.status(status).json({ error: status >= 500 ? 'Internal server error' : err.message });
  });
  return app;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('server.js')) {
  if (usingAtlas && roleArg !== 'all') { log('error', 'With MongoDB Atlas the app keeps a working copy in memory, so web and worker must run together. Start it with: npm start (role=all).'); process.exit(1); }
  if (roleArg === 'all' || roleArg === 'worker') startScheduler();
  if (roleArg === 'worker') { // headless worker still exposes health on PORT+1 for orchestrators
    const app = express(); app.get('/healthz', (_q, r) => { const s = schedulerStats(); r.status(Date.now() - s.lastTick < 15000 ? 200 : 503).json({ role: 'worker', ...s }); }); app.listen(config.port + 1, () => log('info', `worker health on :${config.port + 1}`)).on('error', (err) => { if (err.code === 'EADDRINUSE') explainPortInUse(config.port + 1); else { log('error', 'worker health server failed', { error: err.message }); process.exit(1); } });
  }
  if (roleArg === 'all' || roleArg === 'web') {
    var srv = createApp().listen(config.port, () => log('info', `Time Global Tech Monitor listening on :${config.port} (role=${roleArg})`, { integrations: integrationStatus() }));
    srv.on('error', (err) => { if (err.code === 'EADDRINUSE') explainPortInUse(config.port); else { log('error', 'server failed to start', { error: err.message }); process.exit(1); } });
  }
  let closing = false; // finish running checks, then write everything to the main database file before exiting
  const shutdown = async (sig) => {
    if (closing) return; closing = true; log('info', `${sig} received: saving and shutting down`);
    try { srv?.close(); await stopScheduler(); } catch { /* keep going */ }
    await closeDb(); log('info', usingAtlas ? 'all changes saved to MongoDB Atlas' : 'database flushed to disk'); process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM')); process.on('SIGINT', () => shutdown('SIGINT'));
  setTimeout(() => { auditWeakPasswords().then((n) => { if (n) log('warn', `${n} account(s) still use a known/guessable password: users are asked to change it at next sign-in`); }).catch((e) => log('warn', 'password audit failed', { error: e.message })); }, 3000).unref();
  process.on('unhandledRejection', (e) => log('error', 'unhandledRejection', { error: String(e?.stack || e) }));
}
