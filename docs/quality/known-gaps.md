# Phase 22 — Known Gaps and Defects

> **Date:** 2026-10-28 (opened in Phase 22.6; entries 22.0–22.5 consolidated)
> **Plan:** `PLAN_Phase_22_Integration_E2E_Hardening.md` §3.2
> **Rule:** every entry names the evidence it rests on. A gap that is not reproduced is a hypothesis, and a hypothesis is labelled as one.
> **Status vocabulary:** `Open` · `Fixed` (with the commit/test) · `Accepted` (a deliberate decision, with the reason) · `Deferred` (belongs to a later sub-phase, named)

---

## Summary

| ID | Title | Module | Severity | Status |
|---|---|---|---|---|
| G1 | No generated OpenAPI document — the API contract is not machine-verifiable | platform | Medium | Deferred (22.22) |
| G2 | Event payloads carry no `schemaVersion`, `correlationId` or `dedupeKey` | platform | Medium | Deferred (22.7) |
| G3 | `LeadConversionService` has no direct service-level test | lead-score | Low | Open |
| G4 | `advanced-integrations-contracts.test.ts` leaves two contacts behind | advanced-integrations | Low | Open |
| G5 | The worker test suite is not part of the root `pnpm verify` gate | platform | Medium | Deferred (22.22) |
| G6 | Most domain events have no registered consumer | platform | Medium | Accepted (documented) |
| G7 | Two provider-key conventions across two port families | esignature / advanced-integrations | Info | Fixed (22.6) |
| G8 | The shared core imports two business domains | platform | Medium | Accepted (allow-listed) |
| G9 | The default JWT secret is accepted in non-production environments | auth | High | Fixed (22.4) |
| G10 | The architecture guard threw a `ReferenceError` instead of reporting a violation | platform | Medium | Fixed (22.6) |
| G11 | The connector dead-letter replay route has no capability check | advanced-integrations | Medium | Open (22.17) |
| G12 | The signature webhook inbox stamps a purge date that nothing acts on | esignature | Low | Open (22.21) |
| G13 | Two provider receipt tables have no retention at all | voice-communications / marketing-automation | Low | Open (22.21) |
| G14 | The `jobs` and `job_logs` tables have no retention | platform | Medium | Open (22.21) |
| G15 | No jitter on the queue or outbox retry | platform | Medium | Open (22.18) |
| G16 | `JOB_BACKOFF_BASE_MS` is dead configuration and the two attempt settings can diverge | platform | Low | Open (22.21) |
| G17 | The CSV import keeps its per-row errors in memory only | search | Low | Open (22.9) |
| G18 | No projection compares an event's timestamp — every ordering guard is a state-machine rule | platform | Medium | Open (22.18) |
| G19 | No door detects "same idempotency key, different body" | platform | Medium | Open (22.18 / 22.19) |
| G20 | The payment provider event key is not scoped by provider | sales | Low | Open (22.19) |
| G21 | A failed `jobs` row can be neither retried nor discarded through the API | platform | Medium | Open (22.21) |
| G22 | The duplicate-job collapse looks for a status that never exists (`active`) | lead-score | Medium | Open (22.19) |
| G23 | A connector dead letter can be marked "replayed" without the failed work being re-run | advanced-integrations | Medium | Open (22.21) |
| G24 | The marketing form's Lead write is silently truncated — six fields the form writes are not Lead fields, so they are deleted | marketing-automation | Medium | Open (22.12) |
| G25 | There is no first-class campaign↔Lead link; the Lead carries only a free-text `source` | lead-score / marketing-automation | Medium | Open (22.12) |
| G26 | There is no Sales→ESignature contract; a completed signature has no consumer in the platform | sales / esignature | Medium | Open (22.9+) |
| G27 | Customer Success never creates or reads `Project`/`ProjectTask`; the only link is the plan's `projectId` | customer-success / projects | Medium | Open (22.10+) |
| G28 | The customer-success suite leaves the default onboarding template's Task behind | customer-success (test hygiene) | Low | Fixed (verified 22.11) |
| G29 | A connector webhook delivery leaves a pending durable `jobs` row that the delivering suite does not remove | advanced-integrations (test hygiene) | Low | Open (partly fixed 22.11) |
| G30 | Hard-deleting an entity leaves its `stream_items` (and attachment rows) behind as orphans | platform (Entity Engine delete) | Medium | Open (found 22.11) |

