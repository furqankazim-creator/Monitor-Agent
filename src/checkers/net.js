import tls from 'node:tls';
import net from 'node:net';
import dns from 'node:dns';
import { guardedLookup, guardLiteral } from '../ssrf.js';
import { round, friendlyError } from './probe.js';

export function tcpExchange(host, port, { timeout = 5000, send = null, expectBytes = 1 } = {}) {
  try { guardLiteral(host); } catch (error) { return Promise.resolve({ error }); }
  return new Promise((resolve) => {
    const t0 = performance.now(); let done = false; let connectMs = null;
    const s = net.connect({ host, port, lookup: guardedLookup });
    const fin = (r) => { if (!done) { done = true; s.destroy(); resolve({ ...r, connectMs, totalMs: round(performance.now() - t0) }); } };
    s.setTimeout(timeout, () => fin({ error: Object.assign(new Error('Connection timeout'), { code: 'ETIMEDOUT' }) }));
    s.on('error', (e) => fin({ error: e }));
    s.on('connect', () => { connectMs = round(performance.now() - t0); if (send) s.write(send); else if (!expectBytes) fin({ data: Buffer.alloc(0) }); });
    s.on('data', (d) => fin({ data: d }));
  });
}

export function tlsInspect(host, port = 443, timeout = 8000) {
  try { guardLiteral(host); } catch (e) { return Promise.resolve({ error: e.message }); }
  return new Promise((resolve) => {
    const t0 = performance.now(); let done = false;
    const s = tls.connect({ host, port, servername: host, rejectUnauthorized: false, lookup: guardedLookup, timeout });
    const fin = (r) => { if (!done) { done = true; s.destroy(); resolve(r); } };
    s.on('timeout', () => fin({ error: 'Connection timeout' }));
    s.on('error', (e) => fin({ error: friendlyError(e) }));
    s.on('secureConnect', () => {
      const c = s.getPeerCertificate(true);
      if (!c || !c.valid_to) return fin({ error: 'No certificate presented' });
      const validTo = Date.parse(c.valid_to); const validFrom = Date.parse(c.valid_from);
      const mismatch = tls.checkServerIdentity(host, c);
      fin({ validFrom, validTo, daysLeft: Math.floor((validTo - Date.now()) / 86400000), issuer: c.issuer?.O || c.issuer?.CN || null, subject: c.subject?.CN || null, san: c.subjectaltname || null,
        authorized: s.authorized, authError: s.authorizationError || null, hostnameMismatch: mismatch ? mismatch.message : null, protocol: s.getProtocol(), ms: round(performance.now() - t0) });
    });
  });
}

export async function resolveDns(domain) {
  const r = dns.promises; const out = { a: [], aaaa: [], ns: [], mx: [] }; let err = null;
  await Promise.all([['a', 'resolve4'], ['aaaa', 'resolve6'], ['ns', 'resolveNs'], ['mx', 'resolveMx']].map(async ([k, fn]) => {
    try { const v = await r[fn](domain); out[k] = k === 'mx' ? v.map((x) => x.exchange).sort() : v.sort(); } catch (e) { if (k === 'a' || k === 'ns') err = err || e; }
  }));
  return { ...out, error: out.a.length || out.aaaa.length || out.ns.length ? null : (err ? friendlyError(err) : 'No DNS records') };
}

export async function rdapExpiry(domain) {
  try {
    const res = await fetch(`https://rdap.org/domain/${encodeURIComponent(domain)}`, { signal: AbortSignal.timeout(10000), headers: { accept: 'application/rdap+json' } });
    if (!res.ok) return { available: false, reason: `RDAP HTTP ${res.status}` };
    const j = await res.json();
    const ev = (j.events || []).find((e) => e.eventAction === 'expiration');
    return { available: !!ev, expiresAt: ev ? Date.parse(ev.eventDate) : null, status: j.status || [], reason: ev ? null : 'No expiration event published by registry' };
  } catch (e) { return { available: false, reason: `RDAP lookup failed: ${e.message}` }; }
}

// ---- database liveness (protocol-level, no credentials needed, no data read) ----
export async function checkDatabaseTarget(kind, host, port, timeout, password) {
  const t0 = performance.now();
  const defaults = { postgres: 5432, mysql: 3306, mariadb: 3306, redis: 6379, mongodb: 27017, other: port };
  port = port || defaults[kind];
  if (kind === 'redis') {
    const cmd = (password ? `*2\r\n$4\r\nAUTH\r\n$${Buffer.byteLength(password)}\r\n${password}\r\n` : '') + '*1\r\n$4\r\nPING\r\n';
    const r = await tcpExchange(host, port, { timeout, send: cmd });
    if (r.error) return { ok: false, error: friendlyError(r.error) };
    const txt = r.data.toString();
    if (/NOAUTH|WRONGPASS/.test(txt)) return { ok: false, error: 'Redis authentication required/failed', ms: r.totalMs };
    return /PONG/.test(txt) ? { ok: true, ms: r.totalMs, info: 'PING/PONG' } : { ok: false, error: `Unexpected Redis reply: ${txt.slice(0, 40).replace(/\r?\n/g, ' ')}`, ms: r.totalMs };
  }
  if (kind === 'postgres') {
    const r = await tcpExchange(host, port, { timeout, send: Buffer.from([0, 0, 0, 8, 4, 210, 22, 47]) }); // SSLRequest: server answers 'S' or 'N'
    if (r.error) return { ok: false, error: friendlyError(r.error) };
    return ['S', 'N'].includes(String.fromCharCode(r.data[0])) ? { ok: true, ms: r.totalMs, info: 'PostgreSQL protocol responding' } : { ok: false, error: 'Port open but not speaking PostgreSQL protocol', ms: r.totalMs };
  }
  if (kind === 'mysql' || kind === 'mariadb') {
    const r = await tcpExchange(host, port, { timeout });
    if (r.error) return { ok: false, error: friendlyError(r.error) };
    return r.data[4] === 10 ? { ok: true, ms: r.totalMs, info: 'MySQL handshake received' } : { ok: false, error: r.data[4] === 0xff ? 'MySQL server returned an error (host blocked / too many connections?)' : 'Port open but not speaking MySQL protocol', ms: r.totalMs };
  }
  const r = await tcpExchange(host, port, { timeout, expectBytes: 0 });
  return r.error ? { ok: false, error: friendlyError(r.error) } : { ok: true, ms: r.totalMs, info: 'TCP connect succeeded' };
}
