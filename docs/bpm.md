# BPM engine (Phase 16 — PLAN §36)

A process is a multi-step approval: it parks on a **user task**, waits for a person, then runs
service steps and branches on conditions until it ends. Where a workflow (PLAN §35) reacts to an
event, a process is *started on a record* and then waits for humans — that waiting is the whole
difference, and it shapes everything below.

```text
POST /ProcessInstance (anyone who can read the record)
  → the engine advances until it parks on a user task (or ends)
  → the task row is created, its assignee notified, its due timer armed
  → the answer arrives at POST /ProcessTask/:id/action/complete
  → the state machine advances again: service tasks dispatch to the worker,
    gateways branch on formulas, an end node completes the instance
  → every step is recorded in process_events — the audit trail
```

## 1. The definition

```jsonc
{
  "entityType": "Account",            // or "*" for any record type
  "start": "review",
  "nodes": [
    {
      "id": "review", "type": "userTask", "name": "Manager review",
      "assignee": { "type": "role", "value": "Sales Manager" },
      "dueSeconds": 86400,                       // arms a timer that marks the task overdue
      "escalateAfterSeconds": 172800,            // second timer: reassign + mark escalated
      "escalateTo": { "type": "user", "value": "u-ids..." },
      "outcomes": [
        { "value": "approved", "label": "Approve", "next": "gate" },
        { "value": "changes",  "label": "Request changes", "next": "review" },  // loops are legal
        { "value": "rejected", "label": "Reject", "next": "stop" }
      ]
    },
    { "id": "gate", "type": "gateway", "name": "High value?",
      "branches": [{ "when": "field('amount') > 10000", "next": "audit" }],
      "default": "notify" },
    { "id": "audit",  "type": "serviceTask", "name": "Flag for audit",
      "action": "updateRecord", "params": { "fields": { "industry": "Audited" } },
      "next": "notify", "onError": "continue" },
    { "id": "notify", "type": "serviceTask", "name": "Notify finance",
      "action": "createNotification", "params": { "userId": "{{assignedUserId}}", "message": "Approved" },
      "next": "done" },
    { "id": "done", "type": "end", "name": "Approved", "outcome": "approved" },
    { "id": "stop", "type": "end", "name": "Rejected", "outcome": "rejected" }
  ]
}
```

Node types are `userTask`, `serviceTask`, `gateway` and `end`.

**Assignees** name *who* holds the task:

| Kind | Value | Resolution time |
|---|---|---|
| `user` | user id | at task creation: the user must exist and be active |
| `role` | role **name** | at task creation: any member of the role may answer (candidate group) |
| `recordField` | field name, e.g. `assignedUserId` | at task creation, read from the record |

An assignee that cannot be resolved is not a crash: the instance **fails** with the reason in
`error` and an `instance.failed` event — a broken process on one record is data, visible in the
list, not a 500 the starter cannot understand.

**Gateways** are exclusive: the first branch whose sandboxed formula (PLAN §22, same engine as
formula fields) evaluates true wins; otherwise the required `default` target is taken. The chosen
path is recorded as a `branch.selected` event with the matched condition.

**Service tasks** are the same action catalog workflows use (`updateRecord`, `createRecord`,
`createNotification`, `sendEmail`, `runJob` — see `docs/workflows.md` §1) with the same `{{field}}`
placeholders. They are **dispatched to the worker, never awaited in the request**, and their
results deliberately do *not* feed gateway conditions: the state machine advances on human answers,
not on background side effects. `onError: "continue"` records the failure and keeps going; the
default stops the instance with the error visible.

## 2. Loops, and what keeps them safe

Unlike workflows, process graphs **may loop** — "request changes, back to review" is the canonical
approval pattern. A loop with nothing to wait for inside it would spin the CPU dry, so validation
(Tarjan) refuses any cycle that contains no `userTask`: `PROCESS_HOT_LOOP`. Every save is also
checked for unknown actions, dangling or empty targets (`PROCESS_DEAD_END`, `PROCESS_INVALID`),
unreachable steps, timers out of range, and malformed assignees/outcomes.

## 3. Versioning — the workflow rule, reused

Draft is editable, published is immutable, `is_active` gates only *starting new instances*.
Publishing re-validates and archives the previous published version in one transaction; editing a
published definition forks a new draft exactly as workflows do. A running instance keeps the
definition of the version it started on — republishing never rewrites history.

## 4. Execution: who moves the token

The **API owns the state machine**; the worker only runs dispatched work and fires timers.

- `start` / `completeTask` / `cancel` lock the instance row (`FOR UPDATE`) inside a transaction,
  so two people answering the same task — or two tasks of one instance — cannot both advance it.
