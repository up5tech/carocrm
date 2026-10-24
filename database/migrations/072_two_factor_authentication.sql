-- Two-factor authentication (PLAN_Phase_20_Settings_UX.md §4.3 row 14, §4.9).
--
-- Additive only (AGENTS.md §3.5): three columns on `users` (two nullable, one NOT NULL DEFAULT)
-- and two new tables. No column is altered, no row is touched, so an instance that never enables
-- 2FA is completely unaffected.

ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_confirmed_at TIMESTAMPTZ;

-- A password that matched on a 2FA account opens this one-shot challenge instead of a session:
-- it expires, it counts attempts, and it is deleted the moment it is satisfied.
CREATE TABLE IF NOT EXISTS auth_challenges (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  attempts   INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_auth_challenges_user ON auth_challenges (user_id);

-- Recovery codes, stored as hashes so a database reader cannot sign in with them; `used_at` makes
-- each code single-use.
CREATE TABLE IF NOT EXISTS user_recovery_codes (
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  code_hash  TEXT NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, code_hash)
);
