# Platform operations and incident runbook

> Phase 22.21 deliverable (`PLAN_Phase_22_Integration_E2E_Hardening.md` §20).
> Module-specific procedures are linked, not duplicated: the module runbooks know their queues and
> state machines better than a platform page can.

This runbook answers the questions an operator asks during an incident:

1. **What broke?** — the operations snapshot and correlation ids (§1–§2).
2. **What is safe to retry, and what must never be retried?** — the scenario sections (§3).
3. **Who may act, and what is left behind?** — the authority/audit table (§4).
4. **What is kept, for how long?** — retention (§5).

## 1. The first five minutes

Run these in order; each is read-only. Do not start by purging a queue or resetting a table.

| Step | Command | What it answers |
|---|---|---|
| 1 | `GET /api/v1/AdminInternal/action/operations` (sysAdmin) | Outbox/job backlog and age, dead letters, receipt states, open circuits, AI failures. |
| 2 | `GET /api/v1/AdminInternal` (sysAdmin) | Queue counts (BullMQ), metadata version, uptime, extension list. |
| 3 | `GET /api/v1/DomainEvent?status=failed&limit=20` (admin) | Which domain event failed and its `last_error`. Add `eventType=` to narrow. |
| 4 | `GET /api/v1/Jobs?status=failed&limit=20` (admin, `/admin/jobs` in the SPA) | Which durable job failed and its message. `GET /api/v1/Jobs/:id/log` shows its lines. |
| 5 | Module surface (§3) | The provider/receipt/agent view that owns the failure. |

The snapshot is derived from the same tables the modules use; there is no second metrics system to
disagree with them. It carries counters only — no record content, address, token or provider payload.

## 2. Correlation: from a user's report to a worker line

- Every response carries **`x-request-id`**. A caller may supply a bounded `x-correlation-id`; the API
  echoes it (or Fastify's own id) as `x-request-id`. Ask the user for that header, or the `requestId`
  in an error log, when they report a failure.
- A mutation writes its request id into **`outbox_events.correlation_id`**. The worker runs each
  outbox handler inside that request context, so a handler's log lines carry the same `requestId`;
  the poller's own lines include `eventId` and `correlationId`.
- An enqueued job carries the request id in its **queue payload**; the worker's job runner runs the
  handler in that context and records `correlationId` in the job's result metadata (visible on the
  job detail). A job created by a schedule or by the worker has no request id, and says so rather
  than inventing one.
- ESignature and AdvancedIntegrations also persist **`correlation_id`** on their receipts/runs/audit
  rows; AI runs have one. Use the module runbooks to go from the platform id to the provider's id.

Example: a webhook answered 500 → the log line has `requestId=req-…` → the receipt row has the
same `correlation_id` → the module's audit/event row has the provider event id → the provider's own
dashboard. That is the whole chain; do not guess by timestamp.

## 3. Scenario runbooks

### 3.1 A job is stuck (`pending` or `running`)

**Symptoms.** `jobs` snapshot shows a growing `pending` count or an old `oldestPendingAgeSeconds`;
the Admin jobs screen has a row that has not moved; `GET /api/v1/AdminInternal` queue counts show
`waiting`/`active` but no progress.

**Diagnose.**

1. `GET /api/v1/Jobs/:id` — the row's `status`, `attempt`, `max_attempts`, `queue_job_id`, `message`.
2. `GET /api/v1/Jobs/:id/log` — the last lines the handler wrote; they carry the request id.
3. `GET /api/v1/AdminInternal` — is Redis reachable (`jobQueue.counts` is `null` when not)?
4. If the row is `running` and the worker process is gone, the BullMQ stalled-job mechanism is the
   owner of recovery; do not delete the row to "free" it.

**Safe action.**

- `POST /api/v1/Job/:id/cancel` — cooperative: a waiting queue entry is removed; a running handler is
  asked to stop at its next check. It is audited as an ordinary job change.
- Re-submit the job through `POST /api/v1/Job` **only** after the cause is fixed and the handler is
  idempotent. There is no retry/discard API yet (G21, 22.21 follow-up).
- **Never** run `AdminInternal/action/queue-purge` to "clear the stuck one": it drains *all* waiting
  jobs and is a typed-confirmation danger-zone action.

