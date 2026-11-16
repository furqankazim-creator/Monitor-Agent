// Test-only stand-in for Atlas (MONGODB_URI=memory://name): same interface, kept in this process. Lets the test suite exercise the whole
// load / write-behind / restart path without a network. Never used in production.
const stores = new Map();
export function openMemoryStore(uri) {
  if (!stores.has(uri)) stores.set(uri, { cols: new Map(), fail: false });
  const s = stores.get(uri); const col = (t) => { if (!s.cols.has(t)) s.cols.set(t, new Map()); return s.cols.get(t); };
  return {
    kind: 'memory', name: uri, state: s,
    async readAll(t) { return [...col(t).values()].map((d) => structuredClone(d)); },
    async write(ops) { if (s.fail) throw new Error('simulated Atlas outage'); for (const o of ops) { if (o.doc) col(o.t).set(o.id, structuredClone(o.doc)); else col(o.t).delete(o.id); } },
    async close() {},
  };
}
export const memoryState = (uri) => stores.get(uri);
