import { smtpSink, seed, addAsset, sleep } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';

const S = await seed(); const { db } = S;
const { encryptJson } = await import('../src/crypto.js');
const { setSetting } = await import('../src/db.js');
const { reportCondition } = await import('../src/incidents.js');
const { dispatchDue, runEscalations, enqueueIncident, requeueUnconfigured, applyWaStatuses, verifyWaSignature } = await import('../src/notify.js');
const { buildReport, reportCsv, reportPdf, reportHtml, runScheduledReports } = await import('../src/reports.js');
const { hydrate } = await import('../src/monitor.js');
const sink = await smtpSink();
test.after(() => sink.close());

const recip = (o) => db.insert('INSERT INTO recipients(project_id,name,channel,address,level,min_severity,recovery,daily_summary,consent,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)', o.project_id ?? S.projA, o.name || 'r', o.channel || 'email', o.address, o.level || 1, o.min_severity || 'low', o.recovery ?? 1, o.daily ?? 0, o.consent ?? 1, Date.now());
const mkAsset = (name = 'example.com') => addAsset(db, S.projA, { target: `http://${name}/`, name, criticality: 'critical', verify_failures: 1 });
const down = (id, desc = 'Connection timeout') => reportCondition(hydrate(db.get('SELECT * FROM assets WHERE id=?', id)), 'availability', { bad: true, severity: 'critical', title: 'Website offline', description: desc, verify: 1 }).incident;
const up = (id) => reportCondition(hydrate(db.get('SELECT * FROM assets WHERE id=?', id)), 'availability', { bad: false, recover: 1 });
const events = (inc) => db.all('SELECT type,message FROM incident_events WHERE incident_id=? ORDER BY id', inc).map((e) => e.type);
const notifs = (inc) => db.all('SELECT * FROM notifications WHERE incident_id=?', inc);

test('13/alert-never-silent: with NO provider configured, alerts are recorded as "unconfigured" and the incident stays open', async () => {
  recip({ address: 'ops@client.com' });
  const inc = down(mkAsset('unconf.com')); await dispatchDue();
  const n = notifs(inc.id); assert.equal(n.length, 1); assert.equal(n[0].status, 'unconfigured'); assert.match(n[0].last_error, /SMTP is not configured/);
  assert.ok(events(inc.id).includes('alert_unconfigured'), 'timeline explains the alert was not delivered');
  assert.equal(db.get('SELECT status FROM incidents WHERE id=?', inc.id).status, 'new', 'failed notification must not resolve the incident');
});

