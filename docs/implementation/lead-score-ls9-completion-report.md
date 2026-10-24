# Phase 19-LS.9 — Qualification Workflow and Signals: completion report

`PLAN_Phase_19_LeadScore.md` §6.4, §6.6, §10.3, §10.4, §16 (`19-LS.9`); audit §11 `LS.9`, decisions D7/D9/D11,
gaps G2/G6; compatibility `docs/compatibility/lead-score.md` §3 (Recalculation, Threshold actions, Signals a
rule may read), §7 deviations, §8 verification record.

**Exit criterion (plan §16):** *optional signal source failure does not break scoring and threshold actions are
auditable.* Both halves are asserted by tests that fail if the claim is removed: a model with an engagement rule
still scores the completeness half (30, not 70) with the skip named when `engagementSignals` is off, and answers
a definite zero when the Lead has no events; and a band crossing leaves one notification and one audit row — both
keyed by the crossing itself — plus the two versioned events behind, so a redelivered job answers
`suppressed: 'duplicate'` instead of interrupting the owner twice. The fourth state — `absent`, Marketing
Automation not installed at all — is the one this database cannot produce, because the table is here; it is
covered by the marker check itself (`isSourcePresent()` reading `information_schema`, with the same
`disabled`-style skip path the other three states take), not by a test that fakes a missing table.

## 1. What landed

**The engagement read — `apps/api/src/lead-score/lead-score-signals.ts` (new).** `LeadScoreSignalsService` is
the only place Lead Score touches another module's data. It reads `marketing_events` — Marketing Automation's
own table, not a metadata entity, not an MA service (plan §0.1-4: never assume an integration exists) — scoped
to `recipient_entity_type = 'Lead'` and `recipient_entity_id = <this Lead>`, newest-first, inside the rule's
window, capped at `MAX_SIGNAL_EVENTS_PER_PLAN = 200` rows per plan and `MAX_SIGNAL_PLANS_PER_MODEL = 20` plans
per model. **One query per source, not per rule**: eight engagement rules that ask the same question of the
same window cost one index range scan. Absence is detected with the metadata/schema marker the audit settled on
(§7.1) — `information_schema` for the table, the `Campaign` entity for the module — never by importing MA. The
answer is one of four states (`available`, `no_events`, `disabled`, `absent`) plus the timestamps it found; the
state is stored on the evaluation, printed by the preview, and printed by the card when it is the reason a rule
was not answered — so a score always says *what it did not know*.

**The engine still has no clock.** `lead-score-evaluator.ts` receives `snapshot.signals = { evaluatedAt, readings }`
from the caller and derives the metrics (`eventCount`, `lastEventAt`, `daysSinceLastEvent`, and the `emailLinks`
slice `clickCount` / `lastClickedAt` / `daysSinceLastClick`) against that instant. Time decay — `linear` toward
the window edge, `halfLife` at `0.5 ** (age / halfLife)` — is applied **to the signal**, never to a stored row
(plan §6.4), so a re-run of one reading at one instant is bit-identical and the reproducibility assertion of
LS.4 still holds. A rule whose source is not `lead` and is not a readable engagement source skips with
`LS_EVALUATION_SIGNAL_SOURCE_NOT_READABLE`; a rule whose source is present but not read skips with the new
`LS_EVALUATION_SIGNAL_SOURCE_UNAVAILABLE`, and both names carry the state that produced them.

**Provenance that survives being read.** Each matched engagement rule stores a `signal` block on its
`ruleResults` entry — `source`, `eventTypes`, `windowDays`, `metric`, `value` — and the evaluation stores its
`signalState`, so the explanation, the paged history and the Lead card can name the window and the number behind
the points without re-reading anything (`ScoreBreakdownEntry.signal`, `explanation.signalState` on both read
paths). The idempotency key is now
`sha256(leadId, modelId, modelVersion, inputsHash, signalsHash)`. That split is the whole point: `inputsHash`
stays *the Lead's own fields*, so LS.5's freshness verdict keeps its meaning, while a signal that has decayed
changes only `signalsHash` and is therefore recorded as the different evaluation it is — a repeat of an
identical reading is still absorbed by LS.2's unique index.

