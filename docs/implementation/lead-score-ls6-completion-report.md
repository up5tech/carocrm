# Phase 19-LS.6 — Event-Driven and Manual Recalculation: completion report

Delivered 2026-10-24. Scope: `PLAN_Phase_19_LeadScore.md` §4.2, §9.1–§9.4, §10.2, §11.1, §15.2 stage 5,
§16 `19-LS.6`; contract in `docs/implementation/lead-score-audit.md` §5.4 and §11; compatibility rows in
`docs/compatibility/lead-score.md` §3, §8 and §9.

**Acceptance, as the plan writes it:** *"repeat events do not create duplicate history or unbounded jobs;
list reads remain performant."* LS.5 could score a Lead only when somebody named it. This phase is the part
that decides, on its own, *when* to score — and every one of the four properties the acceptance names is
enforced somewhere a test can reach rather than asserted in a comment.

---

## 1. What landed

| File | Responsibility |
| --- | --- |
| `apps/api/src/lead-score/lead-score-recalculation.service.ts` (new) | The whole decision: six answers to a committed Lead change, the debounce, the outstanding-job collapse, the bounded chunked rebuild, and the per-record error accounting. Owns `LEADSCORE_JOB_NAMES`, `MAX_BATCH_CHUNK = 50`, `MAX_BATCH_TOTAL = 2 000`. |
| `lead-score-authority.ts` (new) | The documented service authority for background work — a `system` principal carrying `sysAdmin`, exactly the shape `customer-success-authority.ts` established. No second authorization model for jobs, no flag that bypasses ACL. |
| `dto/lead-score-shapes.ts` | `LeadChangedSchema`, `BatchRecalculateSchema`, `RecalculateBatchChunkSchema` — strict, bounded, and applying the **same** ceilings to a job payload that a client faces, so a hand-edited `jobs.target` cannot widen a run. |
| `lead-score.controller.ts` | Four routes: `POST action/recalculate-batch` behind `LeadScoreBatch`, and three `@Public()` worker routes behind `x-worker-secret` (`action/work/lead-changed`, `…/recalculate`, `…/recalculate-batch-chunk`), each running under the service authority. |
| `lead-score-feature-gate.service.ts` | One new operation, `eventRecalculate`, mapped to `feature.eventRecalculation` — see §2.3. |
| `lead-score-module.ts`, `lead-score-settings.service.ts` | `eventRecalculation` and `batchRecalculation` flipped to delivered; `settings.scoring.debounceSeconds` (0–900 s, default 60) added to the section LS.5 opened. |
| `apps/api/src/jobs/jobs.service.ts` | `enqueue(… delayMs)` now passes the delay through to the queue's own `options.delay`. One line, and it is the difference between "debounced" and "not". |
| `lead-score-calculation.service.ts` | `recalculate(leadId, { operation, trigger })` — the stored trigger is now the truth: `manual_recalculate`, `lead_change` or `batch_rebuild`. LS.5 hardcoded one value because only one path existed. |
| `apps/worker/src/handlers/lead-score-handlers.ts` (new) + `apps/worker/src/app.ts` | The two job handlers, the `entity.created`/`entity.updated` Lead subscriber, and the response classification in §2.2. |
| `apps/api/test/lead-score-recalculation.test.ts` (19), `apps/worker/src/handlers/lead-score-handlers.test.ts` (21) | The evidence. |

## 2. The three findings that changed the design

1. **The loop break is a fact about two field lists, not a flag.** A score write is a write to the Lead, so it
   emits `entity.updated` with `changed = [scoreValue, scoreBand, …]` — and an event-driven path that queues a
   job for any Lead change would recalculate forever. The rule that stops it is one line:
   `changed ∩ requiredInputFields(model, rules) ≠ ∅`. It holds because 19-LS.3 **refuses** scoring outputs and
   protected names as rule inputs, at validation *and* at publish. There is no marker to forget, no in-process
   lock, and nothing to re-remember when a new write path appears: a projection write cannot be an input, so it
   cannot be a trigger. The suite proves it from both sides, and the negative side reads the `changed` array out
   of the **real `outbox_events` row the score write produced** rather than a hand-written list — then shows a
   change that *does* touch `company` is queued, so the assertion is about the lists and not a stub that says no.
   The same reasoning covers `markPending`, which moves only `scoreStatus`.
