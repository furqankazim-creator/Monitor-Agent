import { config } from './config.js';
import { db, heartbeat, setSetting, getSetting } from './db.js';
import { decryptJson } from './crypto.js';
import { emit } from './events.js';
import { reportCondition, evaluateExpiry, severityFor, inMaintenance, openIncident } from './incidents.js';
import { checkWebsite } from './checkers/website.js';
import { checkApi } from './checkers/api.js';
import { probe } from './checkers/probe.js';
import { tlsInspect, resolveDns, rdapExpiry, checkDatabaseTarget } from './checkers/net.js';
import { runWorkflow } from './synthetic.js';
import { renderCheck, renderAvailable } from './render.js';
import { dispatchDue, runEscalations, pingWatchdog, notifyStartup } from './notify.js';
import { log, safeJson, sleep } from './util.js';
import { isScheduled, nextSlot, RECHECK_CATEGORIES } from './schedule.js';

const CHECKABLE = ['website', 'webapp', 'mobile', 'api', 'server', 'database', 'domain', 'ssl', 'custom'];
const running = new Set();
const QUICK_VERIFY = ['website', 'webapp', 'mobile', 'api', 'custom', 'database'];
const hydrate = (a) => ({ ...a, config: safeJson(a.config, {}), state: safeJson(a.state, {}) });
const setState = (a, patch) => { a.state = { ...a.state, ...patch }; db.run('UPDATE assets SET state=? WHERE id=?', JSON.stringify(a.state), a.id); };

// ---------------- check execution per asset type ----------------
async function executeCheck(a) {
  const secret = decryptJson(a.secret_enc);
  switch (a.type) {
    case 'website': case 'webapp': case 'mobile': return checkWebsite(a);
    case 'api': return checkApi(a, secret);
    case 'database': {
      const c = a.config; const r = await checkDatabaseTarget(c.kind || 'other', c.host, c.port, a.timeout_ms, secret?.password);
      return { state: r.ok ? 'ok' : 'fail', error: r.error, responseMs: r.ms, detail: { info: r.info } };
    }
    case 'ssl': {
      const c = a.config; const r = await tlsInspect(c.host, c.port || 443, a.timeout_ms);
      if (r.error) return { state: 'fail', error: r.error, ssl: null };
      return { state: 'ok', responseMs: r.ms, ssl: r, detail: { days_left: r.daysLeft, issuer: r.issuer, expires: r.validTo } };
    }
    case 'domain': return checkDomain(a);
    case 'server': {
      const stale = (a.config.agent_interval_sec || 60) * 3 * 1000;
      const age = a.last_heartbeat_at ? Date.now() - a.last_heartbeat_at : null;
      if (age === null) return { state: 'unknown', error: 'Agent has never reported. Install the agent on the server.', skipCount: true };
      return age > stale ? { state: 'fail', error: `Agent heartbeat lost: last report ${Math.round(age / 1000)}s ago (server unreachable or agent stopped)` } : { state: 'ok' };
    }
    case 'custom': {
      const c = a.config;
      if (c.host && c.port) { const r = await checkDatabaseTarget('other', c.host, c.port, a.timeout_ms); return { state: r.ok ? 'ok' : 'fail', error: r.error, responseMs: r.ms }; }
      return checkWebsite(a);
    }
    default: return { state: 'unknown', error: 'unsupported type' };
  }
}

async function checkDomain(a) {
  const d = a.config.domain || a.target; const out = { state: 'ok', detail: {} };
  const t0 = performance.now(); const dnsr = await resolveDns(d); out.responseMs = Math.round(performance.now() - t0);
  out.dns = dnsr;
  if (dnsr.error) { out.state = 'fail'; out.error = `DNS resolution failed: ${dnsr.error}`; return out; }
  out.detail = { a: dnsr.a.length, ns: dnsr.ns };
  const st = a.state;
  if (!st.rdap_at || Date.now() - st.rdap_at > 24 * 3600 * 1000) { out.rdap = await rdapExpiry(d); }
  return out;
}

