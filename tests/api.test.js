import { targetServer, startApp, seed, addAsset, waitFor, sleep } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';

const S = await seed(); const { db } = S;
const app = await startApp(); const T = await targetServer();
test.after(async () => { await app.close(); await T.close(); });
const as = async (email) => { const c = app.mk(); await c.login(email, S.password); return c; };
const anon = app.mk();
const siteBody = (o = {}) => ({ project_id: S.projA, type: 'website', name: 'Site', target: T.url + '/', ...o });

test('auth: login, session cookie flags, wrong password, lockout, logout', async () => {
  const bad = await anon.post('/api/auth/login', { email: 'super@t.io', password: 'nope' }); assert.equal(bad.status, 401);
  const ok = await anon.login('super@t.io', S.password); const sc = ok.headers.get('set-cookie'); assert.match(sc, /HttpOnly/); assert.match(sc, /SameSite=Strict/);
  assert.equal((await anon.get('/api/auth/me')).json.user.role, 'super_admin');
  await anon.post('/api/auth/logout'); assert.equal((await anon.get('/api/auth/me')).status, 401);
  const v = app.mk(); for (let i = 0; i < 5; i++) await v.post('/api/auth/login', { email: 'adminB@t.io', password: 'x' + i });
  const locked = await v.post('/api/auth/login', { email: 'adminB@t.io', password: S.password }); assert.equal(locked.status, 429, 'account locked after 5 failures even with the right password');
  db.run('UPDATE users SET failed_logins=0, locked_until=NULL WHERE email=?', 'adminB@t.io');
});

test('security: unauthenticated API access is rejected; CSRF header required for state changes', async () => {
  assert.equal((await anon.get('/api/assets')).status, 401); assert.equal((await anon.get('/api/incidents')).status, 401);
  const c = await as('super@t.io'); const noHeader = await c.raw('POST', '/api/projects', { name: 'X' }, { 'X-Requested-With': '' }); assert.equal(noHeader.status, 403);
  const h = await fetch(app.base + '/'); assert.match(h.headers.get('content-security-policy'), /default-src 'self'/); assert.equal(h.headers.get('x-frame-options'), 'DENY');
});

test('17. role permissions: super admin / admin / technician', async () => {
  const sup = await as('super@t.io'), adm = await as('adminA@t.io'), tech = await as('techA@t.io');
  assert.equal((await sup.post('/api/projects', { name: 'Project C' })).status, 200); assert.equal((await adm.post('/api/projects', { name: 'Nope' })).status, 403, 'only super admin creates projects');
  assert.equal((await adm.post('/api/assets', siteBody({ name: 'by-admin' }))).status, 200);
  assert.equal((await adm.post('/api/assets', siteBody({ project_id: S.projB, name: 'wrong-project' }))).status, 403, 'admin cannot register in a project they do not manage');
  assert.equal((await tech.post('/api/assets', siteBody({ name: 'by-tech' }))).status, 403);
  assert.equal((await adm.post('/api/users', { email: 'newadmin@t.io', name: 'n', role: 'admin', password: 'Another-Long-Pass-1' })).status, 403, 'admin cannot create admins');
  assert.equal((await adm.post('/api/users', { email: 'newtech@t.io', name: 'n', role: 'technician', password: 'Another-Long-Pass-1', projects: [S.projA] })).status, 200);
  assert.equal((await adm.post('/api/users', { email: 'oldrole@t.io', name: 'n', role: 'client', password: 'Another-Long-Pass-1' })).status, 400, 'client role no longer exists');
  assert.equal((await adm.post('/api/users', { email: 'x@t.io', name: 'n', role: 'technician', password: 'Another-Long-Pass-1', projects: [S.projB] })).status, 403, 'cannot assign projects outside own scope');
  assert.equal((await adm.post('/api/users', { email: 'short@t.io', name: 'n', role: 'technician', password: 'short', projects: [S.projA] })).status, 400);
  assert.equal((await adm.get('/api/audit')).status, 403); assert.equal((await sup.get('/api/audit')).status, 200);
  assert.equal((await adm.put('/api/integrations/email', { host: 'x' })).status, 403, 'only super admin edits integrations'); assert.equal((await tech.get('/api/integrations')).status, 403);
  assert.equal((await tech.get('/api/recipients')).status, 403, 'technicians cannot manage alert recipients');
  const inc = db.insert("INSERT INTO incidents(asset_id,project_id,category,severity,title,status,first_detected,last_detected) VALUES(?,?,?,?,?,?,?,?)", addAsset(db, S.projA, { target: 'http://perm.com', name: 'perm' }), S.projA, 'availability', 'critical', 'Down', 'new', Date.now(), Date.now());
  assert.equal((await tech.patch(`/api/incidents/${inc}`, { status: 'investigating' })).status, 200);
  assert.equal((await tech.patch(`/api/incidents/${inc}`, { status: 'closed' })).status, 403, 'technicians mark resolved; admins close');
  assert.equal((await tech.patch(`/api/incidents/${inc}`, { status: 'resolved', root_cause: 'bad deploy' })).status, 200);
  assert.equal((await adm.patch(`/api/incidents/${inc}`, { status: 'closed' })).status, 200);
  assert.equal((await tech.post(`/api/incidents/${inc}/notes`, { text: 'rolled back', kind: 'action' })).status, 200);
  const sel = await tech.patch(`/api/incidents/${inc}`, { assignee_id: S.users.adminB }); assert.equal(sel.status, 400, 'cannot assign to someone outside the project');
});

