import { Router } from 'express';
import { db, audit } from '../db.js';
import { requireRole, scope, canSeeProject, ROLE_LEVEL } from '../auth.js';
import { HttpError, toCsv, fmtDuration, safeJson } from '../util.js';
import { addEvent, emit, incCode } from '../events.js';
import { incidentPdf } from '../reports.js';
import { OPEN_STATUSES, CATEGORY_LABEL } from '../incidents.js';
import { mask } from '../notify.js';

export const router = Router();
const STATUSES = ['new', 'acknowledged', 'investigating', 'identified', 'monitoring', 'resolved', 'closed'];
const int = (v, d, lo, hi) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };

function listQuery(req) {
  const q = req.query; const s = scope(req.user, 'i.project_id'); const w = [s.sql]; const p = [...s.params];
  const view = q.view || 'active';
  if (view === 'active') w.push(`i.status IN (${OPEN_STATUSES.map((x) => `'${x}'`).join(',')})`);
  else if (view === 'critical') w.push(`i.severity='critical' AND i.status IN (${OPEN_STATUSES.map((x) => `'${x}'`).join(',')})`);
  else if (view === 'unassigned') w.push(`i.assignee_id IS NULL AND i.status IN (${OPEN_STATUSES.map((x) => `'${x}'`).join(',')})`);
  else if (view === 'acknowledged') w.push("i.status IN ('acknowledged','investigating','identified','monitoring')");
  else if (view === 'resolved') w.push("i.status IN ('resolved','closed')");
  if (['critical', 'high', 'medium', 'low', 'informational'].includes(q.severity)) { w.push('i.severity=?'); p.push(q.severity); }
  if (q.project_id) { w.push('i.project_id=?'); p.push(+q.project_id); }
  if (q.from) { w.push('i.first_detected>=?'); p.push(+q.from); } if (q.to) { w.push('i.first_detected<=?'); p.push(+q.to); }
  if (q.q) { const like = `%${String(q.q).slice(0, 80)}%`; const num = String(q.q).replace(/\D/g, ''); w.push('(i.title LIKE ? OR a.name LIKE ? OR i.description LIKE ?' + (num ? ' OR i.id=?' : '') + ')'); p.push(like, like, like); if (num) p.push(+num); }
  return { where: w.join(' AND '), p };
}
const FROM = 'FROM incidents i JOIN assets a ON a.id=i.asset_id JOIN projects pr ON pr.id=i.project_id LEFT JOIN users u ON u.id=i.assignee_id';
const shape = (r) => ({ ...r, code: incCode(r.id), duration_ms: (r.recovered_at || Date.now()) - r.first_detected, category_label: CATEGORY_LABEL[r.category] || r.category });

router.get('/incidents', (req, res) => {
  const { where, p } = listQuery(req); const pageSize = int(req.query.page_size, 25, 1, 200); const page = int(req.query.page, 1, 1, 1e5);
  const total = db.get(`SELECT COUNT(*) n ${FROM} WHERE ${where}`, ...p).n;
  const rows = db.all(`SELECT i.*, a.name AS asset_name, a.type AS asset_type, pr.name AS project_name, u.name AS assignee_name ${FROM} WHERE ${where} ORDER BY CASE i.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, i.first_detected DESC LIMIT ? OFFSET ?`, ...p, pageSize, (page - 1) * pageSize);
  const counts = {}; const s = scope(req.user, 'i.project_id');
  counts.active = db.get(`SELECT COUNT(*) n FROM incidents i WHERE i.status IN ('new','acknowledged','investigating','identified','monitoring') AND ${s.sql}`, ...s.params).n;
  counts.critical = db.get(`SELECT COUNT(*) n FROM incidents i WHERE i.severity='critical' AND i.status IN ('new','acknowledged','investigating','identified','monitoring') AND ${s.sql}`, ...s.params).n;
  counts.unassigned = db.get(`SELECT COUNT(*) n FROM incidents i WHERE i.assignee_id IS NULL AND i.status IN ('new','acknowledged','investigating','identified','monitoring') AND ${s.sql}`, ...s.params).n;
  res.json({ total, page, page_size: pageSize, counts, items: rows.map(shape) });
});
router.get('/incidents-export', requireRole('technician'), (req, res) => {
  const { where, p } = listQuery(req);
  const rows = db.all(`SELECT i.*, a.name AS asset_name, pr.name AS project_name, u.name AS assignee_name ${FROM} WHERE ${where} ORDER BY i.first_detected DESC LIMIT 5000`, ...p).map((r) => ({ ...shape(r), first_detected_iso: new Date(r.first_detected).toISOString(), recovered_iso: r.recovered_at ? new Date(r.recovered_at).toISOString() : '', duration: fmtDuration((r.recovered_at || Date.now()) - r.first_detected) }));
  res.type('text/csv').attachment('incidents.csv').send(toCsv(rows, ['code', 'project_name', 'asset_name', 'category', 'severity', 'status', 'title', 'description', 'first_detected_iso', 'recovered_iso', 'duration', 'assignee_name', 'root_cause', 'resolution_notes']));
});