test('13. email alert + recovery email are really delivered over SMTP with the specified content', async () => {
  setSetting('integration.smtp', encryptJson({ host: '127.0.0.1', port: sink.port, secure: false, user: '', pass: '', from: 'Monitor <alerts@t.io>' }));
  const requeued = requeueUnconfigured(); assert.ok(requeued >= 1, 'previously held alerts are released once configured');
  const before = sink.mails.length; const a = mkAsset('delivered.com'); const inc = down(a, 'Connection timeout'); await dispatchDue(50);
  const mail = sink.mails.find((m) => /delivered\.com/.test(m.body)); assert.ok(mail, 'mail arrived at the SMTP server'); assert.ok(sink.mails.length > before);
  const body = mail.body; assert.match(body, /TIME GLOBAL TECH MONITOR/); assert.match(body, /CRITICAL ALERT/); assert.match(body, /Connection timeout/); assert.match(body, /INC-0000?\d+|INC-\d{5}/); assert.match(body, /monitor\.test\/#\/incident\//);
  assert.ok(events(inc.id).includes('alert_sent'));
  up(a); await dispatchDue(50);
  const rec = sink.mails.find((m) => /SERVICE RECOVERED/.test(m.body) && /delivered\.com/.test(m.body)); assert.ok(rec, 'recovery email sent'); assert.match(rec.body, /OPERATIONAL/); assert.match(rec.body, /Downtime:/);
});

test('14. duplicate alerts are prevented (same incident+kind+recipient) and repeated failures do not re-notify', async () => {
  const a = mkAsset('dedupe.com'); const inc = down(a); const first = notifs(inc.id).length;
  down(a); down(a); enqueueIncident(db.get('SELECT * FROM incidents WHERE id=?', inc.id), 'opened');
  assert.equal(notifs(inc.id).length, first, 'no duplicate notifications');
});

test('failed delivery retries with backoff and finally fails visibly (never discarded, incident not resolved)', async () => {
  setSetting('integration.smtp', encryptJson({ host: '127.0.0.1', port: 1, secure: false, from: 'x@y.z' })); // nothing listens on port 1
  const a = mkAsset('retry.com'); const inc = down(a); await dispatchDue(50);
  let n = notifs(inc.id).find((x) => x.recipient === 'ops@client.com'); assert.equal(n.status, 'pending'); assert.equal(n.attempts, 1); assert.ok(n.next_attempt_at > Date.now() + 5000, 'backoff scheduled'); assert.ok(events(inc.id).includes('alert_retry'));
  for (let i = 0; i < 6; i++) { db.run('UPDATE notifications SET next_attempt_at=0 WHERE id=?', n.id); await dispatchDue(50); }
  n = db.get('SELECT * FROM notifications WHERE id=?', n.id); assert.equal(n.status, 'failed'); assert.ok(events(inc.id).includes('alert_failed'));
  assert.notEqual(db.get('SELECT status FROM incidents WHERE id=?', inc.id).status, 'resolved');
  // manual retry path after fixing SMTP
  setSetting('integration.smtp', encryptJson({ host: '127.0.0.1', port: sink.port, secure: false, from: 'x@y.z' }));
  db.run("UPDATE notifications SET status='pending', attempts=0, next_attempt_at=0 WHERE id=?", n.id); await dispatchDue(50);
  assert.equal(db.get('SELECT status FROM notifications WHERE id=?', n.id).status, 'sent');
});

test('12. WhatsApp Cloud API: template payload, delivery-status webhooks, consent gating, signature verification', async () => {
  const realFetch = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, opts) => { if (String(url).startsWith('https://graph.facebook.com')) { calls.push({ url: String(url), body: JSON.parse(opts.body), auth: opts.headers.authorization }); return new Response(JSON.stringify({ messages: [{ id: 'wamid.TEST123' }] }), { status: 200 }); } return realFetch(url, opts); };
  try {
    setSetting('integration.whatsapp', encryptJson({ phoneNumberId: '1234567890', token: 'EAAG-secret', appSecret: 'shh', verifyToken: 'vt', template: 'monitor_alert', templateLang: 'en', apiVersion: 'v21.0' }));
    recip({ channel: 'whatsapp', address: '971500000001', consent: 1 });
    db.run('INSERT INTO recipients(project_id,channel,address,level,min_severity,consent,created_at) VALUES(?,?,?,?,?,?,?)', S.projA, 'whatsapp', '971500000002', 1, 'low', 0, Date.now());
    const a = mkAsset('wa.com'); const inc = down(a); await dispatchDue(50);
    assert.equal(calls.length, 1, 'only the opted-in recipient is messaged'); assert.match(calls[0].url, /graph\.facebook\.com\/v21\.0\/1234567890\/messages/); assert.equal(calls[0].auth, 'Bearer EAAG-secret');
    assert.equal(calls[0].body.type, 'template'); assert.equal(calls[0].body.to, '971500000001'); assert.equal(calls[0].body.template.name, 'monitor_alert'); assert.equal(calls[0].body.template.components[0].parameters.length, 6);
    assert.ok(events(inc.id).some((t) => t === 'alert_skipped'), 'missing consent is recorded');
    const n = notifs(inc.id).find((x) => x.channel === 'whatsapp'); assert.equal(n.status, 'sent'); assert.equal(n.provider_id, 'wamid.TEST123');
    applyWaStatuses({ entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.TEST123', status: 'delivered' }] } }] }] }); assert.equal(db.get('SELECT status FROM notifications WHERE id=?', n.id).status, 'delivered');
    applyWaStatuses({ entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.TEST123', status: 'failed', errors: [{ title: 'Re-engagement message' }] }] } }] }] }); assert.equal(db.get('SELECT status FROM notifications WHERE id=?', n.id).status, 'failed');
    const crypto = await import('node:crypto'); const raw = Buffer.from('{"x":1}'); const good = 'sha256=' + crypto.createHmac('sha256', 'shh').update(raw).digest('hex');
    assert.equal(verifyWaSignature(raw, good), true); assert.equal(verifyWaSignature(raw, 'sha256=00'), false); assert.equal(verifyWaSignature(raw, undefined), false);
    // permanent API rejection (4xx) fails immediately and visibly
    globalThis.fetch = async (url, opts) => (String(url).startsWith('https://graph.facebook.com') ? new Response(JSON.stringify({ error: { message: 'Invalid OAuth access token' } }), { status: 401 }) : realFetch(url, opts));
    const inc2 = down(mkAsset('wa2.com')); await dispatchDue(50); const n2 = notifs(inc2.id).find((x) => x.channel === 'whatsapp'); assert.equal(n2.status, 'failed'); assert.match(n2.last_error, /Invalid OAuth/);
  } finally { globalThis.fetch = realFetch; setSetting('integration.whatsapp', ''); }
});

test('15. escalation: L1 immediately, L2 if unacknowledged after 5 min, L3 after 15 min; acknowledgement stops L2; no spam on re-runs', async () => {
  setSetting('integration.smtp', encryptJson({ host: '127.0.0.1', port: sink.port, secure: false, from: 'x@y.z' }));
  db.run('DELETE FROM recipients'); recip({ address: 'l1@t.io', level: 1 }); recip({ address: 'l2@t.io', level: 2 }); recip({ address: 'l3@t.io', level: 3 });
  const a = mkAsset('esc.com'); const inc = down(a); const addrs = () => notifs(inc.id).map((n) => n.recipient).sort();
  assert.deepEqual(addrs(), ['l1@t.io']); runEscalations(); assert.deepEqual(addrs(), ['l1@t.io'], 'nothing before timeout');
  db.run('UPDATE incidents SET first_detected=? WHERE id=?', Date.now() - 6 * 60000, inc.id); runEscalations(); assert.deepEqual(addrs(), ['l1@t.io', 'l2@t.io']);
  runEscalations(); assert.equal(notifs(inc.id).length, 2, 'idempotent');
  db.run('UPDATE incidents SET first_detected=? WHERE id=?', Date.now() - 16 * 60000, inc.id); runEscalations(); assert.deepEqual(addrs(), ['l1@t.io', 'l2@t.io', 'l3@t.io']);
  assert.equal(events(inc.id).filter((t) => t === 'escalated').length, 2);
  // acknowledged incidents do not trigger level 2
  const inc2 = down(mkAsset('esc2.com')); db.run("UPDATE incidents SET ack_at=?, status='acknowledged', first_detected=? WHERE id=?", Date.now(), Date.now() - 6 * 60000, inc2.id); runEscalations();
  assert.equal(notifs(inc2.id).length, 1, 'acked → no L2'); await dispatchDue(100);
  assert.ok(sink.mails.some((m) => /ESCALATION \(level 2\)/.test(m.body)), 'escalation email text');
  // recovery only goes to people who were told about the problem
  up(a); const rec = notifs(inc.id).filter((n) => n.kind === 'recovered').map((n) => n.recipient).sort(); assert.deepEqual(rec, ['l1@t.io', 'l2@t.io', 'l3@t.io']);
});

test('alert rules: min severity, disabled categories, quiet hours (critical bypasses), channel toggle, no recipients is recorded', async () => {
  db.run('DELETE FROM recipients'); recip({ address: 'crit@t.io', min_severity: 'critical' });
  const a = addAsset(db, S.projA, { target: 'http://rules.com', name: 'rules', verify_failures: 1 });
  const lowInc = reportCondition(hydrate(db.get('SELECT * FROM assets WHERE id=?', a)), 'ssl_expiry', { bad: true, severity: 'low', title: 'SSL expiring', description: 'x', verify: 1 }).incident;
  assert.equal(notifs(lowInc.id).length, 0, 'below recipient min severity');
  db.run("UPDATE projects SET alert_categories_off='[\"performance\"]' WHERE id=?", S.projA);
  const perf = reportCondition(hydrate(db.get('SELECT * FROM assets WHERE id=?', a)), 'performance', { bad: true, severity: 'medium', title: 'Slow', description: 'x', verify: 1 }).incident; assert.ok(events(perf.id).includes('alert_suppressed')); db.run("UPDATE projects SET alert_categories_off='[]' WHERE id=?", S.projA);
  const m = new Date(); const nowMin = m.getUTCHours() * 60 + m.getUTCMinutes(); db.run('UPDATE projects SET quiet_start=?, quiet_end=?, quiet_tz_offset_min=0 WHERE id=?', (nowMin + 1430) % 1440, (nowMin + 30) % 1440, S.projA);
  recip({ address: 'any@t.io', min_severity: 'low' });
  const med = reportCondition(hydrate(db.get('SELECT * FROM assets WHERE id=?', a)), 'workflow', { bad: true, severity: 'medium', title: 'wf', description: 'x', verify: 1 }).incident; assert.ok(events(med.id).includes('alert_suppressed'), 'non-critical held in quiet hours');
  const crit = reportCondition(hydrate(db.get('SELECT * FROM assets WHERE id=?', a)), 'database', { bad: true, severity: 'critical', title: 'db', description: 'x', verify: 1 }).incident; assert.ok(notifs(crit.id).length > 0, 'critical bypasses quiet hours');
  db.run('UPDATE projects SET quiet_start=NULL, quiet_end=NULL WHERE id=?', S.projA);
  db.run('DELETE FROM recipients'); const none = reportCondition(hydrate(db.get('SELECT * FROM assets WHERE id=?', a)), 'agent', { bad: true, severity: 'critical', title: 'a', description: 'x', verify: 1 }).incident; assert.ok(events(none.id).includes('no_recipients'));
});

test('16. reports are generated from real data: JSON, CSV (formula-safe), HTML, PDF; gaps are not downtime; unverified assets excluded', async () => {
  const a = addAsset(db, S.projB, { target: 'http://rep.com', name: '=cmd|calc', verify_failures: 1 }); const t = Date.now();
  for (let i = 0; i < 8; i++) db.run("INSERT INTO checks(asset_id,ts,kind,state,response_ms,confirmed) VALUES(?,?,'check','ok',100,0)", a, t - 60000 * (10 - i));
  for (let i = 0; i < 2; i++) db.run("INSERT INTO checks(asset_id,ts,kind,state,response_ms,confirmed) VALUES(?,?,'check','fail',NULL,1)", a, t - 60000 * (2 - i));
  db.run("INSERT INTO checks(asset_id,ts,kind,state,error) VALUES(?,?,'gap','gap','missed')", a, t - 500000); db.run("INSERT INTO checks(asset_id,ts,kind,state,confirmed) VALUES(?,?,'check','fail',0)", a, t - 400000);
  db.run('UPDATE assets SET verified=1, status=? WHERE id=?', 'operational', a);
  const rep = buildReport({ projectIds: [S.projB], from: t - 3600000, to: t + 1000, title: 'T' }); const row = rep.assets.find((x) => x.id === a);
  assert.equal(row.uptime_pct, 80, '8 ok vs 2 verified-failed; unconfirmed blip and gap excluded'); assert.equal(row.monitoring_gaps, 1); assert.equal(rep.summary.total_assets, 1);
  assert.ok(reportCsv(rep).includes("'=cmd|calc"), 'CSV formula injection neutralised');
  assert.ok(reportHtml(rep).includes('TIME GLOBAL TECH MONITOR')); const pdf = await reportPdf(rep); assert.equal(pdf.subarray(0, 4).toString(), '%PDF');
  const empty = buildReport({ projectIds: [], from: t - 1000, to: t }); assert.equal(empty.summary.total_assets, 0); assert.equal(empty.summary.avg_uptime_pct, null);
});

test('16b. scheduled daily report is emailed once per day to opted-in recipients', async () => {
  db.run('DELETE FROM recipients'); recip({ address: 'daily@t.io', daily: 1 });
  const before = sink.mails.length; const noon = Date.UTC(2031, 0, 15, 9, 0, 0);
  await runScheduledReports(noon); await runScheduledReports(noon + 60000);
  const sent = sink.mails.slice(before).filter((m) => m.to.includes('daily@t.io')); assert.equal(sent.length, 1, 'exactly once per day'); assert.match(sent[0].body, /Daily Report/);
});

test('demo incidents are never escalated or notified by the real engine (regression)', async () => {
  const a = mkAsset('demo-esc.com'); const inc = down(a); db.run('UPDATE incidents SET is_demo=1, first_detected=? WHERE id=?', Date.now() - 40 * 60000, inc.id);
  const before = events(inc.id).length; runEscalations(); assert.equal(events(inc.id).length, before, 'no escalation events on a demo incident'); assert.equal(db.get('SELECT esc_level FROM incidents WHERE id=?', inc.id).esc_level, 0);
});
