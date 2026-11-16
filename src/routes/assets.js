import { Router } from 'express';
import { db, audit } from '../db.js';
import { encryptJson, decryptJson, randomToken, sha256, safeEqual } from '../crypto.js';
import { requireRole, scope, canSeeProject, visibleProjects, rateLimit } from '../auth.js';
import { HttpError, safeJson, toCsv, sleep } from '../util.js';
import { assertTargetAllowed } from '../ssrf.js';
import { parseTimes, nextSlot, isScheduled } from '../schedule.js';
import { uptime, avgResponse, series, downtimeMs } from '../stats.js';
import { ingestAgent, runNow, DEFAULT_THRESHOLDS } from '../monitor.js';
import { probe, timingsOut } from '../checkers/probe.js';
import { config } from '../config.js';
import { addEvent, incCode } from '../events.js';
import { openIncident } from '../incidents.js';
import fs from 'node:fs';
import { screenshotFile } from '../render.js';

export const router = Router();
export const machineRouter = Router(); // token-authenticated, no session

const TYPES = ['website', 'webapp', 'mobile', 'api', 'server', 'database', 'domain', 'ssl', 'custom'];
const TYPE_GROUPS = { websites: ['website'], applications: ['webapp', 'mobile'], apis: ['api'], servers: ['server'], databases: ['database'], domains: ['domain', 'ssl'] };
const MASK = '••••••••';
const str = (v, m = 300) => String(v ?? '').trim().slice(0, m);
const int = (v, d, lo, hi) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const HOST_RE = /^[a-z0-9._-]{1,253}$/i;

// Allow-listed configuration keys per type
const CONFIG_KEYS = {
  website: ['render_check', 'render_interval_min', 'check_times', 'check_tz_offset_min', 'recheck_while_down_min', 'expected_status', 'expected_content', 'forbidden_content', 'max_response_ms', 'follow_redirects', 'detect_content_change', 'headers', 'expiry_alerts', 'locations', 'website_category'],
  webapp: ['render_check', 'render_interval_min', 'check_times', 'check_tz_offset_min', 'recheck_while_down_min', 'expected_status', 'expected_content', 'forbidden_content', 'max_response_ms', 'follow_redirects', 'headers', 'expiry_alerts', 'login_url', 'health_url', 'owner', 'steps', 'workflow_interval_sec', 'workflow_verify'],
  mobile: ['check_times', 'check_tz_offset_min', 'recheck_while_down_min', 'expected_status', 'expected_content', 'max_response_ms', 'headers', 'platform', 'min_supported_version', 'error_rate_threshold', 'crash_threshold', 'push_service', 'auth_service_url'],
  api: ['check_times', 'check_tz_offset_min', 'recheck_while_down_min', 'method', 'headers', 'body', 'expected_status', 'expected_fields', 'schema', 'response_format', 'assertions', 'max_response_ms'],
  server: ['hostname', 'ip', 'os', 'thresholds', 'services', 'agent_interval_sec', 'resource_verify'],
  database: ['check_times', 'check_tz_offset_min', 'recheck_while_down_min', 'kind', 'host', 'port'],
  domain: ['check_times', 'check_tz_offset_min', 'recheck_while_down_min', 'domain', 'expiry_alerts'],
  ssl: ['check_times', 'check_tz_offset_min', 'recheck_while_down_min', 'host', 'port', 'expiry_alerts'],
  custom: ['check_times', 'check_tz_offset_min', 'recheck_while_down_min', 'host', 'port', 'expected_status', 'expected_content', 'max_response_ms', 'headers'],
};

