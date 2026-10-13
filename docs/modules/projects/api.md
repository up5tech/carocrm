# Projects — API

Everything a single metadata record can express stays on the generic API
(`/api/v1/Project`, `/api/v1/ProjectTask`, `/api/v1/ProjectGroup`, … with list, read, create, PATCH,
delete, relations, attachments, stream). The routes below exist only where a request mutates more
than one record or needs interpretation. All are `POST` actions under the entity's own static
prefix, so they can never collide with `:entity/:id/:relation`
(`PROJECTS_CONTROLLERS` is spread before `ENTITY_CONTROLLERS` in `apps/api/src/app.module.ts`).

Bodies are validated with zod (`apps/api/src/projects/dto/project-shapes.ts`); a cleared control may
send `null`, which means "absent". Errors use the kernel envelope
`{ error: { code, message, details } }`, and the specific reason rides in `details.reason` because
`message` is the localized face of the code.

## Project

| Operation | Route | Body / notes |
|---|---|---|
| Capabilities + feature flags | `GET /Project/:id/action/capabilities` | drives every visible control in the SPA |
| Plan projection | `GET /Project/:id/action/plan` | ordered groups with ordered tasks, board stages, `truncated` |
| Kanban projection | `GET /Project/:id/action/board?groupId=` | columns from the board's stages; defaults to `activeGroupId` |
| Gantt projection | `GET /Project/:id/action/gantt?allGroupTypes=` | dated tasks, milestones, dependency edges; 422 when the view is disabled |
| Board stages | `GET /Project/:id/action/stages` | the project board's stages in order |
| Members | `GET /Project/:id/action/members` | membership with resolved user and role names |
| Add member | `POST /Project/:id/action/members` | `{ userId, projectRoleId }` |
| Change role | `POST /Project/:id/action/memberUpdate` | `{ memberId, projectRoleId }` |
| Remove member | `POST /Project/:id/action/memberRemove` | `{ memberId, transferToMemberId? }`; clears the ex-member's assignments and collaborations in one transaction |
| Bulk membership | `POST /Project/:id/action/memberBulk` | `{ projectIds[], userIds[], projectRoleId, operation: add\|remove\|role }`, per-project verdicts |
| Create group | `POST /Project/:id/action/groupCreate` | `{ name, groupType, color?, newTaskPlacement?, sortOrder? }` |
| Update group | `POST /Project/:id/action/groupUpdate` | `{ groupId, … }` |
| Delete group | `POST /Project/:id/action/groupRemove` | `{ groupId, moveToGroupId? }`; refuses while the group holds tasks |
| Reorder groups | `POST /Project/:id/action/groupReorder` | `{ groupIds[] }` |
| Create task | `POST /Project/:id/action/taskCreate` | stage defaults to the board's first stage; creator becomes owner |
| Create milestone | `POST /Project/:id/action/milestone` | one `dateStart`, no duration |
| Reorder tasks | `POST /Project/:id/action/taskReorder` | `{ groupId? , parentTaskId?, taskIds[] }` |
| Write settings | `POST /Project/:id/action/settings` | any of the six flags + `activeGroupId` |
| Clone | `POST /Project/:id/action/clone` | `{ name?, dateStart?, copyMembers, copyTaskOwners, copyTaskAssignees, copyAttachments }` → `{ projectId, name, counts }` |

## ProjectTask

| Operation | Route | Body / notes |
|---|---|---|
| Move | `POST /ProjectTask/:id/action/move` | `{ stageId?, groupId?, parentTaskId?, beforeTaskId?, afterTaskId?, version? }` — one atomic command behind every drag |
| Reorder | `POST /Project/:id/action/taskReorder` | see above (addressed to the project, so a foreign task list is refused) |
| Transition | `POST /ProjectTask/:id/action/transition` | `{ kind: start \| complete \| cancel }`; always a stage move, never a status write |
| Edit | `POST /ProjectTask/:id/action/update` | field edits with the same guards as a generic PATCH |
| Bulk | `POST /ProjectTask/action/bulk` | `{ ids[], operation: complete \| cancel \| selfAssign }`, per-record result |
| Dependencies | `GET/POST /ProjectTask/:id/action/dependencies` | list, or `{ predecessorTaskId, dependencyType? }` |
| Dependency type | `POST /ProjectTask/:id/action/dependencyUpdate` | `{ dependencyId, dependencyType \| null }` |
| Dependency delete | `POST /ProjectTask/:id/action/dependencyRemove` | `{ dependencyId }`; the edge must belong to `:id` |
| Collaborators | `GET/POST /ProjectTask/:id/action/collaborators`, `collaboratorAdd`, `collaboratorRemove` | members only; refuses when the project disables the feature |

## Read models that reuse the kernel

* **Calendar** — `GET /api/v1/Calendar?entities=ProjectTask` (read-only, ACL-filtered).
* **Dashlet** — `POST /api/v1/Dashboard/:id/dashlets` with
  `kind: "projectTasks"` and `config: { nextDays, includeOwned, includeCollaboration,
  excludeAssigned, groupTypes[], includeCompleted, maxSize }`; run it through the normal
  `…/action/run` route.
* **Stream, notes, attachments, audit history** — the ordinary `/Stream`, `/Note`, `/Attachment`
  and `/AuditLog` routes accept `Project` and `ProjectTask` as parents; no module endpoint exists.

`GET /api/v1/OpenApi` and `/docs` list the controllers; the generic entity routes and these actions
share the same auth guard and request context as the rest of the API.
