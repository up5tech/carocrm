# ADR 0003 — Job topology for connector work

* **Status:** Accepted
* **Phase:** 19-INT.1 (decided), implemented in 19-INT.6 / 19-INT.9
* **Related:** `docs/modules/advanced-integrations/feature-contract.md` §5.2, §5.5 ·
  `docs/implementation/advanced-integrations-audit.md` §2

## Context

The platform has two background mechanisms and they behave differently:

* **The job queue** — `packages/jobs` (`JobRegistry`, `JobQueuePort`) with
  `apps/api/src/jobs/jobs.service.ts` (`JobsService.enqueue`, `JOB_NAME` = 2–4 dot segments) and a
  BullMQ + Redis transport. Attempts are bounded and backoff is exponential
  (`apps/worker/src/queue/job-consumer.ts:42-45`). There is **no jitter** and **no dead-letter
  table**.
* **The outbox** — `outbox_events` with `apps/api/src/events/event-bus.ts` (`EventBus.dispatch`,
  committed with the data that caused it) and `apps/worker/src/outbox/outbox-poller.ts`, a
  **separate Postgres polling loop**. The outbox is *not* enqueued as a job.

A connector needs at least four kinds of work: periodic sync, incremental sync, webhook
processing, and credential refresh. The plan (§11.1) asks for a queue design and §11.2 for a retry
policy.

The audit found the trap: `outbox_events.failed` is **swept** by
`CLEANUP_OUTBOX_SQL` in `apps/worker/src/handlers/job-handlers.ts`, not replayed. So the outbox is
a *notification* channel, not a *retry* channel. Retrying through it would silently discard work.

## Decision

1. **Connector work runs on the job queue, not the outbox.** The outbox is used for what it is
   good at — telling the platform that a CRM record changed — and the job queue carries the
   work. `EventBus.dispatch` inside a transaction, then a job that consumes it.
2. **One job per run, one operation per unit of retry.** A sync is a *run* job. It creates
   **operation** rows as it goes, one per provider object it touches. An operation that fails is
   retried **as its own job**, so a retry re-reads only the page it needs and never replays the
   whole run.
3. **The operation ledger is the source of truth, not the queue.** The queue carries work; the
   `integration_sync_operations` rows record what was actually applied. A crash between "provider
   accepted the write" and "the queue acked" is detected by comparing the ledger with the
   provider on the next run, not by trusting the queue.
4. **Dead letters are a table, not a log line.** The worker's
   `'bullmq job permanently failed (dead letter)'` log is a message, not a store. Terminal
   failures become `integration_dead_letters` rows that an operator can inspect and replay.
5. **Refresh is per connection, under a lock.** Credential refresh is not a job; it happens inline
   in the operation that needs the token, guarded by a per-connection database lock so two
   concurrent operations cannot refresh the same token twice (see ADR 0001 / feature contract
   §5.5). A refresh race is a correctness bug, not a performance issue — a rotating refresh token
   is destroyed by the second refresh.
6. **Webhook processing is a job, the acknowledgement is not.** The ingress endpoint verifies the
   signature, writes a receipt, enqueues the processing job, and acknowledges. Processing happens
   asynchronously so a slow provider never holds an HTTP connection open.
7. **Job names follow the platform convention**: `advancedIntegrations.<verb>` — two dot-separated
   camelCase segments, matching `voiceCommunications.processWebhookEvent` and
   `marketing.deliveryBatch`.

## Consequences

**Positive**

* Retries are bounded and per-object, so a single bad record cannot block a run.
* The outbox's weakness (failed rows are swept) is avoided: nothing that matters is carried by it.
* An operator can see exactly which operations failed, for which connection, and replay them.

**Negative**

* The operation ledger is extra state to keep consistent with the queue. This is the price of
  being able to detect the crash-between-write-and-ack case, and it is why the ledger, not the
  queue, is authoritative.
* Per-connection refresh locking adds a database round-trip on the hot path of every
  token-consuming operation. The lock is taken only when the token is expired or about to expire.
* BullMQ's backoff has no jitter, so many connections refreshing at once could synchronize onto
  the same retry instant. The per-connection lock absorbs this, but a jittered backoff would be a
  platform-wide improvement (out of scope here).

**Alternatives rejected**

| Alternative | Why rejected |
| --- | --- |
| Retry through the outbox | `outbox_events.failed` rows are swept, not replayed — a retry would disappear silently. |
| One job per provider object | At a realistic object count this floods the queue and makes a run impossible to reason about. The run job plus an operation ledger gives the same retry granularity without the flood. |
| One job per page | A page is not a unit of meaning. A partial page failure would re-apply objects that already succeeded. |
| Refresh as a scheduled job | A scheduled refresh refreshes tokens nobody is using, and still races with an inline refresh. Inline, under a lock, is the only correct arrangement. |
| In-memory locks for refresh | The API and the worker are separate processes. An in-memory lock does not serialise them. |
