-- Phase 19-AI.14 — evaluation suites, cases and results
-- (PLAN_Phase_19_AI_Agents.md §17, §20 `19-AI.14`).
--
-- An evaluation is a repeatable engineering artifact, not a score that proves safety (§17.1). A
-- suite groups cases; each case names a deterministic grader (schema validity, tool permissions,
-- approval policy, budget bounds, provider policy, memory policy, ownership, exact invariants) or
-- a clearly-labelled review grader (human review is recorded with a decision; a model-based grader
-- is advisory only and can never flip a failed deterministic result). A run stores every case
-- outcome against one configuration checksum, so the publication gate can require a *passing*
-- evaluation of the exact draft it is about to publish, and a report can compare the current draft
-- with the previously published version.

CREATE TABLE IF NOT EXISTS ai_agent_eval_suites (
  id                  TEXT PRIMARY KEY,
  suite_key           TEXT NOT NULL,
  name                TEXT NOT NULL,
  description         TEXT,
  -- A required suite blocks publication of a draft it has not passed (§17.4).
  required_for_publish BOOLEAN NOT NULL DEFAULT TRUE,
  enabled             BOOLEAN NOT NULL DEFAULT TRUE,
  created_by_user_id  TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_agent_eval_suites_key
  ON ai_agent_eval_suites (suite_key);

CREATE TABLE IF NOT EXISTS ai_agent_eval_cases (
  id           TEXT PRIMARY KEY,
  suite_id     TEXT NOT NULL REFERENCES ai_agent_eval_suites (id) ON DELETE CASCADE,
  case_key     TEXT NOT NULL,
  title        TEXT NOT NULL,
  -- Deterministic graders run offline and are mandatory; review graders carry clear labels and,
  -- for model-based ones, advisory weight only (§17.3, §17.4).
  grader       TEXT NOT NULL,
  grader_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ai_agent_eval_cases_grader_check CHECK (
    grader IN (
      'config_schema', 'tool_permissions', 'approval_policy', 'budget_bounded',
      'provider_policy', 'memory_policy', 'ownership', 'exact_invariant',
      'human_review', 'model_review'
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_agent_eval_cases_key
  ON ai_agent_eval_cases (suite_id, case_key);

CREATE TABLE IF NOT EXISTS ai_agent_eval_runs (
  id               TEXT PRIMARY KEY,
  agent_id         TEXT NOT NULL REFERENCES ai_agents (id) ON DELETE CASCADE,
  suite_id         TEXT NOT NULL REFERENCES ai_agent_eval_suites (id) ON DELETE CASCADE,
  -- The exact configuration this run graded; the publication gate matches it against the draft.
  config_checksum  TEXT NOT NULL,
  agent_version    INTEGER,
  status           TEXT NOT NULL,
  results          JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by_user_id TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ai_agent_eval_runs_status_check CHECK (status IN ('passed', 'failed', 'pending_review'))
);

CREATE INDEX IF NOT EXISTS idx_ai_agent_eval_runs_agent
  ON ai_agent_eval_runs (agent_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_agent_eval_runs_suite_checksum
  ON ai_agent_eval_runs (suite_id, config_checksum, status);
