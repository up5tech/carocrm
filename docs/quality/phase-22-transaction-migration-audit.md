# Phase 22.5 — Persistence, Transactions, and Migration Verification

**Plan:** PLAN_Phase_22_Integration_E2E_Hardening.md §10
**Objective:** Verify that cross-module operations are atomic where possible and recoverable where distributed/external side effects make full transactions impossible.
**Status:** Verified · no code changes required (no evidence-backed defects) · 1 read-only migration-status check run

---

## 1. Transaction model (Plan tasks 1, 3, 8)

The persistence layer is built on Kysely over PostgreSQL with a single, well-factored transaction primitive.

**Ambient transaction context** — `apps/api/src/entity/tx-context.ts`:
- `runInTransaction(db, work)` reuses an **already-open** ambient transaction if one exists (no nested `BEGIN`, no connection-pool deadlock — AGENTS.md §5.1), otherwise opens a new one.
- `withTxContext(tx, work)` marks the async context so every store read/write joins the same transaction.

This lets a Phase 19 domain command (stage move, reorder, project clone, case lifecycle) be several mutations under **one invariant**, while nested calls automatically reuse the outer transaction.

**Kernel hooks run inside the mutation transaction** (`entity-record.store.ts:472-498`, `app.module.ts:448`):
- Audit rows, stream items, and domain events are all written inside the same transaction as the record mutation, so a rolled-back mutation rolls back its audit/stream/event rows too (no orphaned side effects).
- Report reads use `setIsolationLevel('repeatable read')` for a stable snapshot (`entity-record.store.ts:360-362`).

**Validation before irreversible effects (task 3):** every surveyed multi-record command performs its permission/validation checks *before* the first write — e.g. `settings-document.service.ts:107` ("permission check before any write"), `sales/pricing/bulk-price.service.ts:32` ("a permission check before any write, a bounded transaction, an audit record"), and the optimistic-concurrency version check in §5.

---

## 2. Transaction boundaries for required operations (Plan task 2)

| Operation | Service / evidence | Boundary |
|---|---|---|
| Lead conversion | `lead-score/lead-conversion.service.ts:298,338,395,435` — 4 `runInTransaction` sites | Atomic convert + related writes; recovery re-claims the row if a prior attempt partially applied (`lead-conversion-audit.service.ts:213`) |
| Quote / order / invoice state | `sales/*` via entity store `withTransaction` | Each state transition is one transaction; money is a canonical decimal string (`sales/money/decimal.ts`) |
| Signature request setup | `esignature/esignature-request.service.ts:338,593,655,697,756,863,1103,1142,1499` — 9 `runInTransaction` sites | Request, recipients, envelope, and outbound event all commit or roll back together |
| Case linking / handoff | `service-desk/case-conversation.service.ts:35` ("Every write happens in one transaction with the stream item…"); `omnichannel/omnichannel-handoff.service.ts` → `CaseHandoffService.recordLink/createOrGet` | Conversation↔Case link is transactional; 403 if the caller may not read either side (`omnichannel-handoff.test.ts:227`) |
| Journey enrollment | `marketing-automation/marketing-form.service.ts:150` → `runtime.enroll(...)`, persisted via the entity store's transactional boundary; idempotency key per step (`marketing-journey-action.service.ts:180`) | Enrollment + first step are transactional; retries reuse the same idempotency key so a node never executes twice |
| Conversation handoff | see Case linking above | — |
| Agent approval execution | `ai-agents/ai-agent-runs.service.ts` (`scope.runAs(initiatingUser)`, `executeTool` idempotency claim at `:1411-1483`) | Tool effect claimed by `idempotency_key` inside one transaction; a duplicate executor cannot repeat the effect |
| Workflow / process execution | `workflows/workflow.service.ts:227`, `processes/process.service.ts:263` | Definition publish/enable and instance start are transactional; instance audit trail written in-tx |
| Scheduled report delivery | `reports/report.service.ts:296` `scope.runAs(ownerPrincipal, …)` | CSV generated under the owner's principal; owner-mismatch denied before any write (`:290`) |

**Conclusion (task 2):** every operation the plan names executes inside an explicit transaction boundary.

---

## 3. Foreign keys & unique / dedup constraints (Plan task 4)

