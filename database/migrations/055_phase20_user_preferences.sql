-- Phase 20.10 — per-user preferences (PLAN_Phase_20_Settings_UX.md §5.9, §20.10)
--
-- Additive only (AGENTS.md §3.5): one new table; no existing table is altered, no row is touched.
-- A preference is a small named document owned by exactly one account — the primary key is
-- (user_id, name), so "only the owner may read/write" is a property of the data model, not a check
-- the endpoints have to remember. There is nothing to seed or backfill: a user without rows simply
-- gets the client-side defaults.

CREATE TABLE IF NOT EXISTS user_preferences (
  user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  data        JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, name)
);