2. **A worker's failure semantics are three-way, not binary.** Delivery is at-least-once (outbox poller retries
   an event whose subscriber throws; the queue retries a failed attempt), and the naive rule — throw on any
   non-2xx — turns an operator's switch into an outage: an event that keeps retrying blocks the poller behind
   it, and a job that retries `LEADSCORE_MODULE_DISABLED` until it exhausts its attempts fills `/admin/jobs`.
   So the handler classifies on the module's **stable code**: transport/5xx and a wrong capability **throw**
   (retry, and a misconfigured deployment stays loud); `LEADSCORE_*`, `RECORD_NOT_FOUND` and a 404 **complete**
   (a retry cannot change them); and the decision route itself never answers 4xx for a configuration reason.
   That last one is why `handleLeadChanged` returns `disabled` / `noActiveModel` / `leadGone` as *responses*.
   Found while writing the tests, and one of them is a real bug caught before it shipped: `records.get` raises
   `RecordNotFoundError`, not the `NotFoundError` the first cut caught, so a deleted Lead threw a 404 out of a
   hand-off that was supposed to answer calmly.
3. **The event kill switch has to stop the work already queued.** A `leadScore.recalculateLead` job is born
   only from a Lead change, but the row LS.5 put behind it was `recalculateLead` → feature
   `manualRecalculation`. Turning `eventRecalculation` off would then have stopped new jobs while outstanding
   ones kept scoring, which is not a switch an operator can reason about. Rather than overload a capability,
   the gate gained one operation — `eventRecalculate` (same `LeadScoreRecalculate` right, the event feature) —
   so each background path is governed by the switch its name promises. The batch path already had its own
   (`runBatchChunk` gates every Lead with `batchRecalculate`), and that is also why a rebuild is not blocked by
   an administrator who chose not to enable the interactive button.

Two more decisions are worth recording:

- **The subscriber owns no rule.** It posts three fields (`leadId`, `revision`, `changed`) to a route and lets
  the API decide. An alternative — reading the Lead and the model in the worker — would have put a scoring
  policy in two places, and LS.4/LS.5 established that the engine and its inputs are the module's business.
  It also means changing the debounce or the trigger rule needs no worker redeploy.
- **Cancellation is per chunk, and the view says so.** `runBatchChunk` checks the run's `jobs` rows for
  `cancel_requested`/`status = 'cancelled'` before it lists and again before it hands the cursor on. The honest
  limit: a cancel lands at the next chunk boundary, so at most `MAX_BATCH_CHUNK` (50) Leads finish after it —
  the worker's own `context.shouldStop()` is per attempt and `JobContext` carries no job row id, so an
  in-chunk stop would mean a per-Lead JSON-key scan of `jobs`. Those ≤ 50 writes are the no-op LS.5 made them,
  which is what makes the latency acceptable rather than merely documented.

## 3. What each half guarantees, and where it is asserted

