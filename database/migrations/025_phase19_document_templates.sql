-- Phase 19-S.7 (prerequisite) — the kernel `document` module's template records.
--
-- `DocumentTemplate` is an ordinary metadata entity in `entity_records`, so what JSON alone cannot
-- express — the uniqueness of a template's code, the one-default-per-entity-type rule, and the indexes
-- the render and default-selection lookups need — is expressed here.
--
-- Additive only (AGENTS.md §3.5): indexes and two unique backstops over rows this module owns.
-- Nothing is dropped, truncated, rewritten or backfilled.

-- ---------------------------------------------------------------------------
-- Template code (§5.7)
-- ---------------------------------------------------------------------------
--
-- A template is addressed by its code on every render, preview and default lookup, so the code is both
-- unique and indexed: a duplicate is impossible even if two creates race past the service's own check,
-- exactly as a duplicate document number or provider event id is impossible (migrations 023/024).
CREATE UNIQUE INDEX IF NOT EXISTS uq_document_template_code
  ON entity_records ((attrs ->> 'code'))
  WHERE entity_type = 'DocumentTemplate' AND deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Default template (§5.7)
-- ---------------------------------------------------------------------------
--
-- "The default" must be unambiguous. The service clears the previous default when marking a new one;
-- this partial unique index is the second line of defence, so two defaults for one entity type cannot
-- exist even if two writes race. Rows without the flag (and non-default rows generally) are excluded.
CREATE UNIQUE INDEX IF NOT EXISTS uq_document_template_default
  ON entity_records ((attrs ->> 'entityType'))
  WHERE entity_type = 'DocumentTemplate' AND deleted_at IS NULL
    AND (attrs ->> 'isDefault') = 'true';

-- ---------------------------------------------------------------------------
-- List / default-selection queries (§16.1)
-- ---------------------------------------------------------------------------
--
-- The two reads this module makes are "the templates of an entity type" (optionally only active ones,
-- which is also how the default is chosen) and nothing else — one composite index serves both.
CREATE INDEX IF NOT EXISTS idx_document_template_entity
  ON entity_records ((attrs ->> 'entityType'), (attrs ->> 'active'))
  WHERE entity_type = 'DocumentTemplate' AND deleted_at IS NULL;
