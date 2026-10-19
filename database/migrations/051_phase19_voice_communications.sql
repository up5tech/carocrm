-- Phase 19-VC.3 — Voice & Communications persistence.
-- Additive only: new tables, indexes and constraints. No existing table, column or row is touched.
-- Provider accounts/endpoints, webhook receipts, normalized events, call sessions, conversations,
-- participants, messages, media, consent evidence and suppressions.
-- The CRM records this module links to (Contact, Lead, Account, Call, Case) stay where they are.

CREATE TABLE IF NOT EXISTS voice_provider_accounts (
  id                        TEXT PRIMARY KEY,
  key                       TEXT NOT NULL,
  provider_key              TEXT NOT NULL,
  label                     TEXT NOT NULL,
  environment               TEXT NOT NULL DEFAULT 'test'
                              CHECK (environment IN ('test', 'production')),
  enabled                   BOOLEAN NOT NULL DEFAULT FALSE,
  capabilities              JSONB NOT NULL DEFAULT '[]'::jsonb,
  config                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- AES-256-GCM payload from @carocrm/core encryptSecret; never plaintext.
  credential_encrypted      TEXT,
  credential_hint           TEXT,
  webhook_secret_encrypted  TEXT,
  webhook_secret_hint       TEXT,
  last_health_status        TEXT,
  last_health_detail        TEXT,
  last_health_at            TIMESTAMPTZ,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_id             TEXT,
  modified_by_id            TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_voice_provider_accounts_key
  ON voice_provider_accounts (key);
CREATE INDEX IF NOT EXISTS idx_voice_provider_accounts_provider
  ON voice_provider_accounts (provider_key, enabled);

CREATE TABLE IF NOT EXISTS voice_endpoints (
  id               TEXT PRIMARY KEY,
  account_key      TEXT NOT NULL REFERENCES voice_provider_accounts (key) ON DELETE CASCADE,
  key              TEXT NOT NULL,
  channel          TEXT NOT NULL CHECK (channel IN ('voice', 'sms', 'mms', 'whatsapp')),
  -- Normalized E.164. `display_address` keeps what the operator typed.
  address          TEXT NOT NULL,
  display_address  TEXT NOT NULL,
  country          TEXT,
  capabilities     JSONB NOT NULL DEFAULT '[]'::jsonb,
  active           BOOLEAN NOT NULL DEFAULT TRUE,
  team_id          TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_voice_endpoints_address
  ON voice_endpoints (account_key, channel, address);
CREATE UNIQUE INDEX IF NOT EXISTS uq_voice_endpoints_key
  ON voice_endpoints (account_key, key);
CREATE INDEX IF NOT EXISTS idx_voice_endpoints_channel
  ON voice_endpoints (channel, active);

CREATE TABLE IF NOT EXISTS voice_webhook_events (
  id                 TEXT PRIMARY KEY,
  account_key        TEXT NOT NULL REFERENCES voice_provider_accounts (key) ON DELETE CASCADE,
  provider_key       TEXT NOT NULL,
  vendor_event_id    TEXT,
  -- Deterministic idempotency key: the provider's event id, or a digest of type+object+time.
  dedup_key          TEXT NOT NULL,
  event_type         TEXT NOT NULL,
  signature_valid    BOOLEAN NOT NULL DEFAULT FALSE,
  processing_status  TEXT NOT NULL DEFAULT 'received'
                       CHECK (processing_status IN ('received', 'processed', 'rejected', 'failed', 'enqueue_failed')),
  attempts           INTEGER NOT NULL DEFAULT 0,
  failure_code       TEXT,
  failure_detail     TEXT,
  payload_digest     TEXT,
  -- Redacted payload only; credential-like keys are removed before persistence.
  payload_redacted   JSONB,
  received_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at       TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_voice_webhook_events_dedup
  ON voice_webhook_events (account_key, dedup_key);
CREATE INDEX IF NOT EXISTS idx_voice_webhook_events_status
  ON voice_webhook_events (processing_status, received_at);
CREATE INDEX IF NOT EXISTS idx_voice_webhook_events_provider
  ON voice_webhook_events (provider_key, received_at);

CREATE TABLE IF NOT EXISTS voice_communication_events (
  id               TEXT PRIMARY KEY,
  webhook_event_id TEXT NOT NULL REFERENCES voice_webhook_events (id) ON DELETE CASCADE,
  account_key      TEXT NOT NULL,
  provider_key     TEXT NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('call', 'message', 'status', 'unknown')),
  state            TEXT,
  external_id      TEXT,
  direction        TEXT CHECK (direction IN ('inbound', 'outbound')),
  channel          TEXT CHECK (channel IN ('voice', 'sms', 'mms', 'whatsapp')),
  from_address     TEXT,
  to_address       TEXT,
  body             TEXT,
  occurred_at      TIMESTAMPTZ,
  payload          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- One normalized event per receipt: a replayed job cannot create a second one.
CREATE UNIQUE INDEX IF NOT EXISTS uq_voice_communication_events_receipt
  ON voice_communication_events (webhook_event_id);
CREATE INDEX IF NOT EXISTS idx_voice_communication_events_external
  ON voice_communication_events (kind, external_id);
CREATE INDEX IF NOT EXISTS idx_voice_communication_events_from
  ON voice_communication_events (from_address, created_at);

CREATE TABLE IF NOT EXISTS voice_call_sessions (
  id                  TEXT PRIMARY KEY,
  account_key         TEXT NOT NULL REFERENCES voice_provider_accounts (key) ON DELETE RESTRICT,
  endpoint_id         TEXT REFERENCES voice_endpoints (id) ON DELETE SET NULL,
  direction           TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  state               TEXT NOT NULL DEFAULT 'requested'
                        CHECK (state IN ('requested', 'initiated', 'ringing', 'in_progress',
                                         'completed', 'missed', 'busy', 'no_answer', 'failed',
                                         'cancelled', 'unknown')),
  provider_call_id    TEXT,
  from_number         TEXT,
  to_number           TEXT,
  from_display        TEXT,
  to_display          TEXT,
  started_at          TIMESTAMPTZ,
  answered_at         TIMESTAMPTZ,
  ended_at            TIMESTAMPTZ,
  duration_seconds    INTEGER,
  result              TEXT,
  failure_category    TEXT,
  initiator_user_id   TEXT,
  assigned_user_id    TEXT,
  related_entity_type TEXT,
  related_entity_id   TEXT,
  recording_ref       TEXT,
  -- The platform `Call` Activity this session logs to; one session, one Activity (19-VC.7).
  activity_id         TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_voice_call_sessions_provider_call
  ON voice_call_sessions (account_key, provider_call_id)
  WHERE provider_call_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_voice_call_sessions_state
  ON voice_call_sessions (state, started_at);
CREATE INDEX IF NOT EXISTS idx_voice_call_sessions_from
  ON voice_call_sessions (from_number, created_at);
CREATE INDEX IF NOT EXISTS idx_voice_call_sessions_to
  ON voice_call_sessions (to_number, created_at);
CREATE INDEX IF NOT EXISTS idx_voice_call_sessions_related
  ON voice_call_sessions (related_entity_type, related_entity_id);

CREATE TABLE IF NOT EXISTS voice_conversations (
  id                  TEXT PRIMARY KEY,
  account_key         TEXT NOT NULL REFERENCES voice_provider_accounts (key) ON DELETE RESTRICT,
  channel             TEXT NOT NULL CHECK (channel IN ('sms', 'mms', 'whatsapp')),
  external_thread_id  TEXT,
  status              TEXT NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open', 'pending_customer', 'pending_internal',
                                         'resolved', 'closed', 'spam')),
  subject             TEXT,
  assigned_user_id    TEXT,
  assigned_team_id    TEXT,
  unread_count        INTEGER NOT NULL DEFAULT 0,
  last_activity_at    TIMESTAMPTZ,
  last_inbound_at     TIMESTAMPTZ,
  related_entity_type TEXT,
  related_entity_id   TEXT,
  -- Service Desk Case reference. Conversation status never mutates Case status (plan §9.2).
  case_id             TEXT,
  archived            BOOLEAN NOT NULL DEFAULT FALSE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_voice_conversations_thread
  ON voice_conversations (account_key, channel, external_thread_id)
  WHERE external_thread_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_voice_conversations_status
  ON voice_conversations (status, last_activity_at DESC);
CREATE INDEX IF NOT EXISTS idx_voice_conversations_assignee
  ON voice_conversations (assigned_user_id, status);
CREATE INDEX IF NOT EXISTS idx_voice_conversations_team
  ON voice_conversations (assigned_team_id, status);
CREATE INDEX IF NOT EXISTS idx_voice_conversations_related
  ON voice_conversations (related_entity_type, related_entity_id);

CREATE TABLE IF NOT EXISTS voice_conversation_participants (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES voice_conversations (id) ON DELETE CASCADE,
  address         TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'customer'
                    CHECK (role IN ('customer', 'agent', 'system')),
  -- A reference to the CRM record, never a copy of its fields.
  entity_type     TEXT,
  entity_id       TEXT,
  display_name    TEXT,
  consent_status  TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_voice_conversation_participants
  ON voice_conversation_participants (conversation_id, address, role);
CREATE INDEX IF NOT EXISTS idx_voice_conversation_participants_address
  ON voice_conversation_participants (address);

CREATE TABLE IF NOT EXISTS voice_messages (
  id                  TEXT PRIMARY KEY,
  conversation_id     TEXT NOT NULL REFERENCES voice_conversations (id) ON DELETE CASCADE,
  account_key         TEXT NOT NULL REFERENCES voice_provider_accounts (key) ON DELETE RESTRICT,
  channel             TEXT NOT NULL CHECK (channel IN ('sms', 'mms', 'whatsapp')),
  direction           TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  body                TEXT,
  content_type        TEXT NOT NULL DEFAULT 'text/plain',
  provider_message_id TEXT,
  state               TEXT NOT NULL DEFAULT 'queued'
                        CHECK (state IN ('draft', 'queued', 'submitted', 'sent', 'delivered',
                                         'read', 'failed', 'undelivered', 'unknown')),
  is_internal_note    BOOLEAN NOT NULL DEFAULT FALSE,
  template_key        TEXT,
  author_user_id      TEXT,
  sent_at             TIMESTAMPTZ,
  delivered_at        TIMESTAMPTZ,
  failed_at           TIMESTAMPTZ,
  failure_category    TEXT,
  failure_detail      TEXT,
  occurred_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- An internal note is structurally unable to be an external message.
  CONSTRAINT ck_voice_messages_internal_note
    CHECK (NOT (is_internal_note AND provider_message_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_voice_messages_provider_message
  ON voice_messages (account_key, provider_message_id)
  WHERE provider_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_voice_messages_conversation
  ON voice_messages (conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_voice_messages_state
  ON voice_messages (state, created_at);

CREATE TABLE IF NOT EXISTS voice_media (
  id               TEXT PRIMARY KEY,
  message_id       TEXT REFERENCES voice_messages (id) ON DELETE CASCADE,
  call_session_id  TEXT REFERENCES voice_call_sessions (id) ON DELETE CASCADE,
  kind             TEXT NOT NULL CHECK (kind IN ('attachment', 'recording', 'transcript')),
  provider_ref     TEXT,
  storage_ref      TEXT,
  mime_type        TEXT,
  size_bytes       BIGINT,
  duration_seconds INTEGER,
  sha256           TEXT,
  scan_status      TEXT NOT NULL DEFAULT 'pending'
                     CHECK (scan_status IN ('pending', 'clean', 'infected', 'skipped')),
  retention_at     TIMESTAMPTZ,
  transcript_state TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_voice_media_parent
    CHECK (message_id IS NOT NULL OR call_session_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_voice_media_message
  ON voice_media (message_id);
CREATE INDEX IF NOT EXISTS idx_voice_media_call
  ON voice_media (call_session_id);
CREATE INDEX IF NOT EXISTS idx_voice_media_retention
  ON voice_media (retention_at);

CREATE TABLE IF NOT EXISTS voice_consent_events (
  id            TEXT PRIMARY KEY,
  channel       TEXT NOT NULL CHECK (channel IN ('voice', 'sms', 'mms', 'whatsapp')),
  address       TEXT NOT NULL,
  purpose       TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('granted', 'denied', 'revoked', 'unknown')),
  basis         TEXT,
  source        TEXT NOT NULL,
  evidence      TEXT,
  occurred_at   TIMESTAMPTZ NOT NULL,
  actor_user_id TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_voice_consent_events_lookup
  ON voice_consent_events (channel, address, purpose, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_voice_consent_events_address
  ON voice_consent_events (address, occurred_at DESC);

CREATE TABLE IF NOT EXISTS voice_suppressions (
  id         TEXT PRIMARY KEY,
  channel    TEXT NOT NULL CHECK (channel IN ('voice', 'sms', 'mms', 'whatsapp')),
  address    TEXT NOT NULL,
  reason     TEXT NOT NULL,
  source     TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);
-- At most one active suppression per channel and address; revoked history stays readable.
CREATE UNIQUE INDEX IF NOT EXISTS uq_voice_suppressions_active
  ON voice_suppressions (channel, address)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_voice_suppressions_address
  ON voice_suppressions (address);
