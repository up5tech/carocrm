-- 095_inbound_mail_connections.sql — configured inbound mailboxes (plans/PLAN_Phase_24_Product_Completion.md §12)
--
-- Phase 24.6: each row is one mailbox/connection administered at installation level. The
-- credential is encrypted at rest with ENCRYPTION_KEY (the same vault as email_accounts SMTP
-- passwords); each connection keeps an independent poll cursor so overlapping provider-local
-- ids (e.g. IMAP UID 1 in two mailboxes) never dedupe against each other.

CREATE TABLE IF NOT EXISTS inbound_mail_connections (
  id                      TEXT PRIMARY KEY,
  name                    TEXT NOT NULL,
  provider                TEXT NOT NULL,
  mailbox                 TEXT NOT NULL,
  host                    TEXT,
  port                    INTEGER,
  secure                  BOOLEAN NOT NULL DEFAULT TRUE,
  folder                  TEXT,
  tenant_id               TEXT,
  client_id               TEXT,
  credential_encrypted    TEXT,
  owner_user_id           TEXT,
  is_active               BOOLEAN NOT NULL DEFAULT TRUE,
  is_deleted              BOOLEAN NOT NULL DEFAULT FALSE,
  last_polled_at          TIMESTAMPTZ,
  last_error              TEXT,
  created_by_id           TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inbound_mail_connections_active
  ON inbound_mail_connections (provider, is_active) WHERE NOT is_deleted;

CREATE TABLE IF NOT EXISTS inbound_mail_cursors (
  connection_id TEXT PRIMARY KEY,
  cursor        TEXT,
  last_uid      TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Inbound dedupe lookups by (entity, provider id, connection). The attrs store is schemaless,
-- so this expression index is what makes scoped dedupe cheap on large installations.
CREATE INDEX IF NOT EXISTS idx_entity_records_email_inbound
  ON entity_records (entity_type, (attrs ->> 'inboundConnectionId'), (attrs ->> 'messageId'))
  WHERE deleted_at IS NULL;
