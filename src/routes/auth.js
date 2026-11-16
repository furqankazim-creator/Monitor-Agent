import { Router } from 'express';
import { db, audit } from '../db.js';
import { hashPassword, verifyPassword, encrypt, decrypt, newTotpSecret, verifyTotp } from '../crypto.js';
import { createSession, clearSession, requireAuth, rateLimit } from '../auth.js';
import { HttpError } from '../util.js';
import { config } from '../config.js';
import { isWeakPassword, setWeakFlag, hasWeakFlag } from '../weakpw.js';

export const router = Router();
const DUMMY = hashPassword('dummy-password-for-timing');

router.post('/login', rateLimit('login', config.loginRateLimit, 60000), (req, res) => {
  const { email, password, totp } = req.body || {};
  const u = db.get('SELECT * FROM users WHERE email=? AND active=1', String(email || '').trim());
  if (u?.locked_until && u.locked_until > Date.now()) throw new HttpError(429, 'Account temporarily locked after repeated failures. Try again later.');
  const ok = verifyPassword(String(password || ''), u ? u.password_hash : DUMMY) && !!u;
  if (!ok) {
    if (u) { const f = u.failed_logins + 1; db.run('UPDATE users SET failed_logins=?, locked_until=? WHERE id=?', f, f >= 5 ? Date.now() + 15 * 60000 : null, u.id); }
    audit(u, 'login_failed', 'user', u?.id, String(email).slice(0, 100), req.ip);
    throw new HttpError(401, 'Invalid email or password');
  }
  if (u.totp_enabled) {
    if (!totp) return res.status(200).json({ needs_totp: true });
    if (!verifyTotp(decrypt(u.totp_secret_enc), totp)) { audit(u, 'login_2fa_failed', 'user', u.id, null, req.ip); throw new HttpError(401, 'Invalid two-factor code'); }
  }
  db.run('UPDATE users SET failed_logins=0, locked_until=NULL WHERE id=?', u.id);
  setWeakFlag(u.id, isWeakPassword(String(password))); // we hold the plaintext right now: remember whether it is a known/guessable one
  createSession(res, u.id, req); audit(u, 'login', 'user', u.id, null, req.ip);
  res.json({ ok: true });
});
router.post('/logout', (req, res) => { if (req.sessionHash) db.run('DELETE FROM sessions WHERE token_hash=?', req.sessionHash); clearSession(res); res.json({ ok: true }); });
router.get('/me', requireAuth, (req, res) => res.json({ user: { ...req.user, weak_password: hasWeakFlag(req.user.id) } }));
router.post('/password', requireAuth, rateLimit('pw', 5, 60000, (r) => r.user?.id), (req, res) => {
  const { current, next } = req.body || {}; const u = db.get('SELECT * FROM users WHERE id=?', req.user.id);
  if (!verifyPassword(String(current || ''), u.password_hash)) throw new HttpError(400, 'Current password is incorrect');
  if (String(next || '').length < 12) throw new HttpError(400, 'New password must be at least 12 characters');
  if (isWeakPassword(next)) throw new HttpError(400, 'That password is too easy to guess or is a well-known example. Use a longer, unique passphrase (e.g. four random words and a number).');
  db.run('UPDATE users SET password_hash=? WHERE id=?', hashPassword(next), u.id); setWeakFlag(u.id, isWeakPassword(next));
  db.run('DELETE FROM sessions WHERE user_id=? AND token_hash!=?', u.id, req.sessionHash); audit(req.user, 'password_change', 'user', u.id, null, req.ip);
  res.json({ ok: true });
});
router.post('/2fa/setup', requireAuth, (req, res) => {
  const secret = newTotpSecret(); db.run('UPDATE users SET totp_secret_enc=?, totp_enabled=0 WHERE id=?', encrypt(secret), req.user.id);
  res.json({ secret, otpauth: `otpauth://totp/TimeGlobalTechMonitor:${encodeURIComponent(req.user.email)}?secret=${secret}&issuer=TimeGlobalTechMonitor` });
});
router.post('/2fa/enable', requireAuth, (req, res) => {
  const u = db.get('SELECT totp_secret_enc FROM users WHERE id=?', req.user.id);
  if (!u.totp_secret_enc || !verifyTotp(decrypt(u.totp_secret_enc), req.body?.code)) throw new HttpError(400, 'Invalid code');
  db.run('UPDATE users SET totp_enabled=1 WHERE id=?', req.user.id); audit(req.user, '2fa_enabled', 'user', req.user.id, null, req.ip); res.json({ ok: true });
});
router.post('/2fa/disable', requireAuth, (req, res) => {
  const u = db.get('SELECT * FROM users WHERE id=?', req.user.id);
  if (!verifyPassword(String(req.body?.password || ''), u.password_hash)) throw new HttpError(400, 'Password incorrect');
  db.run('UPDATE users SET totp_enabled=0, totp_secret_enc=NULL WHERE id=?', u.id); audit(req.user, '2fa_disabled', 'user', u.id, null, req.ip); res.json({ ok: true });
});
