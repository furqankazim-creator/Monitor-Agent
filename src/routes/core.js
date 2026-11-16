import { Router } from 'express';
import fs from 'node:fs';
import { db, audit, getSetting, setSetting, atlasStatus } from '../db.js';
import { hashPassword } from '../crypto.js';
import { isWeakPassword, setWeakFlag } from '../weakpw.js';
import { requireRole, scope, visibleProjects, ROLE_LEVEL, canSeeProject } from '../auth.js';
import { HttpError } from '../util.js';
import { uptime, avgResponse } from '../stats.js';
import { integrationStatus } from '../notify.js';
import { playwrightAvailable } from '../synthetic.js';
import { config } from '../config.js';

export const router = Router();
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const need = (v, msg) => { if (!v) throw new HttpError(400, msg); return v; };

// ---------- projects ----------
const PROJ_COLS = ['name', 'description', 'environment', 'notify_min_severity', 'notify_recovery', 'esc1_min', 'esc2_min', 'quiet_start', 'quiet_end', 'quiet_tz_offset_min'];
function projectFields(b) {
  const sev = ['informational', 'low', 'medium', 'high', 'critical']; const int = (v, d, lo, hi) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  const nullInt = (v) => (v === null || v === '' || v === undefined ? null : int(v, null, 0, 1439));
  return { name: need(str(b.name), 'Name required'), description: str(b.description, 1000), environment: ['production', 'staging', 'development'].includes(b.environment) ? b.environment : 'production',
    notify_min_severity: sev.includes(b.notify_min_severity) ? b.notify_min_severity : 'low', notify_recovery: b.notify_recovery === false || b.notify_recovery === 0 ? 0 : 1,
    esc1_min: int(b.esc1_min, 5, 0, 1440), esc2_min: int(b.esc2_min, 15, 0, 1440), quiet_start: nullInt(b.quiet_start), quiet_end: nullInt(b.quiet_end), quiet_tz_offset_min: int(b.quiet_tz_offset_min, 0, -840, 840) };
}
router.get('/projects', (req, res) => {
  const s = scope(req.user, 'p.id');
  const rows = db.all(`SELECT p.* FROM projects p WHERE p.archived=0 AND ${s.sql} ORDER BY p.name`, ...s.params);
  const t = Date.now();
  res.json(rows.map((p) => {
    const ids = db.all('SELECT id FROM assets WHERE project_id=? AND archived=0 AND deleted_at IS NULL', p.id).map((a) => a.id);
    const ups = ids.map((id) => uptime(id, t - 30 * 86400000, t).pct).filter((x) => x !== null);
    return { ...p, assets: ids.length, uptime_30d: ups.length ? Math.round((ups.reduce((a, b) => a + b, 0) / ups.length) * 100) / 100 : null, open_incidents: db.get("SELECT COUNT(*) n FROM incidents WHERE project_id=? AND status NOT IN ('resolved','closed')", p.id).n, channels_enabled: JSON.parse(p.channels_enabled), alert_categories_off: JSON.parse(p.alert_categories_off) };
  }));
});
router.post('/projects', requireRole('super_admin'), (req, res) => {
  const f = projectFields(req.body);
  try { const id = db.insert('INSERT INTO projects(name,description,environment,notify_min_severity,notify_recovery,esc1_min,esc2_min,quiet_start,quiet_end,quiet_tz_offset_min,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)', f.name, f.description, f.environment, f.notify_min_severity, f.notify_recovery, f.esc1_min, f.esc2_min, f.quiet_start, f.quiet_end, f.quiet_tz_offset_min, Date.now()); audit(req.user, 'project_create', 'project', id, f.name, req.ip); res.json({ id }); }
  catch (e) { if (/UNIQUE/.test(e.message)) throw new HttpError(409, 'A project with this name already exists'); throw e; }
});
router.put('/projects/:id', requireRole('admin'), (req, res) => {
  if (!canSeeProject(req.user, req.params.id)) throw new HttpError(404, 'Not found');
  const f = projectFields(req.body);
  const ch = { email: req.body.channels_enabled?.email !== false, whatsapp: req.body.channels_enabled?.whatsapp !== false };
  const off = Array.isArray(req.body.alert_categories_off) ? req.body.alert_categories_off.map((x) => str(x, 40)).slice(0, 40) : [];
  db.run('UPDATE projects SET name=?, description=?, environment=?, notify_min_severity=?, notify_recovery=?, esc1_min=?, esc2_min=?, quiet_start=?, quiet_end=?, quiet_tz_offset_min=?, channels_enabled=?, alert_categories_off=? WHERE id=?',
    f.name, f.description, f.environment, f.notify_min_severity, f.notify_recovery, f.esc1_min, f.esc2_min, f.quiet_start, f.quiet_end, f.quiet_tz_offset_min, JSON.stringify(ch), JSON.stringify(off), req.params.id);
  audit(req.user, 'project_update', 'project', req.params.id, null, req.ip); res.json({ ok: true });
});
router.delete('/projects/:id', requireRole('super_admin'), (req, res) => {
  if (db.get('SELECT 1 x FROM assets WHERE project_id=? AND archived=0 AND deleted_at IS NULL', req.params.id)) throw new HttpError(409, 'Archive or delete the project\'s assets first');
  db.run('UPDATE projects SET archived=1 WHERE id=?', req.params.id); audit(req.user, 'project_archive', 'project', req.params.id, null, req.ip); res.json({ ok: true });
});

