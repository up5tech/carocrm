-- Phase 15 — workflow engine (PLAN §35).
--
-- Definitions are versioned and never mutated in place: `workflows` is the identity, and each save
-- produces a row in `workflow_versions`. A published version is immutable — editing a live workflow
-- creates the next draft — so a run that started against version 3 still finds version 3 later.
--
-- The node graph lives inside `workflow_versions.definition` (JSONB) rather than in separate node
-- and edge tables. That is a deliberate deviation from PLAN §35's table list: one row per version
-- makes a version an *atomic* snapshot, which is exactly the property the versioning rule needs,
-- and there is no window in which a version's nodes and edges disagree.
--
-- Runs and their steps are the execution history (PLAN §35 "Run history" / "Retry"). `workflow_run_steps`
-- is also the idempotency ledger: a retried job re-runs only the nodes that have no completed step,
-- so redelivery never repeats a notification or an email.

CREATE TABLE IF NOT EXISTS workflows (
  id                   TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,
  entity_type          TEXT NOT NULL,
  event_type           TEXT NOT NULL,
  is_active            BOOLEAN NOT NULL DEFAULT FALSE,
  current_version_id   TEXT,
  published_version_id TEXT,
  is_deleted           BOOLEAN NOT NULL DEFAULT FALSE,
  created_by_id        TEXT,
  modified_by_id       TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workflows_active ON workflows (is_active, is_deleted);

CREATE TABLE IF NOT EXISTS workflow_versions (
  id            TEXT PRIMARY KEY,
  workflow_id   TEXT NOT NULL REFERENCES workflows (id) ON DELETE CASCADE,
  version       INTEGER NOT NULL,
  definition    JSONB NOT NULL,
  -- draft: editable; published: what the worker runs, immutable; archived: superseded.
  status        TEXT NOT NULL DEFAULT 'draft',
  created_by_id TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at  TIMESTAMPTZ,
  UNIQUE (workflow_id, version)
);

CREATE INDEX IF NOT EXISTS idx_workflow_versions_workflow ON workflow_versions (workflow_id, version DESC);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id            TEXT PRIMARY KEY,
  workflow_id   TEXT NOT NULL REFERENCES workflows (id) ON DELETE CASCADE,
  version_id    TEXT NOT NULL,
  entity_type   TEXT NOT NULL,
  entity_id     TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'running',
  current_node  TEXT,
  user_id       TEXT,
  error         TEXT,
  context       JSONB NOT NULL DEFAULT '{}'::jsonb,
  attempt       INTEGER NOT NULL DEFAULT 1,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow ON workflow_runs (workflow_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_record ON workflow_runs (entity_type, entity_id, created_at DESC);

CREATE TABLE IF NOT EXISTS workflow_run_steps (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES workflow_runs (id) ON DELETE CASCADE,
  node_id     TEXT NOT NULL,
  node_type   TEXT NOT NULL,
  name        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'running',
  attempt     INTEGER NOT NULL DEFAULT 1,
  output      JSONB,
  error       TEXT,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, node_id)
);

CREATE INDEX IF NOT EXISTS idx_workflow_run_steps_run ON workflow_run_steps (run_id, started_at);