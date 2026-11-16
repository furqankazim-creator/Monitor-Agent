import { Router } from 'express';
import nodemailer from 'nodemailer';
import { db, audit, getSetting, setSetting } from '../db.js';
import { requireRole, scope, canSeeProject, visibleProjects } from '../auth.js';
import { HttpError, safeJson } from '../util.js';
import { encryptJson, decryptJson } from '../crypto.js';
import { smtpConfig, waConfig, requeueUnconfigured, verifyWaSignature, applyWaStatuses, brandedHtml, mask, integrationStatus, pushConfig, sendPushRaw, watchdogUrl, pingWatchdog } from '../notify.js';
import { config } from '../config.js';

export const router = Router();
export const webhookRouter = Router();
const str = (v, m = 200) => String(v ?? '').trim().slice(0, m);

// ---------- recipients ----------
router.get('/recipients', requireRole('admin'), (req, res) => {
  const s = scope(req.user, 'r.project_id'); const global = req.user.role === 'super_admin' ? ' OR r.project_id IS NULL' : '';
  res.json(db.all(`SELECT r.*, p.name AS project_name FROM recipients r LEFT JOIN projects p ON p.id=r.project_id WHERE (${s.sql}${global}) ORDER BY r.project_id, r.level, r.id`, ...s.params));
});
router.post('/recipients', requireRole('admin'), (req, res) => {
  const b = req.body; const pid = b.project_id ? Number(b.project_id) : null;
  if (pid === null && req.user.role !== 'super_admin') throw new HttpError(403, 'Only super administrators can add global recipients');
  if (pid !== null && !canSeeProject(req.user, pid)) throw new HttpError(403, 'Not permitted for this project');
  const channel = b.channel; if (!['email', 'whatsapp', 'push'].includes(channel)) throw new HttpError(400, 'Channel must be email, whatsapp or push');
  let address = str(b.address, 120);
  if (channel === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) throw new HttpError(400, 'Invalid email address');
  if (channel === 'whatsapp') { address = address.replace(/[^\d]/g, ''); if (!/^\d{8,15}$/.test(address)) throw new HttpError(400, 'WhatsApp number must be in international format (digits only, e.g. 9715XXXXXXXX)'); if (!b.consent) throw new HttpError(400, 'Recipient opt-in consent must be confirmed for WhatsApp messaging'); }
  if (channel === 'push' && !/^[A-Za-z0-9_-]{10,64}$/.test(address)) throw new HttpError(400, 'Push topic must be 10-64 letters, numbers, - or _ and hard to guess (use the Generate button). Anyone who knows the topic can read your alerts.');
  const sev = ['informational', 'low', 'medium', 'high', 'critical'].includes(b.min_severity) ? b.min_severity : 'low';
  const id = db.insert('INSERT INTO recipients(project_id,name,channel,address,level,min_severity,recovery,daily_summary,weekly_report,monthly_report,consent,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', pid, str(b.name, 100), channel, address, Math.min(3, Math.max(1, +b.level || 1)), sev, b.recovery === false ? 0 : 1, b.daily_summary ? 1 : 0, b.weekly_report ? 1 : 0, b.monthly_report ? 1 : 0, ['whatsapp', 'push'].includes(channel) ? 1 : (b.consent ? 1 : 0), Date.now());
  audit(req.user, 'recipient_create', 'recipient', id, `${channel}:${mask(address)}`, req.ip); res.json({ id });
});
router.put('/recipients/:id', requireRole('admin'), (req, res) => {
  const r = db.get('SELECT * FROM recipients WHERE id=?', req.params.id); if (!r || (r.project_id ? !canSeeProject(req.user, r.project_id) : req.user.role !== 'super_admin')) throw new HttpError(404, 'Not found'); const b = req.body;
  db.run('UPDATE recipients SET name=?, level=?, min_severity=?, recovery=?, daily_summary=?, weekly_report=?, monthly_report=?, active=? WHERE id=?', str(b.name, 100), Math.min(3, Math.max(1, +b.level || r.level)), ['informational', 'low', 'medium', 'high', 'critical'].includes(b.min_severity) ? b.min_severity : r.min_severity, b.recovery === false ? 0 : 1, b.daily_summary ? 1 : 0, b.weekly_report ? 1 : 0, b.monthly_report ? 1 : 0, b.active === false ? 0 : 1, r.id);
  audit(req.user, 'recipient_update', 'recipient', r.id, null, req.ip); res.json({ ok: true });
});
router.delete('/recipients/:id', requireRole('admin'), (req, res) => {
  const r = db.get('SELECT * FROM recipients WHERE id=?', req.params.id); if (!r || (r.project_id ? !canSeeProject(req.user, r.project_id) : req.user.role !== 'super_admin')) throw new HttpError(404, 'Not found');
  db.run('DELETE FROM recipients WHERE id=?', r.id); audit(req.user, 'recipient_delete', 'recipient', r.id, null, req.ip); res.json({ ok: true });
});