// ---------- users ----------
router.get('/users', requireRole('technician'), (req, res) => {
  let rows = db.all('SELECT id,email,name,role,phone,active,totp_enabled,created_at FROM users ORDER BY name');
  if (req.user.role !== 'super_admin') { // only people who share a project with the requester (and never super admins' details beyond name)
    const v = visibleProjects(req.user) || []; const mine = new Set(db.all(`SELECT DISTINCT user_id FROM user_projects WHERE project_id IN (${v.map(() => '?').join(',') || 'NULL'})`, ...v).map((r) => r.user_id));
    rows = rows.filter((u) => mine.has(u.id) || u.id === req.user.id);
    if (req.user.role === 'technician') rows = rows.map(({ email, phone, ...r }) => ({ ...r, email: '' }));
  }
  const withProj = rows.map((u) => ({ ...u, projects: db.all('SELECT project_id FROM user_projects WHERE user_id=?', u.id).map((r) => r.project_id) }));
  res.json(withProj);
});
function validateUserBody(req, b, creating) {
  const role = b.role; if (!ROLE_LEVEL[role]) throw new HttpError(400, 'Invalid role');
  if (req.user.role === 'admin' && ROLE_LEVEL[role] >= ROLE_LEVEL.admin) throw new HttpError(403, 'Administrators can only manage technicians');
  const projects = (Array.isArray(b.projects) ? b.projects : []).map(Number).filter(Boolean);
  for (const p of projects) if (!canSeeProject(req.user, p)) throw new HttpError(403, 'You can only assign projects you manage');
  if (creating && String(b.password || '').length < 12) throw new HttpError(400, 'Password must be at least 12 characters');
  if (creating && isWeakPassword(b.password)) throw new HttpError(400, 'That password is too easy to guess or is a well-known example. Choose a longer, unique one.');
  return { role, projects };
}
router.post('/users', requireRole('admin'), (req, res) => {
  const b = req.body; const { role, projects } = validateUserBody(req, b, true);
  const email = need(str(b.email, 200).toLowerCase(), 'Email required'); if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'Invalid email');
  try {
    const id = db.tx(() => { const id = db.insert('INSERT INTO users(email,name,password_hash,role,phone,timezone,created_at) VALUES(?,?,?,?,?,?,?)', email, need(str(b.name), 'Name required'), hashPassword(b.password), role, str(b.phone, 30), str(b.timezone, 60) || 'UTC', Date.now()); for (const p of projects) db.run('INSERT OR IGNORE INTO user_projects VALUES(?,?)', id, p); return id; });
    audit(req.user, 'user_create', 'user', id, `${email} (${role})`, req.ip); res.json({ id });
  } catch (e) { if (/UNIQUE/.test(e.message)) throw new HttpError(409, 'A user with this email already exists'); throw e; }
});
router.put('/users/:id', requireRole('admin'), (req, res) => {
  const target = db.get('SELECT * FROM users WHERE id=?', req.params.id); if (!target) throw new HttpError(404, 'Not found');
  if (req.user.role === 'admin') { if (ROLE_LEVEL[target.role] >= ROLE_LEVEL.admin) throw new HttpError(403, 'Not allowed'); const shared = db.all('SELECT project_id FROM user_projects WHERE user_id=?', target.id).some((r) => canSeeProject(req.user, r.project_id)); if (!shared) throw new HttpError(404, 'Not found'); }
  const b = req.body; const { role, projects } = validateUserBody(req, { ...b, role: b.role || target.role }, false);
  if (target.id === req.user.id && (b.active === false || role !== target.role)) throw new HttpError(400, 'You cannot deactivate or change the role of your own account');
  db.tx(() => {
    db.run('UPDATE users SET name=?, role=?, phone=?, active=? WHERE id=?', str(b.name) || target.name, role, str(b.phone, 30), b.active === false ? 0 : 1, target.id);
    if (b.password) { if (String(b.password).length < 12) throw new HttpError(400, 'Password must be at least 12 characters'); if (isWeakPassword(b.password)) throw new HttpError(400, 'That password is too easy to guess or is a well-known example. Choose a longer, unique one.'); setWeakFlag(target.id, false); db.run('UPDATE users SET password_hash=?, failed_logins=0, locked_until=NULL WHERE id=?', hashPassword(b.password), target.id); db.run('DELETE FROM sessions WHERE user_id=?', target.id); }
    if (b.active === false) db.run('DELETE FROM sessions WHERE user_id=?', target.id);
    if (Array.isArray(b.projects)) { // admins may only touch assignments within their own scope
      const keep = req.user.role === 'super_admin' ? [] : db.all('SELECT project_id FROM user_projects WHERE user_id=?', target.id).map((r) => r.project_id).filter((p) => !canSeeProject(req.user, p));
      db.run('DELETE FROM user_projects WHERE user_id=?', target.id); for (const p of [...new Set([...projects, ...keep])]) db.run('INSERT OR IGNORE INTO user_projects VALUES(?,?)', target.id, p);
    }
  });
  audit(req.user, 'user_update', 'user', target.id, `${target.email}`, req.ip); res.json({ ok: true });
});

