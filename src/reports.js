import PDFDocument from 'pdfkit';
import nodemailer from 'nodemailer';
import { db } from './db.js';
import { uptime, avgResponse, downtimeMs } from './stats.js';
import { brandedHtml, smtpConfig } from './notify.js';
import { incCode } from './events.js';
import { csvEscape, fmtDuration, fmtTime, log, toCsv } from './util.js';
import { config } from './config.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** All figures come from stored checks/incidents. projectIds=null means every project (caller must have authorised that). */
export function buildReport({ projectIds = null, from, to = Date.now(), title = 'Monitoring Report' }) {
  const where = projectIds ? `AND a.project_id IN (${projectIds.map(() => '?').join(',') || 'NULL'})` : '';
  const assets = db.all(`SELECT a.*, p.name AS project_name FROM assets a JOIN projects p ON p.id=a.project_id
    WHERE a.archived=0 AND a.deleted_at IS NULL AND a.type!='domain_placeholder' ${where}`, ...(projectIds || []));
  const rows = assets.map((a) => {
    const u = uptime(a.id, from, to);
    return { id: a.id, name: a.name, type: a.type, target: a.target, project: a.project_name, status: a.status, uptime_pct: u.pct, checks: u.checks, failed_checks: u.downChecks, monitoring_gaps: u.gaps, avg_response_ms: avgResponse(a.id, from, to), downtime_ms: downtimeMs(a.id, from, to), verified: !!a.verified, demo: !!a.is_demo, state: a.state };
  });
  const incWhere = projectIds ? `AND i.project_id IN (${projectIds.map(() => '?').join(',') || 'NULL'})` : '';
  const incidents = db.all(`SELECT i.*, a.name AS asset_name FROM incidents i JOIN assets a ON a.id=i.asset_id WHERE i.first_detected<=? AND COALESCE(i.recovered_at, ?)>=? ${incWhere} ORDER BY i.first_detected DESC`, to, to, from, ...(projectIds || []));
  const measured = rows.filter((r) => r.uptime_pct !== null);
  const catCount = {}; incidents.forEach((i) => { const k = `${i.asset_name}`; catCount[k] = (catCount[k] || 0) + 1; });
  const sslWarn = rows.filter((r) => r.state?.ssl && r.state.ssl.daysLeft <= 30).map((r) => ({ name: r.name, days: r.state.ssl.daysLeft }))
    .concat(rows.filter((r) => r.state?.rdap?.expiresAt && Math.floor((r.state.rdap.expiresAt - to) / 86400000) <= 30).map((r) => ({ name: r.name, days: Math.floor((r.state.rdap.expiresAt - to) / 86400000) })));
  const summary = {
    total_assets: rows.length, online: rows.filter((r) => ['operational', 'slow'].includes(r.status)).length, offline: rows.filter((r) => r.status === 'down').length,
    avg_uptime_pct: measured.length ? Math.round((measured.reduce((a, r) => a + r.uptime_pct, 0) / measured.length) * 100) / 100 : null,
    total_downtime_ms: rows.reduce((a, r) => a + r.downtime_ms, 0), incidents_total: incidents.length,
    incidents_active: incidents.filter((i) => !['resolved', 'closed'].includes(i.status)).length, incidents_resolved: incidents.filter((i) => ['resolved', 'closed'].includes(i.status)).length,
    slow_endpoints: rows.filter((r) => r.status === 'slow').map((r) => r.name), ssl_warnings: sslWarn,
    most_unreliable: Object.entries(catCount).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, n]) => ({ name, incidents: n })),
    unverified_assets: rows.filter((r) => !r.verified).length, demo_assets: rows.filter((r) => r.demo).length,
  };
  return { title, from, to, generated_at: Date.now(), summary, assets: rows.map(({ state, ...r }) => r), incidents: incidents.map((i) => ({ code: incCode(i.id), asset: i.asset_name, severity: i.severity, category: i.category, title: i.title, status: i.status, first_detected: i.first_detected, recovered_at: i.recovered_at, duration_ms: (i.recovered_at || to) - i.first_detected, root_cause: i.root_cause })) };
}

export function reportCsv(r) {
  const a = toCsv(r.assets.map((x) => ({ ...x, downtime: fmtDuration(x.downtime_ms) })), ['project', 'name', 'type', 'target', 'status', 'uptime_pct', 'checks', 'failed_checks', 'monitoring_gaps', 'avg_response_ms', 'downtime', 'verified', 'demo']);
  const i = toCsv(r.incidents.map((x) => ({ ...x, first_detected: new Date(x.first_detected).toISOString(), recovered_at: x.recovered_at ? new Date(x.recovered_at).toISOString() : '', duration: fmtDuration(x.duration_ms) })), ['code', 'asset', 'severity', 'category', 'title', 'status', 'first_detected', 'recovered_at', 'duration', 'root_cause']);
  return `# ${csvEscape(r.title)},${new Date(r.from).toISOString()} to ${new Date(r.to).toISOString()}\n# ASSETS\n${a}\n\n# INCIDENTS\n${i}\n`;
}

