-- Phase 16 — BPM process engine (PLAN §36).
--
-- Definitions are versioned exactly like workflows (§35): `process_definitions` is the identity and
-- every save produces an immutable row in `process_definition_versions`. A running instance points
-- at the version it started on, so republishing a definition never rewrites the history of instances
-- already in flight.
--
-- A process instance is a single token walking the graph (see packages/bpm). `process_instances`
-- holds the token position and the accumulated context; `process_tasks` is the human side of it —
-- one row per parked user task, with the resolved assignee, its due/escalation timers and the answer
-- given; `process_events` is the audit trail PLAN §36 asks for: every move, dispatch, decision and
-- failure, in order (`seq` gives a stable order within a transaction, where `now()` is identical for
-- every row).

CREATE TABLE IF NOT EXISTS process_definitions (
  id                   TEXT PRIMARY KEY,
  -- Stable identifier used when starting an instance, e.g. "opportunity-approval".
  key                  TEXT NOT NULL,
  name                 TEXT NOT NULL,
  description          TEXT,
  -- Record type instances attach to; "*" accepts any.
  entity_type          TEXT NOT NULL DEFAULT '*',
  is_active            BOOLEAN NOT NULL DEFAULT FALSE,
  current_version_id   TEXT,
  published_version_id TEXT,
  is_deleted           BOOLEAN NOT NULL DEFAULT FALSE,
  created_by_id        TEXT,
  modified_by_id       TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_process_definitions_key ON process_definitions (key) WHERE NOT is_deleted;

CREATE TABLE IF NOT EXISTS process_definition_versions (
  id            TEXT PRIMARY KEY,
  definition_id TEXT NOT NULL REFERENCES process_definitions (id) ON DELETE CASCADE,
  version       INTEGER NOT NULL,
  definition    JSONB NOT NULL,
  -- draft: editable; published: what instances run against, immutable; archived: superseded.
  status        TEXT NOT NULL DEFAULT 'draft',
  created_by_id TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at  TIMESTAMPTZ,
  UNIQUE (definition_id, version)
);

CREATE INDEX IF NOT EXISTS idx_process_definition_versions_definition
  ON process_definition_versions (definition_id, version DESC);

CREATE TABLE IF NOT EXISTS process_instances (
  id            TEXT PRIMARY KEY,
  definition_id TEXT NOT NULL REFERENCES process_definitions (id) ON DELETE CASCADE,
  version_id    TEXT NOT NULL REFERENCES process_definition_versions (id),
  entity_type   TEXT NOT NULL,
  entity_id     TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'running',
  -- Where the token currently is: the parked user task, or NULL at start/after completion.
  current_node  TEXT,
  context       JSONB NOT NULL DEFAULT '{}'::jsonb,
  outcome       TEXT,
  error         TEXT,
  initiated_by  TEXT,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_process_instances_definition ON process_instances (definition_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_process_instances_status ON process_instances (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_process_instances_record ON process_instances (entity_type, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_process_instances_initiator ON process_instances (initiated_by, created_at DESC);

CREATE TABLE IF NOT EXISTS process_tasks (
  id               TEXT PRIMARY KEY,
  instance_id      TEXT NOT NULL REFERENCES process_instances (id) ON DELETE CASCADE,
  node_id          TEXT NOT NULL,
  name             TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'open',
  -- Resolved responsible party: a user (direct or via a record field) and/or a candidate role.
  assignee_id      TEXT,
  assignee_role_id TEXT,
  -- The assignee spec as written in the definition; an escalation re-resolves it against live data.
  assignee_spec    JSONB NOT NULL DEFAULT '{}'::jsonb,
  due_at           TIMESTAMPTZ,
  escalated_at     TIMESTAMPTZ,
  outcome          TEXT,
  comment          TEXT,
  completed_by_id  TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at     TIMESTAMPTZ,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_process_tasks_assignee ON process_tasks (assignee_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_process_tasks_role ON process_tasks (assignee_role_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_process_tasks_instance ON process_tasks (instance_id, created_at);

CREATE TABLE IF NOT EXISTS process_events (
  id          TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES process_instances (id) ON DELETE CASCADE,
  node_id     TEXT,
  type        TEXT NOT NULL,
  message     TEXT NOT NULL,
  actor_id    TEXT,
  data        JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Ordering column: several events are written in one transaction, where now() is identical.
  seq         BIGSERIAL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_process_events_instance ON process_events (instance_id, seq);
