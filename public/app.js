import { $, $$, esc, state, api, toast, fail, dt, ago, dur, pct, pill, stat, empty, role, modal, confirmBox, field, lineChart, barChart, usageBar, qs, STATUS_LABEL, countUp, spark, skeleton, ring } from './lib.js';
import { assetForm, TYPE_META, showAgentInstall } from './assetform.js';
import { pageProjects, pageIncidents, pageIncident, pageAlerts, pageAnalytics, pageReports, pageTeam, pageIntegrations, pageSettings } from './pages.js';

const NAV = [
  ['overview', 'Overview', 'M3 12l9-9 9 9M5 10v10h5v-6h4v6h5V10', 'technician'], ['projects', 'Projects', 'M3 7h18M3 12h18M3 17h18', 'technician'], ['websites', 'Websites', 'M12 22a10 10 0 100-20 10 10 0 000 20zM2 12h20M12 2a15 15 0 010 20M12 2a15 15 0 000 20', 'technician'],
  ['applications', 'Applications', 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z', 'technician'], ['apis', 'APIs', 'M8 6l-6 6 6 6M16 6l6 6-6 6', 'technician'],
  ['servers', 'Servers', 'M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01', 'technician'], ['databases', 'Databases', 'M12 8c4.4 0 8-1.3 8-3s-3.6-3-8-3-8 1.3-8 3 3.6 3 8 3zM4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5', 'technician'],
  ['domains', 'Domains & SSL', 'M12 2l8 4v6c0 5-3.4 8.7-8 10-4.6-1.3-8-5-8-10V6z', 'technician'], ['incidents', 'Incident Center', 'M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z', 'technician'],
  ['alerts', 'Alerts', 'M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 01-3.4 0', 'admin'], ['analytics', 'Analytics', 'M18 20V10M12 20V4M6 20v-6', 'technician'],
  ['reports', 'Reports', 'M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8zM14 2v6h6M8 13h8M8 17h8', 'technician'], ['team', 'Team Management', 'M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8M22 21v-2a4 4 0 00-3-3.9M16 3.1a4 4 0 010 7.8', 'technician'],
  ['integrations', 'Integrations', 'M10 13a5 5 0 007.5.5l3-3a5 5 0 00-7-7l-1.7 1.7M14 11a5 5 0 00-7.5-.5l-3 3a5 5 0 007 7l1.7-1.7', 'admin'], ['settings', 'Settings', 'M12 15a3 3 0 100-6 3 3 0 000 6M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1A1.7 1.7 0 004.6 9a1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z', 'technician'],
];
const GROUP_PAGES = { websites: ['Websites', 'website', ['website']], applications: ['Applications', 'webapp', ['webapp', 'mobile']], apis: ['APIs', 'api', ['api']], servers: ['Servers', 'server', ['server']], databases: ['Databases', 'database', ['database']], domains: ['Domains & SSL', 'domain', ['domain', 'ssl']] };
const root = () => $('#app');
let refreshTimer = null; let currentRefresh = null; let sse = null;

// ---------------- boot / auth ----------------
async function boot() {
  try { const { user } = await api('/auth/me'); state.me = user; state.tz = user.timezone && user.timezone !== 'UTC' ? user.timezone : Intl.DateTimeFormat().resolvedOptions().timeZone; known = null; shell(); route(); connectSse(); checkAlerts(); checkEngine(); refreshSecurity(); clearInterval(window.__alertPoll); window.__alertPoll = setInterval(() => { checkAlerts(); checkEngine(); }, 20000); }
  catch { login(); }
}
function login(needTotp = false, creds = {}) {
  if (sse) { sse.close(); sse = null; }
  root().innerHTML = `<div class="login"><form class="card" id="lf"><div class="brand" style="border:0"><div class="logo"><svg width="20" height="20" viewBox="0 0 32 32"><path d="M3 17h6l3-9 6 16 3-9h8" stroke="#22c55e" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></div><div><b>TIME GLOBAL TECH<br>MONITOR</b></div></div>
  <svg class="pulse-line" width="100%" height="34" viewBox="0 0 260 34" preserveAspectRatio="none"><path d="M0 18h70l10-14 14 28 12-22 8 8h146"/></svg><p>Monitor Everything. Detect Instantly. Stay Operational.</p>
  <div class="field"><label>Email</label><input name="email" type="email" required autocomplete="username" value="${esc(creds.email || '')}"></div>
  <div class="field"><label>Password</label><input name="password" type="password" required autocomplete="current-password" value="${esc(creds.password || '')}"></div>
  ${needTotp ? '<div class="field"><label>Two-factor code</label><input name="totp" inputmode="numeric" maxlength="6" autofocus autocomplete="one-time-code"></div>' : ''}
  <div id="lerr"></div><button class="btn pri" style="width:100%">Sign in</button></form></div>`;
  $('#lf').addEventListener('submit', async (e) => {
    e.preventDefault(); const f = Object.fromEntries(new FormData(e.target));
    try { const r = await api('/auth/login', { method: 'POST', body: f }); if (r.needs_totp) return login(true, f); await boot(); } catch (er) { $('#lerr').innerHTML = `<div class="err-box" style="margin-bottom:10px">${esc(er.message)}</div>`; }
  });
}
let savedTimer = null; window.addEventListener('tgt-saved', () => { const s = $('#saved'); if (!s) return; s.classList.add('on'); clearTimeout(savedTimer); savedTimer = setTimeout(() => s.classList.remove('on'), 2600); });
window.addEventListener('tgt-logout', () => { known = null; clearInterval(window.__alertPoll); login(); });

function shell() {
  const items = NAV.filter((n) => role(n[3]));
  root().innerHTML = `<div class="layout"><aside class="side" id="side"><div class="brand"><div class="logo"><svg width="18" height="18" viewBox="0 0 32 32"><path d="M3 17h6l3-9 6 16 3-9h8" stroke="#22c55e" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></div><div><b>TIME GLOBAL TECH<br>MONITOR</b></div></div>
  <nav class="nav">${items.map(([id, label, d]) => `<a href="#/${id}" data-nav="${id}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>${esc(label)}${id === 'incidents' ? '<span class="pill critical badge" id="incbadge" style="display:none"></span>' : ''}</a>`).join('')}</nav>
  <div style="padding:14px 10px;color:var(--dim);font-size:11px">Monitor Everything.<br>Detect Instantly.<br>Stay Operational.</div></aside>
  <div class="main"><div class="top"><button class="btn sm menu-btn" data-act="menu">☰</button><div class="live"><span class="dot ok" id="livedot"></span><span id="livetxt">Live</span></div><span class="saved" id="saved">✓ Saved</span>${role('admin') ? '<form class="quick" data-quick><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg><input name="url" placeholder="Paste a website or API address to monitor…" autocomplete="off" spellcheck="false"><button class="btn pri sm">Add</button></form>' : ''}<div class="sp"></div>
  <button class="btn ghost icon" id="bell" data-act="bell" title="Alert settings"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 01-3.4 0"/></svg><span class="bellbadge" id="bellbadge" style="display:none"></span></button><span class="mut">${esc(state.me.name)} · <span class="pill">${esc(state.me.role.replace('_', ' '))}</span></span><button class="btn sm" data-act="logout">Sign out</button></div><div id="alertbar"></div><div class="content" id="page"></div></div></div>`;
}
document.addEventListener('submit', async (e) => {
  const f = e.target.closest('[data-quick]'); if (!f) return; e.preventDefault();
  const input = $('input[name=url]', f); const btn = $('button', f); const url = input.value.trim(); if (!url) return input.focus();
  btn.disabled = true; btn.textContent = 'Checking…';
  try {
    const r = await api('/quick-add', { method: 'POST', body: { url } }); input.value = '';
    toast(r.status === 'operational' ? `✓ ${r.name} is up (${Math.round(r.last_response_ms ?? 0)} ms). Now monitored every 60s.` : `${r.name} added: status ${r.status}${r.status_reason ? ' – ' + r.status_reason : ''}`, r.status === 'operational' ? 'ok' : 'err');
    location.hash = `#/asset/${r.id}`;
  } catch (er) { fail(er); } finally { btn.disabled = false; btn.textContent = 'Add'; }
});
document.addEventListener('click', async (e) => {
  const a = e.target.closest('[data-act]'); if (!a) return;
  if (a.dataset.act === 'logout') { await api('/auth/logout', { method: 'POST' }).catch(() => {}); state.me = null; known = null; clearInterval(window.__alertPoll); document.title = baseTitle; login(); }
  if (a.dataset.act === 'menu') $('#side').classList.toggle('open');
});
function connectSse() {
  if (sse) sse.close(); sse = new EventSource('/api/stream');
  sse.onopen = () => { $('#livedot')?.classList.add('ok'); const t = $('#livetxt'); if (t) t.textContent = 'Live'; };
  sse.onerror = () => { $('#livedot')?.classList.remove('ok'); const t = $('#livetxt'); if (t) t.textContent = 'Reconnecting…'; };
  let pending = null; sse.onmessage = () => { clearTimeout(pending); pending = setTimeout(() => { currentRefresh?.(); updateBadge(); checkAlerts(); }, 500); };
}
async function updateBadge() { try { const r = await api('/incidents?view=active&page_size=1'); const b = $('#incbadge'); if (b) { b.textContent = r.counts.critical || ''; b.style.display = r.counts.critical ? '' : 'none'; } } catch { /* ignore */ } }


// ---------------- live alerts: banner + sound + browser notification + tab title ----------------
const prefs = (() => { try { return { sound: true, notify: false, ...JSON.parse(localStorage.getItem('tgt_alert_prefs') || '{}') }; } catch { return { sound: true, notify: false }; } })();
const savePrefs = () => { try { localStorage.setItem('tgt_alert_prefs', JSON.stringify(prefs)); } catch { /* ignore */ } };
let known = null; let flashTimer = null; const baseTitle = document.title; let audioCtx = null;
function beep(kind = 'down') {
  if (!prefs.sound) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); audioCtx.resume?.();
    const tones = kind === 'down' ? [[880, 0], [660, 0.22], [880, 0.44]] : [[523, 0], [784, 0.18]];
    for (const [f, t] of tones) { const o = audioCtx.createOscillator(); const g = audioCtx.createGain(); o.type = 'sine'; o.frequency.value = f; g.gain.setValueAtTime(0.0001, audioCtx.currentTime + t); g.gain.exponentialRampToValueAtTime(0.25, audioCtx.currentTime + t + 0.03); g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + t + 0.2); o.connect(g).connect(audioCtx.destination); o.start(audioCtx.currentTime + t); o.stop(audioCtx.currentTime + t + 0.22); }
  } catch { /* audio blocked until the user interacts with the page */ }
}
function systemNotify(title, body, tag) {
  if (!prefs.notify || !('Notification' in window) || Notification.permission !== 'granted') return;
  try { const n = new Notification(title, { body, tag, requireInteraction: tag.startsWith('inc-') }); n.onclick = () => { window.focus(); location.hash = '#/incident/' + tag.slice(4); n.close(); }; } catch { /* ignore */ }
}
function updateTitle() {
  const downs = $$('.alertbanner.down').length; clearInterval(flashTimer);
  if (!downs) { document.title = baseTitle; return; }
  let on = false; flashTimer = setInterval(() => { on = !on; document.title = on ? `🔴 ${downs} DOWN – ${baseTitle}` : `⚠ Check your monitors – ${baseTitle}`; }, 1000);
}
function bellBadge(n) { const b = $('#bellbadge'); if (b) { b.textContent = n; b.style.display = n ? '' : 'none'; } }
function headline(i) {
  if (i.category === 'availability') return `Your website ${i.asset_name} is DOWN`;
  if (i.category === 'api_failure') return `Your API ${i.asset_name} is failing`;
  if (i.category === 'agent') return `Server ${i.asset_name} is OFFLINE`;
  if (i.category === 'database') return `Database ${i.asset_name} is unavailable`;
  return `${i.asset_name}: ${i.title}`;
}
function showAlert(i) {
  const loud = ['critical', 'high', 'medium'].includes(i.severity); const text = headline(i);
  if (loud) {
    const el = document.createElement('div'); el.className = `alertbanner down ${i.severity}`; el.dataset.inc = i.id;
    el.innerHTML = `<span class="dot down"></span><div class="at"><b>${esc(text)}</b><span>${esc(i.description || i.title)} · ${esc(i.code)} · detected ${esc(ago(i.first_detected))}</span></div><a class="btn sm" href="#/incident/${i.id}">View incident</a><button class="btn sm ghost" data-dismiss="${i.id}">Dismiss</button>`;
    $('#alertbar')?.prepend(el); beep('down'); updateTitle();
  }
  toast(`${loud ? '🔴 ' : '⚠ '}${text}`, 'err'); systemNotify(text, `${i.description || i.title} (${i.code})`, 'inc-' + i.id);
}
function showRecovered(i) {
  $$(`.alertbanner[data-inc="${i.id}"]`).forEach((b) => b.remove()); updateTitle();
  toast(`✓ ${i.asset_name} has recovered`, 'ok'); beep('up'); systemNotify(`Recovered: ${i.asset_name}`, 'Monitoring verified successful responses.', 'rec-' + i.id);
}
// Security banner: shown while the signed-in account uses a known / easy-to-guess password
async function refreshSecurity() {
  try {
    const { user } = await api('/auth/me'); state.me = user; const bar = $('#alertbar'); if (!bar) return; let b = $('#secbanner');
    if (!user.weak_password) { b?.remove(); return; }
    if (!b) { b = document.createElement('div'); b.id = 'secbanner'; b.className = 'alertbanner down medium'; bar.prepend(b); }
    b.innerHTML = '<span class="dot degraded"></span><div class="at"><b>Security: change your password now</b><span>Your password is a well-known example or too easy to guess, so anyone who has seen it could sign in as you. Choose a long, unique passphrase.</span></div><a class="btn sm" href="#/settings">Change password</a>';
  } catch { /* ignore */ }
}
window.addEventListener('tgt-pw-changed', refreshSecurity);
// Loud warning when nothing is being checked (e.g. only the dashboard was started, or the checker crashed / the computer slept)
let engineWasDown = false;
async function checkEngine() {
  if (!state.me) return;
  try {
    const e = await api('/engine'); const bar = $('#alertbar'); if (!bar) return; let b = $('#enginebanner');
    if (e.scheduler_healthy) { if (b) { b.remove(); if (engineWasDown) toast('✓ Monitoring is running again', 'ok'); } engineWasDown = false; return; }
    engineWasDown = true;
    if (!b) { b = document.createElement('div'); b.id = 'enginebanner'; b.className = 'alertbanner down enginedown'; bar.prepend(b); }
    b.innerHTML = `<span class="dot down"></span><div class="at"><b>Monitoring is NOT running: nothing is being checked right now</b><span>${e.scheduler_age_s == null ? 'The checker has never started.' : `The checker last reported ${dur(e.scheduler_age_s * 1000)} ago.`} Only the dashboard is open. Start the full app with <b>npm start</b> in the project folder (or run <b>npm run worker</b> alongside <b>npm run web</b>).</span></div>`;
  } catch { /* offline: the live indicator already shows it */ }
}
async function checkAlerts() {
  if (!state.me) return;
  try {
    const r = await api('/incidents?view=active&page_size=50'); const cur = new Map(r.items.map((i) => [i.id, i]));
    if (known) { for (const [id, i] of cur) if (!known.has(id)) showAlert(i); for (const [id, i] of known) if (!cur.has(id)) showRecovered(i); }
    known = cur; bellBadge(r.counts.active);
  } catch { /* transient */ }
}
document.addEventListener('click', (e) => {
  const d = e.target.closest('[data-dismiss]'); if (d) { d.closest('.alertbanner')?.remove(); updateTitle(); }
  if (e.target.closest('[data-act=bell]')) openAlertSettings();
});
function openAlertSettings() {
  const perm = 'Notification' in window ? Notification.permission : 'unsupported';
  const m = modal('Alert settings', `<p class="mut">When a monitored site or service goes down, you get an instant alert here, without needing email or WhatsApp. Keep this page open (a pinned tab works well) to be alerted.</p>
    <div class="field chk"><input type="checkbox" name="sound" id="a_s" ${prefs.sound ? 'checked' : ''}><label for="a_s">Play a sound when something goes down or recovers</label></div>
    <div class="field chk"><input type="checkbox" name="notify" id="a_n" ${prefs.notify && perm === 'granted' ? 'checked' : ''} ${perm === 'unsupported' ? 'disabled' : ''}><label for="a_n">Show desktop notifications ${perm === 'denied' ? '<span class="pill failed">blocked in browser settings</span>' : perm === 'granted' ? '<span class="pill operational">allowed</span>' : ''}</label></div>
    <div class="row mt"><button type="button" class="btn" id="a_test">Send a test alert</button></div>
    <div class="note mt">For alerts when you are away from the screen, also configure email or WhatsApp under <a href="#/integrations">Integrations</a> and add recipients under <a href="#/alerts">Alerts</a>.</div>`,
    { submit: 'Save', onSubmit: async (f) => { prefs.sound = !!f.sound; prefs.notify = !!f.notify; savePrefs(); if (prefs.notify && 'Notification' in window && Notification.permission === 'default') await Notification.requestPermission(); if (prefs.notify && Notification.permission !== 'granted') { prefs.notify = false; savePrefs(); toast('Desktop notifications are blocked by the browser', 'err'); } else toast('Alert settings saved', 'ok'); } });
  $('#a_n', m.el).addEventListener('change', async (e) => { if (e.target.checked && 'Notification' in window && Notification.permission === 'default') { const p = await Notification.requestPermission(); if (p !== 'granted') e.target.checked = false; } });
  $('#a_test', m.el).addEventListener('click', () => { const fake = { id: 0, severity: 'critical', category: 'availability', asset_name: 'example.com (test)', title: 'Website offline', description: 'This is a test alert', code: 'INC-TEST', first_detected: Date.now() }; const keep = prefs.notify; prefs.notify = $('#a_n', m.el).checked; beep('down'); toast('🔴 Your website example.com (test) is DOWN', 'err'); systemNotify(headline(fake), 'This is a test alert', 'test-0'); prefs.notify = keep; });
}

