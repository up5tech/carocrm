-- Phase 19-OM.17 — ServiceDesk hand-off contract (E9; PLAN_Phase_19_Omnichannel.md §14 OM.17;
-- docs/omnichannel/feature-contract.md §8).
--
-- The Case side of the link: `Case.externalId`/`externalSource` are metadata fields (server-owned;
-- written only by the hand-off command). This migration adds the **partial unique index** that makes
-- "one Case per external conversation" a database guarantee rather than a service check, and an index
-- for the authoritative link that lives on the conversation (`voice_conversations.case_id`).
--
-- Additive only: existing Cases have no externalId, so they neither enter the index nor change
-- behaviour. A unique violation here means a second creation attempt for the same conversation — the
-- command then returns the existing Case (create-or-link), never a duplicate.

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS uq_entity_records_case_external
  ON entity_records ((attrs->>'externalId'))
  WHERE entity_type = 'Case'
    AND deleted_at IS NULL
    AND attrs->>'externalId' IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_voice_conversations_case
  ON voice_conversations (case_id)
  WHERE case_id IS NOT NULL;

COMMIT;
