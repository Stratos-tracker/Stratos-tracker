-- Adds the full-name and Terms-acceptance columns to a database created before
-- this change. A fresh database gets both from schema.sql, so a new install
-- never needs this file. SQLite has no "ADD COLUMN IF NOT EXISTS": running it a
-- second time reports a duplicate column and changes nothing.
--
--   npx wrangler d1 execute stratos-accounts --remote \
--     --config relay/worker/wrangler.toml --file relay/worker/migrations/002-name-and-terms.sql

ALTER TABLE users ADD COLUMN name TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN terms_at INTEGER NOT NULL DEFAULT 0;
