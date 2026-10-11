-- Extension `webhook-integration` — its own tables (PLAN §38.3).
--
-- Endpoints deliberately do NOT live in `entity_records`: the signing secret is stored encrypted
-- (PLAN §31, secrets at rest) and must never land in a metadata attrs blob that a list endpoint or
-- an export could serialise.
--
-- Additive and idempotent: re-running is a no-op because the installer records the file in
-- `extension_migrations`.

CREATE TABLE IF NOT EXISTS extension_webhook_endpoints (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  url               TEXT NOT NULL,
  events            JSONB NOT NULL DEFAULT '["entity.created","entity.updated","entity.deleted"]'::jsonb,
  secret_encrypted  TEXT,
  enabled           BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_extension_webhook_endpoints_enabled ON extension_webhook_endpoints (enabled);

CREATE TABLE IF NOT EXISTS extension_webhook_deliveries (
  id            TEXT PRIMARY KEY,
  endpoint_id   TEXT NOT NULL,
  event_type    TEXT NOT NULL,
  payload       JSONB NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  attempts      INTEGER NOT NULL DEFAULT 0,
  response_code INTEGER,
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_extension_webhook_deliveries_endpoint ON extension_webhook_deliveries (endpoint_id, created_at DESC);