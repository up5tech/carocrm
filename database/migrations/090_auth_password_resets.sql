-- Phase 23.2 (plans/PLAN_Phase_23_Security_Hardening.md §8, task 2) — self-service password reset.
--
-- Additive only (AGENTS.md §3.5): one new table, no change to existing rows.
--
-- `token_hash` is the SHA-256 hex of the reset token; the raw token exists only in the email that was
-- sent. One live token per account: requesting a new reset retires the previous row. Rows are deleted
-- when they are consumed or superseded, and expired rows are swept when a new reset is requested
-- (bounded retention — no cleanup job needed).

CREATE TABLE IF NOT EXISTS auth_password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_auth_password_resets_user
  ON auth_password_resets (user_id, created_at DESC);