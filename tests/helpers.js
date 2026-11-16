// Must be imported FIRST in every test file: it points the app at an isolated temp data dir.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgt-test-'));
process.env.DATA_DIR = dir;
process.env.MONGODB_URI = '';
process.env.ALLOW_PRIVATE_TARGETS = 'true';
process.env.ENCRYPTION_KEY = 'ab'.repeat(32);
process.env.NODE_ENV = 'test';
process.env.RENDER_CHECKS = 'off'; // the real-browser check has its own test file; keep the other suites fast
process.env.LOGIN_RATE_LIMIT = '1000'; // per-account lockout is still tested separately
process.env.BASE_URL = 'http://monitor.test';

export const TMP = dir;

/** Programmable HTTP target. routes: { '/path': (req,res)=>... } */
export function targetServer(routes = {}) {
  const state = { hits: 0, routes };
  const srv = http.createServer((req, res) => {
    state.hits++;
    const h = state.routes[req.url.split('?')[0]] || state.routes['*'];
    if (h) return h(req, res);
    res.setHeader('content-type', 'text/html'); res.end('<h1>Welcome Home</h1>');
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, state, port: srv.address().port, url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }) })));
}

/** Minimal real SMTP sink: accepts mail over TCP and records it. */
export function smtpSink() {
  const mails = [];
  const srv = net.createServer((s) => {
    let buf = ''; let data = false; let cur = { to: [], body: '' };
    s.write('220 sink ESMTP\r\n');
    s.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (data) { if (line === '.') { data = false; mails.push(cur); cur = { to: [], body: '' }; s.write('250 queued\r\n'); } else cur.body += line + '\n'; continue; }
        const u = line.toUpperCase();
        if (u.startsWith('EHLO') || u.startsWith('HELO')) s.write('250 sink\r\n');
        else if (u.startsWith('MAIL FROM')) s.write('250 ok\r\n');
        else if (u.startsWith('RCPT TO')) { cur.to.push(line.match(/<(.+)>/)?.[1]); s.write('250 ok\r\n'); }
        else if (u === 'DATA') { data = true; s.write('354 go\r\n'); }
        else if (u === 'QUIT') { s.write('221 bye\r\n'); s.end(); }
        else s.write('250 ok\r\n');
      }
    });
    s.on('error', () => {});
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ mails, port: srv.address().port, close: () => new Promise((r) => srv.close(r)) })));
}

export const closedPort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

/** HTTP client with cookie jar + CSRF header, against an in-process app. */
export async function startApp() {
  const { createApp } = await import('../src/server.js');
  const app = createApp(); const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const mk = () => {
    let cookie = '';
    const call = async (method, p, body, extra = {}) => {
      const r = await fetch(base + p, { method, headers: { ...(cookie ? { cookie } : {}), 'X-Requested-With': 'tgt', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...extra }, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
      const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
      const text = await r.text(); let json; try { json = JSON.parse(text); } catch { json = null; }
      return { status: r.status, json, text, headers: r.headers };
    };
    return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}), patch: (p, b) => call('PATCH', p, b ?? {}), del: (p, b) => call('DELETE', p, b ?? {}), raw: call, login: async (email, password) => { const r = await call('POST', '/api/auth/login', { email, password }); if (r.status !== 200) throw new Error('login failed ' + r.status + r.text); return r; } };
  };
  return { base, mk, close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }) };
}

export async function seed() {
  const { db, migrate } = await import('../src/db.js'); const { hashPassword } = await import('../src/crypto.js'); migrate();
  const now = Date.now(); const pw = hashPassword('Correct-Horse-Battery-9');
  const projA = db.insert('INSERT INTO projects(name,created_at) VALUES(?,?)', 'Project A', now); const projB = db.insert('INSERT INTO projects(name,created_at) VALUES(?,?)', 'Project B', now);
  const U = (email, role) => db.insert('INSERT INTO users(email,name,password_hash,role,created_at) VALUES(?,?,?,?,?)', email, email.split('@')[0], pw, role, now);
  const users = { super: U('super@t.io', 'super_admin'), adminA: U('adminA@t.io', 'admin'), techA: U('techA@t.io', 'technician'), adminB: U('adminB@t.io', 'admin') };
  db.run('INSERT INTO user_projects VALUES(?,?)', users.adminA, projA); db.run('INSERT INTO user_projects VALUES(?,?)', users.techA, projA); db.run('INSERT INTO user_projects VALUES(?,?)', users.adminB, projB);
  return { db, projA, projB, users, password: 'Correct-Horse-Battery-9' };
}

export function addAsset(db, projectId, o) {
  return db.insert(`INSERT INTO assets(project_id,type,name,target,config,interval_sec,timeout_ms,criticality,verify_failures,recover_successes,retry_delay_sec,secret_enc,next_run_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    projectId, o.type || 'website', o.name || 'asset', o.target, JSON.stringify(o.config || {}), o.interval_sec || 60, o.timeout_ms || 3000, o.criticality || 'normal', o.verify_failures ?? 2, o.recover_successes ?? 2, 1, o.secret_enc || null, o.next_run_at ?? Date.now() + 3600000, Date.now());
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function waitFor(fn, ms = 8000, step = 100) { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('waitFor timed out'); await sleep(step); } }
