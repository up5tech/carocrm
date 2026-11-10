-- Phase 23.2 (plans/PLAN_Phase_23_Security_Hardening.md §8, tasks 3–4) — session hardening.
--
-- Additive only (AGENTS.md §3.5): new nullable/defaulted columns on user_sessions, no change to
-- existing rows' meaning. Existing sessions keep working: they are treated as password-only
-- (two_factor_verified = FALSE), which is exactly what they were.
--
-- family_id ties a rotation chain together so a replayed (already-rotated) refresh token revokes the
-- whole family (reuse detection). ip_address records the sign-in source for the session list.
-- two_factor_verified binds the second factor to the session; mfa_pending marks a session that may
-- only enroll TOTP until the instance MFA policy is satisfied. revoked_reason distinguishes a
-- rotation (replayable -> reuse detection) from logout/password-change revocations.

ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS family_id TEXT;
ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS ip_address TEXT;
ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS two_factor_verified BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS mfa_pending BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS revoked_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_user_sessions_family
  ON user_sessions (family_id) WHERE family_id IS NOT NULL;