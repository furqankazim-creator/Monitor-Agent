import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config, ROOT } from './config.js';
import { log } from './util.js';

const localFile = config.dbFile || path.join(config.dataDir, 'monitor.db');
// MongoDB Atlas mode: Atlas is the ONLY permanent database. The app works on a fast in-memory copy that is loaded from Atlas at start-up and
// every change is written back to Atlas within about a second (write-behind). Without MONGODB_URI the app uses the local SQLite file instead.
let atlas = null;
if (config.mongoUri) {
  try {
    atlas = await (await import('./atlas.js')).openStore(config.mongoUri);
  } catch (e) {
    log('warn', `MongoDB Atlas connection error (${e.message.split('\n')[0]}). Falling back to local SQLite database: ${localFile}`);
    atlas = null;
  }
}
const file = atlas ? `atlas:${atlas.name}` : localFile;
const raw = new DatabaseSync(atlas ? ':memory:' : file);
raw.exec(atlas ? 'PRAGMA foreign_keys=ON;' : 'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');

const cache = new Map();
const stmt = (sql) => { let s = cache.get(sql); if (!s) { s = raw.prepare(sql); cache.set(sql, s); } return s; };
const clean = (p) => p.map((x) => (x === undefined ? null : typeof x === 'boolean' ? +x : x));

export const db = {
  raw, file,
  get: (sql, ...p) => stmt(sql).get(...clean(p)),
  all: (sql, ...p) => stmt(sql).all(...clean(p)),
  run: (sql, ...p) => stmt(sql).run(...clean(p)),
  insert: (sql, ...p) => Number(stmt(sql).run(...clean(p)).lastInsertRowid),
  tx(fn) {
    raw.exec('BEGIN IMMEDIATE');
    try { const r = fn(); raw.exec('COMMIT'); return r; } catch (e) { raw.exec('ROLLBACK'); throw e; }
  },
};

