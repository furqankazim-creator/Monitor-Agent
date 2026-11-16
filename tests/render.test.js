import { targetServer, startApp, seed, addAsset } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Real-browser check: an HTTP 200 does not prove a visitor sees anything. Uses a real Chromium (skipped if it is not installed).
const S = await seed(); const { db } = S;
const { config } = await import('../src/config.js');
const { renderAvailable, screenshotFile } = await import('../src/render.js');
const { runNow } = await import('../src/monitor.js');
const have = renderAvailable(); const opts = { skip: have ? false : 'Playwright browser not installed' };
config.renderEnabled = true; config.renderWaitMs = 1500; // short patience keeps the blank-page tests quick
const app = await startApp();
const API = await targetServer({ '*': (_q, res) => { res.setHeader('content-type', 'application/json'); res.end('{"name":"Rukn"}'); } }); // an API that sends NO CORS header
let page = 'good';
const PAGES = {
  good: '<!doctype html><html><head><title>Shop</title></head><body><h1>Welcome to the shop</h1><p>Browse our products and services today.</p></body></html>',
  blank: `<!doctype html><html><head><title>App</title></head><body><div id="root"></div><script>throw new Error("Failed to execute 'removeChild' on 'Node'")</script></body></html>`,
  cors: `<!doctype html><html><head><title>App</title></head><body><div id="root"></div><script>fetch('${API.url}/api/settings').then(r=>r.json()).then(d=>{document.getElementById('root').textContent='Hello '+d.name})</script></body></html>`,
  error: '<!doctype html><html><body>Application error: a client-side exception has occurred (see the browser console for more information).</body></html>',
  hidden: '<!doctype html><html><body style="background:#fff"><p style="color:#fff">Rukn Al Harir hidden text nobody can see on screen</p></body></html>',
  tiny: '<!doctype html><html><body><h1>OK</h1></body></html>',
  slow: `<!doctype html><html><head><title>Slow app</title></head><body><div id="root"></div><script>setTimeout(()=>{document.getElementById('root').innerHTML='<h1>Finally loaded</h1><p>This heavy app needed a few seconds to draw.</p>'},2500)</script></body></html>`,
  svg: '<!doctype html><html><body style="margin:0"><svg width="400" height="300"><rect width="400" height="300" fill="#c00"/></svg></body></html>',
};
const T = await targetServer({ '*': (_q, res) => { res.setHeader('content-type', 'text/html'); res.end(PAGES[page]); } });
test.after(async () => {
  await app.close();
  await T.close();
  await API.close();
  config.renderEnabled = false;
  const { closeBrowser } = await import('../src/render.js');
  await closeBrowser();
});
db.run("INSERT INTO recipients(project_id,channel,address,level,min_severity,consent,created_at) VALUES(?,?,?,?,?,1,?)", S.projA, 'email', 'noc@t.io', 1, 'low', Date.now());
const mk = (name, config = {}) => addAsset(db, S.projA, { name, target: T.url + '/', verify_failures: 2, recover_successes: 1, criticality: 'high', config });
const asset = (id) => db.get('SELECT * FROM assets WHERE id=?', id); const state = (id) => JSON.parse(asset(id).state);
const inc = (id) => db.get("SELECT * FROM incidents WHERE asset_id=? AND category='render' ORDER BY id DESC", id);

test('healthy page: displays → no incident, a screenshot is stored and served only to people who may see the project', opts, async () => {
  page = 'good'; const id = mk('shop'); await runNow(id);
  assert.equal(asset(id).status, 'operational'); assert.equal(state(id).render.state, 'ok'); assert.ok(state(id).render.textLen > 30); assert.equal(inc(id), undefined);
  assert.ok(fs.existsSync(screenshotFile(id)), 'screenshot saved');
  const adm = app.mk(); await adm.login('adminA@t.io', S.password); const img = await adm.raw('GET', `/api/assets/${id}/screenshot`); assert.equal(img.status, 200); assert.match(img.headers.get('content-type'), /image\/jpeg/);
  const other = app.mk(); await other.login('adminB@t.io', S.password); assert.equal((await other.get(`/api/assets/${id}/screenshot`)).status, 404, 'another project cannot see it');
  assert.equal((await app.mk().get(`/api/assets/${id}/screenshot`)).status, 401);
});

test('BLANK PAGE (HTTP 200 but nothing displayed, JavaScript crashes) → down with the reason, alert text, screenshot; stays down on later HTTP checks; recovers when fixed', opts, async () => {
  page = 'blank'; const id = mk('blank-spa'); await runNow(id);
  const a = asset(id); assert.equal(a.last_status_code, 200, 'the server itself answers fine'); assert.equal(a.status, 'down');
  assert.match(a.status_reason, /loads \(HTTP 200\) but nothing is displayed: the screen is blank/); assert.match(a.status_reason, /JavaScript error: Failed to execute 'removeChild'/);
  const i = inc(id); assert.ok(i, 'incident opened'); assert.equal(i.severity, 'critical'); assert.equal(i.title, 'Page not displaying');
  assert.ok(db.all('SELECT type FROM incident_events WHERE incident_id=?', i.id).some((e) => e.type === 'alert_queued'), 'alert queued');
  const n = db.get("SELECT body FROM notifications WHERE incident_id=? AND channel='email'", i.id); const txt = JSON.parse(n.body).text; assert.match(txt, /is reachable but the page is NOT displaying/); assert.match(txt, /Status: PAGE BLANK \/ BROKEN/);
  assert.ok(fs.existsSync(screenshotFile(id)));
  // an ordinary HTTP check (which succeeds) must not flip it back to "operational"
  const { hydrate, processResult } = await import('../src/monitor.js'); await processResult(hydrate(asset(id)), { state: 'ok', statusCode: 200, responseMs: 20 });
  assert.equal(asset(id).status, 'down', 'still down while the page is blank');
  page = 'good'; await runNow(id);
  assert.equal(db.get('SELECT status FROM incidents WHERE id=?', i.id).status, 'resolved'); assert.equal(asset(id).status, 'operational'); assert.equal(asset(id).status_reason, null); assert.equal(state(id).render.state, 'ok');
});

