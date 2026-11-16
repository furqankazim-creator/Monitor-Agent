import { db } from './db.js';
import { addEvent, emit, incCode, SEV_RANK } from './events.js';
import { enqueueIncident } from './notify.js';
import { fmtDuration, log } from './util.js';

export const CATEGORY_LABEL = {
  availability: 'Website / service unavailable', render: 'Page not displaying (blank or broken screen)', api_failure: 'API failure', performance: 'Degraded performance', ssl: 'SSL certificate problem', ssl_expiry: 'SSL certificate expiring',
  domain_expiry: 'Domain expiring', dns: 'DNS failure', resource_cpu: 'High CPU utilization', resource_ram: 'Critical RAM utilization', resource_disk: 'Disk space critical',
  service: 'Service stopped', database: 'Database unavailable', workflow: 'Application workflow failure', agent: 'Server offline', content_change: 'Unexpected content change', mobile_errors: 'Mobile app error rate',
};

export function inMaintenance(a, t = Date.now()) {
  return !!a.maintenance || (a.maint_start && a.maint_end && t >= a.maint_start && t < a.maint_end);
}
export function severityFor(asset, base = 'availability') {
  if (base === 'availability') return asset.criticality === 'critical' || asset.criticality === 'high' ? 'critical' : 'high';
  return base;
}
export const openIncident = (assetId, category) => db.get("SELECT * FROM incidents WHERE asset_id=? AND category=? AND status NOT IN ('resolved','closed')", assetId, category);

/**
 * Central verification state machine. A condition must be bad `verify` consecutive times before an incident opens,
 * and good `recover` consecutive times before it auto-resolves. Returns {incident, failCount, opened}.
 */
export function reportCondition(asset, category, o) {
  if (inMaintenance(asset)) return { incident: null, failCount: 0, suppressed: true };
  const verify = o.verify ?? asset.verify_failures; const recover = o.recover ?? asset.recover_successes;
  db.run('INSERT OR IGNORE INTO conditions(asset_id,category) VALUES(?,?)', asset.id, category);
  const open = openIncident(asset.id, category);
  const c = db.get('SELECT * FROM conditions WHERE asset_id=? AND category=?', asset.id, category);
  if (o.bad) {
    const failCount = c.fail_count + 1;
    db.run('UPDATE conditions SET fail_count=?, ok_count=0 WHERE asset_id=? AND category=?', failCount, asset.id, category);
    if (open) {
      const upgrade = SEV_RANK[o.severity] > SEV_RANK[open.severity];
      db.run('UPDATE incidents SET last_detected=?, description=?, severity=?, title=? WHERE id=?', Date.now(), o.description ?? open.description, upgrade ? o.severity : open.severity, upgrade ? o.title : open.title, open.id);
      if (upgrade) {
        addEvent(open.id, 'severity_change', `Severity raised from ${open.severity} to ${o.severity}: ${o.description || o.title}`);
        const fresh = db.get('SELECT * FROM incidents WHERE id=?', open.id);
        enqueueIncident(fresh, `severity-${o.severity}`);
      }
      emit('incident', { id: open.id, asset_id: asset.id });
      return { incident: open, failCount, opened: false };
    }
    if (failCount < verify) return { incident: null, failCount, pending: true };
    const t = Date.now();
    const id = db.insert('INSERT INTO incidents(asset_id,project_id,category,severity,title,description,status,first_detected,last_detected,is_demo) VALUES(?,?,?,?,?,?,?,?,?,?)',
      asset.id, asset.project_id, category, o.severity, o.title, o.description ?? null, 'new', t, t, asset.is_demo ? 1 : 0);
    addEvent(id, 'detected', `Initial detection: ${o.description || o.title}`);
    if (verify > 1) addEvent(id, 'verified', `Failure verified: ${failCount} consecutive failed checks`);
    if (o.assignToAssignee !== false && asset.assignee_id) { db.run('UPDATE incidents SET assignee_id=? WHERE id=?', asset.assignee_id, id); addEvent(id, 'assigned', 'Auto-assigned to the asset owner'); }
    const inc = db.get('SELECT * FROM incidents WHERE id=?', id);
    log('warn', 'incident opened', { incident: incCode(id), asset: asset.name, category });
    enqueueIncident(inc, 'opened');
    emit('incident', { id, asset_id: asset.id, opened: true });
    return { incident: inc, failCount, opened: true };
  }
  const okCount = c.ok_count + 1;
  db.run('UPDATE conditions SET ok_count=?, fail_count=0 WHERE asset_id=? AND category=?', okCount, asset.id, category);
  if (open && okCount >= recover) { recoverIncident(open, o.recoveryNote); return { incident: null, recovered: true }; }
  return { incident: open || null, okCount };
}

export function recoverIncident(inc, note) {
  const t = Date.now();
  db.run("UPDATE incidents SET status='resolved', recovered_at=?, resolved_at=?, last_detected=last_detected WHERE id=?", t, t, inc.id);
  const dur = fmtDuration(t - inc.first_detected);
  addEvent(inc.id, 'recovered', `Recovery detected automatically after ${dur}. ${note || 'Monitoring verified successful checks.'}`);
  addEvent(inc.id, 'resolved', 'Incident auto-resolved by monitoring engine');
  enqueueIncident(db.get('SELECT * FROM incidents WHERE id=?', inc.id), 'recovered');
  emit('incident', { id: inc.id, asset_id: inc.asset_id, recovered: true });
  log('info', 'incident recovered', { incident: incCode(inc.id), downtime: dur });
}

// Expiry-type condition (SSL certificate / domain registration) with configurable alert schedule.
export function evaluateExpiry(asset, category, daysLeft, label, schedule = [30, 14, 7, 3, 0]) {
  const maxDays = Math.max(...schedule);
  const bad = daysLeft <= maxDays;
  const severity = daysLeft <= 0 ? 'critical' : daysLeft <= 3 ? 'high' : daysLeft <= 7 ? 'medium' : 'low';
  const title = daysLeft <= 0 ? `${label} has EXPIRED` : `${label} expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`;
  return reportCondition(asset, category, { bad, severity, title, description: title, verify: 1, recover: 1, recoveryNote: `${label} renewed or no longer near expiry.` });
}

export const OPEN_STATUSES = ['new', 'acknowledged', 'investigating', 'identified', 'monitoring'];
