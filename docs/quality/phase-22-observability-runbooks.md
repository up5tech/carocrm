# Phase 22.21 — Observability and Operational Runbooks

> **Date:** 2026-10-29
> **Plan:** `PLAN_Phase_22_Integration_E2E_Hardening.md` §20
> **Status:** Complete — correlation now runs request → outbox/job → worker log, log redaction is tested,
> an administrator operations snapshot exists, the platform runbook covers the eight required scenarios,
> and two tabletop walkthroughs are recorded with their test evidence. G76 (readiness is DB-only) and G77
> (no continuous metrics/tracing exporter) are accepted and explicit rather than implied.

---

## 1. Objective

Make integration failures diagnosable while keeping logs and traces safe for CRM data.

## 2. Tasks (plan §20) and status

| # | Task | Status |
|---|---|---|
| 1 | Verify request/correlation ids across HTTP, events, jobs, providers, webhooks, agent runs | **Done for HTTP → outbox → worker and HTTP → job → worker**; provider/webhook/agent modules already persist `correlation_id` (inventory §3). Module-to-module gaps are listed in G77. |
| 2 | Define structured log fields (module, operation, entity, actor, job/run, provider, retry, duration, outcome, code) | **Partly done by convention**; the logger adds `requestId`/`userId`/`tenantId`/`traceId`, and the worker/outbox/poller lines carry job/event/correlation/attempt/outcome. A field-by-field schema is documented in §3.2; enforcing it across ~150 call sites is a lint exercise, not done here. |
| 3 | Redact secrets/passwords/tokens/OAuth codes/database URLs/signatures/bodies/prompts by default | **Done and tested** (§4.1). |
| 4 | Metrics for request latency/errors, queue age/failure/retry, webhook failures/duplicates, provider health, sync outcomes, AI usage, high-risk actions | **Reuse + snapshot**: module-derived metrics (`IntegrationMetricsService`, CRM Chat observability, AI usage, ESignature operations, Voice/Omnichannel health) plus a new administrator operations snapshot (§4.2). Continuous time series is G77. |
| 5 | Use OpenTelemetry only if compatible instrumentation exists | **Decision: not added.** No exporter/backend exists, and adding one would be a second stack; correlation ids are the trace spine (§6). |
| 6 | Safe health/readiness checks | **Existing probes verified**, plus a test that they are public, cheap and secret-free (§4.3). Queue/provider depth is on demand (G76). |
| 7 | Runbooks for the eight scenarios | **Done** — `docs/runbooks/platform-operations.md`, linking the module runbooks (§5). |
| 8 | Tabletop recovery exercise (event processing + provider failure) | **Done** — two walkthroughs with commands, observed outcomes and test evidence (§7). |
| 9 | Operator actions authenticated, authorized and audited | **Verified and tabulated** (§8); the new snapshot is sysAdmin-only and read-only. |
| 10 | Log/trace retention and test-artifact handling | **Documented** (§9). |

## 3. Correlation inventory (task 1)

| Hop | Mechanism | Where |
|---|---|---|
| HTTP request → response | `x-request-id` echoed; a bounded `x-correlation-id` is honoured; CORS exposes the header | `common/request-id.ts`, bootstrap `onRequest`, `RequestContextMiddleware`, `AuthGuard` |
| HTTP → outbox event | `outbox_events.correlation_id` (migration 086) | `common/outbox.service.ts` |
| Outbox event → worker logs | poller runs the handler inside the event's request context; lines carry `eventId` + `correlationId` | `apps/worker/src/outbox/outbox-poller.ts` |
| HTTP → job | queue payload `correlationId`; the worker runs the handler inside that context and records it in the job result metadata | `JobsService`/`JobQueueService`/`job-payload`/`job-runner` |
| HTTP → provider call | `integration_sync_runs.correlation_id`, `integration_webhook_deliveries.correlation_id`, `esignature` receipt/audit `correlation_id`, `ai_agent_runs.correlation_id` | existing module schemas |
| Provider webhook → receipt → projection | module receipt + audit/event rows; the ingress sets the id from the request scope | ESignature, AdvancedIntegrations, Voice/Omnichannel, Marketing, Sales |

The id is **not trusted for authorization**; it is a log/header token, bounded to 120 printable characters
so a caller cannot forge a multi-line log line. A deployment behind a proxy should set/strip it at the
edge; the API still uses its own id when the header is absent or malformed.

### 3.2 Structured log fields

The logger's child module name is `module`; `requestId`/`userId`/`tenantId`/`traceId` are injected by
the logger hook. The fields the platform's own code uses, by convention:

- `module` — `createLogger('<module>')`.
- `requestId` — request/correlation id (automatic).
- `entityType`/`entityId` — safe record identity, never record content.
- `job`/`jobRowId`/`queueJobId`/`attempt`/`maxAttempts`, `eventId`/`eventType`, `runId`/`step`,
  `providerKey`, `connectionId`.
- `outcome`/`code`/`category`/`retryable`/`retryAfterMs`, `durationMs` where measured.
- Never a payload body, prompt, attachment, token or full URL with sensitive query values; `redactUrl`
  strips OAuth codes/states before an error path logs a URL.

