# Lead Score — operations and recovery runbook

> Phase 19-LS.18 deliverable (`PLAN_Phase_19_LeadScore.md` §16, §17; audit §11 `LS.18`).
> Companion documents: `docs/compatibility/lead-score.md` ·
> `docs/implementation/lead-score-conversion-contract.md` ·
> `docs/implementation/lead-score-ls18-completion-report.md`.
> UI: **Lead Score** on a Lead (`apps/web/src/components/LeadScorePanel.tsx`) and the administration
> workspace at `/lead-score` (`LeadScoreSettings:edit`).

This runbook answers the question an operator has during an incident: **what is broken, what is safe to
run again, and what must never be run again?** It is written for the person who owns the instance, not
for the person who wrote the module.

## 0. The commands you will need

| Command | Capability | What it answers |
| --- | --- | --- |
| `GET /api/v1/LeadScore/action/health` | `LeadScore:read` (`viewScore`) | Whether the module is installed correctly: the registered records, the indexes, the write guard, the engine's operators, the state of every feature switch, and which operation is admitted for *you*. |
| `GET /api/v1/LeadScore/action/settings` · `POST /api/v1/LeadScore/action/settings` | `LeadScoreSettings:edit` | The switches and the policy: which model is active, the recalculation debounce, the conversion targets and map, the AI agent, the recovery bounds. |
| `GET /api/v1/LeadScore/action/score/:leadId` | `LeadScore:read` | One Lead's score, its freshness verdict and the actions this caller may take. The place to start: it names the reason a score is stale. |
| `POST /api/v1/LeadScore/action/score/recalculate` | `LeadScoreRecalculate:edit` (`recalculate`) | Score one Lead now. Idempotent: an unchanged Lead records nothing. |
| `GET /api/v1/LeadScore/action/conversion/operations?status=…` | `LeadConversionAudit:read` | The conversion operation history: who converted what, which targets were created versus linked, and which rows are stuck. |
| `POST /api/v1/LeadScore/action/conversion/operations/:id/retry` · `…/close` | `LeadConversionRecover:edit` | Retry an operation whose accounting proves nothing was written, or close one a human decides not to retry. |
| `POST /api/v1/LeadScore/action/work/recover-conversion-operations` | `LeadConversionRecover:edit` (worker secret) | The off-by-default sweep that settles `processing` rows a crash left behind. It **never** creates a record. |
| `GET /api/v1/LeadScore/action/report` | `LeadScore:read` | The operational numbers: the scored population, the bands, the freshness and the conversions — under the reader's own record scope. |
| `GET /api/v1/Jobs` (`/admin/jobs` in the SPA) | platform admin | The shared job records: the debounced recalculations and the rebuild chunks, with their failures. |

**Never** edit a score, an evaluation, a conversion operation or an AI insight through the record API.
The write guard refuses it (an administrator included) because those rows are a record of what the system
did — plan §0.1-8 and §5.3.

## 1. Turning it on, in this order

The order matters, because each step depends on the previous one being in place.

1. **Publish a model.** `/lead-score` → *Models* → draft → validate → publish. A published version is
   immutable; a change is a new version, and the old evaluations keep naming the version that produced
   them.
2. **Choose the active model** (`scoring.activeModelId`). Until one is chosen, nothing is scored: the
   calculation service refuses with `LEADSCORE_NO_ACTIVE_MODEL` and names whether the model is missing,
   unpublished or archived.
3. **Turn on `features.scoring`.** Scores start being computed for the Leads you can read; the
   projection and the evaluation history appear together, in one transaction.
4. **Turn on `features.manualRecalculation` and `features.eventRecalculation`** as you need them. The
   event-driven path is a debounced job per Lead per model version; a burst of edits collapses into one
   job, and an edit that cannot move the score queues nothing.
5. **Turn on `features.scoreExplanation`** when the card should show the rule-by-rule reasons.
6. **Only then, the conversion chain**: `features.fieldMapping` → `features.conversionPreview` →
   `features.leadConversion` → `features.conversionRecovery`. Each switch is a requirement of the next,
   so a chain with a hole stays inactive and says so in the settings warnings (`requirementUnmet`).
7. **Last, and optionally, `features.aiInsight`** with an agent chosen (`insight.agentId`). The AI
   explanation is the only part that spends money, and it is off by default.

Turning the module off (`enabled: false`) closes every screen and every command and stops the jobs. The
scores already stored on Leads stay where they are — they are a record of what happened, not a live
value — and the core Lead lifecycle is untouched.

## 2. The switches, and what each one turns on

| Switch | Effect when off |
| --- | --- |
| `scoring` | No score is computed or stored. The projection stays as it was. |
| `scoringPreview` | `action/model/preview` refuses; the model workspace loses its preview. |
| `modelAdministration` | Drafting, validating, publishing, archiving and forking refuse. Published models stay readable. |
| `scoreExplanation` | The card shows the number and the band, not the per-rule reasons. |
| `manualRecalculation` | The Recalculate button and the command refuse. |
| `eventRecalculation` | A committed Lead change queues no recalculation job. |
| `batchRecalculation` | `action/recalculate-batch` refuses; the rebuild cannot be started. |
| `decaySweep` (under `signals`) | The nightly sweep settles without a run. |
| `engagementSignals` | A rule that reads `marketing_events` or email clicks **skips**, and the evaluation says which state produced the answer. |
| `thresholdNotifications` | A band crossing is still published as an event, but nobody is interrupted. |
| `duplicateDetection` | The candidate review is off; the conversion no longer warns about a possible duplicate. |
| `fieldMapping` / `conversionPreview` / `leadConversion` / `conversionRecovery` | The conversion chain is inactive, step by step. |
| `opportunityConversion` | A conversion may still build a Contact and an Account, but not a deal. |
| `aiInsight` | No AI explanation is generated, and the stored answers are hidden. The score is unaffected. |

