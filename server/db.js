import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from './config.js';

export const db = new Database(path.join(config.dataDir, 'app.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  email            TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash    TEXT NOT NULL,
  totp_secret_enc  TEXT,
  totp_enabled     INTEGER NOT NULL DEFAULT 0,
  totp_last_step   INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  last_login_at    INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash    TEXT PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token    TEXT NOT NULL,
  oauth_state   TEXT,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  ip            TEXT,
  user_agent    TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS login_throttle (
  email         TEXT PRIMARY KEY,
  failures      INTEGER NOT NULL DEFAULT 0,
  last_failure  INTEGER NOT NULL,
  locked_until  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reviews (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id      TEXT NOT NULL UNIQUE,   -- Google review resource name, or demo id
  source           TEXT NOT NULL,          -- 'google' | 'demo'
  reviewer_name    TEXT,
  reviewer_photo   TEXT,
  star_rating      INTEGER,
  comment          TEXT,
  created_at       INTEGER NOT NULL,       -- when the review was written (ms)
  updated_at       INTEGER,
  status           TEXT NOT NULL,          -- pending | posting | posted | replied | skipped | failed
  suggested_reply  TEXT,
  drafted_at       INTEGER,
  reply_text       TEXT,                   -- reply that is live on Google
  reply_at         INTEGER,
  auto_approved    INTEGER NOT NULL DEFAULT 0,
  posted_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  error            TEXT,
  first_seen_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reviews_status ON reviews(status, created_at);
CREATE INDEX IF NOT EXISTS idx_reviews_created ON reviews(created_at);

CREATE TABLE IF NOT EXISTS api_usage (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at     INTEGER NOT NULL,
  model          TEXT NOT NULL,
  purpose        TEXT NOT NULL,            -- draft | regenerate | preview
  review_id      INTEGER,
  input_tokens   INTEGER NOT NULL DEFAULT 0,
  cached_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens  INTEGER NOT NULL DEFAULT 0,
  cost_usd       REAL,                     -- NULL when no price is set for the model
  success        INTEGER NOT NULL,
  error          TEXT,
  latency_ms     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_usage_created ON api_usage(created_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  INTEGER NOT NULL,
  user_id     INTEGER,
  user_email  TEXT,
  action      TEXT NOT NULL,
  detail      TEXT,
  ip          TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
`);

export function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value);
  } catch {
    return fallback;
  }
}

export function setSetting(key, value) {
  if (value === undefined || value === null) {
    db.prepare('DELETE FROM settings WHERE key = ?').run(key);
    return;
  }
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}

export function audit(user, action, detail = null, ip = null) {
  db.prepare('INSERT INTO audit_log (created_at, user_id, user_email, action, detail, ip) VALUES (?, ?, ?, ?, ?, ?)')
    .run(Date.now(), user?.id ?? null, user?.email ?? null, action, detail, ip);
}

// Housekeeping: drop expired sessions and stale audit rows.
export function cleanup() {
  const now = Date.now();
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
  db.prepare('DELETE FROM login_throttle WHERE last_failure < ? AND locked_until < ?').run(now - 86_400_000, now);
  db.prepare('DELETE FROM audit_log WHERE created_at < ?').run(now - 365 * 86_400_000);
}
