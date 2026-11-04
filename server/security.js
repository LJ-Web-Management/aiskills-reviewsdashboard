import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { config } from './config.js';

const scrypt = promisify(crypto.scrypt);

export class AppError extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.status = status;
    this.isAppError = true;
    this.extra = extra;
  }
}

// ---------- Encryption at rest (AES-256-GCM) ----------

const encKey = Buffer.from(crypto.hkdfSync('sha256', config.appSecret, 'review-reply-admin', 'token-encryption', 32));

export function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encKey, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join(':');
}

export function decrypt(payload) {
  if (!payload) return null;
  const [version, iv, tag, ct] = String(payload).split(':');
  if (version !== 'v1') throw new Error('Unknown ciphertext version');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encKey, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
}

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

// ---------- Password hashing (scrypt) ----------

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, keylen: 64 };
const MAXMEM = 128 * SCRYPT.N * SCRYPT.r * 2;

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: MAXMEM });
  return ['scrypt', Math.log2(SCRYPT.N), SCRYPT.r, SCRYPT.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

export async function verifyPassword(password, stored) {
  try {
    const [algo, logN, r, p, saltB64, hashB64] = String(stored).split('$');
    if (algo !== 'scrypt') return false;
    const N = 2 ** Number(logN);
    const expected = Buffer.from(hashB64, 'base64');
    const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, {
      N, r: Number(r), p: Number(p), maxmem: 128 * N * Number(r) * 2,
    });
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 12) return 'Password must be at least 12 characters.';
  if (password.length > 256) return 'Password is too long.';
  if (/^(.)\1+$/.test(password)) return 'Password is too simple.';
  return null;
}

export function normalizeEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  if (e.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return null;
  return e;
}

// ---------- TOTP (RFC 6238) for two-factor auth ----------

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = String(str).replace(/=+$/, '').toUpperCase();
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function hotp(key, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', key).update(msg).digest();
  const offset = h[h.length - 1] & 0xf;
  return String((h.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

export function generateTotpSecret() {
  return base32Encode(crypto.randomBytes(20));
}

/** Returns the matched time-step (to block replays), or null. */
export function verifyTotp(secret, code, lastUsedStep = 0) {
  const clean = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(clean)) return null;
  const key = base32Decode(secret);
  const step = Math.floor(Date.now() / 30_000);
  for (const drift of [0, -1, 1]) {
    const s = step + drift;
    if (s <= lastUsedStep) continue;
    if (safeEqual(hotp(key, s), clean)) return s;
  }
  return null;
}

export function totpUri(secret, email, issuer = 'Review Reply Admin') {
  const label = encodeURIComponent(`${issuer}:${email}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
