-- 100_phase25_web_search_citations.sql — external (web) citations (Phase 25.8).
--
-- Two additive changes, no row removed or rewritten:
--
--  1. `crm_chat_citations_source_check` gains one value, `approved_external_source`, the value the
--     chat contract already reserved for a source outside the installation. The existing constraint
--     is replaced with the same list plus that value; every prior value stays valid, so an existing
--     row can never be invalidated by this migration.
--  2. `retrieved_at` records the instant an external page was fetched. It is nullable and left NULL
--     for every existing source type (`crm_record`, `query_result`, `report`, `help_document`),
--     which are re-read under ACL instead and keep using `rechecked_at`. No backfill is needed and
--     no reader is required to change: the citation view falls back to `rechecked_at`.
--
-- The existing `crm_chat_citations_target_check` already says a non-`crm_record` citation stores no
-- entity/record id, which is exactly what an external citation is.

ALTER TABLE crm_chat_citations
  DROP CONSTRAINT IF EXISTS crm_chat_citations_source_check;

ALTER TABLE crm_chat_citations
  ADD CONSTRAINT crm_chat_citations_source_check
  CHECK (source_type IN ('crm_record', 'query_result', 'report', 'help_document', 'approved_external_source'));

ALTER TABLE crm_chat_citations
  ADD COLUMN IF NOT EXISTS retrieved_at TIMESTAMPTZ;
