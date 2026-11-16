import { db } from './db.js';
import { config } from './config.js';
import { sha256, randomToken } from './crypto.js';
import { HttpError } from './util.js';

export const COOKIE = 'tgt_session';
export const ROLE_LEVEL = { technician: 1, admin: 2, super_admin: 3 };

const parseCookies = (h) => Object.fromEntries(String(h || '').split(';').map((c) => c.trim().split(/=(.*)/s).slice(0, 2)).filter(([k]) => k));

export function sessionMiddleware(req, _res, next) {
  const tok = parseCookies(req.headers.cookie)[COOKIE];
  if (tok) {
    const s = db.get('SELECT s.*, u.id AS uid FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.active=1', sha256(tok), Date.now());
    if (s) { req.user = db.get('SELECT id,email,name,role,phone,timezone,totp_enabled FROM users WHERE id=?', s.user_id); req.sessionHash = s.token_hash; }
  }
  next();
}
export function createSession(res, userId, req) {
  const tok = randomToken(32); const exp = Date.now() + config.sessionHours * 3600000;
  db.run('INSERT INTO sessions(token_hash,user_id,created_at,expires_at,ip,user_agent) VALUES(?,?,?,?,?,?)', sha256(tok), userId, Date.now(), exp, req.ip, String(req.headers['user-agent'] || '').slice(0, 200));
  res.setHeader('Set-Cookie', `${COOKIE}=${tok}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${config.sessionHours * 3600}${config.cookieSecure ? '; Secure' : ''}`);
}
export const clearSession = (res) => res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);

// CSRF: cookies are SameSite=Strict AND state-changing requests must carry a custom header (not sendable cross-site without CORS preflight, which we never allow).
export function csrfGuard(req, _res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.path.startsWith('/api/agent/') || req.path.startsWith('/api/mobile/') || req.path === '/api/probe' || req.path.startsWith('/api/webhooks/')) return next(); // token-authenticated machine endpoints
  if (req.headers['x-requested-with'] !== 'tgt') return next(new HttpError(403, 'Missing CSRF header'));
  next();
}
export const requireAuth = (req, _res, next) => (req.user ? next() : next(new HttpError(401, 'Authentication required')));
export const requireRole = (min) => (req, _res, next) => {
  if (!req.user) return next(new HttpError(401, 'Authentication required'));
  if (ROLE_LEVEL[req.user.role] < ROLE_LEVEL[min]) return next(new HttpError(403, 'Insufficient permissions'));
  next();
};

// ---- tenant / project scoping ----
/** null = unrestricted (super admin). Otherwise array of project ids the user may see. */
export function visibleProjects(u) {
  if (u.role === 'super_admin') return null;
  const assigned = db.all('SELECT project_id FROM user_projects WHERE user_id=?', u.id).map((r) => r.project_id);
  return assigned;
}
export const canSeeProject = (u, pid) => { const v = visibleProjects(u); return v === null || v.includes(Number(pid)); };
export function scope(u, col = 'project_id') {
  const v = visibleProjects(u);
  if (v === null) return { sql: '1=1', params: [] };
  if (!v.length) return { sql: '0=1', params: [] };
  return { sql: `${col} IN (${v.map(() => '?').join(',')})`, params: v };
}

// ---- simple in-memory rate limiter ----
const buckets = new Map();
export function rateLimit(name, max, windowMs, keyFn = (r) => r.ip) {
  return (req, _res, next) => {
    const k = `${name}:${keyFn(req)}`; const t = Date.now(); let b = buckets.get(k);
    if (!b || b.reset < t) { b = { n: 0, reset: t + windowMs }; buckets.set(k, b); }
    if (++b.n > max) return next(new HttpError(429, 'Too many requests, slow down'));
    next();
  };
}
setInterval(() => { const t = Date.now(); for (const [k, b] of buckets) if (b.reset < t) buckets.delete(k); }, 60000).unref();
