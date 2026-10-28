# Phase 22.7 — Idempotency, Outbox/Inbox, and Retry Hardening

> **Date:** 2026-10-28
> **Plan:** `PLAN_Phase_22_Integration_E2E_Hardening.md` §12 (tasks 1–10) and its acceptance criteria
> **Depends on:** `docs/architecture/contract-catalog.md` (22.3), `docs/quality/phase-22-contract-tests.md` (22.6)
> **Status:** Implemented. The inventory and the strategy are written down, five defects are fixed, and the required scenarios that were unproven are now proven by tests.

---

## 1. What this sub-phase is about

Phase 22.7 asks one question: **can the same thing happen twice without anything happening twice?**

The platform delivers everything at least once — a provider retries, a queue re-delivers, a worker
restarts — so the illusion of exactly-once has to be built out of durable keys and unique
constraints, not out of hope. This sub-phase:

1. **inventories** every high-risk operation, with the key that makes a replay a replay and the
   constraint that enforces it (§2);
2. **records** the strategy per operation: at-least-once delivery plus a dedup key, or an
   at-most-once illusion built from a claim (§2);
3. **proves** the required scenarios that were not proven (§3);
4. **fixes** the five defects the inventory exposed (§4);
5. **records** what is still missing, so the next sub-phase does not have to rediscover it (§6).

---

## 2. The inventory (plan tasks 1 and 2)

Every row is a real operation with a real key. "Delivery" is how the work arrives; "Enforcement" is
what stops a second effect.

| Operation | Idempotency key | Enforcement (unique rule) | Delivery strategy | Ambiguous outcome | Dedup record retention |
|---|---|---|---|---|---|
| Connector webhook (Advanced Integrations) | the provider's `delivery_id` | `UNIQUE (connection_id, delivery_id)` on `integration_webhook_deliveries` | at-least-once; the receipt is written before the job is queued | n/a (the provider is not asked to act) | **Fixed in 22.7**: the row is kept, only the payload is cleared (14 d) |
| Signature provider webhook (ESignature) | the provider's event id, else a digest of envelope+type+payload hash | `UNIQUE dedup_key` on `signature_webhook_inbox` and on `signature_provider_events` | at-least-once; `MAX_PROCESSING_ATTEMPTS = 5` → `retryable` → `dead_letter` | n/a | `purge_after` stamped (90 d) — **no executor exists** (gap G12) |
| Voice / Omnichannel provider callback | the provider's event id, else a digest of type+external id+occurred at | `UNIQUE (account_key, dedup_key)` on `voice_webhook_events` | at-least-once; a rejected callback is recorded under a `rejected:` key so it cannot poison the genuine one | n/a | **none** (gap G13) |
| Marketing provider webhook | the provider's event id, else type+message+recipient+occurred at | `UNIQUE (provider, dedup_key)` on `marketing_provider_webhook_inbox` | at-least-once; the side effect runs in the same request | n/a | declared 30 d — **no executor** (gap G13) |
| Sales payment provider event | the provider's event id | **new in 22.7**: `UNIQUE` index on `attrs->>'providerEventId'` for `PaymentProviderEventLog` (migration 083) | at-least-once; the write is the decision | n/a | **none** |
| Lead conversion (LeadScore) | `operationKey` | `UNIQUE` partial index on `attrs->>'operationKey'` for `LeadConversionOperation` | at-most-once illusion: the claim is the mutex, a racing key replays the stored result | n/a | none |
| ESignature send to the provider | the send attempt token, hashed into the provider key | provider-side key; the platform keeps the attempt id | at-least-once with an **unknown outcome** | `send_unknown` + `PROVIDER_OUTCOME_UNKNOWN`; reconciliation, never a blind resend | n/a |
| Scheduled report delivery | `(schedule_id, scheduled_for_ms)` | `UNIQUE` on `report_deliveries` | at-least-once, duplicate **suppressed** | `ambiguous` → the resend is suppressed | none |
| Email send | `(email_id, recipient)` | `UNIQUE` on `email_deliveries` | at-least-once per recipient | transient SMTP errors re-throw | none |
| Subscription invoicing | the period window `(subscriptionId, periodStart, periodEnd)` | `UNIQUE` on the period identity + a `FOR UPDATE` claim on the period row | at-most-once per period; the invoice and the period write are one transaction | n/a | none |
| AI agent tool execution | `step:index:toolKey` | `UNIQUE idempotency_key` on `ai_agent_tool_calls`, claimed by a guarded update | at-most-once per tool call | n/a | none |
| Lead score evaluation | a hash of lead + model + inputs + signals | `UNIQUE` on `attrs->>'idempotencyKey'` for the evaluation | at-most-once per input set: a replay records nothing | n/a | none |
| Marketing delivery to a recipient | `ma:{sendId}:{slot}:{type}:{id}` | `UNIQUE (send_id, slot, entity_type, entity_id)` on `marketing_recipient_deliveries` | at-least-once per recipient; the claim is `FOR UPDATE SKIP LOCKED` | n/a | none |
| Voice / Omnichannel outbound message | the caller's `idempotencyKey` | `UNIQUE` partial index on `voice_messages.idempotency_key` | at-most-once per key | n/a | none |
| Inbound connector sync | `mappingId:operationType:externalId:version` | `UNIQUE idempotency_key` on `integration_sync_operations` | at-least-once with a checkpoint that advances only past a succeeded operation | provider outage → a dead letter | **Fixed in 22.7**: the payload is cleared, the key is kept (30 d) |
| Outbound connector push | the idempotency key derived from the event id | `UNIQUE` partial index on `integration_outbound_operations` | at-most-once per key | n/a | none |
| Worker job | the `jobs` row + the handler's own domain key | the caller-supplied deterministic row id (`DuplicateRecordError` on clash) | **at-least-once**: a retry re-invokes the handler, so every handler must be idempotent | the handler's own domain rules | the `jobs` table has **no retention** (gap G14) |

