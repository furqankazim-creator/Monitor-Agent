import { targetServer, startApp, seed, addAsset } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';

const S = await seed(); const { db } = S;
const { reportCondition, recoverIncident } = await import('../src/incidents.js');
const { dispatchDue, notifyStartup, pingWatchdog } = await import('../src/notify.js');
const { hydrate } = await import('../src/monitor.js');
const app = await startApp();
const W = await targetServer({ '*': (_q, res) => res.end('ok') }); // stands in for healthchecks.io
test.after(async () => { await app.close(); await W.close(); });

// stand-in for the ntfy server: record every JSON publish
const realFetch = globalThis.fetch; const pushes = []; let pushStatus = 200;
globalThis.fetch = async (url, opts) => {
  if (/ntfy\.sh|push\.example\.org/.test(String(url))) { pushes.push({ url: String(url), headers: opts.headers, body: JSON.parse(opts.body) }); return new Response(JSON.stringify({ id: 'msg' + pushes.length }), { status: pushStatus }); }
  return realFetch(url, opts);
};
const TOPIC = 'rukn-alerts-7Fq2xK9mP4';
const as = async (email) => { const c = app.mk(); await c.login(email, S.password); return c; };
const mk = (name) => addAsset(db, S.projA, { name, target: `http://${name}.example/`, criticality: 'critical', verify_failures: 1 });
const down = (id, desc = 'HTTP 503 Service unavailable (expected 200)') => reportCondition(hydrate(db.get('SELECT * FROM assets WHERE id=?', id)), 'availability', { bad: true, severity: 'critical', title: 'Website offline', description: desc, verify: 1 }).incident;

test('recipient API: a hard-to-guess topic is required; push needs no consent', async () => {
  const c = await as('adminA@t.io');
  assert.equal((await c.post('/api/recipients', { project_id: S.projA, channel: 'push', address: 'alerts' })).status, 400, 'short/guessable topics are refused');
  assert.equal((await c.post('/api/recipients', { project_id: S.projA, channel: 'push', address: 'bad topic!!!!!!' })).status, 400);
  const ok = await c.post('/api/recipients', { project_id: S.projA, channel: 'push', address: TOPIC, name: 'My phone', level: 1 }); assert.equal(ok.status, 200, ok.text);
  assert.equal(db.get('SELECT consent FROM recipients WHERE id=?', ok.json.id).consent, 1);
});

