-- Phase 19-MA — Marketing Automation (PLAN_Phase_19_Marketing_Automation.md §6.1, §6.7, §15 `19-MA.2`).
--
-- Campaign and audience records live in the generic `entity_records` store (JSONB `attrs`) exactly like
-- every other CRM entity, so the Entity Engine keeps CRUD, validation, field ACL, audit, stream,
-- attachments and search. This file adds only what JSON alone cannot express: the uniqueness invariants the
-- module's commands rely on, and the two indexes their reads actually use.
--
-- Additive only (AGENTS.md §3.5, plan §0.1 rule 11): no table is created, dropped, truncated or rewritten,
-- no column is renamed or repurposed, and no existing row is modified. Every statement is `IF NOT EXISTS`,
-- and the existing Campaign/TargetList data is untouched — there is none yet, because the audit
-- (docs/implementation/marketing-automation-audit.md §1) confirmed no campaign or audience record existed
-- in this checkout before phase 19-MA.2.

-- ---------------------------------------------------------------------------
-- Campaign (§5.1, §6.1)
-- ---------------------------------------------------------------------------

-- `code` is the stable external reference for a campaign, and §5.1 makes it optional — so the constraint is
-- partial on "has a code", and on live rows only: a soft-deleted campaign must not pin its code forever, and
-- an unfinished row must not be rejected for missing one.
--
-- The expression is `lower(trim(...))`, matching the write guard's own comparison: `NEWS-2026` and
-- `news-2026 ` are the same code, and two campaigns cannot both claim it. Because the guard asks the
-- database the same question through the same expression, this index is what makes that check a lookup
-- rather than a scan — and it stays correct if a row is ever written outside the module.
CREATE UNIQUE INDEX IF NOT EXISTS uq_entity_records_campaign_code
  ON entity_records ((lower(trim(attrs ->> 'code'))))
  WHERE entity_type = 'Campaign'
    AND deleted_at IS NULL
    AND (attrs ->> 'code') IS NOT NULL;

-- The campaign list is filtered by status and read newest-first (§10.2 "saved filters for Draft, Scheduled,
-- Running…"). Status is an `attrs` value; `modified_at` is the physical column the sort key resolves to.
CREATE INDEX IF NOT EXISTS idx_entity_records_campaign_status
  ON entity_records ((attrs ->> 'status'), modified_at)
  WHERE entity_type = 'Campaign'
    AND deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Audience records (§5.2, §6.1)
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS uq_entity_records_target_list_code
  ON entity_records ((lower(trim(attrs ->> 'code'))))
  WHERE entity_type = 'TargetList'
    AND deleted_at IS NULL
    AND (attrs ->> 'code') IS NOT NULL;

-- The audience picker in a campaign form and the segment list (§10.3) both filter by status and by how the
-- audience is populated, so a marketer choosing an audience reads a short list rather than every list.
CREATE INDEX IF NOT EXISTS idx_entity_records_target_list_status
  ON entity_records ((attrs ->> 'status'), (attrs ->> 'membershipMode'))
  WHERE entity_type = 'TargetList'
    AND deleted_at IS NULL;

-- Membership is a fact about a pair: this record, in this audience, once. §5.2 requires de-duplication of a
-- recipient who appears in several included lists, and the first step is one row per (list, record) —
-- otherwise every preview, snapshot and count would double-count the same person.
--
-- Partial on live rows and on rows that have not been *removed*: removal is recorded rather than deleted
-- (§5.2 "membership changes must be auditable"), so a re-added record gets a fresh row and the earlier
-- removal stays readable. That is why the predicate excludes a row with `removedAt` set instead of relying
-- on `deleted_at` alone.
CREATE UNIQUE INDEX IF NOT EXISTS uq_entity_records_target_list_entry
  ON entity_records ((attrs ->> 'targetListId'), (attrs ->> 'entityType'), (attrs ->> 'entityId'))
  WHERE entity_type = 'TargetListEntry'
    AND deleted_at IS NULL
    AND (attrs ->> 'removedAt') IS NULL;

-- "Which audiences name this record?" — the reverse lookup §6.7 asks for, needed to explain a recipient who
-- appears in several included lists and to remove them from all of them at once.
-- (The list→members direction is served by the unique index above, whose leading column is the list id.)
CREATE INDEX IF NOT EXISTS idx_entity_records_target_list_entry_record
  ON entity_records ((attrs ->> 'entityType'), (attrs ->> 'entityId'))
  WHERE entity_type = 'TargetListEntry'
    AND deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Campaign lifecycle history (§5.1 "append-only", §7.3, plan §0.1 rule 10)
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_entity_records_campaign_transition_campaign
  ON entity_records ((attrs ->> 'campaignId'), created_at)
  WHERE entity_type = 'CampaignTransition'
    AND deleted_at IS NULL;

-- A retried command must not produce a second transition or a second event. The key is unique among live
-- history rows, so a replay is *unrepresentable* rather than merely unlikely — the database enforces what
-- the service also checks, and a race between two retries fails on this index instead of double-writing.
CREATE UNIQUE INDEX IF NOT EXISTS uq_entity_records_campaign_transition_idem
  ON entity_records ((attrs ->> 'idempotencyKey'))
  WHERE entity_type = 'CampaignTransition'
    AND deleted_at IS NULL
    AND (attrs ->> 'idempotencyKey') IS NOT NULL;
