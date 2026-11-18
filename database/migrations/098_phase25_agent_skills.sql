-- 098_phase25_agent_skills.sql — reusable versioned instruction records (Phase 25.4).
--
-- Additive only (AGENTS.md §3.5): one new table and indexes. No existing row is modified and no
-- existing table is dropped, truncated or rewritten.
--
-- One row is one immutable version of a skill. A draft may be edited until publication; after that
-- its instruction text is a snapshot. A new edit creates the next version, so a published agent that
-- pinned version N never observes version N+1. There is no script, handler or executable field: the
-- only payload is bounded instruction text that the run engine treats as lower-priority guidance.

CREATE TABLE IF NOT EXISTS ai_agent_skills (
  id                TEXT PRIMARY KEY,
  skill_key         TEXT NOT NULL,
  version           INTEGER NOT NULL,
  label             TEXT NOT NULL,
  description       TEXT,
  instructions      TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'draft',
  visibility        TEXT NOT NULL DEFAULT 'team',
  owner_user_id     TEXT REFERENCES users (id) ON DELETE SET NULL,
  team_id           TEXT REFERENCES teams (id) ON DELETE SET NULL,
  published_by_id   TEXT REFERENCES users (id) ON DELETE SET NULL,
  published_at      TIMESTAMPTZ,
  publication_note  TEXT,
  is_deleted        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_id     TEXT,
  modified_by_id    TEXT,
  CONSTRAINT ai_agent_skills_status_check CHECK (status IN ('draft', 'published', 'archived')),
  CONSTRAINT ai_agent_skills_visibility_check CHECK (visibility IN ('private', 'team', 'organization')),
  CONSTRAINT ai_agent_skills_version_check CHECK (version > 0),
  CONSTRAINT ai_agent_skills_key_version_key UNIQUE (skill_key, version)
);

CREATE INDEX IF NOT EXISTS idx_ai_agent_skills_key_status
  ON ai_agent_skills (skill_key, status, version DESC)
  WHERE is_deleted = FALSE;

CREATE INDEX IF NOT EXISTS idx_ai_agent_skills_owner
  ON ai_agent_skills (owner_user_id, team_id)
  WHERE is_deleted = FALSE;

COMMENT ON COLUMN ai_agent_skills.instructions IS
  'Bounded, non-executable shared instructions. Treated as lower-priority than the agent operating rules and never as a tool grant, approval policy or output schema.';
