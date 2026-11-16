import { db, getSetting, setSetting } from './db.js';
import { verifyPassword, sha256 } from './crypto.js';
import { log } from './util.js';

// Passwords that appear in docs/examples/chat transcripts or are on every attacker's first-try list.
export const KNOWN_WEAK = ['a-long-passphrase', 'TGT-Monitor-2026!', 'Sup3rSecret!Pass', 'Correct-Horse-Battery-9', 'password', 'password1', 'password123', 'Password1', 'Password123', 'Password123!', 'admin', 'admin123', 'admin1234', 'Admin123', 'Admin12345!', 'Admin@123', 'administrator', 'letmein', 'qwerty123', 'qwertyuiop', '123456789', '1234567890', '12345678', 'changeme', 'ChangeMe123!', 'welcome1', 'Welcome123', 'iloveyou', 'monitor123', 'Monitor123!', 'timeglobaltech', 'TimeGlobalTech1!', 'passw0rd', 'Passw0rd!'];
const LOWER = new Set(KNOWN_WEAK.map((p) => p.toLowerCase()));

/** Plain-text check (used when we legitimately hold the password: login, change, create). */
export function isWeakPassword(pw) {
  const p = String(pw || ''); const l = p.toLowerCase();
  if (p.length < 12) return true;
  if (LOWER.has(l)) return true;
  if (/^(.)\1+$/.test(p)) return true;                                   // aaaaaaaaaaaa
  if (/^(0123456789|1234567890|abcdefghij|qwertyuiop)/i.test(p)) return true; // keyboard / number runs
  if (new Set(p).size < 6) return true;
  return false;
}
export const setWeakFlag = (userId, weak) => setSetting(`weakpw:${userId}`, weak ? '1' : '');
export const hasWeakFlag = (userId) => getSetting(`weakpw:${userId}`) === '1';

/** Existing accounts (created before this check existed) are tested against the known list ONCE per password hash, never re-hashed again. */
export async function auditWeakPasswords() {
  let flagged = 0; const tick = () => new Promise((r) => setImmediate(r)); // let the checker and web requests run between hashes (each hash is ~70 ms of CPU)
  for (const u of db.all('SELECT id, email, password_hash FROM users WHERE active=1')) {
    const stamp = sha256(u.password_hash).slice(0, 16); if (getSetting(`weakpw_seen:${u.id}`) === stamp) continue;
    let hit = null; for (const g of KNOWN_WEAK) { if (verifyPassword(g, u.password_hash)) { hit = g; break; } await tick(); }
    setWeakFlag(u.id, !!hit); setSetting(`weakpw_seen:${u.id}`, stamp); if (hit) { flagged++; log('warn', 'account uses a known/guessable password', { user: u.email }); }
  }
  return flagged;
}
