# Phase 22.18 — Resilience and Chaos-Lite Tests

> **Date:** 2026-10-29
> **Plan:** `PLAN_Phase_22_Integration_E2E_Hardening.md` §17
> **Status:** Complete — deterministic fault injection mapped to existing suites; three hardening fixes landed
> (queue/outbox jitter, outbox claim lease, provider-key body-mismatch detection) with regression tests; decisions
> recorded for the items that need a product/operations call (G18, G48).

---

## 1. Objective

Verify graceful behavior under realistic, controlled failures without destabilizing the primary project environment.

## 2. Tasks (plan §17, 12 items)

1. Add deterministic fault injection at existing provider/client/queue abstractions where available.
2. Simulate network timeout before request, during request, and after provider acceptance but before response.
3. Simulate HTTP 429, 5xx, invalid credentials, expired OAuth token, malformed provider payload, slow response, and
   provider unavailability.
4. Simulate duplicate and out-of-order webhook delivery.
5. Simulate a worker interruption after committing local state but before acknowledging the job.
6. Simulate Redis/queue unavailability only in an isolated test double or approved non-production environment.
7. Simulate object storage upload failure, download failure, and expired media URL.
8. Simulate AI provider failure, partial tool execution, approval timeout, and cancellation.
9. Simulate a DB serialization/deadlock/constraint error through controlled repository/transaction test boundaries.
10. Verify retries are bounded, backoff is applied, permanent failures are not retried forever, and exhausted jobs are
    visible for operator intervention.
11. Verify user-visible state distinguishes failed, pending, unknown, partially completed, and successful outcomes.
12. Verify reconciliation tools can repair ambiguous state using authoritative provider status without duplicating
    external actions.

## 3. Acceptance criteria (plan §17)

- Each critical asynchronous workflow has at least one retry/replay test and one permanent-failure test.
- No test uses uncontrolled failure injection against shared production-like infrastructure.
- Recovery procedures are documented for failures that cannot be automatically repaired.

## 4. Status

- **Task 1 — deterministic fault injection: done.** The seams already existed and are used as-is: the connector and
  signature fakes (`failNextCall`), the fake payment/AI providers, injected `random` on every retry calculation, and the
  worker's `FakeDb` that can throw per statement. No new injection framework was added.
- **Tasks 2, 3, 4, 8, 9, 10, 11, 12 — covered by existing suites + this phase's additions.** See the matrix in §6.
- **Tasks 5 and 6 — fixed in this phase.** §5.2 (outbox claim lease) and the worker tests that throw from the claim and
  retry statements.
- **Task 7 — storage upload/download failure now automated** (§5.4). Expired media URLs are not applicable to the
  local driver (no public read path, so no signed URL to expire); S3 signing/expiry is covered by
  `packages/files/src/s3/index.test.ts`. The delivery of a media/recording download after expiry is not injected
  end-to-end — recorded in §8.
- **G15 (jitter) — fixed.** §5.1.
- **G19 (same key, different body) — fixed for every door that stores a body hash.** §5.3.
- **G18 (event timestamp ordering) — reviewed and accepted as a documented product decision** (§7). The state machine
  remains the ordering authority.
- **G48 (unused resilience layer) — reviewed; the parts that do not need a policy decision landed (jitter, lease), the
  rest is deferred to 22.21** (§7).

## 5. What changed

### 5.1 G15 — equal jitter on both durable retries

`apps/worker/src/backoff.ts` now owns the delay plan (`exponentialDelayMs`) and equal jitter
(`equalJitterDelayMs`). Both consumers use it:

- `apps/worker/src/outbox/outbox-poller.ts` — `retryDelayMs` (used by `MARK_RETRY_SQL`).
- `apps/worker/src/queue/job-consumer.ts` — `jobRetryDelayMs` (BullMQ `backoffStrategy`).

The jitter is over the upper half of the exponential plan: a retry waits between `plan/2` and `plan`, never longer
than the configured ceiling. Both callers accept an injectable `random` so the delay is asserted deterministically, and
the "same failure does not recompute to the same instant" property is tested (`backoff.test.ts`).

### 5.2 Task 5 — an outbox claim is a lease, not a permanent reservation

