import { TMP, targetServer, closedPort, seed, addAsset, sleep } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import tls from 'node:tls';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const S = await seed();
const { db } = S;
const { runNow, ingestAgent, hydrate } = await import('../src/monitor.js');
const { encryptJson } = await import('../src/crypto.js');
const { evaluateExpiry } = await import('../src/incidents.js');
const { uptime } = await import('../src/stats.js');
const asset = (id) => db.get('SELECT * FROM assets WHERE id=?', id);
const openInc = (id, cat) => db.get("SELECT * FROM incidents WHERE asset_id=? AND category=? AND status NOT IN ('resolved','closed')", id, cat);
const allInc = (id) => db.all('SELECT * FROM incidents WHERE asset_id=? ORDER BY id', id);

let mode = 'ok';
const T = await targetServer({
  '*': (req, res) => {
    if (mode === 'down') return req.socket.destroy();
    const m = /^\/status\/(\d+)/.exec(req.url); if (m) { res.statusCode = +m[1]; return res.end('x'); }
    res.setHeader('content-type', 'text/html'); res.end('<h1>Welcome Home</h1>');
  },
  '/api/ok': (_q, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ status: 'ok', data: { id: 7, count: 3 } })); },
  '/api/badjson': (_q, res) => { res.setHeader('content-type', 'application/json'); res.end('{oops'); },
  '/api/nofield': (_q, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ status: 'ok' })); },
  '/api/slow': (_q, res) => { setTimeout(() => { res.setHeader('content-type', 'application/json'); res.end('{"status":"ok"}'); }, 400); },
  '/api/secure': (req, res) => { if (req.headers.authorization !== 'Bearer good-token') { res.statusCode = 401; return res.end('{"error":"nope"}'); } res.setHeader('content-type', 'application/json'); res.end('{"status":"ok"}'); },
});
test.after(() => T.close());

test.beforeEach(() => { mode = 'ok'; });

test('1. register a website and it becomes operational (verified, with timings)', async () => {
  const id = addAsset(db, S.projA, { target: T.url + '/', name: 'Site' });
  await runNow(id); const a = asset(id);
  assert.equal(a.status, 'operational'); assert.equal(a.verified, 1); assert.equal(a.last_status_code, 200); assert.ok(a.last_response_ms >= 0);
  const c = db.get('SELECT * FROM checks WHERE asset_id=?', id); assert.equal(c.state, 'ok'); assert.ok(JSON.parse(c.detail).total_ms !== undefined);
});

test('2/3. downtime is VERIFIED by retries before an incident, then recovery is detected automatically', async () => {
  const id = addAsset(db, S.projA, { target: T.url + '/', name: 'Flappy', verify_failures: 3, recover_successes: 2, criticality: 'critical' });
  await runNow(id); assert.equal(asset(id).status, 'operational');
  mode = 'down';
  await runNow(id); assert.equal(asset(id).status, 'degraded', 'a failed check is re-tested once after 500 ms; with a verification of 3 it is still unverified'); assert.equal(allInc(id).length, 0);
  assert.equal(db.get("SELECT COUNT(*) n FROM checks WHERE asset_id=? AND state='fail'", id).n, 2, 'both the first check and the quick retry are kept in the history');
  await runNow(id); const inc = openInc(id, 'availability');
  assert.ok(inc, 'the third consecutive failure opens the incident'); assert.equal(inc.severity, 'critical'); assert.equal(asset(id).status, 'down');
  await runNow(id); assert.equal(allInc(id).length, 1, 'continued failure must not duplicate the incident or re-notify');
  const confirmed = db.get("SELECT COUNT(*) n FROM checks WHERE asset_id=? AND state='fail' AND confirmed=1", id).n; assert.ok(confirmed >= 3, 'earlier failures retro-confirmed as downtime');
  assert.ok(db.all('SELECT type FROM incident_events WHERE incident_id=?', inc.id).some((e) => e.type === 'verified'));
  mode = 'ok';
  await runNow(id); assert.ok(openInc(id, 'availability'), 'one success is not enough to resolve');
  await runNow(id);
  const done = db.get('SELECT * FROM incidents WHERE id=?', inc.id); assert.equal(done.status, 'resolved'); assert.ok(done.recovered_at >= done.first_detected);
  assert.equal(asset(id).status, 'operational');
  const types = db.all('SELECT type FROM incident_events WHERE incident_id=?', inc.id).map((e) => e.type); for (const t of ['detected', 'verified', 'recovered', 'resolved']) assert.ok(types.includes(t), `timeline has ${t}`);
});

