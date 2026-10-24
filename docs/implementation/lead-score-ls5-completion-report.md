# Phase 19-LS.5 — Scoring History, Explanation and Freshness: completion report

Delivered 2026-10-24. Scope: `PLAN_Phase_19_LeadScore.md` §3.1, §5.3–§5.4, §6.3, §6.5, §8.2, §9.1–§9.2,
§10.2, §15.2 stages 4–5, §16 `19-LS.5`; contract in `docs/implementation/lead-score-audit.md` §5.2–§5.3 and
§11; compatibility rows in `docs/compatibility/lead-score.md` §3, §7 and §8.

**Acceptance, as the plan writes it:** *"users can explain score and know whether it is current."* LS.4
answered "can the same inputs be scored the same way twice". This phase answers the two questions a sales
person actually asks of a number on a Lead: *why this* and *is this still true* — and stores the evidence for
both.

---

## 1. What landed

| File | Responsibility |
| --- | --- |
| `apps/api/src/lead-score/lead-score-records.ts` (new) | The module's structural reads: one model by id, a model's **whole** rule set in evaluation order, a Lead's evaluations paged with a total, a row by idempotency key. Literal SQL against the predicates `073_phase19_lead_score.sql` indexes, entity kinds from `LEADSCORE_ENTITY_TYPES`, every request value a bind parameter (AGENTS.md §5.2). |
| `lead-score-calculation.service.ts` (new) | `recalculate(leadId)` — the active published model, one Lead, one evaluation row and one projection update in a single internal transaction. |
| `lead-score-explanation.service.ts` (new) | `score(leadId)` and `history(leadId, limit, offset)` — labeled per-rule breakdown, derived freshness, paged history. |
| `lead-score.controller.ts`, `dto/lead-score-shapes.ts` | `POST action/score/recalculate`, `GET action/score/:leadId`, `GET action/score/:leadId/history`, all strict and bounded. |
| `lead-score-evaluator.ts` | `scoringInputsHash(…)` exported so the read re-computes exactly what the engine signed; `ruleName` added to each rule outcome, because "a stable code is not an explanation". |
| `lead-score-module.ts`, `lead-score-settings.service.ts`, `lead-score-feature-gate.service.ts` | `scoring`, `manualRecalculation` and `scoreExplanation` are delivered; `settings.scoring.activeModelId` is the section this phase reads. |
| `lead-score-module-health.service.ts` | `settings.scoring` reports which model a score would use, whether it is published, and with which state code — informative, not a failing check. |
| `database/seed-metadata.ts` | `inputsHash` on `LeadScoreEvaluation` (attrs JSONB + the `run` panel; no migration, no DDL). |
| `lead-score-errors.ts`, `i18n/{en,vi}/errors.json`, `i18n/{en,vi}/leadscore.json` (new) | `LEADSCORE_NO_ACTIVE_MODEL`, and the labels a reader sees: freshness states, staleness reasons, rule outcomes, dimensions — en + vi. |
| `apps/api/test/lead-score-calculation.test.ts` (15), `lead-score-explanation.test.ts` (12) | The evidence. |

## 2. The three findings that changed the design