---

## G1 — No generated OpenAPI document

- **Module / contract:** platform — every `/api/v1/**` route.
- **Impact:** a client cannot be generated or checked against the API. `@nestjs/swagger` decorators exist on nearly every controller, but no `DocumentBuilder`/`SwaggerModule` setup does, and there is no global prefix or versioning — so no document is produced.
- **Expected vs observed:** expected — a spec generated from the DTOs; observed — the catalog (`docs/architecture/contract-catalog.md`) plus hand-written assertions.
- **Root cause:** the swagger decorators were added per controller; the assembly step was never added.
- **Status:** Deferred to 22.22 (CI quality gates). 22.6 compensates with DTO-shape and error-envelope assertions at the route boundary rather than a generated spec.
- **Remaining risk:** a client built from the catalog can still drift from the DTOs between releases.

## G2 — Event payloads carry no version, correlation or dedupe key

- **Module / contract:** platform — `outbox_events.payload`.
- **Impact:** cross-version tolerance and replay safety rely entirely on consumer code being additive-tolerant. There is no first-class key to dedupe on, so "was this event already handled?" has no answer inside the event itself.
- **Evidence:** `outbox_events` has only `event_type` + `payload` (`docs/architecture/contract-catalog.md` §3, Finding F2).
- **Status:** Deferred to 22.7 (idempotency, outbox/inbox, retry hardening), which will assert the envelope in replay tests. 22.6 verified the **current** rule — a consumer tolerates unknown optional fields and ignores an unknown event type (`apps/worker/src/events/domain-event-bus.contract.test.ts`).
- **Remaining risk:** a consumer written before a producer adds a field relies on that tolerance; a consumer that throws on an unexpected field would block the outbox.

## G3 — `LeadConversionService` has no direct service-level test

- **Module / contract:** lead-score → CRM records (conversion).
- **Impact:** the conversion's *route* contract is well covered (`apps/api/test/lead-score-conversion.test.ts`, `lead-score-conversion-preview.test.ts`, `lead-score-duplicates.test.ts`), but `LeadConversionService.convert` / `.affordance` / `.operationByKey` and `LeadConversionAuditService` are only exercised through HTTP.
- **Why it was not fixed in 22.6:** duplicating the same assertions at a second layer adds no evidence; the plan asks for the critical edges to be covered, not for every class to have a test.
- **Status:** Open. A service-level test is worth writing when 22.8 exercises the lead→customer journey.
- **Remaining risk:** a change to the service that keeps the route's behaviour cannot be detected separately from a route change.

## G4 — A pre-existing suite leaves two records behind

- **Module / contract:** advanced-integrations (test hygiene, not product behaviour).
- **Impact:** `apps/api/test/advanced-integrations-contracts.test.ts` creates two `Contact` records (`Protected Target`, `Record`) and its cleanup does not remove them; they were observed in the configured database after a run on 2026-10-28.
- **Status:** Open. The rows were left untouched (AGENTS.md §3.3 — cleanup only what the run can positively identify). The Phase 22.1 run-id policy (`apps/api/test/support/test-run.ts`) is the intended fix.
- **Remaining risk:** the primary database keeps accumulating `AGENT_TEST_%` rows — the 22.0 audit counted 25,847 of them.

## G5 — The worker test suite is outside the root quality gate

- **Module / contract:** platform — the test gate itself.
- **Impact:** `pnpm verify` runs the root Vitest config, which collects `apps/api/test` and `packages/*/src` only. The worker package keeps its own config (`apps/worker/vitest.config.ts`, 21 files, 215 tests), so a green `pnpm verify` says nothing about the worker's handlers — including the outbox consumer that every domain event depends on.
- **Status:** Deferred to 22.22 (CI quality gates). 22.6's consumer-contract test therefore runs under `pnpm --filter @carocrm/worker test`.
- **Remaining risk:** a regression in a worker handler is invisible to the default local gate.

## G6 — Most domain events have no registered consumer

- **Module / contract:** platform — `serviceDesk.*`, `customerSuccess.*`, `esignature.*`, `marketing.*`, `aiAgents.*`.
- **Impact:** the events are published into the outbox and the poller logs "no handler" and marks them processed. A journey that assumes "event X triggers Y" silently does nothing.
- **Status:** Accepted — documented in `docs/architecture/contract-catalog.md` §3 and §7 rather than "fixed", because the missing consumers are product features, not defects.
- **Remaining risk:** 22.8–22.14 must verify the consumer exists before a journey relies on it.

