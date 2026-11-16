import { $, $$, esc, api, toast, fail, modal, field, role, formData } from './lib.js';

export const TYPE_META = {
  website: { label: 'Website', blurb: 'HTTP(S) availability, status codes, content, response timings, SSL expiry.' },
  webapp: { label: 'Web application', blurb: 'Health endpoint plus optional synthetic browser workflow (login, navigate, verify).' },
  mobile: { label: 'Mobile app backend', blurb: 'Backend health plus client-reported crashes and error rates from the app.' },
  api: { label: 'API', blurb: 'Methods, auth, JSON/XML/schema validation, assertions, latency.' },
  server: { label: 'Linux server', blurb: 'Lightweight agent: CPU, RAM, disk, network, load, services.' },
  database: { label: 'Database', blurb: 'PostgreSQL, MySQL/MariaDB, Redis liveness and latency (no data read).' },
  domain: { label: 'Domain', blurb: 'DNS resolution, nameserver changes, registration expiry.' },
  ssl: { label: 'SSL certificate', blurb: 'Validity, issuer, hostname match, chain, expiry schedule.' },
  custom: { label: 'Custom service (TCP)', blurb: 'TCP port reachability for any service.' },
};
const ENV = ['production', 'staging', 'development'];
const J = { json: true }; const L = { list: true };
const URLF = { k: 'target', label: 'URL', req: true, ph: 'https://example.com/' };
const STATUS = { k: 'config.expected_status', label: 'Expected HTTP status code', ph: '200', help: 'The status that means "working". Any other status is treated as down. Default 200. Ranges are allowed, e.g. 200-299.' };
const EXPIRY = { k: 'config.expiry_alerts', label: 'Expiry alert days', ph: '30,14,7,3,0', ...L, help: 'Alert when days remaining reach these values.' };
const FIELDS = {
  website: [URLF, STATUS, { k: 'config.expected_content', label: 'Expected page content', help: 'Fails if this text is missing from the page.' }, { k: 'config.forbidden_content', label: 'Error content to detect', ph: 'e.g. Fatal error' }, { k: 'config.max_response_ms', label: 'Report as slow above (ms)', type: 'number', ph: '2000', help: 'Slower than this is reported as slow. Default 2000 ms.' }, { k: 'config.follow_redirects', label: 'Follow redirects', type: 'checkbox', def: true }, { k: 'config.detect_content_change', label: 'Alert on unexpected content change (Low)', type: 'checkbox' }, { k: 'config.headers', label: 'Custom request headers (JSON)', type: 'textarea', ph: '{"X-Test":"1"}', ...J }, EXPIRY],
  webapp: [URLF, { k: 'config.health_url', label: 'Health-check endpoint', ph: '/health' }, { k: 'config.login_url', label: 'Login URL' }, { k: 'config.owner', label: 'Application owner' }, STATUS, { k: 'config.expected_content', label: 'Expected content' }, { k: 'config.max_response_ms', label: 'Report as slow above (ms)', type: 'number', ph: '2000', help: 'Slower than this is reported as slow. Default 2000 ms.' },
    { k: 'config.steps', label: 'Synthetic workflow steps (JSON, optional – needs Playwright)', type: 'textarea', ph: '[{"action":"goto","url":"/login"},{"action":"fill","selector":"#email","value":"{{username}}"},{"action":"fill","selector":"#password","value":"{{password}}"},{"action":"click","selector":"button[type=submit]"},{"action":"expectText","text":"Dashboard"}]', ...J, help: 'Actions: goto, fill, click, waitFor, expectText, expectUrl. Use a DEDICATED TEST ACCOUNT and only safe, non-destructive steps.' },
    { k: 'secret.username', label: 'Test account username (encrypted)' }, { k: 'secret.password', label: 'Test account password (encrypted)', type: 'password' }, { k: 'config.workflow_interval_sec', label: 'Workflow interval (s)', type: 'number', ph: '300' }],
  mobile: [{ ...URLF, label: 'Mobile backend health URL' }, { k: 'config.platform', label: 'Platform', type: 'select', options: ['both', 'android', 'ios'] }, STATUS, { k: 'config.min_supported_version', label: 'Minimum supported app version' }, { k: 'config.error_rate_threshold', label: 'Client error-rate threshold (0-1)', type: 'number', ph: '0.2' }, { k: 'config.crash_threshold', label: 'Crash reports / 15 min threshold', type: 'number', ph: '5' }, { k: 'config.max_response_ms', label: 'Report as slow above (ms)', type: 'number', ph: '2000', help: 'Slower than this is reported as slow. Default 2000 ms.' }],
  api: [URLF, { k: 'config.method', label: 'HTTP method', type: 'select', options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] }, { k: 'config.headers', label: 'Headers (JSON)', type: 'textarea', ...J, ph: '{"Accept":"application/json"}' }, { k: 'config.body', label: 'Request body (JSON) – use only safe test payloads', type: 'textarea', ...J },
    { k: 'secret.type', label: 'Authentication', type: 'select', options: [['none', 'None'], ['bearer', 'Bearer token'], ['basic', 'Basic auth'], ['apikey', 'API key'], ['oauth2', 'OAuth 2.0 (client credentials)'], ['custom', 'Custom headers']], help: 'Fill only the fields relevant to the selected method. All credentials are encrypted and masked.' },
    { k: 'secret.token', label: 'Bearer token', type: 'password' }, { k: 'secret.username', label: 'Basic username' }, { k: 'secret.password', label: 'Basic password', type: 'password' }, { k: 'secret.name', label: 'API key name', ph: 'x-api-key' }, { k: 'secret.value', label: 'API key value', type: 'password' }, { k: 'secret.in', label: 'API key location', type: 'select', options: ['header', 'query'] },
    { k: 'secret.token_url', label: 'OAuth token URL' }, { k: 'secret.client_id', label: 'OAuth client ID' }, { k: 'secret.client_secret', label: 'OAuth client secret', type: 'password' }, { k: 'secret.scope', label: 'OAuth scope' }, { k: 'secret.headers', label: 'Custom auth headers (JSON)', type: 'textarea', ...J },
    STATUS, { k: 'config.response_format', label: 'Response format', type: 'select', options: [['', 'Auto-detect'], 'json', 'xml', 'text'] }, { k: 'config.expected_fields', label: 'Required response fields', ...L, ph: 'status,data.id', help: 'Dot-paths for JSON, element names for XML.' }, { k: 'config.schema', label: 'JSON schema (optional)', type: 'textarea', ...J, ph: '{"type":"object","required":["status"]}' },
    { k: 'config.assertions', label: 'Custom assertions (JSON)', type: 'textarea', ...J, ph: '[{"path":"data.count","op":"gt","value":0}]', help: 'ops: eq, neq, gt, lt, contains, exists' }, { k: 'config.max_response_ms', label: 'Report as slow above (ms)', type: 'number', ph: '2000', help: 'Slower than this is reported as slow. Default 2000 ms.' }],
  server: [{ k: 'config.hostname', label: 'Hostname', req: true }, { k: 'config.ip', label: 'IP address' }, { k: 'config.os', label: 'Operating system', ph: 'Ubuntu 22.04' }, { k: 'config.services', label: 'Critical services to watch', ...L, ph: 'nginx,mysql,redis-server', help: 'Alerts when a listed service stops. The platform never restarts services automatically.' }, { k: 'config.thresholds', label: 'Thresholds [warning, critical] (JSON, optional)', type: 'textarea', ...J, ph: '{"cpu":[80,95],"ram":[85,95],"disk":[80,90]}' }, { k: 'config.agent_interval_sec', label: 'Agent report interval (s)', type: 'number', ph: '60' }],
  database: [{ k: 'config.kind', label: 'Database type', type: 'select', options: ['postgres', 'mysql', 'mariadb', 'redis', 'mongodb', 'other'] }, { k: 'config.host', label: 'Host', req: true }, { k: 'config.port', label: 'Port', type: 'number' }, { k: 'secret.password', label: 'Redis password (encrypted, optional)', type: 'password' }],
  domain: [{ k: 'config.domain', label: 'Domain', req: true, ph: 'example.com' }, EXPIRY],
  ssl: [{ k: 'config.host', label: 'Hostname', req: true, ph: 'example.com' }, { k: 'config.port', label: 'Port', type: 'number', def: 443 }, EXPIRY],
  custom: [{ k: 'config.host', label: 'Host', req: true }, { k: 'config.port', label: 'TCP port', type: 'number', req: true }],
};
// Daily check schedule (optional) - appended to every non-server type
const SCHED = [
  { k: 'config.check_times', label: 'Check only at these times each day (optional)', ph: '9:00 AM, 12:00 PM, 3:00 PM, 5:30 PM', list: true, help: 'Leave empty to check continuously. If set, it is checked at these times and you are alerted when something is wrong; while a problem is open it is re-checked every few minutes.' },
  { k: 'config.check_tz_offset_min', label: 'Time zone (minutes from UTC)', type: 'number', def: -new Date().getTimezoneOffset(), help: 'Filled in automatically from your browser. Only used with fixed times.' },
  { k: 'config.recheck_while_down_min', label: 'Re-check while a problem is open (minutes)', type: 'number', def: 5 },
];
for (const t of Object.keys(FIELDS)) if (t !== 'server') FIELDS[t].push(...SCHED);
const RENDER = [
  { k: 'config.render_check', label: 'Also check that the page really displays (opens it in a real browser)', type: 'checkbox', def: true, help: 'Catches a site that answers "OK" but shows a blank or broken page, for example when its JavaScript crashes.' },
  { k: 'config.render_interval_min', label: 'Real-browser check every (minutes)', type: 'number', def: 5 },
];
for (const t of ['website', 'webapp']) FIELDS[t].push(...RENDER);

