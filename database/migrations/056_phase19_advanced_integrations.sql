-- Phase 19-INT.2–19-INT.5 — Advanced Integrations persistence.
--
-- Additive only (AGENTS.md §3.5): three new tables and their indexes. No existing table, column
-- or row is touched, and nothing is seeded — no connector is enabled by default.
--
-- The control plane lives here rather than in `entity_records` on purpose. A metadata entity is
-- reachable through the generic `/api/v1/:entity` API, and a direct `PATCH` on a connection would
-- move it between states without passing the connection state machine (feature contract §5.1).
-- The CRM records a connection syncs are not affected by this decision and stay where they are.

CREATE TABLE IF NOT EXISTS integration_connections (
  id                        TEXT PRIMARY KEY,
  provider_key              TEXT NOT NULL,
  name                      TEXT NOT NULL,
  -- Ownership. `organization` is the first-release default (feature contract §4); `user` scopes
  -- the connection to one principal.
  owner_type                TEXT NOT NULL DEFAULT 'organization'
                              CHECK (owner_type IN ('organization', 'user')),
  owner_id                  TEXT NOT NULL,
  -- A non-secret provider account/tenant label, e.g. a Google Workspace domain.
  tenant_ref                TEXT,
  -- The connection state machine (feature contract §5.1). `paused`, `revoked` and
  -- `reauthorization_required` are never permission to call the provider.
  status                    TEXT NOT NULL DEFAULT 'draft'
                              CHECK (status IN ('draft', 'pending_authorization', 'connected', 'degraded',
                                                'reauthorization_required', 'paused', 'revoked', 'error')),
  enabled                   BOOLEAN NOT NULL DEFAULT FALSE,
  -- The scopes the provider actually granted.
  granted_scopes            JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- The scopes the provider declares as required. Compared with the granted set before the
  -- connection may become usable.
  required_scopes           JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Non-secret configuration. A key that looks like a credential is refused by the service.
  connection_options        JSONB NOT NULL DEFAULT '{}'::jsonb,
  adapter_version           TEXT NOT NULL,
  health_status             TEXT,
  health_summary_code       TEXT,
  last_validated_at         TIMESTAMPTZ,
  last_successful_sync_at   TIMESTAMPTZ,
  last_error_code           TEXT,
  -- A reference to the credential row, never the credential itself.
  credential_reference_id   TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_id             TEXT,
  modified_by_id            TEXT,
  deleted_at                TIMESTAMPTZ
);
-- One connection per (provider, owner, name). Several connections to the same provider are
-- allowed: they are different tenants, environments or regions.
CREATE UNIQUE INDEX IF NOT EXISTS uq_integration_connections_owner_name
  ON integration_connections (provider_key, owner_type, owner_id, name)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_integration_connections_provider
  ON integration_connections (provider_key, status);
CREATE INDEX IF NOT EXISTS idx_integration_connections_owner
  ON integration_connections (owner_type, owner_id);

CREATE TABLE IF NOT EXISTS integration_credential_secrets (
  id                TEXT PRIMARY KEY,
  connection_id     TEXT NOT NULL REFERENCES integration_connections (id) ON DELETE CASCADE,
  kind              TEXT NOT NULL
                      CHECK (kind IN ('oauth_access_token', 'oauth_refresh_token', 'client_secret',
                                      'api_key', 'webhook_secret', 'signing_secret')),
  state             TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'revoked')),
  -- AES-256-GCM payload from @carocrm/core encryptSecret; never plaintext.
  payload_encrypted TEXT NOT NULL,
  -- When the credential stops being usable. Not a secret, and it lets the expiry sweep work
  -- without decrypting anything.
  expires_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  rotated_at        TIMESTAMPTZ,
  revoked_at        TIMESTAMPTZ
);
-- One credential per (connection, kind). Storing a second value of the same kind replaces the
-- first rather than accumulating rows nobody can tell apart.
CREATE UNIQUE INDEX IF NOT EXISTS uq_integration_credential_secrets_kind
  ON integration_credential_secrets (connection_id, kind);
CREATE INDEX IF NOT EXISTS idx_integration_credential_secrets_expiry
  ON integration_credential_secrets (expires_at)
  WHERE state = 'active' AND expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS integration_oauth_states (
  -- The SHA-256 hash of the authorization state. The state itself is never persisted, so a
  -- database read cannot yield a usable authorization state.
  id                TEXT PRIMARY KEY,
  connection_id     TEXT NOT NULL REFERENCES integration_connections (id) ON DELETE CASCADE,
  provider_key      TEXT NOT NULL,
  -- The principal that started the flow. The callback refuses a connection that changed hands in
  -- the meantime.
  initiated_by      TEXT NOT NULL,
  -- The PKCE verifier. It is bound to this one authorization request and deleted with it.
  code_verifier     TEXT,
  -- The allowlisted redirect URI the platform sent to the provider.
  redirect_uri      TEXT NOT NULL,
  requested_scopes  JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at        TIMESTAMPTZ NOT NULL,
  -- Set when the state is consumed. A second callback with the same state finds nothing.
  consumed_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_integration_oauth_states_expiry
  ON integration_oauth_states (expires_at);
CREATE INDEX IF NOT EXISTS idx_integration_oauth_states_connection
  ON integration_oauth_states (connection_id);