async function normalize(b, type, existing) {
  const cfgIn = b.config && typeof b.config === 'object' ? b.config : {}; const config_ = {};
  for (const k of CONFIG_KEYS[type]) if (cfgIn[k] !== undefined && cfgIn[k] !== '') config_[k] = cfgIn[k];
  if (config_.render_check !== undefined) config_.render_check = config_.render_check !== false && config_.render_check !== 'false';
  if (config_.render_interval_min !== undefined) config_.render_interval_min = int(config_.render_interval_min, 5, 1, 120);
  if (config_.check_times !== undefined) {
    try { config_.check_times = parseTimes(config_.check_times); } catch (e) { throw new HttpError(400, e.message); }
    if (!config_.check_times.length) delete config_.check_times;
  }
  if (config_.check_times) {
    config_.check_tz_offset_min = int(config_.check_tz_offset_min, 0, -840, 840); config_.recheck_while_down_min = int(config_.recheck_while_down_min, 5, 1, 240);
  } else { delete config_.check_tz_offset_min; delete config_.recheck_while_down_min; }
  if (JSON.stringify(config_).length > 30000) throw new HttpError(400, 'Configuration too large');
  if (config_.headers && existing) { const oldH = safeJson(existing.config, {}).headers || {}; for (const k of Object.keys(config_.headers)) if (config_.headers[k] === MASK) config_.headers[k] = oldH[k] ?? ''; }
  if (config_.headers) { if (typeof config_.headers !== 'object' || Array.isArray(config_.headers)) throw new HttpError(400, 'headers must be an object'); for (const k of Object.keys(config_.headers)) if (/^(host|content-length|transfer-encoding|connection)$/i.test(k)) delete config_.headers[k]; }
  if (config_.expiry_alerts) config_.expiry_alerts = [].concat(config_.expiry_alerts).map(Number).filter((n) => Number.isFinite(n) && n >= 0).slice(0, 10);
  let target;
  if (['website', 'webapp', 'mobile', 'api'].includes(type) || (type === 'custom' && !cfgIn.host)) {
    target = str(b.target, 2000); if (!/^https?:\/\//i.test(target)) throw new HttpError(400, 'URL must start with http:// or https://');
    try { new URL(target); } catch { throw new HttpError(400, 'Invalid URL'); }
    try { await assertTargetAllowed(target); } catch (e) { throw new HttpError(400, e.message); }
    if (type === 'webapp') for (const k of ['login_url', 'health_url']) if (config_[k]) { try { await assertTargetAllowed(new URL(config_[k], target).href); } catch (e) { throw new HttpError(400, `${k}: ${e.message}`); } }
  } else if (type === 'server') { target = str(config_.hostname || b.target, 253); if (!HOST_RE.test(target)) throw new HttpError(400, 'Valid hostname required'); config_.hostname = target; if (config_.thresholds) { const th = {}; for (const k of ['cpu', 'ram', 'disk']) { const p = config_.thresholds[k]; if (Array.isArray(p) && p.length === 2 && p[0] < p[1] && p[1] <= 100 && p[0] > 0) th[k] = p.map(Number); } config_.thresholds = th; } if (config_.services) config_.services = [].concat(config_.services).map((s) => str(s, 64)).filter((s) => /^[\w.@:-]+$/.test(s)).slice(0, 50); }
  else if (type === 'database') { const h = str(config_.host, 253); if (!HOST_RE.test(h)) throw new HttpError(400, 'Valid host required'); if (!['postgres', 'mysql', 'mariadb', 'redis', 'mongodb', 'other'].includes(config_.kind)) throw new HttpError(400, 'Unsupported database kind'); config_.port = int(config_.port, null, 1, 65535); try { await assertTargetAllowed(h); } catch (e) { throw new HttpError(400, e.message); } target = `${config_.kind}://${h}${config_.port ? ':' + config_.port : ''}`; }
  else if (type === 'domain') { target = str(config_.domain || b.target, 253).toLowerCase(); if (!DOMAIN_RE.test(target)) throw new HttpError(400, 'Valid domain required (e.g. example.com)'); config_.domain = target; }
  else if (type === 'ssl') { const h = str(config_.host || b.target, 253).toLowerCase(); if (!HOST_RE.test(h)) throw new HttpError(400, 'Valid host required'); config_.host = h; config_.port = int(config_.port, 443, 1, 65535); try { await assertTargetAllowed(h); } catch (e) { throw new HttpError(400, e.message); } target = `${h}:${config_.port}`; }
  else if (type === 'custom') { const h = str(config_.host, 253); if (!HOST_RE.test(h)) throw new HttpError(400, 'Valid host required'); config_.port = int(config_.port, null, 1, 65535); if (!config_.port) throw new HttpError(400, 'Port required'); try { await assertTargetAllowed(h); } catch (e) { throw new HttpError(400, e.message); } target = `${h}:${config_.port}`; }
  // secrets: encrypted at rest, masked on read, MASK placeholder keeps previous value
  let secret_enc = existing?.secret_enc ?? null;
  if (b.secret && typeof b.secret === 'object') {
    const old = decryptJson(existing?.secret_enc) || {}; const merged = { ...b.secret };
    const keep = (n, o) => { for (const k of Object.keys(n)) { if (n[k] === MASK) n[k] = o?.[k]; else if (n[k] && typeof n[k] === 'object') keep(n[k], o?.[k]); } };
    keep(merged, old);
    secret_enc = encryptJson(Object.keys(merged).length ? merged : null);
  } else if (b.secret === null) secret_enc = null;
  const interval = int(b.interval_sec, type === 'domain' || type === 'ssl' ? 86400 : 60, type === 'domain' || type === 'ssl' ? 300 : 15, 86400);
  return {
    target, config: config_, secret_enc, interval_sec: interval, timeout_ms: int(b.timeout_ms, 10000, 1000, 60000),
    name: str(b.name, 120) || (() => { throw new HttpError(400, 'Name required'); })(), category: str(b.category, 60), environment: ['production', 'staging', 'development'].includes(b.environment) ? b.environment : 'production',
    criticality: ['critical', 'high', 'normal', 'low'].includes(b.criticality) ? b.criticality : 'normal', verify_failures: int(b.verify_failures, 2, 1, 10), recover_successes: int(b.recover_successes, 1, 1, 10), retry_delay_sec: int(b.retry_delay_sec, config.defaultRetryDelaySec, 2, 300),
    assignee_id: b.assignee_id ? Number(b.assignee_id) : null,
  };
}
function maskSecret(enc) {
  const s = decryptJson(enc); if (!s) return null;
  const m = (o) => (o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v && typeof v === 'object' ? m(v) : (v ? (['type', 'in', 'name', 'username', 'client_id', 'token_url', 'scope', 'kind'].includes(k) ? v : MASK) : v)])) : o);
  return m(s);
}
const publicAsset = (a, user) => {
  const { secret_enc, agent_token_hash, ...r } = a; const cfg = safeJson(a.config, {});
  if (cfg.headers) cfg.headers = Object.fromEntries(Object.keys(cfg.headers).map((k) => [k, MASK])); // header values may carry tokens
  const view = cfg;
  return { ...r, config: view, state: safeJson(a.state, {}), has_secret: !!secret_enc, secret_masked: maskSecret(secret_enc), has_agent_token: !!agent_token_hash };
};
function loadAsset(req, id) { const a = db.get('SELECT * FROM assets WHERE id=? AND deleted_at IS NULL', id); if (!a || !canSeeProject(req.user, a.project_id)) throw new HttpError(404, 'Asset not found'); return a; }
function assertManage(req, projectId) { if (!canSeeProject(req.user, projectId)) throw new HttpError(403, 'Not permitted for this project'); }

