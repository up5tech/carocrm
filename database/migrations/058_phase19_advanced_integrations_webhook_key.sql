-- Phase 19-INT.12 — the opaque webhook endpoint key.
--
-- This column was designed alongside migration 057 but shipped after 057 had already been applied
-- to the configured database. Migration history is never edited once applied (AGENTS.md §3.5), so
-- the change lands here as its own additive migration.
--
-- The provider is given a URL containing this key instead of the connection id, so the endpoint
-- cannot be enumerated. It is a **routing identifier, not a secret**: the secret is the
-- provider's signature. The column is nullable, because a connection whose provider has no
-- webhook support never needs one.

ALTER TABLE integration_connections ADD COLUMN IF NOT EXISTS webhook_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_integration_connections_webhook_key
  ON integration_connections (webhook_key)
  WHERE webhook_key IS NOT NULL;
