import { targetServer, startApp, seed, addAsset } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';

const S = await seed(); const { db } = S;
const { parseTimes, nextSlot } = await import('../src/schedule.js');
const { runNow } = await import('../src/monitor.js');
const app = await startApp(); let mode = 'ok';
const T = await targetServer({ '*': (req, res) => { if (mode === 'down') return req.socket.destroy(); res.setHeader('content-type', 'text/html'); res.end('<h1>hi</h1>'); } });
test.after(async () => { await app.close(); await T.close(); });
const asset = (id) => db.get('SELECT * FROM assets WHERE id=?', id);

test('time parsing accepts natural input (9pm, 12pm, 3pm, 5.30pm) and rejects nonsense', () => {
  assert.deepEqual(parseTimes('9 pm, 12pm, 3pm, 5.30pm'), ['12:00', '15:00', '17:30', '21:00']);
  assert.deepEqual(parseTimes('9am; 12:00\n3 PM, 17:30, 9am'), ['09:00', '12:00', '15:00', '17:30'], 'sorted, de-duplicated, mixed formats');
  assert.deepEqual(parseTimes('12am, 12pm'), ['00:00', '12:00']);
  for (const bad of ['25:00', '13pm', '9:75', 'noon', '0pm']) assert.throws(() => parseTimes(bad), /valid time|must be/, bad);
});

test('next slot respects the time zone and rolls over to tomorrow', () => {
  const times = ['09:00', '12:00', '15:00', '17:30'];
  const utc = (h, m = 0) => Date.UTC(2031, 5, 10, h, m);
  assert.equal(nextSlot(times, 0, utc(8)), utc(9)); assert.equal(nextSlot(times, 0, utc(9, 0) + 5000), utc(12)); assert.equal(nextSlot(times, 0, utc(16)), utc(17, 30));
  assert.equal(nextSlot(times, 0, utc(18)), Date.UTC(2031, 5, 11, 9), 'after the last slot → first slot tomorrow');
  assert.equal(nextSlot(times, 240, utc(4, 59)), utc(5), 'UTC+4: 09:00 local = 05:00 UTC'); assert.equal(nextSlot(times, -300, utc(13)), utc(14), 'UTC-5: 09:00 local = 14:00 UTC');
  assert.equal(nextSlot([], 0), null);
});

test('a scheduled asset is checked now, then sleeps until its next daily slot (not every minute)', async () => {
  const id = addAsset(db, S.projA, { target: T.url + '/s1', name: 'Sched', interval_sec: 60, config: { check_times: ['09:00', '12:00', '15:00', '17:30'], check_tz_offset_min: 0 } });
  await runNow(id); const a = asset(id); assert.equal(a.status, 'operational');
  const expected = nextSlot(['09:00', '12:00', '15:00', '17:30'], 0, a.last_check_at); assert.ok(Math.abs(a.next_run_at - expected) < 2000, `next=${new Date(a.next_run_at).toISOString()} expected=${new Date(expected).toISOString()}`);
});

