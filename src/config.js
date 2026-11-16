import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* no .env file: rely on real env */ }

const env = process.env;
const bool = (v, d = false) => (v === undefined || v === '' ? d : ['1', 'true', 'yes'].includes(String(v).toLowerCase()));
const int = (v, d) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : d);

export const config = {
  env: env.NODE_ENV || 'development',
  port: int(env.PORT, 3000),
  baseUrl: (env.BASE_URL || `http://localhost:${int(env.PORT, 3000)}`).replace(/\/$/, ''),
  dataDir: env.DATA_DIR ? path.resolve(ROOT, env.DATA_DIR) : (env.VERCEL ? '/tmp/tgt-data' : path.resolve(ROOT, 'data')),
  dbFile: env.DB_FILE || '',
  mongoUri: env.MONGODB_URI || '', // MongoDB Atlas connection string. Empty = use the local SQLite file
  encryptionKey: env.ENCRYPTION_KEY || '',
  cookieSecure: bool(env.COOKIE_SECURE, env.NODE_ENV === 'production'),
  trustProxy: bool(env.TRUST_PROXY, !!env.VERCEL),
  sessionHours: int(env.SESSION_HOURS, 12),
  // SSRF / authorized-target policy
  allowPrivateTargets: bool(env.ALLOW_PRIVATE_TARGETS, false),
  allowedHosts: (env.ALLOWED_HOSTS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  // scheduler
  loginRateLimit: int(env.LOGIN_RATE_LIMIT, 10), // login attempts per minute per IP
  maxConcurrency: int(env.MAX_CONCURRENCY, 20),
  retentionDays: int(env.RETENTION_DAYS, 90),
  defaultRetryDelaySec: int(env.RETRY_DELAY_SEC, 10),
  // remote verification probes (other deployments of this app)
  probeToken: env.PROBE_TOKEN || '',
  remoteProbes: (env.REMOTE_PROBE_URLS || '').split(',').map((s) => s.trim()).filter(Boolean),
  // email
  smtp: { host: env.SMTP_HOST || '', port: int(env.SMTP_PORT, 587), user: env.SMTP_USER || '', pass: env.SMTP_PASS || '', secure: bool(env.SMTP_SECURE, false), from: env.SMTP_FROM || 'Time Global Tech Monitor <monitor@localhost>' },
  // whatsapp cloud api
  wa: { phoneNumberId: env.WA_PHONE_NUMBER_ID || '', token: env.WA_ACCESS_TOKEN || '', verifyToken: env.WA_VERIFY_TOKEN || '', appSecret: env.WA_APP_SECRET || '', template: env.WA_ALERT_TEMPLATE || '', templateLang: env.WA_TEMPLATE_LANG || 'en', apiVersion: env.WA_API_VERSION || 'v21.0' },
  push: { server: env.PUSH_SERVER || 'https://ntfy.sh', token: env.PUSH_TOKEN || '' },
  heartbeatUrl: env.HEARTBEAT_URL || '', // external watchdog: pinged every minute while the checker is alive
  renderWaitMs: parseInt(env.RENDER_WAIT_MS || '15000', 10), // how long a page may stay empty before it counts as blank
  renderEnabled: env.VERCEL ? bool(env.RENDER_CHECKS, false) : String(env.RENDER_CHECKS || 'on').toLowerCase() !== 'off', // real-browser checks off on serverless unless explicitly enabled
  metricsToken: env.METRICS_TOKEN || '',
  demoEnabled: bool(env.ENABLE_DEMO, false),
};
try { fs.mkdirSync(config.dataDir, { recursive: true }); } catch { /* read-only filesystem */ }
