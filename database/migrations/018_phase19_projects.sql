-- Phase 19 — Projects (PLAN_Phase_19_Projects.md §5).
--
-- Project records live in the generic `entity_records` store (JSONB `attrs`) exactly like every
-- other CRM entity, so the Entity Engine keeps ownership of CRUD, validation, audit, stream and
-- record ACL. What JSON cannot express is the relational invariants §5.2 demands — one membership
-- per user per project, one stage key per board, one dependency edge — so those become expression
-- indexes over `attrs`, and the self-edge rule becomes a table CHECK.
--
-- Additive only (AGENTS.md §3.5): new indexes plus one CHECK that every existing row already
-- satisfies. No table is created, dropped, truncated or rewritten.

-- ---------------------------------------------------------------------------
-- Invariants
-- ---------------------------------------------------------------------------

-- §4.4: "A member links one user to one project" — unique (projectId, userId).
CREATE UNIQUE INDEX IF NOT EXISTS uq_project_member_project_user
  ON entity_records ((attrs ->> 'projectId'), (attrs ->> 'userId'))
  WHERE entity_type = 'ProjectMember' AND deleted_at IS NULL;

-- §4.3: a stage key is stable and unique inside its board.
CREATE UNIQUE INDEX IF NOT EXISTS uq_project_board_stage_key
  ON entity_records ((attrs ->> 'boardId'), (attrs ->> 'key'))
  WHERE entity_type = 'ProjectBoardStage' AND deleted_at IS NULL;

-- §4.8: one edge per (successor, predecessor) pair; duplicate logical edges are refused here.
CREATE UNIQUE INDEX IF NOT EXISTS uq_project_task_dependency_edge
  ON entity_records ((attrs ->> 'taskId'), (attrs ->> 'predecessorTaskId'))
  WHERE entity_type = 'ProjectTaskDependency' AND deleted_at IS NULL;

-- §4.8: "Prevent self-dependencies". A task can never depend on itself.
ALTER TABLE entity_records
  ADD CONSTRAINT chk_project_task_dependency_no_self_edge
  CHECK (
    entity_type <> 'ProjectTaskDependency'
    OR attrs ->> 'taskId' IS NULL
    OR attrs ->> 'predecessorTaskId' IS NULL
    OR attrs ->> 'taskId' <> attrs ->> 'predecessorTaskId'
  );

-- §4.10: a user collaborates on a task at most once.
CREATE UNIQUE INDEX IF NOT EXISTS uq_project_task_collaborator_task_user
  ON entity_records ((attrs ->> 'taskId'), (attrs ->> 'userId'))
  WHERE entity_type = 'ProjectTaskCollaborator' AND deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Query support for the Plan / Board / Gantt projections and the dashlet
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_entity_records_project_task_project
  ON entity_records ((attrs ->> 'projectId'))
  WHERE entity_type = 'ProjectTask';

CREATE INDEX IF NOT EXISTS idx_entity_records_project_task_group_order
  ON entity_records ((attrs ->> 'groupId'), ((attrs ->> 'sortOrder')::int))
  WHERE entity_type = 'ProjectTask' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_entity_records_project_task_stage
  ON entity_records ((attrs ->> 'stageId'))
  WHERE entity_type = 'ProjectTask' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_entity_records_project_task_assignee
  ON entity_records ((attrs ->> 'assigneeUserId'))
  WHERE entity_type = 'ProjectTask' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_entity_records_project_task_owner
  ON entity_records ((attrs ->> 'ownerUserId'))
  WHERE entity_type = 'ProjectTask' AND deleted_at IS NULL;

-- `dateEnd` searches cast the JSON text to `timestamptz`, which is not IMMUTABLE, so an expression
-- index over it is refused by Postgres. Range queries fall back to the `projectId` index plus the
-- GIN index on `attrs` — recorded as a known limitation rather than silently widened.

CREATE INDEX IF NOT EXISTS idx_entity_records_project_group_project
  ON entity_records ((attrs ->> 'projectId'), ((attrs ->> 'sortOrder')::int))
  WHERE entity_type = 'ProjectGroup' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_entity_records_project_member_user
  ON entity_records ((attrs ->> 'userId'))
  WHERE entity_type = 'ProjectMember' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_entity_records_project_member_project
  ON entity_records ((attrs ->> 'projectId'))
  WHERE entity_type = 'ProjectMember' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_entity_records_project_stage_board
  ON entity_records ((attrs ->> 'boardId'), ((attrs ->> 'sortOrder')::int))
  WHERE entity_type = 'ProjectBoardStage' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_entity_records_dependency_predecessor
  ON entity_records ((attrs ->> 'predecessorTaskId'))
  WHERE entity_type = 'ProjectTaskDependency' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_entity_records_collaborator_user
  ON entity_records ((attrs ->> 'userId'))
  WHERE entity_type = 'ProjectTaskCollaborator' AND deleted_at IS NULL;