// ---------- list ----------
router.get('/assets', (req, res) => {
  const q = req.query; const s = scope(req.user, 'a.project_id'); const where = ['a.archived=0', 'a.deleted_at IS NULL', s.sql]; const p = [...s.params];
  if (q.group && TYPE_GROUPS[q.group]) { where.push(`a.type IN (${TYPE_GROUPS[q.group].map(() => '?').join(',')})`); p.push(...TYPE_GROUPS[q.group]); }
  if (q.type && TYPES.includes(q.type)) { where.push('a.type=?'); p.push(q.type); }
  const stat = { online: "a.status IN ('operational')", offline: "a.status='down'", slow: "a.status='slow'", degraded: "a.status='degraded'", unknown: "a.status='unknown'", maintenance: "a.status='maintenance'" }[q.status];
  if (stat) where.push(stat);
  if (q.critical === '1') where.push("EXISTS (SELECT 1 FROM incidents i WHERE i.asset_id=a.id AND i.severity='critical' AND i.status NOT IN ('resolved','closed'))");
  if (q.project_id) { where.push('a.project_id=?'); p.push(+q.project_id); }
  if (q.q) { where.push('(a.name LIKE ? OR a.target LIKE ?)'); p.push(`%${String(q.q).slice(0, 80)}%`, `%${String(q.q).slice(0, 80)}%`); }
  const sort = { name: 'a.name', status: 'a.status', response: 'a.last_response_ms', last_check: 'a.last_check_at', type: 'a.type' }[q.sort] || 'a.name'; const dir = q.dir === 'desc' ? 'DESC' : 'ASC';
  const pageSize = Math.min(int(q.page_size, 25, 1, 200), 200); const page = int(q.page, 1, 1, 100000);
  const base = `FROM assets a JOIN projects pr ON pr.id=a.project_id WHERE ${where.join(' AND ')}`;
  const total = db.get(`SELECT COUNT(*) n ${base}`, ...p).n;
  const rows = db.all(`SELECT a.*, pr.name AS project_name, u.name AS assignee_name ${base.replace('WHERE', 'LEFT JOIN users u ON u.id=a.assignee_id WHERE')} ORDER BY ${sort} ${dir}, a.id LIMIT ? OFFSET ?`, ...p, pageSize, (page - 1) * pageSize);
  const t = Date.now(); const from = q.from ? +q.from : t - 86400000; const to = q.to ? +q.to : t;
  res.json({ total, page, page_size: pageSize, items: rows.map((a) => { const inc = db.get("SELECT id,severity FROM incidents WHERE asset_id=? AND status NOT IN ('resolved','closed') ORDER BY first_detected DESC LIMIT 1", a.id); return { ...publicAsset(a, req.user), spark: db.all("SELECT response_ms v, state FROM checks WHERE asset_id=? AND kind='check' ORDER BY id DESC LIMIT 24", a.id).reverse(), project_name: a.project_name, assignee_name: a.assignee_name, uptime: uptime(a.id, from, to).pct, active_incident: inc ? { id: inc.id, code: incCode(inc.id), severity: inc.severity } : null }; }) });
});