### The strategy in one sentence

Nothing in this platform is delivered exactly once. Every operation is either **at-least-once with a
durable dedup key** (the delivery is repeated; the key decides that the second one changes nothing)
or **at-most-once by claim** (the effect is claimed under a unique constraint before it happens, so
the second attempt loses the race and replays the stored answer). Which one applies is a property of
the operation, not of the transport — and the table above says which is which, per operation.

### The retry policy (plan task 5)

| Path | Attempts | Backoff | Jitter | Observable in |
|---|---|---|---|---|
| Queue jobs (BullMQ) | `JOB_ATTEMPTS` = 3 (API, baked in at enqueue) | exponential, capped by `WORKER_JOB_BACKOFF_MAX_MS` = 15 min | **no** | `jobs` row: `status`, `attempt`, `last_error`, `result` |
| Outbox poller | `WORKER_MAX_ATTEMPTS` = 8 | exponential, capped at 15 min | **no** | `outbox_events`: `status`, `attempts`, `last_error` |
| Provider HTTP calls | 5 | exponential to 60 s | **yes** (equal jitter, `advanced-integrations/resilience.ts`) | the module's audit trail |
| ESignature webhook delivery | 5 | handled by the inbox row's `attempt_count` | no | `signature_webhook_inbox.state` |
| Marketing delivery | `delivery.maxAttempts` = 3 | the delivery row's `attempts` | no | `marketing_recipient_deliveries.state` |

The retries are **bounded** everywhere, and the failure is **observable** in a durable row rather
than in a log line. Two policy gaps remain and are recorded in §6: no jitter on the queue and the
outbox (G15), and `JOB_BACKOFF_BASE_MS` on the API side is dead configuration (G16).

### Bulk operations with a per-item outcome (plan task 9)

A retry that redoes the whole batch is a retry that repeats the work. The operations that carry a
per-item outcome are: the marketing delivery ledger (per recipient), the inbound sync operations
(per object), the Lead Score batch rebuild (per chunk cursor, failures carried as `errorCodes`),
the ESignature webhook inbox (per delivery), the Customer Success playbook steps (per step), the
report delivery (per scheduled run) and the email ledger (per recipient). **The CSV import is the
exception** — it keeps its per-row errors in memory only, so a re-import is a full redo (gap G17).

---

## 3. The required scenarios (plan §12) — where each one stands

