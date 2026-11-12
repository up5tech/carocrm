# Data Retention and Deletion Windows

> **Owner:** platform / operations
> **Introduced:** Phase 23.7 (2026-11-12); closes G12, G13, G14, G21 and the stream half of G30.
> **Plan:** `plans/PLAN_Phase_23_Security_Hardening.md` §13
> **Rule:** every cleanup is **narrowly predicated**, bounded per run, and tested against unrelated
> rows. No retention job truncates a table or deletes by a caller-supplied predicate.

## 1. What runs, when, and for how long

The schedules are seeded by `database/migrations/094_phase23_retention_schedules.sql` and run in the
worker's low-traffic window (03:15–03:55 server time). Each job accepts an override in its
`scheduled_jobs.target`; an invalid or non-positive value falls back to the documented default.

| Schedule ID | Job | Default window | What it removes | What it never touches |
|---|---|---|---|---|
| `system-retention-outbox` | `system.cleanupOutbox` | 7 days | `outbox_events` with status `processed` / `failed` | pending / in-flight events |
| `system-retention-sessions` | `system.pruneSessions` | 30 days | revoked or expired `user_sessions` | live sessions |
| `system-retention-jobs` | `system.cleanupJobs` | 30 days | terminal `jobs` (`completed`, `failed`, `cancelled`); `job_logs` via FK cascade | `pending` / `running` rows |
| `system-retention-provider-receipts` | `system.cleanupProviderReceipts` | signature 90, voice 90, marketing 30 | minimized signature/voice payloads; terminal receipts with no dependent evidence | normalized events, non-terminal receipts, voice receipts that parent an event |
| `system-retention-stream-orphans` | `system.cleanupStreamOrphans` | 30 days | `stream_items` whose entity type is known and whose exact record no longer exists | soft-deleted records, stream rows for an unknown/non-record subject |

Batch size defaults to **500** rows per statement for the jobs and provider-receipt passes, so a
backlog never becomes one long lock.

## 2. Per-source rules

### ESignature receipts (G12)

`signature_webhook_inbox.purge_after` is stamped from the module's policy (90 days by default). The
retention pass now **reads** it:

- the normalized `signature_provider_events.event_data` is replaced by `{}` once `purge_after` passes
  (the event row, hashes and outcome stay as evidence);
- the terminal inbox receipt (`processed`, `ignored`, `duplicate`, `dead_letter`) is deleted after the
  same deadline. A non-terminal receipt is retained for operator replay.

A late provider redelivery after the receipt is gone is processed again; that is the deliberate
trade-off of a bounded dedup window.

### Voice and marketing receipts (G13)

Neither table carries a per-row purge deadline, so the window comes from the schedule:
`voiceDays` (90) and `marketingDays` (30).

- **Voice:** `payload_redacted` is set to `NULL` after 90 days. A receipt is deleted only when it has
  **no** `voice_communication_events` child and is terminal (`processed`, `rejected`, `failed`,
  `enqueue_failed`). A receipt that produced a call or message is evidence and stays.
- **Marketing:** a terminal inbox row (`processed`, `processed_with_errors`, `rejected`) is deleted
  after 30 days. `marketing_events.inbox_id` is `ON DELETE SET NULL`, so the normalized event log
  survives the receipt.

### Jobs and logs (G14)

Only terminal rows older than 30 days (measured from `finished_at`, falling back to `created_at`) are
deleted, oldest first, at most 500 per run. `job_logs` disappears through its `ON DELETE CASCADE`
foreign key. A failed row is therefore retained for the same window in which an operator can retry
or discard it (G21).

### Stream orphans (G30, partial)

`stream_items` is polymorphic and has no foreign key. The pass deletes a row only when **all** of these
hold:

1. it is older than the window;
2. its `entity_type` exists in `entity_records` (so it is a real Entity Engine type, not a future
   non-record subject);
3. no `entity_records` row with that exact `(entity_type, id)` exists.

Soft-deleted records still have a row, so their timeline survives. `stream_mentions` and
`stream_attachments` cascade with the item.

**Residual (documented exception).** `attachments` rows and their stored files are **not** removed by
this pass. Attachment access is already denied when the parent cannot be read (Phase 23.6 ACL), so the
residual is inert storage growth rather than exposure. See the G30 row in
`docs/security/exception-register.md` for the owner and review date.

### Failed jobs (G21)

The admin API now exposes:

- `POST /api/v1/Job/:id/action/retry` — only a `failed` job; creates a **new** row with the same job
  name and target, leaving the failed row as history;
- `POST /api/v1/Job/:id/action/discard` — only a terminal job; removes that exact row and its logs.
  A pending/running job must be cancelled first.

Both are administrator-only, like every other `/Job` route.

## 3. Audit log retention and tamper evidence

`audit_log` is **not** part of these schedules. It is the tamper-evidence record for authorization,
consent and operator actions, and deleting it by age would let a retention sweep erase the reason a
decision was made.

- **Retention expectation:** at least **24 months** in the primary database, then export to the
  encrypted backup/archive before any purge. A purge is an owner-approved, off-cycle operation with a
  written record; it is not a seed schedule.
- **Immutability expectation:** the application exposes read routes only (`GET /AuditLog`,
  `GET /AuditLog/:id`); there is no update or delete route. The runtime database role must not own
  `audit_log` (or must be denied `UPDATE`/`DELETE` on it) in a production deployment; this remains a
  deployment-role check, not an application control.
- **Redaction:** `denied` events added in Phase 23.4 run through the same field-level redaction as
  every other audit row (`password`, `secret`, `token`, `apiKey` → `[REDACTED]`). Regression:
  `apps/api/test/audit.test.ts` and `apps/api/test/phase23-4-authorization.test.ts`.

## 4. Verification

| Check | Where |
|---|---|
| Terminal-only job deletion, cascade and batch | `apps/worker/src/handlers/job-handlers.test.ts` — *phase 23.7 retention jobs* |
| Provider receipt minimization/deletion predicates | same file |
| Stream orphan predicate requires a known type **and** a missing record | same file |
| Retry/discard contract and metadata redaction | `apps/api/test/jobs.test.ts` |
| Migration numbering and additive SQL | `pnpm ci:migrations` |

## 5. Operating notes

- Run a window change by updating `scheduled_jobs.target`; no deploy is required, and an invalid value
  falls back to the default rather than deleting with an unintended window.
- A retention job reports counts in its result and log line; it never logs row contents.
- If a job fails, the durable `jobs` row keeps the failure for the standard 30-day window — the same
  window the job itself enforces.