**The validator bounds it before it can run (LS.3's mechanism, LS.9's rules).** An engagement rule must name a
whole-day window in `1…365` (`LS_RULE_SIGNAL_WINDOW_INVALID`), an event type the reader actually knows
(`LS_RULE_EVENT_TYPE_UNKNOWN`, new), and `emailLinks` is forced to `clicked`. Its condition is checked against
**that source's metric policy**, not the Lead's field grant — `eventCount` is not a Lead field and a rule over it
is not allowed to look like one. A model with more than 20 distinct plans is refused
(`LS_MODEL_SIGNAL_PLANS_LIMIT`, new) rather than silently truncated, because a score that quietly dropped half
the author's rules is worse than a publish that fails. The pending-phase refusal
(`LS_RULE_SIGNAL_SOURCE_NOT_IMPLEMENTED`) is gone: it named a phase that has now delivered, and its code had no
other consumer.

**Threshold actions — `apps/api/src/lead-score/lead-score-threshold.service.ts` (new).** After the projection
write, **inside the same transaction**, `afterScore()` dispatches `leadScore.updated.v1` for every recorded
score and `leadScore.bandChanged.v1` when the band really moved, inserts one in-app notification for the Lead's
owner — behind `features.thresholdNotifications` — and appends one `leadScore.thresholdAction` row to
`audit_log`. Notification id and audit id are digests of the crossing
(`lead | from→to | modelVersion | evaluationId`), inserted `on conflict do nothing`, so the primary key *is* the
dedup: no check-then-write race, and a replayed job leaves no second trace. The event payload carries ids,
version, score, band, coverage, result state, trigger, timestamps and correlation — **no Lead name and no record
body**, because an outbox row is readable by anything that can subscribe. Nothing converts, and no Lead field
other than the LS.5 projection is written.

**Workflow's seam, used rather than duplicated.** The platform's trigger vocabulary is closed
(`entity.created/updated/deleted/restored`), so an administrator's reaction to a band is the `entity.updated` on
`Lead` whose `changed` already names `scoreBand` — the projection write is the trigger, and `leadScore.*` events
are for consumers that can name an event. Lead Score builds no second rule engine and no automations table.

**The decay sweep.** `settings.signals.decaySweep` (`enabled` default **false**, `limit` 1–2000, `chunkSize`
1–50) + a `scheduled_jobs` row `leadScoreDecaySweep` (`35 3 * * *`, seeded `on conflict do nothing`) + the worker
job `leadScore.decaySweep` → `POST /LeadScore/action/work/decay-sweep` behind `x-worker-secret` →
`decaySweep()`, which is **a rebuild with a source**, not a second bulk engine: it enqueues the LS.6 chunked path
with `target.source = 'decay_sweep'` and answers `skipped: 'disabled' | 'noDecayingRules'` when the switch is off
or the active model has no rule whose signal decays and no condition that reads a `daysSince…` metric. A score
whose inputs cannot move is not worth scanning the Lead table for.

**The gate, honestly widened.** `LEADSCORE_OPERATIONS` is 16 now: `engagementSignals` (capability `recalculate`,
feature `engagementSignals`), `thresholdAction` (capability `recalculate`, feature `thresholdNotifications`) and
`decaySweep` (capability `batchRecalculate`, feature `engagementSignals`). Both LS.9 features flipped from
`pendingPhase: 'LS.9'` to delivered in `lead-score-module.ts`, and the editor catalog now answers the metric list
per source, the event-type vocabulary, the window bounds and the per-plan cap, so the rule form offers exactly
what the validator accepts.

