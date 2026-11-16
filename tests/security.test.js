import { startApp, seed } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';

const S = await seed(); const { db } = S;
const { isWeakPassword, auditWeakPasswords, hasWeakFlag } = await import('../src/weakpw.js');
const { hashPassword } = await import('../src/crypto.js');
const app = await startApp();
test.after(() => app.close());
const login = async (email, pw) => { const c = app.mk(); const r = await c.post('/api/auth/login', { email, password: pw }); return { c, r }; };
const addUser = (email, pw) => db.insert("INSERT INTO users(email,name,password_hash,role,created_at) VALUES(?,?,?,'admin',?)", email, email, hashPassword(pw), Date.now());

test('known / guessable passwords are recognised; strong unique passphrases are not', () => {
  for (const w of ['a-long-passphrase', 'TGT-Monitor-2026!', 'Password123!', 'short1', 'aaaaaaaaaaaaaa', '1234567890123', 'qwertyuiopasdf', 'ChangeMe123!']) assert.equal(isWeakPassword(w), true, w);
  for (const s of ['plum-tractor-signal-47-lantern', 'Vq8#mTz2-kLp9!wRx', 'my-dog-eats-green-apples-2031']) assert.equal(isWeakPassword(s), false, s);
});

test('signing in with a documented password raises the warning flag; the account still works (so you can change it)', async () => {
  const { c, r } = await login('adminA@t.io', S.password); assert.equal(r.status, 200); // seed password "Correct-Horse-Battery-9" is a documented example
  const me = await c.get('/api/auth/me'); assert.equal(me.json.user.weak_password, true);
});

test('changing to another weak password is refused; a strong one clears the warning everywhere', async () => {
  const { c } = await login('adminA@t.io', S.password);
  const bad = await c.post('/api/auth/password', { current: S.password, next: 'Password123!' }); assert.equal(bad.status, 400); assert.match(bad.json.error, /too easy to guess/);
  assert.equal((await c.get('/api/auth/me')).json.user.weak_password, true, 'still flagged after a refused change');
  const good = await c.post('/api/auth/password', { current: S.password, next: 'plum-tractor-signal-47-lantern' }); assert.equal(good.status, 200, good.text);
  const c2 = (await login('adminA@t.io', 'plum-tractor-signal-47-lantern')).c; assert.equal((await c2.get('/api/auth/me')).json.user.weak_password, false);
});

test('creating or resetting a user with a weak password is refused', async () => {
  const sup = (await login('super@t.io', S.password)).c;
  assert.equal((await sup.post('/api/users', { email: 'weak@t.io', name: 'w', role: 'technician', password: 'TGT-Monitor-2026!', projects: [S.projA] })).status, 400);
  const ok = await sup.post('/api/users', { email: 'strong@t.io', name: 's', role: 'technician', password: 'Vq8#mTz2-kLp9!wRx', projects: [S.projA] }); assert.equal(ok.status, 200, ok.text);
  assert.equal((await sup.put(`/api/users/${ok.json.id}`, { name: 's', role: 'technician', projects: [S.projA], password: 'a-long-passphrase' })).status, 400);
});

test('startup audit finds EXISTING accounts that already use a documented password (without anyone signing in), once per password', async () => {
  const id = addUser('legacy@t.io', 'a-long-passphrase'); const ok = addUser('fine@t.io', 'plum-tractor-signal-47-lantern');
  assert.ok((await auditWeakPasswords()) >= 1); assert.equal(hasWeakFlag(id), true); assert.equal(hasWeakFlag(ok), false);
  assert.equal(await auditWeakPasswords(), 0, 'already checked: not re-hashed on every start');
  db.run('UPDATE users SET password_hash=? WHERE id=?', hashPassword('plum-tractor-signal-47-lantern'), id); await auditWeakPasswords(); assert.equal(hasWeakFlag(id), false, 'a new password is re-checked');
});
