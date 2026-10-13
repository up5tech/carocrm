# Projects — data model

All ten records are metadata entities (`database/seed-metadata.ts`) stored in the shared
`entity_records` table (`attrs` JSONB), like every other CRM entity: no per-entity table is
created, and adding a field is a metadata change, not a migration.

| Entity | Purpose | Notes |
|---|---|---|
| `Project` | root container | `boardId` required and immutable; six feature flags |
| `ProjectCategory` | hierarchical classification | `parentId`, `sortOrder`; cycles refused |
| `ProjectBoard` | reusable stage definition | `isDefault`; shared by many projects |
| `ProjectBoardStage` | a stage with a status mapping | `key` stable per board, `statusValue` ∈ the five task statuses |
| `ProjectRole` | eleven policy dimensions | `projectRoleOwner/Editor/Member` seeded with `isSystem` |
| `ProjectMember` | user ↔ project ↔ role | unique `(projectId, userId)` |
| `ProjectGroup` | ordered section inside one project | `groupType`, `sortOrder`, `newTaskPlacement`, `color` |
| `ProjectTask` | work item or milestone | `taskType`, `stageId`, derived `status`, `parentTaskId`, dates, priority, points, hours |
| `ProjectTaskCollaborator` | one user shared onto one task | unique `(taskId, userId)` |
| `ProjectTaskDependency` | directed edge, predecessor → successor | `taskId` is the successor; `dependencyType` nullable |

## Invariants and where each one lives

| Rule | Enforced by |
|---|---|
| A board must exist; `boardId` cannot change after creation | `ProjectGuardService.validateProject` |
| `dateEnd` never precedes `dateStart` (project and task) | `datesAreConsistent` in the guard |
| A task's status is its stage's `statusValue`, never a client write | guard derives `data.status`; rejects an explicit change outside a domain command |
| Stage, group and project must agree | guard + `assertGroupInProject`/`assertStageOfBoard` (cross-project ids are refused, not hidden) |
| A milestone has one date, no duration | guard (`dateEnd` must be empty for `taskType: Milestone`) |
| A parent completes only when every subtask is Completed/Canceled | guard `subtasksAllowCompletion` |
| Subtask and dependency graphs stay acyclic | `wouldCreateHierarchyCycle`, `wouldCreateCycle` |
| Reopening a subtask cannot leave a completed parent claiming completion | `ProjectTaskService.reopenParentIfNeeded`, same transaction |
| Assignee must be a current member | guard `validateAssignee` |
| The last managing member cannot disappear without a transfer | `ProjectMemberService.isLastOwner` + guard `assertNotLastOwner` |
| Membership, stage key, dependency edge and collaborator uniqueness | partial unique indexes in `018_phase19_projects.sql`; a self-edge is a table `CHECK` |
| A disabled feature cannot be written, and its stored values survive | guard `assertNotDisabled` + `ProjectPolicyService.features` |
| Deleting a group/category/board/stage/role that is in use | guard `validateDelete` (never cascades to tasks) |

`entity_records` needs no schema change for a new entity, so migration `018` carries only the
constraints JSON cannot express, plus expression indexes for the Plan/Board/Gantt access paths:

```sql
CREATE UNIQUE INDEX uq_project_member_project_user ON entity_records ((attrs->>'projectId'), (attrs->>'userId'))
  WHERE entity_type = 'ProjectMember' AND deleted_at IS NULL;
CREATE INDEX idx_entity_records_project_task_group_order ON entity_records ((attrs->>'groupId'), ((attrs->>'sortOrder')::int))
  WHERE entity_type = 'ProjectTask' AND deleted_at IS NULL;
```

Migration `019_phase19_dashlet_kind.sql` widens the `dashlets.kind` CHECK with `projectTasks`; the
replacement is a strict superset, so every existing row stays valid.

## Ordering

Group order is scoped to a project, task order to a group (or to a parent for subtasks). Ranks are
spaced by `ORDER_GAP = 1000` so a drop between two neighbours writes one row instead of renumbering
the list, and `id` breaks ties so a concurrent edit cannot produce two equal ranks. Reorder and move
commands validate every submitted id against the project they are addressed to, and run in one
transaction (see `apps/api/src/entity/tx-context.ts`).

## Delete and retention

Deletion is the kernel's soft delete (`deleted_at`). A project with tasks cannot be deleted; a group
with tasks can only be deleted after its tasks move. The partial unique indexes exclude
soft-deleted rows, so a deleted membership can be recreated. Audit rows, stream items and
attachments keep pointing at the soft-deleted record, as everywhere else in the platform.