// ---------------- result processing ----------------
const FAIL_CATEGORY = { website: 'availability', webapp: 'availability', mobile: 'availability', custom: 'availability', api: 'api_failure', database: 'database', server: 'agent', domain: 'dns', ssl: 'ssl' };
const FAIL_TITLE = { availability: 'Website offline', api_failure: 'API failure', database: 'Database unavailable', agent: 'Server offline', dns: 'DNS failure', ssl: 'SSL certificate problem' };

async function publicExternalCheck(url) {
  try {
    const res = await fetch(`https://api.hackertarget.com/httpheaders/?q=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const txt = await res.text();
    const firstLine = txt.split('\n')[0] || '';
    const match = firstLine.match(/HTTP\/[0-9.]+\s+([0-9]{3})/i);
    if (match) {
      const code = +match[1];
      return { ok: code >= 200 && code < 400, statusCode: code };
    }
  } catch {}
  return null;
}

async function remoteConfirm(a) {
  // 1. Independent verification from other monitoring locations (other deployments of this app running /api/probe).
  if (config.remoteProbes.length && ['website', 'webapp', 'mobile', 'api'].includes(a.type)) {
    const results = await Promise.all(config.remoteProbes.map(async (base) => {
      try {
        const res = await fetch(`${base.replace(/\/$/, '')}/api/probe`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${config.probeToken}` }, body: JSON.stringify({ url: a.target, timeout: a.timeout_ms }), signal: AbortSignal.timeout(a.timeout_ms + 5000) });
        const j = await res.json(); return j.ok ? { base, ok: true } : { base, ok: false };
      } catch { return null; }
    }));
    const valid = results.filter(Boolean);
    if (valid.length) return { reachable: valid.some((v) => v.ok), n: valid.length };
  }

  // 2. Fallback external global route verification:
  // If local Mac has ISP routing timeouts to the target, verify with an external cloud route before raising alarm
  if (['website', 'webapp', 'api'].includes(a.type) && /^https?:\/\//i.test(a.target)) {
    try {
      const ext = await publicExternalCheck(a.target);
      if (ext && ext.ok) {
        log('info', 'external route confirms site is operational globally, local network timeout ignored', { asset: a.name, target: a.target, statusCode: ext.statusCode });
        return { reachable: true, n: 1, externalVerified: true, statusCode: ext.statusCode };
      }
    } catch {}
  }

  // 3. Local network blackout protection (Circuit Breaker):
  // When 3+ completely separate assets fail simultaneously with network timeouts / DNS errors,
  // the monitoring station's own local ISP/connection is impaired. Suppress false alarms!
  try {
    const t = Date.now();
    const mass = db.get("SELECT COUNT(DISTINCT asset_id) AS n FROM checks WHERE state='fail' AND ts>=? AND (error LIKE '%Timeout%' OR error LIKE '%DNS%' OR error LIKE '%ECONNREFUSED%')", t - 60000);
    if ((mass?.n || 0) >= 3) {
      log('warn', 'circuit breaker active: local network disruption detected on monitor host, suppressing false alerts', { affected_assets: mass.n });
      return { reachable: true, n: 1, localNetworkBlackout: true };
    }
  } catch {}

  return null;
}

/** When should this asset run next? Continuous assets use their interval; scheduled assets use the daily slots, but retry fast to
 *  verify a failure and re-check every few minutes while a problem is open so recovery is noticed. */
function computeNext(a, t, retry, interval) {
  const jitter = Math.floor(Math.random() * 1000);
  if (retry) return t + Math.min(a.retry_delay_sec * 1000, interval) + jitter;
  // While ANY problem is open, look again soon so the status turns green BY ITSELF the moment it is fixed (nobody has to press "Check now"),
  // even for sites whose normal interval is 15 minutes or "only at set times".
  const open = db.get(`SELECT 1 x FROM incidents WHERE asset_id=? AND status NOT IN ('resolved','closed') AND category IN (${RECHECK_CATEGORIES.map(() => '?').join(',')}) LIMIT 1`, a.id, ...RECHECK_CATEGORIES);
  if (open) { const every = isScheduled(a.config) ? Math.max(1, a.config.recheck_while_down_min || 5) * 60000 : Math.min(interval, 60000); return t + every + jitter; }
  if (!isScheduled(a.config)) return t + interval + jitter;
  return nextSlot(a.config.check_times, a.config.check_tz_offset_min, t) ?? t + interval + jitter;
}

