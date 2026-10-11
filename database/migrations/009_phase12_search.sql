-- 009_phase12_search.sql — make substring search indexable (PLAN.md §30 Stage 1, Phase 12 acceptance)
--
-- 008 added a trigram index over a concatenation expression. PostgreSQL can only use an expression
-- index when the query predicate *is* that expression, and the Query Engine emits one `ILIKE` per
-- field, so the concatenation could never be matched. Its keys were also wrong for this project's
-- metadata: it indexed 'email' / 'phone' while the seed uses 'emailAddress' / 'phoneNumber'.
-- Verified with EXPLAIN on the configured database: a per-key index is chosen, the concatenation
-- is not.

DROP INDEX IF EXISTS idx_entity_records_attrs_trgm;

-- One trigram index per hot attribute key. `::text` on the right of `->>` is a no-op that the
-- planner strips, so these match the engine's `(attrs ->> 'x'::text)::text ILIKE '%term%'`.
-- Custom fields added through the Entity Manager have no index by design: a predicate that ORs an
-- unindexed key falls back to sequential scan (documented in docs/reference/alpha-status.md).
CREATE INDEX IF NOT EXISTS idx_entity_records_firstname_trgm
  ON entity_records USING GIN ((attrs ->> 'firstName'::text) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_entity_records_lastname_trgm
  ON entity_records USING GIN ((attrs ->> 'lastName'::text) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_entity_records_email_trgm
  ON entity_records USING GIN ((attrs ->> 'emailAddress'::text) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_entity_records_phone_trgm
  ON entity_records USING GIN ((attrs ->> 'phoneNumber'::text) gin_trgm_ops);