**Follow-up.** If the handler can exceed the outbox lease, alert on `running` age (22.18 lease is for
outbox events, not for `jobs` rows).

### 3.2 A webhook failed or is missing

**Symptoms.** Snapshot `webhooks` shows a non-empty `rejected`/`failed`/`dead_letter` bucket; the
provider says it sent; the module's health page is red.

**Diagnose.** Use the module's own receipt view, which knows the dedup key and signature state:

- ESignature → [`esignature-operations.md`](esignature-operations.md) §2 (Connect secret/HMAC, inbox
  state, operator retry). The retry route is `POST /api/v1/ESignature/action/operations/webhooks/:id/retry`
  and only re-applies a **verified** delivery.
- AdvancedIntegrations → [`advanced-integrations.md`](advanced-integrations.md) §4–§5 (signature
  spike, subscription, delivery states) and the dead-letter replay route.
- Voice/Omnichannel → [`../omnichannel/runbook.md`](../omnichannel/runbook.md) and the voice webhook
  receipt list; replay is `POST /api/v1/VoiceCommunications/action/webhook-events/:id/replay`.
- Marketing → [`marketing-provider-incidents.md`](marketing-provider-incidents.md).

**Never** "re-send" a signature or a payment to make a webhook look delivered. A delivery that failed
verification is evidence, not work.

### 3.3 Provider authentication expired or was revoked

**Symptoms.** A connection is `reauthorization_required`; provider calls fail with `AUTHORIZATION`/
`TOKEN_EXPIRED`; the circuit may be open.

**Procedure.** [`advanced-integrations.md`](advanced-integrations.md) §1–§2 and
[`esignature-operations.md`](esignature-operations.md) §1. Re-authorize through the provider; never
paste a token into a setting or a log. A successful callback restores the connection, but the state
does not become `connected` on its own.

### 3.4 Duplicate records or a sync conflict

**Symptoms.** Two CRM records for one provider object; a conflict row is open; a mapping is bound to
the wrong connection; an echo loop keeps updating.

**Procedure.** [`advanced-integrations.md`](advanced-integrations.md) §6–§7. Open the conflict and
decide with the provider's authoritative state; do not "fix" it by editing both sides. A mapping that
points at the wrong connection is a configuration change (G50), not a data repair: keep one live
connection per provider and reconcile the mapping deliberately.

### 3.5 Unknown signature state

**Symptoms.** An ESignature request is `send_unknown`; the inbox has an event but no request bound; the
provider shows a different envelope status.

**Procedure.** [`esignature-operations.md`](esignature-operations.md) §2 and
`docs/modules/esignature/...`. Reconcile (`POST /api/v1/ESignature/requests/:id/reconcile`) reads the
provider; it does not send. An unknown envelope stays as evidence until an operator links/ignores it;
never delete the receipt to clear the queue. A *verified* inbound delivery may be retried; an invalid
one cannot.

### 3.6 An ambiguous payment or communications result

**Symptoms.** A payment request is not `paid` although the provider says it was; a payment event is
logged twice; a voice/WhatsApp message has no body but the provider shows a delivered receipt; a
media fetch is pending.

**Procedure.**

- Payments: the provider event log is the evidence; the unique `(provider, providerEventId)` key (G20)
  means a repeat is answered as a duplicate. Do **not** create a second payment or edit a balance by
  hand. Re-deliver the provider event only if the provider says it was not accepted; otherwise the
  event is already applied.
- Communications: inspect the voice/Omnichannel receipt (`processing_status`, `failure_code`,
  `payload_digest`) and replay it; the message/event unique keys make a replay safe (22.18 G19 shows a
  same-key/different-body mismatch on the receipt). A media fetch that is pending is retried by its
  sweep; absence of a body is not proof that a customer did not receive a message.

### 3.7 An agent run is partially complete or blocked

**Symptoms.** A run is `waiting_for_approval`, `blocked_by_policy`, `failed` or `outcome_unknown`; a
tool call succeeded but the run stopped; an approval expired.

