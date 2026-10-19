-- Phase 19-AI.12 — conversations, messages and scoped memory (PLAN_Phase_19_AI_Agents.md §10, §20).
--
-- Additive only (AGENTS.md §3.5): new tables, one nullable column and indexes. No existing row is
-- rewritten and no column is dropped or repurposed. A run without a conversation stays `NULL`, so
-- every pre-existing run and every no-memory agent keeps exactly the behaviour it had.
--
-- Retention is explicit rather than implied: a conversation stores its own `expires_at`, the module
-- settings carry the window, and the retention job deletes only rows past that window or already
-- marked deleted. Nothing cascades into another module's data.

-- ---------------------------------------------------------------------------
-- Conversation thread (§10.1 "conversation memory")
-- ---------------------------------------------------------------------------

-- Owner-scoped: a conversation belongs to exactly one authenticated user. It is never shared by
-- knowing its id; the service refuses a thread whose `owner_user_id` is not the caller.
CREATE TABLE IF NOT EXISTS ai_agent_conversations (
  id                    TEXT PRIMARY KEY,
  agent_id              TEXT NOT NULL REFERENCES ai_agents (id) ON DELETE CASCADE,
  owner_user_id         TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  title                 TEXT,
  status                TEXT NOT NULL DEFAULT 'active',
  related_entity        TEXT,
  related_id            TEXT,
  message_count         INTEGER NOT NULL DEFAULT 0,
  summary               TEXT,
  summary_message_count INTEGER NOT NULL DEFAULT 0,
  last_activity_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at            TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ai_agent_conversations_status_check CHECK (status IN ('active', 'archived', 'deleted')),
  CONSTRAINT ai_agent_conversations_counts_check CHECK (message_count >= 0 AND summary_message_count >= 0)
);

CREATE INDEX IF NOT EXISTS idx_ai_agent_conversations_owner
  ON ai_agent_conversations (owner_user_id, last_activity_at DESC)
  WHERE status <> 'deleted';

CREATE INDEX IF NOT EXISTS idx_ai_agent_conversations_agent
  ON ai_agent_conversations (agent_id, last_activity_at DESC)
  WHERE status <> 'deleted';

CREATE INDEX IF NOT EXISTS idx_ai_agent_conversations_expiry
  ON ai_agent_conversations (expires_at)
  WHERE status <> 'deleted';

-- ---------------------------------------------------------------------------
-- Messages (§4.4, §10.2)
-- ---------------------------------------------------------------------------

-- `content` is the message body. Redaction records how much of it is safe to show: a `summary` row
-- was truncated before storage and a `hashed` row deliberately has no readable body. Tool messages
-- are never stored with raw arguments; the tool-call ledger remains the authoritative record.
CREATE TABLE IF NOT EXISTS ai_agent_messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES ai_agent_conversations (id) ON DELETE CASCADE,
  run_id          TEXT REFERENCES ai_agent_runs (id) ON DELETE SET NULL,
  seq             BIGINT NOT NULL,
  role            TEXT NOT NULL,
  content         TEXT NOT NULL,
  content_meta    JSONB NOT NULL DEFAULT '{}'::jsonb,
  redaction       TEXT NOT NULL DEFAULT 'none',
  token_count     INTEGER,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ai_agent_messages_seq_check CHECK (seq > 0),
  CONSTRAINT ai_agent_messages_role_check CHECK (role IN ('user', 'assistant', 'tool', 'system')),
  CONSTRAINT ai_agent_messages_redaction_check CHECK (redaction IN ('none', 'summary', 'hashed')),
  CONSTRAINT ai_agent_messages_token_check CHECK (token_count IS NULL OR token_count >= 0),
  CONSTRAINT ai_agent_messages_conversation_seq_key UNIQUE (conversation_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_ai_agent_messages_conversation
  ON ai_agent_messages (conversation_id, seq);

CREATE INDEX IF NOT EXISTS idx_ai_agent_messages_run
  ON ai_agent_messages (run_id, seq);

-- ---------------------------------------------------------------------------
-- Scoped memory items (§10.1, §10.2)
-- ---------------------------------------------------------------------------

-- Kinds are deliberately narrow: a rolling conversation summary, a resumable run checkpoint and an
-- explicitly curated fact. Source references point at CRM records and are re-checked against ACL
-- before they are put in a prompt; a summary never substitutes for current record state.
CREATE TABLE IF NOT EXISTS ai_agent_memory_items (
  id              TEXT PRIMARY KEY,
  scope           TEXT NOT NULL,
  owner_user_id   TEXT REFERENCES users (id) ON DELETE CASCADE,
  agent_id        TEXT REFERENCES ai_agents (id) ON DELETE CASCADE,
  conversation_id TEXT REFERENCES ai_agent_conversations (id) ON DELETE CASCADE,
  run_id          TEXT REFERENCES ai_agent_runs (id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,
  content         TEXT NOT NULL,
  source_refs     JSONB NOT NULL DEFAULT '[]'::jsonb,
  sensitivity     TEXT NOT NULL DEFAULT 'internal',
  confidence      NUMERIC(4, 3),
  expires_at      TIMESTAMPTZ,
  deleted_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ai_agent_memory_items_scope_check CHECK (scope IN ('user', 'agent', 'conversation', 'run')),
  CONSTRAINT ai_agent_memory_items_kind_check CHECK (kind IN ('conversation_summary', 'run_checkpoint', 'curated_fact')),
  CONSTRAINT ai_agent_memory_items_sensitivity_check CHECK (sensitivity IN ('public', 'internal', 'confidential', 'restricted')),
  CONSTRAINT ai_agent_memory_items_confidence_check CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  CONSTRAINT ai_agent_memory_items_owner_check CHECK (scope <> 'user' OR owner_user_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_ai_agent_memory_items_conversation
  ON ai_agent_memory_items (conversation_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_ai_agent_memory_items_run
  ON ai_agent_memory_items (run_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_ai_agent_memory_items_expiry
  ON ai_agent_memory_items (expires_at)
  WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Run → conversation link
-- ---------------------------------------------------------------------------

ALTER TABLE ai_agent_runs
  ADD COLUMN IF NOT EXISTS conversation_id TEXT REFERENCES ai_agent_conversations (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_ai_agent_runs_conversation
  ON ai_agent_runs (conversation_id, created_at DESC);

COMMENT ON COLUMN ai_agent_runs.conversation_id IS
  'Set only when the captured agent version uses conversation memory; NULL means a no-memory run.';
COMMENT ON COLUMN ai_agent_conversations.summary IS
  'Deterministic rolling extract of messages before summary_message_count; never a substitute for current CRM data.';
COMMENT ON TABLE ai_agent_memory_items IS
  'Scoped memory with provenance and expiry. Retention deletes expired or deleted rows; no broad cascade.';
