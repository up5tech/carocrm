-- Phase 19-S.7 follow-up — the `DocumentTemplate` target-entity attribute, index maintenance.
--
-- The kernel reserves the attribute name `entityType`: the record store drops it while mapping a
-- record to `entity_records` (it is the physical `entity_type` column and a query-engine physical
-- key), so a template's target entity could never be stored under that name. The metadata field is
-- now `targetEntity`; the API keeps accepting `entityType` as its request/query name.
--
-- Index maintenance only (AGENTS.md §3.5): the two 025 indexes that named the old attribute are
-- replaced by their `targetEntity` equivalents. No rows are rewritten — no row could ever carry the
-- old attribute (writes under it were discarded), so there is nothing to backfill.

DROP INDEX IF EXISTS uq_document_template_default;
DROP INDEX IF EXISTS idx_document_template_entity;

-- "The default" must stay unambiguous per target entity type.
CREATE UNIQUE INDEX IF NOT EXISTS uq_document_template_default
  ON entity_records ((attrs ->> 'targetEntity'))
  WHERE entity_type = 'DocumentTemplate' AND deleted_at IS NULL
    AND (attrs ->> 'isDefault') = 'true';

-- The two reads: "the templates of an entity type", optionally only the active ones.
CREATE INDEX IF NOT EXISTS idx_document_template_entity
  ON entity_records ((attrs ->> 'targetEntity'), (attrs ->> 'active'))
  WHERE entity_type = 'DocumentTemplate' AND deleted_at IS NULL;