| Guarantee | Where |
| --- | --- |
| Nothing is computed during a list or detail read | no code in the recalculation service is reachable from a read route; `GET /Lead/:id` still reads the projection LS.5 stored (LS.5's read suite is the guard) |
| A committed change is decided, never guessed | six decisions asserted as 200s: `disabled`, `noActiveModel`, `inputsUnaffected`, `leadGone`, `alreadyQueued`, `queued` — including one for a Lead deleted between the commit and the hand-off |
| Only a change that can move the score produces work | `changed ∩ requiredInputFields`; the negative side uses the real outbox payload of a projection write |
| A burst and a duplicate delivery collapse to one unit of work | the job id is `sha256(job\|leadId\|modelVersion\|revision)` (recomputed independently in the test), a repeated delivery returns the same id, a newer revision of the same Lead+version returns `alreadyQueued`, and exactly one `jobs` row exists |
| Debounce is the administrator's number, honoured by the queue | `debounceSeconds: 120` → `delayMs: 120_000` in the answer and in `JobsService.enqueue` → BullMQ `options.delay`; the durable `jobs` row still exists for `/admin/jobs` |
| A pending marker tells the truth without churning the row | `scoreStatus: 'pending'` written once, the Lead's `version` unmoved by the second hand-off, no value rewritten before the job runs |
| A queued job runs the same engine under the same guards | worker route → 50 for a Software company Lead, `trigger: lead_change`, `correlationId: leadScore:recalculate`, audit stays empty for score fields (LS.2's decision, still true on the job path), a repeat records nothing and moves nothing |
| The switches are real kill switches | turning `eventRecalculation` off makes an **already queued** job refuse with `LEADSCORE_MODULE_DISABLED` naming the feature; turning the module off refuses too |
| A rebuild is bounded and cannot be widened | `limit`/`chunkSize` above the ceilings are refused (400) rather than silently clamped, on the client route *and* on the worker route, so a hand-edited job payload meets the same wall |
| A rebuild is chunked and hands a cursor, not an offset | chunk 1 processes 2 and names `nextJobId`; chunk 2 resumes from `cursor`, reports `processedTotal: 3`, `done: true`, no successor; the three Leads each carry the number the engine gives them |
| Re-running a run is harmless | the same chunk replayed from the start reports `scored: 0, unchanged: 2` and history still holds one row per Lead |
| A cancel ends the chain | `cancel_requested` (and, separately, a terminal `cancelled` row) → `cancelled: true`, `done: true`, `nextJobId: null`, `processed: 0`, and the run still owns exactly one job row |
| One bad Lead does not fail the rebuild | the active model swapped for a draft mid-run → `failed: 2`, `errorCodes: ['LEADSCORE_NO_ACTIVE_MODEL']`, chunk still 200, no code leaks the model id; restoring the model lets the same chunk score both |
| Capability and switch both gate a rebuild | a user with `Lead` edit and `LeadScore` read but no `LeadScoreBatch` gets 403 naming the capability; the right holder with the switch off gets 403 naming `leadScore.batchRecalculation` |
| The worker door is the capability | every worker route refuses a missing and a wrong `x-worker-secret` with 401 **before** any parsing, so a probe cannot use an invalid body to learn what a route accepts |

## 4. Verification actually run

| Command | Outcome |
| --- | --- |
| `npx vitest run apps/api/test/lead-score-recalculation.test.ts` | **19 passed** |
| `npx vitest run --config apps/worker/vitest.config.ts apps/worker/src/handlers/lead-score-handlers.test.ts` | **21 passed** |
| All nine LeadScore API files together (`module`, `schema`, `validator`, `model`, `evaluator`, `preview`, `calculation`, `explanation`, `recalculation`) | **213 passed / 0 failed** |
| Full `npx vitest run` (`apps/api/test` + `packages/*/src`) | **2,848 passed / 34 failed (2,882 tests, 200 files)** — zero `lead-score` failures; the 34 are the same seven pre-existing shared-state files as the LS.5 baseline (`ai-agent-runs`, `crm-chat-ai-agents-integration`, `crm-chat-docs-help`, `crm-chat-security`, `service-desk`, `service-desk-workflow`, `service-desk-sla`) |
| Full worker suite (`--config apps/worker/vitest.config.ts`) | **205 passed / 0 failed (20 files)** |
| `npx tsc --noEmit -p tsconfig.json` | exit 0 |
| `npx eslint apps/api/src/lead-score apps/worker/src apps/api/test/lead-score-*.ts --max-warnings=0` | exit 0 (after `--fix` for import sorting) |
| residue check (`app_settings`, `entity_records`, `jobs`, `job_logs`, `outbox_events`, `users`, `roles`, Leads carrying a score) | `leadScore` row **0**, `AGENT_TEST_LS*` records **0**, `LeadScore*` records **0**, `leadScore.*` job rows **0**, outbox rows naming this run's records **0**, `AGENT_TEST_LS*` users and roles **0**, Leads carrying a stored score **0**, Leads in the database **12** (the demo set, untouched) |

The full-suite row above is the **second** complete run, made after the suite cleanup in §5 landed; the first
run, with identical numbers, is what surfaced the residue this section describes. Only documentation changed
afterwards.

Seven assertions in the **earlier** suites said something LS.6 delivered was still pending, and each wasretargeted rather than weakened: `lead-score-module.test.ts` (the `implementedPhases` list, the delivered-features
list, the `pendingFeatures` list, the `phasePending` warning — moved to `duplicateDetection`/19-LS.11, and the
gate table — moved to `conversionPreview`/19-LS.12, which writes nothing so the `writes` expectation changed
too), `lead-score-model.test.ts` (both `batchRecalculate` phase pointers now assert the *switch* refusal they
should give, with `pendingPhase: null`), `lead-score-preview.test.ts` (a test titled "…while a stored score
still waits for 19-LS.5" now names what actually still waits), and `lead-score-schema.test.ts` — whose
"still refuses every operation" test lost its example once LS.6 shipped `batchRecalculate`, so it now proves
the same rule through the operations that *are* still pending and adds the new refusal shape alongside the old
one. `defaults.scoring` gained `debounceSeconds: 60` in the LS.1 settings assertion, because that is the real
default now.

## 5. Database hygiene (AGENTS.md §3)

- Configured primary database only: no test database, no reset, no truncate, no seed run, and **no migration**
  in this commit. Every read the phase adds is either a key lookup (`jobs.id`, `entity_records.id`) or a
  `jobs`/`target` filter on a table the platform already keeps small; the `073_*` indexes cover the evaluation
  and Lead reads unchanged.
- Test records are `AGENT_TEST_LS6_*`, removed by exact id. Evaluations do not carry the run marker in their
  name (their display name is the score the engine produced), so they are swept by `attrs->>'leadId'` for this
  run's Leads — a gap the first cut of this suite had and the residue check found. Job rows are swept by
  `target->>'leadId'`, by `target->>'runId'` for the runs this suite started, and by the run marker in the
  payload; `job_logs` before `jobs`, `entity_links` before `entity_records`, `users_roles`/`users_teams` before
  users, and the `outbox_events` rows naming this run's records go with them, because a development worker
  would otherwise eventually read a hand-off for a Lead that no longer exists.
- The `leadScore` settings row is restored from the **raw `app_settings.data` column**, and
  `REPORT_WORKER_SECRET` is restored to whatever the environment held (or unset), because the suite installs
  its own capability at module scope before boot.
- Found and removed on the strength of the residue check: **40 evaluation rows and 4 `leadScore.batchRecalculate`
  job rows left by four earlier runs of this suite** (before the two cleanups above existed). Each was deleted
  by exact id inside a transaction, and only after a join proved that the Lead *and* the model each row
  described no longer exist and that their timestamps matched this agent's own runs. Nothing else in the
  database was touched, and no row was deleted "because its name looked similar". After the fix, every residue
  count is 0 — measured once after a fresh LS.5 + LS.6 run and again after the full 200-file suite that
  re-ran them, with the database's 12 demo Leads unchanged and none of them carrying a score.

## 6. What is deliberately not delivered

| Still owed | Phase | State today |
| --- | --- | --- |
| Band-change events and notifications, engagement/email signals, **decay sweep**, publishing a model queues a rebuild | LS.9 | `thresholdNotifications`/`engagementSignals` still name 19-LS.9 and refuse with `LEADSCORE_PHASE_PENDING`; `decay_sweep` exists in the vocabulary and nothing writes it; `scheduled_jobs` has no Lead Score row, deliberately — a sweep would decay engagement signals that do not exist yet |
| Score panel, list column/filter, history drawer, recalculate action in the SPA | LS.7 | the API for all of it exists now, including the batch command an admin screen would call |
| Model admin UI, sample picker, version diff, batch status screen | LS.8 | choosing the active model and the debounce is a settings write, not a screen |
| Conversion preview/execute/duplicates/mapping/recovery | LS.10–LS.16 | refused with their own phases; nothing in LS.6 touched the Lead lifecycle |

Known limits worth stating before someone discovers them:

- **A rebuild runs as the service authority, not as the person who asked.** The request to *start* one is
  gated by `LeadScoreBatch` and the run's `requestedBy` is recorded in the job payload, but the chunk itself
  walks the Lead set under `sysAdmin`, like every other worker path on this platform (Customer Success,
  Sales). It is the admin-only right that carries the reach; the filter a caller passes is validated by the
  query engine under that authority, not by the caller's own ACL.
- **Cancellation granularity is one chunk** (§2, last bullet).
- **`debounceSeconds` is a per-instance number**, not a per-model one, and the debounce defers *queue*
  delivery of an already-durable `jobs` row — so a Lead that changes again while a job waits is absorbed by the
  outstanding-job check rather than re-timed, and the job reads the inputs as they are when it runs.
- **The subscriber fires on every Lead create and update**, and the API decides. On an installation with
  scoring switched off that is one internal POST per Lead mutation: cheap, deliberately stateless, and the
  price of keeping the rule in one place. A deployment with no `REPORT_WORKER_SECRET` registers no subscriber
  at all and both jobs are inert.