Every switch is **effective** only when its requirements are met too; the settings screen lists the
unmet ones, and `GET action/health` shows the same answer.

## 3. What to watch

- **`checks.entity-registration`, `checks.schema-indexes`, `checks.write-guard`** in the health view.
  A red check here is an installation problem, not an incident: the module's records are not registered,
  an index is missing (a migration was not applied) or the write guard is not registered. Fix the
  installation before anything else — `npm run db:migrate` applies the additive migrations.
- **Freshness.** `GET action/report` → *Score freshness* counts the Leads by `scoreStatus`. A growing
  `stale` or `pending` column means the recalculation path is not keeping up: check the debounce, the
  job failures in `/admin/jobs`, and whether `eventRecalculation` is on.
- **The conversion operations.** `GET action/conversion/operations?status=processing` lists the attempts
  that have not finished. A row older than an hour is *stuck* and the recovery scan will settle it to
  `failed_retryable`; a row in `needs_review` is waiting for a human.
- **The AI spend.** Each stored insight carries its token and cost counters; sum them for the period
  before enabling the feature wider.

## 4. Recovery

### A score is stale or missing

**Symptom.** The card says *stale*, or the Lead has no score.

**Cause and safe action.** The Lead changed after the last evaluation, the model changed, or the
recalculation never ran.

1. Read the reason on the card (`freshness.reasons`) — it names which of the three it is.
2. `POST action/score/recalculate` for that Lead, or `action/recalculate-batch` for a bounded set. Both
   are idempotent: an unchanged Lead records nothing and its `version` does not move.
3. If a recalculation fails, the evaluation row carries `errorSummary` with safe codes; the Lead keeps
   its previous score rather than a wrong one.

### A conversion is stuck

**Symptom.** `GET action/conversion/operations` shows a row in `processing` for longer than the attempt
should take.

**Safe action.** The attempt was claimed, and the work happens in **one transaction**: either every
target, the Lead's references and the operation row committed, or none of them did. So a stuck row has
written nothing, and the recovery scan says so:

1. Run the scan (`action/work/recover-conversion-operations`, `conversion.recovery.enabled`): it settles
   `processing` rows to `failed_retryable` **only** when it can prove nothing was written.
2. `POST action/conversion/operations/:id/retry` re-runs the stored plan. The plan is re-derived from the
   stored decisions and refused as `needs_review` when the Lead, the map or the reader's visibility moved
   on — that is the design, not a bug.
3. If a human decides the attempt should never be retried, `…/close` settles it as `failed_final`. The
   row stays; nothing is deleted.

**Never** convert the same Lead with a new operation key to "get past" a stuck attempt: the Lead is
already `Converted`, and the second attempt is refused with `LEADSCORE_ALREADY_CONVERTED` — but the
refusal does not undo anything, and the history would then show two attempts for one conversion.

### An AI explanation is missing or refused

**Symptom.** The button is absent, or the request is refused.

**Read the code.** `actions.insight.reason` in the score answer names it: `NOT_CONFIGURED` (no agent
chosen), `AI_UNAVAILABLE` (AIAgents execution is off or paused), `AI_AGENTS_UNAUTHORIZED` (the caller
has no AIAgents `use` right), `AUTHORIZATION_DENIED` (no LeadScore insight right), or
`LEADSCORE_MODULE_DISABLED` (the feature is off). The refusal codes `LEADSCORE_INSIGHT_*` say the same
thing to a client that asks anyway.

**The answer is never worth retrying blindly.** A repeated request key returns the first answer — that
is the point of the key. A *different* key is a new provider call and a new cost, so do not retry a
failed generation with a fresh key unless the cause was fixed.

## 5. Known limitations

- **A score is a snapshot.** It describes the Lead at `inputsAsOf`, and the card says so. The engine has
  no clock: the evaluation carries the instant it was taken.
- **The band vocabulary is fixed** (`Unknown`, `Cold`, `Warm`, `Hot`, `Sales Ready`, `Disqualified`),
  and `Disqualified` is reachable only through a `setBand` rule or the existing `Dead` Lead status — a
  low score never disqualifies anybody by itself.
- **The AI explanation is provider output.** It is labelled as AI-generated, it is stored separately from
  the score, and it cannot move a score. It is not translated by the SPA, and a reader who cannot see
  one of the fields the answer was grounded on is not shown the text.
- **A correction workflow does not exist.** Undoing a conversion is an explicit admin action outside this
  module; the command never reverses a conversion silently.
- **The report is a current snapshot**, with one windowed slice (the conversions of the last 30 days).
  There is no historical trend yet.

## 6. Where the code is

| Concern | File |
| --- | --- |
| The switch, the gate and the operations | `apps/api/src/lead-score/lead-score-feature-gate.service.ts` |
| The settings document | `apps/api/src/lead-score/lead-score-settings.service.ts` |
| The score read, the explanation and the actions | `apps/api/src/lead-score/lead-score-explanation.service.ts` |
| The evaluation and the projection | `apps/api/src/lead-score/lead-score-calculation.service.ts` |
| The conversion command and its recovery | `apps/api/src/lead-score/lead-conversion.service.ts`, `lead-conversion-audit.service.ts` |
| The AI explanation | `apps/api/src/lead-score/lead-score-insight.service.ts` |
| The operational report | `apps/api/src/lead-score/lead-score-report.service.ts` |
| The records and the write guard | `apps/api/src/lead-score/lead-score-records.ts`, `lead-score-write-guard.service.ts` |
| The worker jobs | `apps/worker/src/handlers/lead-score-handlers.ts` |