export async function processResult(a, r) {
  const t = Date.now(); const maint = inMaintenance(a, t);
  // alerts are built while this runs: store the latest status code / latency first so they never report the previous check
  if (r.state !== 'unknown') { db.run('UPDATE assets SET last_status_code=?, last_response_ms=COALESCE(?, last_response_ms) WHERE id=?', r.statusCode ?? null, r.responseMs ?? null, a.id); a.last_status_code = r.statusCode ?? null; if (r.responseMs != null) a.last_response_ms = r.responseMs; }
  const detail = JSON.stringify(r.detail || {});
  let confirmed = 0;
  let status = a.status; let reason = r.error || null; let retry = false;

  if (r.state === 'unknown') { // e.g. server never reported
    status = 'unknown';
  } else if (maint) {
    status = 'maintenance'; reason = 'Scheduled maintenance: alerts suppressed';
  } else if (a.type === 'ssl' || a.type === 'domain') {
    status = a.status; // handled by the type-specific block below
  } else if (r.state === 'fail') {
    const cat = FAIL_CATEGORY[a.type] || 'availability';
    let rc = null;
    const open = openIncident(a.id, cat);
    const peek = db.get('SELECT fail_count FROM conditions WHERE asset_id=? AND category=?', a.id, cat);
    if ((peek?.fail_count || 0) + 1 >= a.verify_failures || open) rc = await remoteConfirm(a);
    if (rc && rc.reachable) { // other locations can reach it or local network blackout: don't open a false down incident
      if (open) reportCondition(a, cat, { bad: false, recover: 1, recoveryNote: 'Recovered: site verified operational globally via external route.' });
      status = 'degraded'; reason = rc.localNetworkBlackout ? `Monitoring station local network timeout (circuit breaker active, suppressing false alerts)` : rc.externalVerified ? `Operational globally (verified HTTP ${rc.statusCode} via external route), but timing out on local network` : `Failed from primary location but reachable from ${rc.n} other location(s): ${r.error}`; retry = true;
    } else {
      const res = reportCondition(a, cat, { bad: true, severity: severityFor(a, 'availability'), title: FAIL_TITLE[cat], description: r.error });
      if (res.incident) { status = 'down'; confirmed = 1; if (res.opened && res.failCount > 1) db.run("UPDATE checks SET confirmed=1 WHERE id IN (SELECT id FROM checks WHERE asset_id=? AND state='fail' ORDER BY ts DESC LIMIT ?)", a.id, res.failCount - 1); }
      else { status = 'degraded'; reason = `Verifying failure (${res.failCount}/${a.verify_failures}): ${r.error}`; retry = true; }
    }
    db.run("UPDATE conditions SET ok_count=0 WHERE asset_id=? AND category='performance'", a.id);
  } else { // ok | slow
    const cat = FAIL_CATEGORY[a.type] || 'availability';
    const sched = isScheduled(a.config); reportCondition(a, cat, { bad: false, ...(sched ? { recover: 1 } : {}) });
    if (r.state === 'slow') {
      const res = reportCondition(a, 'performance', { bad: true, severity: 'medium', title: 'Slow response', description: r.error, verify: a.verify_failures });
      status = 'slow'; // slow responses show amber immediately; a Medium incident opens only if sustained
    } else { reportCondition(a, 'performance', { bad: false, ...(sched ? { recover: 1 } : {}) }); status = 'operational'; reason = null; }
    // downstream conditions
    if (r.cert) evaluateExpiry(a, 'ssl_expiry', Math.floor((r.cert.validTo - t) / 86400000), `SSL certificate for ${new URL(a.target).hostname}`, a.config.expiry_alerts);
    if (r.contentHash !== undefined) {
      const changed = a.state.content_hash && a.state.content_hash !== r.contentHash;
      setState(a, { content_hash: r.contentHash });
      reportCondition(a, 'content_change', { bad: !!changed, severity: 'low', title: 'Unexpected content change', description: 'Page content changed since the previous check', verify: 1, recover: 2 });
    }
  }

  if (a.type === 'ssl' && !maint && !r.ssl) {
    const res = reportCondition(a, 'ssl', { bad: true, severity: 'critical', title: 'SSL check failed', description: `${a.config.host}: ${r.error}`, verify: a.verify_failures, recover: 1 });
    status = res.incident ? 'down' : 'degraded'; reason = r.error; confirmed = res.incident ? 1 : 0;
  }
  if (a.type === 'ssl' && r.ssl && !maint) {
    const s = r.ssl; const host = a.config.host;
    const bad = !s.authorized || !!s.hostnameMismatch || s.daysLeft < 0;
    const why = s.daysLeft < 0 ? 'Certificate has expired' : s.hostnameMismatch ? `Hostname mismatch: ${s.hostnameMismatch}` : `Certificate chain not trusted: ${s.authError}`;
    const res = reportCondition(a, 'ssl', { bad, severity: 'critical', title: s.daysLeft < 0 ? 'SSL certificate expired' : 'SSL certificate invalid', description: `${host}: ${why}`, verify: 1, recover: 1 });
    evaluateExpiry(a, 'ssl_expiry', s.daysLeft, `SSL certificate for ${host}`, a.config.expiry_alerts);
    status = bad ? 'down' : s.daysLeft <= 7 ? 'degraded' : 'operational'; reason = bad ? why : s.daysLeft <= 30 ? `Expires in ${s.daysLeft} days` : null;
    if (res.incident) confirmed = 1;
    if (s.daysLeft <= 7) a.next_override = 3600 * 1000; // check hourly near expiry
    setState(a, { ssl: { daysLeft: s.daysLeft, validTo: s.validTo, issuer: s.issuer, protocol: s.protocol } });
  }
  if (a.type === 'domain' && !maint) {
    const st = {}; let nsChanged = false;
    if (r.dns && !r.dns.error) { const ns = r.dns.ns.join(','); if (a.state.ns && a.state.ns !== ns) nsChanged = true; st.ns = ns; }
    if (r.rdap) { st.rdap_at = t; st.rdap = r.rdap; } else if (a.state.rdap) st.rdap = a.state.rdap;
    setState(a, st);
    const dnsRes = reportCondition(a, 'dns', { bad: r.state === 'fail', severity: 'high', title: 'DNS failure', description: r.error, verify: a.verify_failures, recover: 1 });
    if (nsChanged) { reportCondition(a, 'dns_ns_change', { bad: true, severity: 'medium', title: 'Nameservers changed', description: `Nameservers changed to: ${st.ns}`, verify: 1 }); setState(a, { ns: st.ns }); }
    const exp = st.rdap?.expiresAt ?? a.state.rdap?.expiresAt;
    if (exp) { evaluateExpiry(a, 'domain_expiry', Math.floor((exp - t) / 86400000), `Domain ${a.config.domain || a.target}`, a.config.expiry_alerts); status = r.state === 'fail' ? 'down' : Math.floor((exp - t) / 86400000) <= 14 ? 'degraded' : 'operational'; if (status === 'degraded') reason = `Domain expires in ${Math.floor((exp - t) / 86400000)} days`; }
    else if (r.state !== 'fail') { status = 'operational'; reason = st.rdap?.reason ? `Registration expiry unavailable (${st.rdap.reason})` : null; }
    if (r.state === 'fail') { status = dnsRes.incident ? 'down' : 'degraded'; confirmed = dnsRes.incident ? 1 : 0; reason = r.error; }
  }
  if (a.type === 'mobile') evaluateMobile(a);

  // persist check row + asset summary
  if (!maint && ['operational', 'slow'].includes(status)) { const rInc = openIncident(a.id, 'render'); if (rInc) { status = 'down'; reason = rInc.description; } } // server answers but the page is blank/broken
  const checkState = r.state === 'unknown' ? null : r.state;
  if (checkState) {
    db.run('INSERT INTO checks(asset_id,ts,kind,state,response_ms,status_code,size,error,detail,confirmed) VALUES(?,?,?,?,?,?,?,?,?,?)', a.id, t, 'check', checkState, r.responseMs ?? null, r.statusCode ?? null, r.size ?? null, r.error ? String(r.error).slice(0, 500) : null, detail, confirmed);
  }
  const okish = r.state === 'ok' || r.state === 'slow';
  const interval = (a.next_override || a.interval_sec * 1000);
  db.run(`UPDATE assets SET status=?, status_reason=?, last_check_at=?, last_ok_at=CASE WHEN ? THEN ? ELSE last_ok_at END, last_fail_at=CASE WHEN ? THEN ? ELSE last_fail_at END,
    last_response_ms=COALESCE(?, last_response_ms), last_status_code=?, verified=CASE WHEN ? THEN 1 ELSE verified END, lease_until=NULL, next_run_at=? WHERE id=?`,
    status, reason ? String(reason).slice(0, 300) : null, t, okish ? 1 : 0, t, r.state === 'fail' ? 1 : 0, t, r.responseMs ?? null, r.statusCode ?? null, checkState ? 1 : 0,
    computeNext(a, t, retry, interval), a.id);
  emit('asset', { id: a.id, status });
}