// ---------- dashboard ----------
router.get('/dashboard', (req, res) => {
  const s = scope(req.user, 'a.project_id'); const si = scope(req.user, 'i.project_id'); const t = Date.now(); const day = t - 86400000;
  const A = "a.archived=0 AND a.deleted_at IS NULL";
  const count = (extra, ...p) => db.get(`SELECT COUNT(*) n FROM assets a WHERE ${A} AND ${s.sql} ${extra}`, ...s.params, ...p).n;
  const ids = db.all(`SELECT a.id FROM assets a WHERE ${A} AND ${s.sql} AND a.verified=1`, ...s.params).map((r) => r.id);
  const ups = ids.map((id) => uptime(id, day, t).pct).filter((x) => x !== null); const avgs = ids.map((id) => avgResponse(id, day, t)).filter((x) => x !== null);
  const startOfDay = new Date(); startOfDay.setUTCHours(0, 0, 0, 0);
  res.json({
    total: count(''), online: count("AND a.status IN ('operational')"), offline: count("AND a.status='down'"), slow: count("AND a.status='slow'"), degraded: count("AND a.status='degraded'"), unknown: count("AND a.status='unknown'"), maintenance: count("AND a.status='maintenance'"),
    critical_incidents: db.get(`SELECT COUNT(*) n FROM incidents i WHERE i.severity='critical' AND i.status NOT IN ('resolved','closed') AND ${si.sql}`, ...si.params).n,
    warnings: db.get(`SELECT COUNT(*) n FROM incidents i WHERE i.severity IN ('medium','low','high') AND i.status NOT IN ('resolved','closed') AND ${si.sql}`, ...si.params).n,
    avg_uptime_24h: ups.length ? Math.round((ups.reduce((a, b) => a + b, 0) / ups.length) * 100) / 100 : null,
    avg_response_ms: avgs.length ? Math.round(avgs.reduce((a, b) => a + b, 0) / avgs.length) : null,
    alerts_today: db.get(`SELECT COUNT(*) n FROM notifications n JOIN projects p ON p.id=n.project_id WHERE n.status IN ('sent','delivered','read') AND n.sent_at>=? AND ${scope(req.user, 'n.project_id').sql}`, startOfDay.getTime(), ...scope(req.user, 'n.project_id').params).n,
    recovered_today: db.get(`SELECT COUNT(*) n FROM incidents i WHERE i.recovered_at>=? AND ${si.sql}`, startOfDay.getTime(), ...si.params).n,
    unverified: count('AND a.verified=0'), demo: count('AND a.is_demo=1'),
    recent_incidents: db.all(`SELECT i.id,i.severity,i.title,i.status,i.first_detected,a.name AS asset_name FROM incidents i JOIN assets a ON a.id=i.asset_id WHERE ${si.sql} ORDER BY i.first_detected DESC LIMIT 8`, ...si.params),
  });
});

