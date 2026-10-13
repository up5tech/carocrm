# Phase 19 — Projects Module (`projects`)

> **Status:** Implemented 2026-10-13 — see `docs/modules/projects/` (README, data-model, permissions, api, compatibility) and the "Projects" section of `docs/reference/alpha-status.md` for what was built, what is deferred and the verification actually run.  
> **Parent roadmap:** `PLAN.md` — Phase 19: Advanced Domains  
> **Target runtime:** NestJS / TypeScript backend with the existing React SPA  
> **Functional reference:** EspoCRM Project Management documentation, especially [Projects](https://docs.espocrm.com/extensions/project-management/projects/)  
> **Implementation rule:** Build on the platform completed in Phases 0–18. Do not reimplement kernel capabilities inside this module.

---

## 1. Purpose

Implement a first-class Projects domain for the NestJS CRM reimplementation. The module must let users plan projects, organize work into groups and tasks, assign work to project members, manage task status through board stages, visualize work in Plan/Kanban/Gantt views, track milestones and dependencies, and discuss work through the existing CRM collaboration features.

This is a **clean-room TypeScript implementation** guided by documented EspoCRM behavior. It is not a PHP port and does not require the upstream PHP runtime or database schema.

### 1.1 Primary outcomes

At the end of this phase, authorized users can:

1. Create and manage projects and project categories.
2. Choose a project board at creation time and use its stages to control task status.
3. Manage project members and assign project-specific roles.
4. Organize tasks into project-specific groups, reorder them, and move them between groups.
5. Create tasks, subtasks, and milestones, and manage owners, assignees, collaborators, dates, priority, points, and estimated hours.
6. Configure task dependencies and enforce supported dependency constraints.
7. Work through Plan, Kanban Board, and Gantt views.
8. Use the existing Stream, Attachments, Activities/History, Calendar, Dashboard, ACL, notification, audit, and job infrastructure where available.
9. Clone a project with selected content and shift dates relative to a new project start date.
10. Operate safely through the generic Entity Engine and documented APIs, without bypassing metadata or authorization.

### 1.2 Explicit scope boundary

This phase implements the **Projects domain module**. It does not replace or duplicate:

- The generic Entity Engine, Metadata Registry, relation engine, query engine, layouts, or field validation.
- Authentication, global Role/Team ACL, record ACL, field-level ACL, or request context.
- The generic Stream/timeline, attachments/file storage, audit/history, notification, and Activities systems.
- The generic dashboard/dashlet framework, job queue/scheduler, working-time calendar, search, import/export, or formula/dynamic-logic engines.
- A general-purpose resource planning, billing, invoicing, timesheet, or portfolio-management system unless those features are explicitly added in a later scope decision.

The module may contribute metadata, domain services, authorization policies, UI views, events, and settings to those existing platform subsystems.

---

## 2. Reference Baseline and Compatibility Notes

Use the project-wide compatibility policy in `PLAN.md`:

- **Phase A baseline:** EspoCRM 9.3.x documented behavior where the existing plan requires that baseline.
- **Phase B baseline:** newer upstream behavior only when explicitly recorded as an intentional later enhancement.
- Do not silently combine behaviors from different baseline versions.

The upstream Project Management documentation describes features including projects, project categories, boards, access control, project roles, members, tasks, dependencies, subtasks, milestones, groups, Plan view, Board view, Gantt view, project cloning, a Project Task dashlet, keyboard shortcuts, and read-only calendar display. The feature-specific reference is:

- https://docs.espocrm.com/extensions/project-management/projects/
- Related generic developer APIs and concepts: https://docs.espocrm.com/development/metadata/, https://docs.espocrm.com/development/acl/, https://docs.espocrm.com/development/hooks/, https://docs.espocrm.com/development/attachments/

### 2.1 Compatibility policy

- Reproduce documented user-visible behavior where practical.
- Use this project's API, metadata, database, naming, and frontend conventions even when their internal representation differs from EspoCRM.
- Record meaningful deviations in `docs/compatibility/projects.md`.
- Never assume database-schema compatibility with EspoCRM.
- Do not copy upstream PHP code, frontend assets, translations, icons, or branding.

---

## 3. Prerequisites and Repository Audit

Before implementation, the coding agent must read `AGENTS.MD` and `PLAN.md`, inspect the repository, and identify what Phases 0–18 actually delivered. **Do not assume a subsystem exists merely because it appears in the master plan.**

### 3.1 Verify available platform capabilities

Confirm the existing implementation and documented usage for:

- NestJS module registration and dependency injection.
- Entity Engine CRUD, metadata, field types, relation definitions, query filtering, pagination, sorting, and serialization.
- Database migration conventions and SQL/query-builder conventions.
- Generic REST endpoint and error/response conventions.
- Global role ACL, record-level ACL, field-level ACL, and current-user/request context.
- Hooks/domain events and transaction boundaries.
- Stream, attachments, audit/history, activities, calendar, dashboard/dashlets, notifications, and jobs.
- React routing, generic list/detail/edit forms, metadata-based layouts, modal/dialog patterns, drag-and-drop library (if any), and UI component conventions.
- Existing test commands and database lifecycle behavior.

### 3.2 Gap handling

If a prerequisite is missing:

1. Identify the smallest interface or extension needed by Projects.
2. Determine whether it belongs in the kernel or this module.
3. Implement the smallest reusable platform enhancement in the established location only when necessary.
4. Do not create a second implementation of an existing subsystem.
5. Record the gap and any compatibility impact in the completion report.

### 3.3 Repository and database safety

- Preserve all user changes and inspect `git status` before editing.
- Follow `AGENTS.MD` database rules. Integration/API/smoke tests must use the existing configured primary project database; do not create `test_db`, shadow, temporary, per-agent, or other test databases.
- Do not reset, truncate, broadly delete, recreate, or replace the database.
- Use clearly marked, narrowly scoped test records and only clean up records created by the current test run.
- Inspect migration SQL before applying it. Prefer additive/backward-compatible migrations.

---

## 4. Functional Requirements

### 4.1 Projects

A project is the top-level container for members, a board, groups, tasks, project-specific settings, and project-level collaboration.

Required capabilities:

- Project list, detail, create, edit, archive/delete according to the platform's deletion conventions, and related-record navigation.
- Fields: `name`, `description`, `dateStart`, `dateEnd`, `ownerUserId`, `boardId`, `categoryId` (optional), `activeGroupId` (optional), project-level settings, and standard created/modified/audit fields as supported by the Entity Engine.
- Validate dates: when both project start and end dates are set, end date must not precede start date unless the project-wide date policy explicitly allows it.
- `boardId` is required at creation and becomes immutable after initial creation to preserve stage integrity. If the product later supports changing boards, it must include a reviewed stage/task migration strategy; do not silently swap the board.
- Projects can share a Project Board definition.
- Project owner and project members are distinct concepts: the project owner is the accountable owner; members are explicit users with project-specific roles.
- Project detail view includes Overview, Members, Plan, Board, Gantt (when enabled), Stream, Activities, and History panels/tabs according to the UI conventions.
- Project-level settings can enable/disable optional capabilities described in Section 4.11.
- Project updates are published to the existing Stream/event framework where that framework supports the corresponding event types.

Do not introduce an unverified project lifecycle enum as if it were an upstream compatibility requirement. If the application needs an explicit project lifecycle state, follow the existing product convention, define it as an intentional local extension, and document it.

### 4.2 Project categories

- Support hierarchical/tree-like categories.
- A category has `name`, optional `description`, `parentId`, `sortOrder`, and normal audit fields.
- Prevent a category from becoming its own ancestor; detect cycles on move/update.
- Prevent deletion when it has child categories or projects, unless the established platform convention defines a safe reassignment/soft-delete process.
- Only administrators (or the explicitly configured administrative permission) may create/edit/delete categories.
- Global Role ACL has a separate Project Category scope. Category visibility and project visibility must not accidentally grant access to a project record.
- The project editor exposes only categories visible to the current user.

### 4.3 Project Boards and Stages

A Project Board defines the stages available to tasks in projects that use that board.

Required capabilities:

- Administration CRUD for Project Boards and stages, governed by global ACL.
- Provide a seeded/default board with practical default stages, without repeatedly reseeding on application startup.
- Board fields: `name`, `description`, `isDefault` or equivalent default-board setting, and audit fields.
- Stage fields: `boardId`, stable `key`, display `name`, `sortOrder`, mapped task `status`, and optional presentation metadata supported by the UI framework.
- Stage mapping supports the task statuses:
  - `Not Started`
  - `Started`
  - `Completed`
  - `Canceled`
  - `Deferred`
- Multiple stages may map to the same status (for example, Review and In Progress may both map to Started).
- Each board must have at least one stage; a default board must be selected deterministically.
- A task's `stageId` must belong to its project's board.
- When a task moves to a stage, update its derived status in the same transaction.
- The Status field is read-only through ordinary task edit operations. It must not be independently edited in a way that contradicts the stage mapping.
- Validate changes to board stages against existing project/task usage. Do not delete or remap an in-use stage in a way that leaves tasks invalid. Require a safe explicit migration/reassignment strategy.
- Changing stage ordering is allowed and must not change the mapped status unexpectedly.

### 4.4 Project-specific roles and members

Support both global ACL and project-specific permission rules. Global ACL is always a prerequisite; a project role must never grant a permission denied by the global ACL.

#### Built-in project roles

Provide seed definitions for these roles, implemented using the same custom role model as user-defined project roles:

- **Owner:** may edit the project, manage project membership, manage groups, create/edit tasks, and access the project Stream, subject to global ACL.
- **Editor:** may edit the project and groups, create/edit tasks, and access the project Stream, subject to global ACL.
- **Member:** may view tasks allowed by the role policy, move permitted assigned tasks between stages, edit tasks they own when permitted, and access only the Streams allowed by the configured policy.

Built-in roles must be identifiable as system roles so they cannot be accidentally deleted or structurally corrupted. Their labels and defaults may be configurable if the platform supports that safely.

#### Custom Project Roles

Project Role definitions should express these policy dimensions:

- Task creation: `yes | no`.
- Assignment scope: `all | own` (whether the user can assign tasks to eligible project members generally or only to themselves, interpreted consistently and documented).
- Task read scope: `all | own`.
- Task Stream scope: `all | own`.
- Task edit scope: `all | assigned | own`.
- Stage-move scope: `all | assigned | own`.
- Task delete scope: `all | own | no`.
- Project Stream access: `yes | no`.
- Group management: derived from the role's documented capabilities or represented explicitly as a permission if needed by this implementation.
- Member management and project settings management must be limited to project Owner/Editor and global administrators unless a deliberate permission is introduced.

Document the precise meanings of `own` and `assigned`. Do not overload the global ACL's `own` semantics without checking the existing ACL evaluator.

#### Members

- A member links one user to one project and a Project Role.
- Enforce unique `(projectId, userId)` membership.
- A user removed from a project must no longer be eligible as a task assignee for that project.
- Prevent removal of the last project Owner unless ownership is transferred in the same transaction.
- Project members can be managed in the project detail view.
- Where bulk multi-project membership operations are in scope, provide guarded bulk add/remove/role-change actions from the project list.
- Enforce project membership and role checks on every API and background job; frontend visibility is not sufficient.

### 4.5 Project Groups

Each project owns its groups; groups are not shared across projects.

Group fields:

- `projectId`, `name`, `type`, `sortOrder`, optional `color`, `newTaskPlacement`, and audit fields.
- Supported group types: `Triage`, `Backlog`, `Work`, `Phase`, and `Sprint`.
- Default group type is `Work`.
- `newTaskPlacement` supports top or bottom, and determines initial task order within that group.
- `activeGroupId` on a project (or equivalent relation) preselects the group when creating a task.
- Project Owners and Editors can create, rename, recolor, reorder, and remove groups.
- Reordering must be persisted as a batch operation with server-side validation and deterministic ordering.
- Deleting a non-empty group must require a clear policy: move its tasks to another group, or perform a guarded operation that preserves those tasks. Never cascade-delete a group's tasks by default.
- Moving a task between groups must verify the task and destination group belong to the same project and preserve task sort order.
- Only groups of type Work, Phase, and Sprint are included in the Gantt view by default. The implementation may expose a controlled filter to show other types if useful.
- Expose the related Group Type as a queryable/metadata foreign field for filters and dashboard options, without trusting a client-provided value that disagrees with the actual group.

### 4.6 Project Tasks

Project Task is a dedicated entity (`ProjectTask`) managed through the generic Entity Engine and extended by a domain service. It must not be a second implementation of the generic CRM `Task` activity entity. The two entities may be related only through an explicit integration, not conflated.

Core fields:

- `projectId` (required)
- `groupId` (required for regular tasks and milestones)
- `parentTaskId` (optional; subtask relation)
- `name` (required)
- `description` (optional)
- `taskType`: `task | milestone`
- `stageId` (required for regular tasks; apply a documented milestone rule)
- `status` (derived/read-only from stage for normal moves; system-controlled completion/cancellation paths)
- `ownerUserId` (the user overseeing the task)
- `assigneeUserId` (optional; must be an eligible project member)
- `dateStart` and `dateEnd` (optional for tasks)
- `priority`: `Low | Normal | High | Urgent`, when enabled
- `points` (optional numeric/whole-number effort estimate, when enabled)
- `estimateHours` (optional numeric effort estimate, when enabled)
- `sortOrder`
- standard audit fields, and optimistic concurrency field/version if the platform already supports it.

Rules:

- The task creator becomes the initial task owner if no permitted owner override is supplied.
- Assignee may be empty. If supplied, the user must be a current project member.
- Project membership changes must not silently leave invalid assignees. Define a transaction-safe reassignment/clear policy before allowing member removal.
- A task must reference a group and stage belonging to the same project/board.
- `dateEnd` must not precede `dateStart`.
- Priority, points, and hours may be disabled per project. When disabled, hide controls in the UI and reject or ignore writes according to the platform's established validation contract; never allow the UI-only setting to be bypassed by direct API calls.
- Status is derived from the stage mapping and cannot be manually changed via generic PATCH/PUT.
- Provide domain commands for complete/cancel/move where needed so all status, dependency, subtask, events, and audit rules are applied consistently.
- Task list filters include project, group, group type, stage, status, owner, assignee, dates, priority, and parent task where supported by the query engine.
- Preserve the existing Entity Engine semantics for field validation, serialization, relations, filtering, sorting, pagination, and ACL.

### 4.7 Subtasks

- Any eligible task may have child tasks; milestones should not become parents unless explicitly allowed by a documented rule.
- Subtasks may have different owners and assignees from their parent, provided all assignees are project members.
- Provide a hierarchical subtask view and safe create/edit/reorder operations.
- Prevent a task from being its own parent and prevent cycles in the parent-child graph.
- A task that has subtasks cannot be marked Completed until every subtask is in Completed or Canceled status.
- Define and test the behavior when reopening a child task after a parent has completed. The parent should not silently remain in an inconsistent completed state; use a deterministic validation or status-reopen policy and document it.
- Deleting a parent must not silently delete descendants. Use the repository's established relation deletion policy and an explicit confirmation/policy for descendants.
- Keep subtask ordering stable within the parent.

### 4.8 Task dependencies

Support a task having multiple predecessor dependencies. Model dependency direction explicitly as predecessor → successor.

Dependency types:

- `FinishToStart`
- `FinishToFinish`
- `StartToStart`
- `StartToFinish`
- `null` / no type for a declarative, non-blocking dependency.

Requirements:

- Dependency functionality can be enabled/disabled per project.
- A disabled project rejects create/update dependency operations and does not expose dependency editing controls.
- Both tasks must belong to the same project unless cross-project dependencies are later approved as a separately scoped enhancement.
- Prevent self-dependencies and dependency cycles. Validate the proposed edge before persistence.
- Enforced dependencies must be checked server-side when starting/completing/moving tasks, not only in the Gantt UI.
- A null dependency type is informational only and must not block a transition.
- The transition validator must account for the documented dependency type; do not implement all types as a generic “predecessor must be complete” rule.
- Support create, delete, and type-change actions from the Gantt interaction and normal API.
- Display predecessor status clearly (for example, muted for Not Started, blue for Started, green for Completed); use the project's existing theme tokens, not hard-coded upstream assets.
- Provide understandable errors identifying the blocking predecessor and rule, without exposing inaccessible task details to unauthorized users.
- Dependency validation, task transition, stage update, audit record, and event emission must be transactionally consistent.

### 4.9 Milestones

- A milestone is represented by the Project Task entity with `taskType = milestone`, avoiding a separate duplicated task entity.
- A milestone has a single milestone date; provide a clear data invariant so it is not treated as a duration task in timeline logic.
- Milestones belong to a project and group and can be ordered among items according to the chosen Plan-view rule.
- A milestone has a name, optional description, owner, and optional assignee if the selected compatibility baseline requires it.
- Render milestones as a single point/date marker in Gantt and Plan views rather than a duration bar.
- Provide a create-milestone command from the Plan view group menu.
- Exclude or specially handle milestones in effort, duration, subtask, dependency, and calendar calculations so they do not produce misleading results.

### 4.10 Task collaborators and Streams

- Collaborators are enabled per project.
- Collaborators must be valid users under the established project membership policy. If the compatibility baseline permits non-member collaborators, record that as a deliberate divergence and apply a strict project-level boundary.
- Collaborators can read a task and post to its Stream only within the scope granted by the project configuration and global ACL.
- Task Stream and project Stream must use the shared Stream subsystem; do not create a separate comment/timeline implementation.
- A project member with permission to read the project Stream may see a task update in that Stream even if the member cannot open the task detail, if this visibility behavior is intentionally adopted from the reference. Stream serialization must redact fields and linked-record details the viewer is not allowed to read.
- Attachments to projects/tasks use the shared file/attachment subsystem and its download authorization checks.
- Task updates that materially affect status, dates, assignment, stage, or group should appear in Stream/history when supported by the existing kernel.

### 4.11 Project-level settings

Provide a project Settings page/menu that supports at least:

- Enable/disable task dependencies.
- Enable/disable task collaborators.
- Enable/disable priority.
- Enable/disable points.
- Enable/disable estimated hours.
- Enable/disable Gantt view.
- Any additional view setting justified by the compatibility baseline.

Rules:

- Store settings in validated schema-backed fields or the existing structured settings mechanism; do not scatter arbitrary booleans across frontend local state.
- Only authorized Owners/Editors/global administrators may change settings.
- Disabling a feature must not delete the underlying data. Re-enabling it must reveal existing values again.
- Disabling Gantt hides the view/action but does not erase task dates or dependencies.
- Feature flags are enforced by the backend as well as the UI.

### 4.12 Views and interactions

#### Projects list/detail

- Generic list filters, sort, pagination, search, saved filters, row actions, and layouts should use the platform UI/metadata framework.
- Detail view exposes project summary, dates, owner/category/board, members, settings, and the enabled Project views.
- Use loading, empty, validation, error, and permission-denied states consistently with other modules.

#### Plan view

- Display groups as ordered sections/columns and tasks as ordered items.
- Create, edit, complete, cancel, and remove tasks within the caller's permissions.
- Create, rename, remove, color, and reorder groups where authorized.
- Drag/drop can reorder tasks in a group or move a task between groups.
- Persist drag/drop using a single server-side command that validates all referenced rows and updates order atomically.
- Provide clear optimistic-update rollback when the server rejects a move.
- A group menu can create a milestone.
- Keyboard shortcuts, if implemented, must be discoverable and must not fire while the user is typing in an input/textarea/editor or when focus is inside an unrelated modal.

#### Kanban Board view

- Display task cards in columns defined by the selected Project Board's stages.
- Show tasks from one selected group at a time, with group switching.
- Drag/drop between columns changes stage and derives the status.
- Drag/drop within a column changes ordering.
- Enforce stage-move ACL, dependencies, subtask rules, project settings, and concurrency checks on the server.
- Do not let a drag/drop bypass task edit restrictions simply because the UI accepts a drop.

#### Gantt view

- Render task start/end dates, durations, milestones, dependencies, and applicable working/non-working days.
- By default include group types Work, Phase, and Sprint; exclude Triage and Backlog unless filtered otherwise.
- Drag to move a task timeline; resize to adjust its date range; support multi-select shift only if it can be implemented without breaking constraints.
- Dependency paths are selectable to edit/remove the related dependency.
- When one task is selected and the user creates a new task/milestone, offer the documented “create dependent item after selected item” interaction.
- Drag/resize requests must use domain endpoints that validate project settings, date ranges, task ACL, dependency constraints, and concurrent updates.
- If a working-time calendar already exists, use it for visual non-working-day shading and duration calculations. Do not build a second working-time calendar.
- If no calendar engine exists in the completed platform, use calendar-neutral date calculations in the first version and document that working-day shading is deferred rather than introducing an isolated engine here.
- Gantt can be disabled per project; direct view/data endpoints remain protected by project ACL and settings.

### 4.13 Calendar integration

- Integrate Project Tasks into the existing Calendar through the calendar's supported entity registration/configuration mechanism.
- Initial compatibility target is **read-only calendar display** for Project Tasks, consistent with the documented Project Management behavior.
- Calendar queries must enforce global ACL, project membership, task read permissions, and date visibility.
- Clicking a calendar item opens the task only if the user is authorized to read it.
- Do not allow calendar drag/drop to modify task dates unless editable calendar support is separately scoped and tested.

### 4.14 Activities, History, and related CRM records

- Allow supported existing activity types (Meetings, Calls, Emails, and other types actually implemented by the platform) to relate to a project using the standard relation engine.
- Reuse generic Activities and History panels; do not create ProjectMeeting, ProjectCall, or duplicated audit tables unless a specific platform gap demands it.
- Related-record visibility must follow the most restrictive applicable ACL; a Project relation must not grant access to an otherwise hidden Email or Meeting.

### 4.15 Project cloning

Provide a guarded Project Clone action.

Required behavior:

- User must have global create permission for Projects and edit permission on the source project.
- The new project's start date is required if the source project's start date is set and date shifting is requested.
- Copy project fields, groups, tasks, task hierarchy, task order, stage mapping, milestones, and dependencies that remain valid within the cloned project.
- Calculate the date shift from source project start date to new project start date and apply it consistently to project and task dates; milestone dates shift by the same delta.
- Optional clone choices: project members, task owners, task assignees, and attachments. Default values must be conservative and documented.
- If members are not copied, do not retain assignee/owner references that violate membership policy. Apply a deterministic fallback (clear the invalid assignment or map to the cloning user) and explain it in the UI.
- Copy dependencies only after all cloned task IDs are known; remap predecessor/successor IDs to the cloned tasks.
- Never copy system IDs, audit history, Stream messages, integration secrets, webhook identifiers, or external provider state.
- Perform clone operations in a transaction or via an idempotent staged job when volume requires it. Incomplete clones must be detectable and safely retriable/cleanable.
- Return the new project identifier and navigate to the new project after success.
- Deleting the clone must follow normal project/task deletion constraints; do not add hidden cascade behavior solely for clones.

### 4.16 Project Task dashboard dashlet

Implement a Project Task dashlet using the existing dashboard framework.

Configuration options:

- Next X days.
- Include tasks owned by the current user.
- Include tasks shared with the current user as collaborator.
- Exclude tasks assigned to the current user.
- Filter by one or more group types.
- Any sort or result limit should follow existing dashlet/query conventions.

Requirements:

- Multiple instances may use different option sets.
- Query results must be ACL-filtered at the server and reflect project-level task access.
- Define date semantics (date-only vs timestamp/timezone) consistently with the platform.
- Exclude completed/canceled items only if selected by the user's options or the existing dashlet convention; do not silently hide tasks in a way that contradicts filters.

### 4.17 Bulk actions and keyboard shortcuts

- Where feasible, support bulk member add/remove/role assignment across selected projects, with per-record authorization checks and partial-failure reporting.
- Provide the following optional shortcuts in the Plan view if they can be safely integrated with existing keyboard handling:
  - `Ctrl + Backspace`: complete selected tasks.
  - `Ctrl + Quote`: self-assign selected tasks that are currently unassigned.
- Shortcuts must run the same domain command and permission checks as normal actions, and must confirm or undo bulk destructive/state-changing operations according to existing UI conventions.

---

## 5. Domain Model and Persistence Design

Use the existing Entity Engine and selected persistence layer (see `PLAN.md`). The following is a logical model, not a command to use these exact table names if the repository has a stronger established naming convention.

### 5.1 Core records

| Logical entity | Purpose | Main relationships |
|---|---|---|
| `Project` | Project root and project-level configuration | Board, category, owner, members, groups, tasks |
| `ProjectCategory` | Hierarchical classification | Parent category, child categories, projects |
| `ProjectBoard` | Reusable stage-definition template | Stages, projects |
| `ProjectBoardStage` | A stage with status mapping and order | Board, tasks |
| `ProjectRole` | Project-specific task/stream permissions | Members |
| `ProjectMember` | User membership and assigned Project Role | Project, user, role |
| `ProjectGroup` | Ordered group within one project | Project, tasks |
| `ProjectTask` | Work item or milestone | Project, group, stage, owner, assignee, parent, dependencies |
| `ProjectTaskCollaborator` | Optional user-level task sharing | Task, user |
| `ProjectTaskDependency` | Directed dependency edge between tasks | Predecessor and successor tasks |

### 5.2 Data constraints and indexes

Implement appropriate unique constraints, foreign keys, and indexes for at least:

- Unique project membership by `(project_id, user_id)`.
- Unique board-stage key or name/order key according to board configuration rules.
- Unique category identity as defined by the project convention; index `parent_id`.
- Unique group/task rank within the intended scope only if rank-shifting logic can guarantee uniqueness safely; otherwise use deterministic order keys and a stable tie-breaker.
- Index tasks by `(project_id, group_id, sort_order)` and by commonly queried `stage_id`, `assignee_user_id`, `owner_user_id`, `status`, `date_start`, and `date_end` as workload warrants.
- Index dependency edges by predecessor and successor; prevent duplicate logical edges.
- Index all foreign keys and frequently joined relation columns.
- Enforce foreign keys wherever compatible with the existing Entity Engine/deletion model.

Do not add redundant indexes blindly. Check query plans against representative queries when performance requires it.

### 5.3 JSONB/settings rules

If the project uses PostgreSQL JSONB for flexible settings, validate settings against a typed schema and version them if schema evolution warrants it. Core relational invariants (foreign keys, stages, membership, dependencies) must not exist only in unconstrained JSON.

### 5.4 Ordering model

- Group order is scoped to a project.
- Task order is scoped to a group (or a parent when ordering subtasks).
- All order-changing commands must validate that the user may mutate every affected item.
- Prefer a deterministic ordering representation supported by the repository. Avoid requiring clients to submit a full arbitrary database row update.
- Use transactions for batch reordering and include tie-breakers so concurrent edits do not produce unstable lists.
- Protect against stale drag/drop writes using the platform's version/optimistic concurrency pattern when available.

### 5.5 Soft delete and retention

Use the platform's existing delete/archive conventions. Define how a project with groups, tasks, dependencies, Stream records, attachments, and activity relations is handled. Do not add cascading destructive deletion without an explicit policy, confirmation, and tests. Preserve references needed for audit/history according to the existing platform rules.

---

## 6. Backend Architecture

### 6.1 Module boundaries

Register Projects as an independent domain module using the actual workspace structure. An example target organization (adapt to the repository rather than creating duplicate roots) is:

```text
modules/projects/
  src/
    projects.module.ts
    projects.controller.ts
    projects.service.ts
    project-policy.service.ts
    project-members.service.ts
    project-board.service.ts
    project-group.service.ts
    project-task.service.ts
    project-task-transition.service.ts
    project-task-dependency.service.ts
    project-clone.service.ts
    project-query.service.ts
    project-dashlet.service.ts
    dto/
    domain/
    events/
    metadata/
    migrations/          # only if this module owns migrations in this repository
    tests/
  web/                   # only if the project convention places module UI here
  docs/
```

This layout is illustrative. Follow the actual repository's package/module pattern and do not reorganize the monorepo as part of this phase.

### 6.2 Domain services

Separate domain operations from controllers. At minimum, domain operations should cover:

- Project creation/update and board immutability.
- Project category validation and cycle prevention.
- Board/stage changes and safe stage mapping.
- Member management and last-owner invariants.
- Role policy evaluation in cooperation with the global ACL evaluator.
- Group creation/update/delete/reorder.
- Task create/update/move/reorder/complete/cancel/delete.
- Subtask constraints.
- Dependency create/update/delete and cycle/blocking validation.
- Milestone create/update and date handling.
- Project cloning and ID remapping.
- Read models/queries for Plan, Board, Gantt, and dashlets.

Keep controllers thin: authenticate, validate/deserialize, delegate to services, and return the standard API envelope.

### 6.3 Transaction boundaries

Operations requiring multiple related writes must be atomic where supported:

- Create project and its required initial groups/settings, if default groups are part of the selected product behavior.
- Transfer ownership and remove the prior owner.
- Reorder groups or tasks.
- Move a task and recalculate status/order.
- Complete/cancel tasks after validating dependencies/subtasks.
- Add/remove/change dependencies.
- Clone a project and remap all internal relationships.

Use the transaction abstraction already adopted by the repository. Do not introduce a competing transaction manager.

### 6.4 Events and hooks

Use existing domain events/outbox and hooks to emit appropriate events such as:

- `project.created`, `project.updated`, `project.member.added`, `project.member.removed`.
- `project.group.created`, `project.group.updated`, `project.group.reordered`.
- `project.task.created`, `project.task.updated`, `project.task.moved`, `project.task.completed`, `project.task.canceled`, `project.task.assigned`.
- `project.task.dependency.created`, `project.task.dependency.deleted`.
- `project.cloned`.

Use the repository's existing event naming convention if one exists. Do not invent a separate event bus. Event handlers should be idempotent where they trigger notifications or jobs. Include only permitted payload fields; consumers must re-check access where necessary.

---

## 7. API Plan

Follow the existing API versioning, URL casing, response envelope, validation errors, pagination, query/filter syntax, OpenAPI generation, and generic entity semantics. The routes below are a logical endpoint inventory; adjust exact method/path casing to match the current codebase.

### 7.1 Generic entity operations

Expose Projects entities through the generic Entity API and metadata registry where appropriate:

- `Project`
- `ProjectCategory`
- `ProjectBoard`
- `ProjectRole`
- `ProjectGroup`
- `ProjectTask`
- Dependency/member relation records only if the platform's generic relation patterns make them directly addressable.

Generic CRUD does not replace domain commands for state transitions or operations with cross-record invariants.

### 7.2 Domain endpoints/commands

Recommended logical endpoints:

| Capability | Operation |
|---|---|
| Project members | List/add/remove/change project role |
| Project members bulk edit | Add/remove/change role across selected projects, with per-project authorization |
| Project groups | Create/update/remove/reorder groups |
| Project tasks for a project | Query tasks with Plan/Board/Gantt projections and filters |
| Move task | Move to another group and/or stage through a validated command |
| Reorder tasks | Persist an ordered set of task IDs in a specified group/parent scope |
| Complete/cancel task | State transition command; do not accept arbitrary status patch |
| Task subtasks | List/create/reorder children and update parent relationship |
| Task dependencies | List/create/change type/delete directed dependencies |
| Create milestone | Create a milestone in a project group with one date |
| Clone project | Clone source project with options and date offset |
| Project settings | Read/update typed settings under project policy |
| Plan view | Read-optimized grouped ordered projection |
| Kanban view | Read-optimized stage columns for the selected group |
| Gantt view | Read-optimized task ranges, milestones, and dependency edges |
| Project Task dashlet | Query scoped tasks from the current user's configuration |

Use action-oriented routes only where generic CRUD cannot express domain invariants. Do not create one endpoint for every frontend click if a smaller, consistent set of domain commands suffices.

### 7.3 API requirements

- Validate all entity IDs and ensure relations belong to the same project/board/group scope.
- Apply global ACL and project-level role policy server-side to every operation, including batch commands and read projections.
- Avoid leaking task names, dates, assignees, dependency details, or stream text through unauthorized projections/errors.
- Use structured validation errors for blocked transitions, invalid dependency edges, invalid stage/group combinations, and stale ordering versions.
- Include idempotency/concurrency protection for clone and batch operations where duplicate submissions are possible.
- Update OpenAPI and API contract tests as endpoints are implemented.

---

## 8. Frontend Plan

Use the established React SPA, router, API client, state/query cache, metadata forms, component library, theming, and translation approach. Before adding dependencies, check whether an appropriate drag-and-drop or Gantt library is already installed and approved by the project.

### 8.1 Navigation and page structure

- Add Projects to navigation using the existing metadata/configuration mechanism.
- Project list page uses generic list infrastructure and project-specific row/actions only where needed.
- Project create/edit forms use metadata-driven fields and proper board/category selection.
- Project detail provides links/tabs for Overview, Members, Plan, Board, and Gantt (Gantt only if enabled), plus Stream, Activities, and History.
- Add Board, Project Role, and Project Category administration pages through the existing admin/module UI pattern.

### 8.2 Components

Build reusable components consistent with current architecture:

- ProjectHeader and ProjectSummary.
- ProjectMemberTable and MemberRoleEditor.
- ProjectSettingsForm.
- ProjectPlanView with GroupSection and TaskRow/Card.
- ProjectBoardView with StageColumn and TaskCard.
- ProjectGanttView with TaskBar, MilestoneMarker, and DependencyPath.
- TaskEditor and MilestoneEditor.
- SubtaskTree.
- DependencyEditor.
- CloneProjectDialog.
- ProjectTaskDashlet configuration panel.

Avoid a single very large component containing authorization, task transition, date calculations, and drag/drop logic. Domain rules belong on the server and complex pure frontend utilities should be separately testable.

### 8.3 UI interaction rules

- All drag/drop actions must wait for server validation and recover gracefully on failure.
- Keyboard and drag interactions must be accessible by keyboard where practical; provide non-drag alternatives for reordering/moving items.
- Use visible labels for stage/status, priority, group type, assignee, date, and milestone state.
- Show empty states with clear actions for projects with no groups/tasks/members.
- Confirm destructive group/task operations and explain consequences when tasks or descendants are affected.
- Do not depend on frontend filtering as a security mechanism.
- Reuse theme tokens; don't introduce a new theme or global navigation redesign inside Phase 19.

### 8.4 Localization

- Add translation keys for every visible string, status, group type, validation message, action, settings label, and accessibility label.
- Follow the current locale/fallback behavior. Do not copy EspoCRM translation files.

---

## 9. Security and Authorization Matrix

Every read and write must first pass the platform's global permissions. Project role rules then narrow access by membership, task ownership/assignment, and project settings.

| Action | Global ACL required | Project policy requirement |
|---|---|---|
| View project | Project read | The record must be visible under global record ACL and project membership/visibility rules |
| Create project | Project create; Project Board read | Select an accessible board; creator becomes initial owner/member if that is the platform convention |
| Edit project | Project edit | Project Owner/Editor or permitted administrator |
| Manage members | Project/member access | Owner or role with explicit member-management permission |
| Manage groups | Relevant write permission | Owner/Editor or explicit custom capability |
| Create task | Project Task create | Role allows create; task group/stage is valid for the project |
| Read task | Project Task read | Project role read policy plus owner/assignment/collaborator scope |
| Assign task | Project Task edit/assignment permission | Target user must be eligible project member and assignment scope must allow it |
| Edit task fields | Project Task edit | `all`, `assigned`, or `own` policy as configured |
| Move task stage | Stage field/command permission | `Stage Edit` policy; task must be in the selected project/board; validate dependencies/subtasks |
| Delete task | Project Task delete | `all`, `own`, or `no` policy; validate descendants and relations |
| Read/post task Stream | Stream permission | Project task stream scope and collaborator/project settings |
| Read project Stream | Stream permission | Project Stream permission plus global ACL |
| Manage dependency | Project Task edit | Dependencies enabled; both tasks belong to same project; edge is valid and acyclic |
| Clone project | Project create and source Project edit | User can read/clone included content; output cannot inherit inaccessible data |
| View Gantt/Plan/Board projection | Relevant project/task read | Filter every included task/dependency/group by ACL before serialization |

### 9.1 Security-specific tests

Test at least:

- A user who is not a project member cannot access private project details or task projections unless global policy explicitly permits it.
- A Member cannot edit a task belonging to another user when the role only permits own tasks.
- A user cannot assign a task to a non-member or move a task in a project they cannot access.
- A guessed task/group/stage ID from another project cannot be used to move or mutate a record.
- Gantt, dashlet, calendar, clone, Stream, and bulk-operation queries do not leak unauthorized tasks.
- Project Stream access does not accidentally grant task detail access.
- A custom role cannot escalate global ACL.
- Errors do not leak details about inaccessible tasks or dependencies.

---

## 10. Validation, Business Rules, and Failure Modes

Build domain validation as reusable services/pure functions where practical.

- Board is required when creating a project and cannot be changed by a generic update.
- A stage must belong to the board used by the project.
- A group and every task moved into it must belong to the same project.
- An assignee must be eligible under project membership rules.
- Removing the last owner requires ownership transfer in the same transaction.
- Task status must stay consistent with its stage/status mapping.
- A parent with active subtasks cannot be completed.
- Parent/subtask and dependency graphs must not contain cycles.
- Non-blocking dependencies (`type = null`) never prevent state transitions.
- Enforced dependency rules differ by dependency type and must be implemented explicitly.
- Tasks cannot finish before their start dates, and project dates must be internally consistent when both are present.
- Disabled project features cannot be modified through direct API requests.
- Category hierarchy must remain acyclic.
- Stage/group/task reorder commands must reject invalid or unauthorized IDs and handle concurrent changes deterministically.
- Clone must remap internal references and validate all copied fields and optional relationships.
- Deletes must honor the project's relation retention and cascade policy.

Use consistent application errors and actionable client messages. Do not swallow exceptions or let a partially completed multi-record operation report success.

---

## 11. Notifications, Audit, and Observability

Reuse the shared systems implemented in prior phases.

- Audit project/task creation and material updates through the generic audit/history mechanism.
- Publish appropriate Stream updates using the existing Stream service.
- Notify a newly assigned user or added project member only if notification infrastructure and the user's preferences support it.
- Avoid generating an unbounded number of notifications for a bulk reorder or project clone; group or suppress low-value events according to existing conventions.
- Record structured logs for failed transitions, dependency violations, clone failures, and rejected cross-project references.
- Do not log credentials, complete database URLs, full task descriptions, or other sensitive content unnecessarily.
- Background clone work, if used, must be observable, idempotent, and safe to retry.
- Every event/job handler must tolerate duplicate delivery where the established infrastructure provides at-least-once processing.

---

## 12. Testing Strategy

**Follow `AGENTS.MD` exactly. Do not add a test database or automated database provisioning.** Use unit tests for pure rules and the existing configured primary project database for narrow integration/API tests. Use clearly marked `AGENT_TEST_` data, unique run markers, and cleanup only for records created by the current test run.

### 12.1 Unit tests

Cover:

- Board stage → status mapping.
- Each dependency type's start/finish transition requirements.
- Null/non-blocking dependencies.
- Dependency and parent hierarchy cycle detection.
- Subtask completion rules and parent reopening behavior.
- Project role policy evaluation (`all`, `assigned`, `own`, `no`, `yes`).
- Feature-setting validation.
- Date-offset calculations for project cloning and milestones.
- Group/task ordering utilities.
- Category hierarchy cycle detection.

### 12.2 Repository/integration tests

Using the existing configured primary database, narrowly verify:

- Migrations apply additively and preserve existing records.
- Foreign keys, uniqueness constraints, indexes, and transaction behavior.
- Create/update/delete for each core project record.
- Board/stage and project/group/task relationship constraints.
- Atomic stage transition, dependency validation, and audit/event persistence.
- Reorder operations do not duplicate or lose tasks.
- Clone remaps all IDs and dependencies and shifts dates consistently.
- Settings do not destroy data when disabled/enabled.

Do not run destructive setup/teardown, `TRUNCATE`, broad deletes, or database recreation. If an existing test command does that, inspect and replace/disable the destructive setup before executing it.

### 12.3 API tests

Cover authenticated and unauthenticated requests, global ACL denial, project-role denial, valid membership, invalid cross-project IDs, invalid stages/groups, disabled features, malformed dependencies, concurrency conflicts, and expected response envelopes.

### 12.4 Frontend tests

Cover:

- Project create/edit and board selection.
- Member management and role change.
- Plan view task/group reordering, including failed requests and rollback.
- Kanban stage moves with validation errors.
- Gantt drag/resize and dependency interactions.
- Milestone display and editing.
- Clone dialog option handling and successful navigation.
- Dashlet filters and permission-filtered results.
- Keyboard shortcuts not triggering inside text editors/inputs.

### 12.5 End-to-end acceptance scenarios

1. Administrator creates a board with multiple stages, including two stages mapped to Started.
2. Administrator creates project categories and a custom Project Role.
3. Project owner creates a project with a chosen board and adds three users with distinct roles.
4. Owner creates groups of different types and assigns a group as active.
5. Editor creates a task; its creator becomes owner; assignee must be a project member.
6. Member sees permitted tasks, moves an allowed assigned task to another stage, and sees the mapped status update.
7. A task cannot be completed while an active subtask remains.
8. A blocking dependency prevents the invalid transition; a null dependency remains informational only.
9. Plan view and Kanban preserve group/stage order after drag/drop and refresh.
10. Gantt displays task durations, milestones, dependencies, and optional working-time shading.
11. A user without task access cannot retrieve it through Gantt, the dashlet, calendar, or Stream-related APIs.
12. Clone creates a new project, remaps all internal references, applies date offsets, and respects optional-member/attachment choices.
13. Disabling Gantt/dependencies/priority does not erase existing values and direct API writes honor the disabled settings.

---

## 13. Performance and Scalability

- Load project views with bounded pagination and avoid N+1 queries for assignees, owners, stages, groups, and members.
- Provide purpose-built read projections for Plan, Board, and Gantt while still running their data through the platform's ACL policy.
- Never load all projects or tasks into memory when a bounded query can serve the view.
- Batch relation loading and order updates.
- Add indexes based on real query patterns and inspect query plans for larger task lists.
- Put sensible limits on bulk reorder, clone, and dependency operations; make long-running clone work asynchronous only if the existing jobs infrastructure is available and justified.
- Avoid recursive queries that can loop forever; enforce and test cycle protection before relying on recursive traversal.
- Apply caching only where invalidation is well-defined. Do not cache user-specific task projections without incorporating permissions and relevant version keys.
- Gantt performance should be measured with realistic task counts and dependency density before optimizing prematurely.

---

## 14. Migration and Installation

- Add version-controlled migrations following the existing repository migration system.
- Migrations must be additive/backward-compatible where possible and must never reset or recreate the database.
- Register metadata, entity definitions, relations, routes, translation keys, dashboard dashlet, calendar entity integration, and module navigation through the established registry/loading mechanisms.
- Seed the default Project Board/stages and built-in Project Roles exactly once using an idempotent migration/seed mechanism supported by the project. Do not seed them on every app boot.
- If metadata caches exist, use the existing invalidation/reload mechanism after installation/update.
- Provide safe uninstall/disable behavior only if the platform has a supported module lifecycle. Do not drop tables or delete business records during routine disable/uninstall.
- Document upgrade behavior when a board stage, role field, or setting changes between module versions.

### 14.1 Default data

The initial default board should be useful but minimal. Choose stage names and status mappings matching the documented functional reference. Keep stable internal stage keys separate from user-visible names so display names can be changed without breaking task references.

Built-in roles: Owner, Editor, Member. Seed them idempotently and prevent accidental duplicate entries.

Avoid creating demo Projects/Tasks automatically. Only create records that are necessary for system configuration.

---

## 15. Documentation Deliverables

Create or update the following documents according to the repository convention:

- `docs/modules/projects/README.md` — capabilities, setup, navigation, settings, and supported views.
- `docs/modules/projects/data-model.md` — entities, relationships, indexes, invariants, and delete policy.
- `docs/modules/projects/permissions.md` — global ACL plus project-level role semantics and examples.
- `docs/modules/projects/api.md` or generated OpenAPI references — endpoints/commands and representative requests.
- `docs/modules/projects/compatibility.md` — behavior matched to the EspoCRM reference, intentional deviations, and deferred items.
- Admin/operations notes for board-stage changes, default data, and safe upgrades.

Documentation must distinguish implemented features from future/deferred ones. Do not claim exact upstream parity for a behavior that has not been tested.

---

## 16. Implementation Phases and Work Order

Implement the module incrementally. Keep every sub-phase small enough to review. A phase is not complete just because its UI exists; backend invariants, ACL, migrations, tests, and documentation must be complete for its scope.

### Phase 19.0 — Repository audit and feature contract

Tasks:

- Read `AGENTS.MD`, the master `PLAN.md`, and relevant implementations from Phases 0–18.
- Confirm actual module, metadata, route, migration, frontend, event, audit, and test conventions.
- Write a short gap analysis for missing dependencies and identify what must be extended versus reused.
- Freeze the initial Project fields, task statuses, stage mapping, group types, project-role permission meanings, and delete/clone policies.

Acceptance:

- No duplicate kernel subsystem is proposed.
- API/module boundaries, migrations, data invariants, and compatibility baseline are recorded.

### Phase 19.1 — Module registration and metadata

Tasks:

- Register the Projects module using the established module/extension mechanism.
- Register entity metadata for Project, ProjectCategory, ProjectBoard, ProjectRole, ProjectGroup, ProjectTask, and dependency/member entities as appropriate.
- Add field types, relations, default layouts, list layouts, search/filter definitions, validation declarations, ACL scope definitions, nav item, and translations.
- Ensure Entity Manager and metadata APIs recognize the new entities where applicable.

Acceptance:

- Metadata loads and validates.
- The module appears in the right navigation/admin locations for authorized users.
- No hand-coded CRUD duplication bypasses the generic entity system.

### Phase 19.2 — Persistence and default configuration

Tasks:

- Implement versioned migrations and repository/query methods.
- Add constraints/indexes based on Section 5.
- Add idempotent default board/stages and built-in roles.
- Verify migration application against the configured primary database, after reviewing SQL and preserving current data.

Acceptance:

- Fresh install and upgrade paths succeed without database recreation.
- Existing records outside Projects remain intact.
- Re-running the default configuration mechanism does not duplicate rows.

### Phase 19.3 — Projects CRUD and categories

Tasks:

- Implement project list/detail/create/update and required board selection.
- Enforce immutable board after project creation.
- Implement category tree CRUD and cycle/permission validation.
- Implement project date validations, owner selection, project settings persistence, and generic activity/history relations.

Acceptance:

- Standard list/detail/form behavior works.
- Board/category/date constraints are enforced by the API.

### Phase 19.4 — Boards and stage mapping

Tasks:

- Implement board/stage administration.
- Implement status mapping and default board selection.
- Prevent invalid stage deletion/remapping when tasks depend on it.
- Implement task stage validation and derived status update service interfaces needed by later phases.

Acceptance:

- Multiple stages can map to the same status.
- A task cannot reference a stage from another board.
- Stage change updates status atomically.

### Phase 19.5 — Project roles and membership

Tasks:

- Implement project member CRUD and role assignment.
- Implement Owner/Editor/Member default roles and custom role policies.
- Integrate with global ACL without escalation.
- Enforce last-owner, assignee eligibility, project visibility, and member removal behavior.
- Add member management UI and optional bulk membership operations if the generic list supports them.

Acceptance:

- Role checks work in services and API tests, not only in React.
- A non-member cannot gain access by guessing IDs.

### Phase 19.6 — Groups and base task CRUD

Tasks:

- Implement project groups, types, colors, ordering, and new-task placement.
- Implement ProjectTask basic fields, ownership/assignment, dates, priority, points, hours, status mapping, and generic filters.
- Implement safe task ordering and group movement commands.
- Enforce feature toggles on the backend.

Acceptance:

- Tasks cannot cross project boundaries through forged group/stage IDs.
- Group/task order is stable after refresh and under rejected concurrent updates.

### Phase 19.7 — Task transition engine, subtasks, milestones

Tasks:

- Implement complete/cancel/start/move command semantics.
- Implement subtask parent links, hierarchy validation, and completion guard.
- Implement milestone type and single-date display/storage behavior.
- Ensure audit, event, status, stage, and ordering updates are consistent.

Acceptance:

- Invalid parent/subtask and transition combinations are rejected predictably.
- Milestones display as points, not duration tasks.

### Phase 19.8 — Dependencies

Tasks:

- Implement dependency storage, CRUD, types, validation, and cycle prevention.
- Implement type-specific start/finish transition guards.
- Respect per-project dependency settings.
- Implement dependency serialization for authorized Gantt/read projections.

Acceptance:

- All four dependency types behave according to documented semantics.
- Null dependency type is non-blocking.
- No operation can create a self-edge or cycle.

### Phase 19.9 — Standard UI, Stream, Attachments, Activities

Tasks:

- Add project/task forms and detail pages using existing metadata-driven components.
- Add Members and Settings panels.
- Integrate Project and ProjectTask with shared Stream and Attachments.
- Add related Activities and History using existing platform panels.
- Add notifications/events only where shared infrastructure already supports them.

Acceptance:

- No separate Stream, attachment store, or audit system is introduced.
- Stream and related-record views preserve all authorization boundaries.

### Phase 19.10 — Plan view

Tasks:

- Implement ordered groups, tasks, subtasks, and group menus.
- Implement task/group create/edit/remove and drag/drop movement/reordering.
- Implement milestone creation in a group.
- Add keyboard alternatives for drag/drop and optional shortcuts with focus checks.

Acceptance:

- Moves persist server-side and roll back visually on rejection.
- UI ordering matches the database after reload.

### Phase 19.11 — Kanban Board view

Tasks:

- Implement board columns from Project Board stages and group switching.
- Implement stage drag/drop and within-column ordering.
- Show derived status and relevant ownership/priority/date summaries.
- Enforce stage edit role, dependency/subtask constraints, and concurrency responses.

Acceptance:

- The UI cannot bypass server-side status or permission rules.

### Phase 19.12 — Gantt view

Tasks:

- Implement timeline calculations and rendering for task durations and milestones.
- Draw dependency paths and allow dependency editing.
- Implement drag-to-move, resize, and date updates through domain commands.
- Filter default group types correctly and honor the per-project Gantt setting.
- Integrate the existing working-time calendar only if one is already available.

Acceptance:

- Dates, milestones, dependency lines, and task order remain consistent after refresh.
- Invalid date/dependency moves are rejected and produce understandable UI feedback.

### Phase 19.13 — Calendar and Project Task dashlet

Tasks:

- Register Project Tasks with the existing read-only Calendar integration.
- Implement the Project Task dashlet and configuration options.
- Verify permission filtering for calendar and dashlet query results.

Acceptance:

- The dashlet supports multiple option configurations.
- Calendar and dashboards do not reveal tasks hidden from the current user.

### Phase 19.14 — Project cloning and bulk actions

Tasks:

- Implement project cloning with selected members, task owners, assignees, and attachment options.
- Apply project-start date offset to task/milestone dates.
- Remap groups, tasks, parent IDs, dependencies, and internal references.
- Implement supported bulk member actions and keyboard shortcuts.
- Add idempotency/retry handling if the operation uses jobs.

Acceptance:

- A clone contains no references pointing to the source project where they should point to cloned rows.
- Clone options are respected and no unauthorized source content is copied.

### Phase 19.15 — Hardening, compatibility, and release readiness

Tasks:

- Finish unit, integration, API, frontend, security, and end-to-end tests.
- Run lint/type-check/build and existing project checks.
- Evaluate performance with representative project/task counts using safe, non-destructive data.
- Verify translations, OpenAPI, migration upgrade behavior, ACL, audit, logging, and disabled-feature enforcement.
- Complete documentation and compatibility matrix.
- Review git diff for accidental changes, secrets, copied upstream assets/code, and unsafe SQL.

Acceptance:

- All P0/P1 behaviors in Section 17 are implemented and tested.
- Any deferred functionality or known deviation is listed explicitly.
- No database test sprawl or destructive test setup was introduced.

---

## 17. Priorities and Release Gates

### P0 — Required for the first usable Projects release

- Projects CRUD with board selection and board immutability.
- Default Project Board and stage/status mapping.
- Project categories and global ACL integration.
- Project members and project-specific roles.
- Groups and Project Task CRUD.
- Task owner/assignee and project membership validation.
- Stage/status transition logic.
- Plan view and basic Kanban view.
- Subtask validation and milestones.
- Project/task Stream and attachment integration through the kernel.
- Server-side authorization for every Project API/projection.
- Versioned migrations and tests following `AGENTS.MD`.

### P1 — Required for functional parity and day-to-day project use

- Full project-role policy dimensions.
- Task dependencies with all four types and cycle prevention.
- Gantt view with dependencies and milestones.
- Project settings for dependencies, collaborators, priority, points, hours, and Gantt.
- Read-only Calendar integration.
- Project Task dashlet.
- Project cloning with optional content and date shifting.
- Bulk membership changes and keyboard shortcuts, where the existing UI framework supports them safely.

### P2 — Post-first-release enhancements

Only implement after P0/P1 are stable and the current codebase's conventions are clear:

- Advanced resource/capacity planning.
- Time tracking/timesheets and budgets.
- Cross-project dependencies.
- Advanced critical-path and schedule optimization.
- Project templates library beyond cloning an existing project.
- External project-management integrations.
- Offline edits and conflict resolution.
- Public/customer project portals beyond the separate Portal module's existing scope.

---

## 18. Definition of Done

Phase 19 is complete when all applicable checks below pass:

- [ ] Projects module is registered through the established module system.
- [ ] Project and related entity metadata are valid and discoverable.
- [ ] Migrations are reviewed, versioned, and safe for existing data.
- [ ] Default board/stages and built-in roles are seeded idempotently.
- [ ] Projects, categories, boards, stages, members, roles, groups, tasks, subtasks, milestones, and dependencies work through the supported API.
- [ ] Plan and Kanban views work for permitted users.
- [ ] Gantt view works when enabled and is hidden/blocked when disabled.
- [ ] Board stage mapping is the single source of truth for task status.
- [ ] Dependencies and subtasks are validated server-side.
- [ ] Project roles narrow permissions and never override global ACL.
- [ ] Project/task Stream, attachments, activities, audit/history, Calendar, and dashlet reuse shared kernel services.
- [ ] Project clone remaps all internal identifiers and safely applies date offsets.
- [ ] All API read projections are authorization-filtered.
- [ ] Tests cover happy paths, invalid input, cross-project ID attacks, permission denial, and race/concurrency scenarios.
- [ ] Lint, type checks, builds, and relevant tests have been run; skipped checks are documented honestly.
- [ ] Documentation and compatibility deviations are updated.
- [ ] No extra database was created; no database reset/truncate/broad cleanup was performed.
- [ ] No upstream PHP source or unlicensed frontend assets were copied.

---

## 19. Suggested First Coding-Agent Task

Start with **Phase 19.0 only**, then implement Phases 19.1–19.2 after reviewing the repository. Do not attempt to build the entire module in one code-generation pass.

The initial agent must:

1. Inspect the actual codebase and report the relevant existing abstractions and concrete file paths.
2. Identify any missing prerequisites in Phases 0–18 without implementing unrelated refactors.
3. Propose the precise Project entity/relationship metadata and migration changes for review in its own execution plan.
4. Confirm the existing configured primary database target and inspect migration/test scripts without exposing credentials; do not create another database.
5. Deliver an implementation sequence with the smallest first migration and a verification plan.

After the audit, continue in the phase order in Section 16. A sub-phase should be considered complete only after its acceptance criteria and applicable Definition of Done items are verified.

---

## 20. Official References

1. EspoCRM Project Management — Projects, boards, roles, tasks, dependencies, groups, views, clone, dashlet, and keyboard shortcuts: https://docs.espocrm.com/extensions/project-management/projects/
2. EspoCRM Developer Documentation — overall module and platform concepts: https://docs.espocrm.com/development/
3. EspoCRM Metadata: https://docs.espocrm.com/development/metadata/
4. EspoCRM ACL: https://docs.espocrm.com/development/acl/
5. EspoCRM Hooks: https://docs.espocrm.com/development/hooks/
6. EspoCRM Attachments: https://docs.espocrm.com/development/attachments/
7. EspoCRM Activities and Calendar: https://docs.espocrm.com/user-guide/activities-and-calendar/

The official Project Management documentation is the functional reference. The repository's `PLAN.md`, `AGENTS.MD`, implemented kernel behavior, and explicit compatibility baseline determine how those behaviors should be realized in this NestJS codebase.