function evaluateMobile(a) {
  const win = Date.now() - 15 * 60000; const th = a.config.error_rate_threshold || 0.2;
  const m = db.get("SELECT SUM(requests) AS req, SUM(failures) AS fail, SUM(kind='crash') AS crashes FROM mobile_reports WHERE asset_id=? AND ts>=?", a.id, win);
  const rate = m.req >= 20 ? (m.fail || 0) / m.req : 0;
  reportCondition(a, 'mobile_errors', { bad: rate > th || (m.crashes || 0) >= (a.config.crash_threshold || 5), severity: 'high', title: 'Mobile app error rate high', description: `Client-reported failure rate ${(rate * 100).toFixed(0)}% over 15 min, ${m.crashes || 0} crash report(s). The backend responds, but real app users are failing.`, verify: 1, recover: 2 });
}

// ---------------- server agent ingest ----------------
export const DEFAULT_THRESHOLDS = { cpu: [80, 95], ram: [85, 95], disk: [80, 90] };
export function ingestAgent(a, p) {
  const t = Date.now(); const th = { ...DEFAULT_THRESHOLDS, ...(a.config.thresholds || {}) };
  const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
  const m = { cpu: num(p.cpu_percent), ram: num(p.ram_percent), ram_available_mb: num(p.ram_available_mb), load1: num(p.load1), load5: num(p.load5), load15: num(p.load15), uptime_s: num(p.uptime_s), net_rx_bytes: num(p.net_rx_bytes), net_tx_bytes: num(p.net_tx_bytes), net_errors: num(p.net_errors), disk_read_bytes: num(p.disk_read_bytes), disk_write_bytes: num(p.disk_write_bytes), temp_c: num(p.temp_c), cpu_user: num(p.cpu_user), cpu_system: num(p.cpu_system), cpu_iowait: num(p.cpu_iowait), cpu_steal: num(p.cpu_steal) };
  const disks = Array.isArray(p.disks) ? p.disks.slice(0, 16).filter((d) => d && typeof d.mount === 'string' && num(d.percent) !== null) : [];
  const worstDisk = disks.reduce((w, d) => (!w || d.percent > w.percent ? d : w), null);
  if (worstDisk) m.disk = worstDisk.percent;
  db.tx(() => { for (const [k, v] of Object.entries(m)) if (v !== null) db.run('INSERT INTO metrics(asset_id,ts,name,value) VALUES(?,?,?,?)', a.id, t, k, v); });
  const services = Array.isArray(p.services) ? p.services.slice(0, 64).map((s) => ({ name: String(s.name).slice(0, 64), running: !!s.running })) : [];
  const top_processes = Array.isArray(p.top_processes) ? p.top_processes.slice(0, 10).map((x) => ({ pid: num(x.pid), cpu: num(x.cpu), ram: num(x.ram), user: String(x.user || '').slice(0, 32), command: String(x.command || '').slice(0, 120) })) : [];
  const docker = p.docker && typeof p.docker === 'object' ? { available: !!p.docker.available, total: num(p.docker.total) || 0, running: num(p.docker.running) || 0, stopped: num(p.docker.stopped) || 0 } : null;
  const reboot_required = !!p.reboot_required;
  setState(a, { last_report: { disks, services, hostname: String(p.hostname || '').slice(0, 100), os: String(p.os || '').slice(0, 100), agent_version: String(p.agent_version || '').slice(0, 20), cores: num(p.cores), top_processes, docker, reboot_required } });
  db.run("UPDATE assets SET last_heartbeat_at=?, verified=1 WHERE id=?", t, a.id);
  heartbeatRecovery(a);
  const lvl = (v, [w, c]) => (v === null ? null : v >= c ? 'critical' : v >= w ? 'high' : null);
  const apply = (cat, v, pair, label, unit = '%') => {
    const s = lvl(v, pair);
    reportCondition(a, cat, { bad: !!s, severity: s === 'critical' ? 'critical' : 'medium', title: `${label} ${s === 'critical' ? 'critical' : 'high'}`, description: v == null ? '' : `${label} at ${v.toFixed(1)}${unit} (warning ${pair[0]}, critical ${pair[1]})`, verify: a.config.resource_verify || 2, recover: 2, assignToAssignee: true });
  };
  apply('resource_cpu', m.cpu, th.cpu, 'CPU utilization'); apply('resource_ram', m.ram, th.ram, 'RAM utilization');
  if (worstDisk) { const s = lvl(worstDisk.percent, th.disk); reportCondition(a, 'resource_disk', { bad: !!s, severity: s === 'critical' ? 'critical' : 'medium', title: `Disk space ${s === 'critical' ? 'critical' : 'high'}`, description: `${worstDisk.mount} at ${worstDisk.percent.toFixed(1)}% (warning ${th.disk[0]}, critical ${th.disk[1]})`, verify: 2, recover: 2 }); }
  const required = a.config.services || [];
  for (const name of required) {
    const s = services.find((x) => x.name === name);
    reportCondition(a, `service`, { bad: !s || !s.running, severity: 'high', title: `Service stopped: ${name}`, description: `Registered service "${name}" is ${s ? 'not running' : 'not reported by the agent'}`, verify: 2, recover: 2 });
    if (!s || !s.running) break; // one service incident per asset at a time (category-scoped); next ticks surface others
  }
  const cur = a.state.last_report; emit('asset', { id: a.id });
  const worst = openIncident(a.id, 'agent') ? 'down' : ['resource_cpu', 'resource_ram', 'resource_disk', 'service'].some((c) => openIncident(a.id, c)) ? 'degraded' : 'operational';
  db.run('UPDATE assets SET status=?, status_reason=?, last_check_at=?, last_ok_at=?, last_response_ms=NULL WHERE id=?', worst, worst === 'operational' ? null : 'Resource threshold or service issue (see incidents)', t, t, a.id);
  return cur;
}
function heartbeatRecovery(a) { const open = openIncident(a.id, 'agent'); if (open) reportCondition(a, 'agent', { bad: false, recover: 1, recoveryNote: 'Agent heartbeat resumed.' }); }