// ---------- audit + settings + integrations status ----------
router.get('/audit', requireRole('super_admin'), (req, res) => res.json(db.all('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?', Math.min(+req.query.limit || 200, 1000))));
router.get('/settings', requireRole('admin'), (req, res) => res.json({
  allow_private_targets: config.allowPrivateTargets, allowed_hosts: config.allowedHosts, retention_days: config.retentionDays, max_concurrency: config.maxConcurrency, remote_probes: config.remoteProbes.length,
  demo_enabled: config.demoEnabled, base_url: config.baseUrl, org_name: getSetting('org_name', 'Time Global Tech'), timezone_default: getSetting('default_tz', 'UTC'),
}));
router.put('/settings', requireRole('super_admin'), (req, res) => { for (const k of ['org_name', 'default_tz']) if (req.body[k] !== undefined) setSetting(k, str(req.body[k], 100)); audit(req.user, 'settings_update', 'settings', null, null, req.ip); res.json({ ok: true }); });
router.get('/system', requireRole('admin'), async (req, res) => {
  const hb = db.all('SELECT * FROM heartbeats'); const t = Date.now();
  const fileSize = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };
  const at = atlasStatus();
  const storage = { engine: at.enabled ? 'MongoDB Atlas' : 'SQLite', atlas: at.enabled ? { database: at.database, connected: at.connected, pending: at.pending, last_saved: at.lastFlushAt, error: at.lastError } : undefined, size_bytes: at.enabled ? 0 : fileSize(db.file) + fileSize(db.file + '-wal'), last_write: db.get('SELECT MAX(ts) t FROM checks').t || null, durability: at.enabled ? 'every change is written to MongoDB Atlas within about a second' : 'every save is flushed to disk before it is confirmed',
    counts: { projects: db.get('SELECT COUNT(*) n FROM projects WHERE archived=0').n, assets: db.get('SELECT COUNT(*) n FROM assets WHERE deleted_at IS NULL').n, users: db.get('SELECT COUNT(*) n FROM users').n, recipients: db.get('SELECT COUNT(*) n FROM recipients').n, incidents: db.get('SELECT COUNT(*) n FROM incidents').n, checks: db.get('SELECT COUNT(*) n FROM checks').n }, path: req.user.role === 'super_admin' ? db.file : undefined };
  res.json({ storage, integrations: { ...integrationStatus(), playwright: await playwrightAvailable(), remote_probes: config.remoteProbes.length > 0 }, heartbeats: hb.map((h) => ({ name: h.name, age_s: Math.round((t - h.ts) / 1000), healthy: t - h.ts < 30000 })), db_file: req.user.role === 'super_admin' ? db.file : undefined });
});

