-- 007_email_accounts.sql — sending mailboxes (PLAN.md §28.1, §28.3)
--
-- A CRM install can have several mailboxes (sales@, support@, per-user). The account owns the SMTP
-- connection settings; the actual sending still happens in the worker through the §24 queue.
-- Credentials are stored encrypted at rest (PLAN §28.3): the plaintext password never touches this
-- table, only the AES-256-GCM payload produced by @carocrm/core's crypto helper.

CREATE TABLE IF NOT EXISTS email_accounts (
  id                      TEXT PRIMARY KEY,
  name                    TEXT NOT NULL,
  email_address           TEXT NOT NULL,
  from_name               TEXT,
  smtp_host               TEXT NOT NULL,
  smtp_port               INTEGER NOT NULL DEFAULT 587,
  -- 'starttls' (opportunistic), 'ssl' (implicit TLS) or 'none' (trusted network only).
  smtp_security           TEXT NOT NULL DEFAULT 'starttls',
  smtp_username           TEXT,
  -- Encrypted payload ("v1:<iv>:<tag>:<ciphertext>", base64url); NULL for credential-less relays.
  smtp_password_encrypted TEXT,
  -- Per-mailbox default signature appended to outbound bodies (PLAN §28 / Phase 11 "Signature").
  signature               TEXT,
  is_active               BOOLEAN NOT NULL DEFAULT TRUE,
  -- One active default account supplies the From address when a record has none.
  is_default              BOOLEAN NOT NULL DEFAULT FALSE,
  is_deleted              BOOLEAN NOT NULL DEFAULT FALSE,
  created_by_id           TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_email_accounts_address ON email_accounts (email_address) WHERE NOT is_deleted;
CREATE INDEX IF NOT EXISTS idx_email_accounts_active ON email_accounts (is_active) WHERE NOT is_deleted;