// ---------------- router ----------------
let routeSeq = 0; // each navigation gets its own container; a page that finishes late can no longer overwrite or crash the current one
async function route() {
  if (!state.me) return; const [, page = 'overview', ...params] = location.hash.split('/'); const host = $('#page'); if (!host) return;
  const seq = ++routeSeq; const el = document.createElement('div'); host.replaceChildren(el);
  $('#side')?.classList.remove('open'); $$('.nav a').forEach((a) => a.classList.toggle('on', a.dataset.nav === (page === 'asset' ? '' : page === 'incident' ? 'incidents' : page === 'add' ? '' : page)));
  clearInterval(refreshTimer); currentRefresh = null; const ctx = { el, params, setRefresh: (fn) => { if (seq !== routeSeq) return; currentRefresh = fn; clearInterval(refreshTimer); refreshTimer = setInterval(fn, 30000); } };
  el.innerHTML = skeleton(); updateBadge();
  setTimeout(() => { // watchdog: a page stuck on its loading skeleton gets a visible message and a retry button
    if (seq !== routeSeq || !el.querySelector('.skel')) return;
    el.innerHTML = '<div class="err-box"><b>This page is taking too long to load.</b><div class="mut" style="margin:6px 0 12px">The server may be busy or your connection dropped.</div><button class="btn pri" id="retry">Try again</button></div>'; $('#retry', el)?.addEventListener('click', route);
  }, 15000);
  try {
    if (page === 'overview') await pageOverview(ctx); else if (GROUP_PAGES[page]) await pageAssets(ctx, page); else if (page === 'asset') await pageAsset(ctx); else if (page === 'add') await pageAdd(ctx);
    else if (page === 'projects') await pageProjects(ctx); else if (page === 'incidents') await pageIncidents(ctx); else if (page === 'incident') await pageIncident(ctx);
    else if (page === 'alerts') await pageAlerts(ctx); else if (page === 'analytics') await pageAnalytics(ctx); else if (page === 'reports') await pageReports(ctx); else if (page === 'team') await pageTeam(ctx);
    else if (page === 'integrations') await pageIntegrations(ctx); else if (page === 'settings') await pageSettings(ctx); else el.innerHTML = empty('Page not found');
  } catch (er) { if (seq !== routeSeq) return; /* superseded by a newer navigation */ console.error(er.stack || er); el.innerHTML = `<div class="err-box">Failed to load: ${esc(er.message)}</div>`; }
}
window.addEventListener('hashchange', route);
let lastFatal = 0; // never let an unexpected error fail silently: say so, once in a while, without blocking the app
const reportFatal = (msg) => { if (!state.me || Date.now() - lastFatal < 5000) return; lastFatal = Date.now(); toast(`Something went wrong: ${String(msg).slice(0, 140)}. If the page looks wrong, press Cmd+Shift+R.`, 'err'); };
window.addEventListener('error', (e) => reportFatal(e.message || 'script error'));
window.addEventListener('unhandledrejection', (e) => reportFatal(e.reason?.message || e.reason || 'request failed'));

