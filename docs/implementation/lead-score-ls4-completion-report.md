# Phase 19-LS.4 — Deterministic Scoring Engine: completion report

Delivered 2026-10-24. Scope: `PLAN_Phase_19_LeadScore.md` §3.1, §6.2–§6.5, §8.1, §9.2, §9.4, §15.2
stage 3, §16 `19-LS.4`; contract in `docs/implementation/lead-score-audit.md` §5.2–§5.3 and §11;
compatibility rows in `docs/compatibility/lead-score.md` §3 and §8.

**Acceptance of the phase, restated as the plan writes it:** *"same model/input snapshot produces the same
auditable result."* Everything below exists to make that sentence mean something checkable rather than
aspirational.

---

## 1. What landed

| File | Responsibility |
| --- | --- |
| `apps/api/src/lead-score/lead-score-evaluator.ts` (new) | The engine. Pure: no database, no settings row, no request scope, **no clock**. `scoreLead(request)` takes a model's stored attributes, its rules, the scored entity's field metadata and one input snapshot, and answers with the score, band, per-rule outcomes, reason codes, coverage, result state and a signature. `requiredInputFields(model, rules, fields)` answers what a recalculation must fetch. |
| `apps/api/src/lead-score/lead-score-preview.service.ts` (new) | `POST /api/v1/LeadScore/action/model/preview` — the only door the engine is admitted through at this phase. Scores a bounded sample of Leads **the caller may read** and writes nothing. |
| `lead-score.controller.ts`, `dto/lead-score-shapes.ts` | The route and its strict shape (`modelId`, optional `leadIds`/`maxSize`, both bounded to 25 at the DTO so a caller cannot widen them). |
| `lead-score-module.ts` | `19-LS.4` in `implementedPhases`; a new `scoringPreview` feature delivered by this phase; `scoring`'s pending phase moved to **`19-LS.5`**. |
| `lead-score-settings.service.ts` | `features.scoringPreview` in the validated document. |
| `lead-score-feature-gate.service.ts` | `previewModel` → capability `modelManage`, feature `scoringPreview`, `writes: false`. |
| `lead-score-module-health.service.ts` | New `scoring-engine` health check: every operator in the platform's `CRITERIA_OPERATORS` must have a scoring meaning, and the engine must not score with an operator the platform does not name. |
| `apps/api/test/lead-score-evaluator.test.ts` (new, 65 tests), `apps/api/test/lead-score-preview.test.ts` (new, 12 tests) | The evidence. |

## 2. The questions plan §6.3 left open, and the answer each got

Each of these is asserted in `lead-score-evaluator.test.ts`; the wording in
`docs/implementation/lead-score-audit.md` §5.2 is the contract copy.

1. **Order.** `priority`, then `reasonCode`, then `id`. Without the tie-break two rules at one priority
   would be applied in whatever order the relation query returned, so a stored score would depend on a
   database detail (compat U13, now closed).
2. **Sign.** The rule's `effect` decides it: `add` contributes `|points|`, `subtract` contributes
   `-|points|`, `setBand` contributes 0. A number typed as `-8` on a `subtract` rule and one typed as `8`
   mean the same thing, which is what lets a score survive an editor's habits.
3. **Weights.** Applied after the rule deltas, before the clamp, and normalized:
   `Σ(delta_d × weight_d) / Σ(weight_d)` over the dimensions the evaluation *attempted*. So a weight set is
   relative influence, not a multiplier that quietly widens the scale. A skipped rule leaves the denominator
   (it cannot dilute a score); a total weight of 0 falls back to the unweighted delta and flags
   `LS_EVALUATION_WEIGHTS_ZERO_TOTAL`.
4. **Rounding.** Half **away from zero**, because `Math.round(-0.5)` is `-0`: otherwise the sign of a delta
   would choose the rounding rule. The clamp runs first, and both bounds are integers, so the result is an
   integer inside `[scoreFloor, scoreCeiling]`.
5. **Band lookup.** A matched `setBand` rule wins, last one in evaluation order; otherwise the first
   threshold band containing the score. A score no band covers is reported as `Unknown` with
   `LS_EVALUATION_SCORE_OUTSIDE_BANDS` rather than assigned to the nearest one — LS.5 decides whether that
   keeps the previous band. `Disqualified` stays reachable only through a rule or the core `Dead` status
   (plan §3.3), and a low number still cannot produce it.
6. **Coverage.** Known share of attempted rule weight (`|points|`, or 1 for a `setBand` rule and for a draft
   rule with no points yet), four decimals. Definite answers on both sides; `neutral` unknowns and errors in
   the denominator only; `ignore` unknowns and skips out of both.
