// MongoDB Atlas storage. Each table is one collection; each row is one document whose _id is the row id.
// Interface used by db.js:  readAll(table) -> docs | write(ops) | close()
//   ops = [{ t: 'checks', id: 12, doc: {...} | null }]   (doc null = delete)
import { MongoClient } from 'mongodb';
import dns from 'node:dns';

try {
  // Use public DNS to prevent ISP querySrv EREFUSED errors on MongoDB SRV lookups
  dns.setServers(['8.8.8.8', '1.1.1.1']);
} catch {}

export function dbNameFromUri(uri) {
  try { const p = new URL(uri).pathname.replace(/^\//, ''); return p || 'time_global_monitor'; } catch { return 'time_global_monitor'; }
}

export async function openStore(uri) {
  if (uri.startsWith('memory://')) return (await import('./atlas-memory.js')).openMemoryStore(uri);
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000, appName: 'time-global-tech-monitor', retryWrites: true });
  try { await client.connect(); await client.db('admin').command({ ping: 1 }); }
  catch (e) { await client.close().catch(() => {}); throw new Error(`Cannot reach MongoDB Atlas: ${e.message}. Check the connection string in .env (MONGODB_URI), the database user's password, and that your IP address is allowed under Atlas > Network Access.`); }
  const dbo = client.db(dbNameFromUri(uri));
  return {
    kind: 'atlas', name: dbo.databaseName,
    async readAll(t) { return dbo.collection(t).find({}).toArray(); },
    async write(ops) {
      const by = new Map();
      for (const o of ops) {
        if (!by.has(o.t)) by.set(o.t, []);
        by.get(o.t).push(o.doc ? { replaceOne: { filter: { _id: o.id }, replacement: o.doc, upsert: true } } : { deleteOne: { filter: { _id: o.id } } });
      }
      for (const [t, list] of by) await dbo.collection(t).bulkWrite(list, { ordered: false });
    },
    async close() { await client.close(); },
  };
}