// ---------------- scheduler ----------------
let timers = []; let started = false; const stats = { ticks: 0, checksRun: 0, lastTick: 0 };
export const schedulerStats = () => ({ ...stats, running: running.size });

async function runOne(a0, { forceRender = false } = {}) {
  const a = hydrate(a0);
  const t0 = Date.now();
  try {
    // record monitoring gap if we fell far behind schedule (worker was down / overloaded)
    const lateBy = t0 - a.next_run_at;
    if (a.last_check_at && lateBy > a.interval_sec * 2000 + 5000 && a.type !== 'server' && !isScheduled(a.config)) {
      db.run("INSERT INTO checks(asset_id,ts,kind,state,error) VALUES(?,?,'gap','gap',?)", a.id, a.last_check_at + a.interval_sec * 1000, `Monitoring gap: ${Math.round(lateBy / 1000)}s of checks missed (not counted as downtime)`);
    }
    if (inMaintenance(a)) { // no checks recorded, no alerts; asset shows Maintenance
      db.run("UPDATE assets SET status='maintenance', status_reason='Scheduled maintenance: monitoring paused', lease_until=NULL, next_run_at=? WHERE id=?", Date.now() + Math.min(a.interval_sec, 60) * 1000, a.id); emit('asset', { id: a.id }); return;
    }
    const r = await executeCheck(a);
    await processResult(a, r);
    // Quick verification: a bad first result is checked once more after 500 ms (instead of waiting for the next scheduler tick),
    // so a one-off blip never raises an alert but a real outage is confirmed within about a second.
    if ((r.state === 'fail' || r.state === 'slow') && QUICK_VERIFY.includes(a.type) && a.verify_failures >= 2) {
      const fresh = hydrate(db.get('SELECT * FROM assets WHERE id=?', a.id));
      const pending = r.state === 'fail' ? fresh.status === 'degraded' : !openIncident(a.id, 'performance');
      if (pending && !inMaintenance(fresh)) { await sleep(500); const r2 = await executeCheck(fresh); await processResult(fresh, r2); }
    }
    // optional synthetic workflow for web apps (own interval)
    if (a.type === 'webapp' && a.config.steps?.length && r.state !== 'fail') {
      const due = !a.state.workflow_at || t0 - a.state.workflow_at >= (a.config.workflow_interval_sec || 300) * 1000;
      if (due) {
        const w = await runWorkflow(a, decryptJson(a.secret_enc)); setState(a, { workflow_at: Date.now(), workflow: { state: w.state, error: w.error || null } });
        if (w.state !== 'unavailable') reportCondition(a, 'workflow', { bad: w.state === 'fail', severity: 'high', title: 'Application workflow failure', description: w.error, verify: a.config.workflow_verify || 2, recover: 1 });
      }
    }
    await maybeRender(a.id, r, forceRender);
    stats.checksRun++;
  } catch (e) {
    log('error', 'check crashed', { asset: a.id, error: e.message });
    db.run('UPDATE assets SET lease_until=NULL, next_run_at=? WHERE id=?', Date.now() + a.interval_sec * 1000, a.id);
  } finally { running.delete(a.id); }
}