// ---------- detail ----------
// what a real visitor's browser showed at the last render check (auth + project scoped)
router.get('/assets/:id/screenshot', (req, res) => {
  const a = loadAsset(req, req.params.id); const f = screenshotFile(a.id); if (!fs.existsSync(f)) throw new HttpError(404, 'No screenshot yet');
  res.set('Cache-Control', 'no-store'); res.type('image/jpeg').sendFile(f);
});
router.get('/assets/:id', (req, res) => {
  const a = loadAsset(req, req.params.id); const t = Date.now(); const range = { '24h': 86400000, '7d': 7 * 86400000, '30d': 30 * 86400000 }[req.query.range] || (req.query.from ? null : 86400000);
  const from = range ? t - range : +req.query.from; const to = range ? t : +req.query.to || t;
  const checks = db.all('SELECT ts,state,response_ms,status_code,size,error,confirmed,detail,kind FROM checks WHERE asset_id=? ORDER BY ts DESC LIMIT 50', a.id).map((c) => ({ ...c, detail: safeJson(c.detail) }));
  const metrics = {}; if (a.type === 'server') for (const n of ['cpu', 'ram', 'disk', 'load1']) metrics[n] = db.all('SELECT ts,value FROM metrics WHERE asset_id=? AND name=? AND ts>=? AND ts<=? ORDER BY ts', a.id, n, from, to).filter((_, i, arr) => arr.length < 400 || i % Math.ceil(arr.length / 400) === 0);
  res.json({ asset: publicAsset(a, req.user), uptime: uptime(a.id, from, to), avg_response_ms: avgResponse(a.id, from, to), downtime_ms: downtimeMs(a.id, from, to), series: series(a.id, from, to), recent_checks: checks, metrics,
    incidents: db.all('SELECT id,severity,title,status,first_detected,recovered_at,category FROM incidents WHERE asset_id=? ORDER BY first_detected DESC LIMIT 20', a.id).map((i) => ({ ...i, code: incCode(i.id) })),
    mobile: a.type === 'mobile' ? db.all('SELECT kind,platform,app_version,message,ts FROM mobile_reports WHERE asset_id=? ORDER BY ts DESC LIMIT 20', a.id) : undefined, default_thresholds: DEFAULT_THRESHOLDS });
});

