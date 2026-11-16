import nodemailer from 'nodemailer';
import crypto from 'node:crypto';
import { config } from './config.js';
import { db, getSetting } from './db.js';
import { decryptJson } from './crypto.js';
import { addEvent, emit, incCode, SEV_RANK } from './events.js';
import { fmtDuration, fmtTime, log, safeJson } from './util.js';

// ---------- provider configuration (settings override env) ----------
export function smtpConfig() {
  const s = decryptJson(getSetting('integration.smtp'));
  const c = s || config.smtp;
  return c && c.host ? c : null;
}
export function waConfig() {
  const s = decryptJson(getSetting('integration.whatsapp'));
  const c = s || { phoneNumberId: config.wa.phoneNumberId, token: config.wa.token, verifyToken: config.wa.verifyToken, appSecret: config.wa.appSecret, template: config.wa.template, templateLang: config.wa.templateLang, apiVersion: config.wa.apiVersion };
  return c && c.phoneNumberId && c.token ? { apiVersion: 'v21.0', templateLang: 'en', ...c } : null;
}
export function pushConfig() {
  const s = decryptJson(getSetting('integration.push')) || {};
  return { server: String(s.server || config.push.server || 'https://ntfy.sh').replace(/\/$/, ''), token: s.token || config.push.token || '', custom: !!(s.server || process.env.PUSH_SERVER) };
}
export function watchdogUrl() { return decryptJson(getSetting('integration.watchdog'))?.url || config.heartbeatUrl || ''; }
export const integrationStatus = () => ({ email: !!smtpConfig(), whatsapp: !!waConfig(), push: true, watchdog: !!watchdogUrl() });

let transport = null; let transportKey = '';
function mailer() {
  const c = smtpConfig(); if (!c) return null;
  const key = JSON.stringify([c.host, c.port, c.user, c.secure]);
  if (!transport || key !== transportKey) { transport = nodemailer.createTransport({ host: c.host, port: +c.port || 587, secure: !!c.secure, auth: c.user ? { user: c.user, pass: c.pass } : undefined, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000 }); transportKey = key; }
  return { t: transport, from: c.from || config.smtp.from };
}

// ---------- message formatting ----------
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const SEV_COLOR = { critical: '#dc2626', high: '#ea580c', medium: '#d97706', low: '#2563eb', informational: '#2563eb' };
export const incidentLink = (id) => `${config.baseUrl}/#/incident/${id}`;

export function brandedHtml(title, innerHtml, accent = '#2563eb') {
  return `<!doctype html><html><body style="margin:0;background:#0b1220;font-family:Segoe UI,Arial,sans-serif"><table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#111a2e;border-radius:10px;overflow:hidden;border:1px solid #22304d">
<tr><td style="background:#0f1a33;padding:18px 24px;border-bottom:3px solid ${accent}"><span style="color:#fff;font-weight:800;letter-spacing:.14em;font-size:15px">TIME GLOBAL TECH MONITOR</span><br><span style="color:#8aa0c8;font-size:11px">Monitor Everything. Detect Instantly. Stay Operational.</span></td></tr>
<tr><td style="padding:24px;color:#e5ecf9;font-size:14px;line-height:1.55"><h2 style="margin:0 0 14px;color:#fff;font-size:18px">${esc(title)}</h2>${innerHtml}</td></tr>
<tr><td style="padding:14px 24px;background:#0d1526;color:#6f82a8;font-size:11px">Sent by Time Global Tech Monitor. You receive this because you are a registered alert recipient.</td></tr></table></td></tr></table></body></html>`;
}

