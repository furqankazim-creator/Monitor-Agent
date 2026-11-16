import { TMP } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const listen = (handler) => new Promise((resolve) => { const s = http.createServer(handler); s.listen(0, () => resolve({ s, port: s.address().port, close: () => new Promise((r) => s.close(r)) })); });
const startOnPort = (port, role = 'web') => new Promise((resolve) => { // async, so the stand-in server in THIS process can still answer the child's health question
  const c = spawn('node', ['src/server.js', `--role=${role}`], { cwd: ROOT, env: { ...process.env, PORT: String(port), DATA_DIR: TMP, ENCRYPTION_KEY: 'ab'.repeat(32), NODE_ENV: 'test' } });
  let stderr = ''; c.stderr.on('data', (d) => { stderr += d; }); const t = setTimeout(() => c.kill('SIGKILL'), 20000);
  c.on('exit', (status) => { clearTimeout(t); resolve({ status, stderr }); });
});

test('starting a second copy while the app is already running explains it plainly and exits (no stack trace)', async () => {
  const fake = await listen((_q, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ status: 'ok', db: true, scheduler_age_s: 1, dispatcher_age_s: 1, uptime_s: 5 })); });
  const r = await startOnPort(fake.port); await fake.close();
  assert.equal(r.status, 1); assert.match(r.stderr, /ALREADY RUNNING on port \d+/); assert.match(r.stderr, new RegExp(`http://localhost:${fake.port}`)); assert.match(r.stderr, /autostart-mac\.sh status/);
  assert.doesNotMatch(r.stderr, /EADDRINUSE|at Server\.setupListenHandle|node:events/, 'no scary stack trace');
});

test('if a DIFFERENT program holds the port, say so and suggest another port', async () => {
  const other = await listen((_q, res) => res.end('hello from another program'));
  const r = await startOnPort(other.port); await other.close();
  assert.equal(r.status, 1); assert.match(r.stderr, /already used by another program/); assert.match(r.stderr, /lsof -i :\d+/); assert.match(r.stderr, new RegExp(`PORT=${other.port + 1} npm start`)); assert.doesNotMatch(r.stderr, /ALREADY RUNNING/);
});