export function reportHtml(r, { email = false } = {}) {
  const s = r.summary;
  const card = (k, v) => `<td style="padding:10px 14px;background:#0f1a33;border-radius:6px"><div style="color:#8aa0c8;font-size:11px">${k}</div><div style="color:#fff;font-size:20px;font-weight:700">${esc(v)}</div></td>`;
  const body = `<p style="color:#8aa0c8">${esc(fmtTime(r.from))} &rarr; ${esc(fmtTime(r.to))}</p>
<table cellspacing="6"><tr>${card('Assets', s.total_assets)}${card('Online', s.online)}${card('Offline', s.offline)}${card('Avg uptime', s.avg_uptime_pct == null ? 'n/a' : s.avg_uptime_pct + '%')}</tr>
<tr>${card('Total downtime', fmtDuration(s.total_downtime_ms))}${card('Incidents', s.incidents_total)}${card('Active', s.incidents_active)}${card('Resolved', s.incidents_resolved)}</tr></table>
${s.unverified_assets ? `<p style="color:#f59e0b">${s.unverified_assets} asset(s) have no completed check yet and are excluded from uptime.</p>` : ''}
${s.demo_assets ? `<p style="color:#f59e0b">Includes ${s.demo_assets} DEMO asset(s).</p>` : ''}
<h3 style="color:#fff">Assets</h3><table width="100%" cellpadding="5" style="font-size:12px;color:#e5ecf9;border-collapse:collapse"><tr style="color:#8aa0c8;text-align:left"><th>Asset</th><th>Status</th><th>Uptime</th><th>Avg ms</th><th>Downtime</th></tr>
${r.assets.slice(0, 200).map((a) => `<tr style="border-top:1px solid #22304d"><td>${esc(a.name)}</td><td>${esc(a.status)}</td><td>${a.uptime_pct ?? 'n/a'}${a.uptime_pct == null ? '' : '%'}</td><td>${a.avg_response_ms ?? '-'}</td><td>${esc(fmtDuration(a.downtime_ms))}</td></tr>`).join('')}</table>
<h3 style="color:#fff">Incidents</h3>${r.incidents.length ? `<table width="100%" cellpadding="5" style="font-size:12px;color:#e5ecf9;border-collapse:collapse"><tr style="color:#8aa0c8;text-align:left"><th>ID</th><th>Asset</th><th>Severity</th><th>Status</th><th>Duration</th></tr>${r.incidents.slice(0, 100).map((i) => `<tr style="border-top:1px solid #22304d"><td>${i.code}</td><td>${esc(i.asset)}</td><td>${i.severity}</td><td>${i.status}</td><td>${esc(fmtDuration(i.duration_ms))}</td></tr>`).join('')}</table>` : '<p>No incidents in this period.</p>'}
${s.ssl_warnings.length ? `<h3 style="color:#fff">SSL / domain expiry warnings</h3><ul>${s.ssl_warnings.map((w) => `<li>${esc(w.name)}: ${w.days} days</li>`).join('')}</ul>` : ''}`;
  if (email) return brandedHtml(r.title, body);
  return brandedHtml(r.title, body).replace('<body style="margin:0;background:#0b1220', '<body style="margin:0;background:#0b1220;-webkit-print-color-adjust:exact');
}

export function reportPdf(r) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: 'A4' }); const chunks = [];
    doc.on('data', (c) => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    doc.rect(0, 0, 595, 70).fill('#0f1a33'); doc.fillColor('#fff').fontSize(16).font('Helvetica-Bold').text('TIME GLOBAL TECH MONITOR', 40, 22);
    doc.fontSize(8).font('Helvetica').fillColor('#8aa0c8').text('Monitor Everything. Detect Instantly. Stay Operational.', 40, 44);
    doc.fillColor('#111').fontSize(15).font('Helvetica-Bold').text(r.title, 40, 90).fontSize(9).font('Helvetica').text(`${fmtTime(r.from)} to ${fmtTime(r.to)}   |   generated ${fmtTime(r.generated_at)}`);
    const s = r.summary; doc.moveDown().fontSize(10);
    [['Assets', s.total_assets], ['Online / Offline', `${s.online} / ${s.offline}`], ['Average uptime', s.avg_uptime_pct == null ? 'n/a (no completed checks)' : s.avg_uptime_pct + '%'], ['Total verified downtime', fmtDuration(s.total_downtime_ms)], ['Incidents (active / resolved)', `${s.incidents_total} (${s.incidents_active} / ${s.incidents_resolved})`]].forEach(([k, v]) => doc.font('Helvetica-Bold').text(`${k}: `, { continued: true }).font('Helvetica').text(String(v)));
    if (s.demo_assets) doc.fillColor('#b45309').text(`Note: includes ${s.demo_assets} demo asset(s).`).fillColor('#111');
    doc.moveDown().font('Helvetica-Bold').fontSize(12).text('Assets').moveDown(0.3).fontSize(8);
    for (const a of r.assets.slice(0, 120)) { if (doc.y > 770) doc.addPage(); doc.font('Helvetica').text(`${a.name} [${a.type}]  ${a.status}  uptime ${a.uptime_pct ?? 'n/a'}${a.uptime_pct == null ? '' : '%'}  avg ${a.avg_response_ms ?? '-'}ms  downtime ${fmtDuration(a.downtime_ms)}`); }
    doc.moveDown().font('Helvetica-Bold').fontSize(12).text('Incidents').moveDown(0.3).fontSize(8);
    if (!r.incidents.length) doc.font('Helvetica').text('No incidents in this period.');
    for (const i of r.incidents.slice(0, 120)) { if (doc.y > 770) doc.addPage(); doc.font('Helvetica').text(`${i.code}  ${i.severity.toUpperCase()}  ${i.asset}: ${i.title}  [${i.status}]  ${fmtDuration(i.duration_ms)}${i.root_cause ? '  cause: ' + i.root_cause : ''}`); }
    doc.end();
  });
}