test('18. project isolation: admins/technicians only ever see their own projects across assets, incidents, reports, exports, recipients and users', async () => {
  const aId = addAsset(db, S.projA, { target: 'http://a.com', name: 'A-private' }); const bId = addAsset(db, S.projB, { target: 'http://b.com', name: 'B-private' });
  const bInc = db.insert("INSERT INTO incidents(asset_id,project_id,category,severity,title,status,first_detected,last_detected) VALUES(?,?,?,?,?,?,?,?)", bId, S.projB, 'availability', 'critical', 'B outage', 'new', Date.now(), Date.now());
  db.run("INSERT INTO recipients(project_id,channel,address,level,min_severity,created_at) VALUES(?,?,?,?,?,?)", S.projB, 'email', 'b-secret@b.com', 1, 'low', Date.now());
  const adA = await as('adminA@t.io'), adB = await as('adminB@t.io'), tech = await as('techA@t.io');
  const names = (r) => r.json.items.map((x) => x.name);
  for (const who of [adA, tech]) { const l = await who.get('/api/assets?page_size=200'); assert.ok(names(l).includes('A-private')); assert.ok(!names(l).includes('B-private')); }
  assert.ok(names(await adB.get('/api/assets?page_size=200')).includes('B-private')); assert.ok(!names(await adB.get('/api/assets?page_size=200')).includes('A-private'));
  for (const who of [adA, tech]) {
    assert.equal((await who.get(`/api/assets/${bId}`)).status, 404, 'direct object reference to another project is a 404'); assert.equal((await who.get(`/api/incidents/${bInc}`)).status, 404);
    assert.equal((await who.get(`/api/incidents/${bInc}/export.pdf`)).status, 404); assert.equal((await who.patch(`/api/incidents/${bInc}`, { status: 'acknowledged' })).status, 404);
    assert.ok(!(await who.get('/api/incidents?view=active')).text.includes('B outage')); assert.ok(!(await who.get('/api/projects')).text.includes('Project B'));
    assert.equal((await who.get(`/api/reports?project_id=${S.projB}`)).status, 404); assert.ok(!(await who.get('/api/reports')).text.includes('B-private')); assert.ok(!(await who.get('/api/analytics')).text.includes('B-private'));
    assert.ok(!(await who.get('/api/dashboard')).text.includes('B outage')); assert.ok(!(await who.get('/api/incidents-export')).text.includes('B outage')); assert.ok(!(await who.get('/api/assets-export')).text.includes('B-private'));
  }
  assert.ok(!(await adA.get('/api/recipients')).text.includes('b-secret@b.com')); assert.ok(!(await adA.get('/api/users')).text.includes('adminB@t.io'));
  assert.equal((await adA.put(`/api/assets/${bId}`, { type: 'website', name: 'x', target: T.url + '/' })).status, 404, 'cannot edit another project\'s asset'); assert.equal((await adA.del(`/api/assets/${bId}`, { confirm: 'B-private' })).status, 404);
  assert.equal((await adA.post('/api/recipients', { project_id: S.projB, channel: 'email', address: 'x@y.co' })).status, 403);
  const stream = await fetch(app.base + '/api/stream'); assert.equal(stream.status, 401, 'event stream requires auth');
  void aId;
});

