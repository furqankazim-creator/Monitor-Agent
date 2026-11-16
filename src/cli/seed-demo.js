// Creates clearly-labelled DEMO data with SIMULATED history. Demo assets are never probed (next_run_at is far future),
// are flagged is_demo=1 and shown with a DEMO badge + banner everywhere. Remove with:  npm run demo -- --clear
import { migrate, db, closeDb } from '../db.js';

migrate();
const clear = process.argv.includes('--clear');
const PROJECT = 'DEMO Project';

function wipe() {
  const demoAssets = "(SELECT id FROM assets WHERE is_demo=1)";
  db.run('DELETE FROM incident_events WHERE incident_id IN (SELECT id FROM incidents WHERE is_demo=1)');
  db.run('DELETE FROM notifications WHERE incident_id IN (SELECT id FROM incidents WHERE is_demo=1)');
  db.run('DELETE FROM incidents WHERE is_demo=1');
  db.run(`DELETE FROM checks WHERE asset_id IN ${demoAssets}`);
  db.run(`DELETE FROM metrics WHERE asset_id IN ${demoAssets}`);
  db.run(`DELETE FROM conditions WHERE asset_id IN ${demoAssets}`);
  db.run('DELETE FROM assets WHERE is_demo=1');
  db.run('DELETE FROM projects WHERE name=? AND id NOT IN (SELECT project_id FROM assets)', PROJECT);
}
wipe();
if (clear) { console.log('Demo data removed'); process.exit(0); }

const t = Date.now(); const FAR = 8.64e15; const STEP = 5 * 60000; const N = 288; // 24 h at 5-minute resolution
const pid = db.insert('INSERT INTO projects(name,description,created_at) VALUES(?,?,?)', PROJECT, 'Simulated data - not real monitoring', t);
const wave = (i, base, amp, noise) => Math.max(1, base + Math.sin(i / 14) * amp + (Math.random() - 0.5) * noise);

function asset(o) {
  const id = db.insert(`INSERT INTO assets(project_id,type,name,target,config,status,status_reason,last_check_at,last_ok_at,last_fail_at,last_response_ms,last_status_code,state,verified,is_demo,next_run_at,interval_sec,criticality,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,1,1,?,?,?,?)`, pid, o.type, o.name, o.target, JSON.stringify(o.config || {}), o.status, o.reason || null, t, o.status === 'down' ? t - 40 * 60000 : t, o.status === 'down' ? t : null, o.ms ?? null, o.code ?? null, JSON.stringify(o.state || {}), FAR, o.interval || 60, o.criticality || 'normal', t - 7 * 86400000);
  if (o.history !== false) {
    db.tx(() => {
      for (let i = N; i > 0; i--) {
        const ts = t - i * STEP; const downNow = o.downLast && i <= o.downLast; const slowNow = o.slow && i <= 30;
        if (downNow) db.run("INSERT INTO checks(asset_id,ts,kind,state,error,confirmed) VALUES(?,?,'check','fail',?,1)", id, ts, 'Connection timeout');
        else db.run("INSERT INTO checks(asset_id,ts,kind,state,response_ms,status_code,confirmed) VALUES(?,?,'check',?,?,200,0)", id, ts, slowNow ? 'slow' : 'ok', slowNow ? wave(i, o.ms * 1.1, 200, 300) : wave(i, o.ms || 150, (o.ms || 150) * 0.25, (o.ms || 150) * 0.3));
      }
    });
  }
  return id;
}
function incident(assetId, o) {
  const first = t - o.agoMin * 60000; const rec = o.durMin ? first + o.durMin * 60000 : null;
  const id = db.insert('INSERT INTO incidents(asset_id,project_id,category,severity,title,description,status,first_detected,last_detected,recovered_at,resolved_at,ack_at,root_cause,resolution_notes,is_demo) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)',
    assetId, pid, o.category, o.severity, o.title, o.description, o.status, first, rec || t, rec, rec, o.ack ? first + 4 * 60000 : null, o.root || null, o.resolution || null);
  for (const [off, type, msg] of o.events) db.run('INSERT INTO incident_events(incident_id,ts,type,message) VALUES(?,?,?,?)', id, first + off * 60000, type, `${msg} (DEMO)`);
  return id;
}