test('problem found at a scheduled time → verified quickly → incident + alert queued → re-checked every few minutes → one good check recovers', async () => {
  db.run("INSERT INTO recipients(project_id,channel,address,level,min_severity,created_at) VALUES(?,?,?,?,?,?)", S.projA, 'email', 'oncall@t.io', 1, 'low', Date.now());
  const id = addAsset(db, S.projA, { target: T.url + '/s2', name: 'Sched-fail', verify_failures: 3, criticality: 'critical', config: { check_times: ['12:00'], check_tz_offset_min: 0, recheck_while_down_min: 5 } });
  await runNow(id); mode = 'down'; const t0 = Date.now();
  await runNow(id); let a = asset(id); assert.equal(a.status, 'degraded'); assert.ok(a.next_run_at - t0 < 15000, 'failure is verified within seconds, not at the next slot');
  await runNow(id); await runNow(id); a = asset(id); assert.equal(a.status, 'down');
  const inc = db.get("SELECT * FROM incidents WHERE asset_id=? AND status NOT IN ('resolved','closed')", id); assert.ok(inc, 'incident opened'); assert.equal(inc.severity, 'critical');
  assert.ok(db.get("SELECT 1 x FROM notifications WHERE incident_id=? AND recipient='oncall@t.io'", inc.id), 'alert queued for the recipient');
  assert.ok(Math.abs(a.next_run_at - (Date.now() + 5 * 60000)) < 3000, 're-check in 5 minutes while the problem is open (not at the next daily slot)');
  mode = 'ok'; await runNow(id); assert.equal(db.get('SELECT status FROM incidents WHERE id=?', inc.id).status, 'resolved', 'a single successful check resolves a scheduled asset');
  a = asset(id); assert.equal(a.status, 'operational'); assert.ok(a.next_run_at - Date.now() > 60000 * 30 || a.next_run_at > Date.now(), 'back to waiting for the next slot');
});

test('API: validates times, edits reschedule, and "apply to all" updates every asset in scope (and can revert)', async () => {
  const c = app.mk(); await c.login('super@t.io', S.password);
  const bad = await c.post('/api/assets', { project_id: S.projA, type: 'website', name: 'x', target: T.url + '/api1', config: { check_times: '25pm' } }); assert.equal(bad.status, 400); assert.match(bad.json.error, /hour must be|not a valid time/);
  const ok = await c.post('/api/assets', { project_id: S.projA, type: 'website', name: 'Daily', target: T.url + '/api2', config: { check_times: '9am, 12pm, 3pm, 5.30pm', check_tz_offset_min: 240 } }); assert.equal(ok.status, 200, ok.text);
  const cfg = JSON.parse(db.get('SELECT config FROM assets WHERE id=?', ok.json.id).config); assert.deepEqual(cfg.check_times, ['09:00', '12:00', '15:00', '17:30']); assert.equal(cfg.check_tz_offset_min, 240); assert.equal(cfg.recheck_while_down_min, 5);
  const before = db.get("SELECT COUNT(*) n FROM assets WHERE project_id=? AND type!='server' AND archived=0", S.projA).n;
  const ap = await c.post('/api/schedule/apply', { project_id: S.projA, times: '9pm, 12pm, 3pm, 5.30pm', tz_offset_min: 0, recheck_min: 10 }); assert.equal(ap.status, 200, ap.text); assert.equal(ap.json.updated, before); assert.deepEqual(ap.json.times, ['12:00', '15:00', '17:30', '21:00']);
  const one = JSON.parse(db.get("SELECT config FROM assets WHERE project_id=? AND type!='server' AND archived=0 LIMIT 1", S.projA).config); assert.deepEqual(one.check_times, ['12:00', '15:00', '17:30', '21:00']); assert.equal(one.recheck_while_down_min, 10);
  assert.equal(db.get("SELECT COUNT(*) n FROM assets WHERE project_id=? AND archived=0 AND config LIKE '%check_times%' AND type!='server'", S.projB).n, 0, 'other projects untouched');
  assert.equal((await c.post('/api/schedule/apply', { times: 'whenever' })).status, 400);
  const back = await c.post('/api/schedule/apply', { project_id: S.projA, mode: 'continuous' }); assert.equal(back.json.updated, before);
  assert.equal(db.get("SELECT COUNT(*) n FROM assets WHERE project_id=? AND archived=0 AND config LIKE '%check_times%'", S.projA).n, 0, 'reverted to continuous');
  const tech = app.mk(); await tech.login('techA@t.io', S.password); assert.equal((await tech.post('/api/schedule/apply', { times: '9am' })).status, 403);
  const admB = app.mk(); await admB.login('adminB@t.io', S.password); assert.equal((await admB.post('/api/schedule/apply', { project_id: S.projA, times: '9am' })).status, 404, 'cannot schedule another project');
});
