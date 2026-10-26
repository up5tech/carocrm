-- Phase 19-OM.9 — Website chat channel (PLAN_Phase_19_Omnichannel.md §14 OM.9;
-- docs/omnichannel/feature-contract.md §7).
--
-- Two additive structures only:
--
-- 1. `omnichannel_visitor_sessions` — the anonymous visitor principal the contract §7 defines.
--    Portal has no anonymous principal and `PortalPolicyService.recordVisible()` is not weakened:
--    the widget is not a Portal surface. The row stores a **hash** of the visitor key (the cookie
--    carries the key; the database never sees it in clear), the consent evidence, the linked
--    canonical conversation (D1: `voice_conversations`) once the first message arrives, and the
--    rate-limit window. Expiry is explicit (`expires_at`), so a stolen cookie stops working.
--
-- 2. A system provider account for the self-hosted channel. `voice_conversations.account_key` is
--    NOT NULL and references `voice_provider_accounts`, and D1 maps OmnichannelConnection onto that
--    table — so the web-chat transport owns exactly one account row, seeded here. It has no
--    credential and no webhook secret because its "provider" is this CRM (`omnichannel-web-chat`
--    adapter registered by the Omnichannel module); the seeded row is what lets the canonical
--    conversation and message records live in the owner tables without a second store.
--
-- Retention: a visitor session is metadata of the same class as the conversation it points to and
-- follows the conversation's lifecycle (ON DELETE SET NULL — deleting a conversation never deletes
-- the visitor's consent evidence). `expires_at` bounds the anonymous principal; the session row and
-- the conversation messages keep the repository's `message-body`/metadata retention classes
-- (docs/modules/voice-communications/privacy-and-retention.md). No message content is duplicated
-- here.

BEGIN;

CREATE TABLE IF NOT EXISTS omnichannel_visitor_sessions (
  id                 TEXT PRIMARY KEY,
  -- sha256(visitor key); the key itself lives only in the visitor's httpOnly cookie.
  visitor_key_hash   TEXT NOT NULL,
  conversation_id    TEXT REFERENCES voice_conversations (id) ON DELETE SET NULL,
  status             TEXT NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active', 'expired', 'revoked')),
  consent_state      TEXT NOT NULL DEFAULT 'pending'
                       CHECK (consent_state IN ('pending', 'granted', 'declined')),
  consent_version    TEXT,
  consent_at         TIMESTAMPTZ,
  identified_entity_type TEXT,
  identified_entity_id   TEXT,
  ip_hash            TEXT,
  user_agent         TEXT,
  message_count      INTEGER NOT NULL DEFAULT 0,
  window_started_at  TIMESTAMPTZ,
  window_messages    INTEGER NOT NULL DEFAULT 0,
  first_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at         TIMESTAMPTZ NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_omnichannel_visitor_sessions_key
  ON omnichannel_visitor_sessions (visitor_key_hash);
CREATE INDEX IF NOT EXISTS idx_omnichannel_visitor_sessions_expiry
  ON omnichannel_visitor_sessions (expires_at);
CREATE INDEX IF NOT EXISTS idx_omnichannel_visitor_sessions_conversation
  ON omnichannel_visitor_sessions (conversation_id) WHERE conversation_id IS NOT NULL;

-- The web-chat transport's single connection row (see the header). Idempotent on re-run.
INSERT INTO voice_provider_accounts
  (id, key, provider_key, label, environment, enabled, capabilities, config,
   created_at, modified_at)
VALUES
  ('omnichannel-web-chat', 'omnichannel-web-chat', 'omnichannel-web-chat',
   'Website chat (self-hosted)', 'production', TRUE,
   '["messaging.web_chat.send", "messaging.web_chat.receive"]'::jsonb, '{}'::jsonb,
   now(), now())
ON CONFLICT (key) DO NOTHING;

COMMIT;