## G7 — Two provider-key conventions

- **Module / contract:** esignature and advanced-integrations.
- **Impact:** the connector registry accepts hyphen-only keys (`/^[a-z][a-z0-9-]{1,63}$/`), the signature module's keys use an underscore (`dropbox_sign`). A suite copied from one family to the other reports a false failure.
- **Status:** Fixed in 22.6 — the signature provider conformance suite uses the signature module's own convention, and the difference is documented in `apps/api/src/esignature/providers/signature-provider.contract.ts`.
- **Verification:** `apps/api/test/phase22-provider-contract.test.ts` → "is honoured by every adapter this build ships" (fake, DocuSign, Dropbox Sign).

## G8 — The shared core imports two business domains

- **Module / contract:** `acl/acl-api.service.ts` → `portal`, `projects`; `search/dashboard.service.ts` → `esignature`, `lead-score`, `projects`.
- **Impact:** the dependency direction points up, so a shared service can break when a domain changes.
- **Status:** Accepted as a reviewed exception, allow-listed in `scripts/check-architecture-boundaries.mjs` (`KNOWN_VIOLATIONS`) so the static gate fails only on **new** violations. The refactor is not part of Phase 22.
- **Verification:** `pnpm lint:arch` passes today.

## G9 — The default JWT secret

- **Module / contract:** auth — every session token.
- **Impact:** a deployment that boots without `JWT_SECRET` would accept a publicly known signing key, letting anyone forge a session.
- **Expected vs observed:** expected — refuse to boot in production; observed (before 22.4) — a silent default.
- **Status:** Fixed in 22.4 — `apps/api/src/config.ts` now refuses the default secret when `NODE_ENV=production`.
- **Verification:** `apps/api/test/config-jwt-secret.test.ts`.

## G10 — The architecture guard failed in the path it exists for

- **Module / contract:** platform — the shared-core boundary guard.
- **Impact:** `scripts/check-architecture-boundaries.mjs` built the relative path `rel` inside a block and used it outside it. The guard therefore threw a `ReferenceError` instead of reporting a violation — the guard was blind exactly when it had something to report — and it kept `pnpm lint` red, which blocked the whole quality gate.
- **Expected vs observed:** expected — a new shared-core → business-domain import is reported as a violation; observed — a `ReferenceError` (and a lint error).
- **Root cause:** the variable was declared in the "not a known violation" branch but used in the reporting branch.
- **Status:** Fixed in 22.6 — `rel` is computed once at the top of `checkFile`.
- **Verification:** `pnpm lint` (clean) and `pnpm lint:arch` (`OK: no new shared-core -> business-domain imports (known exceptions=2)`).
- **Remaining risk:** none known; the guard still allow-lists the two reviewed exceptions from G8.

---

## G11 — The dead-letter replay route has no capability check

- **Module / contract:** advanced-integrations — `POST /api/v1/AdvancedIntegrations/action/dead-letters/:id/replay`.
- **Impact:** every other route in that controller checks a capability server-side (its own header comment says so), but this one does not. Any caller who can reach the controller can mark a dead letter as replayed.
- **Status:** Open — deferred to 22.17 (security and privacy regression suite), where the authorization matrix becomes a test.
- **Remaining risk:** the replay only flips a status and writes an audit row (see G23), so the damage today is a misleading queue rather than a re-run.

## G12 — The signature webhook inbox stamps a purge date that nothing acts on

- **Module / contract:** esignature — `signature_webhook_inbox.purge_after` (90 days by default).
- **Impact:** the column is written and never read; the inbox and `signature_provider_events` grow without bound. The dedup rows are never deleted, so a late redelivery stays a duplicate — the safe side of the trade.
- **Status:** Open — deferred to 22.21 (observability and runbooks), which is where a cleanup job belongs.

## G13 — Two provider receipt tables have no retention at all

- **Module / contract:** voice-communications (`voice_webhook_events`) and marketing-automation (`marketing_provider_webhook_inbox`).
- **Impact:** the receipts accumulate. The marketing module declares a 30-day policy in `RETENTION_POLICIES` and its retention service only ever counts rows — the delete does not exist.
- **Status:** Open — deferred to 22.21.