`CLAIM_SQL` used to claim only `pending` rows. A worker that died after the claim committed (before the handler ran, or
after its side effects but before `MARK_PROCESSED_SQL`) left the row `running` forever: no worker could claim it, and no
operator screen lists it. The claim now writes `available_at = now() + lease` and can reclaim a `running` row whose lease
expired:

```sql
SET status = 'running', available_at = now() + make_interval(secs => $2)
WHERE status IN ('pending', 'running') AND available_at <= now()
```

- New setting: `WORKER_OUTBOX_LEASE_MS` (default 10 minutes, `outboxLeaseMs`).
- The lease must comfortably exceed the slowest event handler. A shorter lease trades silence for duplicate work;
  handlers are already required to be idempotent (AGENTS.md §5.5), and the consumer contract has always been
  at-least-once.
- Verified against the configured database in a rolled-back transaction (2026-10-29): a `running` row with an expired
  lease is claimed, a `running` row with a live lease is not, and a due `pending` row is claimed.

### 5.3 G19 — a reused id with a different body is no longer silent

Every door that stores a body hash now compares it on a redelivery, keeps the first delivery as the receipt of record,
and surfaces the mismatch without creating a second effect:

| Door | Store | Mismatch signal |
|---|---|---|
| Voice webhook | `voice_webhook_events.payload_digest` | `failure_code = DEDUP_BODY_MISMATCH` on the receipt + `bodyMismatch: true` in the ingest result |
| ESignature delivery | `signature_webhook_inbox.payload_hash` | audit action `provider.event_body_mismatch`, `outcome = refused`, `reason_safe = DEDUP_BODY_MISMATCH` |
| ESignature event | `signature_provider_events.payload_hash` | inbox receipt `last_error_safe = duplicate_event_body_mismatch` + the same audit action |

The new audit action is declared in `AUDIT_ACTIONS` and translated in both `i18n` catalogs. The provider-facing
response does not change: a duplicate is still acknowledged safely, because a provider that is told "error" retries
forever.

### 5.4 Task 7 — storage failures are rejections, not empty files

`packages/files/src/storage/index.test.ts` now asserts a missing object rejects with `ENOENT` (both `get` and
`openRead`) and that an upload whose destination cannot be created rejects instead of reporting success. This is the
local-driver equivalent of an object-store write failure.

## 6. Fault-injection matrix