test('DOWN → one push with a phone-friendly title, reason, priority 5 and a link; repeats do not re-send', async () => {
  pushes.length = 0; const id = mk('shop'); const inc = down(id); await dispatchDue(50);
  assert.equal(pushes.length, 1); const p = pushes[0]; assert.equal(p.url, 'https://ntfy.sh'); assert.equal(p.body.topic, TOPIC);
  assert.equal(p.body.title, '🔴 shop is DOWN'); assert.match(p.body.message, /HTTP 503 Service unavailable \(expected 200\)/); assert.match(p.body.message, /Verified by retry\./); assert.match(p.body.message, /INC-\d{5}/);
  assert.equal(p.body.priority, 5, 'critical = urgent'); assert.deepEqual(p.body.tags, ['rotating_light']); assert.match(p.body.click, /monitor\.test\/#\/incident\//);
  assert.ok(db.all('SELECT type FROM incident_events WHERE incident_id=?', inc.id).some((e) => e.type === 'alert_sent'), 'delivery recorded on the incident timeline');
  down(id); down(id); await dispatchDue(50); assert.equal(pushes.length, 1, 'no duplicate push while the incident stays open');
});

test('RECOVERED → push "✅ … recovered" with downtime', async () => {
  pushes.length = 0; const id = mk('portal'); const inc = down(id); await dispatchDue(50); pushes.length = 0;
  db.run('UPDATE incidents SET first_detected=? WHERE id=?', Date.now() - 12 * 60000, inc.id); db.run('UPDATE assets SET last_status_code=200, last_response_ms=180 WHERE id=?', id);
  recoverIncident(db.get('SELECT * FROM incidents WHERE id=?', inc.id)); await dispatchDue(50);
  assert.equal(pushes.length, 1); assert.equal(pushes[0].body.title, '✅ portal recovered'); assert.match(pushes[0].body.message, /Back up \(HTTP 200 in 180 ms\)\. Downtime: 12 minutes\./); assert.equal(pushes[0].body.priority, 3);
});

test('push server errors: temporary failure retries (alert kept), permanent 4xx fails visibly; incident stays open', async () => {
  const id = mk('flaky-push'); pushStatus = 503; const inc = down(id); await dispatchDue(50);
  let n = db.get("SELECT * FROM notifications WHERE incident_id=? AND channel='push'", inc.id); assert.equal(n.status, 'pending'); assert.equal(n.attempts, 1); assert.ok(db.all('SELECT type FROM incident_events WHERE incident_id=?', inc.id).some((e) => e.type === 'alert_retry'));
  pushStatus = 200; db.run('UPDATE notifications SET next_attempt_at=0 WHERE id=?', n.id); await dispatchDue(50); assert.equal(db.get('SELECT status FROM notifications WHERE id=?', n.id).status, 'sent', 'delivered on retry');
  const id2 = mk('denied-push'); pushStatus = 403; const inc2 = down(id2); await dispatchDue(50); n = db.get("SELECT * FROM notifications WHERE incident_id=? AND channel='push'", inc2.id); assert.equal(n.status, 'failed');
  assert.ok(db.all('SELECT type FROM incident_events WHERE incident_id=?', inc2.id).some((e) => e.type === 'alert_failed')); assert.notEqual(db.get('SELECT status FROM incidents WHERE id=?', inc2.id).status, 'resolved'); pushStatus = 200;
});

test('startup notice: tells each push topic once that the monitor (re)started', async () => {
  pushes.length = 0; assert.ok(notifyStartup() >= 1); assert.equal(notifyStartup(), 0, 'not repeated within the same minute'); await dispatchDue(50);
  const s = pushes.filter((p) => /Monitor started/.test(p.body.title)); assert.equal(s.length, 1); assert.equal(s[0].body.topic, TOPIC); assert.match(s[0].body.message, /being checked/);
});

test('test button + custom (self-hosted) push server with token; secrets never returned', async () => {
  const sup = await as('super@t.io'); pushes.length = 0;
  assert.equal((await sup.post('/api/integrations/push/test', { topic: 'short' })).status, 400);
  assert.equal((await sup.post('/api/integrations/push/test', { topic: TOPIC })).status, 200); assert.equal(pushes[0].body.title, '✅ Test alert');
  assert.equal((await sup.put('/api/integrations/push', { server: 'not a url' })).status, 400);
  assert.equal((await sup.put('/api/integrations/push', { server: 'https://push.example.org/', token: 'tk_SECRET123' })).status, 200);
  pushes.length = 0; await sup.post('/api/integrations/push/test', { topic: TOPIC }); assert.equal(pushes[0].url, 'https://push.example.org'); assert.equal(pushes[0].headers.authorization, 'Bearer tk_SECRET123');
  const i = await sup.get('/api/integrations'); assert.equal(i.json.push.custom_server, true); assert.equal(i.json.push.has_token, true); assert.ok(!i.text.includes('tk_SECRET123'), 'token is never sent back to the browser');
  const adm = await as('adminA@t.io'); assert.equal((await adm.put('/api/integrations/push', { server: 'https://x.org' })).status, 403, 'only super admin changes the server');
  await sup.put('/api/integrations/push', { clear: true });
});

test('watchdog: URL validated + stored encrypted; test ping reaches it; the app pings only what you configured', async () => {
  const sup = await as('super@t.io'); const before = W.state.hits;
  assert.equal((await sup.put('/api/integrations/watchdog', { url: 'not-a-url' })).status, 400); assert.equal((await sup.post('/api/integrations/watchdog/test')).status, 400, 'nothing saved yet');
  assert.equal((await sup.put('/api/integrations/watchdog', { url: W.url + '/ping/SECRET-UUID-1234' })).status, 200);
  assert.ok(!db.get("SELECT value FROM settings WHERE key='integration.watchdog'").value.includes('SECRET-UUID'), 'stored encrypted');
  assert.equal((await sup.post('/api/integrations/watchdog/test')).status, 200); assert.equal(W.state.hits, before + 1);
  const r = await pingWatchdog(); assert.equal(r.ok, true); assert.equal(W.state.hits, before + 2);
  const i = await sup.get('/api/integrations'); assert.equal(i.json.watchdog.configured, true); assert.ok(!i.text.includes('SECRET-UUID'));
  await sup.put('/api/integrations/watchdog', { clear: true }); assert.deepEqual(await pingWatchdog(), { skipped: true });
});
