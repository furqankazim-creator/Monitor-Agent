import { migrate, db, audit, closeDb } from '../db.js';
import { hashPassword } from '../crypto.js';
import readline from 'node:readline/promises';

migrate();
const arg = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=').slice(1).join('=');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const email = (arg('email') || process.env.ADMIN_EMAIL || (await rl.question('Admin email: '))).trim().toLowerCase();
const name = arg('name') || process.env.ADMIN_NAME || 'Super Administrator';
const pw = arg('password') || process.env.ADMIN_PASSWORD || (await rl.question('Password (min 12 chars): '));
rl.close();
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { console.error('Invalid email'); process.exit(1); }
if (pw.length < 12) { console.error('Password must be at least 12 characters'); process.exit(1); }
const { isWeakPassword } = await import('../weakpw.js'); if (isWeakPassword(pw) && !process.env.ALLOW_WEAK_PASSWORD) { console.error('That password is too easy to guess or is a well-known example. Choose a longer, unique passphrase.'); process.exit(1); }
const ex = db.get('SELECT id FROM users WHERE email=?', email);
if (ex) { db.run("UPDATE users SET password_hash=?, role='super_admin', active=1, failed_logins=0, locked_until=NULL WHERE id=?", hashPassword(pw), ex.id); console.log(`Updated existing user ${email} as super_admin`); }
else { const id = db.insert("INSERT INTO users(email,name,password_hash,role,created_at) VALUES(?,?,?,'super_admin',?)", email, name, hashPassword(pw), Date.now()); audit({ id, email }, 'bootstrap_admin', 'user', id); console.log(`Created super administrator ${email}`); }
await closeDb(); // with MongoDB Atlas: make sure everything is written before this command exits
