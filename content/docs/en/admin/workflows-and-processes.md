---
title: Workflows and processes
summary: The workflow and process builders, the five actions automation can perform, and the limits a definition cannot cross.
audience: admin
order: 100
tags: [workflows, processes, automation, approvals, runs]
related: [admin/settings-overview, admin/entities-and-fields, admin/extensions, user/activities-and-tasks, user/record-page]
updated: 2026-10-21
---

Open [Workflows](/admin/workflows) for event-driven automation and [Processes](/admin/processes) for a
flow with human steps in it. Both screens are administrator-only, both store a **draft version** and an
immutable **published version**, and both refuse to publish a definition that fails validation. The
versioning rule is the same on purpose: a run that started against version 3 still finds exactly
version 3 while somebody edits version 4.

## Workflows

A workflow is a trigger plus a list of steps. On the editor you set the name, the event and the entity,
then add steps after any node, move them, or remove them; removing one relinks the chain so no step
points at a node that no longer exists.

| Part | What it can be |
| --- | --- |
| Event | `entity.created`, `entity.updated`, `entity.deleted`, `entity.restored` |
| Entity | one entity type, or `*` for every record type |
| Action step | one of the five actions below, with its parameters |
| Condition step | a formula, plus a `then` target and an optional `otherwise` |
| Delay step | a wait in seconds, up to 31 536 000 (a year) |
| End step | stops the run |

Parameters are single-line text fields, one per known parameter of the chosen action. Any value may
contain `{{field}}` placeholders, resolved against the triggering record when the run executes — the
record's attributes plus its id, type, owner, creator and the user whose action started the run.

**Publish** is disabled while the draft is unsaved or has problems; the problems are listed with the path
that caused them. **Enable** is a separate switch: a workflow only starts a run when it is both enabled and
published, because a trigger match reads the published version.

## The five actions

That is the complete catalog, offered by name in the builder and implemented in the worker:

| Action | What it does |
| --- | --- |
| `updateRecord` | Writes the given fields onto the record that started the workflow |
| `createRecord` | Creates a record of the entity type you name |
| `createNotification` | Writes an in-app notification for one user, up to 2000 characters |
| `sendEmail` | Creates an Email record and queues it through the standard send job |
| `runJob` | Queues any registered background job by name |

## What a rule cannot do

- It cannot run code, call a URL of your choosing, or write SQL. A definition can only name something the
  platform already implements, so a capability appears only when a release adds it.
- It cannot loop, and there is no hidden branch: every next step is an explicit node id.
- It cannot rewrite bookkeeping. `id`, `createdAt`, `modifiedAt`, `createdById`, `modifiedById`,
  `deletedAt` and `teams` are refused; `assignedUserId` is honoured, but written to the real ownership
  column rather than into the attributes.
- It cannot use an unknown parameter key — strict validation rejects it, so a typo fails loudly at save
  time instead of silently doing nothing.
- It does not run as the person who triggered it. Actions run with **system authority** in the worker, so
  an automation can reach records its trigger could not. This is why these screens are administrator-only.

> [!WARNING]
> A workflow fires on the event, not on the reason for it. An `updateRecord` step that writes a field on
> the same entity type can trigger another workflow, including itself. Keep the entity narrow, keep the
> condition specific, and check the run history after the first publish.

## Runs

Execution happens in the worker: an entity event that matches an enabled, published workflow queues
`workflow.run`, and a delay becomes a scheduled `workflow.resume`, which is what lets a waiting run
survive a worker restart. Each run records a step per node with its status, attempt count, output and
error, and a run ends as `running`, `waiting`, `completed`, `failed` or `cancelled`.

The editor lists recent runs under the definition, expandable to the steps; run history is also readable
across all workflows. Failed runs are retried by the queue's own attempt policy (three attempts by
default). Finished runs older than 30 days are pruned by `system.cleanupWorkflowRuns`. If nothing
happens when you change a record, check that the worker is running and that the queue name matches the
API's — see [jobs](/admin/jobs).

## Processes

A process is the same versioning model with human decisions in it, and a stable lowercase `key`
(2 to 64 characters) that instances are started by. Its node types are:

| Node | Purpose |
| --- | --- |
| `userTask` | Waits for a person; each answer (an outcome with a label) chooses the next node |
| `serviceTask` | Runs one of the five platform actions with no person in the loop |
| `gateway` | The first branch whose formula holds wins, otherwise the default target |
| `end` | Stops the instance and reports an outcome label |

A task's responsible party is resolved when the task is created: one user, every member of a role, or a
field on the record. A task can be marked overdue after a number of seconds and escalated after another,
optionally reassigned to someone else. A failing service task either fails the instance (the default) or
continues, per node.

The page has two tabs. **Definitions** lists each process with its draft and published versions, any
problems, and the enable switch. **Instances** shows what is running, its open, overdue or escalated
tasks, and the event trail; you can cancel an instance here, and only the person who started it (or an
administrator) may do so. People answer their own tasks from the [Tasks](/tasks) screen.

> [!NOTE]
> Nothing in the interface starts an instance today. Starting is an API call
> (`POST /api/v1/ProcessInstance`) naming the process by id or key plus the record it attaches to, so the
> first instance of a process comes from that call — from an integration, a script, or you.

## Where to go next

- [Extensions](admin/extensions) — adding a job an automation can queue.
- [Email accounts and notifications](admin/email-and-notifications) — what `sendEmail` depends on.
- [Entities, fields and layouts](admin/entities-and-fields) — the field names a step can write.
