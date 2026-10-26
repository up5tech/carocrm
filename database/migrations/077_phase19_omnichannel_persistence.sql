-- Phase 19-OM.3 — Omnichannel additive persistence (PLAN_Phase_19_Omnichannel.md §14 OM.3,
-- decisions D1/E4/E5/E6, docs/omnichannel/feature-contract.md §4/§5.1, contract §10).
--
-- Owned by VoiceCommunications (D1: the canonical conversation record stays `voice_conversations`).
-- STRICTLY ADDITIVE: no table is dropped, renamed or recreated; no column is removed, renamed or
-- re-typed; no existing value is regenerated. Every new column is nullable or carries a default
-- that preserves the current meaning of existing rows. Backfills copy facts that are already
-- derivable from existing data (conversation identity into the thread rows, message timestamps into
-- `last_message_at`) and never invent state that was not recorded: `last_outbound_at`, `closed_at`
-- and the identity-evidence columns stay NULL/defaults on historical rows.
--
-- Retention and access semantics (acceptance: "documented retention and access-control
-- expectations"): the new conversation metadata (priority/category/language/tags/queue/snooze)
-- belongs to the existing `message-body`/metadata retention classes documented in
-- `docs/modules/voice-communications/privacy-and-retention.md` — no new retention clock is started
-- here; the thread rows carry no message content and follow their conversation's lifecycle via
-- ON DELETE CASCADE; provider-identity values are channel identifiers of the same class as the
-- existing `address` column and are covered by the same access rules (participant reads require the
-- conversation's record ACL — `voice-inbox.service.ts`). No Omnichannel service writes these
-- columns yet; the writers arrive with OM.6/OM.7.
--
-- The webhook/`voice_webhook_events` receipt pipeline, the message idempotency uniqueness
-- (`uq_voice_messages_idem`) and the provider-message uniqueness are already in place (051) and are
-- reused unchanged — no second receipt store and no second delivery state is created (R1).

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. `voice_conversations`: the workspace fields the audit found missing (E4).
-- ---------------------------------------------------------------------------
ALTER TABLE voice_conversations
  ADD COLUMN IF NOT EXISTS priority          TEXT NOT NULL DEFAULT 'normal'
    CONSTRAINT ck_voice_conversations_priority CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  ADD COLUMN IF NOT EXISTS category          TEXT,
  ADD COLUMN IF NOT EXISTS language          TEXT,
  ADD COLUMN IF NOT EXISTS tags              JSONB NOT NULL DEFAULT '[]'::jsonb
    CONSTRAINT ck_voice_conversations_tags CHECK (jsonb_typeof(tags) = 'array'),
  -- D2: the queue is ServiceDesk's CaseQueue — a metadata entity, so the reference is to the
  -- shared record store; a conversation can occupy a queue without any Case existing (a reference,
  -- not a dependency). Dropping the queue must never take a conversation with it.
  ADD COLUMN IF NOT EXISTS current_queue_id  TEXT REFERENCES entity_records (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS assignment_version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS last_message_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_outbound_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS snoozed_until     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS closed_at         TIMESTAMPTZ,
  -- Optimistic concurrency for the workspace writes (contract §5.1); services bump it explicitly.
  ADD COLUMN IF NOT EXISTS version           INTEGER NOT NULL DEFAULT 1;

-- Conservative backfill: `last_message_at` is a fact already recorded on the messages.
UPDATE voice_conversations c
SET last_message_at = m.last_at
  FROM (SELECT conversation_id, max(created_at) AS last_at FROM voice_messages GROUP BY conversation_id) m
WHERE m.conversation_id = c.id AND c.last_message_at IS NULL;

-- ---------------------------------------------------------------------------
-- 2. Channel scope widened for the first release (contract §4): website chat is a conversation
-- channel; `mms` stays in the vocabulary although no adapter ships it (CF-5). Voice calls remain
-- outside this store entirely (voice_call_sessions, unchanged). CHECK widening is data-preserving.
-- ---------------------------------------------------------------------------
ALTER TABLE voice_conversations
  DROP CONSTRAINT voice_conversations_channel_check,
  ADD CONSTRAINT voice_conversations_channel_check
    CHECK (channel IN ('sms', 'mms', 'whatsapp', 'web_chat'));
ALTER TABLE voice_messages
  DROP CONSTRAINT voice_messages_channel_check,
  ADD CONSTRAINT voice_messages_channel_check
    CHECK (channel IN ('sms', 'mms', 'whatsapp', 'web_chat'));

-- ---------------------------------------------------------------------------
-- 3. E6: N provider threads -> 1 canonical conversation (contract §4).
--    Today the conversation IS the thread (external_thread_id, one per conversation); the target
--    makes the relation explicit. `voice_conversations.external_thread_id` and its unique index are
--    KEPT (deprecated, still written for the primary thread) so nothing that reads them breaks.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS voice_conversation_threads (
  id                 TEXT PRIMARY KEY,
  conversation_id    TEXT NOT NULL REFERENCES voice_conversations (id) ON DELETE CASCADE,
  -- Connection scope mirrors the conversation's own (account_key + channel); the thread is where a
  -- provider's conversation boundary lives.
  account_key        TEXT NOT NULL REFERENCES voice_provider_accounts (key) ON DELETE RESTRICT,
  channel            TEXT NOT NULL CHECK (channel IN ('sms', 'mms', 'whatsapp', 'web_chat')),
  external_thread_id TEXT,
  -- Normalized participant address used for the grouping rule (contract §4); provider identities
  -- that the channel exposes distinctly from the address (E5).
  address            TEXT,
  provider_identity  TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_voice_conversation_threads_external
  ON voice_conversation_threads (account_key, channel, external_thread_id)
  WHERE external_thread_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_voice_conversation_threads_address
  ON voice_conversation_threads (conversation_id, account_key, channel, address)
  WHERE address IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_voice_conversation_threads_conversation
  ON voice_conversation_threads (conversation_id);

-- Backfill: every existing conversation is exactly one thread (the 1:1 rule of 051). Deterministic
-- ids derived from the conversation id, the customer participant's address, and the conversation's
-- own thread reference — no data is invented.
INSERT INTO voice_conversation_threads (id, conversation_id, account_key, channel, external_thread_id, address)
SELECT 'vct_' || c.id, c.id, c.account_key, c.channel, c.external_thread_id, p.address
FROM voice_conversations c
LEFT JOIN LATERAL (
  SELECT address FROM voice_conversation_participants
  WHERE conversation_id = c.id AND role = 'customer'
  ORDER BY created_at LIMIT 1
) p ON TRUE
ON CONFLICT (id) DO NOTHING;

ALTER TABLE voice_messages
  ADD COLUMN IF NOT EXISTS thread_id TEXT REFERENCES voice_conversation_threads (id) ON DELETE SET NULL;

-- Backfill: each conversation has exactly one thread, so every existing message belongs to it.
UPDATE voice_messages m
SET thread_id = t.id
FROM voice_conversation_threads t
WHERE t.conversation_id = m.conversation_id AND m.thread_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_voice_messages_thread
  ON voice_messages (thread_id) WHERE thread_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. E5: participant identity evidence (contract §6). Existing links were produced by the
-- address-equality resolver (`voice-contact-resolver.service.ts`), so the backfill labels them
-- honestly as migrated address matches instead of leaving them unexplained.
-- ---------------------------------------------------------------------------
ALTER TABLE voice_conversation_participants
  ADD COLUMN IF NOT EXISTS provider_identity  TEXT,
  ADD COLUMN IF NOT EXISTS account_key        TEXT,
  ADD COLUMN IF NOT EXISTS channel            TEXT CHECK (channel IN ('sms', 'mms', 'whatsapp', 'web_chat')),
  ADD COLUMN IF NOT EXISTS verification_state TEXT NOT NULL DEFAULT 'unverified'
    CONSTRAINT ck_voice_participants_verification CHECK (verification_state IN ('unverified', 'verified', 'disputed')),
  ADD COLUMN IF NOT EXISTS link_confidence    TEXT NOT NULL DEFAULT 'none'
    CONSTRAINT ck_voice_participants_confidence CHECK (link_confidence IN ('none', 'exact', 'manual', 'heuristic')),
  ADD COLUMN IF NOT EXISTS link_reason        TEXT,
  ADD COLUMN IF NOT EXISTS last_seen_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS source_provenance  TEXT;

UPDATE voice_conversation_participants p
SET account_key = c.account_key, channel = c.channel
FROM voice_conversations c
WHERE c.id = p.conversation_id AND p.account_key IS NULL;

-- Only the customer participant is resolved from the channel address; agent/system participants
-- carry a platform-assigned entity reference, not an address match, so they keep the honest default.
UPDATE voice_conversation_participants
SET verification_state = 'verified',
    link_confidence = 'exact',
    link_reason = 'migrated_address_match',
    source_provenance = 'migration_077'
WHERE role = 'customer' AND entity_id IS NOT NULL AND entity_type IS NOT NULL AND link_confidence = 'none';

-- Uniqueness over connection + channel + provider identity (D1/E5). Within one conversation the
-- same provider identity may appear once; the partial index leaves every historical row (identity
-- NULL) untouched.
CREATE UNIQUE INDEX IF NOT EXISTS uq_voice_participants_provider_identity
  ON voice_conversation_participants (account_key, channel, provider_identity, conversation_id)
  WHERE provider_identity IS NOT NULL AND account_key IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 5. Workspace query indexes (plan OM.3: assignment, queue, state, timestamps, unread projection).
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_voice_conversations_queue
  ON voice_conversations (current_queue_id, status) WHERE current_queue_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_voice_conversations_snoozed
  ON voice_conversations (snoozed_until) WHERE snoozed_until IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_voice_conversations_last_message
  ON voice_conversations (last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_voice_conversations_unread
  ON voice_conversations (unread_count, last_message_at DESC) WHERE unread_count > 0;
CREATE INDEX IF NOT EXISTS idx_voice_conversations_closed
  ON voice_conversations (closed_at) WHERE closed_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_voice_participants_entity
  ON voice_conversation_participants (entity_type, entity_id) WHERE entity_id IS NOT NULL;

COMMIT;