export function buildMessage(inc, kind) {
  const asset = db.get('SELECT * FROM assets WHERE id=?', inc.asset_id) || {};
  const project = db.get('SELECT * FROM projects WHERE id=?', inc.project_id) || {};
  const code = incCode(inc.id); const link = incidentLink(inc.id);
  const lastOk = asset.last_ok_at ? fmtTime(asset.last_ok_at) : 'never';
  let head; let lines; let accent = SEV_COLOR[inc.severity];
  if (kind === 'recovered') {
    accent = '#16a34a'; head = 'SERVICE RECOVERED';
    lines = [`Summary: ${asset.name} is back up (${asset.last_status_code ? 'HTTP ' + asset.last_status_code + ' in ' : ''}${Math.round(asset.last_response_ms ?? 0)} ms). Downtime: ${fmtDuration((inc.recovered_at || Date.now()) - inc.first_detected)}.`, `Asset: ${asset.name}`, `Project: ${project.name}`, 'Status: OPERATIONAL', `Incident: ${code}`, `Downtime: ${fmtDuration((inc.recovered_at || Date.now()) - inc.first_detected)}`, `Recovered: ${fmtTime(inc.recovered_at || Date.now())}`, '', 'The monitoring system has verified successful responses.'];
  } else {
    const tag = kind.startsWith('escalated') ? `ESCALATION (level ${kind.split('-')[1]}): ` : kind.startsWith('severity') ? 'SEVERITY RAISED: ' : '';
    head = `${tag}${inc.severity.toUpperCase()} ALERT: ${inc.title.toUpperCase()}`;
    const down = ['availability', 'api_failure', 'database', 'agent'].includes(inc.category); const slow = inc.category === 'performance';
    const render = inc.category === 'render';
    const summary = render ? `${asset.name} is reachable but the page is NOT displaying — ${inc.description}` : down ? `${asset.name} is DOWN — ${inc.description || inc.title}. Verified by retry.` : slow ? `${asset.name} is SLOW — ${String(inc.description || '').replace(/^Slow( API)? response: /, '')}. Verified by retry.` : `${asset.name}: ${inc.description || inc.title}`;
    lines = [`Summary: ${summary}`, `Asset: ${asset.name} (${asset.target})`, `Project: ${project.name}`, `Status: ${['availability', 'api_failure', 'database', 'agent'].includes(inc.category) ? 'OFFLINE' : inc.category === 'render' ? 'PAGE BLANK / BROKEN' : inc.category === 'performance' ? 'SLOW' : String(asset.status || 'issue').toUpperCase()}`, `Issue: ${inc.description || inc.title}`, `Detected: ${fmtTime(inc.first_detected)}`, `Last successful check: ${lastOk}`, `Incident ID: ${code}`, '', `Dashboard: ${link}`];
    if (kind.startsWith('escalated')) lines.splice(8, 0, `Unacknowledged for: ${fmtDuration(Date.now() - inc.first_detected)}`);
  }
  const text = `TIME GLOBAL TECH MONITOR\n\n${head}\n\n${lines.join('\n')}`;
  const html = brandedHtml(head, `<table cellpadding="4" style="color:#e5ecf9;font-size:14px">${lines.filter(Boolean).map((l) => { const i = l.indexOf(': '); return i > 0 && !l.startsWith('Dashboard') ? `<tr><td style="color:#8aa0c8">${esc(l.slice(0, i))}</td><td>${esc(l.slice(i + 2))}</td></tr>` : ''; }).join('')}</table><p style="margin-top:18px"><a href="${esc(link)}" style="background:${accent};color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:600">Open incident ${esc(code)}</a></p>`, accent);
  const subject = kind === 'recovered' ? `[RECOVERED] ${asset.name} - ${code}` : `[${inc.severity.toUpperCase()}] ${inc.title} - ${asset.name} - ${code}`;
  // short, phone-friendly version (title + message) for push notifications
  const down = ['availability', 'api_failure', 'database', 'agent'].includes(inc.category); const slowCat = inc.category === 'performance';
  const prefix = kind.startsWith('escalated') ? 'ESCALATION: ' : '';
  const push = kind === 'recovered'
    ? { title: `✅ ${asset.name} recovered`, message: `Back up${asset.last_status_code ? ` (HTTP ${asset.last_status_code}${asset.last_response_ms != null ? ' in ' + Math.round(asset.last_response_ms) + ' ms' : ''})` : ''}. Downtime: ${fmtDuration((inc.recovered_at || Date.now()) - inc.first_detected)}. ${code}`, priority: 3, tags: ['white_check_mark'], click: link }
    : { title: `${prefix}${down || inc.category === 'render' ? '🔴' : slowCat ? '🐢' : '⚠️'} ${asset.name} ${down ? 'is DOWN' : inc.category === 'render' ? 'page is blank / not displaying' : slowCat ? 'is SLOW' : inc.title}`, message: `${inc.description || inc.title}\n${down || slowCat ? 'Verified by retry. ' : ''}${code}`, priority: { critical: 5, high: 4, medium: 3 }[inc.severity] || 2, tags: [down ? 'rotating_light' : 'warning'], click: link };
  const params = [inc.title, asset.name || '-', project.name || '', (inc.description || inc.title).slice(0, 200), code, link];
  return { subject, text, html, params, push };
}