## G14 — The `jobs` and `job_logs` tables have no retention

- **Module / contract:** platform — the durable record of every job and every attempt.
- **Impact:** the development database held 6 574 `jobs` rows. The kernel's `system.cleanupOutbox` and `system.pruneSessions` handlers exist but are **not seeded as schedules**, so nothing cleans them by default.
- **Status:** Open — deferred to 22.21 (a scheduled sweep with a retention setting is an operations decision).

## G15 — No jitter on the queue or the outbox retry

- **Module / contract:** platform — `apps/worker/src/queue/job-consumer.ts` and `apps/worker/src/outbox/outbox-poller.ts`.
- **Impact:** both backoffs are pure exponential. A fleet that failed at the same moment retries at the same moment, which is the opposite of what jitter is for. The only jittered retry in the codebase is the provider HTTP call (`advanced-integrations/resilience.ts`).
- **Status:** Open — deferred to 22.18 (resilience and chaos-lite tests), which is where the retry policy as a whole is hardened.

## G16 — Dead retry configuration

- **Module / contract:** platform — `JOB_BACKOFF_BASE_MS` and `JOB_ATTEMPTS` on the API side.
- **Impact:** the worker's `backoffStrategy` replaces BullMQ's own strategy, so the API's backoff base has no effect; and the effective attempt count is the one baked in at enqueue, so `JOB_ATTEMPTS=10` with `WORKER_JOB_ATTEMPTS=1` silently yields ten attempts.
- **Status:** Open — deferred to 22.21.

## G17 — The CSV import has no persisted per-item outcome

- **Module / contract:** search — `import-export.service.ts`.
- **Impact:** the per-row errors live in an in-memory result and are capped at 50; a re-import redoes every row, so a partially successful import cannot be resumed.
- **Status:** Open — deferred to 22.9, where the import path is exercised as a journey.

## G18 — No projection compares an event's timestamp

- **Module / contract:** platform — every state projection (signature envelope, signature recipient, voice call, voice message, marketing delivery, payment request).
- **Impact:** the ordering guards are state-machine rules, so a terminal state cannot regress — but an older event whose target is still a legal *forward* move does move the projection forward. A call that is `in_progress` today and receives a `ringing` event from yesterday becomes `ringing`.
- **Status:** Open — deferred to 22.18. Changing it means deciding what an event's timestamp *means*, which is a product decision rather than a hardening fix.

## G19 — No door detects "same idempotency key, different body"

- **Module / contract:** platform — the five provider ingresses.
- **Impact:** three of them store a body hash (`signature_webhook_inbox.payload_hash`, `signature_provider_events.payload_hash`, `voice_webhook_events.payload_digest`) and never compare it. A delivery that reuses a key with a different body is treated as a replay: the new body is discarded and nothing happens, so the platform is *safe* — but the mismatch is never surfaced to an operator.
- **Status:** Open — deferred to 22.18 / 22.19, where a quarantine path would have to be designed and its operator story written.

## G20 — The payment provider event key is not scoped by provider

- **Module / contract:** sales — `PaymentProviderEventLog.providerEventId`.
- **Impact:** the key is the provider's event id alone, so two providers sharing an id space would collide. Harmless today: only Stripe feeds the payment path.
- **Status:** Open — recorded rather than changed, because changing the key would orphan the rows already recorded.

## G21 — A failed `jobs` row can be neither retried nor discarded through the API

- **Module / contract:** platform — `apps/api/src/jobs/`.
- **Impact:** the jobs API exposes create, list, get, log and cancel. An operator who wants a failed job to run again must re-submit it by hand (`POST /api/v1/Job`), and there is no way to discard one. The admin "purge the job queue" operation drains the Redis waiting list only and leaves the table untouched.
- **Status:** Open — deferred to 22.21 (operations), together with the runbook that says what an operator should do.

## G22 — The duplicate-job collapse looks for a status that never exists

- **Module / contract:** lead-score — `lead-score-recalculation.service.ts`.
- **Impact:** the collapse filters `status IN ('pending','active')`, but a job's status is one of `pending | running | completed | failed | cancelled`. A second recalculation job can therefore be queued for the same lead while the first is still running.
- **Status:** Open — deferred to 22.19 (data integrity and concurrency).

