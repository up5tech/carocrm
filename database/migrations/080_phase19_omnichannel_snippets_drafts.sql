-- Phase 19-OM.12 — canned replies, drafts and message tools
-- (PLAN_Phase_19_Omnichannel.md §14 OM.12; ownership: snippets in VoiceCommunications, drafts in
-- Omnichannel).
--
-- 1. `voice_message_templates` (the existing shared snippet store, VC.14) gains what the workspace
--    needs to present snippets safely: per-team visibility, a language tag and an operational
--    usage counter (a count and a timestamp only — never message content). Additive columns with
--    defaults, so every existing snippet keeps working exactly as before (`team_id` NULL = all
--    teams, `language` NULL = any language).
--
-- 2. `omnichannel_drafts` — an agent's unsent reply is workspace state, not a communication record:
--    it must not appear in the transcript, must never reach an adapter, and belongs to one agent.
--    One draft per conversation per agent (unique), cascading with the conversation.
--
-- Retention: a draft follows its conversation's lifecycle (ON DELETE CASCADE) and is deleted the
-- moment it is sent; it is not a message and carries no provider or delivery state.

BEGIN;

ALTER TABLE voice_message_templates
  ADD COLUMN IF NOT EXISTS team_id      TEXT REFERENCES teams (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS language     TEXT,
  ADD COLUMN IF NOT EXISTS usage_count  INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_voice_message_templates_team
  ON voice_message_templates (team_id) WHERE team_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS omnichannel_drafts (
  id               TEXT PRIMARY KEY,
  conversation_id  TEXT NOT NULL REFERENCES voice_conversations (id) ON DELETE CASCADE,
  user_id          TEXT NOT NULL,
  body             TEXT NOT NULL,
  is_internal_note BOOLEAN NOT NULL DEFAULT FALSE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_omnichannel_drafts_conversation_user
  ON omnichannel_drafts (conversation_id, user_id);
CREATE INDEX IF NOT EXISTS idx_omnichannel_drafts_user
  ON omnichannel_drafts (user_id);

COMMIT;
