# Phase 22.3 — API / Event / Schema Contract Catalog

> **Date:** 2026-10-28
> **Depends on:** `docs/architecture/module-contracts.md` (22.2)
> **Method:** static inspection of `apps/api/src` (controllers, `GlobalExceptionFilter`, `EventBus`, `jobs` service, `sales/money/decimal.ts`) and `database/migrations/001_init.sql`. Read-only.
> **Scope:** the catalog maps each contract to producer, consumer, schema source, owner, versioning strategy, and existing test coverage. It is the **canonical** contract reference for this repository (see Finding F1).

---

## 1. API contract conventions (verified)

- **Versioning:** routes carry the `api/v1` segment in each controller `@Controller('api/v1/...')`. There is **no** global `setGlobalPrefix`/`enableVersioning` — version is a path segment, so a future `api/v2` is a new controller, not a framework version switch.
- **Error envelope** (`apps/api/src/common/global-exception.filter.ts`): every error returns
  ```json
  { "error": { "code": "VALIDATION_FAILED", "message": "<localized>", "details": { "...": "..." } } }
  ```
  Stable codes (from `codeForStatus`): `BAD_REQUEST`(400), `AUTHENTICATION_REQUIRED`(401), `AUTHORIZATION_DENIED`(403), `RECORD_NOT_FOUND`(404), `DUPLICATE_RECORD`(409), `FILE_TOO_LARGE`(413), `VALIDATION_FAILED`(422), `RATE_LIMITED`(429), `INTERNAL_ERROR`(>=500). `details.reason` carries the raw message when a catalog translation replaced it; 429 adds `details.retryAfterSeconds`. **No stack trace or raw provider error reaches the client** — only logged server-side via `redactUrl`.
- **Validation → 422:** `ValidationError` maps to 422 with `details`. Unique-constraint violations (PG `23505`) → `DUPLICATE_RECORD`(409), never 500.
- **Hook errors:** plain `Error`s from `@fastify/rate-limit`/body-parser/multipart carry only `statusCode`; the filter maps them to the matching code (so a 429 reads `RATE_LIMITED`, not `INTERNAL_ERROR`).

---

## 2. Data type conventions (verified)

- **Money:** canonical **decimal string** (`apps/api/src/sales/money/decimal.ts`). `parseDecimal` accepts only canonical strings; max `MAX_DECIMAL_DIGITS` magnitude, max `MAX_DECIMAL_SCALE` fraction digits. Serialized as a JSON string in API responses and `entity_records.attrs` — never a float. Any contract touching amounts must assert string, not number.
- **Dates:** stored/returned as `TIMESTAMPTZ` (UTC). No `updated_at` column anywhere (the Entity Engine uses `created_at`/`modified_at`). API returns ISO-8601; the SPA renders in the user timezone via `formatDateTime`. New timestamps must be UTC ISO-8601; no locale-dependent server-side formatting.
- **IDs:** UUID/text primary keys (`TEXT PRIMARY KEY`). External IDs (connector sync, provider refs) are separate string fields, not the PK.

---

## 3. Event catalog (`outbox_events`)

`outbox_events(id TEXT PK, event_type TEXT, payload JSONB, status, attempts, last_error, available_at, created_at, processed_at)`. Events are written **in the caller's transaction** (`EventBus.dispatch` → `OutboxService`), so a rolled-back mutation never publishes. `event_type` regex: `^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*){1,3}$` (2–4 dot segments, module-prefixed).

> Event payload is a single `JSONB` with **no dedicated `schemaVersion`, `correlationId`, or `dedupeKey` columns** — versioning/tracing must live inside `payload` (see Finding F2).

| event_type (sample) | Producer | Consumer (worker) | Payload carries |
|---|---|---|---|
| `entity.created` / `entity.updated` / `entity.deleted` | auto via `entity-event.hook.ts` (every record mutation) | `advanced-integrations-handlers` (when outbound-sync configured) | `entityType`, `entityId`, `changes` |
| `serviceDesk.case.created` / `.assigned` / `.statusChanged` / `.resolved` / `.closed` / `.reopened` / `.escalated` / `.merged` / `.slaBreached` / `.replySent` / `.noteAdded` | service-desk | **none** (noop/log handler) | `caseId`, `clockId?` |
| `customerSuccess.lifecycle.changed` / `.renewal.windowEntered` / `.goal.progressChanged` / `.goal.overdue` / `.plan.activated` / `.risk.created/escalated/resolved` / `.health.calculated/statusChanged/overrideSet` / `.review.scheduled` | customer-success | **none** | profile/goal/risk ids |
| `leadScore.*` (model change, threshold, conversion) | lead-score | `lead-score-handlers` (subscribes `entityType:'Lead'`) | lead id, score, band |
| `esignature.*` (request lifecycle) | esignature | **none** | request id, status |
| `marketing.*` (campaign/consent/send) | marketing-automation | **none** | campaign/send ids |
| `aiAgents.*` (run lifecycle) | ai-agents | **none** | run id |
| `advancedIntegrations.*` | advanced-integrations | n/a (it is the consumer of `entity.*`) | sync run/conflict refs |
| `system.noop` / `system.log` | worker | direct handlers | n/a |
| `hook.*` (configurable webhooks) | hooks | extension subscribers | per-config |

**Gap (recurs through 22.8–22.14):** most domain events terminate at the noop/log handler — there is **no registered subscriber** for `serviceDesk.*`, `customerSuccess.*`, `esignature.*`, `marketing.*`, `aiAgents.*`. A journey that assumes "event X triggers downstream Y" must first register/verify that consumer, or it silently no-ops.

---

## 4. Queue-job catalog (`jobs` + `scheduled_jobs`)

