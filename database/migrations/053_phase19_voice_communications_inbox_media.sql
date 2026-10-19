-- Phase 19-VC.12–19-VC.17 — Conversation/inbox history, service templates, recordings, transcripts
-- (PLAN_Phase_19_Voice_Communications.md §15, tasks 19-VC.12 … 19-VC.16).
--
-- Additive only. Everything here is module-owned state; no existing table is altered destructively.

-- ---------------------------------------------------------------------------
-- 19-VC.12/19-VC.13 — conversation history: assignment, status and case links.
-- One row per change, with the acting user and time, so "who moved this and when"
-- is answerable without guessing. Never mutated after insert.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS voice_conversation_events (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES voice_conversations (id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('assigned', 'unassigned', 'status_changed',
                                                'case_linked', 'note')),
  actor_user_id   TEXT,
  actor_type      TEXT NOT NULL DEFAULT 'user' CHECK (actor_type IN ('user', 'system')),
  from_value      TEXT,
  to_value        TEXT,
  detail          TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_voice_conversation_events_conversation
  ON voice_conversation_events (conversation_id, created_at);

-- ---------------------------------------------------------------------------
-- 19-VC.14 — local service snippets. Distinct from `voice_whatsapp_templates`:
-- these are one-to-one composer snippets rendered locally; a WhatsApp template
-- only ever leaves the building through its provider-approved definition.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS voice_message_templates (
  id            TEXT PRIMARY KEY,
  key           TEXT NOT NULL,
  name          TEXT NOT NULL,
  channel       TEXT NOT NULL CHECK (channel IN ('sms', 'mms', 'whatsapp', 'any')),
  body          TEXT NOT NULL,
  placeholders  JSONB NOT NULL DEFAULT '[]'::jsonb,
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_by_id TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_voice_message_templates_key
  ON voice_message_templates (key);

-- ---------------------------------------------------------------------------
-- 19-VC.16 — call transcripts and AI enrichment state. One row per call session.
-- AI output is draft-only: `ai_review_status` starts at 'pending' and nothing
-- external happens until an authorized user moves it to 'approved'.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS voice_transcripts (
  id                 TEXT PRIMARY KEY,
  call_session_id    TEXT NOT NULL REFERENCES voice_call_sessions (id) ON DELETE CASCADE,
  state              TEXT NOT NULL DEFAULT 'pending'
                       CHECK (state IN ('pending', 'ready', 'failed')),
  language           TEXT,
  provider_ref       TEXT,
  segments           JSONB,
  text               TEXT,
  ai_summary         TEXT,
  ai_topics          JSONB,
  ai_actions         JSONB,
  ai_suggested_reply TEXT,
  ai_review_status   TEXT NOT NULL DEFAULT 'none'
                       CHECK (ai_review_status IN ('none', 'pending', 'approved', 'dismissed')),
  ai_connection_key  TEXT,
  ai_model           TEXT,
  ai_generated_at    TIMESTAMPTZ,
  error              TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_voice_transcripts_call
  ON voice_transcripts (call_session_id);
CREATE INDEX IF NOT EXISTS idx_voice_transcripts_state
  ON voice_transcripts (state, created_at);
