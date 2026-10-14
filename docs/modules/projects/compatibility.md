# Projects — compatibility with the EspoCRM Project Management reference

Baseline: **EspoCRM 9.3.x documented behaviour** (PLAN §3.2 Phase A), used as a functional
reference only. Nothing was copied from upstream PHP, assets, translations or icons.

## Matched deliberately

| Reference behaviour | Here |
|---|---|
| Projects, categories (tree), boards, stages, tasks, subtasks, milestones, groups | ten metadata entities, see [data-model.md](data-model.md) |
| A board defines the stages; each stage maps to one of `Not Started / Started / Completed / Canceled / Deferred`; several stages may map to the same status | `ProjectBoardStage.statusValue`; seeded default board maps three stages to `Started` |
| The task status follows the stage and is not freely editable | guard derives it and refuses a direct status write |
| A board cannot be swapped after creation without migrating stages | `boardId` is immutable (422 with the reason) |
| Project members hold a project role; Owner / Editor / Member built in, custom roles possible | `ProjectRole` with eleven dimensions; three `isSystem` roles seeded |
| Plan, Board and Gantt views; group types Triage/Backlog/Work/Phase/Sprint; Gantt defaults to Work/Phase/Sprint | `/Project/:id/{plan,board,gantt}`, `groupType`, `GANTT_GROUP_TYPES` |
| Dependencies of four types plus an untyped, informational edge; cycles and self-edges refused; enforcement per type | `dependencyBlockFor`, `wouldCreateCycle`, table `CHECK` against a self-edge |
| With a task selected in the Gantt, create the next item as its dependent | the selected-task panel offers "Create dependent item"; the new task is created and then linked as the successor with a `FinishToStart` edge |
| A parent cannot complete while a subtask is open | guard `subtasksAllowCompletion` |
| Per-project settings for dependencies, collaborators, priority, points, hours, Gantt; disabling never deletes data | six flags, enforced in `assertNotDisabled`, values kept |
| Cloning with optional content and a date offset | `ProjectCloneService` |
| Project Task dashlet with next-X-days / owned / shared / exclude-assigned / group-type options | `kind: "projectTasks"` |
| Read-only calendar display of project tasks | `ProjectTask` in `DEFAULT_CALENDAR_ENTITIES` |
| Stream, notes, attachments, activities and history from the CRM core | kernel routes, no parallel implementation |

## Deliberate deviations

1. **Task type values are `Task` / `Milestone`** (capitalized), matching this codebase's enum style
   (`Not Started`, `FinishToStart`) rather than the reference's lower-case tokens.
2. **`isSystem` roles** are a local marker; upstream has built-in roles without exposing such a flag.
   It exists so the API can refuse to delete the roles the membership rows of a project depend on.
3. **Collaborators must be project members.** The reference's non-member collaborators are not
   adopted: membership is the boundary this implementation enforces everywhere
   (`validateCollaborator`). Recorded as a strict boundary, not an omission.
4. **Reopening a subtask under a completed parent** reopens the parent to its `Started` stage in the
   same transaction. The reference documents the guard (a parent cannot complete with open subtasks)
   but not the reverse direction; this rule keeps the pair consistent instead of leaving a parent
   claiming completion.
5. **A role never widens the global ACL for an outsider, and never narrows a global `all`.** See
   [permissions.md](permissions.md) "How they combine" — the reference leaves this composition
   implicit.
6. **Project settings are typed columns on the `Project` record**, not a JSON blob: each flag is a
   metadata field with a default, so validation, audit and the Entity Manager see them.
7. **Group reordering and the Plan view are hand-drawn** with `dnd-kit` (approved for this phase)
   rather than a bundled project-management widget; the Gantt is SVG written in this repo, with no
   third-party chart dependency.
8. **Group type is resolved at read time, not exposed as a metadata `foreign` field.** §4.5 asks for
   the related Group Type to be queryable "for filters and dashboard options". This platform's
   `foreign` field type is an ID link, not a computed value, so a `ProjectTask.groupType` field
   would either be a stored duplicate that can drift from its group or need a new kernel feature.
   The supported query paths are the dashlet's `groupTypes` option and the Gantt's group-type
   filter; both read the group row itself, so a client cannot supply a value that disagrees with
   the actual group. Filtering the *generic* `ProjectTask` list by group type is therefore not
   available.

## Deferred (not built in this phase)

* **Working-time / non-working-day shading and duration math** in the Gantt view: the platform has no
  working-time calendar to reuse, so the view is calendar-neutral — the spec forbids building a
  second calendar engine here (§4.12, §3.2).
* **Multi-select drag on the Gantt** (shifting several tasks at once).
* **Keyboard shortcuts** `Ctrl+Backspace` / `Ctrl+'` in the Plan view; the same commands exist as
  buttons and API actions, and the SPA has no global shortcut registry to hook into yet.
* **Assignment and membership notifications.** The kernel delivers in-app notifications for Stream
  mentions and reminders, but nothing yet for "a task was assigned to me" or "you were added to a
  project"; §11 makes those conditional on the notification subsystem, so they are not faked here.
* **Project templates** beyond cloning an existing project (P2 in the phase plan).
* **Cross-project dependencies**, capacity/resource planning, timesheets, budgets, offline edits
  (P2).
* **Portal exposure** of projects: portal users get no Projects surface in this phase.
* **Bulk member actions from the project *list***: the bulk command and its per-project verdicts are
  implemented and reachable from the Members page; wiring an extra row action into the generic list
  page would change shared UI for every entity, so it is left for a separate decision.

## Unverified against upstream

docs.espo.crm was not reachable from this machine during implementation, so the wording above
rests on the phase plan's summary of the reference plus the feature list it enumerates. Anything in
this file that claims "the reference documents X" should be re-checked against the upstream page
before it is quoted to a customer — the same caveat already recorded for the formula and dynamic
logic contracts in [../../reference/compatibility-matrix.md](../../reference/compatibility-matrix.md).