7. **Missing-data policy, made distinguishable.** `ignore` = "this rule asks nothing when the signal is
   absent"; `neutral` = "the model wanted that signal and this Lead did not answer". Both give 0 points, and
   only the second lowers coverage — the difference is visible to a reader instead of being a comment.
8. **What may refuse to produce a number.** Only structural failure: an unparseable condition, a leaf
   outside the model's grant, a field the metadata does not declare, or more rules than
   `MAX_EVALUATED_RULES`. If *every* attempted rule failed, the answer is `resultState: failed` with
   `scoreValue: null` — recorded, not hidden (plan §5.4). A model whose rules all asked nothing gets the base
   score at coverage 0, because "nothing known" is that model's declared neutral start, not a server error.

## 3. Why the engine has no clock

Plan §1.2 asks for reproducible results, and §5.3 asks the projection to carry `inputsAsOf` and
`sourceRevision`. Both are satisfied by making time **data the caller supplies about** the evaluation, never
an input to it: the snapshot's `inputsAsOf` is copied into the response and is absent from the signature.

That is possible at this phase because 19-LS.3 confined every condition to an absolute value and refuses a
`lead`-source rule from carrying a lookback window or a decay policy. When 19-LS.9 adds engagement signals,
the *signal reader* will take a window and an as-of instant explicitly; the scorer keeps the property that
lets a rebuild prove it changed nothing. The unit suite asserts it directly: the same model and data scored
under a 2026 timestamp and a 2027 timestamp return the same score and the same signature.

## 4. The finding that changed the design: hidden is not empty

`apps/api/test/lead-score-preview.test.ts` first ran with the engine reading a serialized Lead row as the
snapshot. The field-ACL case then failed, and it was the engine being wrong rather than the test:

- `EntityCrudService` strips a field the reader may not see, so the key simply is not in the row;
- a row where nobody ever filled the field in looks identical to that;
- the engine treated both as "empty", so `isNotEmpty` answered **definitely `not_matched`** for a reader who
  had been shown nothing — turning a withheld value into a stated fact about the Lead, and giving the two
  readers the same signature for different information sets.

