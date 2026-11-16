export const now = () => Date.now();
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const safeJson = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
export function log(level, msg, extra) {
  const line = { t: new Date().toISOString(), level, msg, ...(extra || {}) };
  (level === 'error' ? console.error : console.log)(JSON.stringify(line));
}
export const fmtDuration = (ms) => {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} second${s === 1 ? '' : 's'}`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'}`;
  const h = Math.floor(m / 60); const rm = m % 60;
  if (h < 48) return `${h}h ${rm}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
};
export const fmtTime = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
export function getPath(obj, p) {
  return String(p).split('.').filter(Boolean).reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
export function csvEscape(v) {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // spreadsheet formula injection guard
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export const toCsv = (rows, cols) => [cols.join(','), ...rows.map((r) => cols.map((c) => csvEscape(r[c])).join(','))].join('\n');
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