// ---------- queueing ----------
function quietNow(p) {
  if (p.quiet_start == null || p.quiet_end == null) return false;
  const m = (Math.floor(Date.now() / 60000) + (p.quiet_tz_offset_min || 0)) % 1440; const mm = (m + 1440) % 1440;
  return p.quiet_start <= p.quiet_end ? mm >= p.quiet_start && mm < p.quiet_end : mm >= p.quiet_start || mm < p.quiet_end;
}

export function enqueueIncident(inc, kind, level = 1) {
  const project = db.get('SELECT * FROM projects WHERE id=?', inc.project_id); if (!project) return 0;
  const isRecovery = kind === 'recovered'; const key = (r) => `${inc.id}:${kind}:${r.channel}:${r.address.toLowerCase()}`;
  const channels = safeJson(project.channels_enabled, { email: true, whatsapp: true });
  if (safeJson(project.alert_categories_off, []).includes(inc.category)) { addEvent(inc.id, 'alert_suppressed', `Alerts for category "${inc.category}" are disabled for this project`); return 0; }
  if (!isRecovery && quietNow(project) && inc.severity !== 'critical') { addEvent(inc.id, 'alert_suppressed', 'Alert held: project quiet hours active (critical incidents bypass quiet hours)'); return 0; }
  let recips;
  if (isRecovery) {
    // only tell people who were told about the problem
    recips = db.all("SELECT DISTINCT r.* FROM recipients r JOIN notifications n ON n.recipient=r.address AND n.channel=r.channel AND n.incident_id=? AND n.kind!='recovered' WHERE r.active=1 AND r.recovery=1", inc.id);
    if (!project.notify_recovery) recips = [];
  } else {
    recips = db.all('SELECT * FROM recipients WHERE active=1 AND level=? AND (project_id=? OR project_id IS NULL)', level, inc.project_id)
      .filter((r) => SEV_RANK[inc.severity] >= Math.max(SEV_RANK[r.min_severity] ?? 0, SEV_RANK[project.notify_min_severity] ?? 0));
  }
  recips = recips.filter((r) => channels[r.channel] !== false);
  if (!recips.length) { if (!isRecovery) addEvent(inc.id, 'no_recipients', `No alert recipients configured for level ${level} (project or global). Add recipients under Alerts.`); return 0; }
  const msg = buildMessage(inc, kind); let n = 0;
  for (const r of recips) {
    if (r.channel === 'whatsapp' && !r.consent) { addEvent(inc.id, 'alert_skipped', `WhatsApp to ${mask(r.address)} skipped: recipient opt-in consent not recorded`); continue; }
    const ins = db.run('INSERT OR IGNORE INTO notifications(incident_id,project_id,channel,recipient,kind,subject,body,dedupe_key,status,next_attempt_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      inc.id, inc.project_id, r.channel, r.address, kind, msg.subject, JSON.stringify({ text: msg.text, html: msg.html, params: msg.params, push: msg.push }), key(r), 'pending', Date.now(), Date.now());
    if (ins.changes) { n++; addEvent(inc.id, 'alert_queued', `${kind} alert queued via ${r.channel} to ${mask(r.address)}`); } // duplicates silently prevented by dedupe_key
  }
  return n;
}
export const mask = (a) => (a.includes('@') ? a.replace(/^(.).*(@.*)$/, '$1***$2') : a.replace(/.(?=.{3})/g, '•'));

// ---------- dispatch ----------
async function sendEmail(n) {
  const m = mailer(); if (!m) return { unconfigured: 'SMTP is not configured' };
  const b = safeJson(n.body, {});
  const info = await m.t.sendMail({ from: m.from, to: n.recipient, subject: n.subject, text: b.text, html: b.html });
  return { id: info.messageId };
}
async function sendWhatsapp(n) {
  const c = waConfig(); if (!c) return { unconfigured: 'WhatsApp Cloud API is not configured' };
  const b = safeJson(n.body, {}); const to = n.recipient.replace(/[^\d]/g, '');
  const payload = c.template
    ? { messaging_product: 'whatsapp', to, type: 'template', template: { name: c.template, language: { code: c.templateLang }, components: [{ type: 'body', parameters: b.params.slice(0, 6).map((t) => ({ type: 'text', text: String(t).replace(/[\n\t]+/g, ' ').slice(0, 300) })) }] } }
    : { messaging_product: 'whatsapp', to, type: 'text', text: { body: b.text.slice(0, 4000), preview_url: true } };
  const res = await fetch(`https://graph.facebook.com/${c.apiVersion}/${c.phoneNumberId}/messages`, { method: 'POST', headers: { authorization: `Bearer ${c.token}`, 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(15000) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(`WhatsApp API ${res.status}: ${j?.error?.message || 'error'}`); e.permanent = res.status >= 400 && res.status < 500 && res.status !== 429; throw e; }
  return { id: j.messages?.[0]?.id };
}

/** Phone push through ntfy (free, no account; the recipient "address" is the private topic). The server can be self-hosted. */
export async function sendPushRaw(topic, p) {
  const c = pushConfig();
  const res = await fetch(c.server, { method: 'POST', headers: { 'content-type': 'application/json', ...(c.token ? { authorization: `Bearer ${c.token}` } : {}) }, body: JSON.stringify({ topic, title: p.title, message: p.message, priority: p.priority || 3, tags: p.tags || [], ...(p.click ? { click: p.click } : {}) }), signal: AbortSignal.timeout(15000) });
  if (!res.ok) { const e = new Error(`Push server replied ${res.status}`); e.permanent = res.status >= 400 && res.status < 500 && res.status !== 429; throw e; }
  const j = await res.json().catch(() => ({})); return { id: j.id };
}
async function sendPush(n) { const b = safeJson(n.body, {}); return sendPushRaw(n.recipient, b.push || { title: n.subject || 'Alert', message: String(b.text || '').slice(0, 500) }); }

/** Tell push recipients the monitor (re)started, so a silent restart or outage never goes unnoticed. */
export function notifyStartup() {
  const addrs = [...new Set(db.all("SELECT address FROM recipients WHERE active=1 AND channel='push'").map((r) => r.address))]; if (!addrs.length) return 0;
  const n = db.get("SELECT COUNT(*) n FROM assets WHERE archived=0 AND deleted_at IS NULL AND is_demo=0 AND type!='server'").n; let q = 0;
  for (const a of addrs) { const r = db.run("INSERT OR IGNORE INTO notifications(incident_id,project_id,channel,recipient,kind,subject,body,dedupe_key,status,next_attempt_at,created_at) VALUES(NULL,NULL,'push',?,'startup','Monitor started',?,?,'pending',?,?)", a, JSON.stringify({ push: { title: '✅ Monitor started', message: `Time Global Tech Monitor is running. ${n} site${n === 1 ? '' : 's'} being checked.`, priority: 2, tags: ['white_check_mark'] } }), `startup:${a}:${Math.floor(Date.now() / 60000)}`, Date.now(), Date.now()); q += r.changes; }
  return q;
}
/** Ping the external watchdog (e.g. healthchecks.io). It alerts you when pings STOP, i.e. when this whole monitor is down. */
export async function pingWatchdog() {
  const url = watchdogUrl(); if (!url) return { skipped: true };
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) }); return { ok: res.ok, status: res.status };
}