// ---------- assets ----------
asset({ type: 'website', name: 'DEMO Corporate Website', target: 'https://www.demo-company.example/', status: 'operational', ms: 182, code: 200, criticality: 'high' });
asset({ type: 'website', name: 'DEMO Online Shop', target: 'https://shop.demo-company.example/', status: 'operational', ms: 310, code: 200, criticality: 'critical' });
const admin = asset({ type: 'website', name: 'DEMO Admin Portal', target: 'https://admin.demo-company.example/', status: 'down', reason: 'Connection timeout', ms: null, code: null, downLast: 8, criticality: 'critical' });
const orders = asset({ type: 'api', name: 'DEMO Orders API', target: 'https://api.demo-company.example/v1/orders', status: 'slow', reason: 'Slow API response: 1480 ms (expected < 800 ms)', ms: 1480, code: 200, slow: true, config: { method: 'GET', max_response_ms: 800 } });
asset({ type: 'api', name: 'DEMO Auth API', target: 'https://api.demo-company.example/v1/auth/health', status: 'operational', ms: 95, code: 200, config: { method: 'GET' } });
asset({ type: 'mobile', name: 'DEMO Mobile App Backend', target: 'https://mobile.demo-company.example/health', status: 'operational', ms: 140, code: 200, config: { platform: 'both' } });
asset({ type: 'database', name: 'DEMO PostgreSQL (primary)', target: 'postgres://db1.demo-company.example:5432', status: 'operational', ms: 12, config: { kind: 'postgres', host: 'db1.demo-company.example', port: 5432 } });
asset({ type: 'ssl', name: 'DEMO SSL: shop', target: 'shop.demo-company.example:443', status: 'degraded', reason: 'Expires in 12 days', ms: 90, config: { host: 'shop.demo-company.example', port: 443 }, state: { ssl: { daysLeft: 12, validTo: t + 12 * 86400000, issuer: "Let's Encrypt", protocol: 'TLSv1.3' } }, interval: 86400 });
asset({ type: 'domain', name: 'DEMO Domain: demo-company.example', target: 'demo-company.example', status: 'operational', ms: 25, config: { domain: 'demo-company.example' }, state: { ns: 'ns1.dns.example,ns2.dns.example', rdap: { available: true, expiresAt: t + 212 * 86400000 } }, interval: 86400 });

const srv = asset({ type: 'server', name: 'DEMO web-01 (Linux)', target: 'web-01.demo-company.example', status: 'operational', history: false, config: { hostname: 'web-01.demo-company.example', services: ['nginx', 'mysql', 'redis-server'] },
  state: { last_report: { hostname: 'web-01', os: 'Linux 5.15 (demo)', agent_version: '1.0.0', cores: 4, disks: [{ mount: '/', percent: 62.4 }, { mount: '/var/lib/mysql', percent: 81.7 }], services: [{ name: 'nginx', running: true }, { name: 'mysql', running: true }, { name: 'redis-server', running: true }] } } });
db.run('UPDATE assets SET last_heartbeat_at=?, last_response_ms=NULL WHERE id=?', t, srv);
db.tx(() => { for (let i = N; i > 0; i--) { const ts = t - i * STEP;
  db.run("INSERT INTO metrics(asset_id,ts,name,value) VALUES(?,?,'cpu',?)", srv, ts, Math.min(99, wave(i, 38, 22, 12)));
  db.run("INSERT INTO metrics(asset_id,ts,name,value) VALUES(?,?,'ram',?)", srv, ts, Math.min(98, wave(i, 61, 10, 6)));
  db.run("INSERT INTO metrics(asset_id,ts,name,value) VALUES(?,?,'disk',?)", srv, ts, 81.7 + (N - i) * 0.002);
  db.run("INSERT INTO metrics(asset_id,ts,name,value) VALUES(?,?,'load1',?)", srv, ts, wave(i, 1.1, 0.8, 0.5)); } });

// ---------- incidents ----------
incident(admin, { agoMin: 40, category: 'availability', severity: 'critical', status: 'investigating', ack: true, title: 'Website offline', description: 'DEMO: Connection timeout', events: [[0, 'detected', 'Initial detection: Connection timeout'], [1, 'verified', 'Failure verified: 3 consecutive failed checks'], [1, 'alert_unconfigured', 'email alert NOT delivered: SMTP is not configured'], [5, 'escalated', 'Not acknowledged within 5 minutes: escalating to level 2'], [6, 'acknowledged', 'Status changed new → acknowledged'], [12, 'note', 'Note: checking hosting panel, load balancer health check failing']] });
incident(orders, { agoMin: 22, category: 'performance', severity: 'medium', status: 'new', title: 'Degraded performance', description: 'DEMO: Slow API response: 1480 ms (expected < 800 ms)', events: [[0, 'detected', 'Initial detection: Slow API response'], [0, 'verified', 'Failure verified: 4 consecutive slow checks']] });
incident(admin, { agoMin: 60 * 26, durMin: 14, category: 'availability', severity: 'critical', status: 'resolved', ack: true, title: 'Website offline', description: 'DEMO: HTTP 503 Service unavailable', root: 'Deploy exhausted the worker pool (demo)', resolution: 'Rolled back release 2.14.1 (demo)', events: [[0, 'detected', 'Initial detection: HTTP 503'], [1, 'verified', 'Failure verified'], [4, 'acknowledged', 'Acknowledged'], [14, 'recovered', 'Recovery detected automatically after 14 minutes'], [14, 'resolved', 'Incident auto-resolved']] });
incident(orders, { agoMin: 60 * 52, durMin: 9, category: 'api_failure', severity: 'high', status: 'resolved', title: 'API failure', description: 'DEMO: Server error: HTTP 502', root: 'Upstream gateway restart (demo)', events: [[0, 'detected', 'Initial detection: HTTP 502'], [1, 'verified', 'Failure verified'], [9, 'recovered', 'Recovery detected automatically after 9 minutes'], [9, 'resolved', 'Incident auto-resolved']] });

console.log('Demo data created: 10 assets, 24h history, server metrics, 4 incidents (2 open, 2 resolved).');
console.log('Everything is labelled DEMO and is simulated. Remove with:  npm run demo -- --clear');
await closeDb(); // with MongoDB Atlas: make sure everything is written before this command exits