test('secrets are masked everywhere and encrypted at rest; masked placeholders keep stored values on edit', async () => {
  const sup = await as('super@t.io'); const r = await sup.post('/api/assets', siteBody({ project_id: S.projA, name: 'Cfg', type: 'api', target: T.url + '/api', config: { headers: { Authorization: 'Bearer SUPERSECRET' }, method: 'GET' }, secret: { type: 'bearer', token: 'TOPSECRET' } })); assert.equal(r.status, 200, r.text);
  const id = r.json.id; const tech = await as('techA@t.io');
  for (const who of [sup, tech]) { const v = await who.get(`/api/assets/${id}`); assert.ok(!v.text.includes('TOPSECRET') && !v.text.includes('SUPERSECRET'), 'secrets are masked for everyone'); }
  const adminView = await sup.get(`/api/assets/${id}`); assert.equal(adminView.json.asset.secret_masked.token, '••••••••'); assert.equal(adminView.json.asset.secret_masked.type, 'bearer');
  const raw = db.get('SELECT secret_enc, config FROM assets WHERE id=?', id); assert.ok(raw.secret_enc.startsWith('v1:') && !raw.secret_enc.includes('TOPSECRET'), 'encrypted at rest');
  const upd = await sup.put(`/api/assets/${id}`, { type: 'api', name: 'Cfg2', target: T.url + '/api', config: { headers: adminView.json.asset.config.headers, method: 'GET' }, secret: adminView.json.asset.secret_masked }); assert.equal(upd.status, 200, upd.text);
  const { decryptJson } = await import('../src/crypto.js'); assert.equal(decryptJson(db.get('SELECT secret_enc FROM assets WHERE id=?', id).secret_enc).token, 'TOPSECRET'); assert.match(db.get('SELECT config FROM assets WHERE id=?', id).config, /SUPERSECRET/);
});

test('SSRF & authorisation: private/internal targets rejected at registration when policy is on; invalid input rejected; duplicates detected', async () => {
  const cfg = (await import('../src/config.js')).config; cfg.allowPrivateTargets = false;
  try {
    const sup = await as('super@t.io');
    for (const u of ['http://127.0.0.1/', 'http://localhost/', 'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.5/', 'http://[::1]/']) { const r = await sup.post('/api/assets', siteBody({ target: u, name: 'ssrf' })); assert.equal(r.status, 400, u); assert.match(r.json.error, /private|internal|SSRF/i); }
    assert.equal((await sup.post('/api/assets', siteBody({ target: 'file:///etc/passwd', name: 'f' }))).status, 400); assert.equal((await sup.post('/api/assets', siteBody({ target: 'ftp://x.com', name: 'f' }))).status, 400);
    assert.equal((await sup.post('/api/assets', siteBody({ target: 'http://user:pw@example.com/', name: 'f' }))).status, 400, 'credentials in URL refused');
    assert.equal((await sup.post('/api/assets', { project_id: S.projA, type: 'database', name: 'db', config: { kind: 'redis', host: '10.0.0.8' } })).status, 400);
    assert.equal((await sup.post('/api/assets', { project_id: S.projA, type: 'ssl', name: 'ssl', config: { host: '192.168.1.1' } })).status, 400);
    const { probe } = await import('../src/checkers/probe.js'); const r = await probe('http://127.0.0.1:' + T.port + '/', { timeout: 2000 }); assert.equal(r.error?.code, 'ESSRF', 'runtime connection guard also blocks (defeats DNS rebinding)');
  } finally { cfg.allowPrivateTargets = true; }
  const sup = await as('super@t.io'); const first = await sup.post('/api/assets', siteBody({ name: 'dupe', target: T.url + '/dupe' })); assert.equal(first.status, 200);
  const dup = await sup.post('/api/assets', siteBody({ name: 'dupe2', target: T.url + '/dupe' })); assert.equal(dup.status, 409);
  assert.equal((await sup.post('/api/assets', siteBody({ name: '', target: T.url + '/z' }))).status, 400); assert.equal((await sup.post('/api/assets', { ...siteBody(), type: 'bogus' })).status, 400);
});