/** Real-browser check: does the page actually show something? (An HTTP 200 does not prove it.) Runs every few minutes, not every check. */
async function maybeRender(assetId, httpResult, force) {
  const a = hydrate(db.get('SELECT * FROM assets WHERE id=?', assetId)); if (!a) return;
  if (!config.renderEnabled || !['website', 'webapp'].includes(a.type) || a.config.render_check === false || httpResult.state === 'fail' || inMaintenance(a)) return;
  const everyMs = a.state.render?.state === 'fail' ? 50000 : Math.max(1, a.config.render_interval_min || 5) * 60000; // a failing page is re-examined every minute if (!force && a.state.render?.ts && Date.now() - a.state.render.ts < everyMs) return;
  if (!renderAvailable()) { if (a.state.render?.state !== 'unavailable') setState(a, { render: { ts: Date.now(), state: 'unavailable', error: 'Real-browser checks need: npx playwright install chromium' } }); return; }
  let rr = await renderCheck(a);
  if (rr.state === 'fail') { await sleep(3000); rr = await renderCheck(a); } // verify like every other failure: look again before raising an alert
  const prev = a.state.render; setState(a, { render: { ts: Date.now(), state: rr.state, error: rr.error || null, ...(rr.detail || {}) } });
  if (rr.state === 'unavailable') return;
  const bad = rr.state === 'fail';
  const res = reportCondition(a, 'render', { bad, severity: ['critical', 'high'].includes(a.criticality) ? 'critical' : 'high', title: 'Page not displaying', description: rr.error, verify: 1, recover: 1, recoveryNote: 'The page displays normally again.' });
  if (bad && res.incident) { db.run("UPDATE assets SET status='down', status_reason=?, next_run_at=MIN(next_run_at, ?) WHERE id=?", String(rr.error).slice(0, 300), Date.now() + 60000, a.id); } // problem open: look again in a minute, whatever the normal interval
  else if (!bad && prev?.state === 'fail') { const f = hydrate(db.get('SELECT * FROM assets WHERE id=?', a.id)); db.run('UPDATE assets SET next_run_at=? WHERE id=?', computeNext(f, Date.now(), false, f.interval_sec * 1000), a.id); } // healthy again: back to the normal rhythm
  if (!bad && prev?.state === 'fail') db.run("UPDATE assets SET status='operational', status_reason=NULL WHERE id=? AND status='down' AND NOT EXISTS (SELECT 1 FROM incidents WHERE asset_id=? AND status NOT IN ('resolved','closed') AND category IN ('availability','ssl'))", a.id, a.id);
  emit('asset', { id: a.id });
}

