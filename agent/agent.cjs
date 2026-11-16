#!/usr/bin/env node
/**
 * Time Global Tech Monitor - Enterprise Server Agent (Pro)
 * Zero runtime dependencies (Node >= 18).
 * Read-only, secure execFile execution, HTTPS push.
 *
 * CLI:
 *   node agent.js --test             # One-shot dry-run: prints metrics & verifies connectivity
 *   node agent.js --config <path>    # Load configuration from JSON file
 */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const run = promisify(execFile);
const args = process.argv.slice(2);
const isTestMode = args.includes('--test') || args.includes('--dry-run');

// 1. Config loading: CLI flag > File > Environment
let fileConfig = {};
const cfgIdx = args.indexOf('--config');
const cfgPath = cfgIdx !== -1 ? args[cfgIdx + 1] : '/etc/tgt-agent.json';
if (fs.existsSync(cfgPath)) {
  try { fileConfig = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch (e) {
    console.error(`[agent] Warning: Failed to parse ${cfgPath}:`, e.message);
  }
}

const URL_ = (process.env.TGT_URL || fileConfig.url || '').replace(/\/$/, '');
const TOKEN = process.env.TGT_TOKEN || fileConfig.token || '';
let interval = Math.max(10, +(process.env.TGT_INTERVAL || fileConfig.interval || 60));
let services = (process.env.TGT_SERVICES || fileConfig.services || '').split(',').map((s) => s.trim()).filter(Boolean);
const VERSION = '2.0.0-pro';

if (process.env.TGT_INSECURE === '1' || fileConfig.insecure) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

if (!URL_ || !TOKEN) {
  console.error('[agent] Error: TGT_URL and TGT_TOKEN are required.');
  console.error('Usage: TGT_URL=https://... TGT_TOKEN=tgtm_... node agent.js [--test]');
  process.exit(1);
}

try {
  const u = new URL(URL_);
  if (!/^https?:$/.test(u.protocol)) throw new Error('Protocol must be http or https');
} catch (e) {
  console.error(`[agent] Invalid TGT_URL "${URL_}":`, e.message);
  process.exit(1);
}

const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const SAFE_NAME = /^[A-Za-z0-9_.@:-]{1,64}$/;

let prevCpu = null;
let prevNet = null;
let prevIo = null;

// --- 1. Enhanced CPU Breakdown (User, System, Idle, IOWait, Steal) ---
function cpuMetrics() {
  const s = read('/proc/stat');
  let idle, total, user, system, iowait, steal;
  if (s) {
    const p = s.split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
    user = (p[0] || 0) + (p[1] || 0); // user + nice
    system = p[2] || 0;
    idle = p[3] || 0;
    iowait = p[4] || 0;
    steal = p[7] || 0;
    total = user + system + idle + iowait + (p[5] || 0) + (p[6] || 0) + steal;
  } else {
    const c = os.cpus().reduce((a, x) => {
      for (const k in x.times) a.t += x.times[k];
      a.i += x.times.idle;
      a.u += x.times.user;
      a.s += x.times.sys;
      return a;
    }, { t: 0, i: 0, u: 0, s: 0 });
    user = c.u; system = c.s; idle = c.i; iowait = 0; steal = 0; total = c.t;
  }
  const prev = prevCpu;
  prevCpu = { idle, total, user, system, iowait, steal };
  if (!prev) return { cpu_percent: null };
  const dt = total - prev.total;
  if (dt <= 0) return { cpu_percent: null };
  return {
    cpu_percent: +Math.max(0, Math.min(100, (1 - (idle - prev.idle) / dt) * 100)).toFixed(1),
    cpu_user: +Math.max(0, Math.min(100, ((user - prev.user) / dt) * 100)).toFixed(1),
    cpu_system: +Math.max(0, Math.min(100, ((system - prev.system) / dt) * 100)).toFixed(1),
    cpu_iowait: +Math.max(0, Math.min(100, ((iowait - prev.iowait) / dt) * 100)).toFixed(1),
    cpu_steal: +Math.max(0, Math.min(100, ((steal - prev.steal) / dt) * 100)).toFixed(1)
  };
}

// --- 2. Memory with Container Fallback ---
function memory() {
  const m = read('/proc/meminfo');
  if (m) {
    const g = (k) => +(m.match(new RegExp(`^${k}:\\s+(\\d+)`, 'm')) || [0, 0])[1];
    const total = g('MemTotal');
    let avail = g('MemAvailable') || (g('MemFree') + g('Buffers') + g('Cached') + g('SReclaimable') - g('Shmem'));
    avail = Math.max(0, avail);
    return {
      ram_percent: total ? +Math.max(0, Math.min(100, ((total - avail) / total) * 100)).toFixed(1) : null,
      ram_available_mb: +(avail / 1024).toFixed(1)
    };
  }
  return {
    ram_percent: +(((os.totalmem() - os.freemem()) / os.totalmem()) * 100).toFixed(1),
    ram_available_mb: +(os.freemem() / 1048576).toFixed(1)
  };
}

// --- 3. Top 5 CPU & RAM Processes for Instant Diagnosis ---
async function topProcesses() {
  try {
    const { stdout } = await run('ps', ['-axo', 'pid,pcpu,pmem,user,comm', '--sort=-pcpu'], { timeout: 3000 });
    const lines = stdout.trim().split('\n').slice(1, 6);
    return lines.map((l) => {
      const parts = l.trim().split(/\s+/);
      return {
        pid: +parts[0],
        cpu: parseFloat(parts[1]) || 0,
        ram: parseFloat(parts[2]) || 0,
        user: parts[3] || '',
        command: parts.slice(4).join(' ') || ''
      };
    });
  } catch {
    return [];
  }
}

// --- 4. Disks (Multi-mount, APFS-aware, LVM, NVMe) ---
async function disks() {
  try {
    const { stdout } = await run('df', ['-P', '-k'], { timeout: 8000, killSignal: 'SIGKILL' });
    const isMac = process.platform === 'darwin';
    return stdout.split('\n').slice(1)
      .map((l) => l.trim().split(/\s+/))
      .filter((c) => {
        if (c.length < 6) return false;
        const mount = c.slice(5).join(' ');
        if (/^\/(dev|proc|sys|snap|boot\/efi)/.test(mount)) return false;
        if (isMac && mount === '/') return false;
        return /^\/dev\//.test(c[0]) || mount === '/' || (isMac && mount.startsWith('/System/Volumes/Data'));
      })
      .map((c) => ({
        mount: c.slice(5).join(' '),
        percent: parseFloat(c[4]),
        total_gb: +(c[1] / 1048576).toFixed(1),
        used_gb: +(c[2] / 1048576).toFixed(1)
      }))
      .filter((d) => Number.isFinite(d.percent));
  } catch {
    return [];
  }
}

// --- 5. Docker Daemon Status via Unix Socket (Zero Dependency) ---
function dockerStats() {
  return new Promise((resolve) => {
    const sock = '/var/run/docker.sock';
    if (!fs.existsSync(sock)) return resolve(null);
    const req = http.request({ socketPath: sock, path: '/containers/json?all=1', method: 'GET', timeout: 2500 }, (res) => {
      let raw = '';
      res.on('data', (d) => { raw += d; });
      res.on('end', () => {
        try {
          const list = JSON.parse(raw);
          if (!Array.isArray(list)) return resolve(null);
          const running = list.filter((c) => c.State === 'running').length;
          resolve({ available: true, total: list.length, running, stopped: list.length - running });
        } catch { resolve({ available: true, total: 0, running: 0, stopped: 0 }); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// --- 6. Network & Disk IO Counters ---
function network() {
  const n = read('/proc/net/dev');
  if (!n) return {};
  let rx = 0, tx = 0, errs = 0;
  for (const l of n.split('\n').slice(2)) {
    const [name, rest] = l.split(':');
    if (!rest) continue;
    const iface = name.trim();
    if (iface === 'lo' || /^(docker\d+|veth.*|br-.*|cni.*|flannel.*|cali.*|tun\d+|wg\d+)$/.test(iface)) continue;
    const p = rest.trim().split(/\s+/).map(Number);
    rx += p[0] || 0; errs += (p[2] || 0) + (p[10] || 0); tx += p[8] || 0;
  }
  const prev = prevNet; prevNet = { rx, tx, errs };
  return prev ? {
    net_rx_bytes: Math.max(0, rx - prev.rx),
    net_tx_bytes: Math.max(0, tx - prev.tx),
    net_errors: Math.max(0, errs - prev.errs)
  } : {};
}

function diskIo() {
  const d = read('/proc/diskstats');
  if (!d) return {};
  let r = 0, w = 0;
  for (const l of d.split('\n')) {
    const p = l.trim().split(/\s+/);
    if (p.length > 9 && /^(sd[a-z]+|vd[a-z]+|nvme\d+n\d+|xvd[a-z]+|mmcblk\d+|dm-\d+)$/.test(p[2])) {
      r += +p[5] * 512; w += +p[9] * 512;
    }
  }
  const prev = prevIo; prevIo = { r, w };
  return prev ? {
    disk_read_bytes: Math.max(0, r - prev.r),
    disk_write_bytes: Math.max(0, w - prev.w)
  } : {};
}

// --- 7. Temperature (hwmon + thermal) ---
function temperature() {
  try {
    const hwmon = '/sys/class/hwmon';
    if (fs.existsSync(hwmon)) {
      const temps = [];
      for (const h of fs.readdirSync(hwmon)) {
        const hDir = `${hwmon}/${h}`;
        try {
          const files = fs.readdirSync(hDir).filter((f) => /^temp\d+_input$/.test(f));
          for (const f of files) {
            const v = +read(`${hDir}/${f}`);
            if (v > 0 && v < 150000) temps.push(v / 1000);
          }
        } catch {}
      }
      if (temps.length) return { temp_c: Math.round(Math.max(...temps)) };
    }
    const dir = '/sys/class/thermal';
    if (fs.existsSync(dir)) {
      const zs = fs.readdirSync(dir).filter((z) => z.startsWith('thermal_zone'));
      const v = zs.map((z) => +read(`${dir}/${z}/temp`)).filter((x) => x > 0 && x < 150000);
      if (v.length) return { temp_c: Math.round(Math.max(...v) / 1000) };
    }
  } catch {}
  return {};
}

// --- 8. Host Security / Integrity Flags ---
function hostIntegrity() {
  return {
    reboot_required: fs.existsSync('/var/run/reboot-required'),
  };
}

// --- 9. Parallel Service Checks ---
async function checkSingleService(name) {
  try {
    const { stdout } = await run('systemctl', ['is-active', name], { timeout: 3500 });
    return { name, running: stdout.trim() === 'active' };
  } catch {
    try {
      await run('pgrep', ['-f', name.replace(/\.service$/, '')], { timeout: 2000 });
      return { name, running: true };
    } catch {
      return { name, running: false };
    }
  }
}

async function serviceStates() {
  const target = services.filter((s) => SAFE_NAME.test(s)).slice(0, 64);
  return Promise.all(target.map(checkSingleService));
}

// --- 10. Collector & Reporter ---
async function gatherPayload() {
  const [la, up] = [os.loadavg(), read('/proc/uptime')];
  return {
    agent_version: VERSION,
    hostname: os.hostname(),
    os: `${os.type()} ${os.release()}`,
    cores: os.cpus().length,
    ...cpuMetrics(),
    ...memory(),
    load1: la[0],
    load5: la[1],
    load15: la[2],
    uptime_s: up ? +up.split(' ')[0] : os.uptime(),
    disks: await disks(),
    ...network(),
    ...diskIo(),
    ...temperature(),
    ...hostIntegrity(),
    services: await serviceStates(),
    top_processes: await topProcesses(),
    docker: await dockerStats()
  };
}

async function send(payload) {
  const res = await fetch(`${URL_}/api/agent/ingest`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`Server returned HTTP ${res.status}`);
  const j = await res.json();
  if (j.interval_sec) interval = Math.max(10, j.interval_sec);
  if (Array.isArray(j.services)) services = j.services;
}

// --- 11. Run Modes ---
async function runTestMode() {
  console.log(`\n🔍 --- [TGT Monitor Agent ${VERSION} Diagnostics] ---`);
  console.log(`Endpoint: ${URL_}/api/agent/ingest`);
  console.log(`Hostname: ${os.hostname()} (${os.type()} ${os.release()}, ${os.cpus().length} cores)\n`);
  
  cpuMetrics(); network(); diskIo();
  await new Promise((r) => setTimeout(r, 1000));
  
  const payload = await gatherPayload();
  console.log('📊 Collected Payload:');
  console.log(JSON.stringify(payload, null, 2));

  console.log('\n📡 Testing API Connectivity...');
  try {
    await send(payload);
    console.log('✅ Success: Authenticated and payload accepted by monitoring server.\n');
    process.exit(0);
  } catch (e) {
    console.error('❌ Ingest Failed:', e.cause?.message || e.message);
    process.exit(1);
  }
}

async function loop() {
  for (;;) {
    try {
      const payload = await gatherPayload();
      await send(payload);
      console.log(new Date().toISOString(), `Reported (CPU: ${payload.cpu_percent ?? 0}%, RAM: ${payload.ram_percent ?? 0}%)`);
    } catch (e) {
      console.error(new Date().toISOString(), 'Report failed:', e.cause?.message || e.message);
    }
    await new Promise((r) => setTimeout(r, interval * 1000));
  }
}

// --- Startup ---
process.on('SIGTERM', () => { console.log('Shutting down agent.'); process.exit(0); });
process.on('SIGINT', () => { console.log('Shutting down agent.'); process.exit(0); });

if (isTestMode) {
  runTestMode();
} else {
  cpuMetrics(); network(); diskIo();
  setTimeout(loop, 1000);
}