| Required scenario | Where it is proven | Verdict |
|---|---|---|
| Same webhook delivered at least twice | `apps/api/test/phase22-replay-contract.test.ts` (marketing, connector), `phase22-out-of-order-events.test.ts` (voice), plus the existing suites per ingress | **Proven** |
| Same job retried after the operation committed but before acknowledgement | `apps/api/test/ai-agent-runs.test.ts` ("retries a finished run exactly once per idempotency key"), `sales-subscriptions.test.ts` ("refuses to bill a period that already has an invoice"), `marketing-automation-domain.test.ts` ("returns the recorded answer for a repeated idempotency key") | **Proven per domain**; the runner's own contract (a retry re-invokes the handler) is what makes it safe |
| Worker stops after provider success but before local status update | `apps/api/test/esignature-send.test.ts` (the send is held as `send_unknown` and reconciled, never resent), `apps/worker/src/handlers/report-handlers.test.ts` (an ambiguous SMTP outcome suppresses the resend) | **Proven** |
| Provider returns timeout after potentially accepting a request | `phase22-provider-contract.test.ts` (the mapping to a stable code), `phase22-payment-provider-contract.test.ts` (a failed delivery changes nothing) | **Proven** |
| Older status event arrives after a newer event | `apps/api/test/phase22-out-of-order-events.test.ts` (a completed call stays completed), `esignature-status-mapper.test.ts` ("refuses to move a completed envelope backwards from an older event"), `voice-communications-domain.test.ts` ("never regresses a terminal call") | **Proven** — with the caveat in §6 (G18) |
| Two users issue the same conversion or send command concurrently | `apps/api/test/lead-score-conversion.test.ts` ("two keys race → one 200, one 409, exactly one Contact"), `phase22-replay-contract.test.ts` (two concurrent payment deliveries settle once) | **Proven** |
| An idempotency key reused with a different request body | `phase22-replay-contract.test.ts` ("does not apply a second body under a key it already knows") | **Proven as safe, not as detected** — see G19 |

---

## 4. The defects this sub-phase fixed

| # | Defect | Severity | Fix | Regression test |
|---|---|---|---|---|
| F1 | The marketing webhook door looked the dedup key up **before** it verified the signature, so a forged delivery that reused a known key was answered "already have it" — an oracle, and a way to occupy a genuine key | Medium | Verification moved ahead of the lookup; a rejection is recorded under its own `rejected:<digest>` key (the anti-poisoning rule the voice door already used) | `phase22-replay-contract.test.ts` → "refuses a forged delivery that reuses a known key" |
| F2 | The marketing webhook door claimed the dedup key with a `SELECT` and then an `INSERT`, so two concurrent deliveries of the same event both decided they were first and the loser answered 500 | Medium | The insert **is** the claim (`on conflict do nothing`), and the loser re-reads the winner's row | same file → "survives two deliveries of the same event arriving at the same time" |
| F3 | The Sales payment provider event had **no** unique constraint, so two concurrent deliveries could settle a request twice | High (money) | Migration `083` adds the unique index; the service claims by inserting and answers the loser as the duplicate it is | same file → "lets only one of two concurrent deliveries settle the request" |
| F4 | The connector webhook door answered a delivery that **failed verification** with 202, while its own comment said 401 — so a provider kept retrying a signature that would fail forever | Low | The door answers 401 for a rejected delivery, as documented | same file → "answers a delivery that failed verification with 401" |
| F5 | The retention purge **deleted** the rows that carry the dedup keys (`integration_webhook_deliveries`, `integration_sync_operations`), so a provider that redelivered after 14 days was applied again — the opposite of what the module's own comment promised ("only the payload it goes") | Medium | The purge clears the payload and keeps the row | the retention scenario in `advanced-integrations-contracts.test.ts` + the inventory above |

F3 is the one that mattered most: a payment request that is settled twice is money that moved twice.

---

## 5. What the doors answer (the replay contract)

Every provider door now answers the same way, and the tests hold them to it:

| Situation | Answer | Effect |
|---|---|---|
| A verified delivery, first time | 2xx, `accepted` | one receipt, one effect |
| The same delivery again | 2xx, `duplicate` | **no** second receipt, **no** second effect |
| Two deliveries at the same time | 2xx for both, one of them a duplicate | one receipt, one effect |
| The same key with a different body | 2xx, `duplicate` | the second body is discarded; no second effect |
| A delivery that failed verification | 401 (connector, voice, signature), 200 + `rejected` (marketing) | recorded as evidence; the genuine key is untouched |
| A delivery that is stale (outside the replay window) | 4xx / refused | nothing is written at all |

The last row is the one shape that is still not uniform: the marketing door answers a rejected
delivery with **200** and a `processingStatus: "rejected"`, because a provider that receives a 4xx
for a body it considers valid tends to retry forever. That is a deliberate difference, recorded
here rather than flattened.

---

## 6. What is still missing (also in `docs/quality/known-gaps.md`)

