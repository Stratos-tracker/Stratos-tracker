-- Stratos account schema (Cloudflare D1).
--
-- Apply locally:
--   npx wrangler d1 execute stratos-accounts --local \
--     --config relay/worker/wrangler.toml --file relay/worker/schema.sql
--
-- Apply to the deployed database:
--   npx wrangler d1 execute stratos-accounts --remote \
--     --config relay/worker/wrangler.toml --file relay/worker/schema.sql
--
-- Every row that belongs to a person is keyed by that person's user id, and
-- composite keys (user_id, id) are used where a client supplies the id, so one
-- account can never read or overwrite another account's data by guessing an id.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id                TEXT PRIMARY KEY,
  email             TEXT NOT NULL,
  email_norm        TEXT NOT NULL UNIQUE,
  username          TEXT NOT NULL,
  username_norm     TEXT NOT NULL UNIQUE,
  password_hash     TEXT NOT NULL,
  password_salt     TEXT NOT NULL,
  iterations        INTEGER NOT NULL,
  avatar            TEXT,
  prefs             TEXT NOT NULL DEFAULT '{}',
  email_verified_at INTEGER,
  failed_attempts   INTEGER NOT NULL DEFAULT 0,
  locked_until      INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  label        TEXT NOT NULL DEFAULT '',
  user_agent   TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS email_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
);
CREATE INDEX IF NOT EXISTS email_tokens_user ON email_tokens(user_id, purpose);

CREATE TABLE IF NOT EXISTS flights (
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id           TEXT NOT NULL,
  callsign     TEXT NOT NULL DEFAULT '',
  dep          TEXT NOT NULL DEFAULT '',
  arr          TEXT NOT NULL DEFAULT '',
  aircraft     TEXT NOT NULL DEFAULT '',
  icao         TEXT NOT NULL DEFAULT '',
  registration TEXT NOT NULL DEFAULT '',
  started_at   INTEGER NOT NULL DEFAULT 0,
  ended_at     INTEGER NOT NULL DEFAULT 0,
  duration_sec REAL NOT NULL DEFAULT 0,
  distance_nm  REAL NOT NULL DEFAULT 0,
  data         TEXT NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS flights_user_started ON flights(user_id, started_at DESC);

CREATE TABLE IF NOT EXISTS live_tickets (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
);