A lint that *requires* every field at every call site was not introduced: it would create a large,
mechanical diff and would still not know which entity id is safe in a given module. The field list is
the contract; §4.1 proves the dangerous half (redaction).

## 4. What changed

### 4.1 Log redaction (task 3)

`packages/core/src/logger/index.ts` exports `REDACT_PATHS` and expands the pino redaction list beyond
the original six keys: top-level and one-level `apiKey`/`apiSecret`/`accessToken`/`refreshToken`/
`clientSecret`/`secret`/`password`/`token`/`authorization`/`cookie`, request headers with vendor names
(`x-api-key`, `x-api-secret`, `x-webhook-signature`, `x-docusign-signature-1`, signature, authorization,
cookie), `databaseUrl`/`connectionString`/`redisUrl`, card fields, and nested OAuth config headers.

`packages/core/src/logger/index.test.ts` builds a pino logger with the same paths behind a captured
stream and proves the values are gone while a harmless field survives. The test is the check the phase
asks for; it does not scan every existing log call site.

### 4.2 Operations snapshot (task 4)

`GET /api/v1/AdminInternal/action/operations` (sysAdmin, read-only) returns **derived counters** from
the tables the modules already trust:

- outbox/jobs by status plus oldest pending age; jobs failed in the last 24h;
- dead letters open/total;
- signature inbox states, connector delivery states, voice event processing states, marketing inbox states;
- integrations: connections by status, open circuits, sync runs failed in 24h;
- AI: pending approvals, runs failed in 24h.

No record content, address, token or high-cardinality label. It is the first page of the runbook and
the operator's alternative to a metrics backend (G77). Existing module metrics remain the deeper
per-module view: `GET /api/v1/AdvancedIntegrations/action/metrics`, ESignature operations/health,
CRM Chat observability, AI usage, Voice/Omnichannel health.

### 4.3 Health (task 6)

`/health/live` and `/health/ready` stay public, cheap and DB-only; a test asserts they answer without a
session and that the readiness body contains no connection string, credential or provider detail. They
do **not** call a provider on every probe (the rule in the plan); queue/provider depth is on demand
(G76). The earlier test suite used the wrong path (`/api/v1/health/*`, which the generic entity route
swallowed) — the phase adds the correct `/health/*` coverage.

## 5. Runbooks (task 7)

`docs/runbooks/platform-operations.md` is the index and the platform-level procedure. It covers the
eight required scenarios and links the module runbooks:

| Scenario | Platform section | Module detail |
|---|---|---|
| Stuck job | §3.1 | Admin jobs API/logs; no retry/discard API (G21) |
| Failed webhook | §3.2 | `esignature-operations.md`, `advanced-integrations.md`, `../omnichannel/runbook.md`, `marketing-provider-incidents.md` |
| Provider authentication expiry | §3.3 | `advanced-integrations.md`, `esignature-operations.md` |
| Duplicate sync conflict | §3.4 | `advanced-integrations.md` |
| Unknown signature state | §3.5 | `esignature-operations.md`; reconcile, never resend |
| Ambiguous payment/communications result | §3.6 | Sales payment log; Voice/Omnichannel receipt/replay |
| Agent partial completion | §3.7 | `docs/modules/ai-agents/operations-runbook.md`, 22.13 journey |
| Failed migration | §3.8 | `docs/operations/backup-restore.md`; never reset/truncate |

It also carries the "first five minutes" read-only commands, the correlation guide, the operator
authority/audit table, and retention.

## 6. OpenTelemetry decision (task 5)

Not added. There is no compatible exporter, collector or backend in this repository, and the plan's
rule is to avoid a second metrics/tracing system. The correlation spine (§3) plus module
`correlation_id` columns and the operations snapshot are the current observability contract; G77
records the gap and the owner decision. Adding OTel should be a deployment decision with a backend,
not a library dropped into a hardening phase.

## 7. Tabletop recovery exercise (task 8)

Both exercises were run as **operator walkthroughs against the real code paths**, with the test suite as
the simulator: no production provider was called and no shared data was reset.

### 7.1 Event-processing failure

**Scenario.** An outbox handler throws after the event was committed (a consumer bug or a downstream
outage). The row is retried with equal jitter, then dead-lettered when attempts are exhausted; the
operator must see it and decide.

**Walkthrough.**

1. Detect: the snapshot shows `outbox.byStatus.failed > 0` and `outbox.oldestPendingAgeSeconds`; the
   DomainEvent screen (`?status=failed`) shows `last_error`.
2. Correlate: the failed row's `correlation_id` matches the `x-request-id` the user reported, and its
   payload names the `entityId`/`eventType`; the worker log for that `eventId` carries the same id.
3. Decide: fix the consumer, then re-emit the fact (the outbox is at-least-once; it is not a repair
   tool). Do not delete the failed row to clear the screen.
4. Verify: the next tick processes the re-emitted event; the dead-letter row stays as evidence.

**Evidence.** `apps/worker/src/outbox/outbox-poller.test.ts` — "retries a failing handler with
exponential backoff", "promotes the event to failed once max attempts is reached", and the 22.21
"runs a handler inside the request context of the event"; **16 tests passed**. The correlation column
and the worker context are covered end-to-end by `observability-operator.test.ts`.

