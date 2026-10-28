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
| G11 | The connector dead-letter replay route has no capability check | advanced-integrations | Medium | Fixed (22.14, as part of G43) |
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
| G23 | A connector dead letter can be marked "replayed" without the failed work being re-run | advanced-integrations | Medium | Open (22.21; reproduced 22.14) |
| G24 | The marketing form's Lead write is silently truncated — six fields the form writes are not Lead fields, so they are deleted | marketing-automation | Medium | Fixed (22.12) |
| G25 | There is no first-class campaign↔Lead link; the Lead carries only a free-text `source` | lead-score / marketing-automation | Medium | Fixed (22.12) |
| G26 | There is no Sales→ESignature contract; a completed signature has no consumer in the platform | sales / esignature | Medium | Open (22.9+) |
| G27 | Customer Success never creates or reads `Project`/`ProjectTask`; the only link is the plan's `projectId` | customer-success / projects | Medium | Open (22.10+) |
| G28 | The customer-success suite leaves the default onboarding template's Task behind | customer-success (test hygiene) | Low | Fixed (verified 22.11) |
| G29 | A connector webhook delivery leaves a pending durable `jobs` row that the delivering suite does not remove | advanced-integrations (test hygiene) | Low | Open (partly fixed 22.11; the 22.14 journey removes its own) |
| G30 | Hard-deleting an entity leaves its `stream_items` (and attachment rows) behind as orphans | platform (Entity Engine delete) | Medium | Open (found 22.11) |
| G31 | The campaign reports answered any authenticated caller, and the event log named recipients the caller could not open | marketing-automation | High | Fixed (22.12) |
| G32 | A replayed attribution outcome double-counted the conversion and its revenue | marketing-automation | Medium | Fixed (22.12) |
| G33 | The marketing webhook "signature" is the shared secret itself, and a delivery with no timestamp is never age-checked | marketing-automation | Medium | Open (found 22.12) |
| G34 | Help retrieval read Service Desk's knowledge corpus with the caller's rights ignored | crm-chat → service-desk | Medium | Fixed (22.13) |
| G35 | The MCP-shaped tool door could commit an approval-class write with no decision anywhere | ai-agents | Medium | Fixed (22.13) |
| G36 | Three declared run and approval states are unreachable | ai-agents | Low | Open (found 22.13) |
| G37 | A user whose Case scope is `own` cannot create a Case at all | service-desk / platform ACL | Medium | Open (found 22.13) |
| G38 | `features.readTools` is declared as the gate for turns and queries and never enforced | crm-chat | Medium | Open (found 22.13) |
| G39 | A turn's own `sources` list is handed back without re-authorization | crm-chat | Low | Open (found 22.13) |
| G40 | None of the connector's five worker doors could be reached by the worker | advanced-integrations | High | Fixed (22.14) |
| G41 | The webhook job the API enqueues was refused by the door that receives it, and its domain-claim flag was dropped | advanced-integrations | High | Fixed (22.14) |
| G42 | A verified webhook answered "no events" whenever the connector did not mention a challenge | advanced-integrations | Medium | Fixed (22.14) |
| G43 | Nine connector write routes had no capability check anywhere | advanced-integrations | High | Fixed (22.14) |
| G44 | The sync checkpoint advanced only at the end of the loop, and a bounded run advanced it past records it never applied | advanced-integrations | High | Fixed (22.14) |
| G45 | Cancelling a run stopped nothing, and a cancelled run could be cancelled again | advanced-integrations | Medium | Fixed (22.14) |
| G46 | `features.connections` was stored and displayed but enforced nothing | advanced-integrations | Medium | Fixed (22.14) |
| G47 | Token refresh is implemented, serialised and tested — and no production path calls it | advanced-integrations | Medium | Open (found 22.14) |
| G48 | The resilience layer the sync path never uses: rate limiter, retry policy, `assertCallable` | advanced-integrations | Medium | Open (found 22.14) |
| G49 | `deletionPolicy: 'archive'` behaves exactly like `unlink` | advanced-integrations | Low | Open (found 22.14) |
| G50 | A mapping asked for "the connection for this provider" gets one picked by name order | advanced-integrations | Medium | Open (found 22.14) |
| G51 | The OAuth callback never compares the redirect URI its own comment claims it checks | advanced-integrations | Medium | Open (found 22.14) |
| G52 | A provider's own error text is echoed into a 401, and a credential reference points at the connection, not the credential | advanced-integrations | Low | Open (found 22.14) |
| G53 | A delivery deferred by a paused connection or a disabled module is never picked up again | advanced-integrations | Medium | Open (found 22.14) |

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
- **Status:** Fixed (22.12) — `utmSource`, `utmMedium`, `utmCampaign`, `campaignId` and `formIntakeKey` are declared `Lead` fields (JSONB attributes, so no table changed), the form writes the declared `company` instead of `companyName`, and a record-API write of any of them is refused with `MARKETING_INTAKE_FIELDS_SERVER_OWNED` because that evidence belongs to the intake. They are shown in the Lead detail view's `Acquisition` panel — which the platform's own guard (`lead-score-schema.test.ts`) requires, because every `inDetail` field has to be placed rather than quietly dropped from the view.
- **Verification:** found while building the Phase 22.8 journey (`docs/quality/phase-22-journey-lead-to-customer.md` §8, F3); proven by the Phase 22.12 journey step 2 (`docs/quality/phase-22-journey-marketing-consent-attribution.md`).

