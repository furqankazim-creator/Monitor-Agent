import { targetServer, startApp, seed, addAsset } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';

// Behaviour spec: a live check decides up / slow / down from the REAL status, latency and error; a bad result is verified by one
// quick retry; one DOWN alert per outage; one SLOW alert per slow episode; RECOVERED with downtime when it is up again.
const S = await seed(); const { db } = S;
const { runNow } = await import('../src/monitor.js');
const app = await startApp();
let status = 200; let delay = 0; let redirect = false;
const T = await targetServer({
  '/final': (_q, res) => { res.end('final page'); },
  '*': (req, res) => {
    if (redirect && req.url === '/old') { res.statusCode = 301; res.setHeader('location', '/final'); return res.end(); }
    if (status === 'reset') return req.socket.destroy();
    setTimeout(() => { res.statusCode = status; res.end('<h1>page</h1>'); }, delay);
  },
});
test.beforeEach(() => { status = 200; delay = 0; redirect = false; });
test.after(async () => { await app.close(); await T.close(); });
db.run("INSERT INTO recipients(project_id,channel,address,level,min_severity,consent,created_at) VALUES(?,?,?,?,?,1,?)", S.projA, 'email', 'noc@t.io', 1, 'low', Date.now());
db.run("INSERT INTO recipients(project_id,channel,address,level,min_severity,consent,created_at) VALUES(?,?,?,?,?,1,?)", S.projA, 'whatsapp', '971500000000', 1, 'low', Date.now());
const mk = (name, o = {}) => addAsset(db, S.projA, { name, target: T.url + (o.path || '/'), verify_failures: 2, recover_successes: 1, timeout_ms: o.timeout || 5000, config: o.config || {} });
const asset = (id) => db.get('SELECT * FROM assets WHERE id=?', id);
const incs = (id) => db.all('SELECT * FROM incidents WHERE asset_id=?', id);
const notes = (id, kind) => db.all("SELECT n.* FROM notifications n JOIN incidents i ON i.id=n.incident_id WHERE i.asset_id=? AND n.kind=? AND n.channel='email'", id, kind);
const text = (n) => JSON.parse(n.body).text;

test('healthy URL → up, HTTP 200, latency recorded, no incident', async () => {
  const id = mk('healthy'); await runNow(id); const a = asset(id);
  assert.equal(a.status, 'operational'); assert.equal(a.last_status_code, 200); assert.ok(a.last_response_ms >= 0); assert.equal(incs(id).length, 0);
  assert.equal(db.get('SELECT COUNT(*) n FROM checks WHERE asset_id=?', id).n, 1, 'an up check needs no retry');
});

test('wrong status (expected 200, got 404) → down twice (check + 500 ms retry) → ONE incident and ONE DOWN alert with the exact wording; repeats do not re-alert', async () => {
  const id = mk('wrong-status'); status = 404; const t0 = Date.now(); await runNow(id);
  assert.ok(Date.now() - t0 < 3000, 'verified within about a second, not at the next scheduled run');
  const a = asset(id); assert.equal(a.status, 'down'); assert.match(a.status_reason, /HTTP 404.*\(expected 200\)/);
  const checks = db.all("SELECT state, status_code FROM checks WHERE asset_id=? ORDER BY id", id); assert.deepEqual(checks.map((c) => c.state), ['fail', 'fail'], 'both the first check and the retry are stored'); assert.ok(checks.every((c) => c.status_code === 404));
  assert.equal(incs(id).length, 1); assert.equal(incs(id)[0].status, 'new');
  const n = notes(id, 'opened'); assert.equal(n.length, 1, 'exactly one DOWN alert'); assert.match(text(n[0]), /Status: OFFLINE/, 'the alert must say OFFLINE, not the previous state'); assert.match(text(n[0]), /wrong-status is DOWN — HTTP 404 Page not found \(expected 200\)\. Verified by retry\./);
  assert.equal(db.all("SELECT * FROM notifications n JOIN incidents i ON i.id=n.incident_id WHERE i.asset_id=? AND n.channel='whatsapp' AND n.kind='opened'", id).length, 1, 'WhatsApp recipient addressed too');
  await runNow(id); await runNow(id); assert.equal(incs(id).length, 1, 'same incident stays open'); assert.equal(notes(id, 'opened').length, 1, 'no duplicate alert while the incident stays open');
});

test('same monitor repointed to a healthy URL → up → incident closed, downtime computed, RECOVERED alert with HTTP status and latency', async () => {
  const id = mk('recovers'); status = 500; await runNow(id); assert.equal(asset(id).status, 'down');
  db.run('UPDATE incidents SET first_detected=? WHERE asset_id=?', Date.now() - 8.4 * 60000, id); // pretend the outage began 8.4 minutes ago
  status = 200; await runNow(id);
  const inc = incs(id)[0]; assert.equal(inc.status, 'resolved'); assert.ok(inc.recovered_at); assert.equal(asset(id).status, 'operational');
  const n = notes(id, 'recovered'); assert.equal(n.length, 1); assert.match(text(n[0]), /recovers is back up \(HTTP 200 in \d+ ms\)\. Downtime: 8 minutes\./); assert.match(text(n[0]), /Status: OPERATIONAL/); assert.doesNotMatch(text(n[0]), /HTTP 500/, 'recovery must report the NEW result, not the failed one');
});

