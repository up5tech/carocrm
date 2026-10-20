-- Phase 19-INT.24 — data enrichment profiles and results.
--
-- Additive only (AGENTS.md §3.5): two new tables and their indexes. No existing table, column or
-- row is touched, and nothing is seeded — no enrichment provider is enabled by default.
--
-- Why its own tables and not `entity_records`:
--
--  - a profile is **control-plane state**: it says which provider may be asked, about which
--    entity, for which fields, with which quota. It is configuration, not business data, and it
--    must not be reachable through the generic `/api/v1/:entity` API, where a `PATCH` would
--    widen an allowlist without passing the validation below.
--  - a result is a **decision record**: it holds the old value, the new value, the provider, the
--    retrieval time, the confidence and whether a human accepted or rejected it. The plan requires
--    exactly this much provenance ("Preserve the old value, new value, provider/source, retrieval
--    time, confidence ... and user approval where applicable"), and a generic entity record would
--    not carry it.

CREATE TABLE IF NOT EXISTS integration_enrichment_profiles (
  id                        TEXT PRIMARY KEY,
  -- The provider that answers. The one provider in this release is `rest-enrichment`.
  provider_key              TEXT NOT NULL,
  -- The connection that holds the credential. The credential itself lives in the vault.
  connection_id             TEXT NOT NULL,
  name                      TEXT NOT NULL,
  -- The CRM entity the profile enriches. A profile is per entity: the allowlists are per entity.
  entity_type               TEXT NOT NULL,
  -- Whether the profile may be used at all. A disabled profile is refused before a provider is
  -- called, so disabling one really does stop the spend.
  enabled                   BOOLEAN NOT NULL DEFAULT FALSE,
  -- The fields the profile may ask the provider about. The provider receives nothing else.
  allowed_fields            JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- The fields the profile may never write, whatever the provider answers. "Never overwrite
  -- verified CRM data automatically" is a product rule, so it is data, not code.
  protected_fields          JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- The daily credit ceiling. Zero means "no daily limit"; a negative value is refused.
  daily_quota               INTEGER NOT NULL DEFAULT 0,
  -- What one credit costs in the installation's own currency, for the operator's report.
  cost_per_credit           NUMERIC(18, 6) NOT NULL DEFAULT 0,
  -- How long a provider answer may be reused before it is fetched again.
  cache_ttl_seconds         INTEGER NOT NULL DEFAULT 86400,
  -- The non-secret provider configuration: the endpoint, the field maps, the auth mode.
  provider_options          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_id             TEXT,
  modified_by_id            TEXT,
  deleted_at                TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_integration_enrichment_profiles_name
  ON integration_enrichment_profiles (name)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS ix_integration_enrichment_profiles_connection
  ON integration_enrichment_profiles (connection_id);

CREATE TABLE IF NOT EXISTS integration_enrichment_results (
  id                        TEXT PRIMARY KEY,
  profile_id                TEXT NOT NULL REFERENCES integration_enrichment_profiles (id),
  entity_type               TEXT NOT NULL,
  entity_id                 TEXT NOT NULL,
  -- `pending` — fetched, not yet decided. `accepted` — a human applied it. `rejected` — a human
  -- refused it. `expired` — the answer was too old to be applied.
  status                    TEXT NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending', 'accepted', 'rejected', 'expired')),
  -- The old values, so the operator can see what would change and so an audit can reconstruct it.
  before_values             JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- The new values the provider proposed.
  after_values              JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- The provider's confidence per field, when it published one.
  confidence                JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- The provider's own reference to its answer, for reconciliation.
  provider_ref              TEXT,
  -- What the call cost.
  credits_used              INTEGER NOT NULL DEFAULT 0,
  cost                      NUMERIC(18, 6) NOT NULL DEFAULT 0,
  retrieved_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at                TIMESTAMPTZ,
  decided_by_id             TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_integration_enrichment_results_profile
  ON integration_enrichment_results (profile_id, entity_type, entity_id, retrieved_at desc);

-- One pending result per (profile, record): a second preview updates the pending row rather than
-- accumulating rows nobody can tell apart.
CREATE UNIQUE INDEX IF NOT EXISTS uq_integration_enrichment_results_pending
  ON integration_enrichment_results (profile_id, entity_type, entity_id)
  WHERE status = 'pending';