`jobs(id, job, status, scheduling_type, created_at, started_at, finished_at, target JSONB, result JSONB)`. `scheduled_jobs(id, job, scheduling, target, enabled, last_run_at)`. Job `name` is the `JOB_NAME` allowlist (`apps/api/src/jobs/jobs.service.ts`); retry policy from config: `jobAttempts=3`, `jobBackoffBaseMs=2000`. Dedupe/lease is worker-side (see 22.7).

| job name | Owner module | Trigger | Payload (`target`) |
|---|---|---|---|
| `sales.expireQuotes` / `markOverdueInvoices` / `generateSubscriptionInvoices` | sales | cron | `{}` |
| `customerSuccess.recalculateHealthBatch` / `expireHealthOverrides` / `evaluateRenewalWindows` / `evaluateRiskEscalations` / `evaluateReviewReminders` / `updateGoalOverdueState` / `processPlaybookWaitSteps` / `repairStalePlaybookRuns` | customer-success | cron (8 jobs) | `{}` |
| `serviceDesk.slaScan` | service-desk | cron `*/5 * * * *` | `{}` |
| `marketing.deliveryBatch` / `journeyRunBatch` | marketing-automation | cron `* * * * *` / `*/2 * * * *` | `{}` |
| `aiAgents.executeRun` / `retentionSweep` | ai-agents | cron + enqueue | run id |
| `leadScore.recalculateLead` / `batchRecalculate` / `decaySweep` / `recoverConversionOperations` | lead-score | cron + enqueue | lead id(s) |
| `esignature.processProviderWebhook` / `retrieveCompletedArtifacts` | esignature | webhook enqueue | envelope/cursor refs |
| `advancedIntegrations.notifyExpiringCredentials` / `processWebhookEvent` / `pushOutbound` / `purgeRetention` | advanced-integrations | cron + webhook | sync refs |
| `voiceCommunications.processWebhookEvent` / `fetchMedia` / `retentionSweep` / `transcribeCall` | voice-communications | webhook enqueue | call/message ids |
| `system.sendEmail` / `system.sendReminders` / `system.noop` / `system.log` | worker/platform | mail/CRON | per job |

---

## 5. Findings

### F1 — OpenAPI/Swagger is not generated (plan §8 task 3 gap)
`@nestjs/swagger` decorators (`@ApiTags`/`@ApiOperation`/`@ApiResponse`) are present on nearly every controller, but **no `DocumentBuilder`/`SwaggerModule` setup exists** and there is **no global prefix/versioning** — so no OpenAPI document is produced. Consequently the "API contract" is not machine-verifiable against DTOs today.
**Recommendation:** either (a) add a `docs:openapi` script that builds a spec from the decorators and commit it as the generated contract, or (b) treat **this catalog + `module-contracts.md`** as the canonical contract and add the DTO-shape assertions in 22.6. No code change made in 22.3.

### F2 — Event payloads lack first-class version/correlation/dedupe columns
`outbox_events` stores only `event_type` + `payload`. Cross-version tolerance and replay safety rely entirely on consumer code being additive-tolerant.
**Recommendation:** standardize a reserved envelope inside `payload` (`{ schemaVersion, correlationId, occurredAtUtc, actor? }`) and assert it in 22.7 replay tests. Optional; does not block.

### F3 — Schema/dto conventions are strong where present
Money-as-string, UTC timestamps, stable error codes, transactional outbox, and the `JOB_NAME` allowlist are all real, enforced invariants. The contract risk is **coverage and consumer-wiring**, not shape.

---

## 6. Minimum contract test matrix (plan §8) → current coverage

For each critical contract, the required negative cases and where existing tests already exercise them:

| Negative case | Where covered today | 22.6 work needed |
|---|---|---|
| Required field missing | `*-validator.test.ts`, `sales-*.test.ts` | extend to all owner APIs |
| Invalid enum / unsupported transition | `processes.test.ts`, `service-desk.test.ts`, `esignature-lifecycle.test.ts` | map to every state machine |
| Invalid/unauthorized relation ID | `acl-matrix.test.ts`, `portal.test.ts` | add cross-team/account cases |
| Record not found vs not permitted | `*-security.test.ts` | verify disclosure policy per entity |
| Field-level ACL removes/rejects | `customer-success-security.test.ts`, `projects-security.test.ts` | add to every high-risk entity |
| Stale version / optimistic concurrency | partial in `entity-crud.test.ts` | assert `modified_at` conflict → 409 |
| Duplicate idempotency key | `lead-score-duplicates.test.ts` | cover all creation commands |
| Unknown optional event field | not yet | add to 22.7 replay tests |
| Malformed webhook payload | `*-webhook*`, `omnichannel-ingress.test.ts` | assert signature + shape rejection |
| Safe decimal/date/null/attachment/relation serialization | `sales-money.test.ts` | add API-level assertion (string money) |

---

## 7. Intentional deviations / unsupported fields

- Portal user types (`portal`) are a distinct principal; some internal-only endpoints are not exposed to portal scope (enforced in `acl-api.service.ts`).
- Several provider adapter capabilities are intentionally `not implemented` (Zoom recordings, some AI integration triggers) and surfaced as "not implemented yet" rather than errors (see 22.0 inventory).
- `outbox_events` consumers for non-lead/non-outbound events are intentionally absent until a subscriber is registered.

---

## 8. Acceptance criteria (plan §8)

- [x] Contract catalog maps each contract to producer, consumer, schema source, owner, versioning strategy, and tests (§1–§4, §6).
- [x] All critical contracts have at least one positive and one negative contract test **or a documented gap** (§6).
- [x] Error codes/versioning/money/date conventions documented and verified against source (§1–§2).
- [ ] Generated OpenAPI/docs current — **N/A / not generated** (Finding F1): tracked as a gap, not a failure.
