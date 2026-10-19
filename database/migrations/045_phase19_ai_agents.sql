-- Phase 19-AI — AI Agents foundation (PLAN_Phase_19_AI_Agents.md §4.4, §5, §8, §9, §12, §20 `19-AI.3`).
--
-- Additive only (AGENTS.md §3.5): every statement is `CREATE TABLE/INDEX ... IF NOT EXISTS`, no table is
-- dropped, truncated or rewritten, no column is renamed or repurposed, and no existing row is modified.
-- The repository contained no agent, run, provider or approval row before this migration
-- (docs/modules/ai-agents/repository-audit.md §1), so there is nothing to backfill.
--
-- Deliberately absent until their first consumer exists: conversations/messages, memory items and
-- evaluation suites/cases/runs (§20 `19-AI.3`: "only when their first implementation phase needs them").
-- A table no code reads is a false promise in an admin screen.
--
-- Retention semantics are documented in docs/modules/ai-agents/architecture.md §7. No destructive
-- cascade reaches another module's rows: cascades stay inside a run's own ledger.

-- ---------------------------------------------------------------------------
-- Provider connections (§6.2, §6.3, §14.4)
-- ---------------------------------------------------------------------------

-- The API key is **write-only**. It is AES-256-GCM encrypted by the application with ENCRYPTION_KEY
-- before it reaches this column; no read path returns it. `kind` names the registered adapter, not the
-- vendor, so one OpenAI-compatible adapter can serve several approved providers.
CREATE TABLE IF NOT EXISTS ai_provider_connections (
  id                TEXT PRIMARY KEY,
  key               TEXT NOT NULL UNIQUE,
  kind              TEXT NOT NULL,
  label             TEXT NOT NULL,
  base_url          TEXT NOT NULL,
  models            JSONB NOT NULL DEFAULT '[]'::jsonb,
  data_classes      JSONB NOT NULL DEFAULT '[]'::jsonb,
  api_key_encrypted TEXT,
  config            JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled           BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_id     TEXT,
  modified_by_id    TEXT,
  CONSTRAINT ai_provider_connections_kind_check CHECK (kind IN ('openai-compatible', 'fake'))
);

CREATE INDEX IF NOT EXISTS idx_ai_provider_connections_enabled
  ON ai_provider_connections (enabled, key);

COMMENT ON COLUMN ai_provider_connections.api_key_encrypted IS
  'AES-256-GCM payload; write-only, never returned by an API or written to a run/tool/event row.';

-- ---------------------------------------------------------------------------
-- Agent definition and immutable versions (§5, §4.4)
-- ---------------------------------------------------------------------------

-- A definition is mutable only while it is a draft. Publishing copies the configuration into
-- ai_agent_versions; the version row is never updated afterwards.
CREATE TABLE IF NOT EXISTS ai_agents (
  id               TEXT PRIMARY KEY,
  agent_key        TEXT NOT NULL UNIQUE,
  name             TEXT NOT NULL,
  description      TEXT,
  purpose          TEXT,
  category         TEXT,
  icon             TEXT,
  owner_user_id    TEXT REFERENCES users (id) ON DELETE SET NULL,
  team_id          TEXT REFERENCES teams (id) ON DELETE SET NULL,
  visibility       TEXT NOT NULL DEFAULT 'team',
  status           TEXT NOT NULL DEFAULT 'draft',
  draft_config     JSONB NOT NULL DEFAULT '{}'::jsonb,
  current_version  INTEGER,
  data_sensitivity TEXT NOT NULL DEFAULT 'internal',
  is_deleted       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_id    TEXT,
  modified_by_id   TEXT,
  CONSTRAINT ai_agents_status_check CHECK (status IN ('draft', 'published', 'paused', 'archived')),
  CONSTRAINT ai_agents_visibility_check CHECK (visibility IN ('private', 'team', 'organization')),
  CONSTRAINT ai_agents_sensitivity_check CHECK (data_sensitivity IN ('public', 'internal', 'confidential', 'restricted')),
  CONSTRAINT ai_agents_current_version_check CHECK (current_version IS NULL OR current_version > 0)
);

CREATE INDEX IF NOT EXISTS idx_ai_agents_status
  ON ai_agents (status, modified_at DESC)
  WHERE is_deleted = FALSE;

CREATE INDEX IF NOT EXISTS idx_ai_agents_owner
  ON ai_agents (owner_user_id, team_id)
  WHERE is_deleted = FALSE;

