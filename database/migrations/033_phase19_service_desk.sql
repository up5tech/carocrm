-- Phase 19-SD — Service Desk (PLAN_Phase_19_ServiceDesk.md §5.1, §5.3, §6.1; sub-phase 19-SD.2).
--
-- Case records live in the generic `entity_records` store (JSONB `attrs`) exactly like every other
-- CRM entity, so the Entity Engine keeps CRUD, validation, field ACL, audit, stream, attachments and
-- search. What JSON alone cannot express is the one invariant the whole module rests on — a case
-- number that is unique even under concurrent creation — plus the indexes the case list, queue and
-- requester reads need.
--
-- Additive only (AGENTS.md §3.5): one sequence and indexes. No table is created, dropped, truncated
-- or rewritten, and no existing row is modified. Safe to run once through the official runner; every
-- statement is `IF NOT EXISTS`.

-- ---------------------------------------------------------------------------
-- Case numbering (§5.1)
-- ---------------------------------------------------------------------------
--
-- `nextval` on a sequence is atomic and never repeats across sessions or transactions, so two
-- simultaneous case creations cannot receive the same value, and a number is never produced by
-- counting existing rows. The sequence is deliberately not gapless: a create that fails after
-- allocation consumes its value — ticket numbers reading with small gaps is normal and far cheaper
-- than a lock that serialises every case creation.
CREATE SEQUENCE IF NOT EXISTS service_desk_case_number_seq START WITH 1;

-- The stored number's second line of defence: unique across live cases, so a duplicate is impossible
-- even if a row is ever written outside the numbering service. Partial on `deleted_at IS NULL` so a
-- soft-deleted case does not pin its number, and on a non-null number so an unfinished row is not
-- rejected for missing one.
CREATE UNIQUE INDEX IF NOT EXISTS uq_entity_records_case_number
  ON entity_records ((attrs ->> 'caseNumber'))
  WHERE entity_type = 'Case'
    AND deleted_at IS NULL
    AND (attrs ->> 'caseNumber') IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Query support: case list, queue, requester and activity reads (§5.3, §6.1)
-- ---------------------------------------------------------------------------

-- The default list narrows to a status and orders by recency (`modified_at` is a physical column;
-- `status` is an `attrs` value, PLAN §6.1).
CREATE INDEX IF NOT EXISTS idx_entity_records_case_status
  ON entity_records ((attrs ->> 'status'), modified_at)
  WHERE entity_type = 'Case' AND deleted_at IS NULL;

-- "My open cases" and queue scans: the assignee is the physical `assigned_user_id` column, the state
-- is an `attrs` value.
CREATE INDEX IF NOT EXISTS idx_entity_records_case_assignee
  ON entity_records (assigned_user_id, (attrs ->> 'status'))
  WHERE entity_type = 'Case' AND deleted_at IS NULL;

-- Customer 360: the cases raised by an Account or a Contact.
CREATE INDEX IF NOT EXISTS idx_entity_records_case_account
  ON entity_records ((attrs ->> 'accountId'))
  WHERE entity_type = 'Case' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_entity_records_case_contact
  ON entity_records ((attrs ->> 'contactId'))
  WHERE entity_type = 'Case' AND deleted_at IS NULL;