export async function runNow(assetId) {
  if (running.has(assetId)) return false;
  const a = db.get('SELECT * FROM assets WHERE id=? AND archived=0', assetId); if (!a) return false;
  running.add(a.id); await runOne(a, { forceRender: true }); return true;
}

async function tick() {
  stats.ticks++; stats.lastTick = Date.now(); heartbeat('scheduler', { running: running.size, ticks: stats.ticks });
  const free = config.maxConcurrency - running.size; if (free <= 0) return;
  const t = Date.now();
  const due = db.all(`SELECT * FROM assets WHERE archived=0 AND deleted_at IS NULL AND type IN (${CHECKABLE.map(() => '?').join(',')}) AND next_run_at<=? AND (lease_until IS NULL OR lease_until<?) ORDER BY next_run_at LIMIT ?`, ...CHECKABLE, t, t, free);
  for (const a of due) {
    if (running.has(a.id)) continue;
    // lease prevents duplicate execution across multiple workers; expires automatically if a worker dies
    const lease = db.run('UPDATE assets SET lease_until=? WHERE id=? AND (lease_until IS NULL OR lease_until<?)', t + a.timeout_ms + 45000, a.id, t);
    if (!lease.changes) continue;
    running.add(a.id); runOne(a);
  }
}

function lastRun(key) { return db.get('SELECT ts FROM report_runs WHERE key=?', key)?.ts; }
async function housekeeping() {
  runEscalations();
  const day = Date.now() - config.retentionDays * 86400000;
  if (!lastRun('retention') || Date.now() - lastRun('retention') > 86400000) {
    db.run('DELETE FROM checks WHERE ts<?', day); db.run('DELETE FROM metrics WHERE ts<?', day); db.run('DELETE FROM mobile_reports WHERE ts<?', day);
    db.run('DELETE FROM sessions WHERE expires_at<?', Date.now()); db.run('DELETE FROM audit_log WHERE ts<?', Date.now() - 365 * 86400000);
    db.run("INSERT INTO report_runs(key,ts) VALUES('retention',?) ON CONFLICT(key) DO UPDATE SET ts=excluded.ts", Date.now());
  }
  const { runScheduledReports } = await import('./reports.js'); await runScheduledReports();
}