// ---------- create / update / delete ----------
router.post('/assets', requireRole('admin'), async (req, res) => {
  const type = req.body.type; if (!TYPES.includes(type)) throw new HttpError(400, 'Invalid asset type');
  const pid = Number(req.body.project_id); if (!db.get('SELECT 1 x FROM projects WHERE id=? AND archived=0', pid)) throw new HttpError(400, 'Valid project required'); assertManage(req, pid);
  const n = await normalize(req.body, type);
  const dup = db.get('SELECT id,name FROM assets WHERE project_id=? AND type=? AND target=? AND archived=0 AND deleted_at IS NULL', pid, type, n.target);
  if (dup) throw new HttpError(409, `Duplicate asset: "${dup.name}" already monitors ${n.target} in this project`);
  let agentToken = null; let hash = null; if (type === 'server') { agentToken = 'tgtm_' + randomToken(24); hash = sha256(agentToken); }
  const id = db.insert(`INSERT INTO assets(project_id,type,name,target,category,environment,config,secret_enc,interval_sec,timeout_ms,criticality,verify_failures,recover_successes,retry_delay_sec,assignee_id,agent_token_hash,next_run_at,created_by,created_at,is_demo)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`, pid, type, n.name, n.target, n.category, n.environment, JSON.stringify(n.config), n.secret_enc, n.interval_sec, n.timeout_ms, n.criticality, n.verify_failures, n.recover_successes, n.retry_delay_sec, n.assignee_id, hash, Date.now(), req.user.id, Date.now());
  audit(req.user, 'asset_create', 'asset', id, `${type}: ${n.name}`, req.ip);
  res.json({ id, agent_token: agentToken }); // token is shown exactly once
});
router.put('/assets/:id', requireRole('admin'), async (req, res) => {
  const a = loadAsset(req, req.params.id); assertManage(req, a.project_id);
  const n = await normalize(req.body, a.type, a);
  db.run(`UPDATE assets SET name=?,target=?,category=?,environment=?,config=?,secret_enc=?,interval_sec=?,timeout_ms=?,criticality=?,verify_failures=?,recover_successes=?,retry_delay_sec=?,assignee_id=?, next_run_at=MIN(next_run_at, ?) WHERE id=?`,
    n.name, n.target, n.category, n.environment, JSON.stringify(n.config), n.secret_enc, n.interval_sec, n.timeout_ms, n.criticality, n.verify_failures, n.recover_successes, n.retry_delay_sec, n.assignee_id, Date.now() + n.interval_sec * 1000, a.id);
  if (isScheduled(n.config)) db.run('UPDATE assets SET next_run_at=? WHERE id=?', nextSlot(n.config.check_times, n.config.check_tz_offset_min), a.id);
  audit(req.user, 'asset_update', 'asset', a.id, n.name, req.ip); res.json({ ok: true });
});
router.post('/assets/:id/maintenance', requireRole('admin'), (req, res) => {
  const a = loadAsset(req, req.params.id); assertManage(req, a.project_id); const b = req.body;
  if (b.clear) db.run('UPDATE assets SET maintenance=0, maint_start=NULL, maint_end=NULL WHERE id=?', a.id);
  else if (b.start && b.end && +b.end > +b.start) db.run('UPDATE assets SET maintenance=0, maint_start=?, maint_end=? WHERE id=?', +b.start, +b.end, a.id);
  else db.run('UPDATE assets SET maintenance=? WHERE id=?', b.on ? 1 : 0, a.id);
  audit(req.user, 'asset_maintenance', 'asset', a.id, JSON.stringify(b).slice(0, 200), req.ip); res.json({ ok: true });
});
router.post('/assets/:id/archive', requireRole('admin'), (req, res) => { const a = loadAsset(req, req.params.id); assertManage(req, a.project_id); db.run('UPDATE assets SET archived=?, status=CASE WHEN ? THEN status ELSE \'unknown\' END WHERE id=?', req.body.archived === false ? 0 : 1, req.body.archived === false ? 1 : 0, a.id); audit(req.user, 'asset_archive', 'asset', a.id, a.name, req.ip); res.json({ ok: true }); });
router.delete('/assets/:id', requireRole('admin'), (req, res) => {
  const a = loadAsset(req, req.params.id); assertManage(req, a.project_id);
  if (req.body?.confirm !== a.name) throw new HttpError(400, 'Confirmation required: send the exact asset name in "confirm"');
  // soft delete: history (checks, incidents) is retained under the retention policy
  db.run('UPDATE assets SET deleted_at=?, archived=1 WHERE id=?', Date.now(), a.id);
  audit(req.user, 'asset_delete', 'asset', a.id, a.name, req.ip); res.json({ ok: true });
});
router.post('/assets/:id/check-now', requireRole('technician'), async (req, res) => {
  const a = loadAsset(req, req.params.id); if (a.type === 'server') throw new HttpError(400, 'Server assets report through their agent');
  const ran = await runNow(a.id); const f = db.get('SELECT status,status_reason,last_response_ms,last_status_code FROM assets WHERE id=?', a.id); res.json({ ran, ...f });
});
router.post('/assets/:id/agent-token', requireRole('admin'), (req, res) => {
  const a = loadAsset(req, req.params.id); assertManage(req, a.project_id); if (a.type !== 'server') throw new HttpError(400, 'Only server assets use agent tokens');
  const t = 'tgtm_' + randomToken(24); db.run('UPDATE assets SET agent_token_hash=? WHERE id=?', sha256(t), a.id); audit(req.user, 'agent_token_rotate', 'asset', a.id, null, req.ip); res.json({ agent_token: t });
});

