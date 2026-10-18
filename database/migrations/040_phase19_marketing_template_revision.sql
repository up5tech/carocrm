-- Phase 19-MA.6 — template content revisions
-- (PLAN_Phase_19_Marketing_Automation.md §5.4, §6.2, §15 `19-MA.6`).
--
-- `MarketingTemplateRevision` rows are ordinary metadata records in `entity_records`, exactly like
-- CampaignTransition or MarketingAudienceSnapshot before them: ACL, audit and serialisation stay in the
-- Entity Engine and the metadata seed in `database/seed-metadata.ts` carries the entity definition. This
-- file adds only what JSON attributes cannot express — the uniqueness rules the revision model depends on:
--
--   1. A revision number is **monotonic per template** (§6.2): re-sealing unedited content re-uses the
--      existing revision, so the numbering a new seal computes from has to be safe against two concurrent
--      seals of the same template. The unique index lets only one row win, and the command retries read
--      the winner rather than minting a sibling.
--   2. "Which content revision did this send actually use?" (the phase's acceptance rule) is answered per
--      campaign by provenance lookups on `campaignId` + `sealedAt`.
--
-- Additive in effect (AGENTS.md §3.5): a new partial expression index pair over data that already exists
-- in `entity_records`. No table, column or row is created, altered or deleted beyond the indexes.

-- One live row per (template, revision number): the identity a delivery record should cite.
CREATE UNIQUE INDEX IF NOT EXISTS uq_entity_records_marketing_template_revision_number
  ON entity_records ((attrs ->> 'templateId'), (attrs ->> 'revisionNumber'))
  WHERE entity_type = 'MarketingTemplateRevision'
    AND deleted_at IS NULL;

-- Revisions a campaign's template already carries, newest first — the preview surface.
CREATE INDEX IF NOT EXISTS idx_entity_records_marketing_template_revision_campaign
  ON entity_records ((attrs ->> 'campaignId'), (attrs ->> 'sealedAt'))
  WHERE entity_type = 'MarketingTemplateRevision'
    AND deleted_at IS NULL;