**Foreign keys** are pervasive and use `ON DELETE CASCADE` from owning identities (`users`, `ai_agents`, `ai_agent_conversations`, `reports`) — referential integrity is enforced by the database, not application code. Examples: `013_phase17_reports.sql:9`, `014_phase17_schedules.sql:5`, `047_phase19_ai_agents_memory.sql:19-20`, `062_phase19_crm_chat.sql:29-30`, `072_two_factor_authentication.sql:15/26`.

**Unique / dedup constraints** exist exactly where idempotency matters:
- Subscription idempotency & invoice: `030_phase19_sales_subscriptions.sql:3,7,13` (`uq_subscription_period_identity/_idempotency/_invoice`).
- Agent run idempotency: `uq_ai_agent_runs_idempotency` partial unique index (`045_phase19_ai_agents.sql`, referenced `062_phase19_crm_chat.sql:17`).
- Voice provider-message uniqueness: `077_phase19_omnichannel_persistence.sql:92,160` (`uq_voice_conversation_threads_external`, `uq_voice_participants_provider_identity`).
- Case↔external handoff dedup: `081_phase19_omnichannel_handoff.sql:15` (`uq_entity_records_case_external`).
- CRM-chat ordinal/owner uniqueness: `062_phase19_crm_chat.sql:49,78,106`.
- Process definition key (partial unique, soft-delete aware): `012_phase16_bpm.sql:33,45`.
- Agent version / tool-grant uniqueness: `045_phase19_ai_agents.sql:106,127`.

These constraints back the dedup keys the plan requires for relationships and replay safety.

---

## 4. Optimistic concurrency / version fields (Plan task 5)

`entity_records` carries a `version` column (`entity-record.store.ts:132,531,545,559`). Updates are conditional:

```ts
// entity-record.store.ts:205,212
if (!previousRow || previousRow.version !== expectedVersion) return false;
... .where('version', '=', expectedVersion) ...
```

A stale client (old `version`) matches zero rows, and the store surfaces `CONCURRENCY_CONFLICT` (HTTP 409). This is verified end-to-end by `scripts/e2e-smoke.sh:194-196` (stale-version `PATCH` → 409, code `CONCURRENCY_CONFLICT`). Records subject to concurrent edits (Accounts, Cases, Documents, etc.) are therefore protected.

---

## 5. Migration discipline (Plan task 6)

`database/migrate.ts` applies files **in filename order**, each wrapped in `BEGIN/COMMIT` with `ROLLBACK` on error, and records the name in `schema_migrations` (idempotent — already-applied files are skipped). Findings across all 82 migrations:

- **Additive by default.** New tables via `CREATE TABLE`; new columns via `ADD COLUMN IF NOT EXISTS`. No `DROP TABLE`, no `DROP COLUMN`, no `TRUNCATE`.
- **No lock-risk `NOT NULL` additions.** Every `ADD COLUMN ... NOT NULL` carries a `DEFAULT` (e.g. `008_phase12.sql:27,28,29,42,43,44`, `072_two_factor_authentication.sql:7`), so Postgres does not rewrite existing rows.
- **No `ALTER COLUMN ... TYPE` rewrites** found.
- **"Destructive" hits are safe redefinitions only:** `DROP CONSTRAINT IF EXISTS` (049, 054) and `DROP INDEX IF EXISTS` (027) — each immediately recreates the object. `DROP INDEX IF EXISTS uq_sales_document_number` is paired with a re-create of the document-number uniqueness.
- **Backfill strategy:** new non-nullable columns are populated via the application default; large backfills are not needed because new columns default safely.
- **Rollback/forward-fix:** the runner has no down-migrations; the established practice is additive forward fixes (consistent with AGENTS.md — never destructive in production).

---

## 6. Migration status (Plan task 7 — read-only, no DB recreated)

A read-only check (`SELECT name FROM schema_migrations` vs the files on disk) returned:

```
fileCount: 82, appliedCount: 82, pending: [], orphan: [], maxMigrationNumber: 82, missingSequenceNumbers: []
```

All 82 migration files are applied, none pending, none orphaned, and the numeric sequence 1–82 is complete (note: `038`/`039` are alphabetically out of order but both present). **No test or CI command in this phase created, reset, or recreated the database.**

