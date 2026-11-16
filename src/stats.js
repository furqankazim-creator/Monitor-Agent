import { db } from './db.js';

/** Uptime from real scheduled checks. Monitoring gaps are excluded; only VERIFIED failures count as downtime. */
export function uptime(assetId, from, to = Date.now()) {
  const r = db.get(`SELECT SUM(state IN ('ok','slow')) AS up, SUM(state='fail' AND confirmed=1) AS down, SUM(kind='gap') AS gaps
    FROM checks WHERE asset_id=? AND ts>=? AND ts<=?`, assetId, from, to);
  const up = r.up || 0; const down = r.down || 0; const total = up + down;
  return { pct: total ? Math.round((up / total) * 10000) / 100 : null, checks: total, downChecks: down, gaps: r.gaps || 0 };
}
export function avgResponse(assetId, from, to = Date.now()) {
  const r = db.get("SELECT AVG(response_ms) AS a FROM checks WHERE asset_id=? AND ts>=? AND ts<=? AND state IN ('ok','slow') AND response_ms IS NOT NULL", assetId, from, to);
  return r.a == null ? null : Math.round(r.a * 10) / 10;
}
/** Verified downtime in ms: sum of incident windows of availability-class categories, clipped to the period. */
export function downtimeMs(assetId, from, to = Date.now()) {
  const rows = db.all("SELECT first_detected AS s, COALESCE(recovered_at, ?) AS e FROM incidents WHERE asset_id=? AND category IN ('availability','api_failure','database','agent','workflow','render') AND first_detected<=? AND COALESCE(recovered_at, ?)>=?", to, assetId, to, to, from);
  return rows.reduce((a, r) => a + Math.max(0, Math.min(r.e, to) - Math.max(r.s, from)), 0);
}
export function series(assetId, from, to, buckets = 60) {
  const step = Math.max(1000, Math.floor((to - from) / buckets));
  return db.all(`SELECT (ts-?)/? AS b, AVG(response_ms) AS ms, SUM(state='fail' AND confirmed=1) AS fails, COUNT(*) AS n, MIN(ts) AS ts
    FROM checks WHERE asset_id=? AND ts>=? AND ts<=? AND kind='check' GROUP BY b ORDER BY b`, from, step, assetId, from, to)
    .map((r) => ({ ts: r.ts, ms: r.ms == null ? null : Math.round(r.ms * 10) / 10, fails: r.fails, n: r.n }));
}