## G25 — There is no first-class campaign↔Lead link

- **Module / contract:** lead-score / marketing-automation — "which campaign produced this lead".
- **Impact:** the `Lead` entity carries only the free-text `source`. The campaign↔Lead association lives outside the Lead record: `marketing_events.campaign_id`, `MarketingConsent.campaignId`, `TargetListEntry` and the journey enrollment. LeadScore reads the `marketing_events` association (its engagement signal) and ignores the campaign id, so a score cannot say *which* campaign engaged the lead.
- **Status:** Fixed (22.12) — `Lead.campaignId` is now a declared link to `Campaign`, audited and written only by the intake, so "which campaign produced this lead" is a fact on the Lead and a filterable reference rather than a join through the event log. The direction stays one-way (a Lead names one campaign); a campaign's Leads are read by filtering the Lead list, and `marketing_events` remains the touch-level record.

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

## G31 — The campaign reports answered any authenticated caller

- **Module / contract:** marketing-automation — `GET action/campaign/:id/log`, `/stats`, `/attribution`, `/funnel`.
- **Impact:** these four routes went straight to aggregates over `marketing_events` with no check that the caller may read the campaign at all, and the event log returns each recipient's record id and address digest. A marketer on another team could page through a campaign they cannot open and enumerate whose records it mailed — while the sibling report (`action/send/:id/recipients`) had applied record ACL from the start, and `docs/marketing-automation/metrics.md` §2 already promised "access is the campaign's own record ACL — a report never reveals a recipient the caller could not open". The code did not match its own documentation.
- **Expected vs observed:** expected — a report answers to the campaign's read grant and names only recipients the caller may open; observed — an authenticated stranger got the whole log, and a caller with no Contact rights still got Contact ids and digests.
- **Root cause:** the report services were written against the event table, not against the record; no shared gate existed to point them at.
- **Status:** Fixed (22.12) — `marketing-report-access.service.ts` answers to the Campaign's record-level read grant and all four reports call it; the event log masks the recipient type, id and digest for records the caller cannot open and counts them in a `hidden` field, exactly as the recipient ledger does. Proven in the Phase 22.12 journey step 11 (an outsider sees counted-not-named rows; a caller without campaign rights is refused).
- **Remaining risk:** none for these four routes; the same "reports must answer to the record's own grant" rule should be applied when new aggregate endpoints are added.

## G32 — A replayed attribution outcome double-counted the conversion

- **Module / contract:** marketing-automation — `POST action/attribution`.
- **Impact:** the door that lets another module report "this campaign's work converted" inserted a `conversion` event unconditionally. The same `correlationId` arriving twice — a retried job, a replayed handler, an operator pressing again — counted the conversion twice and added its amount to `influencedRevenue` twice, so the report a marketer acts on could be inflated by nothing but a duplicate request. Phase 22.7 gave every other door an atomic claim; this one was not in its scope.
- **Expected vs observed:** expected — one outcome per correlation id, and a replay answered as the duplicate it is; observed — two rows, two conversions, double revenue.
- **Status:** Fixed (22.12) — migration `084_phase22_marketing_attribution_dedup.sql` adds the partial unique index `uq_marketing_events_internal_attribution` (internally-recorded conversions that name a correlation id, scoped by campaign), and `recordAttribution` now makes the write itself the decision: an insert that loses the race re-reads the winner and returns `duplicate: true`. An outcome without a correlation id is a different fact each time and still stands. Proven in the Phase 22.12 journey step 9.
- **Remaining risk:** attribution is scoped by campaign by design — crediting the same outcome to two campaigns remains two intentional rows, not a duplicate.

## G33 — The marketing webhook signature is the shared secret, and freshness is optional

