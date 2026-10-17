-- Phase 19-SD — Service Desk state machine, queues, routing and history
-- (PLAN_Phase_19_ServiceDesk.md §5.2, §5.3, §6.1; sub-phases 19-SD.4 and 19-SD.5).
--
-- Case, queue, routing-rule and history records all live in the generic `entity_records` store
-- (JSONB `attrs`), exactly like every other CRM entity, so the Entity Engine keeps CRUD, validation,
-- field ACL, audit, stream and search. What JSON alone cannot express is the *uniqueness* the new
-- workflows rely on — one queue code, one membership per (queue, user), and one transition/assignment
-- per idempotency key — plus the indexes the queue scan, routing-rule order and history reads need.
--
-- Additive only (AGENTS.md §3.5): indexes. No table is created, dropped, truncated or rewritten, and
-- no existing row is modified. Safe to run once through the official runner; every statement is
-- `IF NOT EXISTS`.

-- ---------------------------------------------------------------------------
-- Ownership (SD.5, §5.3): queue and team case scans
-- ---------------------------------------------------------------------------

-- Queue backlog and team inbox lists filter by ownership and state.
CREATE INDEX IF NOT EXISTS idx_entity_records_case_queue
  ON entity_records ((attrs ->> 'queueId'), (attrs ->> 'status'))
  WHERE entity_type = 'Case' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_entity_records_case_team
  ON entity_records ((attrs ->> 'teamId'), (attrs ->> 'status'))
  WHERE entity_type = 'Case' AND deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Queue configuration (SD.5, §5.3)
-- ---------------------------------------------------------------------------

-- A queue code is stable configuration an operator and a rule refer to by name.
CREATE UNIQUE INDEX IF NOT EXISTS uq_entity_records_case_queue_code
  ON entity_records ((attrs ->> 'code'))
  WHERE entity_type = 'CaseQueue' AND deleted_at IS NULL AND (attrs ->> 'code') IS NOT NULL;

-- The active-queue list is ordered by `sortOrder`; cast so the numeric order is stable, not lexical.
CREATE INDEX IF NOT EXISTS idx_entity_records_case_queue_active
  ON entity_records ((attrs ->> 'isActive'), ((attrs ->> 'sortOrder')::int))
  WHERE entity_type = 'CaseQueue' AND deleted_at IS NULL;

-- One membership row per (queue, user): the round-robin ring must not contain a user twice.
CREATE UNIQUE INDEX IF NOT EXISTS uq_entity_records_queue_member
  ON entity_records ((attrs ->> 'queueId'), (attrs ->> 'userId'))
  WHERE entity_type = 'QueueMember' AND deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Routing rules (SD.5, §5.3)
-- ---------------------------------------------------------------------------

-- Rules are evaluated in a deterministic, administrator-visible order.
CREATE INDEX IF NOT EXISTS idx_entity_records_routing_rule_active
  ON entity_records ((attrs ->> 'isActive'), ((attrs ->> 'sortOrder')::int))
  WHERE entity_type = 'RoutingRule' AND deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Case history (SD.4/SD.5, §5.2, §5.3)
-- ---------------------------------------------------------------------------

-- History is read per case, oldest first.
CREATE INDEX IF NOT EXISTS idx_entity_records_case_transition_case
  ON entity_records ((attrs ->> 'caseId'), (attrs ->> 'occurredAt'))
  WHERE entity_type = 'CaseTransition' AND deleted_at IS NULL;

-- One transition per idempotency key *within a case*: a retried command inserts nothing new.
CREATE UNIQUE INDEX IF NOT EXISTS uq_entity_records_case_transition_idem
  ON entity_records ((attrs ->> 'caseId'), (attrs ->> 'idempotencyKey'))
  WHERE entity_type = 'CaseTransition'
    AND deleted_at IS NULL
    AND (attrs ->> 'idempotencyKey') IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_entity_records_case_assignment_case
  ON entity_records ((attrs ->> 'caseId'), (attrs ->> 'occurredAt'))
  WHERE entity_type = 'CaseAssignment' AND deleted_at IS NULL;

-- One assignment per idempotency key *within a case*: a retried command inserts nothing new.
CREATE UNIQUE INDEX IF NOT EXISTS uq_entity_records_case_assignment_idem
  ON entity_records ((attrs ->> 'caseId'), (attrs ->> 'idempotencyKey'))
  WHERE entity_type = 'CaseAssignment'
    AND deleted_at IS NULL
    AND (attrs ->> 'idempotencyKey') IS NOT NULL;
