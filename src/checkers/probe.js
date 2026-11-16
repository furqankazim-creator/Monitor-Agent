import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { guardedLookup, guardLiteral } from '../ssrf.js';

const MAX_BODY = 512 * 1024;

export function friendlyError(e) {
  const c = e && e.code;
  if (c === 'ENOTFOUND' || c === 'EAI_AGAIN') return 'DNS resolution failed';
  if (c === 'ECONNREFUSED') return 'Connection refused';
  if (c === 'ECONNRESET') return 'Connection reset by server';
  if (/^Timeout after/.test(e?.message || '')) return e.message;
  if (c === 'ETIMEDOUT' || c === 'ETIMEOUT' || /timeout/i.test(e?.message || '')) return 'Connection timeout';
  if (c === 'EHOSTUNREACH' || c === 'ENETUNREACH') return 'Host unreachable';
  if (c === 'ESSRF') return e.message;
  if (/CERT|SSL|TLS|self.signed|certificate/i.test(`${c} ${e?.message}`)) return `SSL error: ${c || e.message}`;
  return e?.message || 'Unknown error';
}

function once(u, o) {
  try { guardLiteral(u.hostname); } catch (error) { return Promise.resolve({ error, timings: {} }); }
  return new Promise((resolve) => {
    const t0 = performance.now(); const t = {}; let done = false;
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, { method: o.method, headers: o.headers, lookup: guardedLookup, agent: false, rejectUnauthorized: o.rejectUnauthorized !== false }, (res) => {
      t.ttfb = performance.now() - t0;
      let size = 0; const chunks = [];
      let cert = null;
      try { if (u.protocol === 'https:' && res.socket?.getPeerCertificate) { const c = res.socket.getPeerCertificate(); if (c && c.valid_to) cert = { validTo: Date.parse(c.valid_to), issuer: c.issuer?.O || c.issuer?.CN || null, subject: c.subject?.CN || null }; } } catch { /* ignore */ }
      res.on('data', (d) => { size += d.length; if (size <= MAX_BODY) chunks.push(d); });
      res.on('end', () => { t.total = performance.now() - t0; finish({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8'), size, timings: t, cert }); });
      res.on('error', (e) => finish({ error: e, timings: t }));
    });
    const timer = setTimeout(() => { const e = new Error(`Timeout after ${Math.round(o.timeout / 1000)}s`); e.code = 'ETIMEDOUT'; req.destroy(e); }, o.timeout);
    req.on('socket', (s) => {
      s.once('lookup', () => { t.dns = performance.now() - t0; });
      s.once('connect', () => { t.tcp = performance.now() - t0 - (t.dns || 0); t._c = performance.now() - t0; });
      s.once('secureConnect', () => { t.tls = performance.now() - t0 - (t._c || 0); });
    });
    req.on('error', (e) => finish({ error: e, timings: { ...t, total: performance.now() - t0 } }));
    if (o.body) req.write(o.body);
    req.end();
  });
}

/** Single HTTP(S) probe with manual redirect handling. Every hop is SSRF-checked via guardedLookup. */
export async function probe(url, { method = 'GET', headers = {}, body, timeout = 10000, followRedirects = true, maxRedirects = 5, rejectUnauthorized = true } = {}) {
  let u = new URL(url); let hops = 0; const start = performance.now();
  const h = { 'user-agent': 'TimeGlobalTechMonitor/1.0 (+uptime-check)', accept: '*/*', ...headers };
  for (;;) {
    const remaining = Math.max(500, timeout - (performance.now() - start));
    const r = await once(u, { method, headers: h, body, timeout: remaining, rejectUnauthorized });
    r.finalUrl = u.href; r.redirects = hops;
    if (r.error) return r;
    if (followRedirects && [301, 302, 303, 307, 308].includes(r.statusCode) && r.headers.location) {
      if (++hops > maxRedirects) { r.error = Object.assign(new Error(`Too many redirects (>${maxRedirects})`), { code: 'EREDIRECT' }); return r; }
      let next; try { next = new URL(r.headers.location, u); } catch { r.error = new Error('Invalid redirect location'); return r; }
      if (!['http:', 'https:'].includes(next.protocol)) { r.error = new Error('Redirect to unsupported protocol'); return r; }
      u = next; continue;
    }
    r.timings.total = performance.now() - start;
    return r;
  }
}

export const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const round = (n) => (n == null ? null : Math.round(n * 10) / 10);
export const timingsOut = (t) => ({ dns_ms: round(t.dns), tcp_ms: round(t.tcp), tls_ms: round(t.tls), ttfb_ms: round(t.ttfb), total_ms: round(t.total) });