- **Module / contract:** marketing-automation — `POST webhook/:providerKey` (and its `webhooks/` alias).
- **Impact:** `MarketingEventIngestionService.verifySignature` compares the `x-webhook-signature` header **to the configured secret itself** — it is not a signature over the payload. The door therefore cannot prove the body was not altered in transit, and because the five-minute replay window is only consulted when the caller sent an `x-webhook-timestamp`, a captured request without that header can be replayed at any later time and is recorded as a fresh delivery. The platform's other provider doors do it differently: Voice and ESignature sign `timestamp + body` and verify with a constant-time HMAC comparison.
- **Expected vs observed:** expected — the door verifies a body-bound signature and refuses a stale delivery whether or not the caller volunteered a timestamp; observed — the secret itself is the credential, and an omitted header skips the age check.
- **Verification:** found while building the Phase 22.12 journey, whose step 6 asserts today's behaviour (a 2020-dated `open` event with no timestamp header is processed).
- **Status:** Open — the fix changes what every provider adapter must send (a per-event HMAC), so it belongs with the provider-binding work rather than to a journey; the assertion is left in place so the behaviour cannot drift further without a failing test.
- **Remaining risk:** a leaked request (proxy log, support attachment) is a reusable credential for as long as the secret stays valid, and a replayed bounce or complaint can suppress an address that never asked for it.

## G34 — Help retrieval read Service Desk's knowledge corpus with the caller's rights ignored

- **Module / contract:** crm-chat → service-desk — `GET action/help/search`.
- **Impact:** `CRMChatHelpService.searchKnowledgeBase` took `KnowledgeBaseService.portalArticles()` — which selects `entity_records` rows directly, filtered to published, non-internal, in-date — and returned each hit's title, summary and record id to any caller holding `use` plus the `helpRetrieval` flag. The same caller asking `GET /api/v1/KnowledgeArticle/<id>` was refused: the corpus is *portal-safe by state*, which is not the same question as *readable by you*, and Chat answered the second question with the first answer. The handbook half of the same route was already per-caller, because it goes through `DocsService`.
- **Expected vs observed:** expected — a cross-module read through Chat grants the caller nothing they could not get directly (AGENTS.md §5.3, plan §13.6 step 4); observed — ids, titles and summaries of records the caller may not open.
- **Status:** Fixed (22.13) — each knowledge hit is re-read under the caller's own record ACL and dropped silently when it fails, which is the rule the citation builder already applied to CRM records. Proven in the Phase 22.13 journey step 4: the entitled caller sees the article, a caller without `KnowledgeArticle: read` sees handbook pages only.
- **Remaining risk:** the drop is silent, so a user who *should* have seen an article sees a shorter answer rather than a reason — the same trade the citation path makes, deliberately, because a reason is a disclosure.

## G35 — The MCP-shaped tool door could commit an approval-class write with no decision anywhere

- **Module / contract:** ai-agents — `POST action/mcp/call`.
- **Impact:** the door checked the caller's `use` capability, that the tool was enabled, and that the arguments fitted its schema — then executed the handler. For a read tool that is exactly right. For `crm_update_record_fields`, whose registry entry says `material_write` and `requiresApproval: true`, it meant a single caller could commit the write that the run pipeline will only perform after one person proposes and a *different* right decides. The caller's record ACL still governed, so nothing was reached that a plain `PATCH /api/v1/Case/:id` would not have reached — what was bypassed was the decision and its trace: no run, no `ai_agent_approvals` row, no tool-call ledger.
- **Expected vs observed:** expected — an effect class that demands a human decision demands it on every door (plan §13.6 acceptance: proposed and executed states are distinct); observed — one door where they collapsed into one caller.
- **Status:** Fixed (22.13) — the door refuses a tool whose registry entry or the instance's `approval.requireFor` list demands a decision, with `AI_TOOL_APPROVAL_REQUIRED` naming the run pipeline as the path that can carry one. Proven in the Phase 22.13 journey step 12, which also shows a read through the same door still stops at the caller's own record rights.
- **Remaining risk:** a client that used this door for writes gets a refusal rather than a silent downgrade; nothing in the SPA does, and the door's own documentation now says what it will not do.

## G36 — Three declared run and approval states are unreachable

