# Phase 22.19 — Data Integrity and Concurrency

> **Date:** 2026-10-29
> **Plan:** `PLAN_Phase_22_Integration_E2E_Hardening.md` §18
> **Status:** Complete — invariant register built from the existing suites; three defects fixed (G20, G22, and the
> AI approval's unpinned target version); two behaviours accepted and documented (G30, offset pagination);
> regression tests landed and the gate is green.

---

## 1. Objective

Identify race conditions across cross-module workflows and confirm invariants hold under concurrent operations.

## 2. Tasks (plan §18, 11 items)

1. Identify high-contention records and uniqueness constraints: Lead conversion, external ID mappings, inbound message
   deduplication, signature request creation, payment state, journey enrollment, task creation, and webhook event
   processing.
2. Test concurrent duplicate conversion attempts for the same Lead.
3. Test simultaneous webhook/job processing for the same provider event.
4. Test a record update racing with AI action preview/confirmation; confirmation must revalidate version and
   permissions.
5. Test optimistic locking/version conflicts where supported.
6. Test unique external identity/mapping constraints and conflict handling.
7. Verify transactions do not leave orphaned relations or inconsistent statuses after controlled failures.
8. Test pagination/order stability if records are concurrently inserted or modified.
9. Verify monetary/financial fields remain decimal-safe and no float rounding regression is introduced.
10. Verify time-zone and date-boundary logic for scheduled actions, SLAs, renewals, and journey delays.
11. Confirm duplicate notifications/events are avoided through idempotency, not merely frontend button disabling.

## 3. Acceptance criteria (plan §18)

- Each identified invariant has a test or a documented reason it cannot be fully automated.
- Parallel execution produces valid, explainable outcomes, including conflict responses where appropriate.
- No workaround depends solely on client-side serialization.

## 4. Status

- **Task 1 — inventory: done** (see §5). Each high-contention record is named with the constraint that protects it.
- **Tasks 2, 3, 6, 9, 10, 11 — already proven by existing suites** and re-run in this phase (§5).
- **Task 4 — fixed and tested.** AI approvals now carry the target's version from the preview, refuse at decision time
  if it moved, and execute the update with that version (§6.1).
- **Task 5 — tested both sequentially and concurrently** (§6.2).
- **Task 7 — verified through the existing transaction suites; G30 dispositioned** (§7.1).
- **Task 8 — tested and the offset-window behaviour documented** (§6.3, G71).
- **G22 — fixed.** The duplicate-job collapse now looks for `running`, the status a `jobs` row actually has (§6.4).
- **G20 — fixed.** A payment provider event id is now scoped by provider, and the redundant unscoped unique index is
  dropped (§6.5).

## 5. Invariant register

| # | High-contention record / invariant | Constraint or mechanism | Evidence | Verdict |
|---|---|---|---|---|
| 1 | Lead conversion — one conversion per Lead | Operation key + Lead state/row lock inside one transaction | `lead-score-conversion.test.ts` "converts once when two keys race for one Lead", "answers a second key on a converted Lead without creating a second pair" | Holds |
| 2 | Payment provider event — one effect per delivery | `uq_payment_provider_event (provider, providerEventId)` + unique-violation answer | `phase22-replay-contract.test.ts`, `phase22-payment-provider-contract.test.ts`, new cross-provider test | Holds (G20 fixed) |
| 3 | Inbound message dedup | `voice_messages (account_key, provider_message_id)` + `voice_communication_events (webhook_event_id)` unique | `omnichannel-conversation.test.ts` replay test + new concurrent-processing test | Holds |
| 4 | Signature request / envelope creation | Envelope unique per provider request; request state machine with optimistic version | `esignature-entities.test.ts` "loses a concurrent writer…", `esignature-connection.test.ts` refresh race, `esignature-lifecycle` | Holds |
| 5 | Journey enrollment — one enrollment per trigger key | Unique dedupe key on enrollment | `marketing-automation-journey-runtime.test.ts` "creates exactly one enrollment when three triggers race" | Holds |
| 6 | Journey action execution — one worker per action | Atomic claim (`pending → running`) | `marketing-automation-journey-runtime.test.ts` "lets only one of two concurrent claims win" | Holds |
| 7 | Case number allocation | Sequence taken under a row lock | `service-desk.test.ts` "prevents number collisions under concurrent creation" | Holds |
| 8 | Webhook event processing | Dedup receipt + one job per receipt + idempotent projection | `phase22-replay-contract.ts`, worker outbox tests (22.18), this phase's concurrent message test | Holds |
| 9 | AI preview → decision → execution | Target version pinned at preview; revalidated at decision and execution; ACL re-checked by the tool | `ai-agent-runs.test.ts` new version tests, `phase22-journey-ai-controlled-actions` step 6 (permissions/disabled/gone) | Holds (fixed in 22.19) |
| 10 | Optimistic locking on any record | `entity_records.version` checked by the write (`UPDATE … WHERE version = expected`) | `entity-crud.test.ts` stale-version test + new concurrent same-version test | Holds |
| 11 | External identity / mapping uniqueness | `integration_object_links` unique per (connection, object, external id); `external_id` mapping | `phase22-journey-integrations-recovery` step 8 ("the same page twice is one record") | Holds |
| 12 | Transactional consistency after a refusal | One transaction per conversion / webhook apply / allocation; refusal leaves nothing | `lead-score-conversion` refusal cases, `phase22-journey-quote-to-signature`, `phase22-transaction-migration-audit` | Holds |
| 13 | Pagination under concurrent writes | Offset window over live order (no snapshot) | `phase22-data-integrity.test.ts` new test | Documented (G71) |
| 14 | Money / decimal safety | Integer minor units / decimal strings; no float arithmetic | `sales-money.test.ts`, `sales-tax.test.ts`, `sales-quote-document.test.ts`, allocation tests | Holds |
| 15 | Time zone and date boundaries | Calendar time zone per SLA; explicit date arithmetic for schedules/renewals | `service-desk-sla.test.ts` (Tokyo business hours, holidays), `sales-subscriptions.test.ts` (leap/month-end/windows) | Holds |
| 16 | Duplicate notifications / events | Outbox dedupe keys + unique event keys + idempotent consumers | `phase22-journey-*`, `esignature-events.test.ts`, `phase22-replay-contract` | Holds |
| 17 | Orphan rows after hard delete | None in the production path (deletion is soft) | G30; tests clean their own stream/audit rows | Accepted/deferred (G30) |

## 6. What changed

### 6.1 Task 4 — an AI approval is about a version, not just a record

The approval proposal stored the record's id and the before/after values, but not its version, and the update tool
wrote whatever the record looked like at execution. A person could approve a proposal, edit the record, and the agent
would still overwrite the newer state.

- `AIToolPreviewTarget` carries an optional `version`; the update-fields preview captures it.
- `AIAgentApprovalService.revalidationFailure` refuses an approval whose targeted record no longer has that version
  (`422`, "changed after the proposal was shown"); the approval is `invalidated` and the run settles `blocked_by_policy`.
- At execution, the same version map is passed to the tool's preview revalidation and to `updateFields`, which merges
  `version` into the Entity Engine update — so a write that lands between approval and execution loses with
  `CONCURRENCY_CONFLICT` instead of overwriting.
- A target that was deleted between preview and decision keeps the existing behaviour: the human may still approve, and
  execution refuses through the ACL/not-found path (`phase22-journey-ai-controlled-actions` step 6a still passes).

Tests: `ai-agent-runs.test.ts` "refuses an approval whose target changed after the proposal was shown (22.19)" and
"refuses to execute when the target moved after approval (22.19)".

### 6.2 Task 5 — two writers at the same version

`entity-crud.test.ts` already proved a *sequential* stale version is refused. The new
`phase22-data-integrity.test.ts` sends two `PATCH` requests at the same `version` concurrently and asserts exactly one
`200` and one `409 CONCURRENCY_CONFLICT`; the stored description is the winner's and the version moved once.

### 6.3 Task 8 — pagination is a window, not a snapshot

The new test creates four deterministic records, then concurrently edits one (without changing the sort key) and
inserts a record sorting *after* the remaining page: the next page is unchanged. It then inserts a record sorting
*before* the boundary and asserts the window shifts — no duplicate ids across adjacent pages, the total reflects the
new record, and the shifted row is exactly the documented offset behaviour. No client-side serialization is involved;
the API is honest about the window. Recorded as G71.

### 6.4 G22 — the duplicate-job collapse looked for a status that never exists

`LeadScoreRecalculationService.outstandingJob` filtered `status IN ('pending', 'active')`. A `jobs` row's statuses are
`pending | running | completed | failed | cancelled`; `active` is BullMQ's word. Once a worker started the first job, a
newer trigger saw no outstanding job and queued a second recalculation with a different revision-derived id.

Fixed to `('pending', 'running')`. Regression: `lead-score-recalculation.test.ts` "collapses a newer trigger even
after the first job started running (G22)" (the first job's row is moved to `running`, then a newer revision must
return `alreadyQueued` with the same job id and leave one row).