test('a single transient failure never creates an incident', async () => {
  const id = addAsset(db, S.projA, { target: T.url + '/', name: 'Blip', verify_failures: 3 });
  await runNow(id); mode = 'down'; await runNow(id); mode = 'ok'; await runNow(id); await runNow(id);
  assert.equal(allInc(id).length, 0); assert.equal(asset(id).status, 'operational');
  const u = uptime(id, 0); assert.equal(u.pct, 100, 'unconfirmed blip is not counted as downtime');
});

test('4. HTTP errors 404/500/502/503 are classified; expected-status override works', async () => {
  for (const code of [404, 500, 502, 503]) {
    const id = addAsset(db, S.projA, { target: `${T.url}/status/${code}`, name: `S${code}`, verify_failures: 1 });
    await runNow(id); const a = asset(id); assert.equal(a.status, 'down', String(code)); assert.match(a.status_reason, new RegExp(`HTTP ${code}`)); assert.equal(a.last_status_code, code);
  }
  const id = addAsset(db, S.projA, { target: `${T.url}/status/404`, name: 'Expect404', config: { expected_status: '404' }, verify_failures: 1 });
  await runNow(id); assert.equal(asset(id).status, 'operational');
});

test('missing expected content fails the check even though HTTP is 200', async () => {
  const id = addAsset(db, S.projA, { target: T.url + '/', name: 'Content', config: { expected_content: 'NOT PRESENT' }, verify_failures: 1 });
  await runNow(id); assert.equal(asset(id).status, 'down'); assert.match(asset(id).status_reason, /Expected content not found/);
});

test('5. API authentication failure is reported distinctly; correct token passes', async () => {
  const bad = addAsset(db, S.projA, { type: 'api', target: T.url + '/api/secure', verify_failures: 1, secret_enc: encryptJson({ type: 'bearer', token: 'wrong' }) });
  await runNow(bad); assert.equal(asset(bad).status, 'down'); assert.match(asset(bad).status_reason, /Authentication failure: HTTP 401/);
  assert.ok(openInc(bad, 'api_failure'));
  const good = addAsset(db, S.projA, { type: 'api', target: T.url + '/api/secure', verify_failures: 1, secret_enc: encryptJson({ type: 'bearer', token: 'good-token' }) });
  await runNow(good); assert.equal(asset(good).status, 'operational');
});

test('6. incorrect JSON / missing fields / schema / assertions are caught', async () => {
  const a1 = addAsset(db, S.projA, { type: 'api', target: T.url + '/api/badjson', verify_failures: 1 }); await runNow(a1); assert.match(asset(a1).status_reason, /not valid JSON/);
  const a2 = addAsset(db, S.projA, { type: 'api', target: T.url + '/api/nofield', verify_failures: 1, config: { expected_fields: ['status', 'data.id'] } }); await runNow(a2); assert.match(asset(a2).status_reason, /Missing required field: data\.id/);
  const a3 = addAsset(db, S.projA, { type: 'api', target: T.url + '/api/ok', verify_failures: 1, config: { schema: { type: 'object', required: ['status'], properties: { data: { type: 'object', properties: { id: { type: 'string' } } } } } } }); await runNow(a3); assert.match(asset(a3).status_reason, /expected string/);
  const a4 = addAsset(db, S.projA, { type: 'api', target: T.url + '/api/ok', verify_failures: 1, config: { assertions: [{ path: 'data.count', op: 'gt', value: 10 }] } }); await runNow(a4); assert.match(asset(a4).status_reason, /Assertion failed/);
  const a5 = addAsset(db, S.projA, { type: 'api', target: T.url + '/api/ok', verify_failures: 1, config: { expected_fields: ['status', 'data.id'], assertions: [{ path: 'data.count', op: 'eq', value: 3 }] } }); await runNow(a5); assert.equal(asset(a5).status, 'operational');
  const body = db.get('SELECT detail, error FROM checks WHERE asset_id=?', a5); assert.ok(!/"id":7/.test(body.detail || ''), 'response bodies are never stored');
});

test('7. slow responses are flagged Slow, verified by a quick retry, and alert once per slow episode', async () => {
  const id = addAsset(db, S.projA, { type: 'api', target: T.url + '/api/slow', config: { max_response_ms: 100 }, verify_failures: 2, timeout_ms: 3000 });
  await runNow(id); assert.equal(asset(id).status, 'slow');
  const inc = openInc(id, 'performance'); assert.ok(inc, 'slow is verified by the 500 ms retry and then raised once'); assert.equal(inc.severity, 'medium'); assert.match(inc.description, /Slow response: \d+ ms \(threshold 100 ms\)/);
  await runNow(id); await runNow(id); assert.equal(allInc(id).length, 1, 'one alert per slow episode, not one per slow check');
});