// ---------- live engine status + activity feed (real data only, project-scoped) ----------
router.get('/engine', (req, res) => {
  const s = scope(req.user, 'a.project_id'); const si = scope(req.user, 'i.project_id'); const t = Date.now();
  const hb = db.get("SELECT ts FROM heartbeats WHERE name='scheduler'");
  const q = (sql, ...p) => db.get(sql, ...s.params, ...p);
  const next = q(`SELECT MIN(next_run_at) n FROM assets a WHERE a.archived=0 AND a.deleted_at IS NULL AND a.type!='server' AND a.maintenance=0 AND a.is_demo=0 AND ${s.sql}`).n;
  res.json({
    scheduler_healthy: !!hb && t - hb.ts < 30000, scheduler_age_s: hb ? Math.round((t - hb.ts) / 1000) : null,
    checks_last_min: q(`SELECT COUNT(*) n FROM checks c JOIN assets a ON a.id=c.asset_id WHERE c.kind='check' AND c.ts>=? AND ${s.sql}`, t - 60000).n,
    assets_active: q(`SELECT COUNT(*) n FROM assets a WHERE a.archived=0 AND a.deleted_at IS NULL AND ${s.sql}`).n,
    next_check_in_s: next ? Math.max(0, Math.round((next - t) / 1000)) : null,
    open_incidents: db.get(`SELECT COUNT(*) n FROM incidents i WHERE i.status NOT IN ('resolved','closed') AND ${si.sql}`, ...si.params).n,
    pending_alerts: db.get(`SELECT COUNT(*) n FROM notifications n WHERE n.status='pending' AND ${scope(req.user, 'n.project_id').sql}`, ...scope(req.user, 'n.project_id').params).n,
  });
});
router.get('/activity', (req, res) => {
  const s = scope(req.user, 'a.project_id'); const si = scope(req.user, 'i.project_id');
  const checks = db.all(`SELECT c.ts, c.state, c.response_ms, c.error, c.confirmed, a.name, a.id AS aid FROM checks c JOIN assets a ON a.id=c.asset_id WHERE c.kind='check' AND a.is_demo=0 AND ${s.sql} ORDER BY c.id DESC LIMIT 25`, ...s.params)
    .map((c) => ({ ts: c.ts, kind: 'check', level: c.state === 'ok' ? 'ok' : c.state === 'slow' ? 'warn' : c.confirmed ? 'err' : 'warn', title: c.name, text: c.state === 'ok' ? `responded in ${Math.round(c.response_ms ?? 0)} ms` : (c.error || c.state), link: `#/asset/${c.aid}` }));
  const events = db.all(`SELECT e.ts, e.type, e.message, e.incident_id, a.name FROM incident_events e JOIN incidents i ON i.id=e.incident_id JOIN assets a ON a.id=i.asset_id WHERE i.is_demo=0 AND ${si.sql} ORDER BY e.id DESC LIMIT 25`, ...si.params)
    .map((e) => ({ ts: e.ts, kind: 'event', level: /detected|failed|escalated|severity/.test(e.type) ? 'err' : /recovered|resolved|alert_sent|delivered/.test(e.type) ? 'ok' : 'info', title: `${e.name} · ${e.type.replace(/_/g, ' ')}`, text: e.message, link: `#/incident/${e.incident_id}` }));
  res.json([...checks, ...events].sort((a, b) => b.ts - a.ts).slice(0, 30));
});