| Gap | Why it matters | Where it goes |
|---|---|---|
| G11 | The `POST action/dead-letters/:id/replay` route has **no capability check**, unlike every other route in that controller | 22.17 (security) |
| G12 | The `signature_webhook_inbox.purge_after` stamp has **no executor** — the dedup rows are never cleaned, so they grow without bound | 22.21 (operations) |
| G13 | `voice_webhook_events` and `marketing_provider_webhook_inbox` have **no retention at all** | 22.21 |
| G14 | The `jobs` and `job_logs` tables have **no retention** (6 574 rows in the development database) | 22.21 |
| G15 | **No jitter** on the queue or outbox retry — a fleet that retries at the same instant is a fleet that retries at the same instant | 22.18 (resilience) |
| G16 | `JOB_BACKOFF_BASE_MS` on the API side is **dead configuration** (the worker overrides the strategy), and `JOB_ATTEMPTS` / `WORKER_JOB_ATTEMPTS` can diverge | 22.21 |
| G17 | The CSV import keeps its per-row errors **in memory only**, so a re-import is a full redo | 22.9 |
| G18 | **No projection compares an event's timestamp.** Every ordering guard is a state-machine rule, so an older event whose target is still a legal forward move *does* move the projection forward | 22.18 |
| G19 | **No door detects "same key, different body".** Three of them store a body hash and never compare it. The effect is safe (no duplicate), but the mismatch is not surfaced | 22.18 / 22.19 |
| G20 | The payment provider event key is the provider's event id **alone**, not scoped by provider. Harmless today (one provider feeds the payment path) | 22.19 |
| G21 | The `jobs` table has **no operator API to retry or discard** a failed row; an operator re-submits the job by hand | 22.21 |
| G22 | `outstandingJob` filters `status IN ('pending','active')`, and `'active'` is **not a status a job ever has** — so the duplicate-job collapse misses a *running* job | 22.19 |

---

## 7. Evidence — commands actually run

| Command | Result |
|---|---|
| `npx vitest run apps/api/test/phase22-replay-contract.test.ts` | **8 passed** |
| `npx vitest run apps/api/test/phase22-out-of-order-events.test.ts` | **3 passed** |
| Regression sweep of the affected suites (`marketing-automation-events`, `marketing-automation-domain`, `advanced-integrations-engine`, `advanced-integrations-contracts`, `advanced-integrations-admin`, `voice-communications`, `omnichannel-ingress`, `esignature-lifecycle`) | **161 passed**, 0 failed |
| `pnpm db:migrate` | `migrations applied: 083_phase22_payment_provider_event_dedup.sql` (additive, unique index; the table had 0 rows, so no duplicate could block it) |
| `pnpm verify` | **green** — `lint` exit 0, `typecheck` exit 0, `test` 237 files / 3194 tests passed, `test:web` 5 files / 21 tests passed |
| `pnpm lint:changed` | 0 errors, 0 warnings (6 changed files) |
| `npx tsc --noEmit -p apps/api/tsconfig.json` | clean |

**Database discipline.** Everything ran against the configured primary database (`AGENTS.md` §3.1).
No database, schema or container was created; nothing was truncated or dropped; the one migration is
additive and was reviewed before it was applied. Every row the new suites created is deleted by
exact id or by run marker in `afterAll`, and the new index makes a duplicate payment event
*impossible* rather than merely unlikely.

**External effects.** None. The marketing door is a local secret, the connector door is a stub
adapter, the voice door is the in-process simulator, and the payment door is a service call.

---

## 8. Acceptance criteria (plan §12)

- [x] **High-risk operations document their at-most-once illusion / at-least-once processing strategy.** §2 names the key, the enforcing constraint, the strategy and the retention for every operation.
- [x] **Replays do not cause duplicate business records or external actions.** The replay contract in §5 is now proven by tests for the marketing, connector, voice and payment doors, and by the existing suites for the signature, lead-conversion, subscription, agent, lead-score, report, email, sync and outbound doors.
- [x] **Ambiguous results are marked `unknown` / reconciliation required, not falsely reported as success or failure.** The signature send holds an ambiguous answer as `send_unknown` and answers `PROVIDER_OUTCOME_UNKNOWN`; a report delivery that may have been accepted is marked `ambiguous` and its resend is suppressed; a payment delivery that failed changes nothing.
- [x] The required scenarios are each either proven or recorded as a gap (§3, §6).
- [x] The retry policy is bounded and observable; the two remaining policy gaps (no jitter, dead configuration) are recorded rather than silently changed.
- [x] Dead-letter handling was reviewed: the connector dead letters can be listed and replayed (the replay does not re-run the work — G23), the signature dead letters can be retried, and the BullMQ path has **no** dead-letter table (the `jobs` row is the record) — recorded in §6 (G21).

**Not done in this sub-phase (and why):** the missing jitter and the missing operator APIs are behaviour changes to the job and dead-letter surfaces, not test gaps — they belong to 22.18/22.21 with their own acceptance criteria. The timestamp-based ordering rule (G18) changes what a provider event *means*, so it needs a product decision rather than a hardening pass.