## G23 — A dead letter can be marked "replayed" without the work being re-run

- **Module / contract:** advanced-integrations — `DeadLetterService.markReplayed`.
- **Impact:** the route flips the status to `replayed` and writes an audit row; it does not re-enqueue the failed operation, and no route ever calls `markDiscarded`. An operator reading the queue sees "replayed" for work that was never retried.
- **Status:** Open — deferred to 22.21, together with the operator API that G21 also needs.

## G24 — The marketing form's Lead write is silently truncated

- **Module / contract:** marketing-automation → CRM — the public web-form intake.
- **Impact:** `MarketingFormService.createLead` writes `companyName`, `utmSource`, `utmMedium`, `utmCampaign`, `campaignId` and `formIntakeKey` onto a `Lead`. The `Lead` entity declares none of them, and `EntityCrudService.prepareWrite` deletes every key the metadata does not declare. So the company is lost (the Lead field is `company`), the campaign and UTM reference never reach the Lead, and the form's own intake-key idempotency lookup (`attrs ->> 'formIntakeKey'`) can never match — a repeated intake with a different e-mail address creates a second Lead.
- **Expected vs observed:** expected — the intake records where the lead came from and the same intake key never creates two Leads; observed — the record keeps only `source`.
- **Root cause:** two modules disagree about the Lead's shape. The form was written against a richer Lead than the metadata declares.
- **Status:** Open — deferred to 22.12 (the marketing and acquisition journey), which is the sub-phase that owns this path. The fix is additive: declare the fields on the Lead (they need no migration, the attributes are JSONB) and write `company` rather than `companyName`.
- **Verification:** found while building the Phase 22.8 journey (`docs/quality/phase-22-journey-lead-to-customer.md` §8, F3).

## G25 — There is no first-class campaign↔Lead link

- **Module / contract:** lead-score / marketing-automation — "which campaign produced this lead".
- **Impact:** the `Lead` entity carries only the free-text `source`. The campaign↔Lead association lives outside the Lead record: `marketing_events.campaign_id`, `MarketingConsent.campaignId`, `TargetListEntry` and the journey enrollment. LeadScore reads the `marketing_events` association (its engagement signal) and ignores the campaign id, so a score cannot say *which* campaign engaged the lead.
- **Status:** Open — deferred to 22.12, together with G24: if the form's fields are declared, the Lead can carry the campaign it came from.

## G26 — There is no Sales→ESignature contract, and a completed signature has no consumer

- **Module / contract:** sales ⇄ esignature — "a quote is sent for signature" and "a signed document changes the commercial record".
- **Impact:** the two modules do not import each other, no contract adapter exists for ESignature, and the events ESignature publishes (`esignature.requestCompleted`, `esignature.completedArtifactAvailable`) have **no subscriber** anywhere in the platform. The only link that exists is the generic pair `sourceEntityType` + `sourceRecordId` a signature request stores — `signature-record-entry.service.ts` lists `Quote`, `SalesOrder` and `Invoice` as entry points, so a request *may* name a commercial record, and nothing reads that link back.
- **Expected vs observed:** expected — a signed quote reaches the order it became; observed — a signature is a fact about a document, and Sales never hears of it.
- **Status:** Open — this is a product decision rather than a defect, and it was found while building the Phase 22.9 journey (`docs/quality/phase-22-journey-quote-to-signature.md` §8, F1). The journey proves the *negative* the plan asks for (a signed document does not make an invoice paid), which holds precisely because no such path exists.
- **Remaining risk:** an installation that expects "signed ⇒ paid" or "signed ⇒ ordered" will not get it, and no diagnostic will say so.

## G27 — Customer Success never creates or reads a Project

- **Module / contract:** customer-success ⇄ projects — "the onboarding plan and the delivery project are the same thing".
- **Impact:** the only link is `CustomerSuccessPlan.projectId`, a reference written by `CustomerSuccessPlanService.create`. The health engine's facts (`loadFacts`) read no `Project` and no `ProjectTask`, no signal provider looks at one, and the Projects module never writes a Customer Success record. So completing a project milestone moves nothing in Customer Success: the profile's score, status, progress and onboarding state stay exactly where they were. That is the correct line — a delivery milestone is not a customer touch — but an installation that expects the two to move together will not get it.
- **Status:** Open — a product decision rather than a defect, found while building the Phase 22.10 journey (`docs/quality/phase-22-journey-project-customer-success.md` §8, F1). The journey proves the negative the plan asks for.
- **Remaining risk:** the same shape as G26 (no Sales→ESignature contract): a cross-module reaction that the product never promised.

