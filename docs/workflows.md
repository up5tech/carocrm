# Workflow engine (Phase 15 — PLAN §35)

A workflow reacts to an entity event and runs a small graph of conditions and actions. It is
authored entirely in the admin UI, executed by the worker, and every run is recorded.

```text
entity write → outbox event (PLAN §23.2) → matching enabled workflows
  → workflow.run job (§24: retry, backoff, cancellable, visible in /admin/jobs)
  → the engine walks the graph, one node per recorded step
  → delay node → workflow.resume job scheduled for later
  → run + steps become the run history
```

## 1. The definition

```jsonc
{
  "trigger": { "eventType": "entity.created", "entityType": "Account" },  // entityType may be "*"
  "start": "c1",
  "nodes": [
    { "id": "c1", "type": "condition", "name": "Big deal?", "formula": "number(field(\"amount\")) > 10000", "then": "a1", "otherwise": "e" },
    { "id": "a1", "type": "action", "name": "Notify owner", "action": "createNotification", "params": { "userId": "{{assignedUserId}}", "message": "New {{name}}" }, "next": "e" },
    { "id": "d1", "type": "delay", "name": "Wait a day", "seconds": 86400, "next": "a2" },
    { "id": "e",  "type": "end",   "name": "Done" }
  ]
}
```

Node types are `action`, `condition`, `delay` and `end`. There is deliberately **no loop
construct**: the graph must be acyclic, which is checked on every save.

Actions and their parameters:

| Action | Parameters | What it does |
|---|---|---|
| `updateRecord` | `fields` | writes attributes onto the triggering record; `assignedUserId` maps to the ownership column |
| `createRecord` | `entityType`, `fields` | creates a record of any metadata entity |
| `createNotification` | `userId`, `message`, `data?` | in-app notification |
| `sendEmail` | `to`, `subject`, `body`, `cc?`, `bcc?` | creates an Email record and queues `system.sendEmail` |
| `runJob` | `jobName`, `data?` | queues any registered job — how extensions and integrations plug in |

Parameter values may contain `{{field}}` placeholders, resolved against the triggering record
(`{{name}}`, `{{emailAddress}}`, `{{assignedUserId}}`, …). A value that is *exactly* one placeholder
keeps its type; placeholders inside a longer string are interpolated into it.

Conditions are **sandboxed formulas** from PLAN §22 — the same engine that computes formula fields.
`now()` is the run time, `field('x')` reads the record, and no other code can run.

## 2. Versioning (PLAN §35: "never mutate a published workflow in place")

```text
create ──▶ draft v1 ──publish──▶ published v1 (immutable)
                      │                        ▲
                      └──── edit ──▶ draft v2 ─┘ publish
```

- Every save writes the **draft**. Editing a published workflow creates the next version; the
  published one stays byte-for-byte what a run started against.
- Publishing re-validates the stored definition (a hand-edited row, or a build that no longer
  implements an action, is refused here) and freezes the version.
- Enabling is a separate act: publishing says "this definition is correct", enabling says "run it".
  Enabling an unpublished workflow is refused.
- `workflows.current_version_id` is what the editor opens; `published_version_id` is what runs use.

## 3. Execution, retry and history

- Runs execute in the **worker**, never in a request: the trigger only enqueues a `workflow.run`
  job, so automation cannot slow down an API call (PLAN §7.4, §5.5).
- **Retries are safe because the step ledger is the idempotency record.** Before a node runs, the
  engine checks whether that node already completed *in this run*; if it did, the stored output is
  reused instead of acting again. A redelivered message therefore resumes rather than repeats — a
  notification is not sent twice.
- One run row per (workflow, version, record) while it is running or waiting, so a redelivered start
  continues the same run instead of starting a second automation.
- A **delay** parks the run (`status = 'waiting'`) and enqueues `workflow.resume`, which survives a
  worker restart because it is ordinary queued work.