const BACKOFF = [10, 30, 120, 600, 1800, 3600]; // seconds
export async function dispatchDue(limit = 20) {
  const due = db.all("SELECT * FROM notifications WHERE status='pending' AND next_attempt_at<=? ORDER BY id LIMIT ?", Date.now(), limit);
  for (const n of due) {
    const claimed = db.run("UPDATE notifications SET next_attempt_at=? WHERE id=? AND status='pending' AND next_attempt_at<=?", Date.now() + 60000, n.id, Date.now());
    if (!claimed.changes) continue;
    try {
      const r = n.channel === 'email' ? await sendEmail(n) : n.channel === 'whatsapp' ? await sendWhatsapp(n) : await sendPush(n);
      if (r.unconfigured) {
        db.run("UPDATE notifications SET status='unconfigured', last_error=? WHERE id=?", r.unconfigured, n.id);
        if (n.incident_id) addEvent(n.incident_id, 'alert_unconfigured', `${n.channel} alert NOT delivered: ${r.unconfigured}. Configure it under Integrations; it will be sent automatically.`);
        emit('incident', { id: n.incident_id });
        continue;
      }
      db.run("UPDATE notifications SET status='sent', attempts=attempts+1, provider_id=?, sent_at=?, last_error=NULL WHERE id=?", r.id || null, Date.now(), n.id);
      if (n.incident_id) addEvent(n.incident_id, 'alert_sent', `${n.kind} alert sent via ${n.channel} to ${mask(n.recipient)}`);
    } catch (e) {
      const attempts = n.attempts + 1; const final = e.permanent || attempts >= BACKOFF.length;
      db.run('UPDATE notifications SET status=?, attempts=?, last_error=?, next_attempt_at=? WHERE id=?', final ? 'failed' : 'pending', attempts, String(e.message).slice(0, 300), Date.now() + (BACKOFF[attempts - 1] || 3600) * 1000, n.id);
      if (n.incident_id) addEvent(n.incident_id, final ? 'alert_failed' : 'alert_retry', `${n.channel} alert to ${mask(n.recipient)} ${final ? 'FAILED permanently' : `failed (attempt ${attempts}), will retry`}: ${e.message}`);
      log('warn', 'notification failure', { id: n.id, channel: n.channel, error: e.message });
    }
    emit('notification', { id: n.id });
  }
  return due.length;
}
export function requeueUnconfigured() { return db.run("UPDATE notifications SET status='pending', next_attempt_at=? WHERE status='unconfigured'", Date.now()).changes; }

