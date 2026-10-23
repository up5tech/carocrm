---
title: Audit log, jobs and operations
summary: What the record audit trail stores, how the job queue works, and how to triage a job that failed.
audience: admin
order: 150
tags: [audit, jobs, cron, queue, troubleshooting]
aliases: ["nhật ký hệ thống", "việc chạy nền", "giám sát tiến trình", "dấu kiểm"]
related: [admin/settings-overview, admin/integrations, admin/users-teams-roles]
updated: 2026-10-21
---

Three surfaces answer "what happened here": the [audit log](/admin/audit-log) for record changes,
[jobs](/admin/jobs) for background work, and the [internal](/admin/settings/internal) tab for configuration
operations and instance facts.

## The audit log

A row is written inside the same transaction as the change it describes, so a saved record and its audit rows
cannot disagree. Three actions exist: `create`, `update`, `delete`.

| Action | What the row carries |
| --- | --- |
| create | One row naming the fields written |
| update | One row **per changed field**, with the old value and the new value |
| delete | One row marked deleted, with no field detail |

Every row also carries the entity type, the record id, the acting username and user id, an order number, an
archived flag and a timestamp.

Which fields get audited is decided per field: a field is recorded when its definition says it is audited, and
when the entity is unknown to that lookup every changed field is recorded instead. The assignment field
`assignedUserId` is always audited. A field whose name contains password, secret, token or api key is stored as
`[REDACTED]` — the change is visible, the value is not.

Access: an administrator browses the whole log; anyone else must filter by a single record and only sees that
record's history. Reading one entry by its id is administrator-only. The screen is a paged, newest-first table
with when, entity, record, action, field, old value, new value and who — the record column links to the record.
The screen has no filter controls; the endpoint accepts entity type, entity id, action, username and a date range,
and caps a page at 200 rows.

> [!NOTE]
> A **settings** change is not in this table. Publishing a settings document, an entity-manager change or an
> internal operation writes to a separate configuration history that names the document, the keys that changed,
> the versions and the actor — never the values. This build writes that history but has no screen for it.

## Jobs

Every job is a row in Postgres; Redis only carries the queue. The row is the record you read here, and a queue
that is temporarily unreachable is an error on enqueue, not a lost row.

A job name is `<module>.<action>` — two to four dot-separated segments, such as `system.cleanupOutbox`,
`reports.deliver`, `advancedIntegrations.processWebhookEvent` or `webhook.deliver`. A job payload is capped at
32,000 characters, so a job carries a pointer to work, not the work itself.

| Field | Meaning |
| --- | --- |
| status | `pending`, `running`, `completed`, `failed`, `cancelled` |
| attempt / max attempts | How far through the retry plan the job is |
| progress | 0 to 100, as the job reported it |
| message, last error | What the job said, and why it stopped |
| scheduling type | `cron` when the run came from a schedule |
| result | What the job returned |

Retries are exponential with backoff. Three attempts is the default, and the attempt count and the backoff base
are server configuration rather than a setting on any screen. Queue retention drops a completed job after 10
minutes or 50 completed entries, and keeps a failed one for 7 days — the Postgres row outlasts all of that.

Cancelling is cooperative and depends on the state: a waiting job is removed from the queue and marked cancelled;
a running job is flagged and stops at the next checkpoint that checks for it; a finished job is left alone.

### Schedules

The schedules table is the cron plan: an id, a job name, a five-field cron expression, a JSON payload and an
enabled switch. The screen validates the expression by asking the server to preview it. **Run now** starts the
same job immediately, outside the cron boundary, and stamps the schedule's last run. A report schedule is created
disabled, and enabling the report schedule is what enables its job — if that step fails, the schedule goes back to
disabled rather than reporting a delivery that will never run.

## Triaging a failed job

1. Open the job list, filter by status `failed`, and read the message column: it falls back to the last error when
   there is no message.
2. Open the log. Lines are ordered and capped at the first 500, which is the job's own narration of the run.
3. Check the attempt count. A job still below its maximum has not finished failing; BullMQ is between attempts.
4. Check the queue counts on the internal tab. `waiting` growing while nothing moves means the worker is not
   consuming; counts that cannot be read at all mean Redis is unreachable.
5. Re-run deliberately. For a schedule, use run now; for a one-off, submit the job again. Before either, confirm
   the job is safe to repeat — a job that sends mail or calls a provider creates real effects a retry cannot undo.

## The internal tab

Reads here are facts about this instance: metadata version, entity count, how many entity overrides an
administrator has written, the queue name and its counts, installed extension ids, the Node version and uptime.
It also holds the two guarded operations, each of which demands that you type its exact confirmation phrase:

- **Reset metadata overrides** drops the administrator-written entity overrides so the shipped definitions apply
  again. It touches definitions only, never record data.
- **Purge the job queue** removes jobs waiting to be picked up. Running, completed and failed jobs are left where
  they are. It refuses to run when the queue cannot be read.

Both write to the configuration history with the actor's name.

## Where to go next

- [The administration area](admin/settings-overview) — which screens save as a document and which save per action.
- [Integrations](admin/integrations) — the jobs the connector workspace runs and their retention purge.
- [Users, teams and roles](admin/users-teams-roles) — who may see the whole audit log.
