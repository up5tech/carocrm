-- Phase 23.3 (plans/PLAN_Phase_23_Security_Hardening.md §8, task 5) — generic OIDC sign-in.
--
-- Additive only (AGENTS.md §3.5): two new tables, no existing table is altered and no existing row
-- changes meaning. An installation that never configures an OIDC profile is completely unaffected.
--
-- oidc_signin_states holds one row per in-flight sign-in attempt:
--   id            — SHA-256 of the state parameter. The state itself is never stored, so a database
--                   read does not yield a usable callback token.
--   profile_key   — the OIDC profile that started the flow (issuer + client id + endpoints).
--   nonce         — the OIDC nonce, checked against the id_token's nonce claim on the callback.
--   code_verifier — the PKCE verifier. It is deleted with the row.
--   redirect_uri  — the redirect URI the platform sent. The callback compares the value the
--                   provider echoes back against this exact string.
--   consumed_at   — set when the state is consumed, so a replayed callback finds nothing.
--
-- oidc_identities is the account-linking table (PLAN §17.3): one row per (provider, subject) pair
-- that is bound to a local user. The subject is the provider's stable identifier for the person, not
-- an email address, so a changed email never re-points an identity.

CREATE TABLE IF NOT EXISTS oidc_signin_states (
  id            TEXT PRIMARY KEY,
  profile_key   TEXT NOT NULL,
  nonce         TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  redirect_uri  TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  consumed_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_oidc_signin_states_expiry ON oidc_signin_states (expires_at);

CREATE TABLE IF NOT EXISTS oidc_identities (
  id              TEXT PRIMARY KEY,
  provider_key    TEXT NOT NULL,
  subject         TEXT NOT NULL,
  user_id         TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_sign_in_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_oidc_identities_provider_subject ON oidc_identities (provider_key, subject);
CREATE INDEX IF NOT EXISTS idx_oidc_identities_user ON oidc_identities (user_id);