### 7.2 External-provider failure

**Scenario.** A connector's second page is rate-limited during a sync. The first page is applied and
the checkpoint preserved; the run fails, a dead letter opens, and the resume must not re-read the
first page or duplicate records.

**Walkthrough.**

1. Detect: the connection's runs list shows `failed`, the dead-letter list shows `open`, the
   connection's health says attention; the snapshot's `integrations.syncRunsFailedLast24h` increments.
2. Correlate: the run's `correlation_id` points at the request that started the sync; the error code
   is `RATE_LIMITED` with a safe detail, never the provider's text or a token.
3. Decide: wait for the provider's budget; do not replay the dead letter as if it were the sync. Resume
   with `POST action/mappings/:id/sync` (incremental) from the checkpoint; use `reconcile` only when a
   full re-sync is intended.
4. Verify: `records_scanned` equals the remaining records, the account count does not grow twice, the
   checkpoint moves to the end, and the dead letter remains available for an explicit replay decision.

**Evidence.** `apps/api/test/phase22-journey-integrations-recovery.test.ts` (full journey, **14 tests
passed**), especially step 9 ("a provider error stops the run, keeps the checkpoint, and shows up in
the dead letters") and step 13 (replay/dead-letter authority). The provider emits no real request; the
fake adapter scripts the 429.

**Outcome and follow-ups.** Both walkthroughs end without a destructive shortcut. The exercise
confirmed the four open operational gaps: no job retry/discard API (G21), no circuit-reset route
(G48), no continuous metrics (G77), no queue/provider depth in readiness (G76). Nothing in the
walkthrough required client-side serialization.

## 8. Operator authority and audit (task 9)

The full table is in the runbook §4. Summary:

- Reads (snapshot, internal info, domain events) are admin/sysAdmin and mutate nothing.
- Danger-zone queue purge and metadata reset require the exact typed phrase and write `schema_changes`.
- Connector dead-letter replay requires the connection-admin capability and writes the integration
  audit; ESignature webhook retry/reconcile requires the signature capabilities and writes
  `signature_audit_entries`; AI approvals require the `approval` capability and are recorded on the
  approval and run events; job cancel is recorded on the job row.
- The new operations snapshot is sysAdmin-only; `observability-operator.test.ts` asserts a regular
  account gets 403.

## 9. Retention and test artifacts (task 10)

- **Logs:** structured JSON to stdout; the deployment's collector owns rotation/retention. No log file
  is written by the platform. Credential redaction is on by default.
- **Traces:** none (OTel not added); correlation ids are retained wherever the module row keeps them
  (outbox column, receipts, audit, AI runs).
- **Jobs/outbox:** no retention yet (G14); outbox `correlation_id` is indexed partially so a trace read
  does not scan the table.
- **Audit/receipts:** module policy (signature audit and receipts are kept; operator actions are
  attributable).
- **Test artifacts:** `AGENT_TEST_` markers and exact-id cleanup; no test database, no broad delete;
  browser artifacts must be sanitized and are not committed.

## 10. Evidence

| Check | Result |
|---|---|
| `npx vitest run apps/api/test/observability-operator.test.ts` | **5 tests passed** (correlation + outbox column, over-long header refused, health probes, snapshot, 403) |
| `npx vitest run packages/core/src/logger/index.test.ts` | **1 test passed** (redaction) |
| `npx vitest run apps/api/test/jobs.test.ts apps/api/test/auth.test.ts apps/api/test/entity-crud.test.ts` | **52 tests passed** |
| `npx vitest run apps/api/test/phase22-journey-integrations-recovery.test.ts` | **14 tests passed** (tabletop provider evidence) |
| `pnpm --filter @carocrm/worker exec vitest run src/outbox/outbox-poller.test.ts src/queue/job-runner.test.ts src/queue/job-payload.test.ts` | **43 tests passed** (tabletop event evidence + correlation context) |
| `pnpm --filter @carocrm/worker test` | **228 tests passed** |
| `pnpm verify` | lint 0/0 + UI conventions 4 917 keys, typecheck both projects clean, `test:web` 7 files / 31 tests. The first `pnpm test` run hit the known G69 `sales-tracking` lot-stock flake; the immediate full rerun passed **250 files / 3 313 tests** (22.21 changes no Sales code). |
| Migration 086 | applied; `outbox_events.correlation_id` exists and is indexed |

Migration 086 (`outbox_events.correlation_id`) is additive and was applied by the test boot; no row was
rewritten or deleted.

## 11. Known limitations

- No continuous metrics/tracing exporter (G77); request latency is measured by the 22.20 script, not a
  time series.
- Readiness is DB-only (G76); queue/provider depth is on demand.
- No operator API to retry/discard a failed job (G21) or reset a circuit (G48).
- The structured-field convention is not machine-enforced across all call sites; redaction is enforced
  and tested.
- The tabletop used the deterministic test doubles, not a provider sandbox or a staged incident; it
  proves the procedure's commands and state transitions, not a live provider's timing.