CREATE TABLE IF NOT EXISTS ai_agent_versions (
  id               TEXT PRIMARY KEY,
  agent_id         TEXT NOT NULL REFERENCES ai_agents (id) ON DELETE CASCADE,
  version          INTEGER NOT NULL,
  config           JSONB NOT NULL,
  checksum         TEXT NOT NULL,
  provider_key     TEXT,
  model            TEXT,
  fallback_models  JSONB NOT NULL DEFAULT '[]'::jsonb,
  input_schema     JSONB,
  output_schema    JSONB,
  limits           JSONB NOT NULL DEFAULT '{}'::jsonb,
  memory_policy    JSONB NOT NULL DEFAULT '{}'::jsonb,
  trigger_policy   JSONB NOT NULL DEFAULT '{}'::jsonb,
  approval_policy  JSONB NOT NULL DEFAULT '{}'::jsonb,
  published_by_id  TEXT REFERENCES users (id) ON DELETE SET NULL,
  published_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  publication_note TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ai_agent_versions_number_check CHECK (version > 0),
  CONSTRAINT ai_agent_versions_agent_version_key UNIQUE (agent_id, version)
);

CREATE INDEX IF NOT EXISTS idx_ai_agent_versions_agent
  ON ai_agent_versions (agent_id, version DESC);

-- The suffix proves a published snapshot was not mutated after publication (AI.5 verifies it).
COMMENT ON COLUMN ai_agent_versions.checksum IS
  'SHA-256 of the canonical configuration snapshot; verified when a run resolves the version.';

CREATE TABLE IF NOT EXISTS ai_agent_tool_grants (
  id               TEXT PRIMARY KEY,
  agent_version_id TEXT NOT NULL REFERENCES ai_agent_versions (id) ON DELETE CASCADE,
  tool_key         TEXT NOT NULL,
  tool_version     TEXT NOT NULL DEFAULT '1',
  effect_class     TEXT NOT NULL,
  constraints      JSONB NOT NULL DEFAULT '{}'::jsonb,
  requires_approval BOOLEAN NOT NULL DEFAULT FALSE,
  enabled          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ai_agent_tool_grants_effect_check CHECK (effect_class IN ('read', 'low_write', 'material_write', 'high_impact')),
  CONSTRAINT ai_agent_tool_grants_version_tool_key UNIQUE (agent_version_id, tool_key)
);

CREATE INDEX IF NOT EXISTS idx_ai_agent_tool_grants_tool
  ON ai_agent_tool_grants (tool_key, enabled);

-- ---------------------------------------------------------------------------
-- Durable runs and their append-only timeline (§8, §16.1)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ai_agent_runs (
  id                   TEXT PRIMARY KEY,
  agent_id             TEXT NOT NULL REFERENCES ai_agents (id) ON DELETE RESTRICT,
  agent_version_id     TEXT NOT NULL REFERENCES ai_agent_versions (id) ON DELETE RESTRICT,
  agent_version        INTEGER NOT NULL,
  initiated_by_user_id TEXT REFERENCES users (id) ON DELETE SET NULL,
  service_principal    TEXT,
  trigger              TEXT NOT NULL DEFAULT 'manual',
  status               TEXT NOT NULL DEFAULT 'queued',
  input                JSONB NOT NULL DEFAULT '{}'::jsonb,
  input_ref            TEXT,
  idempotency_key      TEXT,
  correlation_id       TEXT,
  causation_id         TEXT,
  lease_owner          TEXT,
  lease_expires_at     TIMESTAMPTZ,
  started_at           TIMESTAMPTZ,
  finished_at          TIMESTAMPTZ,
  expires_at           TIMESTAMPTZ,
  step_count           INTEGER NOT NULL DEFAULT 0,
  model_call_count     INTEGER NOT NULL DEFAULT 0,
  tool_call_count      INTEGER NOT NULL DEFAULT 0,
  input_tokens         INTEGER NOT NULL DEFAULT 0,
  output_tokens        INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd   NUMERIC(18, 8) NOT NULL DEFAULT 0,
  result               JSONB,
  failure_category     TEXT,
  failure_message      TEXT,
  cancel_requested     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ai_agent_runs_trigger_check CHECK (trigger IN ('manual', 'record', 'event', 'schedule', 'integration')),
  CONSTRAINT ai_agent_runs_status_check CHECK (status IN (
    'queued', 'running', 'waiting_for_approval', 'waiting_for_input', 'retry_wait',
    'cancel_requested', 'succeeded', 'partially_succeeded', 'failed', 'canceled',
    'expired', 'blocked_by_policy', 'outcome_unknown'
  )),
  CONSTRAINT ai_agent_runs_principal_check CHECK (num_nonnulls(initiated_by_user_id, service_principal) <= 1),
  CONSTRAINT ai_agent_runs_counters_check CHECK (
    step_count >= 0 AND model_call_count >= 0 AND tool_call_count >= 0
    AND input_tokens >= 0 AND output_tokens >= 0 AND estimated_cost_usd >= 0
  )
);

