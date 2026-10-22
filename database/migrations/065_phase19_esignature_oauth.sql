-- Phase 19-ES.4 — DocuSign OAuth and the connection lifecycle: the module's own credential vault
-- and its own single-use authorization states.
-- (PLAN_Phase_19_ESignature.md §6.1, §8.1, §9.2, §18 `19-ES.4`; reuse decision in
-- docs/implementation/esignature-audit.md §3, §4.)
--
-- ADDITIVE ONLY (AGENTS.md §3.5): two new tables and their indexes. No existing table, column or row
-- is touched, nothing is seeded, and no connection is enabled — a fresh installation still has no
-- DocuSign connection, so every provider path stays closed.
--
-- Why ESignature does not reuse `integration_credential_secrets` and `integration_oauth_states`
-- (the audit listed both as reusable machinery, and the *code* is reused — the tables are not):
-- both carry `connection_id TEXT NOT NULL REFERENCES integration_connections (id)`. An ESignature
-- connection is an `esignature_connections` row, so a DocuSign credential could not be stored in
-- either table without a foreign key that cannot be satisfied. Changing those constraints is not
-- additive and would alter a table Advanced Integrations owns. The column set, the `kind`
-- vocabulary, the `state` machine and the AES-256-GCM payload are therefore mirrored exactly, so the
-- two vaults stay one convention rather than two dialects — and a DocuSign secret still has no path
-- into the generic entity store.
--
-- Everything credential-shaped lives in `esignature_credential_secrets`, keyed by
-- (connection id, kind), encrypted with `ENCRYPTION_KEY` before it reaches a column (plan §4.1).
-- `esignature_connections` keeps only the non-secret half: the OAuth **client id**, the discovered
-- account id and base URI, and the granted scopes.

-- ---------------------------------------------------------------------------
-- 1. Credentials at rest (plan §4.1, §6.1, §9.2; audit §6)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS esignature_credential_secrets (
  id                TEXT PRIMARY KEY,
  connection_id     TEXT NOT NULL REFERENCES esignature_connections (id) ON DELETE CASCADE,
  -- The same allowlist Advanced Integrations' vault uses, restricted to what DocuSign produces:
  -- the OAuth client secret, the access token, the refresh token and the Connect HMAC secret.
  -- `api_key`/`signing_secret` are omitted because no DocuSign credential has that shape; inventing
  -- a kind here would be a fourth name for an existing secret.
  kind              TEXT NOT NULL
                      CHECK (kind IN ('oauth_access_token', 'oauth_refresh_token', 'client_secret',
                                      'webhook_secret')),
  state             TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'revoked')),
  -- AES-256-GCM payload from @carocrm/core encryptSecret; never plaintext. A revoked credential has
  -- this column overwritten rather than kept, so a database snapshot does not preserve it.
  payload_encrypted TEXT NOT NULL,
  -- When the credential stops being usable. Not a secret, and it is what lets the expiry sweep and
  -- the refresh decision work without decrypting anything.
  expires_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  rotated_at        TIMESTAMPTZ,
  revoked_at        TIMESTAMPTZ
);

-- One credential per (connection, kind). Storing a second value of the same kind replaces the first
-- rather than accumulating rows nobody can tell apart — which is also what makes a refresh token
-- rotation a single write.
CREATE UNIQUE INDEX IF NOT EXISTS uq_esignature_credential_secrets_kind
  ON esignature_credential_secrets (connection_id, kind);
-- The expiry sweep: "which credentials expire soon", without touching any payload.
CREATE INDEX IF NOT EXISTS idx_esignature_credential_secrets_expiry
  ON esignature_credential_secrets (expires_at)
  WHERE state = 'active' AND expires_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. The in-flight authorization request (plan §8.1, §9.2)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS esignature_oauth_states (
  -- The SHA-256 hash of the authorization state. The state itself is never persisted, so a database
  -- read does not yield something an attacker can present to the callback.
  id                TEXT PRIMARY KEY,
  -- The state names the connection it was started for. The callback derives the connection **from
  -- the state**, never from the request, so a callback cannot be aimed at another connection.
  connection_id     TEXT NOT NULL REFERENCES esignature_connections (id) ON DELETE CASCADE,
  provider_key      TEXT NOT NULL,
  -- The environment is part of the binding: demo and production are different integrations, and a
  -- state started against one must not complete against the other (plan §9.2, §9.4).
  environment       TEXT NOT NULL CHECK (environment IN ('demo', 'production')),
  -- The principal that started the flow, recorded so the callback can refuse a connection that
  -- changed hands in the meantime.
  initiated_by      TEXT NOT NULL,
  -- The PKCE verifier. It is bound to this one authorization request and is deleted with the row.
  code_verifier     TEXT,
  -- The exact redirect URI the platform sent, stored so the token exchange replays it — OAuth
  -- requires the same value in both calls, and it is never taken from the callback request.
  redirect_uri      TEXT NOT NULL,
  requested_scopes  JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Short-lived by policy: an authorization request that nobody completes is a stale row, not a
  -- standing invitation.
  expires_at        TIMESTAMPTZ NOT NULL,
  -- Set when the state is consumed, in the same statement that reads the row. A second callback with
  -- the same state finds it consumed and is refused.
  consumed_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_esignature_oauth_states_expiry
  ON esignature_oauth_states (expires_at);
CREATE INDEX IF NOT EXISTS idx_esignature_oauth_states_connection
  ON esignature_oauth_states (connection_id);