test('8. server CPU / RAM / disk threshold breaches create incidents with Critical vs Medium severity, and clear on recovery', async () => {
  const id = addAsset(db, S.projA, { type: 'server', target: 'srv1', config: { hostname: 'srv1' }, interval_sec: 60 });
  const feed = (cpu, ram, disk) => { ingestAgent(hydrate(asset(id)), { cpu_percent: cpu, ram_percent: ram, ram_available_mb: 100, load1: 1, disks: [{ mount: '/', percent: disk }], services: [] }); };
  feed(30, 40, 50); assert.equal(asset(id).status, 'operational');
  feed(97, 40, 50); assert.equal(allInc(id).length, 0, 'resource breaches are verified (2 samples) before alerting'); feed(97, 40, 50);
  const cpu = openInc(id, 'resource_cpu'); assert.equal(cpu.severity, 'critical');
  feed(30, 88, 50); feed(30, 88, 50); const ram = openInc(id, 'resource_ram'); assert.equal(ram.severity, 'medium', 'warning level (85-95) is Medium');
  feed(30, 96, 95); feed(30, 96, 95); assert.equal(openInc(id, 'resource_ram').severity, 'critical', 'severity raised on worsening'); assert.ok(openInc(id, 'resource_disk'));
  assert.ok(db.all('SELECT type FROM incident_events WHERE incident_id=?', ram.id).some((e) => e.type === 'severity_change'));
  feed(20, 30, 40); feed(20, 30, 40); assert.equal(openInc(id, 'resource_cpu'), undefined); assert.equal(openInc(id, 'resource_ram'), undefined); assert.equal(asset(id).status, 'operational');
});

test('custom thresholds and registered-service monitoring', async () => {
  const id = addAsset(db, S.projA, { type: 'server', target: 'srv2', config: { hostname: 'srv2', thresholds: { cpu: [50, 60] }, services: ['nginx'] } });
  const f = (svc) => ingestAgent(hydrate(asset(id)), { cpu_percent: 55, ram_percent: 10, disks: [], services: svc });
  f([{ name: 'nginx', running: true }]); f([{ name: 'nginx', running: true }]); assert.equal(openInc(id, 'resource_cpu').severity, 'medium', '55% exceeds the custom 50% warning');
  f([{ name: 'nginx', running: false }]); f([{ name: 'nginx', running: false }]);
  const s = openInc(id, 'service'); assert.ok(s); assert.match(s.title, /nginx/);
});

test('9. a server that stops reporting is detected as offline and recovers when the agent returns', async () => {
  const id = addAsset(db, S.projA, { type: 'server', target: 'srv3', config: { hostname: 'srv3', agent_interval_sec: 10 }, verify_failures: 2, recover_successes: 1 });
  ingestAgent(hydrate(asset(id)), { cpu_percent: 5, ram_percent: 5, disks: [], services: [] });
  db.run('UPDATE assets SET last_heartbeat_at=? WHERE id=?', Date.now() - 120000, id);
  await runNow(id); assert.equal(allInc(id).length, 0); await runNow(id);
  const inc = openInc(id, 'agent'); assert.ok(inc, 'offline incident'); assert.equal(asset(id).status, 'down'); assert.match(inc.description, /heartbeat lost/);
  ingestAgent(hydrate(asset(id)), { cpu_percent: 5, ram_percent: 5, disks: [], services: [] });
  assert.equal(db.get('SELECT status FROM incidents WHERE id=?', inc.id).status, 'resolved', 'heartbeat resumption resolves the incident');
});

test('server never reported → Unknown, not falsely Operational', async () => {
  const id = addAsset(db, S.projA, { type: 'server', target: 'srv4', config: { hostname: 'srv4' } });
  await runNow(id); assert.equal(asset(id).status, 'unknown'); assert.equal(asset(id).verified, 0);
});

