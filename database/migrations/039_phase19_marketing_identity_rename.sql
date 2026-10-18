-- Phase 19-MA.4/MA.5 — rename the audience-membership and consent reference attributes
-- (supersedes two indexes from 037; PLAN_Phase_19_Marketing_Automation.md §5.2, §6.1, §6.3).
--
-- `entityType` cannot be a record attribute in this platform: the record API treats it as an immutable
-- input, because it is the physical discriminator column of `entity_records` (`entity_type`). An attribute
-- with that name is therefore unwritable by anything, which the audience-membership command discovered on
-- its first run. The two references are renamed:
--
--   TargetListEntry.entityType/entityId   -> memberType/memberId   (which record is in this audience)
--   MarketingConsent.entityType/entityId  -> subjectType/subjectId (whose consent this decision is about)
--
-- 037 has already been applied to the configured database, so it is left exactly as it was and the two
-- indexes it created are replaced here. Indexes are derived objects: dropping and recreating them changes
-- no record and no attribute value, and the new definitions cover the same queries.
--
-- Additive in effect (AGENTS.md §3.5): no table, column or row is altered or deleted.

-- ---------------------------------------------------------------------------
-- TargetListEntry membership (§5.2, §6.1)
-- ---------------------------------------------------------------------------

DROP INDEX IF EXISTS uq_entity_records_target_list_entry;
DROP INDEX IF EXISTS idx_entity_records_target_list_entry_record;

-- One live membership row per (audience, record type, record). Removal is recorded rather than deleted, so
-- a re-added record gets a fresh row and the earlier removal stays readable (037 explains the predicate).
CREATE UNIQUE INDEX IF NOT EXISTS uq_entity_records_target_list_entry
  ON entity_records ((attrs ->> 'targetListId'), (attrs ->> 'memberType'), (attrs ->> 'memberId'))
  WHERE entity_type = 'TargetListEntry'
    AND deleted_at IS NULL
    AND (attrs ->> 'removedAt') IS NULL;

-- "Which audiences name this record?" — the reverse lookup §6.7 asks for.
CREATE INDEX IF NOT EXISTS idx_entity_records_target_list_entry_record
  ON entity_records ((attrs ->> 'memberType'), (attrs ->> 'memberId'))
  WHERE entity_type = 'TargetListEntry'
    AND deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- MarketingConsent person reference (§6.3)
-- ---------------------------------------------------------------------------

DROP INDEX IF EXISTS idx_entity_records_marketing_consent_record;

CREATE INDEX IF NOT EXISTS idx_entity_records_marketing_consent_record
  ON entity_records ((attrs ->> 'subjectType'), (attrs ->> 'subjectId'))
  WHERE entity_type = 'MarketingConsent'
    AND deleted_at IS NULL;