// ---------- escalation ----------
export function runEscalations() {
  const open = db.all("SELECT i.*, p.esc1_min, p.esc2_min FROM incidents i JOIN projects p ON p.id=i.project_id WHERE i.status NOT IN ('resolved','closed') AND i.severity IN ('critical','high') AND i.is_demo=0"); // demo incidents never trigger real escalations
  for (const i of open) {
    const age = Date.now() - i.first_detected;
    if (i.esc_level < 1 && !i.ack_at && i.esc1_min > 0 && age >= i.esc1_min * 60000) {
      db.run('UPDATE incidents SET esc_level=1 WHERE id=?', i.id);
      addEvent(i.id, 'escalated', `Not acknowledged within ${i.esc1_min} minutes: escalating to level 2 (administrator)`);
      enqueueIncident(i, 'escalated-2', 2); emit('incident', { id: i.id });
    }
    if (i.esc_level < 2 && i.esc2_min > 0 && age >= i.esc2_min * 60000) {
      db.run('UPDATE incidents SET esc_level=2 WHERE id=?', i.id);
      addEvent(i.id, 'escalated', `Still unresolved after ${i.esc2_min} minutes: escalating to level 3 (escalation contact)`);
      enqueueIncident(i, 'escalated-3', 3); emit('incident', { id: i.id });
    }
  }
}

// ---------- WhatsApp webhook ----------
export function verifyWaSignature(rawBody, header) {
  const c = waConfig(); const secret = c?.appSecret; if (!secret) return false;
  const exp = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(exp); const b = Buffer.from(String(header || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
export function applyWaStatuses(payload) {
  for (const e of payload.entry || []) for (const ch of e.changes || []) for (const s of ch.value?.statuses || []) {
    const n = db.get("SELECT * FROM notifications WHERE provider_id=? AND channel='whatsapp'", s.id); if (!n) continue;
    const map = { sent: 'sent', delivered: 'delivered', read: 'read', failed: 'failed' };
    if (!map[s.status]) continue;
    db.run('UPDATE notifications SET status=?, last_error=? WHERE id=?', map[s.status], s.status === 'failed' ? (s.errors?.[0]?.title || 'delivery failed') : n.last_error, n.id);
    if (n.incident_id) addEvent(n.incident_id, s.status === 'failed' ? 'alert_failed' : 'alert_delivery', `WhatsApp message to ${mask(n.recipient)} ${s.status}${s.status === 'failed' ? `: ${s.errors?.[0]?.title || ''}` : ''}`);
  }
}