test('asset lifecycle: server registration returns a one-time agent token that works; delete requires confirmation and keeps history', async () => {
  const sup = await as('super@t.io'); const r = await sup.post('/api/assets', { project_id: S.projA, type: 'server', name: 'web-01', config: { hostname: 'web-01.example.com', services: ['nginx'] } });
  assert.equal(r.status, 200); assert.match(r.json.agent_token, /^tgtm_/); const tok = r.json.agent_token;
  assert.ok(!JSON.stringify(db.all('SELECT * FROM assets WHERE id=?', r.json.id)).includes(tok), 'token stored only as a hash');
  assert.equal((await anon.raw('POST', '/api/agent/ingest', { cpu_percent: 1 }, { authorization: 'Bearer wrong' })).status, 401); assert.equal((await anon.raw('POST', '/api/agent/ingest', { cpu_percent: 1 })).status, 401);
  const ing = await anon.raw('POST', '/api/agent/ingest', { cpu_percent: 12.5, ram_percent: 40, ram_available_mb: 2048, load1: 0.3, disks: [{ mount: '/', percent: 41 }], services: [{ name: 'nginx', running: true }], hostname: 'web-01', os: 'Linux', agent_version: '1.0.0' }, { authorization: `Bearer ${tok}` });
  assert.equal(ing.status, 200); assert.deepEqual(ing.json.services, ['nginx']);
  const d = await sup.get(`/api/assets/${r.json.id}`); assert.equal(d.json.asset.status, 'operational'); assert.equal(d.json.metrics.cpu.length, 1); assert.equal(d.json.asset.state.last_report.disks[0].percent, 41);
  const rot = await sup.post(`/api/assets/${r.json.id}/agent-token`); assert.equal((await anon.raw('POST', '/api/agent/ingest', { cpu_percent: 1 }, { authorization: `Bearer ${tok}` })).status, 401, 'old token revoked on rotation'); assert.ok(rot.json.agent_token);
  const nd = await sup.del(`/api/assets/${r.json.id}`, { confirm: 'wrong' }); assert.equal(nd.status, 400);
  db.run("INSERT INTO checks(asset_id,ts,kind,state) VALUES(?,?,'check','ok')", r.json.id, Date.now());
  assert.equal((await sup.del(`/api/assets/${r.json.id}`, { confirm: 'web-01' })).status, 200);
  assert.equal((await sup.get(`/api/assets/${r.json.id}`)).status, 404); assert.equal(db.get('SELECT COUNT(*) n FROM checks WHERE asset_id=?', r.json.id).n, 1, 'history preserved');
});

test('bulk import validates, de-duplicates and creates', async () => {
  const sup = await as('super@t.io'); const csv = `name,url,type,interval_sec\nOne,${T.url}/imp1,website,30\nTwo,${T.url}/imp2,api,60\nBad,not-a-url,website,60\nDup,${T.url}/imp1,website,60`;
  const dry = await sup.post('/api/assets/import', { project_id: S.projA, csv, dry_run: true }); assert.equal(dry.status, 200, dry.text); assert.equal(dry.json.summary.valid, 2); assert.equal(dry.json.summary.invalid, 1); assert.equal(dry.json.summary.duplicate, 1);
  assert.equal(db.get("SELECT COUNT(*) n FROM assets WHERE target LIKE '%/imp%'").n, 0, 'dry run writes nothing');
  const real = await sup.post('/api/assets/import', { project_id: S.projA, csv, dry_run: false }); assert.equal(real.json.summary.created, 2);
  assert.equal((await sup.post('/api/assets/import', { project_id: S.projA, urls: `${T.url}/imp1\n${T.url}/imp3`, dry_run: false })).json.summary.created, 1, 'existing assets are detected as duplicates');
});