export function startScheduler() {
  if (started) return; started = true;
  db.run('UPDATE assets SET lease_until=NULL'); // recover safely after restart: stale leases from a crashed worker are cleared
  db.run("UPDATE assets SET next_run_at=? WHERE next_run_at=0", Date.now());
  let busy = false, hbusy = false, nbusy = false;
  timers.push(setInterval(() => { if (busy) return; busy = true; tick().catch((e) => log('error', 'tick failed', { error: e.message })).finally(() => { busy = false; }); }, 1000));
  timers.push(setInterval(() => { if (nbusy) return; nbusy = true; dispatchDue().catch((e) => log('error', 'dispatch failed', { error: e.message })).finally(() => { nbusy = false; }); heartbeat('dispatcher'); }, 2000));
  timers.push(setInterval(() => { if (hbusy) return; hbusy = true; housekeeping().catch((e) => log('error', 'housekeeping failed', { error: e.message })).finally(() => { hbusy = false; }); heartbeat('housekeeping'); }, 15000));
  // monitor-the-monitor: ping the external watchdog once a minute, but ONLY while the checker is really ticking
  timers.push(setInterval(() => { if (Date.now() - stats.lastTick < 15000) pingWatchdog().catch((e) => log('warn', 'watchdog ping failed', { error: e.message })); }, 60000));
  setTimeout(() => renderAvailable(), 1500).unref(); // load the browser library once, off the request path
  setTimeout(() => { try { if (notifyStartup()) log('info', 'startup notice queued for push recipients'); } catch (e) { log('warn', 'startup notice failed', { error: e.message }); } pingWatchdog().catch(() => {}); }, 5000).unref();
  log('info', 'scheduler started', { concurrency: config.maxConcurrency });
}
export async function stopScheduler() { timers.forEach(clearInterval); timers = []; started = false; for (let i = 0; i < 50 && running.size; i++) await sleep(100); }
export { hydrate, CHECKABLE };
