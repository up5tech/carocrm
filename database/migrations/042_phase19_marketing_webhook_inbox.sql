-- Phase 19-MA.10
CREATE TABLE IF NOT EXISTS marketing_provider_webhook_inbox (
  id              TEXT PRIMARY KEY,
  provider        TEXT NOT NULL,
  provider_event_id TEXT,
  dedup_key       TEXT NOT NULL,
  event_type      TEXT NOT NULL,
  signature_valid BOOLEAN NOT NULL DEFAULT FALSE,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at    TIMESTAMPTZ,
  processing_status TEXT NOT NULL DEFAULT 'received',
  failure_reason  TEXT,
  normalized_event_type TEXT,
  campaign_id     TEXT,
  send_id         TEXT,
  provider_message_id TEXT,
  recipient_entity_type TEXT,
  recipient_entity_id TEXT,
  raw_summary     JSONB
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_marketing_webhook_inbox_dedup
  ON marketing_provider_webhook_inbox (provider, dedup_key);
CREATE INDEX IF NOT EXISTS idx_marketing_webhook_inbox_status
  ON marketing_provider_webhook_inbox (processing_status, received_at);
CREATE TABLE IF NOT EXISTS marketing_events (
  id                TEXT PRIMARY KEY,
  inbox_id          TEXT REFERENCES marketing_provider_webhook_inbox (id) ON DELETE SET NULL,
  provider          TEXT NOT NULL,
  provider_event_id TEXT,
  event_type        TEXT NOT NULL,
  normalized_type   TEXT NOT NULL,
  occurred_at       TIMESTAMPTZ,
  received_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  campaign_id       TEXT,
  send_id           TEXT,
  slot              INTEGER,
  provider_message_id TEXT,
  recipient_entity_type TEXT,
  recipient_entity_id TEXT,
  email_hash        TEXT,
  url               TEXT,
  properties        JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_marketing_events_campaign
  ON marketing_events (campaign_id, received_at);
CREATE INDEX IF NOT EXISTS idx_marketing_events_send
  ON marketing_events (send_id, received_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_marketing_events_inbox
  ON marketing_events (inbox_id)
  WHERE inbox_id IS NOT NULL;
