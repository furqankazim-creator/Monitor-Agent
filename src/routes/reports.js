import { Router } from 'express';
import { db } from '../db.js';
import { requireRole, scope, visibleProjects, canSeeProject } from '../auth.js';
import { HttpError } from '../util.js';
import { buildReport, reportCsv, reportHtml, reportPdf, sendReportEmail } from '../reports.js';

export const router = Router();
function parse(req) {
  const q = req.query; const t = Date.now();
  const preset = { daily: 86400000, weekly: 7 * 86400000, monthly: 30 * 86400000 }[q.period];
  const from = preset ? t - preset : q.from ? +q.from : t - 86400000; const to = preset ? t : q.to ? +q.to : t;
  if (!(from < to)) throw new HttpError(400, 'Invalid date range');
  let ids = visibleProjects(req.user);
  if (q.project_id) { if (!canSeeProject(req.user, q.project_id)) throw new HttpError(404, 'Project not found'); ids = [+q.project_id]; }
  const label = q.project_id ? db.get('SELECT name FROM projects WHERE id=?', +q.project_id)?.name  : 'All projects';
  return { projectIds: ids, from, to, title: `${preset ? { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' }[q.period] : 'Custom'} Report: ${label}` };
}
router.get('/reports', (req, res) => {
  const p = parse(req); const rep = buildReport(p); const f = req.query.format || 'json';
  if (f === 'csv') { return res.type('text/csv').attachment('report.csv').send(reportCsv(rep)); }
  if (f === 'html') return res.type('html').send(reportHtml(rep));
  if (f === 'pdf') return reportPdf(rep).then((b) => res.type('application/pdf').attachment('report.pdf').send(b));
  res.json(rep);
});
router.post('/reports/email', requireRole('admin'), async (req, res) => {
  const to = String(req.body.to || '').trim(); if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) throw new HttpError(400, 'Valid email required');
  req.query = { ...req.body }; const rep = buildReport(parse(req));
  try { await sendReportEmail(to, rep); res.json({ ok: true }); } catch (e) { throw new HttpError(502, e.message); }
});
// analytics: per-day uptime/incident trend + reliability ranking
router.get('/analytics', (req, res) => {
  const p = parse(req); const s = p.projectIds === null ? { sql: '1=1', params: [] } : { sql: `a.project_id IN (${p.projectIds.map(() => '?').join(',') || 'NULL'})`, params: p.projectIds };
  const days = db.all(`SELECT (c.ts/86400000) AS d, SUM(c.state IN ('ok','slow')) AS up, SUM(c.state='fail' AND c.confirmed=1) AS down, AVG(c.response_ms) AS ms FROM checks c JOIN assets a ON a.id=c.asset_id WHERE c.ts>=? AND c.ts<=? AND c.kind='check' AND ${s.sql} GROUP BY d ORDER BY d`, p.from, p.to, ...s.params)
    .map((r) => ({ date: new Date(r.d * 86400000).toISOString().slice(0, 10), uptime_pct: r.up + r.down ? Math.round((r.up / (r.up + r.down)) * 10000) / 100 : null, avg_ms: r.ms == null ? null : Math.round(r.ms) }));
  const inc = db.all(`SELECT (i.first_detected/86400000) AS d, COUNT(*) n, SUM(i.severity='critical') crit FROM incidents i JOIN assets a ON a.id=i.asset_id WHERE i.first_detected>=? AND i.first_detected<=? AND ${s.sql.replace(/a\.project_id/g, 'i.project_id')} GROUP BY d ORDER BY d`, p.from, p.to, ...s.params).map((r) => ({ date: new Date(r.d * 86400000).toISOString().slice(0, 10), incidents: r.n, critical: r.crit }));
  const rep = buildReport(p);
  res.json({ from: p.from, to: p.to, daily: days, incidents_per_day: inc, least_reliable: [...rep.assets].filter((a) => a.uptime_pct !== null).sort((a, b) => a.uptime_pct - b.uptime_pct).slice(0, 8), repeated: rep.summary.most_unreliable, summary: rep.summary });
});