| # | Failure mode | Deterministic control | Test / evidence | What it asserts |
|---|---|---|---|---|
| 1 | Timeout before/during a provider call | `failNextCall('fetchPage' / 'envelopeStatus', ProviderError TIMEOUT)` | `phase22-provider-contract.test.ts` | one stable code, retryable, next call unaffected |
| 2 | Provider accepted, response lost | fake signature provider's lost-send mode | `esignature-flow.test.ts` ("holds a lost send at send_unknown and reconciles it instead of sending twice") | no second send; reconciliation is the only path forward |
| 3 | HTTP 429 | `failNextCall(..., RATE_LIMITED, retryAfterMs)` | `phase22-provider-contract`, `phase22-journey-integrations-recovery` step 9 | named `RATE_LIMITED`, dead letter, checkpoint preserved |
| 4 | 5xx | transport status 500/503 | `esignature-docusign.test.ts` (transport mapping), `esignature-dropbox-sign.test.ts` | classified as `provider_outage`, never a raw provider string |
| 5 | Invalid credentials / expired OAuth | `failNextCall(..., TOKEN_EXPIRED)`; journey step 5 + step 14 | `phase22-provider-contract`, `phase22-journey-integrations-recovery` | authorization failure is non-retryable; a disabled connection stops calls |
| 6 | Malformed provider payload | signed but non-JSON body | `esignature-lifecycle.test.ts` | refused, nothing changes |
| 7 | Slow response / cancellation | AI fake delay + cancel | `phase22-journey-ai-controlled-actions.test.ts` step 11 | cancel is recorded, committed work stays committed |
| 8 | Provider unavailability / breaker | breaker table + five transient failures | `advanced-integrations-engine.test.ts` | circuit opens, calls are refused without touching the provider, half-open probe works |
| 9 | Duplicate webhook delivery | same body twice | `phase22-replay-contract.test.ts`, `phase22-out-of-order-events.test.ts` | one effect, safe 2xx |
| 10 | Same key, different body | same id, changed body | `phase22-out-of-order-events.test.ts` (voice), `esignature-events.test.ts` (signature) | one effect; mismatch stamped/audited (G19) |
| 11 | Out-of-order delivery | older event after a terminal one | `phase22-out-of-order-events.test.ts` | a terminal state never regresses |
| 12 | Worker crash after claim, before ack | lease in `CLAIM_SQL` | `apps/worker/src/outbox/outbox-poller.test.ts`; manual DB check §5.2 | row becomes claimable after the lease; handler must be idempotent |
| 13 | Queue/Redis unavailable | `FakeDb` throws on claim/retry write; `JobsService.enqueue` failure marks `enqueue_failed` | `outbox-poller.test.ts` ("surfaces claim failures", "keeps the loop alive when the retry write itself fails"); voice `enqueue_failed` receipt | loop survives; the durable receipt is not lost |
| 14 | DB error in bookkeeping | `FakeDb.throws` on insert/finish | `job-runner.test.ts` ("surfaces bookkeeping failures so BullMQ retries") | a failed bookkeeping write is retried, not swallowed |
| 15 | Storage upload/download failure | local driver, impossible destination / missing key | `packages/files/src/storage/index.test.ts` | rejection, no false success |
| 16 | AI approval timeout | deadline moved into the past | `ai-agent-runs.test.ts` ("expires an approval past its deadline…") | late decision refused, run `expired`, the write never happened |
| 17 | AI provider failure / partial tool / cancel | fake model error and delays | `phase22-journey-ai-controlled-actions.test.ts` step 11 | `failed` run with a category; no fabricated answer |
| 18 | Retries exhausted | `maxAttempts` reached | `outbox-poller.test.ts` ("promotes the event to failed"), `job-consumer` dead-letter log, dead-letter service tests | permanent failure is stored and visible |
| 19 | Ambiguous state after failure | checkpoint reset; dead-letter replay; lost send | `phase22-journey-integrations-recovery` steps 9/13, `esignature-flow.test.ts` | reconciliation applies authoritative state without duplicating the external action |
| 20 | User-visible failure/pending/unknown states | shared UI states + browser specs | `SharedStates.test.tsx`, `e2e/critical-paths.spec.ts` (22.15/22.16) | error, empty, denied and retry states are rendered |

## 7. Decisions recorded

### G18 — event timestamps are not the ordering authority (accepted)

