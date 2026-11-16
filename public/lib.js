export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const state = { me: null, tz: 'UTC' };

export async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch('/api' + path, { method, headers: { 'X-Requested-With': 'tgt', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  if (r.status === 401 && !path.startsWith('/auth/login')) { window.dispatchEvent(new Event('tgt-logout')); throw new Error('Session expired'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
  if (method !== 'GET' && !path.startsWith('/auth/') && !/check-now|\/test|\/probe/.test(path)) window.dispatchEvent(new Event('tgt-saved')); // a change reached the database
  return j;
}
export function toast(msg, kind = '') { const t = document.createElement('div'); t.className = `toast ${kind}`; t.textContent = msg; $('#toasts').append(t); setTimeout(() => t.remove(), kind === 'err' ? 7000 : 3500); }
export const fail = (e) => toast(e.message || String(e), 'err');

export const dt = (ms) => (ms ? new Date(ms).toLocaleString('en-GB', { timeZone: state.tz, dateStyle: 'medium', timeStyle: 'medium' }) : '–');
export const ago = (ms) => { if (!ms) return 'never'; const s = Math.round((Date.now() - ms) / 1000); if (s < 5) return 'just now'; if (s < 60) return s + 's ago'; if (s < 3600) return Math.round(s / 60) + 'm ago'; if (s < 86400) return Math.round(s / 3600) + 'h ago'; return Math.round(s / 86400) + 'd ago'; };
export const dur = (ms) => { const s = Math.round(ms / 1000); if (s < 60) return s + 's'; const m = Math.round(s / 60); if (m < 60) return m + 'm'; const h = Math.floor(m / 60); if (h < 48) return `${h}h ${m % 60}m`; return `${Math.floor(h / 24)}d ${h % 24}h`; };
export const pct = (v) => (v == null ? 'n/a' : v + '%');
export const STATUS_LABEL = { operational: 'Operational', degraded: 'Degraded', slow: 'Slow', down: 'Down', unknown: 'Unknown', maintenance: 'Maintenance' };
export const pill = (s, label) => `<span class="pill ${esc(s)}">${esc(label || STATUS_LABEL[s] || s)}</span>`;
export const stat = (k, v, cls = '', sub = '') => `<div class="card stat ${cls}"><div class="k">${esc(k)}</div><div class="v" ${typeof v === 'number' ? `data-count="${v}"` : ''}>${esc(v)}</div>${sub ? `<div class="s">${esc(sub)}</div>` : ''}</div>`;
export const empty = (t, s = '') => `<div class="empty"><b>${esc(t)}</b>${esc(s)}</div>`;
const LV = { technician: 1, admin: 2, super_admin: 3 };
export const role = (min) => LV[state.me?.role] >= LV[min];

export function modal(title, bodyHtml, { onSubmit, submit = 'Save', wide = false, danger = false } = {}) {
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<form class="modal ${wide ? 'wide' : ''}"><div class="hdr"><h2 style="margin:0">${esc(title)}</h2><div class="sp"></div><button type="button" class="btn sm" data-close>✕</button></div><div class="mbody">${bodyHtml}</div>${onSubmit ? `<div class="row mt" style="justify-content:flex-end"><button type="button" class="btn" data-close>Cancel</button><button class="btn ${danger ? 'dng' : 'pri'}">${esc(submit)}</button></div>` : ''}</form>`;
  document.body.append(bg); const form = $('form', bg); const close = () => bg.remove();
  bg.addEventListener('click', (e) => { if (e.target === bg || e.target.closest('[data-close]')) close(); });
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); const btn = $('.btn.pri,.btn.dng', form); if (btn) btn.disabled = true;
    try { const r = await onSubmit(formData(form), form); if (r !== false) close(); } catch (er) { fail(er); } finally { if (btn) btn.disabled = false; }
  });
  return { el: form, close };
}
export function confirmBox(msg, onYes, { text = 'Confirm', danger = true } = {}) { return modal('Please confirm', `<p>${msg}</p>`, { submit: text, danger, onSubmit: async () => { await onYes(); } }); }
export function formData(form) {
  const o = {};
  for (const el of $$('[name]', form)) { if (el.type === 'radio') { if (el.checked) o[el.name] = el.value; continue; } let v = el.type === 'checkbox' ? el.checked : el.value; if (el.type === 'number') v = v === '' ? undefined : +v; o[el.name] = v; }
  return o;
}
export function field(f, val) {
  const v = val ?? f.def ?? ''; const id = `f_${f.k.replace(/\W/g, '_')}`; let inp;
  if (f.type === 'select') inp = `<select name="${f.k}" id="${id}">${f.options.map((o) => { const [ov, ol] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(ov)}" ${String(ov) === String(v) ? 'selected' : ''}>${esc(ol)}</option>`; }).join('')}</select>`;
  else if (f.type === 'textarea') inp = `<textarea name="${f.k}" id="${id}" placeholder="${esc(f.ph || '')}">${esc(typeof v === 'object' ? JSON.stringify(v, null, 2) : v)}</textarea>`;
  else if (f.type === 'checkbox') return `<div class="field chk"><input type="checkbox" name="${f.k}" id="${id}" ${v ? 'checked' : ''}><label for="${id}">${esc(f.label)}</label></div>`;
  else inp = `<input name="${f.k}" id="${id}" type="${f.type || 'text'}" value="${esc(v)}" placeholder="${esc(f.ph || '')}" ${f.req ? 'required' : ''} ${f.type === 'password' ? 'autocomplete="new-password"' : ''}>`;
  return `<div class="field"><label for="${id}">${esc(f.label)}${f.req ? ' *' : ''}</label>${inp}${f.help ? `<small>${esc(f.help)}</small>` : ''}</div>`;
}

// ---------- charts (inline SVG) ----------
export function lineChart(points, { w = 640, h = 150, color = '#3b82f6', unit = '', max = null, min = 0, fmt = (v) => Math.round(v) } = {}) {
  const pts = points.filter((p) => p.v != null);
  if (pts.length < 2) return `<div class="empty" style="padding:24px">Not enough data yet</div>`;
  const xs = pts.map((p) => p.t); const x0 = Math.min(...xs); const x1 = Math.max(...xs); const ys = pts.map((p) => p.v);
  const y1 = max ?? (Math.max(...ys) * 1.1 || 1); const y0 = min;
  const X = (t) => 36 + ((t - x0) / (x1 - x0 || 1)) * (w - 46); const Y = (v) => h - 20 - ((v - y0) / (y1 - y0 || 1)) * (h - 34);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.t).toFixed(1)},${Y(p.v).toFixed(1)}`).join('');
  const area = `${d}L${X(x1)},${h - 20}L${X(x0)},${h - 20}Z`; const long = x1 - x0 > 86400000 * 1.5;
  const tf = (t) => new Date(t).toLocaleString('en-GB', { timeZone: state.tz, hour: '2-digit', minute: '2-digit', day: long ? '2-digit' : undefined, month: long ? 'short' : undefined });
  const gid = 'g' + color.slice(1);
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" style="display:block"><defs><linearGradient id="${gid}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity=".35"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>
  ${[0, 0.5, 1].map((f) => `<line x1="36" x2="${w - 10}" y1="${Y(y0 + (y1 - y0) * f)}" y2="${Y(y0 + (y1 - y0) * f)}" stroke="#22304d"/><text x="2" y="${Y(y0 + (y1 - y0) * f) + 3}">${fmt(y0 + (y1 - y0) * f)}${unit}</text>`).join('')}
  <path d="${area}" fill="url(#${gid})"/><path d="${d}" fill="none" stroke="${color}" stroke-width="1.8"/><text x="36" y="${h - 4}">${tf(x0)}</text><text x="${w - 10}" y="${h - 4}" text-anchor="end">${tf(x1)}</text></svg>`;
}
export function barChart(data, { w = 640, h = 130, color = '#ef4444' } = {}) {
  if (!data.length) return `<div class="empty" style="padding:24px">No data in range</div>`;
  const m = Math.max(...data.map((d) => d.v), 1); const bw = (w - 20) / data.length;
  return `<svg viewBox="0 0 ${w} ${h}" width="100%">${data.map((d, i) => `<rect x="${10 + i * bw + 1}" y="${h - 20 - (d.v / m) * (h - 34)}" width="${Math.max(2, bw - 2)}" height="${(d.v / m) * (h - 34)}" fill="${color}" rx="2"><title>${esc(d.l)}: ${d.v}</title></rect>`).join('')}<text x="10" y="${h - 4}">${esc(data[0].l)}</text><text x="${w - 10}" y="${h - 4}" text-anchor="end">${esc(data.at(-1).l)}</text></svg>`;
}
export const usageBar = (v, [w, c]) => `<div class="bar"><i class="${v >= c ? 'c' : v >= w ? 'w' : ''}" style="width:${Math.min(100, v)}%"></i></div>`;
export const qs = (o) => Object.entries(o).filter(([, v]) => v !== '' && v != null).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

// ---------- motion helpers ----------
const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
export function countUp(root = document) {
  $$('[data-count]', root).forEach((el) => {
    const to = +el.dataset.count; if (!Number.isFinite(to) || reduced() || to === 0) return; const t0 = performance.now(); const d = 700;
    const tick = (t) => { const p = Math.min(1, (t - t0) / d); el.textContent = Math.round(to * (1 - Math.pow(1 - p, 3))); if (p < 1) requestAnimationFrame(tick); }; el.textContent = '0'; requestAnimationFrame(tick);
  });
}
export function spark(points, w = 92, h = 26) {
  const v = points.map((p) => p.v).filter((x) => x != null);
  if (v.length < 2) return `<span class="mut" style="font-size:11px">collecting…</span>`;
  const max = Math.max(...v) || 1; const min = Math.min(...v); const rng = max - min || 1; const step = (w - 2) / (points.length - 1);
  const pts = points.map((p, i) => [1 + i * step, p.v == null ? h - 2 : h - 3 - ((p.v - min) / rng) * (h - 8)]);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
  const last = points.at(-1); const cls = last?.state === 'fail' ? 'sp-bad' : last?.state === 'slow' ? 'sp-warn' : '';
  return `<svg class="spark ${cls}" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><path class="a" d="${d}L${w - 1},${h}L1,${h}Z"/><path class="l" d="${d}"/></svg>`;
}
export const skeleton = () => `<div class="skel big"></div><div class="grid cards" style="margin-top:16px">${'<div class="skel big"></div>'.repeat(5)}</div><div class="skel" style="height:260px;margin-top:16px"></div>`;
export function ring(pctVal, color) {
  const C = 2 * Math.PI * 56; const o = C * (1 - Math.max(0, Math.min(100, pctVal)) / 100);
  return `<div class="ring"><svg width="132" height="132" viewBox="0 0 132 132"><circle cx="66" cy="66" r="56" fill="none" stroke="#1b2a52" stroke-width="11"/><circle class="fg" cx="66" cy="66" r="56" fill="none" stroke="${color}" stroke-width="11" style="--c:${C.toFixed(1)};--o:${o.toFixed(1)}"/></svg><div class="num"><div>${Math.round(pctVal)}%<small>healthy</small></div></div></div>`;
}