// ---------------- Overview ----------------
const COLS = [['name', 'Asset'], ['category', 'Category'], ['target', 'URL / endpoint'], ['status', 'Status'], ['response', 'Response'], ['trend', 'Trend'], ['code', 'HTTP'], ['last_ok', 'Last success'], ['last_fail', 'Last failure'], ['uptime', 'Uptime'], ['incident', 'Incident'], ['interval', 'Frequency'], ['assignee', 'Assigned'], ['actions', '']];
const DEFAULT_COLS = ['name', 'target', 'status', 'response', 'trend', 'uptime', 'incident', 'actions'];
const colPrefs = () => { try { return JSON.parse(localStorage.getItem('tgt_cols3')) || DEFAULT_COLS; } catch { return DEFAULT_COLS; } };
const t12 = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
const every = (s) => (s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)} min` : s < 86400 ? `${Math.round(s / 3600)} h` : 'daily');
function assetRows(items, cols) {
  const cell = {
    name: (a) => `<a href="#/asset/${a.id}"><b>${esc(a.name)}</b></a><div class="mut" style="font-size:11px">${esc(TYPE_META[a.type]?.label || a.type)} · ${esc(a.project_name)}${a.is_demo ? ' <span class="pill unknown">DEMO</span>' : ''}${!a.verified ? ' <span class="pill unknown" title="No completed check yet">unverified</span>' : ''}</div>`,
    category: (a) => `${esc(TYPE_META[a.type]?.label || a.type)}${a.category ? `<div class="mut" style="font-size:11px">${esc(a.category)}</div>` : ''}`,
    target: (a) => `<span class="mono clip" title="${esc(a.target)}">${esc(a.target)}</span>`,
    status: (a) => `<span class="dot ${esc(a.status)}"></span> ${pill(a.status)}${a.status_reason ? `<div class="mut" style="font-size:11px;max-width:260px" title="${esc(a.status_reason)}">${esc(a.status_reason.slice(0, 70))}</div>` : ''}`,
    response: (a) => (a.last_response_ms != null ? Math.round(a.last_response_ms) + ' ms' : '–'), trend: (a) => (a.type === 'server' ? '<span class="mut" style="font-size:11px">agent</span>' : spark((a.spark || []).map((p) => ({ v: p.v, state: p.state })))), code: (a) => a.last_status_code || '–',
    last_ok: (a) => ago(a.last_ok_at), last_fail: (a) => ago(a.last_fail_at), uptime: (a) => pct(a.uptime), interval: (a) => (a.type === 'server' ? 'agent push' : a.config?.check_times?.length ? `${a.config.check_times.length}×/day` : every(a.interval_sec)),
    incident: (a) => (a.active_incident ? `<a href="#/incident/${a.active_incident.id}">${pill(a.active_incident.severity, a.active_incident.code)}</a>` : '–'), assignee: (a) => esc(a.assignee_name || '–'),
    actions: (a) => `<div class="acts"><a class="btn sm" href="#/asset/${a.id}">Open</a>${role('technician') && a.type !== 'server' ? `<button class="btn sm ghost" data-check="${a.id}" title="Run a check right now">Check now</button>` : ''}</div>`,
  };
  return items.map((a) => `<tr>${cols.map((c) => `<td class="c-${c}">${cell[c](a)}</td>`).join('')}</tr>`).join('');
}
async function assetTable(host, baseParams, { showFilters = true } = {}) {
  const P = { page: 1, page_size: 25, sort: 'name', dir: 'asc', q: '', status: '', critical: '', project_id: '', ...baseParams };
  const projects = showFilters ? await api('/projects') : [];
  host.innerHTML = `${showFilters ? `<div class="filters"><input id="q" placeholder="Search name or URL…" value=""><select id="fstatus"><option value="">All statuses</option><option value="online">Online</option><option value="offline">Offline</option><option value="slow">Slow</option><option value="degraded">Degraded</option><option value="unknown">Unknown</option><option value="maintenance">Maintenance</option></select>
  <select id="fcrit"><option value="">Any incident state</option><option value="1">Critical incidents</option></select>
  <select id="fproj"><option value="">All projects</option>${projects.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select><select id="frange"><option value="86400000">Uptime: 24h</option><option value="604800000">7 days</option><option value="2592000000">30 days</option></select>
  <details style="position:relative"><summary class="btn sm" style="list-style:none">Columns</summary><div class="card" style="position:absolute;z-index:6;width:200px;right:0">${COLS.filter((c) => c[1]).map(([k, l]) => `<div class="chk"><input type="checkbox" data-col="${k}" ${colPrefs().includes(k) ? 'checked' : ''}><label>${l}</label></div>`).join('')}</div></details></div>` : ''}
  <div class="card" style="padding:0"><div class="tw"><table><thead><tr id="thead"></tr></thead><tbody id="tbody"></tbody></table></div><div class="row" style="padding:10px 14px" id="pager"></div></div>`;
  const load = async () => {
    const cols = colPrefs().filter((c) => COLS.some((x) => x[0] === c)); if (!cols.includes('actions')) cols.push('actions');
    const sortable = { name: 'name', status: 'status', response: 'response', category: 'type', last_ok: 'last_check' };
    $('#thead', host).innerHTML = cols.map((c) => `<th class="${sortable[c] ? 'sort' : ''}" data-sort="${sortable[c] || ''}">${esc(COLS.find((x) => x[0] === c)[1])}${P.sort === sortable[c] ? (P.dir === 'asc' ? ' ▲' : ' ▼') : ''}</th>`).join('');
    const r = await api('/assets?' + qs({ ...P, to: Date.now(), from: Date.now() - (+($('#frange', host)?.value) || 86400000) }));
    $('#tbody', host).innerHTML = r.items.length ? assetRows(r.items, cols) : `<tr><td colspan="${cols.length}">${empty('No assets match', 'Register one with “Add asset”, or adjust the filters.')}</td></tr>`;
    const pages = Math.max(1, Math.ceil(r.total / r.page_size));
    $('#pager', host).innerHTML = `<span class="mut">${r.total} asset${r.total === 1 ? '' : 's'}</span><div class="sp" style="flex:1"></div><button class="btn sm" data-pg="-1" ${P.page <= 1 ? 'disabled' : ''}>Prev</button><span>Page ${P.page} / ${pages}</span><button class="btn sm" data-pg="1" ${P.page >= pages ? 'disabled' : ''}>Next</button>
    <select id="psize" style="width:auto">${[10, 25, 50, 100].map((n) => `<option ${n === P.page_size ? 'selected' : ''}>${n}</option>`).join('')}</select>`;
    return r;
  };
  host.addEventListener('click', async (e) => {
    const s = e.target.closest('th.sort'); if (s?.dataset.sort) { P.dir = P.sort === s.dataset.sort && P.dir === 'asc' ? 'desc' : 'asc'; P.sort = s.dataset.sort; return load(); }
    const pg = e.target.closest('[data-pg]'); if (pg) { P.page += +pg.dataset.pg; return load(); }
    const ck = e.target.closest('[data-check]'); if (ck) { ck.disabled = true; ck.textContent = '…'; try { const r = await api(`/assets/${ck.dataset.check}/check-now`, { method: 'POST' }); toast(`Check complete: ${r.status}${r.status_reason ? ' – ' + r.status_reason : ''}`, r.status === 'operational' ? 'ok' : ''); } catch (er) { fail(er); } load(); }
  });
  host.addEventListener('change', (e) => {
    const m = { fstatus: 'status', fcrit: 'critical', fproj: 'project_id' }[e.target.id]; if (m) { P[m] = e.target.value; P.page = 1; load(); }
    if (e.target.id === 'frange') load(); if (e.target.id === 'psize') { P.page_size = +e.target.value; P.page = 1; load(); }
    if (e.target.dataset.col) { const c = $$('[data-col]', host).filter((x) => x.checked).map((x) => x.dataset.col); localStorage.setItem('tgt_cols3', JSON.stringify(c)); load(); }
  });
  let qt; host.addEventListener('input', (e) => { if (e.target.id === 'q') { clearTimeout(qt); qt = setTimeout(() => { P.q = e.target.value; P.page = 1; load(); }, 300); } });
  await load(); return load;
}
async function pageOverview({ el, setRefresh }) {
  const [d, eng, act] = await Promise.all([api('/dashboard'), api('/engine'), api('/activity')]);
  const chips = [['', 'All assets'], ['websites', 'Websites'], ['applications', 'Applications'], ['apis', 'APIs'], ['servers', 'Servers'], ['databases', 'Databases']];
  const cards = (n) => `<div class="grid cards" id="cards">${stat('Monitored assets', n.total)}${stat('Online', n.online, 'green')}${stat('Offline', n.offline, n.offline ? 'red' : '')}${stat('Slow / degraded', n.slow + n.degraded, n.slow + n.degraded ? 'amber' : '')}${stat('Critical incidents', n.critical_incidents, n.critical_incidents ? 'red' : '')}${stat('Active warnings', n.warnings, n.warnings ? 'amber' : '')}${stat('Avg uptime (24h)', pct(n.avg_uptime_24h), 'green')}${stat('Avg response', n.avg_response_ms == null ? 'n/a' : n.avg_response_ms + ' ms')}${stat('Alerts sent today', n.alerts_today, 'blue')}${stat('Recovered today', n.recovered_today, 'green')}</div>`;
  const feed = (a) => (a.length ? a.slice(0, 14).map((x) => `<a class="it" href="${esc(x.link)}" style="color:inherit"><span class="ic ${x.level}"></span><div style="min-width:0"><div class="tt">${esc(x.title)}</div><div class="tx" title="${esc(x.text)}">${esc(x.text)}</div></div><span class="tm">${ago(x.ts)}</span></a>`).join('') : empty('Waiting for the first check…', 'Activity appears here the moment the engine runs.'));
  const hero = (n, e, a) => {
    const measured = n.total - n.unknown - n.maintenance; const healthy = measured > 0 ? (n.online / measured) * 100 : 0; const color = !measured ? '#64748b' : n.offline ? '#f43f5e' : healthy < 100 ? '#fbbf24' : '#22d38a';
    const waiting = n.unknown ? ` · ${n.unknown} awaiting first data` : ''; const msg = (!n.total ? 'No assets yet' : !measured ? `Waiting for first checks${waiting}` : n.offline ? `${n.offline} asset${n.offline > 1 ? 's' : ''} down right now` : n.slow + n.degraded ? 'Some assets need attention' : 'Everything measured is operating normally') + (measured > 0 ? waiting : '');
    return `<div class="hero" id="hero"><div class="card ringwrap">${ring(healthy, color)}<div><h2 style="margin:0 0 4px">Infrastructure health</h2><div class="mut" style="max-width:190px">${msg}</div></div></div>
    <div class="engine"><div class="chipstat"><div class="k">Monitoring engine</div><div class="v">${e.scheduler_healthy ? '<span class="dot ok"></span> Running' : '<span class="dot down"></span> Stalled'}</div></div><div class="chipstat"><div class="k">Checks (last minute)</div><div class="v">${e.checks_last_min}</div></div>
    <div class="chipstat"><div class="k">Next check in</div><div class="v">${e.next_check_in_s == null ? '–' : e.next_check_in_s + 's'}</div></div><div class="chipstat"><div class="k">Open incidents · pending alerts</div><div class="v">${e.open_incidents} · ${e.pending_alerts}</div></div></div>
    <div class="card"><div class="live-title"><h2 style="margin:0">Live activity</h2><span class="dot ok"></span></div><div class="scan"></div><div class="feed" id="feed">${feed(a)}</div></div></div>`;
  };
  el.innerHTML = `<div class="hdr"><h1>Overview</h1><div class="sp"></div>${role('admin') ? '<a class="btn pri" href="#/add">+ Add asset</a>' : ''}</div>
  ${d.total === 0 ? (role('admin') ? `<div class="card welcome"><div><h2 style="font-size:20px;margin-bottom:6px">Start monitoring in 10 seconds</h2><div class="mut">Paste any website or API address. We create the project, run the first check immediately, and alert you if it ever goes down.</div>
    <form class="quick big" data-quick><input name="url" placeholder="example.com  or  https://api.example.com/health" autocomplete="off" spellcheck="false" autofocus><button class="btn pri">Start monitoring</button></form>
    <div class="steps"><div><b>1</b><span>Paste a link</span></div><div><b>2</b><span>First check runs instantly</span></div><div><b>3</b><span>Add alert recipients under <a href="#/alerts">Alerts</a></span></div></div></div></div>` : '<div class="note" style="margin-bottom:14px"><b>No assets registered yet.</b> Ask an administrator to register assets for your project.</div>') : ''}
  ${d.demo ? '<div class="warn" style="margin-bottom:14px">This view includes DEMO assets. Demo results are simulated and are not real monitoring data.</div>' : ''}
  ${d.unverified ? `<div class="note" style="margin-bottom:14px">${d.unverified} asset(s) have not completed a first check yet and are excluded from uptime figures.</div>` : ''}
  ${hero(d, eng, act)}${cards(d)}
  <div class="mt"><div class="row" id="chips" style="margin-bottom:12px">${chips.map(([g, l], i) => `<span class="chip ${i ? '' : 'on'}" data-g="${g}">${l}</span>`).join('')}</div><div id="tbl"></div></div>
  <div class="card mt"><h2>Recent incidents</h2>${d.recent_incidents.length ? `<table>${d.recent_incidents.map((i) => `<tr><td>${pill(i.severity)}</td><td><a href="#/incident/${i.id}">${esc(i.title)}</a> <span class="mut">on ${esc(i.asset_name)}</span></td><td>${pill(i.status)}</td><td class="mut">${ago(i.first_detected)}</td></tr>`).join('')}</table>` : empty('No incidents recorded', 'All good so far.')}</div>`;
  countUp(el);
  let group = ''; let reload = await assetTable($('#tbl', el), { group });
  $('#chips', el).addEventListener('click', async (e) => { const c = e.target.closest('.chip'); if (!c) return; $$('.chip', el).forEach((x) => x.classList.toggle('on', x === c)); group = c.dataset.g; reload = await assetTable($('#tbl', el), { group }); });
  setRefresh(async () => {
    if (!['#/overview', '', '#/'].includes(location.hash)) return;
    const [n, e, a] = await Promise.all([api('/dashboard'), api('/engine'), api('/activity')]);
    const old = $('#cards'); if (old) { const tmp = document.createElement('div'); tmp.innerHTML = cards(n); [...tmp.firstChild.children].forEach((c) => { c.style.animation = 'none'; }); old.replaceWith(tmp.firstChild); }
    const h = $('#hero'); if (h) { const tmp = document.createElement('div'); tmp.innerHTML = hero(n, e, a); [...tmp.firstChild.querySelectorAll('.it')].forEach((c) => { c.style.animation = 'none'; }); h.replaceWith(tmp.firstChild); }
    reload();
  });
}

// ---------------- asset group pages ----------------
async function pageAssets({ el, setRefresh }, page) {
  const [title, defType, types] = GROUP_PAGES[page];
  el.innerHTML = `<div class="hdr"><h1>${esc(title)}</h1><div class="sp"></div>${role('admin') ? `<a class="btn" href="#/add/import">Bulk import</a><a class="btn pri" href="#/add/${defType}">+ Add ${esc(title.replace(/s$/, ''))}</a>` : ''}</div><div id="tbl"></div>`;
  const reload = await assetTable($('#tbl', el), { group: page }); setRefresh(reload);
}

// ---------------- asset detail ----------------
async function pageAsset({ el, params, setRefresh }) {
  const id = params[0]; let range = '24h'; let custom = {};
  const render = async () => {
    const d = await api(`/assets/${id}?` + (range === 'custom' ? qs({ from: custom.from, to: custom.to }) : `range=${range}`)); const a = d.asset; const server = a.type === 'server';
    const m = d.metrics || {}; const lr = a.state?.last_report; const th = { ...d.default_thresholds, ...(a.config.thresholds || {}) };
    const strip = d.recent_checks.slice(0, 60).reverse().map((c) => `<i class="${c.kind === 'gap' ? '' : c.state === 'ok' ? 'ok' : c.state === 'slow' ? 'slow' : c.confirmed ? 'fail' : 'mid'}" title="${esc(dt(c.ts))} ${esc(c.state)} ${c.response_ms ?? ''}ms ${esc(c.error || '')}"></i>`).join('');
    el.innerHTML = `<div class="hdr"><div><div class="mut"><a href="#/${a.type === 'website' ? 'websites' : a.type === 'api' ? 'apis' : server ? 'servers' : a.type === 'database' ? 'databases' : ['domain', 'ssl'].includes(a.type) ? 'domains' : 'applications'}">← ${esc(TYPE_META[a.type]?.label || a.type)}s</a></div><h1><span class="dot ${esc(a.status)}"></span> ${esc(a.name)} ${pill(a.status)}</h1><div class="mono mut">${esc(a.target)}</div></div><div class="sp"></div>
    ${role('technician') && !server ? '<button class="btn" id="chk">Check now</button>' : ''}${role('admin') ? '<button class="btn" id="edit">Edit</button><button class="btn" id="maint">Maintenance</button><button class="btn" id="arch">Archive</button><button class="btn dng" id="del">Delete</button>' : ''}</div>
    ${['website', 'webapp', 'mobile', 'api', 'custom'].includes(a.type) && a.last_check_at ? `<div class="mut" style="margin:-8px 0 14px;font-size:13px">Last check: <b>${a.last_status_code ? 'HTTP ' + a.last_status_code : 'no response'}</b> in <b>${a.last_response_ms != null ? Math.round(a.last_response_ms) + ' ms' : '–'}</b> · working means HTTP ${esc(a.config.expected_status || '200')} · slow above ${a.config.max_response_ms || 2000} ms · checked ${ago(a.last_check_at)}</div>` : ''}
    ${a.status_reason ? `<div class="${a.status === 'down' ? 'err-box' : 'note'}" style="margin-bottom:14px">${esc(a.status_reason)}${d.incidents.some((i) => !['resolved', 'closed'].includes(i.status)) ? '<div class="mut" style="margin-top:8px;font-size:12.5px">⟳ Re-checking automatically every minute. It turns green by itself as soon as the problem is fixed; there is no need to press Check now.</div>' : ''}</div>` : ''}
    ${a.config.check_times?.length ? `<div class="note" style="margin-bottom:14px"><b>Scheduled checks:</b> daily at ${a.config.check_times.map(t12).join(', ')} (UTC${a.config.check_tz_offset_min >= 0 ? '+' : ''}${(a.config.check_tz_offset_min / 60).toFixed(a.config.check_tz_offset_min % 60 ? 1 : 0)}). ${a.status === 'down' || a.active_incident ? `A problem is open, so it is being re-checked every ${a.config.recheck_while_down_min || 5} min.` : `Next check: <b>${esc(dt(a.next_run_at))}</b>.`} Use “Check now” any time.</div>` : ''}
    ${!a.verified ? '<div class="warn" style="margin-bottom:14px">Unverified: no completed check yet. Status and uptime will appear after the first successful run.</div>' : ''}${a.is_demo ? '<div class="warn" style="margin-bottom:14px">DEMO asset: simulated data.</div>' : ''}
    ${server && lr?.reboot_required ? '<div class="warn" style="margin-bottom:14px">⚠️ <b>Host reboot required:</b> Pending system security or kernel updates on this server.</div>' : ''}
    <div class="grid cards">${stat('Uptime', pct(d.uptime.pct), 'green', `${d.uptime.checks} checks · ${d.uptime.gaps} gaps`)}${stat('Avg response', d.avg_response_ms == null ? 'n/a' : d.avg_response_ms + ' ms')}${stat('Verified downtime', dur(d.downtime_ms), d.downtime_ms ? 'red' : '')}${stat('Last check', ago(a.last_check_at))}${stat('Last success', ago(a.last_ok_at))}${stat('Frequency', server ? 'agent push' : a.config.check_times?.length ? `${a.config.check_times.length}× per day` : every(a.interval_sec))}</div>
    <div class="row mt" id="rng">${['24h', '7d', '30d'].map((r) => `<span class="chip ${range === r ? 'on' : ''}" data-r="${r}">${r === '24h' ? 'Last 24 hours' : r === '7d' ? '7 days' : '30 days'}</span>`).join('')}<span class="chip ${range === 'custom' ? 'on' : ''}" data-r="custom">Custom…</span></div>
    ${server ? `<div class="grid two mt">${[['cpu', 'CPU %', '#3b82f6', th.cpu], ['ram', 'RAM %', '#a855f7', th.ram], ['disk', 'Disk %', '#f59e0b', th.disk], ['load1', 'Load (1m)', '#22c55e', null]].map(([k, l, c, t]) => `<div class="card"><h3>${l}${t ? ` <span class="mut">(warn ${t[0]} / crit ${t[1]})</span>` : ''}</h3>${lineChart((m[k] || []).map((p) => ({ t: p.ts, v: p.value })), { color: c, max: k === 'load1' ? null : 100, unit: k === 'load1' ? '' : '%' })}</div>`).join('')}</div>
    <div class="grid two mt"><div class="card"><h2>Disks</h2>${lr?.disks?.length ? lr.disks.map((x) => `<div style="margin-bottom:10px"><div class="row"><span class="mono">${esc(x.mount)}</span><span class="grow"></span><b>${x.percent.toFixed(1)}%</b></div>${usageBar(x.percent, th.disk)}</div>`).join('') : empty('No agent report yet')}</div>
    <div class="card"><h2>Registered services</h2>${(a.config.services || []).length ? `<table>${a.config.services.map((s) => { const r = (lr?.services || []).find((x) => x.name === s); return `<tr><td class="mono">${esc(s)}</td><td>${r ? (r.running ? pill('operational', 'running') : pill('down', 'stopped')) : pill('unknown', 'not reported')}</td></tr>`; }).join('')}</table>` : '<div class="mut">No services registered. Edit the asset to add nginx, mysql, redis…</div>'}
    ${lr?.docker?.available ? `<div class="mt" style="padding-top:10px;border-top:1px solid var(--line)"><span class="chip on">🐳 Docker: ${lr.docker.running} running / ${lr.docker.total} total</span></div>` : ''}
    <div class="mt mut">Agent: ${lr ? `v${esc(lr.agent_version)} · ${esc(lr.hostname)} · ${esc(lr.os)} · ${lr.cores ?? '?'} cores · last report ${ago(a.last_heartbeat_at)}` : 'never reported'}</div>${role('admin') ? '<div class="mt"><button class="btn sm" id="tok">Rotate agent token / show install command</button></div>' : ''}</div></div>
    ${server && lr?.top_processes?.length ? `<div class="card mt"><h2>Top processes by resource usage</h2><table><thead><tr><th>PID</th><th>User</th><th>Command</th><th style="text-align:right">CPU %</th><th style="text-align:right">RAM %</th></tr></thead><tbody>${lr.top_processes.map((p) => `<tr><td class="mono">${p.pid}</td><td>${esc(p.user)}</td><td class="mono">${esc(p.command)}</td><td style="text-align:right"><b>${p.cpu}%</b></td><td style="text-align:right">${p.ram}%</td></tr>`).join('')}</tbody></table></div>` : ''}`
    : `<div class="card mt"><h2>Response time</h2>${lineChart(d.series.map((s) => ({ t: s.ts, v: s.ms })), { unit: ' ms' })}</div>
    <div class="card mt"><h2>Recent checks</h2><div class="strip">${strip || ''}</div><div class="mut" style="font-size:11px;margin-top:4px">Green = ok · orange = slow · amber = unconfirmed failure (retrying) · red = verified failure</div></div>`}
    ${a.type === 'mobile' ? `<div class="card mt"><h2>Client-reported errors</h2><div class="note" style="margin-bottom:10px">Backend availability alone does not prove the mobile app works. Apps report crashes/errors to <span class="mono">POST /api/mobile/report</span> with an app key. ${role('admin') ? '<button class="btn sm" id="appkey">Generate app key</button>' : ''}</div>${d.mobile?.length ? `<table>${d.mobile.map((r) => `<tr><td>${pill(r.kind === 'crash' ? 'down' : 'degraded', r.kind)}</td><td>${esc(r.platform)} ${esc(r.app_version)}</td><td>${esc(r.message)}</td><td class="mut">${ago(r.ts)}</td></tr>`).join('')}</table>` : empty('No client reports received')}</div>` : ''}
    ${['domain', 'ssl'].includes(a.type) ? `<div class="card mt"><h2>${a.type === 'ssl' ? 'Certificate' : 'Domain'}</h2><div class="kv">${a.type === 'ssl' ? `<div>Expires</div><div>${a.state.ssl ? `${dt(a.state.ssl.validTo)} (${a.state.ssl.daysLeft} days)` : '–'}</div><div>Issuer</div><div>${esc(a.state.ssl?.issuer || '–')}</div><div>Protocol</div><div>${esc(a.state.ssl?.protocol || '–')}</div>` : `<div>Registration expiry</div><div>${a.state.rdap?.expiresAt ? dt(a.state.rdap.expiresAt) : `unavailable (${esc(a.state.rdap?.reason || 'not checked yet')})`}</div><div>Nameservers</div><div class="mono">${esc((a.state.ns || '').split(',').join(', ') || '–')}</div>`}</div></div>` : ''}
    ${a.state?.render ? `<div class="card mt"><h2>What a visitor sees ${a.state.render.state === 'ok' ? pill('operational', 'Page displays') : a.state.render.state === 'fail' ? pill('down', 'Page NOT displaying') : pill('unknown', 'Not checked')}</h2>
      ${a.state.render.state === 'fail' ? `<div class="err-box" style="margin-bottom:12px">${esc(a.state.render.error)}</div>` : a.state.render.state === 'unavailable' ? `<div class="warn">${esc(a.state.render.error)}</div>` : `<div class="mut" style="margin-bottom:10px">Opened in a real browser ${esc(ago(a.state.render.ts))}: ${a.state.render.textLen ?? 0} characters of visible text${a.state.render.js_errors ? `, ${a.state.render.js_errors} JavaScript error(s)` : ''}. Checked every ${a.config.render_interval_min || 5} min.</div>`}
      ${a.state.render.shot ? `<img src="/api/assets/${a.id}/screenshot?t=${a.state.render.ts}" alt="Screenshot of what a visitor sees" style="max-width:100%;border-radius:12px;border:1px solid var(--line)">` : ''}</div>` : ''}
    ${a.state?.workflow ? `<div class="card mt"><h2>Synthetic workflow</h2>${a.state.workflow.state === 'unavailable' ? `<div class="warn">${esc(a.state.workflow.error)}</div>` : `${pill(a.state.workflow.state === 'ok' ? 'operational' : 'down', a.state.workflow.state)} ${esc(a.state.workflow.error || '')}`}</div>` : ''}
    <div class="grid two mt"><div class="card"><h2>Incidents</h2>${d.incidents.length ? `<table>${d.incidents.map((i) => `<tr><td>${pill(i.severity)}</td><td><a href="#/incident/${i.id}">${esc(i.code)}</a> ${esc(i.title)}</td><td>${pill(i.status)}</td><td class="mut">${ago(i.first_detected)}</td></tr>`).join('')}</table>` : empty('No incidents')}</div>
    <div class="card"><h2>Recent check log</h2><div class="tw" style="max-height:300px"><table>${d.recent_checks.slice(0, 25).map((c) => `<tr><td class="nowrap mut">${esc(dt(c.ts))}</td><td>${c.kind === 'gap' ? pill('unknown', 'gap') : pill(c.state === 'ok' ? 'operational' : c.state === 'slow' ? 'slow' : 'down', c.state)}</td><td>${c.response_ms != null ? Math.round(c.response_ms) + 'ms' : ''} ${c.status_code || ''}</td><td class="mut" style="font-size:12px">${esc(c.error || '')}</td></tr>`).join('') || '<tr><td>No checks yet</td></tr>'}</table></div></div></div>`;
    wire(a);
  };
  const wire = (a) => {
    $('#rng', el).addEventListener('click', (e) => { const c = e.target.closest('[data-r]'); if (!c) return; if (c.dataset.r === 'custom') { modal('Custom range', `<div class="fgrid">${field({ k: 'from', label: 'From', type: 'datetime-local' })}${field({ k: 'to', label: 'To', type: 'datetime-local' })}</div>`, { submit: 'Apply', onSubmit: async (f) => { if (!f.from || !f.to) throw new Error('Pick both dates'); custom = { from: new Date(f.from).getTime(), to: new Date(f.to).getTime() }; range = 'custom'; render(); } }); } else { range = c.dataset.r; render(); } });
    $('#chk')?.addEventListener('click', async (e) => { e.target.disabled = true; try { const r = await api(`/assets/${id}/check-now`, { method: 'POST' }); toast(`Check complete: ${r.status}`, r.status === 'operational' ? 'ok' : ''); } catch (er) { fail(er); } render(); });
    $('#edit')?.addEventListener('click', () => assetForm(a, { onDone: render }));
    $('#maint')?.addEventListener('click', () => modal('Maintenance window', `<div class="note" style="margin-bottom:12px">During maintenance, checks are paused and no alerts are sent. Status shows “Maintenance”.</div>${field({ k: 'mode', label: 'Mode', type: 'select', options: [['now', 'Start maintenance now (until ended manually)'], ['window', 'Schedule a window'], ['end', 'End maintenance']] })}<div class="fgrid">${field({ k: 'start', label: 'Window start', type: 'datetime-local' })}${field({ k: 'end', label: 'Window end', type: 'datetime-local' })}</div>`, { onSubmit: async (f) => { const body = f.mode === 'end' ? { clear: true } : f.mode === 'now' ? { on: true } : { start: new Date(f.start).getTime(), end: new Date(f.end).getTime() }; await api(`/assets/${id}/maintenance`, { method: 'POST', body }); toast('Maintenance updated', 'ok'); render(); } }));
    $('#arch')?.addEventListener('click', () => confirmBox('Archive this asset? Monitoring stops; history is kept.', async () => { await api(`/assets/${id}/archive`, { method: 'POST', body: {} }); location.hash = '#/overview'; }, { text: 'Archive', danger: false }));
    $('#del')?.addEventListener('click', () => modal('Delete asset', `<div class="err-box" style="margin-bottom:12px">Monitoring stops permanently. Historical checks and incidents are retained under the retention policy.</div>${field({ k: 'confirm', label: `Type the asset name to confirm: ${a.name}`, req: true })}`, { submit: 'Delete asset', danger: true, onSubmit: async (f) => { await api(`/assets/${id}`, { method: 'DELETE', body: { confirm: f.confirm } }); toast('Asset deleted', 'ok'); location.hash = '#/overview'; } }));
    $('#tok')?.addEventListener('click', () => confirmBox('Generate a new agent token? The old token stops working immediately.', async () => { const r = await api(`/assets/${id}/agent-token`, { method: 'POST' }); showAgentInstall(r.agent_token); return true; }, { text: 'Rotate token', danger: false }));
    $('#appkey')?.addEventListener('click', async () => { const r = await api(`/assets/${id}/app-key`, { method: 'POST' }); modal('App key (shown once)', `<div class="mono card" style="word-break:break-all">${esc(r.app_key)}</div>`); });
  };
  await render(); setRefresh(render);
}
// ---------------- Add asset ----------------
async function pageAdd({ el, params }) {
  if (!role('admin')) { el.innerHTML = '<div class="err-box">Administrators only.</div>'; return; }
  const sel = params[0]; if (sel === 'import') return pageImport(el);
  if (sel && TYPE_META[sel]) { el.innerHTML = `<div class="hdr"><h1>Add ${esc(TYPE_META[sel].label)}</h1></div><div class="card" id="form"></div>`; await assetForm(null, { type: sel, host: $('#form', el), onDone: (r) => { location.hash = `#/asset/${r.id}`; } }); return; }
  el.innerHTML = `<div class="hdr"><h1>Add asset</h1><div class="sp"></div><a class="btn" href="#/add/import">Bulk import (CSV / URL list)</a></div><p class="mut">Only register systems your organisation owns or is authorised to monitor.</p>
  <div class="grid cards">${Object.entries(TYPE_META).map(([k, m]) => `<a class="card" href="#/add/${k}" style="color:inherit;text-decoration:none"><h2>${esc(m.label)}</h2><div class="mut">${esc(m.blurb)}</div></a>`).join('')}</div>`;
}
async function pageImport(el) {
  const projects = await api('/projects');
  el.innerHTML = `<div class="hdr"><a href="#/add">←</a><h1>Bulk import</h1></div><div class="card"><div class="fgrid">${field({ k: 'project_id', label: 'Project', type: 'select', options: projects.map((p) => [p.id, p.name]) })}${field({ k: 'type', label: 'Default type', type: 'select', options: Object.keys(TYPE_META).filter((t) => !['server', 'database'].includes(t)) })}${field({ k: 'interval_sec', label: 'Interval (s)', type: 'number', def: 60 })}${field({ k: 'criticality', label: 'Criticality', type: 'select', options: ['normal', 'critical', 'high', 'low'] })}</div>
  ${field({ k: 'urls', label: 'URLs (one per line) – or paste CSV below', type: 'textarea', ph: 'https://example.com\nhttps://api.example.com/health' })}${field({ k: 'csv', label: 'CSV (columns: name,url,type,interval_sec,criticality,environment,expected_status)', type: 'textarea' })}
  <div class="row"><button class="btn" id="val">Validate</button><button class="btn pri" id="imp" disabled>Import valid assets</button></div><div id="res" class="mt"></div></div>`;
  const body = (dry) => ({ project_id: +$('[name=project_id]', el).value, type: $('[name=type]', el).value, interval_sec: $('[name=interval_sec]', el).value, criticality: $('[name=criticality]', el).value, urls: $('[name=urls]', el).value.trim() || undefined, csv: $('[name=csv]', el).value.trim() || undefined, dry_run: dry });
  const show = (r) => { $('#res', el).innerHTML = `<div class="row" style="margin-bottom:8px">${Object.entries(r.summary).map(([k, v]) => pill(k === 'invalid' ? 'down' : k === 'duplicate' ? 'degraded' : 'operational', `${v} ${k}`)).join('')}</div><div class="tw"><table>${r.results.map((x) => `<tr><td class="mono">${esc(x.target)}</td><td>${pill(x.status === 'invalid' ? 'down' : x.status === 'duplicate' ? 'degraded' : 'operational', x.status)}</td><td class="mut">${esc(x.error || '')}</td></tr>`).join('')}</table></div>`; };
  $('#val', el).onclick = async () => { try { const r = await api('/assets/import', { method: 'POST', body: body(true) }); show(r); $('#imp', el).disabled = !(r.summary.valid > 0); } catch (e) { fail(e); } };
  $('#imp', el).onclick = async () => { try { const r = await api('/assets/import', { method: 'POST', body: body(false) }); show(r); toast(`${r.summary.created || 0} assets created`, 'ok'); $('#imp', el).disabled = true; } catch (e) { fail(e); } };
}

boot();