**On screen.** `RuleEditorModal` grew the engagement branch of the same form: source, event type (with "Any
engagement" meaning "any real engagement — a delivery alone never does"), a mandatory lookback bounded by the
catalog, a half-life only when the policy needs one, and the condition builder switched to **that source's
metrics** as its field list. `PreviewTab` says which of the four states the sample came back with. The Lead Score
card prints the rule's signal provenance (`Signal · Marketing events · 2 · last 30 days · Engagement count = 3`).
`SettingsTab` carries the sweep with its limit and chunk and the module-health answer about whether the event
table is even present.

**Schema.** `database/migrations/074_phase19_lead_score_signals.sql` is one additive partial index —
`(recipient_entity_type, recipient_entity_id, occurred_at DESC) WHERE recipient_entity_id IS NOT NULL` — because
`marketing_events` indexed its recipient columns not at all, and a per-Lead engagement read without one is a full
scan of another module's log inside a scoring path. No table, no column, no data touched.

## 2. The findings that changed the design

**Audit G6's email-hash fallback is not safe here, so it was not built.** The gap suggested matching a Lead by
normalized email when no recipient row exists. An email address is shared by a Contact, an Account and a Lead,
and Marketing Automation keys its recipient by *whichever record the send addressed*; falling back to the address
would attribute another person's engagement to this Lead and score on it. A Lead with no recipient rows is a
**definite zero** for that window — which is an answer, and the state that records it is `no_events`, not a
silent null. This is a deviation from the audit's suggestion, recorded rather than quietly dropped.

**Loop prevention is a field-list fact, and LS.9 made it a stronger one.** LS.6 proved the score write cannot
re-trigger itself because `changed ∩ requiredInputFields(model) = ∅`, and that only holds because LS.3 refuses a
scoring output as a rule input. LS.9 adds a *second* reason the loop cannot close: an engagement rule's input is
not a Lead field at all, so it can never appear in a Lead's `changed` list. A decayed signal therefore does not
queue a job — which is precisely why the sweep exists, and why its skip condition is "the model has a rule that
depends on time" rather than "the model has rules".

**The three ways a signal is missing are not one boolean.** `disabled` (an operator's switch), `absent` (this
installation has no MA), and `no_events` (the table answered, empty) have different fixes and different meanings
for the number a Lead is showing. Collapsing them would let a re-enabled switch look like new engagement, so the
state is stored per evaluation and named per rule, and the preview shows it before an administrator publishes.

**A ceiling must refuse, not clamp.** The first cut capped `signalPlans()` at 20 by stopping iteration, which
would have scored a 21-rule model under 20 of its rules and reported a score as if it were the whole model.
LS.6 already established that batch ceilings are refusals on both doors; the same rule now applies here — the
validator refuses and the reader keeps a slice only as defence in depth for a draft written straight through the
record API.

**Events describe; only the notification interrupts.** The temptation was to gate `leadScore.updated` behind
`thresholdNotifications` too. It is not: the event is part of recording what happened (and the audit trail
references the event ids), while the notification is the one artifact that reaches a person, and that is what the
switch is for. The LS.9 test asserts the split from both sides — switch off leaves `suppressed: 'disabled'` and
still publishes the event.

**`decay_sweep` is a job source, not an evaluation trigger.** The vocabulary has always listed `decay_sweep` as a
possible trigger, but the sweep reuses the batch path, so every evaluation it produces honestly names
`batch_rebuild` and the sweep's own attribution lives in `jobs.target.source`. Renaming the stored trigger would
have made one chunk's rows disagree with the next chunk's for no information gain; the gap is documented here
instead of papered over.

**A first score *is* a crossing, and that is the quieter choice.** A Lead that has never been scored shows
`Unknown`, so its first real band is a change the rep sees on the record. `leadScore.updated.v1` therefore
publishes for every recorded score, and `bandChanged` publishes whenever the displayed band moves — including
into a real band from `Unknown`. What does *not* happen is a repeat: a rebuild that lands every Lead on the band
it already carried publishes one event per Lead and notifies nobody, which is what keeps a 2 000-Lead sweep from
becoming 2 000 interruptions. The comment on the dispatch said the opposite until the browser pass scored a
fresh Lead and a notification arrived; the suite had it right all along (`previousBand: 'Unknown'` → `Hot` is the
crossing, and the second identical write leaves no event, no notification and no audit row).

**The browser pass found two real defects that every test was green over.** Both were of the same family — the
write path had the provenance, the read path did not:

1. the explanation service rebuilds each stored rule outcome field by field (`parseRuleResults` reads a row as
   *data*, because an older build may have written an outcome or dimension the current vocabulary no longer
   names) and its rebuild list did not include the new `signal` block. The card therefore printed no signal
   line at all, and the unit tests passed because they asserted the *evaluation result* object, not the
   response the SPA consumes. Fixed by carrying the block through, with a shape guard rather than a cast.
2. `signalState` was put on the write response but never stored, so a stored evaluation could not say whether
   its engagement rules skipped because the switch was off or because this installation has no Marketing
   Automation. The new attribute is stored on the row (LS.2's entity gained one `text` attribute, placed in the
   evaluation's `explanation` detail panel, which LS.2's layout assertion requires for every `inDetail` field)
   and served on both the current-score explanation and each history row.

**A label is a bug waiting to be a code.** The card's first cut interpolated `marketingEvents`, `opened` and
`eventCount` straight into the sentence — a developer's log line wearing a label, in a screen a salesperson
reads. It now resolves each through the module's own vocabulary (`admin.source.*`, `admin.event.*`,
`admin.metric.*`) and formats a count as a number in the reader's locale (`1,857` in Vietnamese) or a
`lastEventAt` as a moment in their timezone. The same went for the preview's plan list. The catalog guard in
`lead-score-explanation.test.ts` now covers all of those keys in **both** locales, because one malformed key
does not break one label — it disables translation for the whole instance.