- **Module / contract:** ai-agents — `RUN_STATUSES` and the approval decision vocabulary; `docs/quality/phase-22-journey-ai-controlled-actions.md` F3.
- **Impact:** `partially_succeeded`, `waiting_for_input` and the `changes_requested` decision are in the schema checks, the route filters and the SPA's vocabulary, and no runtime path writes them. A run that stopped after committing one effect is reported `canceled`, which is true of the stopping but not distinguishable, at the status field, from a run that stopped having done nothing.
- **Expected vs observed:** expected — every state an operator can filter on is one some path can produce; observed — three are reachable only through a database write.
- **Status:** Open (found 22.13) — the honest alternatives are to produce them (`provideInput`/`resume` exist and wait only for a runtime that can park a run, and a review-decision with changes requested needs a re-propose path) or to retire the vocabulary; either is a product decision with an API-shape consequence, so it is recorded rather than silently narrowed. The journey asserts the inspectable truth instead: the tool ledger and timeline say exactly which effects committed.
- **Remaining risk:** a dashboard filters for "partially succeeded" and reports an empty result as though nothing ever went partway.

## G37 — A user whose Case scope is `own` cannot create a Case at all

- **Module / contract:** service-desk write guard × the Entity Engine's own-scope assignment — `POST /api/v1/Case` as a non-administrator.
- **Impact:** with `Case: { create: 'yes', read: 'own' }`, `prepareWrite` stamps `assignedUserId` into the create so the new record is visible to its creator at all, and the guard refuses any client write that changes `assignedUserId` by name — so the create answers `422 …These fields on Case are set by the Service Desk module and cannot be written through the record API: assignedUserId`. The user did not ask for that field; the platform set it for them. The practical result is that a deployment gives its agents `Case: read all` to let them create at all, which is the opposite of least privilege.
- **Expected vs observed:** expected — an own-scoped create succeeds and lands owned by its creator; observed — a refusal naming a field the caller never sent.
- **Status:** Open (found 22.13) — reproduced in the Phase 22.13 journey's setup and worked around by scoping the journey's limited user to Cases they may read but not create. The fix belongs to the guard's rule (accept an own-scope assignment that names the creator, refuse anything else), and it needs the queue-routing semantics decided: a newly created Case is exactly what routing wants to place.
- **Remaining risk:** least-privilege roles keep being widened in practice rather than fixed in the guard.

## G38 — `features.readTools` is declared as the gate for turns and queries and never enforced

- **Module / contract:** crm-chat — `POST action/turns`, `POST action/query/execute`, and the route table in `crm-chat-contract.ts`.
- **Impact:** the contract names `readTools` as the feature those two routes require, and `CRM_CHAT_ROUTES` is pinned against the served routes — but the only thing the turn path consults is assistant readiness (which reads the *AIAgents* execution flags), and the query route only checks the workspace plus `use`. An administrator who switches "Grounded CRM answers" off still gets answers built from live CRM records. The flag is real for write actions, which chain through `actionProposals` → `readTools`, so the one path that does honour it is the one that needs it least.
- **Expected vs observed:** expected — a capability switch the operator can see is a switch the server enforces; observed — decorative for the two routes that most define the product.
- **Status:** Open (found 22.13) — enforcing it is a one-line `assertFeature` on two routes, but it is a behaviour change for every deployment that left the flag off while the code ignored it, so it needs the deliberate decision (and the documentation that goes with it) rather than arriving inside a hardening journey. The Phase 22.13 journey therefore proves the boundary that *is* enforced — the record ACL in step 3 — and does not rely on the flag.
- **Remaining risk:** a compliance answer of "we disabled grounded answers" is not true.

## G39 — A turn's own `sources` list is handed back without re-authorization

- **Module / contract:** crm-chat — `GET action/turns/:id`.
- **Impact:** the turn status returns the run's `result` as recorded, and `sources` there are the raw `entity:id` references collected from the tool ledger at answer time. The citation builder re-reads each record under the caller's current ACL and drops what fails; this field does not, so a record that was readable when the answer was given and has since been revoked continues to appear as `Account:<id>` in the turn's own result. Visibility is bounded (the initiator, or a holder of `AIAgentAudit: read`), and what is disclosed is a reference to a record the reader once could open, which is why this is Low.
- **Expected vs observed:** expected — one rule for "may this caller see this record", applied on every read; observed — two rules, one re-read and one replayed from the stored answer.
- **Status:** Open (found 22.13) — recorded rather than fixed here because the fix is a small behaviour change (a silently shortened list) that should match how citations already behave, and the journey asserts the citation half, which is the surface the SPA renders.
- **Remaining risk:** a long-lived turn keeps naming records its reader may no longer open.

## G40 — None of the connector's five worker doors could be reached by the worker