1. **A score cannot test its own freshness with the Lead's `version`.** The first implementation compared the
   stored `sourceRevision` with the Lead's current `version`. Storing a score *is* a write to that Lead, so
   every score was stale the instant it was saved — and the second recalculation of unchanged data produced a
   different idempotency key, filling history with duplicates. Plan §5.3's "input watermark" therefore became
   real: the evaluation carries `inputsHash` (LS.4's canonical inputs, now exported as `scoringInputsHash`),
   the read re-computes it, and `sourceRevision` stays as provenance only. The key spans
   `(leadId, modelId, modelVersion, inputsHash)` — not the revision — so an unchanged re-run is one row.
2. **Duplicate detection cannot be "insert and catch".** Inside a transaction a rejected statement aborts the
   transaction, so the follow-up read that would identify the existing row is refused too: a duplicate would
   have answered as a server failure rather than a no-op. The lookup now happens *before* the insert, and the
   LS.2 unique index stays as the answer to a genuine race.
3. **Datetime attributes come back as `Date` objects, not the text that was written.** The entity service
   hydrates them, so `typeof value === 'string'` read a stored timestamp as *missing*: the projection could
   never match itself and rewrote the Lead on every call. Found from a failing no-op assertion, fixed by one
   `instantOf` reader used for every timestamp in the write and read paths — and the reason `scoreInputsAsOf`
   / `scoreCalculatedAt` now survive a repeat call unchanged.

A fourth decision is worth recording because it is the one a reviewer would question: **writing the history row
requires the caller's role to permit `LeadScoreEvaluation` create.** Reading the rules internally is unavoidable
(an operator without model rights must still get the published model's real score), but silently writing a row
the caller may not create would make the projection's content depend on a permission nobody can see. The
grant is explicit, it is asserted from both sides, and because history and projection are one transaction the
refusal leaves **neither** behind.

## 3. What each half guarantees, and where it is asserted

| Guarantee | Where |
| --- | --- |
| A score is stored as one immutable evaluation **and** one matching projection, in one transaction | calculation suite: the row's `leadId`/`modelId`/`modelVersion`/`sourceRevision`/`inputsAsOf`/`signature`/`inputsHash`/`ruleResults` are read back from the database and compared with the response |
| Recomputing unchanged data records nothing new and does not move the Lead | `recorded: false`, `projectionWritten: false`, same evaluation id, identical `version` and `modifiedAt`, one row in history |
| A changed signal produces a new row and keeps the old one | edit → recalculate → two rows, `scorePreviousValue` names the displaced number, ordering newest first |
| Nothing is scored without an active published model, and the answer says which state it found | three tests for `unset` / `missing` / `notPublished`; the id of a vanished model is not echoed; archiving the active model changes health and refuses recalculation while leaving the stored score intact |
| The rules are read whole, the Lead is read as the caller may see it | an operator with no `LeadScoreModel`/`LeadScoreRule` rights still scores against both rules (50, not 30) and is refused the rule list; a caller who cannot read the Lead is refused before anything is computed; a reader whose field ACL hides `industry` gets `unknown`, coverage `0.3333` and never the hidden value |
| A breakdown explains without leaking | entries carry reason code, rule name, dimension, outcome and points — and no Lead value is present anywhere in the response; labels resolve in the reader's own language (vi preference wins over `Accept-Language`, the platform's rule) |
| Freshness is derived and named | `current`; `stale` with `leadChanged` after an edit; `modelChanged` when a different model is active; `modelMissing` when none is; `reportedStale` carried from LS.6's future label; and **no claim at all** for a reader who cannot see one of the model's inputs |
| History has one door | the Lead-scoped command serves a reader the generic `GET /LeadScoreEvaluation/:id` refuses; `viewScore` reads the badge, `explainScore` is required for the breakdown; paging is bounded at 50 and a caller cannot widen it |
| The LS.2 ownership still holds | a client `PATCH` of `scoreValue` is still refused after the module wrote it; the projection fields still produce no `audit_log` rows — the evaluations are the score's audit trail |

## 4. Verification actually run

| Command | Outcome |
| --- | --- |
| `npx vitest run apps/api/test/lead-score-calculation.test.ts` | **15 passed** |
| `npx vitest run apps/api/test/lead-score-explanation.test.ts` | **12 passed** |
| All eight LeadScore files together (`module`, `schema`, `validator`, `model`, `evaluator`, `preview`, `calculation`, `explanation`) | **194 passed / 0 failed** |
| Full `npx vitest run apps/api/test` | **2,314 passed / 34 failed (2,348 tests, 161 files)** — zero `lead-score` failures; the 34 are the same seven pre-existing shared-state files as the LS.4 baseline (`ai-agent-runs` 19, `crm-chat-docs-help` 7, `crm-chat-ai-agents-integration` 2, `crm-chat-security` 1 — "the instance allows 2 concurrent agent runs"; `service-desk` 2, `service-desk-workflow` 2, `service-desk-sla` 1) |
| `npm run typecheck` | exit 0 |
| `npx eslint apps/api/src/lead-score apps/api/test/lead-score-*.ts --max-warnings=0` | exit 0 (after `--fix` for import sorting) |
| residue check (`entity_records`, `app_settings`, `users`, scored Leads) | `AGENT_TEST_LS*` names **0**, `LeadScoreModel`/`Rule`/`Evaluation`/`LeadConversionOperation` rows **0**, `leadScore` settings row **0**, `AGENT_TEST_LS*` users **0**, Leads carrying a stored score **0**, Leads in the database **12** (the demo set, untouched) |

Nine assertions in the **earlier** LS.1/LS.2/LS.3/LS.4 suites stated "scoring is still pending". Each was
retargeted to the same claim about something that *is* still pending (`batchRecalculate` → 19-LS.6,
`eventRecalculation` → 19-LS.6 for the settings warning, `conversionExecute` → 19-LS.13, `aiInsight` →
19-LS.17), and the delivered ones now assert the different refusal they should give — a switch, not a phase,
with `pendingPhase: null`. One was a scoping fix rather than a phase change: the LS.3 validation test asked
whether *any* evaluation row exists in the database, which stopped being a meaningful question the moment
LS.5 started storing them; it now asks whether this model has any.

## 5. Database hygiene (AGENTS.md §3)

- Configured primary database only: no test database, no reset, no truncate, no seed run, no migration in this
  commit (`inputsHash` is a JSONB attribute; the LS.2 indexes already cover every read added here).
- Test records are `AGENT_TEST_LS5_*` / `AGENT_TEST_LS5R_*`, removed by exact id; evaluation rows are also
  swept by `attrs->>'leadId'` for this run's Leads, because their display name is the score the engine
  produced rather than the run marker. `entity_links` before `entity_records`; `users_roles` / `users_teams`
  before the users; the `leadScore` row restored from the **raw `app_settings.data` column**, not the API view.
- Both suites warn on residue and on a surviving settings row; neither warned.
- One orphan evaluation row from an **earlier run that failed before this cleanup existed** was found by the
  residue check and removed by exact id — only after a join proved the Lead it described no longer exists and
  confirmed it is this agent's own test lineage. Both `after` counts are above; nothing else in the database
  was touched, and no other row was deleted "because its name looked similar".
- Two edits landed after the authoritative full run: one extra assertion inside an existing LS.1 settings test
  (the `scoring` section default) and the documentation above. The LS.1 suite (15 tests) and both LS.5 suites
  (27 tests) were re-run on the final tree and are green, so the full-suite row remains the measured one.

## 6. What is deliberately not delivered

| Still owed | Phase | State today |
| --- | --- | --- |
| Event-driven debounce, bounded batch rebuild, retry, decay sweep | LS.6 | `batchRecalculate` refuses with `LEADSCORE_PHASE_PENDING` naming 19-LS.6; the triggers `lead_change`/`batch_rebuild`/`decay_sweep` exist in the vocabulary and nothing writes them |
| Score panel, list column/filter, history drawer, manual action in the SPA | LS.7 | no nav entry, no route, no `web.*` catalog keys; the API these screens need is now complete for one Lead |
| Model admin UI, sample picker, version diff | LS.8 | the preview command exists; choosing the active model is a settings write today, not a screen |
| Band-change events, notifications, engagement and email signals | LS.9 | such rules stay `skipped` in the engine and are refused at publish |
| Conversion preview/execute/duplicates/mapping/recovery | LS.10–LS.16 | refused with their own phases; nothing in LS.5 touched the Lead lifecycle |

Known limits worth stating before someone discovers them:

- **One active model, chosen in settings.** `publish` does not select it and does not recalculate anything:
  publishing stays a configuration act, which is plan §9.3's safety property but means a fresh install scores
  nothing until an administrator chooses a model (`LEADSCORE_NO_ACTIVE_MODEL` says so, and health reports the
  state).
- **Recalculation is synchronous and one-Lead.** The rate control is the platform's global limiter plus the
  fact that an unchanged Lead writes nothing at all; the debounce and the bounded batch are LS.6's, and this
  phase deliberately did not grow a loop.
- **`failed` history rows are stored, not currently producible through a published model.** 19-LS.3 refuses to
  publish a rule the engine would fail on and a published version is immutable, so the `failed` projection
  branch is covered by the engine's unit suite (`scoreValue: null`, `resultState: 'failed'`) and by LS.5's
  mapping of it, not by an end-to-end API test — reaching it needs a model whose metadata changed underneath
  it, which this suite refused to fake by mutating shared metadata.
- **Freshness needs the reader to see every input the model reads.** A user whose field ACL hides one of them
  is told neither `current` nor `leadChanged`; the score itself is unchanged, and the breakdown omits the
  signal they may not see.