- The advance loop runs in-process until it parks on a `userTask` (task row + notification + due
  timer) or reaches an `end` (completion) or a service task (dispatch + continue).
- The worker's `bpm.serviceTask` job runs one action with system authority and records the result
  as an event; it **never** moves `current_node`. `bpm.taskTimer` fires due/escalation timers with
  status-guarded, idempotent SQL: a redelivered timer or an already-answered task is a no-op, not
  a double escalation.
- Escalation **re-resolves** the escalation target against live data (the record's owner may have
  changed since task creation), reassigns the task, marks it `escalated` and stamps `escalated_at`.
- `cancel` (initiator or admin) cancels open tasks with the instance and records the trail.

Statuses: instance `running | waiting | completed | cancelled | failed`; task
`open | overdue | escalated | completed | cancelled` (the first three are *answerable*).

## 5. API surface

| Endpoint | Access | Purpose |
|---|---|---|
| `GET /api/v1/Process` | admin | definitions with version state, enable state and issues |
| `GET /api/v1/Process/action/catalog` | admin | action catalog + node/assignee kinds for the editor |
| `POST /api/v1/Process/action/validate` | admin | validate without saving |
| `POST /api/v1/Process` · `PUT /:id` | admin | create / save draft (strictly validated) |
| `POST /api/v1/Process/:id/action/publish` | admin | freeze the version (once) |
| `POST /api/v1/Process/:id/action/enable\|disable` | admin | gate starting new instances |
| `DELETE /api/v1/Process/:id` | admin | soft delete; instances keep their history |
| `POST /api/v1/ProcessInstance` | any reader of the record | start by `processId` or `processKey` |
| `GET /api/v1/ProcessInstance[/:id]` | scoped | list/detail — full views including tasks + events |
| `POST /api/v1/ProcessInstance/:id/action/cancel` | initiator or admin | stop and cancel open tasks |
| `GET /api/v1/ProcessTask` | per person | my tasks (assignee or role candidate); `all=true` is admin-only |
| `GET /api/v1/ProcessTask/:id` | assignee/candidate | one task |
| `POST /api/v1/ProcessTask/:id/action/complete` | assignee/candidate | answer with an offered `outcome` (+ optional `comment`) |

Definitions are admin-only because a process runs actions with system authority. Everything else is
deliberately participant-facing: the person approving a discount needs no admin rights and sees
nothing they are not part of. A record you may not read is *missing* (404), as everywhere else.

## 6. Layout

| Piece | Where |
|---|---|
| Pure engine: types, validation, advance | `packages/bpm` (no DB, queue or network) |
| Definitions, versioning, catalog | `apps/api/src/processes/process.service.ts` |
| State machine, tasks, timers, ACL scoping | `apps/api/src/processes/process-runtime.service.ts` |
| Worker: service tasks, due/escalation timers | `apps/worker/src/bpm/` |
| Admin page, editor, my-tasks page | `apps/web/src/pages/ProcessesPage.tsx`, `ProcessEditorPage.tsx`, `TasksPage.tsx` |
| Tables | `database/migrations/012_phase16_bpm.sql` |

**Deviation from PLAN §36's table list:** definition nodes live inside
`process_definition_versions.definition` (JSONB) instead of separate node/edge tables — the same
reason as workflows: a version must be an atomic snapshot, with no window in which its nodes and
edges disagree.

## 7. Known limitations (Phase 16 alpha)

- **One token per instance**: no parallel fork/join; only the exclusive gateway (first matching
  branch, else the required default).
- **No timer *nodes***: timers exist only on user tasks (due + escalation). "Wait three days, then
  continue" as a flow step is not yet supported.
- **Service results never feed conditions** (by design — see §1).
- **Role tasks are not individually notified**: every member sees the task on their tasks page, but
  only a concrete assignee gets a notification at creation time.
- **No definition triggers**: a process starts via `POST /api/v1/ProcessInstance`; there is no
  "start on event" wiring from workflow triggers to processes yet (a workflow's `runJob` action can
  queue any registered job, but no `startProcess` job is registered in Phase 16).

## 8. Tests

| Suite | Covers |
|---|---|
| `packages/bpm/src/validation/index.test.ts` | shape, hot loops (Tarjan), dead ends, unreachable nodes, unknown actions, timers, assignees |
| `packages/bpm/src/advance/index.test.ts` | ordering, exclusive gateways, loops through waits, dispatch, completion, cancellation |
| `apps/api/test/processes.test.ts` | the full acceptance path: author → publish → enable → start → answer (incl. loop + gateway + role/record assignees) → audit trail; failure, scoping, cancellation, version stability |
| `apps/worker/src/bpm/bpm-handlers.test.ts` | service-task execution and reporting, due/escalate timers, idempotent redelivery, escalation re-resolution, already-answered no-ops |