export function migrate() {
  raw.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const dir = path.join(ROOT, 'migrations');
  const done = new Set(db.all('SELECT name FROM schema_migrations').map((r) => r.name));
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    if (done.has(f)) continue;
    // table rebuilds need FK enforcement off (PRAGMA cannot change inside a transaction); integrity is re-checked before commit
    raw.exec('PRAGMA foreign_keys=OFF');
    try {
      db.tx(() => {
        raw.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
        const bad = raw.prepare('PRAGMA foreign_key_check').all(); if (bad.length) throw new Error(`migration ${f} left ${bad.length} foreign-key violation(s)`);
        db.run('INSERT INTO schema_migrations VALUES (?,?)', f, Date.now());
      });
    } finally { raw.exec('PRAGMA foreign_keys=ON'); }
    log('info', `migration applied: ${f}`);
  }
}
export function backupTo(dest) { raw.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`); }

export const getSetting = (k, d = null) => { const r = db.get('SELECT value FROM settings WHERE key=?', k); return r ? r.value : d; };
export const setSetting = (k, v) => db.run('INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at', k, v, Date.now());
export function audit(user, action, entity, entityId, detail, ip) {
  db.run('INSERT INTO audit_log(ts,user_id,user_email,action,entity,entity_id,detail,ip) VALUES(?,?,?,?,?,?,?,?)', Date.now(), user?.id ?? null, user?.email ?? null, action, entity ?? null, entityId != null ? String(entityId) : null, detail ? String(detail).slice(0, 1000) : null, ip ?? null);
}
export function heartbeat(name, info) { db.run('INSERT INTO heartbeats(name,ts,info) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET ts=excluded.ts, info=excluded.info', name, Date.now(), info ? JSON.stringify(info) : null); }

/** Flush the write-ahead log into the main database file so monitor.db alone always contains everything that was saved. */
export function checkpoint(mode = 'PASSIVE') { if (atlas) return null; try { return raw.prepare(`PRAGMA wal_checkpoint(${mode})`).get(); } catch { return null; } }
export async function closeDb() {
  if (atlas) { clearInterval(flushTimer); await flushAtlas(true); await atlas.close().catch(() => {}); }
  else checkpoint('TRUNCATE');
  try { raw.close(); } catch { /* already closed */ }
}
if (!atlas) setInterval(() => checkpoint('PASSIVE'), 5 * 60 * 1000).unref(); // keep the main file current even if the process is killed hard

// ---------------------------------------------------------------- Atlas write-behind
export const usingAtlas = !!atlas;
const st = { connected: !!atlas, lastError: null, lastFlushAt: null, flushed: 0 };
let flushTimer = null; let flushing = false; let tables = [];
const colsOf = new Map();
const tableCols = (t) => { let c = colsOf.get(t); if (!c) { const info = raw.prepare(`PRAGMA table_info("${t}")`).all(); c = { names: info.map((i) => i.name), alias: info.filter((i) => i.pk).length === 1 && info.some((i) => i.pk === 1 && /^INTEGER$/i.test(i.type)) }; colsOf.set(t, c); } return c; };

export function atlasStatus() { return { enabled: !!atlas, database: atlas?.name ?? null, ...st, pending: atlas ? raw.prepare('SELECT COUNT(*) n FROM _chg').get().n : 0 }; }

/** Send every row that changed since the last flush to Atlas. Rows are read fresh, so many changes to one row cost one write. */
export async function flushAtlas(all = false) {
  if (!atlas || flushing) return;
  flushing = true;
  try {
    for (let round = 0; round < (all ? 1000 : 20); round++) {
      const batch = raw.prepare('SELECT seq, t, r FROM _chg ORDER BY seq LIMIT 3000').all(); if (!batch.length) break;
      const last = batch[batch.length - 1].seq; const seen = new Set(); const ops = [];
      for (const { t, r } of batch) {
        const k = `${t}\u0000${r}`; if (seen.has(k)) continue; seen.add(k);
        const row = raw.prepare(`SELECT rowid AS _rid, * FROM "${t}" WHERE rowid=?`).get(r);
        if (row) { const { _rid, ...rest } = row; ops.push({ t, id: r, doc: { _id: r, ...rest } }); } else ops.push({ t, id: r, doc: null });
      }
      await atlas.write(ops);
      raw.prepare('DELETE FROM _chg WHERE seq<=?').run(last); st.flushed += ops.length;
    }
    st.connected = true; st.lastError = null; st.lastFlushAt = Date.now();
  } catch (e) {
    if (st.connected || st.lastError !== e.message) log('error', `Atlas write failed, will retry (changes are kept and nothing is lost while the app stays running): ${e.message}`);
    st.connected = false; st.lastError = e.message;
  } finally { flushing = false; }
}

function insertDoc(t, d) {
  const c = tableCols(t); const { _id, ...rest } = d; const cols = Object.keys(rest).filter((k) => c.names.includes(k));
  const withRowid = !c.alias && _id !== undefined;
  const names = (withRowid ? ['rowid'] : []).concat(cols); const vals = (withRowid ? [_id] : []).concat(cols.map((k) => rest[k]));
  raw.prepare(`INSERT OR REPLACE INTO "${t}"(${names.map((n) => `"${n}"`).join(',')}) VALUES(${names.map(() => '?').join(',')})`).run(...clean(vals));
}

async function bootAtlas() {
  migrate();
  raw.exec('CREATE TABLE IF NOT EXISTS _chg (seq INTEGER PRIMARY KEY AUTOINCREMENT, t TEXT NOT NULL, r INTEGER NOT NULL)');
  tables = raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('schema_migrations','_chg')").all().map((r) => r.name);
  raw.exec('PRAGMA foreign_keys=OFF'); let loaded = 0;
  for (const t of tables) for (const d of await atlas.readAll(t)) { insertDoc(t, d); loaded++; }
  raw.exec('PRAGMA foreign_keys=ON');
  for (const t of tables) { // record which rows change, so only those are sent to Atlas
    raw.exec(`CREATE TRIGGER IF NOT EXISTS "_chg_i_${t}" AFTER INSERT ON "${t}" BEGIN INSERT INTO _chg(t,r) VALUES('${t}', NEW.rowid); END;
      CREATE TRIGGER IF NOT EXISTS "_chg_u_${t}" AFTER UPDATE ON "${t}" BEGIN INSERT INTO _chg(t,r) VALUES('${t}', OLD.rowid); INSERT INTO _chg(t,r) VALUES('${t}', NEW.rowid); END;
      CREATE TRIGGER IF NOT EXISTS "_chg_d_${t}" AFTER DELETE ON "${t}" BEGIN INSERT INTO _chg(t,r) VALUES('${t}', OLD.rowid); END;`);
  }
  if (!loaded && fs.existsSync(localFile)) await importLocalFile(localFile);
  log('info', `MongoDB Atlas connected: database "${atlas.name}", ${loaded} saved records loaded`);
  await flushAtlas(true);
  if (st.lastError) throw new Error(`Atlas is reachable but writing failed: ${st.lastError}`);
  flushTimer = setInterval(() => { flushAtlas().catch(() => {}); }, 1000); flushTimer.unref();
}

/** One-time move: Atlas is empty and an old local monitor.db exists, so copy everything across (the local file is left untouched as a backup). */
export async function importLocalFile(path0) {
  const old = new DatabaseSync(path0, { readOnly: true }); let n = 0;
  try {
    raw.exec('PRAGMA foreign_keys=OFF');
    for (const t of tables) {
      let rows; try { rows = old.prepare(`SELECT rowid AS _id, * FROM "${t}"`).all(); } catch { continue; }
      for (const r of rows) { insertDoc(t, { ...r }); n++; }
    }
    raw.exec('PRAGMA foreign_keys=ON');
  } finally { old.close(); }
  log('info', `copied ${n} records from the old local database (${path0}) into Atlas. The local file was left unchanged as a backup.`);
  return n;
}

if (atlas) await bootAtlas();