// ---------- quick add: paste one URL, everything else is automatic ----------
router.post('/quick-add', requireRole('admin'), async (req, res) => {
  let url = str(req.body?.url, 2000); if (!url) throw new HttpError(400, 'Paste a website or API address');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) { // bare address: local/internal hosts and explicit ports are almost always plain HTTP; public domains default to HTTPS
    const bare = url.replace(/^\/+/, ''); const hostPart = bare.split(/[/?#]/)[0];
    const local = /^(localhost|\[::1\]|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(hostPart) || /:\d+$/.test(hostPart) || /\.(local|localhost|internal|lan)$/i.test(hostPart);
    url = (local ? 'http://' : 'https://') + bare;
  }
  let host; try { host = new URL(url).hostname; } catch { throw new HttpError(400, 'That does not look like a valid address'); }
  const type = /\/api(\/|$)|\/v\d+(\/|$)|\/graphql|\.json($|\?)/i.test(url) ? 'api' : 'website';
  let pid = req.body?.project_id ? Number(req.body.project_id) : null;
  if (!pid) { const v = visibleProjects(req.user); pid = v === null ? db.get('SELECT id FROM projects WHERE archived=0 ORDER BY id LIMIT 1')?.id : v[0]; }
  if (!pid && req.user.role === 'super_admin') { pid = db.insert('INSERT INTO projects(name,created_at) VALUES(?,?)', 'My Project', Date.now()); audit(req.user, 'project_create', 'project', pid, 'My Project (auto, quick add)', req.ip); }
  if (!pid) throw new HttpError(400, 'You are not assigned to a project yet');
  assertManage(req, pid);
  const n = await normalize({ name: str(req.body?.name, 120) || host, target: url }, type);
  const dup = db.get('SELECT id,name FROM assets WHERE project_id=? AND type=? AND target=? AND archived=0 AND deleted_at IS NULL', pid, type, n.target);
  if (dup) throw new HttpError(409, `Already monitored as "${dup.name}"`);
  const id = db.insert(`INSERT INTO assets(project_id,type,name,target,category,environment,config,secret_enc,interval_sec,timeout_ms,criticality,verify_failures,recover_successes,retry_delay_sec,next_run_at,created_by,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, pid, type, n.name, n.target, n.category, n.environment, JSON.stringify(n.config), null, n.interval_sec, n.timeout_ms, n.criticality, n.verify_failures, n.recover_successes, n.retry_delay_sec, Date.now(), req.user.id, Date.now());
  audit(req.user, 'asset_create', 'asset', id, `${type}: ${n.name} (quick add)`, req.ip);
  await Promise.race([runNow(id), sleep(5000)]); // first result right away; falls back to async if the target is slow
  const a = db.get('SELECT status,status_reason,last_response_ms,last_status_code FROM assets WHERE id=?', id);
  res.json({ id, type, name: n.name, ...a });
});

// ---------- daily check schedule: apply to many assets at once ----------
router.post('/schedule/apply', requireRole('admin'), (req, res) => {
  const b = req.body || {}; const sc = scope(req.user, 'project_id'); const where = ["archived=0", "deleted_at IS NULL", "type!='server'", sc.sql]; const p = [...sc.params];
  if (b.project_id) { if (!canSeeProject(req.user, b.project_id)) throw new HttpError(404, 'Project not found'); where.push('project_id=?'); p.push(+b.project_id); }
  let times = null;
  if (b.mode !== 'continuous') { try { times = parseTimes(b.times); } catch (e) { throw new HttpError(400, e.message); } if (!times.length) throw new HttpError(400, 'Enter at least one time, e.g. 9am, 12pm, 3pm, 5:30pm'); }
  const tz = int(b.tz_offset_min, 0, -840, 840); const recheck = int(b.recheck_min, 5, 1, 240); const rows = db.all(`SELECT id, config FROM assets WHERE ${where.join(' AND ')}`, ...p);
  db.tx(() => { for (const r of rows) {
    const cfg = safeJson(r.config, {});
    if (times) { cfg.check_times = times; cfg.check_tz_offset_min = tz; cfg.recheck_while_down_min = recheck; db.run('UPDATE assets SET config=?, next_run_at=? WHERE id=?', JSON.stringify(cfg), nextSlot(times, tz), r.id); }
    else { delete cfg.check_times; delete cfg.check_tz_offset_min; delete cfg.recheck_while_down_min; db.run('UPDATE assets SET config=?, next_run_at=? WHERE id=?', JSON.stringify(cfg), Date.now(), r.id); }
  } });
  audit(req.user, 'schedule_apply', 'project', b.project_id || 'all', times ? `${times.join(',')} tz${tz}, ${rows.length} assets` : `continuous, ${rows.length} assets`, req.ip);
  res.json({ updated: rows.length, times, next_check_at: times ? nextSlot(times, tz) : null });
});

// ---------- bulk import ----------
function parseCsv(text) {
  const rows = []; let row = []; let cur = ''; let q = false;
  for (let i = 0; i < text.length; i++) { const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true; else if (c === ',') { row.push(cur); cur = ''; } else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); if (row.some((x) => x.trim())) rows.push(row); row = []; cur = ''; } else cur += c; }
  row.push(cur); if (row.some((x) => x.trim())) rows.push(row); return rows;
}
router.post('/assets/import', requireRole('admin'), async (req, res) => {
  const { project_id, csv, urls, type = 'website', dry_run = true, interval_sec, criticality, template } = req.body || {}; const pid = Number(project_id);
  if (!db.get('SELECT 1 x FROM projects WHERE id=? AND archived=0', pid)) throw new HttpError(400, 'Valid project required'); assertManage(req, pid);
  let items = [];
  if (csv) { const rows = parseCsv(String(csv).slice(0, 500000)); const head = rows.shift().map((h) => h.trim().toLowerCase()); const ix = (n) => head.indexOf(n); if (ix('url') < 0 && ix('target') < 0) throw new HttpError(400, 'CSV needs a "url" (or "target") column'); items = rows.slice(0, 500).map((r) => ({ name: r[ix('name')], target: r[ix('url') >= 0 ? ix('url') : ix('target')], type: r[ix('type')] || type, interval_sec: r[ix('interval_sec')] || interval_sec, criticality: r[ix('criticality')] || criticality, environment: r[ix('environment')], expected_status: r[ix('expected_status')] })); }
  else if (urls) items = String(urls).split(/\s+/).filter(Boolean).slice(0, 500).map((u) => ({ target: u, type, interval_sec, criticality }));
  else throw new HttpError(400, 'Provide csv or urls');
  const seen = new Set(); const results = [];
  for (const it of items) {
    const t = TYPES.includes(it.type) ? it.type : 'website'; const target = String(it.target || '').trim(); let name = it.name?.trim();
    try {
      if (!name) { try { name = new URL(target).hostname; } catch { name = target; } }
      const body = { name, target, environment: it.environment, interval_sec: it.interval_sec, criticality: it.criticality, config: { ...(template?.config || {}), ...(it.expected_status ? { expected_status: it.expected_status } : {}), ...(t === 'domain' ? { domain: target } : {}), ...(t === 'ssl' ? { host: target } : {}) } };
      const n = await normalize(body, t);
      const key = `${t}|${n.target}`; if (seen.has(key)) { results.push({ target, status: 'duplicate', error: 'Duplicate within import' }); continue; } seen.add(key);
      if (db.get('SELECT 1 x FROM assets WHERE project_id=? AND type=? AND target=? AND archived=0 AND deleted_at IS NULL', pid, t, n.target)) { results.push({ target, status: 'duplicate', error: 'Already registered' }); continue; }
      if (!dry_run) db.insert(`INSERT INTO assets(project_id,type,name,target,category,environment,config,secret_enc,interval_sec,timeout_ms,criticality,verify_failures,recover_successes,retry_delay_sec,next_run_at,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, pid, t, n.name, n.target, n.category, n.environment, JSON.stringify(n.config), null, n.interval_sec, n.timeout_ms, n.criticality, n.verify_failures, n.recover_successes, n.retry_delay_sec, Date.now(), req.user.id, Date.now());
      results.push({ target: n.target, name: n.name, status: dry_run ? 'valid' : 'created' });
    } catch (e) { results.push({ target, status: 'invalid', error: e.message }); }
  }
  if (!dry_run) audit(req.user, 'asset_import', 'project', pid, `${results.filter((r) => r.status === 'created').length} created`, req.ip);
  res.json({ dry_run, summary: results.reduce((a, r) => ({ ...a, [r.status]: (a[r.status] || 0) + 1 }), {}), results });
});
router.get('/assets-export', requireRole('technician'), (req, res) => {
  const s = scope(req.user, 'a.project_id');
  const rows = db.all(`SELECT a.name,a.type,a.target,a.environment,a.interval_sec,a.criticality,a.status,pr.name AS project FROM assets a JOIN projects pr ON pr.id=a.project_id WHERE a.archived=0 AND a.deleted_at IS NULL AND ${s.sql}`, ...s.params);
  res.type('text/csv').attachment('assets.csv').send(toCsv(rows, ['project', 'name', 'type', 'target', 'environment', 'interval_sec', 'criticality', 'status']));
});

// ---------- machine endpoints ----------
const agentLimiter = rateLimit('agent', 120, 60000, (r) => (r.headers.authorization || r.ip).slice(-24));
machineRouter.post('/agent/ingest', agentLimiter, (req, res) => {
  const tok = String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''); if (!tok) throw new HttpError(401, 'Missing agent token');
  const a = db.get("SELECT * FROM assets WHERE agent_token_hash=? AND type='server' AND archived=0 AND deleted_at IS NULL", sha256(tok)); if (!a) throw new HttpError(401, 'Invalid agent token');
  const h = { ...a, config: safeJson(a.config, {}), state: safeJson(a.state, {}) };
  ingestAgent(h, req.body || {}); res.json({ ok: true, interval_sec: h.config.agent_interval_sec || 60, services: h.config.services || [] });
});
machineRouter.post('/mobile/report', rateLimit('mobile', 300, 60000), (req, res) => {
  const key = String(req.headers['x-app-key'] || ''); if (!key) throw new HttpError(401, 'Missing X-App-Key');
  const a = db.get("SELECT * FROM assets WHERE agent_token_hash=? AND type='mobile' AND archived=0 AND deleted_at IS NULL", sha256(key)); if (!a) throw new HttpError(401, 'Invalid app key');
  const b = req.body || {}; const kind = ['crash', 'error', 'stats'].includes(b.kind) ? b.kind : 'error';
  db.run('INSERT INTO mobile_reports(asset_id,ts,kind,platform,app_version,message,requests,failures) VALUES(?,?,?,?,?,?,?,?)', a.id, Date.now(), kind, str(b.platform, 20), str(b.app_version, 30), str(b.message, 300), int(b.requests, 0, 0, 1e7), int(b.failures, 0, 0, 1e7)); // no PII fields accepted
  res.json({ ok: true });
});
router.post('/assets/:id/app-key', requireRole('admin'), (req, res) => {
  const a = loadAsset(req, req.params.id); assertManage(req, a.project_id); if (a.type !== 'mobile') throw new HttpError(400, 'Mobile assets only');
  const k = 'tgtm_app_' + randomToken(18); db.run('UPDATE assets SET agent_token_hash=? WHERE id=?', sha256(k), a.id); res.json({ app_key: k });
});
// Remote verification probe (used by other deployments for independent multi-location verification)
machineRouter.post('/probe', rateLimit('probe', 60, 60000), async (req, res) => {
  if (!config.probeToken || !safeEqual(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''), config.probeToken)) throw new HttpError(401, 'Unauthorized');
  const url = String(req.body?.url || ''); try { await assertTargetAllowed(url); } catch (e) { throw new HttpError(400, e.message); }
  const r = await probe(url, { timeout: Math.min(+req.body.timeout || 10000, 30000) });
  res.json({ ok: !r.error && r.statusCode < 500, status: r.statusCode ?? null, error: r.error ? r.error.message : null, timings: timingsOut(r.timings || {}) });
});