Plan §6.5 ("only for fields the reading user may see") and §9.2 ("a score model may not become an export
path around Lead ACL") both rule that out, so "no signal" is now **three** states, not two:

| State | How it arrives | Existence operator | Comparison operator | Canonical form |
| --- | --- | --- | --- | --- |
| not supplied | field ACL hid it, or the fetch did not include it | `unknown` | `unknown` | `"__not_supplied__"` |
| supplied, empty | `null`, empty text, whitespace, empty list | answers definitely | `unknown` | `null` |
| supplied, with a value | anything else | — | compared | the value |

and the preview service builds its snapshot from `requiredInputFields(…)` intersected with
`AclApiService.visibleFields('Lead')`, omitting a withheld field rather than substituting `null`. Side
effect, intended: the engine can no longer read a field the caller was not granted even by accident, because
it is never handed one.

**A second finding, from re-reading the operator matrix rather than from a failing test:** 19-LS.3 admits
`equals`/`notEquals` on a `bool` field as well as `isTrue`/`isFalse`, and the first version of the engine
answered `unsupported` for those — which would have made a publishable rule quietly never match. A boolean
comparison now compares booleans, so `equals true` and `isTrue` are the same question, and the operator table
asserts all four readings.

## 5. Verification actually run

| Command | Outcome |
| --- | --- |
| `npx vitest run apps/api/test/lead-score-evaluator.test.ts` | **65 passed** — reproducibility (same snapshot, second call, different clock, key order, rule-array order, whitespace in the stored condition, priority tie), all 16 operators including the two readings a `bool` field admits, every missing-data shape, weights, clamp, rounding, band resolution and the band gap, every error and skipped outcome, `requiredInputFields` agreeing with what the engine read |
| `npx vitest run apps/api/test/lead-score-preview.test.ts` | **12 passed** — per-Lead scores and distribution against the engine's arithmetic, **zero writes** (the Lead row identical field by field including `version` and `modifiedAt`, `LeadScoreEvaluation` and `audit_log` counts unchanged, the model still a draft), identical signature across two calls and a different one after a signal changed, no Lead value anywhere in the response, §9.4 bounds (`26` ids, `maxSize: 0`, `maxSize: 26` all refused; `maxSize: 1` honored), record ACL (`own`) scoring one requested id and reporting the other as `notReadable` without naming it, field ACL turning `company` into an unknown rather than an empty, `modelManage` refusal, the switch-off refusal, the OpenAPI route, and a caller with model rights but no Lead rights being refused by the core ACL |
| `npx vitest run` on all six LeadScore files | **167 passed / 0 failed** (`module`, `schema`, `validator`, `model`, `evaluator`, `preview`). The five assertions LS.4 legitimately changes were updated, not deleted: `implementedPhases`, the implemented-feature list (`modelAdministration`, `scoringPreview`), `readScore`'s pending phase `19-LS.4 → 19-LS.5`, the settings warning naming `19-LS.5`, and the health-check name lists (now eight checks). `previewModel` was **removed** from the phase-pending tables because it is no longer phase-pending, and replaced with an assertion that its refusal now names a switch (`pendingPhase: null`) |
| `npm run typecheck` | exit 0 |
| `npx eslint apps/api/src/lead-score apps/api/test/lead-score-{evaluator,preview}.test.ts --max-warnings=0` | exit 0 (after `--fix` for import/export sorting) |
| Full `npx vitest run apps/api/test` | **2,287 passed / 34 failed (2,321 tests, 159 files)** — zero `lead-score` failures, and the 34 are the same seven pre-existing shared-state files as the LS.2/LS.3 baseline (`ai-agent-runs`, `crm-chat-ai-agents-integration`, `crm-chat-docs-help`, `crm-chat-security`: "The instance allows 2 concurrent agent runs"; `service-desk`, `service-desk-workflow`, `service-desk-sla`: shared settings residue, leftover routing rows and a business-hours-dependent clock). The run exits 1 because of those, not because of this phase |
| residue check (`entity_records`, `app_settings`, `users`, `Lead` scores) | `residue names: 0 \| LS records: 0 \| leadScore row: 0 \| Leads: 12 \| Leads with a stored score: 0 \| LS test users: 0` |

## 6. Database hygiene

AGENTS.md §3: the configured primary database only — no test database, no reset, no truncate, no seed run.

- No migration in this commit. `073_phase19_lead_score.sql` (LS.2) already indexes everything LS.4 needs;
  the engine reads through `EntityCrudService` and writes nothing.
- Every test record is named `AGENT_TEST_LS4_…`, deleted by exact id in `afterAll`, with `entity_links`
  cleared first and a residue warning if anything survives. The check above ran after the suites and found 0.
- The `leadScore` settings row is restored from the **raw `app_settings.data` column** (not from the API
  view), so no test can leave behind an un-enveloped row that the next reader silently ignores.
- "No Lead carries a stored score" is the phase's own proof: after 12 preview calls against real records, the
  `scoreValue` attribute exists on zero Leads.

## 7. What is deliberately not delivered

The module remains switch-off by default and behavior-partial in exactly one direction: a score can be
*computed* but not *kept*.

| Still owed | Phase | What refuses it today |
| --- | --- | --- |
| Storing an evaluation and updating the Lead projection | LS.5 | `readScore` → 409 `LEADSCORE_PHASE_PENDING` naming 19-LS.5; the `scoring` switch is pending there |
| Score and history read APIs, explanation text, staleness | LS.5 | `readScoreHistory` → same, feature `scoreExplanation` |
| Event-driven, manual and batch recalculation | LS.6 | `recalculateLead` / `batchRecalculate` → 19-LS.6 |
| Engagement and email-link signals, decay, lookback | LS.9 | the engine records such a rule as `skipped` with `LS_EVALUATION_SIGNAL_SOURCE_NOT_READABLE`, and 19-LS.3 already blocks publishing it |
| Band-change events, notifications | LS.9 | feature `thresholdNotifications` |
| Model admin UI, sample picker, version diff | LS.8 | no nav entry, no SPA route, no `leadscore.json` catalog yet |
| Conversion preview/execute, duplicates, mapping, AI insight | LS.10–LS.17 | every `conversion*` operation → its own phase |

Two limitations worth stating rather than discovering later:

- **A preview scores a sample, not a Lead list.** `maxSize` is capped at 25 (`MAX_PREVIEW_SAMPLE`) because
  plan §9.4 asks a preview to stay cheap; an administrator who wants every Lead scored is asking for
  19-LS.6's bounded batch job, which does not exist yet.
- **Nothing chooses the active model.** The preview always evaluates the model it is given. `settingsJson`
  still accepts no key, and there is no active-model pointer, so a published version has no runtime effect on
  a Lead until LS.5 writes the projection (compat U12, narrowed but not closed).