---

## 7. Behavior on mid-transaction failure (Plan task 8)

- **Application transactions:** Kysely `db.transaction().execute(fn)` auto-rolls-back on a thrown error. Nested calls reuse the ambient transaction (`tx-context.ts`), so a failure anywhere aborts the whole unit. This is the standard, reliable guarantee behind every boundary in §2.
- **Outbox consistency:** because domain events are written *inside* the same transaction (`events/event-bus.ts:17`, `entity-event.hook.ts:13`), a rolled-back mutation emits no event — there are no orphan events for the worker to process.
- **Worker recovery:** `apps/worker/src/queue/job-runner.ts` adopts the API's `pending` `jobs` row; if a handler throws, the row is marked `failed` and retried up to `jobAttempts` (default 3) with `jobBackoffBaseMs` (default 2000ms). Cancellation is poll-based (`shouldStop`), so a mid-flight cancel is observed, not forced.

No evidence of a partial-commit bug was found.

---

## 8. Durable enqueue / outbox for queues & storage (Plan task 9)

The architecture already uses the correct patterns; **no new outbox is needed**:

- **Domain events → transactional outbox.** `EventBus.dispatch` writes to `outbox_events` inside the caller's transaction; `worker/src/handlers/outbox-handlers.ts:21` fans out. Producers and consumers are decoupled and crash-safe.
- **Jobs → durable row as source of truth.** `jobs/jobs.service.ts:57 enqueue` writes a durable `jobs` row (`insertPending`) **first**, then enqueues to BullMQ, then links `queue_job_id` (`:66-67`). The DB row — not the queue message — is the authoritative record an operator can inspect and cancel; the worker adopts pending rows. Queue delivery is therefore **not** assumed to roll back with the DB transaction.
- **Object storage.** File uploads (`Attachment`) are written to local disk / S3 **outside** the DB transaction (acknowledged distributed side effect); the record row is the durable pointer and the scan hook runs after commit. This matches the plan's "recoverable where distributed/external side effects make full transactions impossible" expectation.

---

## 9. Findings (Plan task 10 — evidence-only; no speculative fixes)

| # | Finding | Severity | Disposition |
|---|---|---|---|
| F1 | Migrations `038`/`039` are alphabetically out of order relative to their phase prefixes | Info | Cosmetic; both applied, sequence complete. Rename would be a no-op churn — leave as-is. |
| F2 | Job `enqueue` (`:57-68`) inserts the durable row, then BullMQ-enqueues; a BullMQ failure after the insert leaves `queue_job_id = null` | Low | Acceptable: the worker adopts `pending` rows, so the job still runs. Recovery path is documented, not a defect. |
| F3 | `ADD COLUMN ... NOT NULL` without default — none found | Info | No lock-risk migrations present. |
| F4 | `DROP` statements limited to `IF EXISTS` constraint/index redefinitions — none data-destructive | Info | Additive discipline confirmed. |

**No Major/High defects.** The persistence layer is disciplined: ambient-transaction reuse, in-transaction audit/stream/event hooks, version-based optimistic concurrency, schema-level FK + unique/dedup constraints, and a transactional outbox for events plus a durable-row job queue.

---

## 10. Acceptance criteria mapping

- ✅ **Critical multi-record operations have documented transaction boundaries** (§2).
- ✅ **Migrations reviewed and checked against the existing schema** (§5, §6; read-only status in §6 shows 82/82 applied, no pending/orphan).
- ✅ **No test or CI command resets or recreates the configured database** (§6 — only read-only `SELECT` used; migration runner itself is idempotent and additive).

**Recommended follow-ups (not blocking):**
- Add a focused **transaction-rollback regression test** (insert two rows, force a throw on the second, assert the first is absent) to lock §7 behavior in CI — requires the standard test database, so it belongs in the existing integration suite rather than a DB-less unit test.
- Consider a periodic **sweeper/metrics** check that no `jobs` row is stuck `pending` with `queue_job_id = null` beyond `jobBackoffBaseMs × attempts` (hardens F2 observability).

**Open items for owner (unchanged):** CI platform (22.22), recovery-env rehearsal (22.23), CRMChat scope (22.13).
