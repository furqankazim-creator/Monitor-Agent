import { probe, sha, round, timingsOut, friendlyError } from './probe.js';

export function parseExpected(exp) {
  const list = Array.isArray(exp) ? exp : String(exp || '200').split(',').map((s) => s.trim());
  const out = [];
  for (const e of list) { const m = String(e).match(/^(\d{3})(?:-(\d{3}))?$/); if (m) out.push([+m[1], +(m[2] || m[1])]); }
  return out.length ? out : [[200, 299]];
}
export const statusOk = (code, ranges) => ranges.some(([a, b]) => code >= a && code <= b);
export const STATUS_TEXT = { 200: 'OK', 301: 'Redirect', 302: 'Redirect', 400: 'Bad request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Page not found', 429: 'Rate limited', 500: 'Internal server error', 502: 'Bad gateway', 503: 'Service unavailable', 504: 'Gateway timeout' };

export async function checkWebsite(asset) {
  const c = asset.config;
  const ranges = parseExpected(c.expected_status);
  const wantsRedirect = ranges.some(([a, b]) => a <= 302 && b >= 301);
  const r = await probe(asset.target, { timeout: asset.timeout_ms, followRedirects: c.follow_redirects !== false && !wantsRedirect, headers: c.headers || {} });
  const out = { detail: {} };
  if (r.error) {
    out.state = 'fail'; out.error = friendlyError(r.error); out.responseMs = round(r.timings?.total);
    out.detail = { ...timingsOut(r.timings || {}), error_code: r.error.code || null };
    return out;
  }
  out.statusCode = r.statusCode; out.size = r.size; out.responseMs = round(r.timings.total);
  out.detail = { ...timingsOut(r.timings), redirects: r.redirects, final_url: r.finalUrl };
  if (r.cert) { out.cert = r.cert; out.detail.cert_expires = r.cert.validTo; }
  if (!statusOk(r.statusCode, ranges)) {
    out.state = 'fail'; out.error = `HTTP ${r.statusCode}${STATUS_TEXT[r.statusCode] ? ' ' + STATUS_TEXT[r.statusCode] : ''} (expected ${c.expected_status || '200'})`;
    return out;
  }
  if (c.expected_content && !r.body.includes(c.expected_content)) { out.state = 'fail'; out.error = `Expected content not found: "${String(c.expected_content).slice(0, 60)}"`; out.category = 'content'; return out; }
  if (c.forbidden_content && r.body.includes(c.forbidden_content)) { out.state = 'fail'; out.error = `Error content detected: "${String(c.forbidden_content).slice(0, 60)}"`; out.category = 'content'; return out; }
  if (c.detect_content_change) out.contentHash = sha(r.body);
  const maxMs = c.max_response_ms || 2000; // slow threshold default 2000 ms
  out.state = out.responseMs > maxMs ? 'slow' : 'ok';
  if (out.state === 'slow') out.error = `Slow response: ${Math.round(out.responseMs)} ms (threshold ${maxMs} ms)`;
  return out;
}
