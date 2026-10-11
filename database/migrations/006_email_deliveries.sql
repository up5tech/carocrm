-- 006_email_deliveries.sql — outbound email delivery state (PLAN.md §28.3)
--
-- An Email is an entity record (its content lives in `entity_records.attrs`); this table is the
-- operational side of the same message: one row per recipient, with what the provider answered.
-- Per-recipient state cannot live in the record's JSON attributes because a send is retried and
-- updated independently for each address, and because "delivery status" has to be queryable.

CREATE TABLE IF NOT EXISTS email_deliveries (
  id                  TEXT PRIMARY KEY,
  email_id            TEXT NOT NULL REFERENCES entity_records (id) ON DELETE CASCADE,
  recipient           TEXT NOT NULL,
  -- Which header list the address came from; kept for the record, not for routing.
  recipient_type      TEXT NOT NULL DEFAULT 'to',
  -- pending -> sending -> sent | rejected | failed | skipped ('skipped' = transport disabled).
  status              TEXT NOT NULL DEFAULT 'pending',
  transport           TEXT,
  provider_message_id TEXT,
  error               TEXT,
  attempts            INTEGER NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at             TIMESTAMPTZ
);

-- One row per address per message, so a retry updates it instead of duplicating it.
CREATE UNIQUE INDEX IF NOT EXISTS uq_email_deliveries_recipient ON email_deliveries (email_id, recipient);
CREATE INDEX IF NOT EXISTS idx_email_deliveries_email ON email_deliveries (email_id);
CREATE INDEX IF NOT EXISTS idx_email_deliveries_status ON email_deliveries (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_deliveries_provider_id ON email_deliveries (provider_message_id) WHERE provider_message_id IS NOT NULL;