**Procedure.** [`../modules/ai-agents/operations-runbook.md`](../modules/ai-agents/operations-runbook.md)
and `docs/quality/phase-22-journey-ai-controlled-actions.md`. Read the run's events, the approval and
the tool calls. An `outcome_unknown` means the effect may have happened: reconcile before retrying.
An expired approval cannot be revived; ask again. A rejected/invalidated approval must not be
recreated by replaying the old arguments — a new proposal is a new decision.

### 3.8 A migration failed

**Symptoms.** Boot fails at `migrateDb`, or a migration is recorded as failed; the schema and the code
disagree.

**Procedure.** [`../operations/backup-restore.md`](../operations/backup-restore.md).

1. Read the migration file and the error; identify whether it is a lock/timeout, a data conflict or a
   genuine SQL error.
2. **Never** reset the database, drop the schema, truncate a table, or edit the migration history to
   get a green boot. A failed migration is a stop-the-line event.
3. Prefer a forward fix (a new additive migration) over editing an applied one. If data must be
   restored, follow the backup/restore runbook in a reviewed window.
4. Record the incident and the fix in `schema_changes`/the change log.

## 4. Operator authority and audit

| Action | Authority | Audit trail |
|---|---|---|
| Read the operations snapshot / internal info | system administrator | none (read-only) |
| Read domain events | administrator | none (read-only) |
| Cancel a job | administrator | `jobs` row (`cancel_requested`, status) |
| Purge the waiting queue / reset metadata overrides | system administrator + exact typed confirmation | `schema_changes` (`admin.internal.queuePurge` / `metadataReset`) |
| Replay a connector dead letter | connection admin capability | integration audit (`dead_letter.(replayed)`), letter status |
| Retry an ESignature webhook, reconcile a send | SignatureConnection/`send` capability | `signature_audit_entries` (`webhook.retryRequested`, `send.outcome_unknown`… ) |
| Voice webhook replay | administrator | receipt processing status; jobs row |
| Approve/reject an AI action | `approval` capability | `ai_agent_approvals`, run events, audit |
| Change settings/connections | the module's own capability | module audit/settings documents |

A read-only check never mutates. A danger-zone action is never the first response to an incident;
every one of them is attributable to an actor.

## 5. Logs, traces and test artifacts

- **Logs** go to stdout as structured JSON through `@carocrm/core/logger`. The platform does not write
  log files itself; the deployment's collector owns rotation and retention. Credential-shaped keys
  (tokens, secrets, passwords, authorization/cookie headers, API keys, signatures, database URLs) are
  redacted by default; `packages/core/src/logger/index.test.ts` proves the paths. A log line still
  must not be used to transport record content.
- **Traces**: no OpenTelemetry exporter or tracing backend is installed. Task 5 of §20 says not to add
  a second tracing system without a need; 22.21 did not add one. Correlation ids and module
  `correlation_id` columns are the trace spine until an operator-owned backend is chosen.
- **Jobs/outbox**: `jobs` and `job_logs` have no retention (G14); outbox events have no scheduled
  cleanup (G14/G21). They are durable operator evidence and grow until a retention decision in 22.21.
  Do not delete them ad hoc.
- **Module evidence**: signature audit, inbox receipts and provider events are kept by design and only
  purged by the module's own retention policy.
- **Test artifacts**: tests use `AGENT_TEST_` markers and delete their own records by exact id; they
  never create a test database. Browser artifacts (if a Playwright run is used) must be sanitized
  before sharing; the critical-path spec uses synthetic records and no production credentials.
- **Never** put a database URL, bearer token, provider payload, message body or document bytes in a
  ticket, a screenshot or a runbook note.

## 6. Known operational gaps (see `docs/quality/known-gaps.md`)

- No operator API to retry/discard a failed `jobs` row (G21) — re-submit by hand.
- No circuit-reset route; an open circuit self-heals after its open window (G48).
- No platform-wide metrics/tracing exporter (G77) — derived module metrics and the snapshot are the
  current answer.
- Readiness checks the database only; queue/provider health is on demand (G76).
- `jobs`/`outbox` retention and the shared-database backlog (G14) — 22.21 follow-up.
- Bulk update/delete are uncapped and sequential (G73); no query/request deadline (G74).
