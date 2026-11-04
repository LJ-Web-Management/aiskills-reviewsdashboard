import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Load .env (Node >= 20.12). Real environment variables win over the file.
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const env = process.env;

function int(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function bool(value, fallback) {
  if (value == null || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
}

function parseTrustProxy(value) {
  if (value == null || value === '' || /^(0|false|no|off)$/i.test(value)) return false;
  if (/^\d+$/.test(value)) return parseInt(value, 10);
  return value; // e.g. "loopback" or a CIDR list
}

const isProd = env.NODE_ENV === 'production';
const port = int(env.PORT, 3000);
const appUrl = (env.APP_URL || `http://localhost:${port}`).replace(/\/+$/, '');
const dataDir = path.resolve(ROOT, env.DATA_DIR || 'data');
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

function loadSecret() {
  if (env.APP_SECRET) {
    if (env.APP_SECRET.length < 32) {
      throw new Error('APP_SECRET must be at least 32 characters. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"');
    }
    return env.APP_SECRET;
  }
  const file = path.join(dataDir, 'secret.key');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const secret = crypto.randomBytes(48).toString('base64url');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  console.warn(`[config] APP_SECRET is not set, so one was generated at ${file}.`);
  console.warn('[config] Keep that file safe and backed up: it encrypts the stored Google token and OpenAI key.');
  return secret;
}

const googleClientId = env.GOOGLE_CLIENT_ID || '';
const googleClientSecret = env.GOOGLE_CLIENT_SECRET || '';

export const config = Object.freeze({
  isProd,
  port,
  host: env.HOST || (isProd ? '0.0.0.0' : '127.0.0.1'),
  appUrl,
  secureCookies: appUrl.startsWith('https://'),
  dataDir,
  appSecret: loadSecret(),
  trustProxy: parseTrustProxy(env.TRUST_PROXY),
  sessionIdleMinutes: int(env.SESSION_IDLE_MINUTES, 120),
  sessionMaxHours: int(env.SESSION_MAX_HOURS, 24),

  openaiApiKey: (env.OPENAI_API_KEY || '').trim(),
  openaiModel: env.OPENAI_MODEL || 'gpt-5-mini',
  openaiBaseUrl: (env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),

  googleClientId,
  googleClientSecret,

  // Demo data is shown until a Google location is connected.
  demoMode: bool(env.DEMO_MODE, true),

  initialAdminEmail: (env.INITIAL_ADMIN_EMAIL || '').trim().toLowerCase(),
  initialAdminPassword: env.INITIAL_ADMIN_PASSWORD || '',
});