test('10. SSL: expiry schedule severities + expired certificate + untrusted/self-signed cert detected on a real TLS endpoint', async () => {
  const id = addAsset(db, S.projA, { type: 'ssl', target: 'x:443', config: { host: 'x', port: 443 }, verify_failures: 1 });
  const a = hydrate(asset(id));
  evaluateExpiry(a, 'ssl_expiry', 25, 'cert'); assert.equal(openInc(id, 'ssl_expiry').severity, 'low');
  evaluateExpiry(a, 'ssl_expiry', 5, 'cert'); assert.equal(openInc(id, 'ssl_expiry').severity, 'medium');
  evaluateExpiry(a, 'ssl_expiry', 2, 'cert'); assert.equal(openInc(id, 'ssl_expiry').severity, 'high');
  evaluateExpiry(a, 'ssl_expiry', -1, 'cert'); assert.equal(openInc(id, 'ssl_expiry').severity, 'critical'); assert.match(openInc(id, 'ssl_expiry').title, /EXPIRED/);
  evaluateExpiry(a, 'ssl_expiry', 90, 'cert'); assert.equal(openInc(id, 'ssl_expiry'), undefined, 'renewal verified → resolved');
  // real handshake against a self-signed cert
  let key; try { execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(TMP, 'k.pem'), '-out', path.join(TMP, 'c.pem'), '-days', '30', '-subj', '/CN=localhost'], { stdio: 'ignore' }); key = true; } catch { key = false; }
  if (!key) return;
  const srv = tls.createServer({ key: fs.readFileSync(path.join(TMP, 'k.pem')), cert: fs.readFileSync(path.join(TMP, 'c.pem')) }, (s) => s.end()); await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const id2 = addAsset(db, S.projA, { type: 'ssl', target: 'localhost', config: { host: '127.0.0.1', port: srv.address().port }, verify_failures: 1 });
  await runNow(id2); srv.close();
  const inc = openInc(id2, 'ssl'); assert.ok(inc, 'untrusted/mismatched certificate must raise an SSL incident'); assert.equal(asset(id2).status, 'down');
  const st = JSON.parse(asset(id2).state); assert.ok(st.ssl.daysLeft >= 29 && st.ssl.daysLeft <= 30);
});

test('11. database connection failures vs healthy Redis/MySQL protocol responders', async () => {
  const port = await closedPort();
  const dead = addAsset(db, S.projA, { type: 'database', target: 'pg://x', config: { kind: 'postgres', host: '127.0.0.1', port }, verify_failures: 1 });
  await runNow(dead); assert.ok(openInc(dead, 'database')); assert.match(asset(dead).status_reason, /refused/i);
  const redis = net.createServer((s) => s.on('data', () => s.write('+PONG\r\n'))); await new Promise((r) => redis.listen(0, '127.0.0.1', r));
  const r = addAsset(db, S.projA, { type: 'database', target: 'redis://x', config: { kind: 'redis', host: '127.0.0.1', port: redis.address().port }, verify_failures: 1 });
  await runNow(r); assert.equal(asset(r).status, 'operational');
  const my = net.createServer((s) => s.write(Buffer.from([0x4a, 0, 0, 0, 10, 0x38, 0x2e, 0x30, 0]))); await new Promise((x) => my.listen(0, '127.0.0.1', x));
  const m = addAsset(db, S.projA, { type: 'database', target: 'my://x', config: { kind: 'mysql', host: '127.0.0.1', port: my.address().port }, verify_failures: 1 });
  await runNow(m); assert.equal(asset(m).status, 'operational');
  const notDb = net.createServer((s) => s.write('HTTP/1.1 200 OK\r\n\r\n')); await new Promise((x) => notDb.listen(0, '127.0.0.1', x));
  const bad = addAsset(db, S.projA, { type: 'database', target: 'pg://y', config: { kind: 'postgres', host: '127.0.0.1', port: notDb.address().port }, verify_failures: 1 });
  await runNow(bad); assert.equal(asset(bad).status, 'down', 'an open port that is not PostgreSQL must not look healthy');
  redis.close(); my.close(); notDb.close();
});

test('maintenance mode suppresses checks and alerts', async () => {
  const id = addAsset(db, S.projA, { target: T.url + '/status/500', name: 'Maint', verify_failures: 1 });
  db.run('UPDATE assets SET maintenance=1 WHERE id=?', id);
  await runNow(id); assert.equal(asset(id).status, 'maintenance'); assert.equal(allInc(id).length, 0); assert.equal(db.get('SELECT COUNT(*) n FROM checks WHERE asset_id=?', id).n, 0);
});

test('unreachable host / DNS failure produce clear errors; SSRF policy blocks private targets when enabled', async () => {
  const id = addAsset(db, S.projA, { target: 'http://does-not-exist.invalid/', verify_failures: 1, timeout_ms: 8000 });
  await runNow(id); assert.match(asset(id).status_reason, /DNS resolution failed|Timeout after/);
  const { isPrivateIp } = await import('../src/ssrf.js');
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.9', '172.16.5.5', '169.254.169.254', '::1', 'fd00::1', '::ffff:127.0.0.1', '0.0.0.0']) assert.equal(isPrivateIp(ip), true, ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.equal(isPrivateIp(ip), false, ip);
});
