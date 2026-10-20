-- Phase 19-CHAT.3 — the three tables Chat owns (PLAN_Phase_19_CRM_Chat.md §7, §17 `19-CHAT.3`).
--
-- Additive only (AGENTS.md §3.5): three new tables and their indexes. No existing table is altered,
-- no column is renamed or repurposed, and no row is rewritten. Conversation and message history stay
-- in `ai_agent_conversations` / `ai_agent_messages` (contract decision D1), so this migration must not
-- create a `crm_chat_conversations` or `crm_chat_turns` twin — a second owner would mean two retention
-- policies and two orderings for the same thread.
--
-- What is genuinely Chat-specific is recorded here:
--   1. a citation rendered under an assistant message, re-checked against ACL when it was produced;
--   2. one rating per user per answer;
--   3. a user's saved prompt templates, which are data and are never executed.
--
-- Every child row cascades from the AI Agents conversation/message it belongs to, so the AI Agents
-- retention sweep remains the single executor: when the thread is removed, Chat's rows go with it and
-- nothing is orphaned. Idempotency for turn submission is *not* re-implemented here — it is the
-- existing `uq_ai_agent_runs_idempotency` partial unique index from migration 045, which is what makes
-- concurrent duplicate submissions impossible at the database level.

-- ---------------------------------------------------------------------------
-- Citations (§7.4, 19-CHAT.8)
-- ---------------------------------------------------------------------------

-- `label` and `route` are produced by Chat from an allowlisted entity/record pair after re-reading the
-- record under the caller's ACL; the model supplies neither. A citation for a record the caller may no
-- longer read is deleted or withheld — never rendered with a fabricated label.
CREATE TABLE IF NOT EXISTS crm_chat_citations (
  id              TEXT PRIMARY KEY,
  message_id      TEXT NOT NULL REFERENCES ai_agent_messages (id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES ai_agent_conversations (id) ON DELETE CASCADE,
  source_type     TEXT NOT NULL,
  entity          TEXT,
  record_id       TEXT,
  label           TEXT NOT NULL,
  route           TEXT NOT NULL DEFAULT '',
  ordinal         INTEGER NOT NULL DEFAULT 0,
  rechecked_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT crm_chat_citations_source_check
    CHECK (source_type IN ('crm_record', 'query_result', 'report', 'help_document')),
  -- A record citation without a target would be unverifiable, and a non-record citation with one would
  -- claim a record it does not point at.
  CONSTRAINT crm_chat_citations_target_check CHECK (
    (source_type = 'crm_record' AND entity IS NOT NULL AND record_id IS NOT NULL)
    OR (source_type <> 'crm_record' AND entity IS NULL AND record_id IS NULL)
  ),
  CONSTRAINT crm_chat_citations_label_check CHECK (length(btrim(label)) BETWEEN 1 AND 200),
  CONSTRAINT crm_chat_citations_ordinal_check CHECK (ordinal >= 0),
  CONSTRAINT crm_chat_citations_message_ordinal_key UNIQUE (message_id, ordinal)
);

CREATE INDEX IF NOT EXISTS idx_crm_chat_citations_conversation
  ON crm_chat_citations (conversation_id, ordinal);

CREATE INDEX IF NOT EXISTS idx_crm_chat_citations_record
  ON crm_chat_citations (entity, record_id)
  WHERE source_type = 'crm_record';

-- ---------------------------------------------------------------------------
-- Answer feedback (§7.6, 19-CHAT.11)
-- ---------------------------------------------------------------------------

-- One rating per user per answer: a second submission is an update, not a second vote. The owner is
-- stored on the row so a rating can be attributed and swept by user without joining the conversation.
CREATE TABLE IF NOT EXISTS crm_chat_feedback (
  id              TEXT PRIMARY KEY,
  message_id      TEXT NOT NULL REFERENCES ai_agent_messages (id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES ai_agent_conversations (id) ON DELETE CASCADE,
  owner_user_id   TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  rating          TEXT NOT NULL,
  category        TEXT,
  comment         TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT crm_chat_feedback_rating_check CHECK (rating IN ('up', 'down')),
  CONSTRAINT crm_chat_feedback_category_check CHECK (category IS NULL OR length(category) <= 60),
  CONSTRAINT crm_chat_feedback_comment_check CHECK (comment IS NULL OR length(comment) <= 2000),
  CONSTRAINT crm_chat_feedback_message_owner_key UNIQUE (message_id, owner_user_id)
);

CREATE INDEX IF NOT EXISTS idx_crm_chat_feedback_owner
  ON crm_chat_feedback (owner_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_crm_chat_feedback_conversation
  ON crm_chat_feedback (conversation_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Saved prompt templates (§7.6, 19-CHAT.14)
-- ---------------------------------------------------------------------------

-- Templates are the caller's own data: a name and a body the user can reuse. Nothing here is executed,
-- and there is no shared/global scope — a template that others can see is an administrated feature the
-- plan does not ask for.
CREATE TABLE IF NOT EXISTS crm_chat_prompts (
  id              TEXT PRIMARY KEY,
  owner_user_id   TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  prompt_template TEXT NOT NULL,
  description     TEXT,
  enabled         BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT crm_chat_prompts_name_check CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  CONSTRAINT crm_chat_prompts_template_check CHECK (length(btrim(prompt_template)) BETWEEN 1 AND 8000),
  CONSTRAINT crm_chat_prompts_description_check CHECK (description IS NULL OR length(description) <= 500),
  CONSTRAINT crm_chat_prompts_owner_name_key UNIQUE (owner_user_id, name)
);

CREATE INDEX IF NOT EXISTS idx_crm_chat_prompts_owner
  ON crm_chat_prompts (owner_user_id, modified_at DESC)
  WHERE enabled;

COMMENT ON TABLE crm_chat_citations IS
  'Citations rendered under an assistant message. Written only from an ACL-checked re-read; the model supplies no label, route or target.';
COMMENT ON TABLE crm_chat_feedback IS
  'One rating per user per answer. Cascades from the AI Agents message, so retention stays with its owner.';
COMMENT ON TABLE crm_chat_prompts IS
  'Owner-scoped reusable prompt text. Data only: a template is inserted into the composer, never executed by the server.';
COMMENT ON COLUMN crm_chat_citations.rechecked_at IS
  'When the record was last read under the asking user''s ACL; a stale citation is withdrawn rather than shown with a stale label.';