### 6.5 G20 — the payment provider event key is scoped by provider

Migration 024 already installed `uq_payment_provider_event` on `(provider, providerEventId)`. Migration 083 added a
second unique index on `providerEventId` alone while closing the concurrent-delivery race, so two gateways that shared
an id space collided. The service now looks events up by `(provider, providerEventId)` in both the fast path and the
unique-violation answer, and
`085_phase22_payment_event_key_scoped.sql` drops the redundant unscoped index. The scoped index still makes the write
the decision for concurrent deliveries of the same provider.

Regression: `sales-payments.test.ts` "scopes a provider event id by provider, so two gateways may share an id space
(G20)" — two providers accept the same id, a repeat from one provider is a duplicate, and the ids are stable.

## 7. Decisions

### 7.1 G30 — orphans after a hard delete (accepted, deferred to retention)

The production delete path is a **soft delete** (`EntityCrudService.remove` → `softDelete: true`); the record and its
stream rows stay together. The orphans observed in G30 come from *hard* deletes performed by tests and maintenance
scripts (`DELETE FROM entity_records`), which have no product operation behind them. A cascading cleanup on every hard
delete would be a retention/administrative decision (22.21) rather than a concurrency fix, and a cascade on
`stream_items` (polymorphic, no foreign key) is exactly the kind of schema change that needs its own review. **Owner:**
platform; **Review:** 22.21 with the retention sweep (G12–G14). Tests in this phase remove their own stream, audit and
outbox rows by exact id, as the existing journeys do.

