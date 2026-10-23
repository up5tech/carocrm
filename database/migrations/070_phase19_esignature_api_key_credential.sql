-- Phase 19-ES multi-provider follow-on — allow an API-key credential in the ESignature vault
-- (`PLAN_Phase_19_ESignature.md` §4.1, §9.2; Dropbox Sign adapter).
--
-- Dropbox Sign authenticates every API call with the account's API key (HTTP Basic, key as username,
-- empty password), and derives its callback `event_hash` from that same key. The key is a credential:
-- it is encrypted by `ESignatureCredentialVault` and never becomes a settings field, a response field
-- or a log line. Migration 065's CHECK allowlist was written for DocuSign's OAuth shapes and omitted
-- it, so the vault could not store the one secret an API-key provider needs.
--
-- Additive and data-preserving: only the allowlist gains a value. No row is rewritten, no column,
-- index or table changes, and every existing value still satisfies the new constraint. The constraint
-- is located by definition rather than by an assumed generated name, so this file is re-runnable and
-- does not depend on PostgreSQL's naming.

DO $$
DECLARE
  target record;
BEGIN
  FOR target IN
    SELECT con.conname AS constraint_name
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = current_schema()
      AND rel.relname = 'esignature_credential_secrets'
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%kind%'
  LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', 'esignature_credential_secrets', target.constraint_name);
  END LOOP;
END $$;

ALTER TABLE esignature_credential_secrets
  ADD CONSTRAINT esignature_credential_secrets_kind_allowed
  CHECK (kind IN ('api_key', 'client_secret', 'oauth_access_token', 'oauth_refresh_token', 'webhook_secret'));