## G28 — The customer-success suite leaves the default onboarding template's Task behind

- **Module / contract:** customer-success — test hygiene, not product behaviour.
- **Impact:** `apps/api/test/customer-success.test.ts` used to start the **default** onboarding playbook, whose first step is a `createTask` step named `Schedule the kickoff call` — a name without the suite's `AGENT_TEST_` marker, so the suite's cleanup could not remove it and every run left one row behind.
- **Expected vs observed:** expected — the suite removes every record it created; observed at the time — one unmarked `Task` per run.
- **Status:** Fixed (verified during the 22.11 run on 2026-10-28) — the suite now installs its own playbook template whose task step is named with the run marker (`AGENT_TEST_csm… kickoff call`) and deletes it through the API: after a full `pnpm test` the database holds **zero** live `Schedule the kickoff call` rows and the run's marked task is soft-deleted. The Phase 22.10 journey does the same by tracking the produced task's id.
- **Remaining risk:** none observed; a future change back to the shared default template would reintroduce it.

## G29 — A connector webhook delivery leaves a pending durable `jobs` row that the delivering suite does not remove

- **Module / contract:** advanced-integrations — test hygiene, plus the delivery seam itself.
- **Impact:** `POST /api/v1/integrations/webhook/:connectionId/:key` stores a durable `jobs` row before the handler runs, so a suite that deletes its connection and delivery rows but not the job leaves a `pending` row whose `target->>'providerKey'` names a provider that no longer exists. `apps/api/test/advanced-integrations-engine.test.ts` has done this on every run since 2026-10-20 (29+ rows found in the configured database, `agent-test-webhook_*`). The Phase 22.7 replay suite showed the same shape (14 rows, `agent-test-p22-*`).
- **Expected vs observed:** expected — a suite removes every row it created; observed — one pending `jobs` row per webhook delivery that the suite never dequeues.
- **Status:** Partly fixed (22.11) — `phase22-replay-contract.test.ts` now deletes `jobs where target->>'connectionId' = ${connectionId}` in its `afterAll`, the rows its earlier runs left behind were removed by exact id, and two further runs of that suite (focused and inside `pnpm test`) left **zero** `agent-test-p22-*` jobs rows. The pre-existing engine suite still leaks; the same one-line predicate is the fix in that file too.
- **Remaining risk:** orphan `jobs` rows keep accumulating, and a worker that scans the durable queue does work for connections that no longer exist.

## G30 — Hard-deleting a record leaves its `stream_items` rows behind as orphans

- **Module / contract:** platform — the Entity Engine delete path and the stream.
- **Impact:** `stream_items` is polymorphic (`entity_type`, `entity_id`) with no foreign key to `entity_records` (migration `002_stream.sql`), and nothing in the platform removes its rows when a record is hard-deleted — `apps/api/src/stream/stream-hooks.ts` only inserts. So every hard delete leaves the record's timeline behind. One `pnpm test` run on 2026-10-28 added 570 such rows across 31 entity types (152 `SubscriptionPeriod`, 68 `LeadScoreModel`, 49 `MarketingSend`, 47 `Invoice`, … , 1 `Case`); the configured database now carries 4,640 orphan `Case` rows, 13,528 `SubscriptionPeriod` and 5,127 `LeadScoreModel`.
- **Expected vs observed:** expected — either the delete path removes the record's stream rows (`stream_items` with their `stream_mentions`/`stream_attachments`) or a retention pass prunes rows whose subject no longer exists; observed — neither, so the stream tables only grow and a list of stream rows can name a record that no longer exists.
- **Status:** Open (found 22.11) — a product decision, not a test fix: either the hard-delete path deletes `stream_items`/`stream_mentions`/`stream_attachments` for that record, or a retention pass prunes rows with no surviving subject. The Phase 22.11 journey proves the test-side discipline in the meantime: it deletes its own Case stream rows by `entity_id` before deleting the Case.
- **Remaining risk:** unbounded growth in the stream tables, and a stale `entity_type`/`entity_id` pair that a future notification or stream reader could surface.
