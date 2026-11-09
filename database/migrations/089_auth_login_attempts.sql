-- Phase 23.2 (plans/PLAN_Phase_23_Security_Hardening.md §8, task 1) — failed-login counters that drive
-- the per-account lockout.
--
-- Additive only (AGENTS.md §3.5): one new table, no change to existing rows.
--
-- `subject_hash` is the SHA-256 hex of the normalized account identifier (the lowercased user name), so
-- no raw account value is stored or compared. Rows older than the policy retention window are deleted
-- when a new failure is recorded (bounded retention — no cleanup job needed).

CREATE TABLE IF NOT EXISTS auth_login_attempts (
  id           BIGSERIAL PRIMARY KEY,
  subject_hash TEXT NOT NULL,
  failed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_auth_login_attempts_subject_failed_at
  ON auth_login_attempts (subject_hash, failed_at DESC);
