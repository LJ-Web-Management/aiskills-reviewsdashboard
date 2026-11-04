import express from 'express';
import rateLimit from 'express-rate-limit';
import QRCode from 'qrcode';
import { db, audit } from '../db.js';
import {
  AppError, verifyPassword, hashPassword, validatePassword,
  encrypt, decrypt, generateTotpSecret, verifyTotp, totpUri,
} from '../security.js';
import {
  createSession, destroySession, requireAuth, csrfProtect, createUser,
  lockRemainingMs, recordLoginFailure, clearLoginFailures,
} from '../auth.js';
import { brand } from '../brand.js';

const router = express.Router();

// Compared against when the email doesn't exist, so response time doesn't reveal valid accounts.
const DUMMY_HASH = await hashPassword('dummy-password-for-timing-only');

const loginLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many sign-in attempts from this network. Try again in 15 minutes.' },
});

router.post('/auth/login', loginLimiter, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase().slice(0, 254);
  const password = String(req.body?.password || '').slice(0, 256);
  const code = String(req.body?.code || '');
  if (!email || !password) throw new AppError('Enter your email and password.');

  const locked = lockRemainingMs(email);
  if (locked) {
    audit(null, 'login_blocked', email, req.ip);
    return res.status(429).json({ error: `Too many failed attempts. Try again in ${Math.ceil(locked / 60_000)} minute(s).` });
  }

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  const ok = await verifyPassword(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !ok) {
    recordLoginFailure(email);
    audit(null, 'login_failed', email, req.ip);
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }

  if (user.totp_enabled) {
    if (!code.trim()) return res.status(401).json({ totpRequired: true, error: 'Enter the 6-digit code from your authenticator app.' });
    const step = verifyTotp(decrypt(user.totp_secret_enc), code, user.totp_last_step);
    if (step === null) {
      recordLoginFailure(email);
      audit(user, 'login_failed', 'invalid 2FA code', req.ip);
      return res.status(401).json({ totpRequired: true, error: 'That code is incorrect or has expired.' });
    }
    db.prepare('UPDATE users SET totp_last_step = ? WHERE id = ?').run(step, user.id);
  }

  clearLoginFailures(email);
  destroySession(req); // never reuse a pre-login session
  createSession(user.id, req, res);
  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(Date.now(), user.id);
  audit(user, 'login', null, req.ip);
  res.json({ ok: true });
});

// Everything below needs a signed-in user; non-GET requests also need the CSRF header.
router.use(requireAuth, csrfProtect);

router.post('/auth/logout', (req, res) => {
  audit(req.user, 'logout', null, req.ip);
  destroySession(req, res);
  res.json({ ok: true });
});

router.get('/auth/me', (req, res) => {
  res.json({ user: req.user, csrfToken: req._session.csrf_token });
});

// ---------- Own account ----------

router.post('/account/password', async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!(await verifyPassword(String(currentPassword || ''), user.password_hash))) throw new AppError('Your current password is incorrect.', 400);
  const problem = validatePassword(newPassword);
  if (problem) throw new AppError(problem);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(newPassword), user.id);
  // Sign out every other session for this user.
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(user.id, req._session.token_hash);
  audit(req.user, 'password_changed', null, req.ip);
  res.json({ ok: true });
});

router.post('/account/2fa/setup', async (req, res) => {
  if (req.user.totpEnabled) throw new AppError('Two-factor authentication is already on.');
  const secret = generateTotpSecret();
  db.prepare('UPDATE users SET totp_secret_enc = ?, totp_enabled = 0 WHERE id = ?').run(encrypt(secret), req.user.id);
  const uri = totpUri(secret, req.user.email, `${brand.name} ${brand.appName}`.trim());
  res.json({ secret, uri, qr: await QRCode.toDataURL(uri, { margin: 1, width: 220 }) });
});

router.post('/account/2fa/enable', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user.totp_secret_enc) throw new AppError('Start the setup first.');
  const step = verifyTotp(decrypt(user.totp_secret_enc), req.body?.code, 0);
  if (step === null) throw new AppError('That code is incorrect. Check your phone\'s clock and try the newest code.');
  db.prepare('UPDATE users SET totp_enabled = 1, totp_last_step = ? WHERE id = ?').run(step, user.id);
  audit(req.user, '2fa_enabled', null, req.ip);
  res.json({ ok: true });
});

router.post('/account/2fa/disable', async (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!(await verifyPassword(String(req.body?.password || ''), user.password_hash))) throw new AppError('Incorrect password.');
  db.prepare('UPDATE users SET totp_enabled = 0, totp_secret_enc = NULL, totp_last_step = 0 WHERE id = ?').run(user.id);
  audit(req.user, '2fa_disabled', null, req.ip);
  res.json({ ok: true });
});

// ---------- Team ----------

router.get('/users', (req, res) => {
  const users = db.prepare('SELECT id, email, totp_enabled, created_at, last_login_at FROM users ORDER BY created_at').all();
  res.json({
    users: users.map((u) => ({ id: u.id, email: u.email, totpEnabled: !!u.totp_enabled, createdAt: u.created_at, lastLoginAt: u.last_login_at, isYou: u.id === req.user.id })),
  });
});

router.post('/users', async (req, res) => {
  const user = await createUser(req.body?.email, req.body?.password, req.user);
  res.status(201).json({ user });
});

router.delete('/users/:id', (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) throw new AppError('You can\'t remove your own account.');
  const target = db.prepare('SELECT email FROM users WHERE id = ?').get(id);
  if (!target) throw new AppError('User not found.', 404);
  db.prepare('DELETE FROM users WHERE id = ?').run(id); // sessions cascade
  audit(req.user, 'user_removed', target.email, req.ip);
  res.json({ ok: true });
});

router.get('/activity', (req, res) => {
  const rows = db.prepare('SELECT created_at, user_email, action, detail, ip FROM audit_log ORDER BY id DESC LIMIT 100').all();
  res.json({ activity: rows.map((r) => ({ at: r.created_at, user: r.user_email, action: r.action, detail: r.detail, ip: r.ip })) });
});

export default router;