- A failing action marks its step `failed`, closes the run with the node name in `error`, and
  rethrows so BullMQ retries with backoff. The final state after the last attempt stays `failed`.
- `system.cleanupWorkflowRuns` (daily in the seed) prunes finished runs older than 30 days.

Statuses: run `running | waiting | completed | failed | cancelled`; step
`running | completed | failed | skipped`.

## 4. API (admin-only)

| Endpoint | Purpose |
|---|---|
| `GET /api/v1/Workflow` | list with version state, enable state and validation issues |
| `GET /api/v1/Workflow/action/catalog` | trigger events + action catalog (the editor builds from this) |
| `POST /api/v1/Workflow/action/validate` | validate a definition without saving it |
| `POST /api/v1/Workflow` | create with a first draft |
| `PUT /api/v1/Workflow/:id` | save the draft (forks a version when published) |
| `POST /api/v1/Workflow/:id/action/publish` | freeze the draft as the runnable version |
| `POST /api/v1/Workflow/:id/action/enable\|disable` | start/stop triggering |
| `DELETE /api/v1/Workflow/:id` | soft delete |
| `GET /api/v1/Workflow/:id/runs` | run history for one workflow |
| `GET /api/v1/WorkflowRun[/:id]` | run history across workflows, with steps |

Everything is administrator-only: a workflow acts with system authority once enabled, so the whole
surface is behind `isAdmin` like the Entity Manager.

## 5. What an automation may and may not do

Workflow actions run in the worker with **system authority**, not as the user who triggered them —
that is what makes automation useful, and it is why authoring is admin-only. Each action is a narrow
statement against data the platform already owns:

- record writes go through the same `entity_records` table the entity engine uses, and refuse to
  write bookkeeping columns (`id`, `createdAt`, `modifiedById`, `teams`, …);
- notifications go through the same table the stream writes;
- email reuses the §28 send path, so it gets the same transport, ledger and retry behaviour;
- `runJob` can only queue a job name the worker has registered — metadata never carries code.

A workflow cannot run SQL, call a URL or evaluate code. The catalog in `packages/workflow` is the
complete list of what automation can do.

## 6. Layout

| Piece | Where |
|---|---|
| Definition types, validation, matching, executor | `packages/workflow` (pure: no DB, queue or network) |
| Admin API and versioning | `apps/api/src/workflows/` |
| Execution, actions, persistence | `apps/worker/src/workflows/` |
| Editor and run history | `apps/web/src/pages/WorkflowsPage.tsx`, `WorkflowEditorPage.tsx` |
| Tables | `database/migrations/011_phase15_workflows.sql` |

**Deviation from PLAN §35's table list:** nodes and edges live inside
`workflow_versions.definition` (JSONB) instead of separate `workflow_nodes`/`workflow_edges` tables.
One row per version makes a version an atomic snapshot — exactly the property the versioning rule
needs — with no window in which a version's nodes and edges disagree.

## 7. Tests

| Suite | Covers |
|---|---|
| `packages/workflow/src/validation/index.test.ts` | shape, edges, cycles, unreachable nodes, unknown actions, formula sandboxing, delay bounds |
| `packages/workflow/src/execute/index.test.ts` | ordering, branching, delays, resume, idempotent retries, failure propagation, cancellation, re-validation of stored definitions |
| `packages/workflow/src/match`, `interpolate` | trigger matching rules and `{{field}}` resolution |
| `apps/worker/src/workflows/workflow-handlers.test.ts` | trigger subscription, job payloads, run reuse, resume, failure, retention |
| `apps/worker/src/workflows/workflow-actions.test.ts` | what each action writes, ownership mapping, reserved fields |
| `apps/api/test/workflows.test.ts` | create/validate/publish/enable, version forking, hand-edited definitions, ACL, run history |
| `scripts/e2e-smoke.sh` | the authoring lifecycle over HTTP |