- **Module / contract:** advanced-integrations — `POST action/outbound-event`, `action/process-webhook-event`, `action/push-outbound`, `action/notify-expiring-credentials`, `action/purge-retention`.
- **Impact:** the section these routes live in says, in its own comment, that the worker has no session so `@Public()` skips session authentication and the shared `x-worker-secret` is the authorisation. Four of the five routes (all but `action/dead-letters/:id/replay`'s neighbours) carried no `@Public()` decorator, so a session guard refused the worker before `assertWorkerSecret` was ever reached: `401 AUTHENTICATION_REQUIRED`. Every job in `ADVANCED_INTEGRATIONS_JOB_NAMES` is an HTTP proxy to one of those doors, so the whole asynchronous side of the module — a verified provider callback becoming a CRM record, an outbound push, the expiring-credential sweep, the retention purge — could not run in any deployment. Nothing noticed because every existing suite called the *services* directly, and the worker's own tests inject a fetcher instead of hitting the API.
- **Expected vs observed:** expected — the worker posts the payload the API handed it and gets an answer; observed — a refusal that names no capability, because the request never reached the capability check.
- **Status:** Fixed (22.14) — `@Public()` on all five doors, with the constant-time shared-capability comparison left as the only authority. Proven in the Phase 22.14 journey step 12, which reads the `jobs` row the ingress itself created and posts *that* to the door: no secret → 401, wrong length secret → 401, right secret → the event is applied.
- **Remaining risk:** the doors are now reachable, so a leaked `REPORT_WORKER_SECRET` can drive them; that is the documented worker contract (ADR 0003) and it is the same capability every other module's door uses.

## G41 — The webhook job the API enqueues was refused by the door that receives it

- **Module / contract:** advanced-integrations — `WebhookIngressService.receive` → `advancedIntegrations.processWebhookEvent` → `action/process-webhook-event`.
- **Impact:** the ingress put `kind` (the routing segment the provider used) into the job payload; the door parses that payload with `WebhookProcessSchema`, which is `.strict()` and does not declare `kind`. The worker forwards `context.data` verbatim, so every delivery failed with `400` at the door — one more way for a verified event to die between the API and the CRM. And `handled`, which the schema *does* accept and `processDelivery` honours (a domain service already claimed this event, so the generic mapping must not apply it a second time), was never passed on by the door — the guard was unreachable from the queue.
- **Expected vs observed:** expected — the payload one component enqueues is the payload the next component accepts; observed — a producer and a consumer of the same contract disagreeing by one field in each direction.
- **Status:** Fixed (22.14) — the enqueued payload carries exactly the fields the door accepts, and the door passes `handled` through. Journey step 12 proves both halves: a delivery a domain claimed answers `handled_by_domain` and leaves the record alone.

## G42 — A verified webhook answered "no events" whenever the connector did not mention a challenge

- **Module / contract:** advanced-integrations — the ingress's endpoint-validation branch.
- **Impact:** `if (verification.challenge !== null)` was read as "this was a challenge", but a verification helper that returns only `{valid, reason}` yields `undefined`, which is `!== null`. So any connector whose `verifyWebhook` did not spell out `challenge: null` had every verified delivery answered as an empty event list: HTTP accepted, nothing recorded, nothing applied. The failure is silent in exactly the direction operators cannot see — the provider is told 202 and the CRM never changes.
- **Expected vs observed:** expected — absence of a challenge means there was no challenge; observed — absence of a challenge *is* a challenge.
- **Status:** Fixed (22.14) — the branch now tests the value, not its absence. The journey's connector returns the helper's result spread with an explicit `challenge: null`, so both readings are covered.

## G43 — Nine connector write routes had no capability check anywhere

- **Module / contract:** advanced-integrations — `POST action/mappings`, `PATCH action/mappings/:id`, `action/mappings/:id/activate`, `…/retire`, `…/sync`, `POST action/runs/:id/cancel`, `POST action/conflicts/:id/resolve`, `POST action/dead-letters/:id/replay`, plus the read-only `…/preview`.
- **Impact:** the controller's header states the rule — every route checks a capability server-side, and each capability is checked by exactly one service, "so a route cannot drift from the matrix". For nine routes the matrix and the route had already drifted: neither the controller nor the service behind it asserted anything. A role holding only `AdvancedIntegrations: read` could create and activate a mapping, start a sync — which writes CRM records under the **connection's** authority, not the caller's — cancel a run, decide a conflict (choosing which side a record keeps) and mark a dead letter replayed. That last one is G11, which this entry subsumes.
- **Expected vs observed:** expected — a write on a connection is connection administration; observed — a read right was a write right.
- **Status:** Fixed (22.14) — the eight writes assert `connectionAdmin` at the controller (the seam an operator crosses, so no internal system path is affected) and `preview` keeps `use`, because a dry run writes nothing. Journey step 2 walks all eight with a viewer-only token and expects `403` on each, then makes the same calls as an operator and requires the refusal to come from the domain rather than from the permission layer.
- **Remaining risk:** the module still has no narrower "who may decide a conflict" rule than `connectionAdmin`; a deployment that wants four-eyes on conflicts needs a new capability, not a new assertion.

## G44 — The sync checkpoint advanced only at the end of the loop, and a bounded run advanced it past records it never applied

- **Module / contract:** advanced-integrations — `SyncOrchestrator.runInbound`, `integration_sync_checkpoints.cursor_value`.
- **Impact:** two faces of one missing rule. First, the cursor was written once, after the page loop finished, so an interruption — a provider error on page 40, a cancelled run, a dying process — discarded the progress of 39 applied pages, and the next run re-read every one of them; the table's own comment ("it advances only past an operation that succeeded") described the intent, not the code. Second, a run stopped by `maxRecords` in the middle of a page still advanced the cursor to the end of that page, so the records after the cut were recorded as behind the checkpoint and were never read again — silent, permanent data loss with a green run row.
- **Expected vs observed:** expected — the cursor names the last thing this process committed; observed — it named a page the process had half-read, or nothing at all.
- **Status:** Fixed (22.14) — the cursor is written per page, only when the page was consumed whole, and the budget is applied to the page before the cursor moves. Journey steps 8–10 pin all three behaviours: a rate-limited page 2 leaves `off:2` behind and the resume run reads the rest; a `maxRecords` stop inside page 2 leaves the cursor at the end of page 1, so the half-read record is read again (five records, not four) and still produces one CRM record; a cancelled run's cursor matches the pages it applied.
- **Remaining risk:** a run that fails *between* the last record of a page and the cursor write re-reads that page on resume. That is the correct direction to be wrong in — at-least-once reading against an idempotent apply — and step 7 proves the apply is idempotent.

## G45 — Cancelling a run stopped nothing, and a cancelled run could be cancelled again

- **Module / contract:** advanced-integrations — `SyncOrchestrator.cancelRun` and the run loop.
- **Impact:** `cancelRun` wrote `status = 'cancelled'` and its comment promised the run "stops at the next record boundary". The loop never read the row again, so the promise was prose: an operator pressed cancel, the answer said `cancelled`, and the run went on calling the provider and writing records until it finished — while the row that said `cancelled` was then overwritten by the loop's own final status. Cancelling an already-cancelled run was also accepted, because only `completed` and `failed` were treated as finished.
- **Expected vs observed:** expected — a cancellation the operator sees is a cancellation that takes effect, and a terminal run is not cancellable twice; observed — a status the loop silently replaced.
- **Status:** Fixed (22.14) — the loop asks once per page whether it was cancelled and stops there, keeping the counts of what it already applied, and `cancelled` joins `completed`/`failed` as a state that refuses a second cancel. Journey step 10 cancels from *inside* the run — the connector's page hook calls the cancel route while the loop is between pages — and asserts `cancelled`, two records scanned, `off:2` in the checkpoint, and a continuation run that reads the remaining five without duplicating anything.
- **Remaining risk:** the boundary is a page, not a record, so a cancel waits for the current page's round-trip. That is the documented contract now and the page size is the operator's knob.

## G46 — `features.connections` was stored and displayed but enforced nothing

- **Module / contract:** advanced-integrations settings — `features.connections`, `AdvancedIntegrationsHealthService`, `docs/runbooks/advanced-integrations.md` §12.
- **Impact:** the schema's own comment calls it "the connection control plane", and the runbook's disable plan tells an operator to turn the module's features off (`connections`, `oauth`). `oauth` is enforced (the flow refuses with a named feature); `connections` was read in exactly one place — the health report describing itself. So the documented way to stop the module stopped nothing, and the health report said "off" to an operator who believed it.
- **Expected vs observed:** expected — a switch an operator can see is a switch the server enforces; observed — the control plane kept accepting writes.
- **Status:** Fixed (22.14) — creating a connection is refused while the flag is off, naming the feature; reads, diagnostics and the existing connections keep answering, which is what the runbook says a disabled module does. Journey step 14 asserts refusal, the health report, and that re-enabling restores the write. Provider calls per se are gated by the connection's own state (`paused`, `revoked`, `reauthorization_required` are never permission to call), which step 14 also proves with the connector's own call counter.
- **Remaining risk:** there is still no single "stop everything" switch — the module's kill switch is pause-the-connection plus features-off, and G53 records what happens to work already queued behind them.

## G47 — Token refresh is implemented, serialised and tested — and no production path calls it

- **Module / contract:** advanced-integrations — `OAuthFlowService.refresh`, `ConnectorExecutor.buildContext`.
- **Impact:** `refresh()` takes an advisory lock per connection, re-checks under that lock whether another worker already rotated the token, stores the new pair and moves the connection to `reauthorization_required` if the provider refuses. It is correct and it is concurrency-safe. Nothing calls it: the only caller in the repository is `apps/api/test/advanced-integrations.test.ts`, and the executor reads the stored access token and hands it to the adapter without consulting its expiry. So a token that expires in the middle of a working day leaves the connection `connected`, every provider call failing, and no path marks it as needing reauthorization from a live authorization error — the operator finds out from failed runs, not from the connection's state.
- **Expected vs observed:** expected — an expiring grant is refreshed before it is used, or the connection says so; observed — an expiry notice job exists (`features.expiryNotices`, `notifyExpiringCredentials`) that warns a human days ahead, and nothing else.
- **Status:** Open (found 22.14) — the journey calls the service directly to prove the mechanism works and says so in the step, because pretending a route exists would be worse than recording that it does not. Wiring it up is a decision with a cost: refreshing inside the executor means a provider round-trip and a credential rotation in the middle of every call, and mapping an adapter's `authorization` failure to `reauthorization_required` changes what a deployment sees after an outage. Both belong in the connector-operations sub-phase, not smuggled into a hardening journey.
- **Remaining risk:** a deployment whose provider issues short-lived tokens needs the expiry notice to be enough, and today it only produces a notification.

## G48 — The resilience layer the sync path never uses

- **Module / contract:** advanced-integrations — `resilience.ts` (`ProviderRateLimiter`, `decideRetry`, `computeRetryDelay`) and `assertCallable` in the domain.
- **Impact:** the rate limiter is wired into the executor behind `options.rateLimit`, and no caller anywhere passes that option — `runInbound`, the webhook paths, the outbound push and the controller's own calls all use `executor.call(id, fn)`. So `integration_rate_limit_buckets` stays empty and a connector that documents `rateLimitStrategy: 'provider_header'` is throttled only by the provider's own refusal. `decideRetry`/`computeRetryDelay` — the bounded, jittered backoff the engine tests assert to the bit — are imported and re-exported by the orchestrator and never called by production code: the retry policy lives in the queue (`attempts`, exponential backoff) and in a hardcoded `attempts >= 5` in the outbound path. `assertCallable`, the domain's own rule about which states may call a provider, is exported and never used; the executor re-implements the same rule inline with different wording.
- **Expected vs observed:** expected — a declared capability and a tested policy that nothing consults is a bug waiting for the day somebody trusts it; observed — the circuit breaker *is* live (it is the one part of `resilience.ts` the executor uses unconditionally), which is why the gap is easy to miss.
- **Status:** Open (found 22.14) — recorded, not patched: passing `rateLimit` from the connector's declared strategy, or moving the queue's retry maths onto `decideRetry`, changes the timing of every deployment's syncs and needs a decision about who owns retries (provider budget, queue policy, or both). The journey asserts what is genuinely enforced instead — the breaker refuses through a poisoned connection, and a rate-limited page produces a named `RATE_LIMITED` failure with a dead letter.
- **Remaining risk:** `docs/compatibility/advanced-integrations/provider-matrix.md` describes rate-limit strategies per connector; a reader can reasonably conclude the platform obeys them.

## G49 — `deletionPolicy: 'archive'` behaves exactly like `unlink`

- **Module / contract:** advanced-integrations — `DELETION_POLICIES` and `SyncOrchestrator.applyDeletion`.
- **Impact:** three policies are declared and validated (`unlink`, `archive`, `ignore`) and the implementation branches only on `ignore`; everything else takes the unlink path. The docstring promises the record is archived. An operator who chose archive to keep an audit trail of provider-side deletions gets an unlink and a live record, and nothing says the choice was not honoured.
- **Expected vs observed:** expected — a policy the API validates is a policy the engine implements; observed — two of three names mean one behaviour.
- **Status:** Open (found 22.14) — a one-branch change (set `deleted_at`/archive state instead of only removing the link), but it changes what a CRM record looks like after a provider delete, which is a product decision with a restore path attached. The journey covers the `unlink` behaviour that exists.
- **Remaining risk:** compliance answers built on "we archive what the provider deletes" are wrong.

## G50 — A mapping asked for "the connection for this provider" gets one picked by name order

- **Module / contract:** advanced-integrations — `POST action/mappings` and its `resolveConnectionId` helper.
- **Impact:** the request names a provider, and the helper lists the caller's connections and takes the **first one whose provider key matches**, ordered by `provider_key, name`. A deployment with two connections to one provider (a sandbox and a production tenant; a revoked one awaiting deletion and a live one) silently binds the mapping — and therefore every sync and every webhook apply — to whichever name sorts first. A revoked connection sorts as easily as a live one.
- **Expected vs observed:** expected — the caller chooses, or the platform chooses a *usable* connection and says which; observed — an ordering accident decides where CRM records come from.
- **Status:** Open (found 22.14) — the journey works around it by keeping exactly one live connection per provider and deleting the ones it revokes, and records the workaround in its findings. The fix is an explicit `connectionId` on the mapping request, which is an API-shape change (and a metadata/migration question for existing mappings that only carry a provider key).
- **Remaining risk:** a mapping bound to the wrong tenant reads real records from the wrong account.

## G51 — The OAuth callback never compares the redirect URI its own comment claims it checks

- **Module / contract:** advanced-integrations — `AdvancedIntegrationsOAuthCallbackController` header comment and `OAuthFlowService.complete`.
- **Impact:** the controller states that the returning redirect URI is compared with the one stored on the state row. `complete()` takes `{state, code, error}` and has no redirect input at all, so nothing is compared. The state row is single-use, hashed, short-lived and bound to a connection and an initiating principal, which is what actually stops a replay — but the provider-facing binding an operator is told about (register the exact redirect) is not enforced by the platform.
- **Expected vs observed:** expected — either compare it, or stop documenting it; observed — documentation of a check that is not there.
- **Status:** Open (found 22.14) — closing it properly means sending `redirectUri` on the exchange (providers validate it against the registered value) or dropping the claim from the comment; the second is honest and the first is what a real OAuth client does, so it belongs with the OAuth wiring in G47 rather than arriving half-way here.
- **Remaining risk:** a mis-registered redirect produces a provider-side error the platform reports as a generic authorization failure (`AUTHORIZATION_FAILED`), which is accurate but not actionable.

## G52 — A provider's own error text is echoed into a 401, and a credential reference points at the connection, not the credential

- **Module / contract:** advanced-integrations — `OAuthFlowService.complete` failure branch; `ConnectionLifecycleService` credential bookkeeping.
- **Impact:** when the provider returns an `error` on the callback, the refusal message interpolates the provider's string — and that string is the one place an OAuth error response sometimes carries a code or a token fragment, which then reaches the operator's browser and whatever logs the message. Separately, `credential_reference_id` is written as the **connection's own id** rather than the credential row it is meant to reference, and it is not cleared when the credential is revoked, so the "reference" is a pointer that never pointed at anything and keeps pointing after the thing is gone; the module's own `secretHint()` helper (first two characters, mask, last two) is exported and never used, so an operator sees the credential *kind* and no recognizable hint.
- **Expected vs observed:** expected — a refusal that carries a stable code and never the provider's raw words; a reference that identifies the row it names, and a hint that helps an operator recognise it. Observed — provider text in a message, and a column that duplicates `connection_id`.
- **Status:** Open (found 22.14) — both are small and both touch what an operator reads, so they are grouped here for one deliberate pass. The journey asserts the part that matters today: no credential value appears in the connection, detail, runs, logs, health, metrics or audit trail — the *values* are safe; it is the reference and the echo that are wrong.
- **Remaining risk:** an error-tracking pipeline that logs API messages can capture a provider error string containing something it should not keep.

## G53 — A delivery deferred by a paused connection or a disabled module is never picked up again

- **Module / contract:** advanced-integrations — `WebhookIngressService.processDelivery`, the connection state gate in the executor.
- **Impact:** the receipt's status is the idempotency guard, and a delivery that is not applied stays `received`. Pausing a connection refuses provider *calls*, but a callback already in the queue still arrives and is still applied through the mapping, because applying a stored payload calls no provider. Turning `features.connections` off refuses new control-plane writes and does nothing to a queued job either. Either way, if a delivery is refused or fails, nothing sweeps the rows left `received`: the provider must send them again, and a provider that will not re-send a duplicate delivery for a row it deduplicates by id has lost the event with only a receipt to prove it happened.
- **Expected vs observed:** expected — one documented policy for work already in flight when the operator stops the module, and a sweeper that acts on it; observed — the runbook's disable plan (pause, then turn features off) has no queue semantics attached to it.
- **Status:** Open (found 22.14) — the journey asserts the enforceable part (no provider call goes out while a connection is paused, proven with the connector's own counter, and a full re-sync via `reconcile` recovers the data that matters), and records the rest rather than inventing a policy the plan has not decided.
- **Remaining risk:** "we paused the connector during the outage" can still mean "the CRM changed underneath us", and an operator has no list of what arrived meanwhile beyond the receipts table.