## 3. Verification

- `apps/api/test/lead-score-engagement.test.ts` — **9 new tests**: the plan contract (one plan per distinct
  question, the window clamped to the vocabulary's bounds, and a bare `delivered` never counted as engagement);
  the switch-off case scoring the Lead-field rules and skipping the engagement rule with the named code; a Lead
  with no events answering a **definite zero** while a metric with nothing behind it answers nothing at all; a
  band crossing producing exactly 2 outbox rows + 1 notification + 1 audit row and the immediate repeat producing
  **nothing new**; `thresholdNotifications` off suppressing the notification while the event still publishes; a
  first-ever score claiming no crossing; the signal provenance and `signalState` read **back out of the stored
  evaluation** (the defect §2 describes); the worker route refusing a wrong `x-worker-secret`; and the sweep's
  three answers (`disabled`, `noDecayingRules`, `started` with `target.source = 'decay_sweep'`).
- `apps/api/test/lead-score-evaluator.test.ts` — **71 tests** (6 new for the engagement signal: metric
  derivation from timestamps, the two skip codes, linear vs half-life decay against `evaluatedAt`, an unknown
  metric, `signalsHash` empty vs set, and a changed signal producing a different signature).
- `apps/api/test/lead-score-validator.test.ts` — **30 tests** (1 rewritten for the engagement bounds, 1 new for
  the 20-plan ceiling *and* the 21st rule that shares a plan and stays publishable).
- `apps/worker/src/handlers/lead-score-handlers.test.ts` — **210 tests** (5 new: the sweep job's name, its route,
  header and payload, the completed-on-refusal vs throw-on-transport split, and the message it reports).
- `apps/api/test/lead-score-explanation.test.ts` — the both-locale catalog guard extended with every word LS.9
  puts on a screen (the signal sentence, its two explaining states, the source, event-type and metric names, the
  preview's window phrase, the rule form's engagement hints, the sweep panel and the `gte` operator).
- All eleven LeadScore API files in **one group: 248 passed / 0 failed** — LS.8's recorded cross-suite hazard is
  closed, because every suite now pins the whole `leadScore` settings document in `beforeAll` and the e2e specs
  restore it (and the admin locale) afterwards.
- Full `npx vitest run` — **2,883 passed / 34 failed across 202 files**. The 34 are the same seven
  pre-existing shared-state files as the LS.6/LS.7/LS.8 baseline (`ai-agent-runs`, `service-desk` ×3,
  `crm-chat` ×3); zero `lead-score` failures, and the +16 over LS.8's 2,867 is exactly this phase's new
  engagement (9), evaluator (6) and validator (1) tests. Worker suite: **210 passed / 0 failed across 20 files**.
  A run taken *before* the browser pass had finished reported 37 failures in 8 files — the three extra were in
  `docs.test.ts`, whose ETag and locale-fallback assertions depend on the shared `admin` row's stored `locale`,
  which the pass had left at `vi`. Restoring it is part of the cleanup, and the run above is the one after that.
- `npx playwright test e2e/lead-score-admin.spec.ts e2e/lead-score.spec.ts` — **9 passed** (2 new for LS.9: an
  engagement rule authored entirely from the form — including the lookback refusal before the window is filled,
  the rule row's condition read back as the sentence *"Engagement count at least 2"*, the stored rule asserted
  to be `marketingEvents` + a 30-day window + a metric condition with no Lead field in it, and the preview of
  that same draft naming what it did with the signal: *"Engagement was read; none of these Leads has a matching
  event."*; plus the settings screen carrying the decay sweep), with LS.8's 4 and LS.7's 3 still green.
- `npm run typecheck` (API + web), `npx eslint` on every touched path, `pnpm --filter @carocrm/web build` and
  `pnpm --filter @carocrm/api build`, migration 074 applied through `database/migrate.ts` and read back from
  `pg_indexes`.
- **A browser pass on a Lead that really has engagement** — a published model with one completeness rule and one
  half-life-decayed `marketingEvents` rule, two `marketing_events` rows addressed to that Lead, then the score
  read through the UI in Vietnamese at 1440px: the card shows `50 · Ấm · 100%`, both reason rows, and the line
  *"Tín hiệu · Sự kiện marketing · đã mở · 30 ngày qua · Số tương tác = 1,857"* — the decayed count, not the raw
  2, because the two opens are 1 and 2 days old against a 14-day half-life. The crossing also put
  *"Lead moved to Warm"* in the notification bell (English, like every other module's notification text — the
  platform's convention is that the writing module owns the sentence), and `audit_log` carries the matching
  `leadScore.thresholdAction` row. The same pass found the two defects in §2, which is the reason it is run.
  Cleanup: the model rows, the Lead, its evaluations, events, notification, audit row and outbox rows removed by
  exact id (a `LeadScoreModel` row is `removable: false`, so it goes at the database level), the settings
  document and the admin locale put back, and a residue query reporting zero rows for the run marker.

## 4. What this phase does not claim

- **No Voice or Activity signal.** The audit found no Lead→Activity relation and no open/click event in Voice
  (G2), so there is no contract to read and none was invented. `marketingEvents` and `emailLinks` are the two
  sources the repository actually offers; a third would be an assumption about a module that has not declared it.
- **No email-address fallback** (see §2), so a Lead that was marketed to as a Contact shows `no_events` rather
  than that Contact's engagement. Making that right needs a recipient-resolution contract in MA's own module, not
  a heuristic in Lead Score.
- **No email or push channel.** The notification is the platform's in-app `notifications` row. Sending mail would
  mean a template, a provider and a consent decision, and LS.9's criterion is about *auditable*, not about loud.
- **No automatic conversion and no threshold-driven workflow node of its own** — plan §6.6 forbids it and the
  projection write remains the only Lead write the module makes.
- **The sweep schedules work, it does not re-time a decay.** A decayed signal is caught on the next sweep, at
  most once a day, which is a deliberate cadence, not a real-time freshness guarantee; `scoreStatus` stays honest
  about it.
- **Signal values are not ACL-filtered per field**, because they are not fields: they are counts of delivery
  events addressed to a record the caller already may read. A reader who cannot see the Lead sees no score at all
  (LS.5's rule), and the breakdown names the metric without naming an event.
- **A compound engagement condition names one metric.** The provenance block carries the *first* comparison's
  metric and value (`metric: 'eventCount'`, `value: 1.8574`), because that is what a rule row can show in one
  line; every metric the condition read still joins `signalsHash`, so a change in the second one is still a
  different recorded evaluation. A future screen that wants the whole list can read it from the hash inputs
  rather than from a widened block.
- **`leadScore.modelPublished` is still not emitted** (compat U12's announcement half); switching the active model
  takes effect on the next change or the next rebuild, exactly as documented before this phase.
- LS.10–LS.18 (conversion domain, duplicates, mapping, wizard, recovery, AI) are not started, and their
  operations still refuse with `LEADSCORE_PHASE_PENDING`.