const get = (o, path) => path.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);
const setp = (o, path, v) => { const ks = path.split('.'); let c = o; ks.slice(0, -1).forEach((k) => { c = c[k] ??= {}; }); c[ks.at(-1)] = v; };

// ---- plain-language form: a few simple questions first, everything technical under "Advanced" ----
const BASIC = { website: ['target'], webapp: ['target'], mobile: ['target'], api: ['target'], server: ['config.hostname', 'config.services'], database: ['config.kind', 'config.host', 'config.port'], domain: ['config.domain'], ssl: ['config.host'], custom: ['config.host', 'config.port'] };
const NICE = {
  target: { website: ['Website address', 'example.com  or  https://example.com'], api: ['API address', 'https://api.example.com/health'], webapp: ['Application address', 'https://app.example.com'], mobile: ['App backend address', 'https://api.example.com/health'] },
  'config.expected_content': ['Alert me if this text is missing from the page (optional)', 'e.g. your company name', 'Catches the case where the page opens but shows an error or a blank screen.'],
  'config.hostname': ['Server name or address', 'web-01.example.com'], 'config.services': ['Services to watch (optional)', 'nginx, mysql', 'Names of programs that must keep running. You are alerted if one stops.'],
  'config.kind': ['Type of database'], 'config.host': { database: ['Database address', 'db.example.com'], ssl: ['Website name', 'example.com', 'We warn you well before its security certificate expires.'], custom: ['Server address', 'example.com'] }, 'config.port': ['Port number'], 'config.domain': ['Domain name', 'example.com', 'We check it resolves and warn you before it expires.'],
};
const IMPORTANCE = [['normal', 'Normal'], ['high', 'Important – alert me as critical'], ['critical', 'Critical – business stops if it is down'], ['low', 'Low – nice to have']];
const FREQ = [['1', 'Every minute', 'Recommended. You are alerted within a minute or two.'], ['5', 'Every 5 minutes', 'A bit lighter on small servers.'], ['15', 'Every 15 minutes', ''], ['times', 'Only at set times each day', 'For example 9 AM, 12 PM, 3 PM and 5:30 PM'], ['custom', 'Custom', 'Set exact seconds under Advanced']];
const LOCAL_RE = /^(localhost|\[::1\]|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i;
export function fixUrl(u) { // "example.com" -> https://example.com ; localhost / IP:port -> http://
  u = String(u || '').trim(); if (!u || /^[a-z][a-z0-9+.-]*:\/\//i.test(u)) return u;
  const host = u.replace(/^\/+/, '').split(/[/?#]/)[0]; return (LOCAL_RE.test(host) || /:\d+$/.test(host) || /\.(local|localhost|internal|lan)$/i.test(host) ? 'http://' : 'https://') + u.replace(/^\/+/, '');
}

export async function assetForm(asset, { type, host, onDone } = {}) {
  const t = asset?.type || type; const projects = await api('/projects'); const users = await api('/users').catch(() => []);
  const vals = asset ? { ...asset, secret: asset.secret_masked || {} } : { interval_sec: ['domain', 'ssl'].includes(t) ? 86400 : 60, timeout_ms: 10000, verify_failures: 2, recover_successes: 1, environment: 'production', criticality: 'normal', secret: {} };
  const basicKeys = BASIC[t]; const showFreq = !['server', 'domain', 'ssl'].includes(t);
  const label = (f) => { let n = NICE[f.k]; if (n && !Array.isArray(n)) n = n[t]; return n ? { ...f, label: n[0], ph: n[1] ?? f.ph, help: n[2] ?? f.help, req: f.req } : f; };
  const fieldVal = (f) => { let v = f.k === 'target' ? vals.target : get(vals, f.k); if (f.list && Array.isArray(v)) v = v.join(', '); return v; };
  const primary = FIELDS[t].filter((f) => basicKeys.includes(f.k)).map(label);
  const timesField = FIELDS[t].find((f) => f.k === 'config.check_times');
  const adv = FIELDS[t].filter((f) => !basicKeys.includes(f.k) && f.k !== 'config.check_times');
  const advCommon = [
    { k: 'category', label: 'Category (optional)', ph: 'e.g. Marketing site' }, { k: 'environment', label: 'Environment', type: 'select', options: ENV },
    ...(t === 'server' ? [] : [{ k: 'interval_sec', label: 'Exact check interval (seconds)', type: 'number', help: 'Only used when "Custom" is chosen above.' }, { k: 'timeout_ms', label: 'Give up waiting after (milliseconds)', type: 'number' }]),
    { k: 'verify_failures', label: 'Failed checks in a row before alerting', type: 'number', help: 'Avoids false alarms: a failed check is re-tested after half a second before an alert is raised. Default 2 (the first check plus one retry).' }, { k: 'recover_successes', label: 'Good checks in a row before marking recovered', type: 'number', help: 'Default 1: the first good check closes the incident.' },
    { k: 'assignee_id', label: 'Person responsible', type: 'select', options: [['', '— nobody —'], ...users.filter((u) => u.role !== 'client' && u.active).map((u) => [u.id, u.name])] },
  ];
  const curFreq = asset ? (asset.config?.check_times?.length ? 'times' : { 60: '1', 300: '5', 900: '15' }[asset.interval_sec] || 'custom') : '1';
  const nameField = { k: 'name', label: 'Name (optional)', ph: 'Leave empty to use the address', help: '' };
  const html = `<div class="simple">
    ${primary.slice(0, 1).map((f) => field(f, fieldVal(f))).join('')}
    ${field(nameField, asset?.name)}
    ${primary.slice(1).map((f) => field(f, fieldVal(f))).join('')}
    ${showFreq ? `<div class="field"><label>How often should we check?</label><div class="opts">${FREQ.map(([v, n, s]) => `<label class="opt"><input type="radio" name="freq" value="${v}" ${v === curFreq ? 'checked' : ''}><span><b>${esc(n)}</b>${s ? `<small>${esc(s)}</small>` : ''}</span></label>`).join('')}</div>
      <div id="timesbox" style="display:${curFreq === 'times' ? 'block' : 'none'};margin-top:10px">${field({ ...timesField, label: 'Check at these times every day', ph: '9:00 AM, 12:00 PM, 3:00 PM, 5:30 PM', help: 'We check only at these times and alert you if anything is wrong. If a problem is found we keep re-checking every few minutes until it is fixed.' }, fieldVal(timesField))}</div></div>` : ''}
    ${field({ k: 'criticality', label: 'How important is it?', type: 'select', options: IMPORTANCE }, vals.criticality)}
    ${projects.length > 1 ? field({ k: 'project_id', label: 'Project', type: 'select', options: projects.map((p) => [p.id, p.name]) }, asset?.project_id) : `<input type="hidden" name="project_id" value="${asset?.project_id ?? projects[0]?.id ?? ''}">`}
    <details class="adv"><summary>Advanced settings <span>optional – most people can skip this</span></summary><div class="fgrid" style="margin-top:14px">${advCommon.map((f) => field(f, vals[f.k])).join('')}${adv.map(label).map((f) => field(f, fieldVal(f))).join('')}</div></details>
    <div class="mut" style="font-size:12px;margin-top:12px">Only add systems you own or are allowed to monitor.</div></div>`;

  const submit = async (f) => {
    const body = { type: t, config: {}, secret: {} };
    for (const k of ['project_id', 'name', 'criticality', 'category', 'environment', 'interval_sec', 'timeout_ms', 'verify_failures', 'recover_successes']) if (f[k] !== undefined && f[k] !== '') body[k] = f[k];
    if (!f.assignee_id) body.assignee_id = null;
    for (const fd of FIELDS[t]) {
      let v = f[fd.k]; if (v === undefined || v === '') continue;
      if (fd.json) { try { v = JSON.parse(v); } catch { throw new Error(`${fd.label}: invalid JSON`); } }
      if (fd.list) v = String(v).split(',').map((x) => x.trim()).filter(Boolean);
      if (fd.type === 'checkbox' && !v && fd.def !== true) continue;
      setp(body, fd.k, v);
    }
    if (showFreq) {
      const fq = f.freq || '1'; const m = { 1: 60, 5: 300, 15: 900 }[fq];
      if (m) body.interval_sec = m;
      if (fq === 'times') { if (!(body.config.check_times || []).length) throw new Error('Enter at least one time, for example 9am, 12pm, 3pm, 5:30pm'); body.interval_sec = 60; }
      else { delete body.config.check_times; delete body.config.check_tz_offset_min; delete body.config.recheck_while_down_min; }
    }
    if (body.target) body.target = fixUrl(body.target);
    if (t === 'server') body.target = body.config.hostname;
    if (!body.name) { const c = body.config; try { body.name = t === 'server' ? c.hostname : t === 'domain' ? c.domain : t === 'ssl' ? c.host : t === 'database' ? `${c.kind} ${c.host}` : t === 'custom' ? `${c.host}:${c.port}` : new URL(body.target).hostname; } catch { /* server reports the problem */ } }
    if (!Object.keys(body.secret).length) delete body.secret;
    if (asset && !body.secret && asset.has_secret) delete body.secret;
    return asset ? (await api(`/assets/${asset.id}`, { method: 'PUT', body }), { id: asset.id }) : api('/assets', { method: 'POST', body });
  };
  const wire = (root) => { $$('[name=freq]', root).forEach((r) => r.addEventListener('change', () => { const b = $('#timesbox', root); if (b) b.style.display = r.value === 'times' && r.checked ? 'block' : 'none'; })); };
  if (host) { // inline (page) mode
    host.innerHTML = `<form id="af">${html}<div class="row mt"><a class="btn ghost" href="#/add">Cancel</a><button class="btn pri">Start monitoring</button></div></form>`; wire(host);
    $('#af', host).addEventListener('submit', async (e) => { e.preventDefault(); const b = $('.btn.pri', host); b.disabled = true; try { const r = await submit(formData($('#af', host))); if (r.agent_token) showAgentInstall(r.agent_token); toast('Added. The first check is running now.', 'ok'); onDone?.(r); } catch (er) { fail(er); b.disabled = false; } });
    return;
  }
  const m = modal(`Edit ${asset.name}`, html, { wide: false, submit: 'Save changes', onSubmit: async (f) => { await submit(f); toast('Saved', 'ok'); onDone?.(); } }); wire(m.el);
}

export function showAgentInstall(token) {
  const cmd = `curl -fsSL ${location.origin}/agent/agent.js -o tgt-agent.js\nTGT_URL=${location.origin} TGT_TOKEN=${token} node tgt-agent.js`;
  modal('Server agent credentials', `<div class="warn" style="margin-bottom:10px">This token is shown only once. Store it securely.</div><label>Agent token</label><div class="mono card" style="word-break:break-all;margin-bottom:10px">${esc(token)}</div><label>Quick start (Linux, Node.js 18+)</label><pre class="mono card" style="white-space:pre-wrap">${esc(cmd)}</pre><div class="mut">Permanent install with systemd: see docs/AGENT.md.</div>`, { wide: true });
}