test('transient failure: first check fails, retry is up → both checks kept, NO incident, NO alert', async () => {
  const id = mk('transient'); let calls = 0;
  T.state.routes['/blip'] = (req, res) => { calls++; if (calls === 1) return req.socket.destroy(); res.end('ok'); };
  const idb = addAsset(db, S.projA, { name: 'blip', target: T.url + '/blip', verify_failures: 2, recover_successes: 1 }); await runNow(idb);
  assert.deepEqual(db.all("SELECT state FROM checks WHERE asset_id=? ORDER BY id", idb).map((c) => c.state), ['fail', 'ok']); assert.equal(incs(idb).length, 0); assert.equal(asset(idb).status, 'operational');
  assert.equal(db.get("SELECT COUNT(*) n FROM notifications WHERE incident_id IN (SELECT id FROM incidents WHERE asset_id=?)", idb).n, 0, 'no alert for a blip');
  void id;
});

test('request throws (connection reset) → down with the REAL error stored', async () => {
  const id = mk('reset'); status = 'reset'; await runNow(id); const a = asset(id); assert.equal(a.status, 'down'); assert.match(a.status_reason, /Connection reset by server/);
  assert.match(db.get("SELECT error FROM checks WHERE asset_id=? ORDER BY id DESC", id).error, /Connection reset/);
});

test('no answer within the timeout → down with "Timeout after Ns"', async () => {
  const id = mk('timeout', { timeout: 1000 }); delay = 1500; await runNow(id); assert.equal(asset(id).status, 'down'); assert.match(asset(id).status_reason, /^Timeout after 1s/);
});

test('slow: correct status but above the threshold → SLOW; verified by retry; ONE alert per slow episode with exact wording', async () => {
  const id = mk('slowsite', { config: { max_response_ms: 100 } }); delay = 250; await runNow(id);
  assert.equal(asset(id).status, 'slow'); const inc = incs(id); assert.equal(inc.length, 1); assert.equal(inc[0].category, 'performance');
  const n = notes(id, 'opened'); assert.equal(n.length, 1); assert.match(text(n[0]), /slowsite is SLOW — \d+ ms \(threshold 100 ms\)\. Verified by retry\./);
  await runNow(id); await runNow(id); assert.equal(notes(id, 'opened').length, 1, 'no repeat SLOW alert while it stays slow');
  delay = 0; await runNow(id); assert.equal(incs(id)[0].status, 'resolved', 'back to normal speed closes the slow episode');
});

test('defaults: slow threshold is 2000 ms and expected status is exactly 200', async () => {
  const id = mk('defaults'); delay = 2300; await runNow(id); assert.equal(asset(id).status, 'slow', 'above 2000 ms is slow by default'); assert.match(asset(id).status_reason, /threshold 2000 ms/);
  delay = 0; status = 204; const id2 = mk('is204', { path: '/x204' }); await runNow(id2); assert.equal(asset(id2).status, 'down', '204 is not 200'); assert.match(asset(id2).status_reason, /\(expected 200\)/);
});

test('redirects are followed to the final answer', async () => {
  redirect = true; const id = mk('redir', { path: '/old' }); await runNow(id); assert.equal(asset(id).status, 'operational'); assert.equal(asset(id).last_status_code, 200);
});

test('invalid input is rejected before any check runs; new assets use the documented defaults', async () => {
  const c = app.mk(); await c.login('super@t.io', S.password); const before = db.get('SELECT COUNT(*) n FROM checks').n;
  assert.equal((await c.post('/api/assets', { project_id: S.projA, type: 'website', name: 'x', target: 'not a url' })).status, 400);
  assert.equal((await c.post('/api/quick-add', { url: '' })).status, 400); assert.equal(db.get('SELECT COUNT(*) n FROM checks').n, before, 'no check ran');
  const ok = await c.post('/api/assets', { project_id: S.projA, type: 'website', name: 'defaults-asset', target: T.url + '/d' }); const a = asset(ok.json.id);
  assert.equal(a.interval_sec, 60); assert.equal(a.timeout_ms, 10000, 'timeout 10 s'); assert.equal(a.verify_failures, 2, 'first check + one retry'); assert.equal(a.recover_successes, 1, 'one good check recovers');
  assert.equal((await c.post('/api/assets', { project_id: S.projA, type: 'website', name: 'defaults-asset', target: T.url + '/d' })).status, 409, 'duplicates are detected');
});

test('the first live check runs immediately when a monitor is added (quick add)', async () => {
  const c = app.mk(); await c.login('super@t.io', S.password); const t0 = Date.now(); const r = await c.post('/api/quick-add', { url: T.url + '/fresh' });
  assert.equal(r.status, 200); assert.equal(r.json.status, 'operational'); assert.ok(Date.now() - t0 < 4000); assert.equal(db.get('SELECT COUNT(*) n FROM checks WHERE asset_id=?', r.json.id).n, 1);
});

test('AUTO-RECOVERY: while a problem is open the site is re-checked within about a minute, even if its normal interval is 15 minutes; it returns to the normal interval once healthy', async () => {
  const id = addAsset(db, S.projA, { name: 'slow-interval', target: T.url + '/', interval_sec: 900, verify_failures: 2, recover_successes: 1, timeout_ms: 3000 });
  await runNow(id); assert.ok(asset(id).next_run_at - Date.now() > 800000, 'healthy: waits the full 15 minutes');
  status = 500; await runNow(id); assert.equal(asset(id).status, 'down');
  const wait = asset(id).next_run_at - Date.now(); assert.ok(wait <= 62000 && wait > 0, `down: next check in ${Math.round(wait / 1000)}s (not 900s)`);
  status = 200; await runNow(id); assert.equal(asset(id).status, 'operational', 'one good check recovers it');
  assert.ok(asset(id).next_run_at - Date.now() > 800000, 'recovered: back to the normal 15-minute interval');
});
