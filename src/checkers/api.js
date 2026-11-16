import { probe, round, timingsOut, friendlyError } from './probe.js';
import { parseExpected, statusOk, STATUS_TEXT } from './website.js';
import { getPath } from '../util.js';

const oauthCache = new Map();
async function oauthToken(a, timeout) {
  const k = `${a.token_url}|${a.client_id}`; const c = oauthCache.get(k);
  if (c && c.exp > Date.now() + 30000) return c.token;
  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: a.client_id, client_secret: a.client_secret, ...(a.scope ? { scope: a.scope } : {}) }).toString();
  const r = await probe(a.token_url, { method: 'POST', body, timeout, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  if (r.error || r.statusCode >= 300) throw Object.assign(new Error(`OAuth token request failed (${r.error ? friendlyError(r.error) : 'HTTP ' + r.statusCode})`), { auth: true });
  const j = JSON.parse(r.body); if (!j.access_token) throw Object.assign(new Error('OAuth response had no access_token'), { auth: true });
  oauthCache.set(k, { token: j.access_token, exp: Date.now() + (j.expires_in || 300) * 1000 });
  return j.access_token;
}

export async function applyAuth(auth, headers, urlObj, timeout) {
  if (!auth || !auth.type || auth.type === 'none') return;
  if (auth.type === 'bearer') headers.authorization = `Bearer ${auth.token}`;
  else if (auth.type === 'basic') headers.authorization = 'Basic ' + Buffer.from(`${auth.username}:${auth.password}`).toString('base64');
  else if (auth.type === 'apikey') { if (auth.in === 'query') urlObj.searchParams.set(auth.name || 'api_key', auth.value); else headers[(auth.name || 'x-api-key').toLowerCase()] = auth.value; }
  else if (auth.type === 'oauth2') headers.authorization = `Bearer ${await oauthToken(auth, timeout)}`;
  else if (auth.type === 'custom') Object.assign(headers, auth.headers || {});
}

// Minimal JSON-schema subset: type, required, properties, items, enum, minimum, maximum.
export function validateSchema(v, s, path = '$') {
  const errs = []; if (!s) return errs;
  const t = Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v;
  if (s.type) { const ok = s.type === 'integer' ? Number.isInteger(v) : s.type === 'number' ? typeof v === 'number' : s.type === t; if (!ok) { errs.push(`${path}: expected ${s.type}, got ${t}`); return errs; } }
  if (s.enum && !s.enum.includes(v)) errs.push(`${path}: not in enum`);
  if (typeof v === 'number') { if (s.minimum != null && v < s.minimum) errs.push(`${path}: below minimum`); if (s.maximum != null && v > s.maximum) errs.push(`${path}: above maximum`); }
  if (t === 'object') { for (const k of s.required || []) if (!(k in v)) errs.push(`${path}.${k}: required field missing`); for (const [k, ps] of Object.entries(s.properties || {})) if (k in v) errs.push(...validateSchema(v[k], ps, `${path}.${k}`)); }
  if (t === 'array' && s.items) v.slice(0, 20).forEach((x, i) => errs.push(...validateSchema(x, s.items, `${path}[${i}]`)));
  return errs;
}

function runAssertion(a, json, text) {
  const val = a.path ? getPath(json, a.path) : text;
  const exp = a.value;
  switch (a.op) {
    case 'exists': return val !== undefined && val !== null;
    case 'eq': return String(val) === String(exp);
    case 'neq': return String(val) !== String(exp);
    case 'gt': return Number(val) > Number(exp);
    case 'lt': return Number(val) < Number(exp);
    case 'contains': return String(val ?? '').includes(String(exp));
    default: return false;
  }
}

export async function checkApi(asset, secret) {
  const c = asset.config; const out = { detail: {} };
  let u; try { u = new URL(asset.target); } catch { return { state: 'fail', error: 'Invalid URL' }; }
  const headers = { ...(c.headers || {}) }; let body = c.body;
  if (body && typeof body === 'object') { body = JSON.stringify(body); if (!headers['content-type'] && !headers['Content-Type']) headers['content-type'] = 'application/json'; }
  try { await applyAuth(secret, headers, u, asset.timeout_ms); } catch (e) { return { state: 'fail', error: e.message, category: 'auth', detail: { auth_failure: true } }; }
  const method = (c.method || 'GET').toUpperCase();
  const r = await probe(u.href, { method, headers, body: ['GET', 'HEAD'].includes(method) ? undefined : body, timeout: asset.timeout_ms, followRedirects: false });
  if (r.error) { out.state = 'fail'; out.error = friendlyError(r.error); out.responseMs = round(r.timings?.total); out.detail = timingsOut(r.timings || {}); return out; }
  out.statusCode = r.statusCode; out.size = r.size; out.responseMs = round(r.timings.total); out.detail = timingsOut(r.timings);
  const ranges = parseExpected(c.expected_status || '200');
  if (!statusOk(r.statusCode, ranges)) {
    out.state = 'fail';
    out.category = r.statusCode === 401 || r.statusCode === 403 ? 'auth' : r.statusCode === 429 ? 'ratelimit' : r.statusCode >= 500 ? 'server_error' : 'status';
    const label = { auth: 'Authentication failure', ratelimit: 'Rate limited', server_error: 'Server error', status: 'Unexpected status' }[out.category];
    out.error = `${label}: HTTP ${r.statusCode}${STATUS_TEXT[r.statusCode] ? ' ' + STATUS_TEXT[r.statusCode] : ''} (expected ${c.expected_status || '200'})`;
    return out;
  }
  const ct = String(r.headers['content-type'] || ''); let json;
  const fmt = c.response_format || (ct.includes('json') ? 'json' : ct.includes('xml') ? 'xml' : 'text');
  const problems = [];
  if (fmt === 'json') {
    try { json = JSON.parse(r.body); } catch { problems.push('Response is not valid JSON'); }
    if (json !== undefined) {
      for (const f of c.expected_fields || []) if (getPath(json, f) === undefined) problems.push(`Missing required field: ${f}`);
      if (c.schema) problems.push(...validateSchema(json, c.schema).slice(0, 5));
    }
  } else if (fmt === 'xml') {
    if (!/^\s*(<\?xml[^>]*\?>\s*)?<[a-zA-Z]/.test(r.body) || !/<\/[\w:.-]+>\s*$|\/>\s*$/.test(r.body)) problems.push('Response is not well-formed XML');
    for (const f of c.expected_fields || []) if (!new RegExp(`<${f}[\\s>/]`).test(r.body)) problems.push(`Missing required XML element: ${f}`);
  }
  for (const a of c.assertions || []) if (!runAssertion(a, json, r.body)) problems.push(`Assertion failed: ${a.path || 'body'} ${a.op} ${a.value ?? ''}`.trim());
  if (problems.length) { out.state = 'fail'; out.category = 'validation'; out.error = problems.slice(0, 3).join('; '); out.detail.validation = problems.slice(0, 10); return out; }
  const maxMs = c.max_response_ms || 2000;
  out.state = out.responseMs > maxMs ? 'slow' : 'ok';
  if (out.state === 'slow') out.error = `Slow response: ${Math.round(out.responseMs)} ms (threshold ${maxMs} ms)`;
  return out; // response bodies are intentionally NOT persisted
}
