-- Phase 17 — saved reports (PLAN §34).
-- Definitions are data, validated against current metadata and ACL on save and every run.
-- Execution uses EntityCrudService/Query Engine with a hard scan budget; this is not SQL input.

CREATE TABLE IF NOT EXISTS reports (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  entity_type  TEXT NOT NULL,
  user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  definition   JSONB NOT NULL,
  visibility   TEXT NOT NULL DEFAULT 'private',
  is_shared    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_reports_visibility CHECK (visibility IN ('private', 'shared')),
  CONSTRAINT chk_reports_visibility_shared CHECK (is_shared = (visibility = 'shared'))
);

CREATE INDEX IF NOT EXISTS idx_reports_owner ON reports (user_id, modified_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_entity ON reports (entity_type, visibility, name);