Provider event time cannot be trusted as an ordering key: providers replay, batch and clock-skew events independently
of the sequence they happened in, and a provider's clock is not a contract this platform can verify. The rule that is
enforced is a state-machine rule — a terminal state never regresses — and the older-forward-move case (`in_progress`
receiving yesterday's `ringing`) stays visible in the event timeline. Turning timestamps into the ordering authority
needs a per-projection `last_event_at`, a decision about which provider's clock wins, and a migration for existing
rows; that is a product decision, not a hardening patch. **Owner:** platform; **Review:** 2026-11-30 (revisit with
22.19 concurrency work).

### G48 — resilience layer usage (partly landed, rest deferred)

`computeRetryDelay`/`decideRetry` remain unused by the queue on purpose: retry ownership (provider budget vs queue
policy) is an operations decision, and the queue's own bounded/exponential/jittered policy is now consistent with the
HTTP retry (G15). The circuit breaker *is* live and tested. The rate limiter stays opt-in until a connector declares a
capacity/refill policy — today the capability declares only a strategy name, not a budget, so wiring it would invent
numbers. **Owner:** advanced-integrations; **Review:** 22.21 (operations) with G47/G53.

## 8. Known limitations

- **No end-to-end expired-media-URL injection.** The local driver has no signed URL; S3 signing/expiry is unit-tested,
  but "the recording URL expired between notification and download" is not driven through the Omnichannel UI.
- **No operator circuit reset route.** An open circuit self-heals after `openDurationMs` (default 60 s, half-open
  probe); there is no API to close it early. That belongs with the operations runbook in 22.21.
- **No API to retry or discard a failed `jobs` row** (G21) — the recovery procedure is still "re-submit by hand".
- **Out-box backlog.** The configured development database held **279 028 `pending` outbox rows** on 2026-10-29
  (against 869 `processed`). The lease makes crash recovery correct, but it does not drain the backlog; retention and
  scheduling are 22.21 (G14).
- **Worker tests are not in the root `pnpm verify` gate** (G5); they were run with
  `pnpm --filter @carocrm/worker test`.

## 9. Recovery procedures (for failures that are not automatically repaired)

| Symptom | Automatic behavior | Operator procedure |
|---|---|---|
| Provider outage | circuit opens after 5 consecutive transient/outage/rate-limit failures; half-open probe after 60 s | wait for the probe; after fixing configuration, reset the connection's circuit (service-level today; operator route in 22.21) |
| Sync run failed mid-way | run `failed`, checkpoint preserved, dead letter `open` | fix the cause → `POST action/connections/:id/reconcile` only if a full re-sync is wanted → sync again (resumes from the checkpoint) |
| Dead letter `open` | nothing runs; it is listed per connection | inspect → fix → `POST action/dead-letters/:id/replay` (marks `replayed`, audited); it is not silently removed |
| Outbox row stuck `running` | lease expires (`WORKER_OUTBOX_LEASE_MS`, 10 min) → another worker reclaims it | none; if the handler is not idempotent, fix the handler first |
| Outbox row `failed` | dead-lettered after `WORKER_MAX_ATTEMPTS`; visible on the DomainEvent read side | inspect `last_error`, correct the consumer, re-emit the fact (the outbox is at-least-once, not a repair tool) |
| Voice receipt `enqueue_failed` | receipt is durable, not lost | `POST VoiceCommunications/action/webhook-events/:id/replay` |
| ESignature delivery `retryable`/`dead_letter` | bounded attempts, then dead-letter | operator retry through the recovery workbench (`webhook.retryRequested` is audited) |
| Failed job | `jobs` row `failed`, error/attempt trail | re-submit the job through `POST /api/v1/Job`; no retry/discard API yet (G21) |
| Storage write/read failure | upload/download rejects; no silent success | retry the upload/download; an abandoned chunked upload is removed by `system.cleanupUploads` after the expiry window |
| AI approval expired | approval `expired`, run `expired`, tool never executed | ask the assistant again — a new proposal is the only path; expired approvals cannot be revived |
| AI run failed on a provider error | run `failed` with `failureCategory`; retry is idempotent per key | re-run with a new idempotency key after the provider recovers |

## 10. Evidence

Commands run on 2026-10-29 (configured `.env` database and Redis; no database was created, reset, truncated or
deleted):

- `pnpm --filter @carocrm/worker test` → 22 files, **224 tests passed** (includes the new jitter, lease and env
  assertions).
- `npx vitest run apps/api/test/phase22-out-of-order-events.test.ts apps/api/test/esignature-events.test.ts` →
  **13 tests passed** (including the two new G19 scenarios).
- `npx vitest run apps/api/test/ai-agent-runs.test.ts` → **26 tests passed** (including the approval-expiry scenario).
- `npx vitest run packages/files/src/storage/index.test.ts` → **9 tests passed**.
- `npx tsc --noEmit -p apps/api/tsconfig.json` → clean (the root typecheck does not include tests, see G5-adjacent
  notes in the phase 22.17 doc).
- `pnpm verify` → **green**: `lint` 0 errors / 0 warnings (UI conventions 4 917 keys), `typecheck` both projects
  clean, `pnpm test` **247 files / 3 300 tests passed**, `pnpm test:web` **7 files / 31 tests passed**. A second
  `verify` run reported one failure that did not reproduce on the immediate full rerun; `sales-tracking.test.ts`
  reproduces its known G69 lot-stock failure when run solo, and this phase touches no Sales code. Recorded as the
  pre-existing flake it is, not as a 22.18 defect.
- Lease semantics checked directly against PostgreSQL inside a transaction that was rolled back: expired-lease
  `running` row reclaimed, live-lease `running` row skipped, due `pending` row claimed. No row was left behind.
