# Projects — permissions

Two layers, in this order, for every request (§9 of the phase plan):

1. **Global ACL** (`packages/acl`, `roles.permissions`): `Project`, `ProjectTask`, … with the levels
   `no | own | team | all`. A `no` here is a hard denial; no project role can change it.
2. **Project role** (`ProjectRole`, read through `ProjectMember.projectRoleId`): decides what a
   member may do *inside that project*.

## How they combine

`AclApiService.recordPredicate(entity, action)` returns a `projectScoped` predicate for the seven
project entities when the caller's global level is `own` or `team`
(`apps/api/src/projects/project-scope.ts`):

* a **non-member** is judged by the global scope alone — a project role grants nothing to an
  outsider, so guessing an id opens nothing;
* a **member** is judged by their role, which *narrows* what the global scope would allow:
  `taskDeleteScope: no` denies deleting even the member's own task;
* a global level of `all`/`yes` (and every administrator) is the documented "global policy
  explicitly permits it" case: the role does not narrow it further.

The same rule is evaluated in two places and must agree exactly: SQL in
`projectScopeSql` (`apps/api/src/entity/entity-record.store.ts`) for lists, the calendar window and
the dashlet, and `ProjectPolicyService.allowsScoped` for by-id reads and writes. A record outside
the caller's scope answers 404, a scope the caller reaches but the role forbids answers 403.

## Role dimensions

| Field | Values | Gates |
|---|---|---|
| `taskCreate` | yes / no | creating a task |
| `assignmentScope` | all / own | assigning a task to somebody else |
| `taskReadScope` | all / own | reading a task, and every projection that contains it |
| `taskStreamScope` | all / own | reading and posting on a task Stream |
| `taskEditScope` | all / assigned / own | editing task fields |
| `stageMoveScope` | all / assigned / own | moving between stages (a drag, a transition) |
| `taskDeleteScope` | all / own / no | deleting a task |
| `projectStreamAccess` | yes / no | the project Stream |
| `groupManage` | yes / no | create / rename / reorder / delete groups |
| `memberManage` | yes / no | membership and roles; also marks the "owner" a project cannot lose |
| `projectEdit` | yes / no | project fields and settings |

`own` means owner, assignee or collaborator of that task; `assigned` means assignee only. Both are
evaluated by `roleGrants` in `project-domain.ts` — one function for the SQL mirror, the guard and
the capabilities read model.

## Seeded roles

| Role | create | read | edit | move | delete | groups | members | project edit |
|---|---|---|---|---|---|---|---|---|
| Owner | yes | all | all | all | all | yes | yes | yes |
| Editor | yes | all | all | all | all | yes | no | yes |
| Member | yes | all | own | assigned | no | no | no | no |

Built-in roles are `isSystem: true`: the API refuses to delete them while any member uses them, and
a role in use cannot be deleted at all.

## Administration-only records

`ProjectBoard`, `ProjectBoardStage`, `ProjectRole` and `ProjectCategory` are configuration. Writing
them requires the global entity permission (`own`/`all` as granted to the role, normally an
administrator), and the guard additionally refuses a stage delete or re-map while tasks sit on it,
and a category move that would create a loop.

## Command-level checks

Beyond the record scope, each command asserts its own dimension through
`ProjectAccessService.assertProjectAbility`: task creation, group management, membership changes,
settings writes, dependency edits, cloning. `GET /api/v1/Project/:id/action/capabilities` returns the
same computation so the SPA draws exactly the controls the server would accept — hiding a button is
never the authorisation.

## Tests

`apps/api/test/projects-security.test.ts` covers: non-member invisibility, global `no` beating a
generous role, cross-project id guessing, the `own`/`assigned` tiers, last-owner transfer,
assignee eligibility, per-project bulk authorisation, and that Plan/Board/Gantt/calendar/dashlet/
Stream all filter identically.