### 7.2 G71 — offset pagination is a live window (accepted)

The API pages with `offset`/`maxSize` over the current order. It is not a snapshot: an insert that sorts before the
next boundary shifts the page. The new test pins the behaviour instead of claiming isolation. A stable cursor is a
product/API-shape decision for a later phase; until then, the UI's own refetch-after-write keeps the visible window
fresh, and no authorization decision depends on a page's contents.

### 7.3 G69 — Sales lot-traceability flake

The shared-database flake recorded in 22.15 still reproduces solo and is unrelated to this phase's changes. It is a
test-isolation defect owned by the Sales suite (G69), not a concurrency defect in the platform.

## 8. Known limitations

- **No automated proof of a deadlock/serialization retry.** The repository/transaction boundary tests in 22.18 cover a
  bookkeeping failure and a retry-write failure; PostgreSQL deadlock detection itself is not forced by a test, because
  deliberately causing one against the shared database would be an uncontrolled failure (AGENTS.md §3.4).
- **Offset pagination drift** is documented, not removed (G71).
- **No operator tool to reconcile a job or stream orphan** — G21/G30 belong to 22.21.
- **The configured database still carries the historical orphan/backlog rows** documented in G14/G30; this phase does not
  delete them (no broad deletes).

## 9. Evidence

Commands run on 2026-10-29 against the configured `.env` database (no database was created, reset, truncated or
deleted; migration 085 is additive and was reviewed before application):

- `npx vitest run apps/api/test/phase22-data-integrity.test.ts` → **2 tests passed** (optimistic lock race, pagination
  window).
- `npx vitest run apps/api/test/lead-score-recalculation.test.ts` → **23 tests passed** (including the G22 regression).
- `npx vitest run apps/api/test/sales-payments.test.ts` → **14 tests passed** (including the G20 regression); migration
  085 applied, the unscoped index is gone and `uq_payment_provider_event` remains.
- `npx vitest run apps/api/test/ai-agent-runs.test.ts` → **28 tests passed** (including both version-revalidation
  scenarios).
- `npx vitest run apps/api/test/omnichannel-conversation.test.ts` → **7 tests passed** (including concurrent receipt
  processing).
- `npx vitest run apps/api/test/phase22-journey-ai-controlled-actions.test.ts apps/api/test/lead-score-conversion.test.ts apps/api/test/phase22-journey-lead-to-customer.test.ts`
  → **47 tests passed** (the existing concurrency/permission journeys still hold).
- `pnpm verify` → **green**: lint 0 errors / 0 warnings (UI conventions 4 917 keys), typecheck both projects clean,
  `pnpm test` **248 files / 3 307 tests passed**, `pnpm test:web` **7 files / 31 tests passed**.
- `pnpm --filter @carocrm/worker test` → **22 files / 224 tests passed** (the worker is outside the root gate, G5;
  22.19 did not change it).