test('explains the cause: a data request blocked by CORS (like the real ruknalharir.com case)', opts, async () => {
  page = 'cors'; const id = mk('cors-site'); await runNow(id);
  assert.equal(asset(id).status, 'down'); assert.match(asset(id).status_reason, /nothing is displayed/); assert.match(asset(id).status_reason, /blocked by CORS/); assert.match(asset(id).status_reason, /api\/settings/);
});

test('a framework error page that "loads fine" is caught; an image-only page is NOT mistaken for blank', opts, async () => {
  page = 'error'; const id = mk('error-page'); await runNow(id); assert.equal(asset(id).status, 'down'); assert.match(asset(id).status_reason, /shows an error message instead of the site.*client-side exception/);
  page = 'hidden'; const idh = mk('invisible-text'); await runNow(idh); assert.equal(asset(idh).status, 'down', 'text exists but is invisible (white on white): a visitor sees a blank page'); assert.match(asset(idh).status_reason, /only invisible text/); assert.ok(state(idh).render.painted_pixels < 80);
  page = 'tiny'; const id3 = mk('tiny-static'); await runNow(id3); assert.equal(asset(id3).status, 'operational', 'a deliberately tiny static page is not flagged'); assert.ok(state(id3).render.painted_pixels > 80);
  page = 'svg'; const id2 = mk('graphic-page'); await runNow(id2); assert.equal(asset(id2).status, 'operational', 'visible graphics count as displayed'); assert.equal(state(id2).render.media >= 1, true);
});

test('a slow-drawing single-page app (like YouTube) is NOT flagged blank when given time; the same page IS flagged if patience runs out', opts, async () => {
  page = 'slow'; config.renderWaitMs = 8000; const id = mk('slow-app'); await runNow(id);
  assert.equal(asset(id).status, 'operational', 'content appeared after 2.5 s'); assert.ok(state(id).render.textLen > 20); assert.equal(inc(id), undefined);
  config.renderWaitMs = 600; const id2 = mk('impatient'); await runNow(id2); assert.equal(asset(id2).status, 'down', 'with too little patience the page is still empty'); config.renderWaitMs = 1500;
});

test('JSON / plain-text endpoints are not browser-checked (nothing to render)', opts, async () => {
  const J = await targetServer({ '*': (_q, res) => { res.setHeader('content-type', 'application/json'); res.end('{"ok":1}'); } });
  const id = addAsset(db, S.projA, { name: 'json-health', target: J.url + '/', verify_failures: 1, config: {} }); await runNow(id);
  assert.equal(asset(id).status, 'operational'); assert.match(state(id).render.skipped, /not an HTML page/); await J.close();
});

test('can be switched off per site and globally; a server that is already down is not browser-checked', opts, async () => {
  page = 'blank'; const off = mk('off-site', { render_check: false }); await runNow(off); assert.equal(asset(off).status, 'operational'); assert.equal(state(off).render, undefined, 'no browser check ran');
  config.renderEnabled = false; const off2 = mk('global-off'); await runNow(off2); assert.equal(state(off2).render, undefined); config.renderEnabled = true;
  const dead = addAsset(db, S.projA, { name: 'dead', target: 'http://127.0.0.1:1/', verify_failures: 1, config: {} }); await runNow(dead); assert.equal(asset(dead).status, 'down'); assert.equal(state(dead).render, undefined, 'HTTP failure is reported as it is; no browser needed');
});

test('form field + API keep the render settings (on by default, interval validated)', opts, async () => {
  const c = app.mk(); await c.login('super@t.io', S.password); page = 'good';
  const r = await c.post('/api/assets', { project_id: S.projA, type: 'website', name: 'cfg', target: T.url + '/cfg', config: { render_check: false, render_interval_min: 9999 } }); assert.equal(r.status, 200, r.text);
  const cfg = JSON.parse(db.get('SELECT config FROM assets WHERE id=?', r.json.id).config); assert.equal(cfg.render_check, false); assert.equal(cfg.render_interval_min, 120, 'clamped to 2 hours');
});

test('AUTO-RECOVERY for a blank page: the next automatic check is within a minute (not the 15-minute interval), and it recovers on that check', opts, async () => {
  page = 'blank'; const id = addAsset(db, S.projA, { name: 'blank-slow', target: T.url + '/', interval_sec: 900, verify_failures: 2, recover_successes: 1, config: {} }); await runNow(id);
  assert.equal(asset(id).status, 'down'); const wait = asset(id).next_run_at - Date.now(); assert.ok(wait <= 62000 && wait > 0, `next check in ${Math.round(wait / 1000)}s`);
  page = 'good'; await runNow(id); assert.equal(asset(id).status, 'operational'); assert.ok(asset(id).next_run_at - Date.now() > 800000, 'back to the normal interval once healthy');
});
