-- Phase 19-ES multi-provider follow-on — widen the `provider_key` allowlists
-- (`PLAN_Phase_19_ESignature.md` §1.2, §6.1, §9.4).
--
-- Migration 064 pinned every provider-keyed table to `docusign`, which was correct for a
-- single-adapter release and is now the one storage fact that would stop a second provider from
-- being stored. The module's catalog (`apps/api/src/esignature/providers/signature-provider.catalog.ts`)
-- is the vocabulary; this migration only widens the database's copy of it.
--
-- Additive and data-preserving: no row is rewritten, no column, index or table changes, and every
-- existing value (`docusign`) still satisfies the new constraint. A provider is added here only when
-- its key is in the catalog, so a stray vendor string cannot reach a row through SQL either.
--
-- The constraints are replaced by name. Migration 064 declared them inline, so PostgreSQL generated
-- the names; the DO block finds whichever CHECK mentions `provider_key` on these four tables instead
-- of assuming a spelling, then re-adds one explicitly named constraint per table.

DO $$
DECLARE
  target record;
BEGIN
  FOR target IN
    SELECT rel.relname AS table_name, con.conname AS constraint_name
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = current_schema()
      AND rel.relname IN (
        'esignature_connections',
        'signature_requests',
        'signature_provider_events',
        'signature_webhook_inbox'
      )
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%provider_key%'
  LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', target.table_name, target.constraint_name);
  END LOOP;
END $$;

ALTER TABLE esignature_connections
  ADD CONSTRAINT esignature_connections_provider_key_allowed
  CHECK (provider_key IN ('docusign', 'dropbox_sign'));

ALTER TABLE signature_requests
  ADD CONSTRAINT signature_requests_provider_key_allowed
  CHECK (provider_key IN ('docusign', 'dropbox_sign'));

ALTER TABLE signature_provider_events
  ADD CONSTRAINT signature_provider_events_provider_key_allowed
  CHECK (provider_key IN ('docusign', 'dropbox_sign'));

ALTER TABLE signature_webhook_inbox
  ADD CONSTRAINT signature_webhook_inbox_provider_key_allowed
  CHECK (provider_key IN ('docusign', 'dropbox_sign'));

-- The connection lookup the gate uses per provider: `countUsable(providerKey)` filters on all three
-- columns, and the partial index from 064 already covers (provider_key, environment, status) only
-- for live rows. A dedicated partial index keeps the gate's per-provider read O(index scan) as the
-- connection table grows; it is additive and safely re-runnable.
CREATE INDEX IF NOT EXISTS idx_esignature_connections_usable_by_provider
  ON esignature_connections (provider_key)
  WHERE deleted_at IS NULL AND status = 'connected' AND is_active = TRUE;
