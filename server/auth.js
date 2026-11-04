import { config } from './config.js';
import { db, audit } from './db.js';
import { AppError, sha256, randomToken, safeEqual, hashPassword, normalizeEmail, validatePassword } from './security.js';

export const SESSION_COOKIE = config.secureCookies ? '__Host-rra_sid' : 'rra_sid';
const IDLE_MS = config.sessionIdleMinutes * 60_000;
const MAX_MS = config.sessionMaxHours * 3_600_000;

// ---------- Sessions ----------

export function createSession(userId, req, res) {
  const token = randomToken(32);
  const now = Date.now();
  db.prepare(`INSERT INTO sessions (token_hash, user_id, csrf_token, created_at, last_seen_at, expires_at, ip, user_agent)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(sha256(token), userId, randomToken(24), now, now, now + MAX_MS, req.ip, String(req.get('user-agent') || '').slice(0, 300));
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: config.secureCookies,
    // "lax" (not "strict") so the cookie survives the redirect back from Google's OAuth screen.
    // Cross-site POSTs are still blocked, and every state-changing request also needs the CSRF header.
    sameSite: 'lax',
    path: '/',
    maxAge: MAX_MS,
  });
}

export function destroySession(req, res) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  if (res) res.clearCookie(SESSION_COOKIE, { httpOnly: true, secure: config.secureCookies, sameSite: 'lax', path: '/' });
}

export function loadSession(req) {
  if (req._session !== undefined) return req._session;
  req._session = null;
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token || token.length > 128) return null;
  const hash = sha256(token);
  const row = db.prepare(`SELECT s.*, u.email, u.totp_enabled FROM sessions s JOIN users u ON u.id = s.user_id
                          WHERE s.token_hash = ?`).get(hash);
  if (!row) return null;
  const now = Date.now();
  if (row.expires_at < now || row.last_seen_at + IDLE_MS < now) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash);
    return null;
  }
  if (now - row.last_seen_at > 60_000) {
    db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(now, hash);
  }
  req._session = row;
  req.user = { id: row.user_id, email: row.email, totpEnabled: !!row.totp_enabled };
  return row;
}

export function requireAuth(req, res, next) {
  if (!loadSession(req)) return res.status(401).json({ error: 'Your session has expired. Please sign in again.' });
  next();
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Every state-changing request must echo the per-session CSRF token in a header. */
export function csrfProtect(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  const session = loadSession(req);
  const header = req.get('x-csrf-token');
  if (!session || !header || !safeEqual(header, session.csrf_token)) {
    return res.status(403).json({ error: 'Security check failed. Reload the page and try again.' });
  }
  next();
}

/** Reject state-changing requests that come from another site. */
export function originCheck(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  if (req.get('sec-fetch-site') === 'cross-site') return res.status(403).json({ error: 'Cross-site request blocked.' });
  const origin = req.get('origin');
  if (origin) {
    let host = null;
    try { host = new URL(origin).host; } catch { /* invalid */ }
    const allowed = new Set([req.get('host'), req.host, new URL(config.appUrl).host]);
    if (!host || !allowed.has(host)) return res.status(403).json({ error: 'Cross-site request blocked.' });
  }
  next();
}

// ---------- Brute-force protection (per email, independent of whether the account exists) ----------

const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60_000;

export function lockRemainingMs(email) {
  const row = db.prepare('SELECT locked_until FROM login_throttle WHERE email = ?').get(email);
  const remaining = row ? row.locked_until - Date.now() : 0;
  return remaining > 0 ? remaining : 0;
}

export function recordLoginFailure(email) {
  const now = Date.now();
  const row = db.prepare('SELECT failures, last_failure FROM login_throttle WHERE email = ?').get(email);
  // Failures older than 24h are forgotten.
  const failures = row && now - row.last_failure < 86_400_000 ? row.failures + 1 : 1;
  // Lock for 15 min after 5 failures, doubling for each further batch of 5 (capped at 24h).
  const lockedUntil = failures % MAX_FAILURES === 0
    ? now + Math.min(LOCK_MS * 2 ** (failures / MAX_FAILURES - 1), 86_400_000)
    : 0;
  db.prepare(`INSERT INTO login_throttle (email, failures, last_failure, locked_until) VALUES (?, ?, ?, ?)
              ON CONFLICT(email) DO UPDATE SET failures = excluded.failures, last_failure = excluded.last_failure,
              locked_until = MAX(login_throttle.locked_until, excluded.locked_until)`)
    .run(email, failures, now, lockedUntil);
}

export function clearLoginFailures(email) {
  db.prepare('DELETE FROM login_throttle WHERE email = ?').run(email);
}

// ---------- Users ----------

export async function createUser(emailInput, password, actor = null) {
  const email = normalizeEmail(emailInput);
  if (!email) throw new AppError('Enter a valid email address.');
  const problem = validatePassword(password);
  if (problem) throw new AppError(problem);
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new AppError('A user with that email already exists.', 409);
  const hash = await hashPassword(password);
  const info = db.prepare('INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?)').run(email, hash, Date.now());
  audit(actor, 'user_created', email);
  return { id: Number(info.lastInsertRowid), email };
}

export async function ensureInitialAdmin() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (count > 0) return;
  if (config.initialAdminEmail && config.initialAdminPassword) {
    await createUser(config.initialAdminEmail, config.initialAdminPassword);
    console.log(`[auth] Created the first admin user: ${config.initialAdminEmail}`);
    console.log('[auth] Remove INITIAL_ADMIN_PASSWORD from your environment now that the account exists.');
  } else {
    console.log('[auth] No users yet. Create the first admin with:  npm run create-user');
  }
}
