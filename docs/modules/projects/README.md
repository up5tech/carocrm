# Projects module (Phase 19)

Implemented 2026-10-13 in `apps/api/src/projects` (backend), `apps/web/src/pages/projects`
(SPA) and `database/{seed-metadata.ts,seed.ts,migrations/018_phase19_projects.sql,019_phase19_dashlet_kind.sql}`.
Functional reference: EspoCRM Project Management documentation
(<https://docs.espocrm.com/extensions/project-management/projects/>), reproduced as clean-room
TypeScript behaviour — see [compatibility.md](compatibility.md) for the deviations.

## What it gives a user

| Capability | Where |
|---|---|
| Projects with a board chosen at creation, an owner, a category, dates and per-project settings | `/Project` list, `/Project/:id` detail |
| Plan view: ordered groups, ordered tasks, subtasks, drag to reorder or move between groups | `/Project/:id/plan` |
| Kanban board: one column per stage of the project's board, one group at a time | `/Project/:id/board` |
| Gantt view: task ranges, milestone markers, dependency paths, drag-move and resize | `/Project/:id/gantt` (only when the project enables it) |
| Members with a project role each, plus bulk membership across projects | `/Project/:id/members` |
| Feature settings (dependencies, collaborators, priority, points, hours, Gantt) | `/Project/:id/settings` |
| Project clone with date shifting and optional content | Settings → "Clone this project" |
| Project Tasks on the calendar (read-only) | `/calendar` |
| "Project tasks" dashlet on any dashboard | `/dashboards` |
| Stream, notes, attachments, audit history and related Activities | inherited from the kernel, no module code |

Navigation: `Project`, `ProjectTask`, `ProjectBoard`, `ProjectRole` and `ProjectCategory` appear in
the SPA's Records menu (metadata-driven); `ProjectGroup`, `ProjectMember`, `ProjectBoardStage`,
`ProjectTaskCollaborator` and `ProjectTaskDependency` are `client.web: false` and are reached
through their parent's views.

## Default data

`database/seed.ts` inserts, once and with fixed ids (`ON CONFLICT DO NOTHING`, never on boot):

* board `projectBoardDefault` with stages `notStarted`, `inProgress`, `blocked`, `review`, `done`,
  `canceled`, `deferred` — three of them map to `Started`, which is what makes the stage→status
  mapping observable;
* built-in roles `projectRoleOwner`, `projectRoleEditor`, `projectRoleMember` (`isSystem: true`,
  so the API refuses to delete them while members still use them).

No demo projects or tasks are ever created.

## Module layout

```text
apps/api/src/projects/
  project-domain.ts             pure rules (statuses, dependency types, cycles, role tiers, date math)
  project-scope.ts              which entity/action a ProjectRole speaks for
  project-policy.service.ts     membership, role resolution, scoped ACL evaluation, feature flags
  project-access.service.ts     the authority question each command asks, + capabilities read model
  project-guard.service.ts      every invariant, enforced on the Entity Engine phases
  project-records.ts            structural reads (board of a stage, group of a task, …)
  project-board.service.ts      stage list as one document, default board
  project-member.service.ts     membership, last-owner rule, bulk membership
  project-group.service.ts      groups, ordering, delete-with-move
  project-task.service.ts       create/move/reorder/transition/subtasks/milestones/collaborators
  project-dependency.service.ts dependency commands
  project-clone.service.ts      transactional clone with id remapping and date offset
  project-view.service.ts       Plan / Board / Gantt projections, settings write
  project-dashlet.service.ts    the Project Task dashlet query
  projects.controller.ts        domain commands; dto/project-shapes.ts validates them
```

Records themselves are ordinary metadata entities in `entity_records`, so the Entity Engine keeps
CRUD, validation, field ACL, audit, stream, attachments and search; the module adds the rules that
span more than one record. Nothing in `apps/api/src/projects` reimplements a kernel subsystem.

## Verification

`pnpm vitest run apps/api/test/projects-domain.test.ts apps/api/test/projects.test.ts
apps/api/test/projects-work.test.ts apps/api/test/projects-security.test.ts
apps/api/test/projects-clone.test.ts` (66 checks) and
`pnpm exec playwright test e2e/projects.spec.ts` (browser journey). See the "Projects" section of
[../../reference/alpha-status.md](../../reference/alpha-status.md) for the recorded results.

## Deeper documents

* [data-model.md](data-model.md) — entities, invariants, where they are enforced
* [permissions.md](permissions.md) — global ACL plus project roles, with worked examples
* [api.md](api.md) — the domain commands and their payloads
* [compatibility.md](compatibility.md) — matched behaviour, deliberate deviations, deferred items