export async function incidentPdf(inc, events) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40 }); const chunks = [];
    doc.on('data', (c) => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    doc.font('Helvetica-Bold').fontSize(16).text(`TIME GLOBAL TECH MONITOR - Incident ${incCode(inc.id)}`).moveDown(0.5).fontSize(11);
    for (const [k, v] of [['Title', inc.title], ['Asset', inc.asset_name], ['Severity', inc.severity], ['Status', inc.status], ['Detected', fmtTime(inc.first_detected)], ['Recovered', inc.recovered_at ? fmtTime(inc.recovered_at) : 'not yet'], ['Duration', fmtDuration((inc.recovered_at || Date.now()) - inc.first_detected)], ['Root cause', inc.root_cause || '-'], ['Resolution', inc.resolution_notes || '-']]) doc.font('Helvetica-Bold').text(`${k}: `, { continued: true }).font('Helvetica').text(String(v));
    doc.moveDown().font('Helvetica-Bold').text('Timeline').moveDown(0.3).font('Helvetica').fontSize(9);
    for (const e of events) { if (doc.y > 760) doc.addPage(); doc.text(`${fmtTime(e.ts)}  [${e.type}]  ${e.message}`); }
    doc.end();
  });
}

// ---------- scheduled delivery ----------
const wk = (d) => { const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); const n = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - n); const y = new Date(Date.UTC(t.getUTCFullYear(), 0, 1)); return `${t.getUTCFullYear()}-W${Math.ceil(((t - y) / 86400000 + 1) / 7)}`; };
export async function runScheduledReports(nowMs = Date.now()) {
  const d = new Date(nowMs); if (d.getUTCHours() < 6) return; // deliver after 06:00 UTC
  const done = (k) => db.get('SELECT 1 AS x FROM report_runs WHERE key=?', k);
  const mark = (k) => db.run('INSERT OR IGNORE INTO report_runs(key,ts) VALUES(?,?)', k, nowMs);
  const day0 = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const jobs = [['daily', `daily:${d.toISOString().slice(0, 10)}`, day0 - 86400000, day0, 'Daily Report', 'daily_summary']];
  if (d.getUTCDay() === 1) jobs.push(['weekly', `weekly:${wk(d)}`, day0 - 7 * 86400000, day0, 'Weekly Report', 'weekly_report']);
  if (d.getUTCDate() === 1) jobs.push(['monthly', `monthly:${d.toISOString().slice(0, 7)}`, Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1), day0, 'Monthly Report', 'monthly_report']);
  for (const [, key, from, to, label, col] of jobs) {
    if (done(key)) continue;
    const recips = db.all(`SELECT * FROM recipients WHERE active=1 AND channel='email' AND ${col}=1`);
    let sent = 0;
    for (const grp of new Set(recips.map((r) => r.project_id))) {
      const g = recips.filter((r) => r.project_id === grp);
      const proj = grp ? db.get('SELECT name FROM projects WHERE id=?', grp) : null;
      const rep = buildReport({ projectIds: grp ? [grp] : null, from, to, title: `${label}: ${proj ? proj.name : 'All projects'}` });
      for (const r of g) { try { await sendReportEmail(r.address, rep); sent++; } catch (e) { log('warn', 'report email failed', { to: r.address, error: e.message }); } }
    }
    if (sent || !recips.length) mark(key);
    log('info', 'scheduled report run', { key, sent });
  }
}
export async function sendReportEmail(to, rep) {
  const c = smtpConfig(); if (!c) throw new Error('SMTP is not configured');
  const t = nodemailer.createTransport({ host: c.host, port: +c.port || 587, secure: !!c.secure, auth: c.user ? { user: c.user, pass: c.pass } : undefined });
  await t.sendMail({ from: c.from || config.smtp.from, to, subject: `${rep.title} - ${new Date(rep.to).toISOString().slice(0, 10)}`, html: reportHtml(rep, { email: true }), attachments: [{ filename: 'report.csv', content: reportCsv(rep) }] });
}