-- A retried request must not create a second run. The partial index allows many runs without a key
-- (the normal interactive case) while making a provided key unique.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_agent_runs_idempotency
  ON ai_agent_runs (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ai_agent_runs_status_created
  ON ai_agent_runs (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_agent_runs_agent_created
  ON ai_agent_runs (agent_id, created_at DESC);

-- Claim recovery: an expired lease is what lets a sweeper take a stalled run without allowing two
-- workers to execute the same step.
CREATE INDEX IF NOT EXISTS idx_ai_agent_runs_lease
  ON ai_agent_runs (lease_expires_at)
  WHERE status = 'running';

CREATE TABLE IF NOT EXISTS ai_agent_run_events (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES ai_agent_runs (id) ON DELETE CASCADE,
  seq           BIGINT NOT NULL,
  category      TEXT NOT NULL,
  event_type    TEXT NOT NULL,
  actor_type    TEXT NOT NULL DEFAULT 'system',
  actor_id      TEXT,
  correlation_id TEXT,
  causation_id  TEXT,
  summary       TEXT NOT NULL,
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
  visibility    TEXT NOT NULL DEFAULT 'internal',
  redaction     TEXT NOT NULL DEFAULT 'summary',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ai_agent_run_events_seq_check CHECK (seq > 0),
  CONSTRAINT ai_agent_run_events_visibility_check CHECK (visibility IN ('user', 'operator', 'admin')),
  CONSTRAINT ai_agent_run_events_redaction_check CHECK (redaction IN ('summary', 'hashed', 'none')),
  CONSTRAINT ai_agent_run_events_run_seq_key UNIQUE (run_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_ai_agent_run_events_run
  ON ai_agent_run_events (run_id, seq);

-- ---------------------------------------------------------------------------
-- Tool calls and approvals (§7.3, §7.5, §9)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ai_agent_tool_calls (
  id               TEXT PRIMARY KEY,
  run_id           TEXT NOT NULL REFERENCES ai_agent_runs (id) ON DELETE CASCADE,
  step             INTEGER NOT NULL,
  tool_key         TEXT NOT NULL,
  tool_version     TEXT,
  argument_hash    TEXT NOT NULL,
  arguments        JSONB,
  policy_result    TEXT NOT NULL,
  status           TEXT NOT NULL,
  outcome          JSONB,
  result_ref       TEXT,
  error_category   TEXT,
  idempotency_key  TEXT NOT NULL,
  attempt          INTEGER NOT NULL DEFAULT 0,
  duration_ms      INTEGER,
  started_at       TIMESTAMPTZ,
  finished_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ai_agent_tool_calls_step_check CHECK (step >= 0),
  CONSTRAINT ai_agent_tool_calls_policy_check CHECK (policy_result IN ('allowed', 'denied', 'approval_required')),
  CONSTRAINT ai_agent_tool_calls_status_check CHECK (status IN (
    'proposed', 'validated', 'executing', 'succeeded', 'failed', 'outcome_unknown'
  )),
  CONSTRAINT ai_agent_tool_calls_attempt_check CHECK (attempt >= 0),
  CONSTRAINT ai_agent_tool_calls_run_idempotency_key UNIQUE (run_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_ai_agent_tool_calls_run
  ON ai_agent_tool_calls (run_id, step, created_at);

CREATE INDEX IF NOT EXISTS idx_ai_agent_tool_calls_status
  ON ai_agent_tool_calls (status, created_at);

CREATE TABLE IF NOT EXISTS ai_agent_approvals (
  id                    TEXT PRIMARY KEY,
  run_id                TEXT NOT NULL REFERENCES ai_agent_runs (id) ON DELETE CASCADE,
  tool_call_id          TEXT REFERENCES ai_agent_tool_calls (id) ON DELETE SET NULL,
  agent_id              TEXT NOT NULL REFERENCES ai_agents (id) ON DELETE RESTRICT,
  agent_version         INTEGER NOT NULL,
  requested_by_user_id  TEXT REFERENCES users (id) ON DELETE SET NULL,
  action_class          TEXT NOT NULL,
  risk_level            TEXT NOT NULL,
  summary               TEXT NOT NULL,
  proposal              JSONB NOT NULL,
  targets               JSONB NOT NULL DEFAULT '[]'::jsonb,
  expires_at            TIMESTAMPTZ NOT NULL,
  status                TEXT NOT NULL DEFAULT 'pending',
  decided_by_user_id    TEXT REFERENCES users (id) ON DELETE SET NULL,
  decided_at            TIMESTAMPTZ,
  decision_note         TEXT,
  revalidation          JSONB,
  execution_result      JSONB,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ai_agent_approvals_risk_check CHECK (risk_level IN ('read', 'low_write', 'material_write', 'high_impact')),
  CONSTRAINT ai_agent_approvals_status_check CHECK (status IN (
    'pending', 'approved', 'rejected', 'changes_requested', 'expired', 'invalidated', 'executed'
  )),
  CONSTRAINT ai_agent_approvals_decision_check CHECK (
    (status IN ('pending', 'expired', 'invalidated') AND decided_by_user_id IS NULL)
    OR (status NOT IN ('pending', 'expired', 'invalidated'))
  )
);

CREATE INDEX IF NOT EXISTS idx_ai_agent_approvals_pending
  ON ai_agent_approvals (status, expires_at, created_at);

CREATE INDEX IF NOT EXISTS idx_ai_agent_approvals_run
  ON ai_agent_approvals (run_id, created_at);

-- ---------------------------------------------------------------------------
-- Model request ledger and budgets (§12)
-- ---------------------------------------------------------------------------

-- No prompt or completion is stored here by default. The hash allows an operator to correlate an
-- identical retry without reading customer content; usage and cost are exact numeric values.
CREATE TABLE IF NOT EXISTS ai_agent_provider_requests (
  id                   TEXT PRIMARY KEY,
  run_id               TEXT REFERENCES ai_agent_runs (id) ON DELETE SET NULL,
  step                 INTEGER,
  agent_id             TEXT REFERENCES ai_agents (id) ON DELETE SET NULL,
  agent_version        INTEGER,
  provider_key         TEXT NOT NULL,
  model                TEXT NOT NULL,
  request_hash         TEXT NOT NULL,
  request_meta         JSONB NOT NULL DEFAULT '{}'::jsonb,
  response_meta        JSONB NOT NULL DEFAULT '{}'::jsonb,
  input_tokens         INTEGER,
  output_tokens        INTEGER,
  cached_input_tokens  INTEGER,
  latency_ms           INTEGER NOT NULL,
  outcome              TEXT NOT NULL,
  error_category       TEXT,
  estimated_cost_usd   NUMERIC(18, 8),
  provider_request_id  TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ai_agent_provider_requests_latency_check CHECK (latency_ms >= 0),
  CONSTRAINT ai_agent_provider_requests_outcome_check CHECK (outcome IN ('succeeded', 'failed')),
  CONSTRAINT ai_agent_provider_requests_tokens_check CHECK (
    (input_tokens IS NULL OR input_tokens >= 0)
    AND (output_tokens IS NULL OR output_tokens >= 0)
    AND (cached_input_tokens IS NULL OR cached_input_tokens >= 0)
    AND (estimated_cost_usd IS NULL OR estimated_cost_usd >= 0)
  )
);

CREATE INDEX IF NOT EXISTS idx_ai_agent_provider_requests_created
  ON ai_agent_provider_requests (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_agent_provider_requests_run
  ON ai_agent_provider_requests (run_id, created_at);

CREATE INDEX IF NOT EXISTS idx_ai_agent_provider_requests_provider_model
  ON ai_agent_provider_requests (provider_key, model, created_at DESC);

CREATE TABLE IF NOT EXISTS ai_agent_budget_policies (
  id                  TEXT PRIMARY KEY,
  scope               TEXT NOT NULL,
  scope_ref           TEXT,
  provider_key        TEXT,
  agent_id            TEXT REFERENCES ai_agents (id) ON DELETE CASCADE,
  period              TEXT NOT NULL,
  max_requests        INTEGER,
  max_tokens          BIGINT,
  max_cost_usd        NUMERIC(18, 8),
  max_runs            INTEGER,
  max_concurrent_runs INTEGER,
  enabled             BOOLEAN NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ai_agent_budget_policies_scope_check CHECK (scope IN ('global', 'user', 'team', 'agent', 'provider')),
  CONSTRAINT ai_agent_budget_policies_period_check CHECK (period IN ('run', 'day', 'month')),
  CONSTRAINT ai_agent_budget_policies_limits_check CHECK (
    (max_requests IS NULL OR max_requests >= 0)
    AND (max_tokens IS NULL OR max_tokens >= 0)
    AND (max_cost_usd IS NULL OR max_cost_usd >= 0)
    AND (max_runs IS NULL OR max_runs >= 0)
    AND (max_concurrent_runs IS NULL OR max_concurrent_runs >= 0)
  )
);

-- One policy per (scope, target, provider, agent, window). COALESCE keeps the uniqueness real when
-- the optional columns are NULL, which a plain UNIQUE constraint would not do in PostgreSQL.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_agent_budget_policies_target
  ON ai_agent_budget_policies (
    scope,
    COALESCE(scope_ref, ''),
    COALESCE(provider_key, ''),
    COALESCE(agent_id, ''),
    period
  );
