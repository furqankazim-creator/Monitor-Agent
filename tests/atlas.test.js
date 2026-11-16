import './helpers.js';
import os from 'node:os';
import nodePath from 'node:path';
import nodeFs from 'node:fs';
const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'atlas-'));
import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryState } from '../src/atlas-memory.js';

// MongoDB Atlas mode, using the in-process stand-in store. Proves: changes are written to the store, a restart loads them back with the same ids,
// updates/deletes (including cascades) are mirrored, an outage queues changes and loses nothing, and an old SQLite file is imported once.
process.env.MONGODB_URI = 'memory://t1';
const { config } = await import('../src/config.js'); config.mongoUri = 'memory://t1';
const A = await import('../src/db.js?first');
const st = () => memoryState('memory://t1');
const docs = (t) => [...(st().cols.get(t)?.values() ?? [])];

test('boots empty on Atlas mode and creates the schema', () => {
  assert.equal(A.usingAtlas, true); assert.equal(A.db.get('SELECT COUNT(*) n FROM users').n, 0);
});

test('every insert / update / delete reaches Atlas', async () => {
  const id = A.db.insert("INSERT INTO users(email,name,password_hash,role,created_at) VALUES('a@t.io','A','x','super_admin',1)");
  const pid = A.db.insert("INSERT INTO projects(name,created_at) VALUES('P1',1)");
  A.db.run('INSERT INTO user_projects(user_id,project_id) VALUES(?,?)', id, pid);
  A.db.run("INSERT INTO settings(key,value,updated_at) VALUES('k','v1',1)"); A.db.run("UPDATE settings SET value='v2' WHERE key='k'");
  await A.flushAtlas(true);
  assert.equal(docs('users').length, 1); assert.equal(docs('users')[0].email, 'a@t.io'); assert.equal(docs('users')[0]._id, id);
  assert.equal(docs('projects')[0].name, 'P1'); assert.equal(docs('user_projects').length, 1, 'tables without an id are saved too');
  assert.equal(docs('settings')[0].value, 'v2', 'the latest value is what is stored');
  A.db.run('DELETE FROM projects WHERE id=?', pid); await A.flushAtlas(true);
  assert.equal(docs('projects').length, 0, 'deleted rows are removed'); assert.equal(docs('user_projects').length, 0, 'cascaded deletes are removed too');
  assert.equal(A.atlasStatus().pending, 0);
});

test('a restart loads everything back from Atlas with the same ids', async () => {
  const pid = A.db.insert("INSERT INTO projects(name,created_at) VALUES('Keep',2)");
  const aid = A.db.insert("INSERT INTO assets(project_id,type,name,target,created_at) VALUES(?,?,?,?,?)", pid, 'website', 'Site', 'https://example.com', 5);
  A.db.run('INSERT INTO checks(asset_id,ts,state) VALUES(?,?,?)', aid, 10, 'ok'); A.db.run("INSERT INTO metrics(asset_id,ts,name,value) VALUES(?,?,?,?)", aid, 10, 'cpu', 1.5);
  await A.closeDb();
  const B = await import('../src/db.js?second');
  assert.equal(B.db.get('SELECT name FROM projects WHERE id=?', pid).name, 'Keep'); assert.equal(B.db.get('SELECT target FROM assets WHERE id=?', aid).target, 'https://example.com');
  assert.equal(B.db.get('SELECT COUNT(*) n FROM checks WHERE asset_id=?', aid).n, 1); assert.equal(B.db.get('SELECT value FROM metrics WHERE name=?', 'cpu').value, 1.5);
  assert.equal(B.db.get("SELECT value FROM settings WHERE key='k'").value, 'v2'); assert.equal(B.db.get('SELECT COUNT(*) n FROM users').n, 1);
  assert.equal(B.atlasStatus().pending, 0, 'loading from Atlas does not re-send everything');
  const nid = B.db.insert("INSERT INTO projects(name,created_at) VALUES('Next',3)"); assert.ok(nid > pid, 'new ids continue after the loaded ones');
  await B.closeDb();
});

test('while Atlas is down changes are queued, then saved when it comes back', async () => {
  const C = await import('../src/db.js?third');
  st().fail = true; C.db.run("INSERT INTO settings(key,value,updated_at) VALUES('during-outage','1',1)");
  await C.flushAtlas(true); assert.equal(C.atlasStatus().connected, false); assert.ok(C.atlasStatus().pending > 0);
  assert.equal(C.db.get("SELECT value FROM settings WHERE key='during-outage'").value, '1', 'the app keeps working');
  st().fail = false; await C.flushAtlas(true);
  assert.equal(C.atlasStatus().connected, true); assert.equal(C.atlasStatus().pending, 0); assert.ok(docs('settings').some((d) => d.key === 'during-outage'));
  await C.closeDb();
});

test('an old local monitor.db is copied into an empty Atlas once', async () => {
  const { DatabaseSync } = await import('node:sqlite'); const path = await import('node:path'); const fs = await import('node:fs');
  const f = path.join(dir, 'old.db'); fs.rmSync(f, { force: true });
  // build an old-style file with the real schema by running the migrations into a scratch database
  const o = new DatabaseSync(f); for (const m of fs.readdirSync('migrations').sort()) o.exec(fs.readFileSync(path.join('migrations', m), 'utf8'));
  o.exec("INSERT INTO projects(id,name,created_at) VALUES(7,'Old project',1); INSERT INTO assets(id,project_id,type,name,target,created_at) VALUES(9,7,'website','Old site','https://old.example',1);"); o.close();
  process.env.MONGODB_URI = 'memory://t2'; config.mongoUri = 'memory://t2'; config.dbFile = f;
  const D = await import('../src/db.js?fourth');
  assert.equal(D.db.get('SELECT name FROM assets WHERE id=9').name, 'Old site');
  await D.flushAtlas(true); assert.equal([...(memoryState('memory://t2').cols.get('assets')?.values() ?? [])].length, 1, 'copied into Atlas');
  await D.closeDb();
});