test('integrations: unconfigured status is shown honestly; secrets never returned; webhook verification', async () => {
  const sup = await as('super@t.io'); let i = (await sup.get('/api/integrations')).json; assert.equal(i.email.configured, false); assert.match(i.email.setup, /SMTP/); assert.equal(i.whatsapp.configured, false); assert.match(i.whatsapp.setup, /template/i);
  assert.equal((await sup.post('/api/integrations/email/test', { to: 'a@b.co' })).status, 400); assert.equal((await sup.post('/api/integrations/whatsapp/test', { to: '971500000000' })).status, 400);
  await sup.put('/api/integrations/whatsapp', { phone_number_id: '999', token: 'SUPERTOKEN', app_secret: 'appsec', verify_token: 'myverify', template: 't' });
  i = (await sup.get('/api/integrations')).json; assert.equal(i.whatsapp.configured, true); assert.ok(!JSON.stringify(i).includes('SUPERTOKEN') && !JSON.stringify(i).includes('appsec'));
  const ok = await fetch(`${app.base}/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=myverify&hub.challenge=12345`); assert.equal(await ok.text(), '12345');
  assert.equal((await fetch(`${app.base}/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1`)).status, 403);
  assert.equal((await fetch(`${app.base}/api/webhooks/whatsapp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=bad' }, body: '{}' })).status, 401, 'unsigned webhook rejected');
  const crypto = await import('node:crypto'); const body = JSON.stringify({ entry: [] }); const sig = 'sha256=' + crypto.createHmac('sha256', 'appsec').update(body).digest('hex');
  assert.equal((await fetch(`${app.base}/api/webhooks/whatsapp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig }, body })).status, 200);
  const rec = await sup.post('/api/recipients', { project_id: S.projA, channel: 'whatsapp', address: '+971 50 000 0009', consent: false }); assert.equal(rec.status, 400, 'WhatsApp recipient needs consent');
  assert.equal((await sup.post('/api/recipients', { project_id: S.projA, channel: 'whatsapp', address: '+971 50 000 0009', consent: true })).status, 200);
  assert.equal((await sup.post('/api/recipients', { project_id: S.projA, channel: 'email', address: 'not-an-email' })).status, 400);
});

test('report & export endpoints return real files', async () => {
  const sup = await as('super@t.io'); const pdf = await fetch(app.base + '/api/reports?period=weekly&format=pdf', { headers: { cookie: (await (async () => { const c = app.mk(); const r = await c.login('super@t.io', S.password); return r.headers.get('set-cookie').split(';')[0]; })()) } });
  assert.equal(pdf.status, 200); assert.equal(pdf.headers.get('content-type'), 'application/pdf'); assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 4).toString(), '%PDF');
  assert.match((await sup.get('/api/incidents-export')).text, /^code,project_name/); assert.match((await sup.get('/api/reports?period=daily&format=csv')).text, /# ASSETS/); assert.equal((await sup.get('/api/reports?from=5&to=1')).status, 400);
});