function loadInc(req, id) {
  const i = db.get(`SELECT i.*, a.name AS asset_name, a.type AS asset_type, a.target AS asset_target, a.status AS asset_status, pr.name AS project_name, u.name AS assignee_name ${FROM} WHERE i.id=?`, id);
  if (!i || !canSeeProject(req.user, i.project_id)) throw new HttpError(404, 'Incident not found'); return i;
}
router.get('/incidents/:id', (req, res) => {
  const i = loadInc(req, req.params.id); 
  let events = db.all('SELECT e.*, u.name AS user_name FROM incident_events e LEFT JOIN users u ON u.id=e.user_id WHERE incident_id=? ORDER BY ts, id', i.id);
  const checks = db.all('SELECT ts,state,response_ms,status_code,error,confirmed FROM checks WHERE asset_id=? AND ts>=? AND ts<=? ORDER BY ts LIMIT 300', i.asset_id, i.first_detected - 30 * 60000, (i.recovered_at || Date.now()) + 10 * 60000);
  const notifications = db.all('SELECT id,channel,recipient,kind,status,attempts,last_error,created_at,sent_at FROM notifications WHERE incident_id=? ORDER BY id', i.id).map((n) => ({ ...n, recipient: mask(n.recipient) }));
  res.json({ incident: shape(i), events, checks, notifications });
});

router.patch('/incidents/:id', requireRole('technician'), (req, res) => {
  const i = loadInc(req, req.params.id); const b = req.body || {}; const sets = []; const p = []; const t = Date.now();
  if (b.status !== undefined) {
    if (!STATUSES.includes(b.status)) throw new HttpError(400, 'Invalid status');
    if (b.status === 'closed' && ROLE_LEVEL[req.user.role] < ROLE_LEVEL.admin) throw new HttpError(403, 'Only administrators can close incidents (technicians mark them resolved for verification)');
    if (i.status === 'closed' && ROLE_LEVEL[req.user.role] < ROLE_LEVEL.admin) throw new HttpError(403, 'Closed incidents can only be reopened by an administrator');
    sets.push('status=?'); p.push(b.status);
    if (['acknowledged', 'investigating', 'identified'].includes(b.status) && !i.ack_at) { sets.push('ack_at=?'); p.push(t); if (!i.assignee_id) { sets.push('assignee_id=?'); p.push(req.user.id); } }
    if (b.status === 'resolved' && !i.resolved_at) { sets.push('resolved_at=?'); p.push(t); }
    if (b.status === 'closed') { sets.push('closed_at=?'); p.push(t); if (!i.resolved_at) { sets.push('resolved_at=?'); p.push(t); } }
    if (['new', 'acknowledged', 'investigating', 'identified', 'monitoring'].includes(b.status) && ['resolved', 'closed'].includes(i.status)) { sets.push('resolved_at=NULL', 'closed_at=NULL'); }
    addEvent(i.id, b.status === 'acknowledged' ? 'acknowledged' : 'status', `Status changed ${i.status} → ${b.status} by ${req.user.name}`, req.user.id);
  }
  if (b.assignee_id !== undefined) {
    const uid = b.assignee_id ? Number(b.assignee_id) : null;
    if (uid) { const u = db.get("SELECT id,name,role FROM users WHERE id=? AND active=1", uid); if (!u) throw new HttpError(400, 'Invalid assignee'); const ok = u.role === 'super_admin' || db.get('SELECT 1 x FROM user_projects WHERE user_id=? AND project_id=?', uid, i.project_id); if (!ok) throw new HttpError(400, 'Assignee is not a member of this project'); addEvent(i.id, 'assigned', `Assigned to ${u.name} by ${req.user.name}`, req.user.id); } else addEvent(i.id, 'assigned', `Unassigned by ${req.user.name}`, req.user.id);
    sets.push('assignee_id=?'); p.push(uid);
  }
  for (const f of ['root_cause', 'resolution_notes']) if (b[f] !== undefined) { sets.push(`${f}=?`); p.push(String(b[f]).slice(0, 5000)); addEvent(i.id, 'note', `${f === 'root_cause' ? 'Root cause' : 'Resolution notes'} updated by ${req.user.name}`, req.user.id); }
  if (['critical', 'high', 'medium', 'low', 'informational'].includes(b.severity) && ROLE_LEVEL[req.user.role] >= ROLE_LEVEL.admin) { sets.push('severity=?'); p.push(b.severity); addEvent(i.id, 'severity_change', `Severity set to ${b.severity} by ${req.user.name}`, req.user.id); }
  if (!sets.length) throw new HttpError(400, 'Nothing to update');
  db.run(`UPDATE incidents SET ${sets.join(',')} WHERE id=?`, ...p, i.id); audit(req.user, 'incident_update', 'incident', i.id, Object.keys(b).join(','), req.ip); emit('incident', { id: i.id });
  res.json({ ok: true });
});
router.post('/incidents/:id/notes', requireRole('technician'), (req, res) => {
  const i = loadInc(req, req.params.id); const text = String(req.body?.text || '').trim().slice(0, 5000); if (!text) throw new HttpError(400, 'Note text required');
  addEvent(i.id, 'note', `${req.body.kind === 'action' ? 'Troubleshooting action' : 'Note'} (${req.user.name}): ${text}`, req.user.id); emit('incident', { id: i.id }); res.json({ ok: true });
});
router.get('/incidents/:id/export.pdf', async (req, res) => {
  const i = loadInc(req, req.params.id); let ev = db.all('SELECT * FROM incident_events WHERE incident_id=? ORDER BY ts,id', i.id);
  const pdf = await incidentPdf(i, ev); res.type('application/pdf').attachment(`${incCode(i.id)}.pdf`).send(pdf);
});
router.get('/incidents/:id/export.csv', requireRole('technician'), (req, res) => {
  const i = loadInc(req, req.params.id); const ev = db.all('SELECT ts,type,message FROM incident_events WHERE incident_id=? ORDER BY ts,id', i.id).map((e) => ({ ...e, ts: new Date(e.ts).toISOString() }));
  res.type('text/csv').attachment(`${incCode(i.id)}.csv`).send(toCsv(ev, ['ts', 'type', 'message']));
});
