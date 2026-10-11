-- 008_phase12.sql — Search / saved filters / dashboards (PLAN.md §30–§33, Phase 12)
--
-- Additive only: existing rows keep their meaning, new columns default to the old shape.
-- `saved_filters` / `dashboards` already exist from 001_init.sql; this file only adds the
-- ownership columns, constraints and the missing `dashlets` table plus pg_trgm search indexes.

-- pg_trgm powers `ILIKE '%term%'` substring search on the hot name/attrs paths (§30.2).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Expression indexes on the generic record table so substring search does not seq-scan.
-- NOTE: expression indexes only cover the indexed expression: `name` and the handful of
-- display-ish attrs keys below. Deeper attrs keys fall back to sequential scan — a
-- documented limitation, not a planner surprise.
CREATE INDEX IF NOT EXISTS idx_entity_records_name_trgm
  ON entity_records USING GIN (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_entity_records_attrs_trgm
  ON entity_records USING GIN ((
    coalesce(attrs ->> 'firstName', '') || ' ' ||
    coalesce(attrs ->> 'lastName', '') || ' ' ||
    coalesce(attrs ->> 'email', '') || ' ' ||
    coalesce(attrs ->> 'phone', '')
  ) gin_trgm_ops);

-- Saved filters (§32.2): ownership + sharing + timestamps. Existing rows keep working:
-- NULL user_id = legacy/shared-by-default, NULL visibility = private.
ALTER TABLE saved_filters ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES users (id) ON DELETE CASCADE;
ALTER TABLE saved_filters ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'private';
ALTER TABLE saved_filters ADD COLUMN IF NOT EXISTS is_shared BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE saved_filters ADD COLUMN IF NOT EXISTS modified_at TIMESTAMPTZ NOT NULL DEFAULT now();
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_saved_filters_visibility') THEN
    ALTER TABLE saved_filters ADD CONSTRAINT chk_saved_filters_visibility CHECK (visibility IN ('private', 'shared'));
  END IF;
END
$$;
CREATE INDEX IF NOT EXISTS idx_saved_filters_owner ON saved_filters (user_id, entity_type);
CREATE INDEX IF NOT EXISTS idx_saved_filters_entity ON saved_filters (entity_type);

-- Dashboards (§33): ownership + layout config + timestamps.
ALTER TABLE dashboards ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES users (id) ON DELETE CASCADE;
ALTER TABLE dashboards ADD COLUMN IF NOT EXISTS layout JSONB NOT NULL DEFAULT '[]';
ALTER TABLE dashboards ADD COLUMN IF NOT EXISTS is_shared BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE dashboards ADD COLUMN IF NOT EXISTS modified_at TIMESTAMPTZ NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS idx_dashboards_owner ON dashboards (user_id);

-- Dashlets: one row per widget on a dashboard. `config` holds the dashlet kind
-- (list | chart | kpi) plus its entity/filter/metric definition; aggregation always runs
-- through the Query Engine in the API process — never raw SQL from config.
CREATE TABLE IF NOT EXISTS dashlets (
  id           TEXT PRIMARY KEY,
  dashboard_id TEXT NOT NULL REFERENCES dashboards (id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'list',
  position     INTEGER NOT NULL DEFAULT 0,
  config       JSONB NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_dashlets_kind CHECK (kind IN ('list', 'chart', 'kpi'))
);
CREATE INDEX IF NOT EXISTS idx_dashlets_dashboard ON dashlets (dashboard_id, position);