// ---------- delivery log ----------
router.get('/notifications', requireRole('technician'), (req, res) => {
  const s = scope(req.user, 'n.project_id'); const w = [s.sql]; const p = [...s.params];
  if (req.query.status) { w.push('n.status=?'); p.push(req.query.status); }
  res.json(db.all(`SELECT n.id,n.incident_id,n.channel,n.recipient,n.kind,n.status,n.attempts,n.last_error,n.created_at,n.sent_at FROM notifications n WHERE ${w.join(' AND ')} ORDER BY n.id DESC LIMIT 200`, ...p).map((n) => ({ ...n, recipient: mask(n.recipient) })));
});
router.post('/notifications/:id/retry', requireRole('admin'), (req, res) => {
  const n = db.get('SELECT * FROM notifications WHERE id=?', req.params.id); if (!n || !canSeeProject(req.user, n.project_id)) throw new HttpError(404, 'Not found');
  if (!['failed', 'unconfigured'].includes(n.status)) throw new HttpError(400, 'Only failed or unconfigured notifications can be retried');
  db.run("UPDATE notifications SET status='pending', attempts=0, next_attempt_at=? WHERE id=?", Date.now(), n.id); res.json({ ok: true });
});

// ---------- integrations (super admin) ----------
router.get('/integrations', requireRole('admin'), (req, res) => {
  const smtp = smtpConfig(); const wa = waConfig(); const sw = decryptJson(getSetting('integration.smtp')); const ww = decryptJson(getSetting('integration.whatsapp'));
  res.json({
    email: { configured: !!smtp, source: sw ? 'database' : smtp ? 'environment' : null, host: smtp?.host || '', port: smtp?.port || 587, user: smtp?.user || '', from: smtp?.from || '', secure: !!smtp?.secure, has_password: !!smtp?.pass, setup: 'Set SMTP host/port/user/password (Amazon SES SMTP, Gmail app password, SendGrid, etc.) below or via SMTP_* environment variables, then send a test email.' },
    whatsapp: { configured: !!wa, source: ww ? 'database' : wa ? 'environment' : null, phone_number_id: wa?.phoneNumberId || '', template: wa?.template || '', template_lang: wa?.templateLang || 'en', has_token: !!wa?.token, has_app_secret: !!wa?.appSecret, verify_token_set: !!wa?.verifyToken, webhook_url: `${config.baseUrl}/api/webhooks/whatsapp`,
      setup: 'Create a Meta Business app with WhatsApp Cloud API, copy the Phone Number ID and a permanent System User access token. Create + get approved an alert template (body with 6 variables), set the webhook callback URL and verify token in Meta. Recipients must have opted in; free-form text only works inside the 24-hour customer-service window, so use an approved template for alerts.' },
    push: { configured: true, server: pushConfig().server, custom_server: pushConfig().custom, has_token: !!pushConfig().token, setup: 'Free phone alerts with the ntfy app (iPhone/Android). Nothing to sign up for: install the app, subscribe to your own private topic, then add that topic under Alerts as a "Phone push" recipient. Alert text passes through the ntfy server (ntfy.sh by default, or your own); keep the topic secret.' },
    watchdog: { configured: !!watchdogUrl(), setup: 'Monitors the monitor. Create a free check at healthchecks.io (period 1 minute, grace 5 minutes), choose how it should alert you, and paste its ping URL here. This app pings it every minute while it is healthy; if the pings stop (computer asleep, app crashed, power cut) the service alerts you.' },
    playwright: { setup: 'Synthetic browser tests need Playwright: npm i playwright && npx playwright install --with-deps chromium (included in the Docker worker image).' },
  });
});
router.put('/integrations/email', requireRole('super_admin'), (req, res) => {
  const b = req.body; const old = decryptJson(getSetting('integration.smtp')) || {};
  if (b.clear) { setSetting('integration.smtp', ''); audit(req.user, 'integration_email_clear', 'settings', null, null, req.ip); return res.json({ ok: true }); }
  if (!str(b.host)) throw new HttpError(400, 'SMTP host required');
  setSetting('integration.smtp', encryptJson({ host: str(b.host), port: +b.port || 587, secure: !!b.secure, user: str(b.user), pass: b.pass && b.pass !== '••••••••' ? String(b.pass) : old.pass || '', from: str(b.from, 200) || config.smtp.from }));
  audit(req.user, 'integration_email_update', 'settings', null, str(b.host), req.ip); const n = requeueUnconfigured(); res.json({ ok: true, requeued: n });
});
router.put('/integrations/whatsapp', requireRole('super_admin'), (req, res) => {
  const b = req.body; const old = decryptJson(getSetting('integration.whatsapp')) || {};
  if (b.clear) { setSetting('integration.whatsapp', ''); audit(req.user, 'integration_wa_clear', 'settings', null, null, req.ip); return res.json({ ok: true }); }
  if (!str(b.phone_number_id)) throw new HttpError(400, 'Phone Number ID required');
  const keep = (v, o) => (v && v !== '••••••••' ? String(v).trim() : o || '');
  setSetting('integration.whatsapp', encryptJson({ phoneNumberId: str(b.phone_number_id), token: keep(b.token, old.token), appSecret: keep(b.app_secret, old.appSecret), verifyToken: keep(b.verify_token, old.verifyToken), template: str(b.template, 100), templateLang: str(b.template_lang, 10) || 'en', apiVersion: 'v21.0' }));
  audit(req.user, 'integration_wa_update', 'settings', null, null, req.ip); const n = requeueUnconfigured(); res.json({ ok: true, requeued: n });
});
router.post('/integrations/email/test', requireRole('super_admin'), async (req, res) => {
  const c = smtpConfig(); if (!c) throw new HttpError(400, 'SMTP is not configured'); const to = str(req.body.to, 200); if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) throw new HttpError(400, 'Valid recipient required');
  try { const t = nodemailer.createTransport({ host: c.host, port: +c.port, secure: !!c.secure, auth: c.user ? { user: c.user, pass: c.pass } : undefined, connectionTimeout: 10000 });
    const info = await t.sendMail({ from: c.from, to, subject: 'Time Global Tech Monitor - test email', html: brandedHtml('Email integration is working', '<p>This is a test message confirming that alert emails can be delivered.</p>'), text: 'Time Global Tech Monitor test email - delivery works.' }); res.json({ ok: true, id: info.messageId }); }
  catch (e) { throw new HttpError(502, `SMTP error: ${e.message}`); }
});
router.post('/integrations/whatsapp/test', requireRole('super_admin'), async (req, res) => {
  const c = waConfig(); if (!c) throw new HttpError(400, 'WhatsApp is not configured'); const to = str(req.body.to, 30).replace(/[^\d]/g, ''); if (!/^\d{8,15}$/.test(to)) throw new HttpError(400, 'Valid international number required');
  const payload = c.template ? { messaging_product: 'whatsapp', to, type: 'template', template: { name: c.template, language: { code: c.templateLang }, components: [{ type: 'body', parameters: ['Test alert', 'Test asset', 'Test project', 'This is a test notification', 'INC-TEST', config.baseUrl].map((t) => ({ type: 'text', text: t })) }] } } : { messaging_product: 'whatsapp', to, type: 'text', text: { body: 'TIME GLOBAL TECH MONITOR\n\nTest message: WhatsApp integration works.' } };
  const r = await fetch(`https://graph.facebook.com/${c.apiVersion}/${c.phoneNumberId}/messages`, { method: 'POST', headers: { authorization: `Bearer ${c.token}`, 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(15000) });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new HttpError(502, `WhatsApp API error: ${j?.error?.message || r.status}`); res.json({ ok: true, id: j.messages?.[0]?.id });
});

// ---------- WhatsApp webhook (Meta) ----------
webhookRouter.get('/whatsapp', (req, res) => {
  const c = waConfig(); const q = req.query;
  if (q['hub.mode'] === 'subscribe' && c?.verifyToken && q['hub.verify_token'] === c.verifyToken) return res.status(200).send(String(q['hub.challenge']));
  res.sendStatus(403);
});
webhookRouter.post('/whatsapp', (req, res) => {
  if (!verifyWaSignature(req.rawBody || Buffer.alloc(0), req.headers['x-hub-signature-256'])) return res.sendStatus(401);
  try { applyWaStatuses(req.body); } catch { /* never fail the webhook */ }
  res.sendStatus(200);
});

router.put('/integrations/push', requireRole('super_admin'), (req, res) => {
  const b = req.body || {}; if (b.clear) { setSetting('integration.push', ''); audit(req.user, 'integration_push_clear', 'settings', null, null, req.ip); return res.json({ ok: true }); }
  let server = str(b.server, 300); try { const u = new URL(server); if (!['http:', 'https:'].includes(u.protocol)) throw new Error(); server = u.origin + u.pathname.replace(/\/$/, ''); } catch { throw new HttpError(400, 'Server must be a valid http(s) address, e.g. https://ntfy.sh'); }
  const old = decryptJson(getSetting('integration.push')) || {}; setSetting('integration.push', encryptJson({ server, token: b.token && b.token !== '••••••••' ? String(b.token) : old.token || '' }));
  audit(req.user, 'integration_push_update', 'settings', null, server, req.ip); res.json({ ok: true });
});
router.post('/integrations/push/test', requireRole('admin'), async (req, res) => {
  const topic = str(req.body?.topic, 64); if (!/^[A-Za-z0-9_-]{10,64}$/.test(topic)) throw new HttpError(400, 'Enter your private topic (10-64 letters, numbers, - or _)');
  try { await sendPushRaw(topic, { title: '✅ Test alert', message: 'Phone alerts from Time Global Tech Monitor are working.', priority: 3, tags: ['white_check_mark'] }); res.json({ ok: true }); }
  catch (e) { throw new HttpError(502, `Push failed: ${e.message}`); }
});
router.put('/integrations/watchdog', requireRole('super_admin'), (req, res) => {
  const b = req.body || {}; if (b.clear) { setSetting('integration.watchdog', ''); audit(req.user, 'integration_watchdog_clear', 'settings', null, null, req.ip); return res.json({ ok: true }); }
  const url = str(b.url, 500); try { if (!['http:', 'https:'].includes(new URL(url).protocol)) throw new Error(); } catch { throw new HttpError(400, 'Enter the full ping URL from your watchdog service (https://…)'); }
  setSetting('integration.watchdog', encryptJson({ url })); audit(req.user, 'integration_watchdog_update', 'settings', null, null, req.ip); res.json({ ok: true });
});
router.post('/integrations/watchdog/test', requireRole('super_admin'), async (req, res) => {
  if (!watchdogUrl()) throw new HttpError(400, 'Save the ping URL first');
  try { const r = await pingWatchdog(); if (!r.ok) throw new Error(`replied HTTP ${r.status}`); res.json({ ok: true }); } catch (e) { throw new HttpError(502, `Ping failed: ${e.message}`); }
});