test('health & metrics endpoints for independent monitoring of the platform itself', async () => {
  const h = await anon.get('/healthz'); assert.equal(h.status, 503, 'degraded when no scheduler has run'); assert.equal(h.json.db, true);
  db.run("INSERT INTO heartbeats(name,ts) VALUES('scheduler',?) ON CONFLICT(name) DO UPDATE SET ts=excluded.ts", Date.now()); db.run("INSERT INTO heartbeats(name,ts) VALUES('dispatcher',?) ON CONFLICT(name) DO UPDATE SET ts=excluded.ts", Date.now());
  assert.equal((await anon.get('/healthz')).status, 200); const m = await anon.get('/metrics'); assert.match(m.text, /tgt_assets\{status=/); assert.match(m.text, /tgt_heartbeat_age_seconds/);
});

test('19/20. monitoring runs with no dashboard/session; scheduler recovers after a crash (stale leases, missed checks recorded as gaps, no duplicate runs)', async () => {
  const { startScheduler, stopScheduler } = await import('../src/monitor.js');
  const id = addAsset(db, S.projA, { target: T.url + '/sched', name: 'Sched', interval_sec: 15, next_run_at: 0 });
  // simulate a worker that crashed mid-check long ago: lease still held, last check an hour ago, next_run overdue
  db.run('UPDATE assets SET lease_until=?, last_check_at=?, next_run_at=? WHERE id=?', Date.now() + 600000, Date.now() - 3600000, Date.now() - 3600000, id);
  const before = T.state.hits; startScheduler();
  await waitFor(() => db.get('SELECT COUNT(*) n FROM checks WHERE asset_id=? AND kind=\'check\'', id).n >= 1, 6000);
  const a = db.get('SELECT * FROM assets WHERE id=?', id); assert.equal(a.status, 'operational'); assert.equal(a.lease_until, null, 'lease released');
  const gap = db.get("SELECT * FROM checks WHERE asset_id=? AND kind='gap'", id); assert.ok(gap, 'missed checks recorded'); assert.match(gap.error, /Monitoring gap/);
  assert.ok(a.next_run_at > Date.now() + 10000, 'rescheduled at the configured interval');
  await sleep(1500); assert.equal(db.get("SELECT COUNT(*) n FROM checks WHERE asset_id=? AND kind='check'", id).n, 1, 'no duplicate overlapping execution for the same asset');
  assert.ok(T.state.hits > before);
  // nobody is logged in: no sessions exist for this app instance's scheduler to depend on
  assert.equal(db.get('SELECT COUNT(*) n FROM sessions WHERE expires_at<?', 0).n, 0);
  db.run('UPDATE assets SET next_run_at=? WHERE id=?', Date.now() - 1000, id); await waitFor(() => db.get("SELECT COUNT(*) n FROM checks WHERE asset_id=? AND kind='check'", id).n >= 2, 5000);
  assert.ok(db.get("SELECT ts FROM heartbeats WHERE name='scheduler'").ts > Date.now() - 5000, 'scheduler heartbeat is fresh');
  await stopScheduler();
});

test('SSRF via redirect: a public URL redirecting to an internal address is blocked at the hop', async () => {
  const cfg = (await import('../src/config.js')).config; const { probe } = await import('../src/checkers/probe.js');
  const R = await targetServer({ '/r': (_q, res) => { res.statusCode = 302; res.setHeader('location', 'http://169.254.169.254/latest/meta-data/'); res.end(); } });
  cfg.allowedHosts = ['127.0.0.1']; cfg.allowPrivateTargets = false; // allow only the redirecting origin itself
  try { const r = await probe(R.url + '/r', { timeout: 2000 }); assert.equal(r.error?.code, 'ESSRF', 'redirect hop to link-local metadata IP must be refused') ; assert.match(r.error.message, /private\/internal/); }
  finally { cfg.allowedHosts = []; cfg.allowPrivateTargets = true; await R.close(); }
});

test('bulk import from a URL list honours the chosen interval and criticality (regression)', async () => {
  const sup = await as('super@t.io'); const r = await sup.post('/api/assets/import', { project_id: S.projA, urls: `${T.url}/iv1`, interval_sec: 30, criticality: 'critical', dry_run: false }); assert.equal(r.json.summary.created, 1);
  const a = db.get("SELECT interval_sec, criticality FROM assets WHERE target LIKE '%/iv1'"); assert.equal(a.interval_sec, 30); assert.equal(a.criticality, 'critical');
});

test('quick add: one pasted address creates project (if none), detects type, runs first check; duplicates and permissions handled', async () => {
  const sup = await as('super@t.io'), tech = await as('techA@t.io');
  const bare = T.url.replace('http://', ''); // no scheme: should be accepted (https assumed) but our target is http, so give the full URL here
  const r = await sup.post('/api/quick-add', { url: T.url + '/qa' }); assert.equal(r.status, 200, r.text); assert.equal(r.json.type, 'website'); assert.equal(r.json.status, 'operational'); assert.ok(r.json.last_response_ms >= 0);
  const api = await sup.post('/api/quick-add', { url: T.url + '/api/health' }); assert.equal(api.json.type, 'api');
  assert.equal((await sup.post('/api/quick-add', { url: T.url + '/qa' })).status, 409, 'duplicate'); assert.equal((await sup.post('/api/quick-add', { url: '' })).status, 400); assert.equal((await tech.post('/api/quick-add', { url: T.url + '/x' })).status, 403);
  assert.equal(db.get('SELECT type FROM assets WHERE id=?', api.json.id).type, 'api');
  const bareRes = await sup.post('/api/quick-add', { url: 'does-not-exist-tgt.invalid' }); assert.equal(bareRes.status, 200); assert.equal(db.get('SELECT target FROM assets WHERE id=?', bareRes.json.id).target, 'https://does-not-exist-tgt.invalid', 'bare domain gets https://'); void bare;
  const lh = await sup.post('/api/quick-add', { url: T.url.replace('http://', '') + '/lh' }); assert.equal(lh.status, 200, lh.text); assert.equal(db.get('SELECT target FROM assets WHERE id=?', lh.json.id).target, T.url + '/lh', 'IP:port defaults to http'); assert.equal(lh.json.status, 'operational');
  const loc = await sup.post('/api/quick-add', { url: 'localhost:' + T.port + '/loc' }); assert.equal(db.get('SELECT target FROM assets WHERE id=?', loc.json.id).target, `http://localhost:${T.port}/loc`);
});
