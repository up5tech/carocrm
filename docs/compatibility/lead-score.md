# LeadScore — compatibility and behavior reference

> Phase 19-LS.0 onwards (`PLAN_Phase_19_LeadScore.md` §0.2, §16 `19-LS.0`).
> Repository audit and feature contract: `docs/implementation/lead-score-audit.md`.
> Status: **19-LS.0, 19-LS.1 and 19-LS.2 delivered** (LS.0 = audit, feature contract and decisions
> D1–D13; LS.1 = module registration: descriptor, capability matrix, `leadScore` settings document,
> feature gate, health view; LS.2 = the schema and metadata foundation: the four `LeadScore` records,
> the current-score projection and `Converted To` attributes on the core `Lead`, the `score`/`converted`
> detail panels, `database/migrations/073_phase19_lead_score.sql` and the write guard that keeps those
> attributes server-owned — evidence in
> `docs/implementation/lead-score-ls1-completion-report.md` and
> `docs/implementation/lead-score-ls2-completion-report.md`).
> **19-LS.5 delivered scoring that is computed *and kept*, 19-LS.6 delivered what decides *when* to score,
> 19-LS.7 put it on the Lead, 19-LS.8 put the model behind an administrator's form and 19-LS.9 gave the score a
> second input and a voice, 19-LS.10 wrote the **conversion contract** without writing conversion behavior,
> 19-LS.11 answered *who this Lead may already be*, 19-LS.12 turned the contract's map and preview into code,
> 19-LS.13 made the conversion run, 19-LS.14 put it on the Lead as a wizard, 19-LS.15 verified what it does
> to the record's history, 19-LS.16 completed the target set with the optional Opportunity and 19-LS.17
> added the optional AI fit insight; only 19-LS.18's rollout and verification remains.** A model can be
> configured, validated,
> published, frozen and previewed
> without writing anything; **recalculated per Lead** (evaluation row and the Lead's current-score projection
> stored together, both readable with an explanation and a freshness verdict); and now **scored without
> somebody asking** — a committed Lead change queues one debounced job per Lead per model version, and an
> administrator can queue a bounded, chunked, cancellable rebuild, and an administrator can now draft, validate,
> preview, publish and rebuild it from a screen instead of a console. A rule can now also read **engagement** —
> a bounded window of `marketing_events` rows addressed to that Lead, with time decay applied to the signal and
> a sweep that re-scores the records whose decay makes a difference — and a stored score **announces itself**:
> `leadScore.updated.v1` always, `leadScore.bandChanged.v1` on a crossing, one notification for the Lead's
> owner and one `leadScore.thresholdAction` audit row — the last two keyed by a digest of the crossing itself, so
> a duplicate delivery cannot double-notify. An engagement source that is absent or switched off does not fail a
> score: those rules skip, and the evaluation says which of the four states produced the answer. Conversion
> exists end to end: 19-LS.10 decided its contract (state machine, combination matrix, mapping policy, recovery
> semantics) in `docs/implementation/lead-score-conversion-contract.md`, 19-LS.11 built the duplicate resolver,
> 19-LS.12 the field map and the side-effect-free preview (values, skipped fields, required gaps, before/after
> conflicts, a `previewHash` over the Lead revision, the versions, the merges and the reader's own field
> visibility), 19-LS.13 the command that runs it — one transaction, one operation row, one answer a retry can
> replay — and 19-LS.14 the screen: a Targets/Review/Result wizard that only offers what the server's preview
> says, and a `Converted To` panel that shows what was made. 19-LS.16 added the third target to that same
> command: an Opportunity created or linked with the operation's `accountId`, its `contactIds` **appended** to
> rather than replaced, its name composed from the Lead, and Sales' stage/document semantics untouched.
> 19-LS.17 added the **optional** AI explanation: one operator-clicked AIAgents run, grounded in the stored
> score and five business fields, stored as its own record and labelled as AI-generated — off by default, and
> never able to change a score. Only 19-LS.18's rollout and verification remains.
> Canonical module name: `LeadScore` (no `Ua` prefix). API prefix: `/api/v1/lead-score` plus
> `/api/v1/leads/:leadId/{score,conversion-preview,convert}` semantics — realized, per §2.5, as
> `LeadScore/action/score/*` and `LeadScore/action/conversion/*` (both delivered).
> Baseline reference re-checked against public EspoCRM documentation on **2026-10-24**
> (Sales Management / Leads and converting). Re-verify and update the date whenever a later
> sub-phase changes a documented behavior.

This is a clean-room reimplementation. No EspoCRM PHP source, frontend asset, icon, translation or
branding is copied; upstream product documentation is used only to describe observable behavior and
the compatibility baseline.

---

## 1. Reference baseline (documented upstream behavior)

| Item | Documented baseline | This repository |
| --- | --- | --- |
| Lead lifecycle | Lead has a `Converted` status among its status options | **Matches.** `Lead.status` enum is `New, Assigned, In Process, Converted, Dead` with default `New` — `database/seed-metadata.ts:250-257`. No status value is added, renamed or repurposed by `LeadScore` |
| Convert action | A conversion form lets the user pick target record types — Account, Contact and/or Opportunity | **Delivered (LS.14, extended in LS.16).** The wizard offers exactly the combinations in §4 — its rows come from the server's `targets` answer — and the backend re-validates every choice |
| Converted Lead | The Lead stays in the system with `Converted` status and references to the records created/linked, shown in a "Converted To" panel | **Delivered (LS.13).** The Lead row is never mutated into another entity type and never deleted; references are `convertedAccountId` / `convertedContactId` / `convertedOpportunityId` / `conversionOperationId` / `convertedAt` / `convertedById` (§5.3) |
| B2C mode | When the installation runs in B2C ("no company") mode, conversion **to Account** is not available | **Intentional deviation — see §2.1.** No B2B/B2C mode exists in this build, so the equivalent control is the module setting `conversion.targets` |
| Lead scoring | **No lead scoring is documented** in the reference baseline product's user guide | **Extension, not compatibility surface.** Everything in §3 is `LeadScore`-owned new behavior; it must never be described as upstream-compatible |
| Web-to-Lead | Documented as an inbound lead-capture form producing a Lead | **Out of scope for LS.0–LS.18.** No web-to-lead endpoint exists in this build (verified negative finding). A captured Lead is scored/converted by the same rules as any other Lead once such capture exists |

## 2. Product decisions that differ from the baseline (and why)

### 2.1 No global B2B/B2C mode

`AGENTS.MD` §5 and plan §7.7 forbid inventing a global product mode the existing CRM does not have,
and the audit confirms none exists (no `B2B`/`B2C`/`companyType` in code, settings, preferences or
metadata). Instead:

- the `leadScore` settings row exposes `conversion.targets` (default: `Account`, `Contact`,
  `Opportunity` all enabled) — **shape decided in 19-LS.10**, contract §5.2: the section is
  `{targets, fieldMergeAllowed, mapping}`, `targets` is a deduplicated subset of `CONVERSION_TARGETS` that
  refuses an unknown value **and** refuses the empty list (disabling conversion entirely is
  `features.leadConversion`'s job, and two switches for one decision is how they start disagreeing);
- an installation that wants B2C-like behavior disables `Account` there;
- the **backend** validates the mode independently of the UI, so a disabled target cannot be created
  even by a direct API call (plan §7.7) — and an unmet choice is a refusal
  (`LEADSCORE_TARGET_DISABLED`), never a silent downgrade to a smaller combination (§4.1's last line, and
  contract §4.2's no-repair rule).

Consequence for compatibility claims: this build does **not** reproduce upstream's B2C "conversion to
Account is unavailable" switch, because it has no B2C switch at all. It reproduces the *effect*
(Account conversion can be turned off), through a different, module-owned setting.

### 2.2 Conversion is a command with an operation record

The baseline describes a form; it does not document idempotency or an operation audit trail. This
module adds `LeadConversionOperation` (plan §5.5, §7.8) because retry-after-timeout and double-click
protection are requirements here. A converted Lead therefore carries *more* provenance than the
baseline record, not less.

### 2.3 `Dead` is the disqualification signal, not a new status

The baseline has no `Disqualified` Lead status. `LeadScore` does not add one: a `setBand` rule may map
the existing `Dead` status to the `Disqualified` band, and a low score alone never disqualifies a Lead
(plan §3.3).

### 2.4 Opportunity conversion is available from the start

The baseline supports converting a Lead to Opportunity. In this build `Opportunity` is a first-class
core entity (`database/seed-metadata.ts:267-301`, only `name` required) and the Sales module does not
own it, so LS.16 implements it through the same conversion command rather than deferring it. Sales
stage semantics and `SalesDocumentService.createFromOpportunity`
(`apps/api/src/sales/document/document.service.ts:1257-1312`) are left entirely to Sales.

**Delivered in 19-LS.16.** `Opportunity` is one more target on the same request: create needs
`Opportunity:create` and the map's `createDefaults.name` template (`{{lastName}} — {{company}}`), link needs
`Opportunity:read`, and either way the command sets `accountId` to the operation's Account and **appends** the
Contact to `contactIds` (never replaces: another person on the deal may not even be readable to the converter).
A linked deal whose Account would change shows the before/after in the preview (a read-only conflict — the opt-out
is choosing the deal's own Account); a created deal is announced by `opportunity_created`. Its `stage` is the
kernel default and its amount/close date/probability are not touched, and no Quote or other Sales document is
rewritten. The affordance's `targets` list is what removes the row from the wizard when
`features.opportunityConversion` is off; the preview refuses such a request with
`LEADSCORE_TARGET_DISABLED {state:'notEnabled'}`.

### 2.5 Commands are module routes, not per-record paths

The plan writes `/api/v1/leads/:leadId/score`, `…/conversion-preview` and `…/convert`. This build has no
per-record custom-action route on the generic entity controller (`apps/api/src/entity/entity.controller.ts:24-98`
offers CRUD, `massUpdate`/`massDelete`/`rowActions`, `restore` and relation routes), and every Lead Score command
since LS.5 has lived at `/api/v1/LeadScore/action/…` behind one gate. **Decided in LS.10 and carried from LS.5:**
the paths are `LeadScore/action/score/*` (delivered) and `LeadScore/action/conversion/{preview,convert,
operations,operations/:id/retry}` (contracted), with the Lead named in the body as `leadId`. The plan's
*semantics* — a Lead-scoped preview, a confirmed convert, an inspectable operation, an explicit retry — are
unchanged; a second controller shape for one module would be a second gate to forget.

---

## 3. Scoring behavior contract

| Aspect | Agreed behavior | Status |
| --- | --- | --- |
| Scale | 0–100 default (`scaleMin`/`scaleMax` per model, registered on `LeadScoreModel` in LS.2); the UI always shows the scale | fields exist (LS.2), validation arrived in LS.3; the module settings row deliberately stores no scale of its own — the model owns it. **Open since LS.7:** the card shows coverage as a percentage and the score as a number, not `30 / 100`; LS.8 gave the scale its screen (the model form names `scaleMin`/`scaleMax` and the validator refuses a band outside them), so what remains is cosmetic |
| Formula | `baseScore` → matched rule deltas in `priority` order → optional dimension weights → clamp `[scoreFloor, scoreCeiling]` → stable rounding → band lookup | **delivered (LS.4)**: `lead-score-evaluator.ts`, with the open questions defined in `docs/implementation/lead-score-audit.md` §5.2 — weights are normalized relative influence over the dimensions actually attempted, rounding is half away from zero, and the sign comes from the rule's `effect` rather than the stored number |
| Reproducibility | same model version + same input snapshot ⇒ identical score, identical reason codes, identical signature | **delivered (LS.4)**: `signature` is SHA-256 over the canonical configuration + the fields actually read + the outcome; `inputsHash` over the inputs alone. Asserted against a second call, a different clock, a different key order, a different rule-array order and two spellings of one condition |
| Missing data | `missingDataPolicy: ignore` or `neutral`, recorded as `unknown` in the breakdown; never silently 0 | **delivered (LS.4)**: conditions are three-valued, and a signal **not supplied** (a field this reader's ACL hides) stays distinct from one supplied empty — an existence rule answers about the second and refuses to answer about the first, so a withheld value is never reported as an absent one. `neutral` keeps the rule's weight in the coverage denominator, `ignore` removes it; neither subtracts |
| Rule vocabulary | declarative `{field, operator, value}` with `all`/`any`/`not`, operators limited to the audited set (`packages/formula/src/dynamic-logic/index.ts:9-26`), field paths validated against `Lead` metadata and the model's `allowedFieldPaths` | LS.3 validates and **LS.4 evaluates**: all 16 platform operators have a scoring meaning, given with the platform's own reading (case-sensitive text, `contains` as substring, empty = null/empty text/empty list), and `…/action/health` fails a check if the two lists ever drift |
| Non-executable | a formula string, a dotted path, a table name, an unknown condition key, a `password`/`file`/`formula` field and any relationship traversal are refused by name at validation time and again at publish | **delivered (LS.3)**, and **LS.4 keeps the engine non-executable too**: it evaluates the parsed tree itself, never the formula engine, and refuses a rule whose leaf is outside the grant *before* reading any value |
| Publication | a published version is immutable, and editing one means creating a new version that copies its rules | **delivered (LS.3)**: `action/model/publish`, `…/archive`, `…/new-version`; the guard answers 409 `LEADSCORE_MODEL_IMMUTABLE` to any client write of a frozen model or its rules |
| Disqualification | `Disqualified` is assigned by an explicit rule or the core `Dead` status | **delivered (LS.3)**: a numeric band named `Disqualified` (or `Unknown`) is refused at validation (plan §3.3) |
| Explainability | every displayed score carries band, model version, `calculatedAt`, `inputsAsOf`, positive/negative reason codes, coverage and evaluation status | **delivered (LS.5)**: all of it on the projection, and the per-rule detail on the evaluation row that produced it — `action/score/:leadId` returns both, with the labels in the reader's language |
| History | append-only, immutable, ACL-gated through a Lead-scoped command rather than entity read permission | **delivered (LS.5)**: `LeadScoreEvaluation` rows are written in the same transaction as the projection, paged by `GET action/score/:leadId/history`, and unreachable through the generic entity API (`read: 'no'`) — asserted from both sides |
| Current projection | the Lead carries the number, band, state, model version, coverage and reason codes so a list or badge never runs the engine | **delivered (LS.5)**: `scoreValue`…`scoreReasonCodes` are written only by the module (LS.2 guard still refuses a client), with `scorePreviousValue` for movement and `inputsHash` on the evaluation as the watermark |
| Freshness | `current` / `stale` / `pending` / `failed` / `not_scored`, with a reason a reader can act on | **delivered (LS.5)**: derived on read from the stored `inputsHash` against the current inputs, the active model and the stored state — **not** from the Lead's `version`, which the score write itself moves; a reader whose field ACL hides an input gets no claim either way (plan §6.5) |
| Recalculation | event-driven (debounced), manual (rate-limited), batch (chunked, admin-only), decay sweep; all idempotent | **delivered (LS.5 + LS.6 + LS.9)** for all four: the manual one-Lead command (`action/score/recalculate`, duplicate absorbed by the LS.2 idempotency unique index), the **event-driven** path (`entity.created`/`entity.updated` → worker → `action/work/lead-changed` → one debounced `leadScore.recalculateLead` job per Lead+model-version, burst collapsed by the deterministic job id and by the outstanding-job check), the **batch** path (`action/recalculate-batch` behind `LeadScoreBatch`, 50 Leads per chunk, 2 000 per run, cursor hand-off, cancellable) and, since LS.9, the **decay sweep** — a `scheduled_jobs` row (`leadScoreDecaySweep`, 03:35) that queues a bounded rebuild tagged `source: decay_sweep` when the active model has a time-dependent rule, and answers `skipped: 'disabled' | 'noDecayingRules'` instead of scanning when it has no reason to run. Idempotency is data, not intent: LS.5's `inputsHash` key, widened by LS.9's `signalsHash`, means a repeat run records nothing and moves nothing — while a signal that *has* decayed is a different evaluation and does get recorded |
| Explanation | score, band, contributing and skipped rules with stable codes, model version, last recalculated | **delivered (LS.5, shown by LS.7)**: `action/score/:leadId` answers the breakdown labeled in the reader's language and names only rules and outcomes — no Lead value, so it cannot read past field ACL (§6.5, §9.2) — and the Lead Score card renders exactly that, with the rule's own input value asserted absent from the reason block in the browser spec |
| Conversion interface | a rep can convert a Lead from the record, see the plan before confirming, and follow the result | **delivered (LS.14)**: the Conversion card appears because `action/conversion/affordance` answered `canConvert` (a 200 with reasons otherwise), the wizard's review *is* the server's preview — values, required gaps, skipped fields with reasons, conflicts as before/after with per-field merge opt-ins, duplicate candidates with the hidden-match count, the confirmations — confirming re-runs that preview and re-shows it if the fingerprint moved, the result separates **Created** from **Linked** with links to the records, and a lost response is resumed with the same operation key rather than a new attempt. A converted Lead shows its references in the card and in the `Converted To` panel |
| Interface | a rep can see, explain and refresh a score without an API call, and sort or filter a queue by it | **delivered (LS.7)** for the Lead: the card on the record (number, band, freshness + reason, coverage, movement, model version, both timestamps, per-rule reason, paged history with each evaluation's own breakdown) and the projection as list columns and filters. Nothing is computed in the browser, and the Recalculate/History buttons are rendered from the server's `actions` answer, not from a role name. **delivered (LS.8)** for the administrator too: `/lead-score` drafts a model, builds a rule from a field/operator/value form whose choices are the validator's own sets, validates it, publishes it behind the server's report, archives it, forks a new version, diffs two versions, previews a bounded sample without writing, queues a bounded rebuild with its job status, and controls the module's switches. The conversion wizard stays 19-LS.14 |
| Threshold actions | emit `leadScore.updated` / `bandChanged`; **never** auto-convert, never silently rewrite unrelated Lead fields | **delivered (LS.9)**: after the projection write, in the same transaction, the module dispatches `leadScore.updated.v1` for every stored score and `leadScore.bandChanged.v1` when the band actually moved, writes one in-app notification for the Lead's owner — that part behind `features.thresholdNotifications` — and appends one `leadScore.thresholdAction` row to `audit_log`. Both rows are keyed by a digest of `(leadId, previous band → new band, modelVersion, evaluationId)`, so a redelivered job cannot notify twice and the second call answers `suppressed: 'duplicate'`; a score whose rollback left no projection leaves no event either. **No conversion and no other Lead field is touched** — the projection patch LS.5 wrote is still the only write, and Workflow's own reaction point remains the `entity.updated` on `Lead` whose `changed` names `scoreBand`, because the platform's trigger vocabulary has no room for a custom domain event (§10.4, audit §1) |
| Sensitive attributes | protected characteristics and proxies are excluded; the model's field allowlist is admin-reviewable and a denylist is enforced at save | LS.3 refuses them at validation and publish; **LS.4 re-checks the grant at evaluation time** and never reads a field outside it, so a stored snapshot cannot smuggle one in |
| AI insight | optional, operator-triggered, evidence-grounded, stored separately from the numeric score, off by default; scoring works with AI disabled | **delivered (LS.17)**: `POST LeadScore/action/insight` asks the **configured published AIAgents agent** — AIAgents' own manual-run path, so its kill switch, budgets, quotas and run audit apply — and grounds the question in the stored score plus five business fields (`company`, `industry`, `title`, `source`, `status`) read through the caller's own ACL. It never sends an e-mail, a phone number, a name, a note, consent or another record, and the configured agent must read a text task and hold read-only tools. The answer is stored in its own append-only `LeadScoreInsight` record with an **AI-generated** label, the run id, the agent version and provider/model, an input digest and the counters — beside the score, never inside it. With the feature off the deterministic path is unchanged, and the AI text cannot move a score |
| Signals a rule may read today | the Lead's own declared fields only | **delivered (LS.9)** for the two the audit found a contract for: `marketingEvents` and `emailLinks`, read as a bounded window of `marketing_events` rows addressed to *this Lead* (`recipient_entity_type = 'Lead'`, new partial index in `074_phase19_lead_score.sql`) — at most 200 rows per plan and 20 plans per model, whole-day lookback 1–365, `emailLinks` restricted to `clicked` rows that carry a URL. A rule compares one of the metrics the server offers for that source (`eventCount`/`lastEventAt`/`daysSinceLastEvent`, `clickCount`/`lastClickedAt`/`daysSinceLastClick`), optionally decayed (linear or half-life) against the caller's `evaluatedAt`, so **the engine still has no clock**. **Deviation from audit G6:** there is no email-hash fallback — an address is shared by a contact, an account and a Lead, so a signal keyed on one would attribute somebody else's engagement; a Lead with no recipient rows is a definite zero, not an unknown. Voice/Activity signals stay out: the audit found no Lead→Activity relation and no open/click event to read (G2) |

**Not supported by this build** (plan §2.2, restated so no screen claims it): automatic conversion on
threshold, unsupervised Contact/Account merging, bulk conversion without preview and confirmation,
destructive Lead deletion after conversion, and any use of the score outside sales prioritization.

---

## 4. Conversion behavior contract

### 4.1 Valid target combinations (backend-validated)

> **Decided in 19-LS.10, implemented in 19-LS.13–LS.16**, with the ACL / data / settings gate made explicit per
> row and two rules this table did not carry (Opportunity's `accountId` is always set and its `contactIds` are
> **appended**, never replaced; and one create-or-link decision per type, because `LeadConversionOperation` has
> one created/linked pair per type): see `docs/implementation/lead-score-conversion-contract.md` §5.1, §6.

| Combination | Available when | Notes |
| --- | --- | --- |
| create Contact | `Contact` in `conversion.targets` + `Contact:create` | — |
| link existing Contact | `Contact:read` | a user who cannot read a candidate never sees it |
| create Account | `Account` in `conversion.targets` + `Account:create` | disabled by the B2C-equivalent setting |
| link existing Account | `Account:read` | — |
| Account + Contact | both enabled | Contact receives `accountId` (`database/seed-metadata.ts:238`) |
| Contact + existing Account | both | user-confirmed relationship |
| existing Contact + existing Account | both read/link | explicit confirmation required |
| ± Opportunity | `Opportunity` enabled + its ACL | for every combination above (19-LS.16); create fills the required `name` from the map's template, either mode sets `accountId` and appends the Contact to `contactIds` |

No invalid partial combination can reach the write layer: an unselected or hidden target is rejected
server-side, not merely filtered in the UI.

### 4.2 Duplicate policy

Staged, in order: normalized e-mail exact → phone exact → Account domain/`website` → Account company name.
The first two classify `same person`, the last two `same organization`. **No stage produces a link, a merge or
an automatic choice**: every stage can only produce a *candidate*, and a candidate becomes a link only if a
person chooses one (`duplicateOverride` is the separate, audited answer for "create anyway").
**A name-similarity stage is not implemented** — 19-LS.11 shipped the four exact stages and no fuzzy one, for a
measured reason: the `pg_trgm` attribute indexes this schema has key on field names that do not exist (see the
LS.10 note below), so a similarity pass would be a full scan of `entity_records` inside a user-facing preview
(plan §14.2), and no new index is added on a hunch — LS.18's query check owns that decision.

No new unique constraint is placed on email or phone: the current data and legitimate shared values do
not support one (decision D7). Only the score-projection and conversion-operation-key partial unique
indexes are added, following `database/migrations/032_phase19_customer_success.sql:17-25`.

> **Decided in 19-LS.10** — and the stages now name the seam each one reuses rather than the helper LS.0
> assumed had to be written: `normalizeEmailAddress`
> (`apps/api/src/marketing-automation/marketing-automation-domain.ts:1385-1387`) for email but explicitly
> **not** MA's consent `emailHash` as a join key; voice's `phoneMatchKeys`/`normalizePhone`
> (`apps/api/src/voice-communications/phone-number.ts:141,201-208`) for phone, on both the international and
> the national digit form, claiming no E.164 accuracy because a Lead carries no country to default against; a
> module-owned `domainOf()` with a hard-coded free-mail set, since nothing in the repository derives a domain
> at all; and the ACL rule copied from `VoiceContactResolverService`'s hidden-match counting
> (`voice-contact-resolver.service.ts:101-167`). The `pg_trgm` indexes LS.0 pointed at key on field names that
> do not exist (`008_phase12.sql:8-22`), so fuzzy suggestions are bounded or absent — contract §9.

> **Delivered in 19-LS.11.** `POST /api/v1/LeadScore/action/conversion/candidates` with `{leadId}` — one Lead
> per call, no parameters that widen a scan — behind the new `duplicateCheck` operation (capability
> `convertPreview`, feature `duplicateDetection`, no write). It answers `candidates` (entity, id, label,
> `matchClass`, `reasons`, and only the visible `details`), `stages` (which key ran, and `no_value` /
> `free_mail` when one could not), `hiddenMatches` (**a count of the records the caller may not read — never an
> id, a name or a hint**), `bounded`, `requiresChoice`, `canOverride`, `allowedDecisions`
> (`link` / `create_with_override` / `cancel`) and `limits` (`10` returned, `25` scanned per stage).
> Three refinements the implementation made to contract §9, each with its reason:
> **(a)** the phone key is the **last nine significant digits** (after the trunk zero), not
> `phoneMatchKeys`'s exact forms — an exact form needs a region no Lead carries, and the tail is what survives
> `+84 912 345 678` vs `0912 345 678` vs `(091) 234-5678`; a cross-country tail collision can only add a
> candidate. **(b)** The domain comparison folds `Account.website` in SQL with the exact rule `domainOf` applies
> in TypeScript (scheme, `www.`, path, query, fragment, port), so "same domain" cannot drift into "same
> string". **(c)** A record the caller may read but whose display name is hidden is **withheld and counted**
> rather than returned as a row of blanks — there is nothing to choose between without a label (contract §9.2's
> invisibility rule, applied to field ACL as well as record ACL).

### 4.3 Failure, retry and concurrency semantics

| Situation | Result |
| --- | --- |
| Same `operationKey`, operation already `succeeded` | the original result is returned; zero new records |
| Different key against an already-`Converted` Lead | `409 LEADSCORE_ALREADY_CONVERTED` — **delivered in LS.13**, caught inside the work transaction so the attempt is recorded `failed_final` / `already_converted` and the error carries that attempt's id (and never another operation's) |
| Preview fingerprint stale (Lead revised, target changed, mapping changed, **or the actor's own visible-field set changed**) | rejected — `LEADSCORE_PREVIEW_STALE` naming which component moved and no values; the user must re-preview and re-confirm. **Delivered in 19-LS.12 for the two components the preview can be pinned on** (`expectedLeadRevision`, `mappingVersion`); the command's own comparison of a supplied hash is 19-LS.13's |
| Failure inside the transaction | nothing is committed — no orphan target, no half-converted Lead; the operation row is settled in its own transaction as `failed_retryable` (transient) or `failed_final` (deterministic) with a token from the closed `failureCode` list. **Delivered in LS.13** (T3), including `503 LEADSCORE_CONVERSION_RETRYABLE` for the transient half |
| Post-commit side effect fails | conversion stays `succeeded`; the side effect is retried through jobs/outbox, entities are never recreated |
| Two concurrent attempts | **delivered in LS.13** (asserted by a test that fires two keys at once): the work transaction takes `SELECT … FOR UPDATE` on the Lead **first** and re-reads status and revision under it, so exactly one converts and the loser settles itself to `failed_final` / `already_converted`; the optimistic `version` check (`packages/entity-engine/src/entity-manager/index.ts:122-125`, store write `entity-record.store.ts:207-214`) stays as the second line, and the `operationKey` unique index is what makes a double click on one key a replay rather than two operations |
| Operation stuck in `processing` | **delivered in LS.13** as the off-by-default `conversion.recovery` scan (the Worker job `leadScore.recoverConversionOperations`): a row is settled to `failed_retryable` (`interrupted`) only when the accounting proves nothing was written, to `needs_review` when it cannot; the scan never creates a record and never re-runs a conversion, and a retry is the explicit `…/operations/:id/retry` action behind `conversionRecover` |
| Correction of a completed conversion | **not** automatic reversal; the policy is decided (contract §11.4 — a correction is a *new* operation row that may re-point or clear one reference and never deletes a target or un-converts a Lead), but **no sub-phase in plan §16 owns the mechanism** — recorded as G9, and the consequence is concrete: LS.2 made those fields server-owned for every caller, so today nobody can correct a wrong reference at all (unresolved item U5) |

### 4.4 What conversion does not do

- sends no email, SMS, webhook or other external message (plan §7.5);
- copies no consent: MA consent is keyed by a normalized `emailHash`, not by record id
  (`apps/api/src/marketing-automation/marketing-identity.ts:36-47`), so a converted Contact is
  **not** a consented Contact;
- duplicates no attachment or file;
- moves no note, stream item or activity out of the Lead's provenance without an explicit authorized
  action — **verified in 19-LS.15**, which also pins the rest: e-mail links (`Email.leads`) stay on the Lead and
  are not linked to the new Contact, a Case keeps its `leadId`, a target-list entry keeps its `Lead` membership,
  an attachment keeps its `parent_type`/`parent_id`, and nothing names the Contact in those tables. The new
  record does **not** inherit the thread, the attachments or the campaign membership; the Lead keeps them and
  stays reachable. Consent is address-level (`emailHash` + channel + purpose), so conversion neither grants nor
  moves a decision — see `docs/implementation/lead-score-conversion-history.md` for the full inventory and for
  the *explicit* linking action the plan allows but no phase owns.

---

## 5. Data mappings

### 5.1 Reused storage

Lead/Contact/Account/Opportunity stay core `entity_records` metadata entities
(`database/migrations/001_init.sql:115-134`). All `LeadScore` records are metadata entities in the
same table; score and conversion-result fields on the Lead are non-physical attributes, so no core
table change is required (`apps/api/src/entity/entity-record.store.ts:116-136`). One additive,
index-only migration is planned (`073_phase19_lead_score.sql`), reviewed before it is applied.

### 5.2 Default field map (audited against the actual field lists)

> **Decided in 19-LS.10** (contract §7). Two rows in this table were wrong about how this kernel writes a
> name, and are corrected below: `name` is not a mappable source, and ownership is not data.

| Lead | → Contact | → Account | → Opportunity |
| --- | --- | --- | --- |
| `firstName` | `firstName` | — | — |
| `lastName` | `lastName` — **required on Contact** (`seed-metadata.ts:234`, verified: a create without it is `422 … "Field is required."`) | — | — |
| ~~`name`~~ | **not mapped** — `EntityCrudService.withName` mirrors `name` from the metadata display field (`apps/api/src/entity/entity.service.ts:509-519`), and `lastName` *is* the display field for both Lead and Contact (`seed-metadata.ts:377`, `:247`). Mapping a derived value into a field the kernel re-derives can only disagree with it | — | — |
| `title` | `title` | — | — |
| `emailAddress` | `emailAddress` | `emailAddress` (account-only mode) | — |
| `phoneNumber` | `phoneNumber` | `phoneNumber` | — |
| `company` | — | `name` (required field satisfied) | — |
| `industry` | — | `industry` | — |
| `source` | `leadSource` | — | `leadSource` |
| — | — | `website` — **unmapped: Lead has no website field** | — |
| — | — | — | `name` — required; defaulted from the Lead and editable in the wizard |
| `assignedUserId`, `teams` | **not copied** — ownership is a decision, not data. The command may set `assignedUserId` only from an explicit wizard choice the actor may assign to, and `teams` only among teams the actor belongs to. Copying a Lead's team list onto a new Contact would silently widen who can read a person record, which is the opposite of plan §7.5/§14.3 (contract §7.6) | same | same |

Never mapped by any generic rule: `password`, `apiKey`-shaped fields, files/attachments, consent
evidence, the Lead's own score/diagnostic attributes, and any field the actor cannot write on the
target (`acl-api.service.ts:172`).

> **Delivered in 19-LS.12.** The map above is the *default* value of
> `conversion.mapping.{Contact,Account,Opportunity}` in the `leadScore` settings document — an operator may
> replace any line through `POST action/settings`, and the write is validated against metadata: the source must
> exist on `Lead` and not be an outcome/system field, the target must exist and not be a relationship, derived
> or ownership field, and the types must be compatible (`text → varchar` and `datetime → date` are refused
> because they lose data silently, `enum → enum` because this build has no value map, `link` only into the same
> entity). A changed map **must raise its `version`**, which is what the preview fingerprint and a stored
> conversion name. `createDefaults` holds the one value no Lead field supplies — `Opportunity.name`, from the
> template `{{lastName}} — {{company}}` — and since 19-LS.16 the preview proposes an Opportunity whenever that
> target is requested and its switch is effective, with `opportunity_created` among the confirmations for a
> create. `Account.emailAddress`/`phoneNumber` are not in the map on purpose: they are added by
> the preview as `contextual` entries only when the request creates **no** Contact (compat §4.1, contract §7.2).
> The map has **no administration screen** yet; the settings document is the configuration surface.

### 5.3 Lead conversion result fields (contract, added in LS.2)

`convertedAt`, `convertedById` (→ User), `convertedAccountId`, `convertedContactId`,
`convertedOpportunityId`, `conversionOperationId`.

### 5.4 Score projection fields on Lead (delivered in LS.2)

`scoreValue`, `scoreBand`, `scoreStatus`, `scoreModelId`, `scoreModelVersion`, `scoreCalculatedAt`,
`scoreInputsAsOf`, `scorePreviousValue`, `scoreReasonCodes` (stable codes only — never raw field
values). Single active model policy: the projection reflects the active published model, while
`LeadScoreEvaluation` keeps every model/version history immutable (plan §5.3 permits this).
None of these attributes is `inEdit`, none is writable through `/api/v1/Lead/:id` — including by an
administrator — and the projection is deliberately not `audited`: the evaluation rows are its history, so
a batch rebuild does not flood `audit_log`.

### 5.5 New module-owned entities (delivered in LS.2)

`LeadScoreModel`, `LeadScoreRule`, `LeadScoreEvaluation` (append-only, module-written, read closed at
ACL and served by a Lead-scoped command — the `CustomerSuccessHealthSnapshot` template,
`seed-metadata.ts:3060-3097`), `LeadConversionOperation`.

---

## 6. Optional integration surface (audited, not assumed)

| Source | Consumable | Not available |
| --- | --- | --- |
| MarketingAutomation | table reads of `marketing_events` (`normalized_type`, `occurred_at`, `campaign_id`, `recipient_entity_type/id`, migration `042_phase19_marketing_webhook_inbox.sql:25-43`), `marketing_recipient_deliveries`, audience snapshots and `TargetListEntry` membership for a Lead, consent/suppression state | any open/click **event**: MA emits only `marketingAutomation.campaign.* / send.* / consent.changed / template.revisionSealed`; nothing is emitted per engagement |
| Sales | core `Opportunity` records and its documents' existing `opportunityId` links | domain events (Sales dispatches none) and `sales.opportunity.stageChanged`, which is whitelisted as a journey trigger (`marketing-journey-trigger.service.ts:17`) but never emitted |
| AIAgents | a manual run through `AIAgentRunsService.create/execute` with its budgets and durable audit | automatic/non-manual triggers — rejected in code (`ai-agent-runs.service.ts:416-421`) |
| Activities | `Email` ↔ Lead links (`emailRelations.leads`, `seed-metadata.ts:62-66`) | `Task`/`Call`/`Meeting` per-Lead links: `activityRelations` has only `accounts/contacts/users/reminders` (`:49-55`) |
| Workflows | the four `entity.*` triggers, the fixed action set (`updateRecord/createRecord/createNotification/sendEmail/runJob`) and a `runJob` extension seam | any module-registered trigger or action type — no such API exists |

If MarketingAutomation, Sales or AIAgents is absent or disabled, baseline scoring and conversion must
still work; availability is detected through the metadata-marker pattern
(`apps/api/src/customer-success/customer-success-module.ts:27-33`), never through an import.

---

## 7. Unresolved items and known limitations

Recorded here so no later phase silently invents behavior (plan §19's closing instruction).

| # | Item | Disposition |
| --- | --- | --- |
| U1 | Lead has no ICP fields (website, company size, region), so most *fit* signals cannot be expressed on the core schema today (gap G1) | LS.3 restricts fit rules to audited fields; adding ICP fields is an Entity-Manager/metadata decision for the installing organization, documented rather than assumed |
| U2 | Activities cannot reference a Lead, so call/meeting/task engagement is unmeasurable per Lead (gap G2) | deferred; needs an approved core-metadata change, out of LS.0–LS.18 |
| U3 | ~~No phone normalization facility exists (gap G3)~~ **superseded in 19-LS.10** — `voice-communications/phone-number.ts` provides `normalizePhone`/`phoneMatchKeys` behind `PHONE_NORMALIZER`, with a `libphonenumber-js` implementation (`apps/api/package.json:45`) and an ACL-gated phone lookup already using it | LS.11 **reuses the rule and adds no normalizer**; it compares the **last nine significant digits** (trunk zero dropped), which is the one form `+84 912 345 678`, `0912 345 678` and `(091) 234-5678` share without a region — `phoneMatchKeys`'s exact international/national forms need one, and a Lead has no country field. E.164 accuracy is still not claimed; the collision cost (a cross-country tail match becomes a *candidate*) is accepted because no stage may auto-link — contract §1.4, §9.1, §9.5's delivered note |
| U4 | `database/seed.ts:458-469` overwrites `metadata_entries` and the `entity` settings document on every seed/boot, so runtime admin overrides to entity metadata are lost (pre-existing, affects LS field definitions) | all LS field definitions live in `seed-metadata.ts`; LS settings live in a separate `leadScore` row. Reported, not worked around |
| U5 | Reopen/correct a completed conversion | **policy decided in 19-LS.10** (contract §11.4): a correction is a *new* `LeadConversionOperation` row that may re-point one `converted*` reference to a record the actor may read, or clear one; it never deletes a target, never un-converts a Lead, and re-checks that the target has not been used in transactions since. **The mechanism is still unimplemented and, worse, unowned** — no sub-phase in plan §16 asks for it (audit G9), and because LS.2 made those fields server-owned for every caller, an administrator has no path at all today |
| U14 | Plan §9.4 asks for per-action abuse bounds; this build has only the global HTTP limiter (`apps/api/src/config.ts`, `bootstrap.ts`), and the LeadScore module contains no rate-limit call | **Found in 19-LS.10** (audit G10). LS.11–LS.13 bound by shape instead — hard per-stage candidate caps, one Lead per preview, and an in-flight operation whose own `processing` row is the retry mutex. Whether a per-user action budget is worth a kernel primitive is LS.18's rollout decision |
| U6 | Bulk conversion | out of initial delivery; requires preview + per-record confirmation + permission checks before it can be enabled |
| U7 | Multi-model concurrent scoring (one projection per model) | MVP is single active model, and LS.2 made that structural: the projection is a set of attributes on the one Lead row, so a second live model needs its own projection entity and unique index — not a reinterpretation of these fields |
| U10 | A Lead list sorted or range-filtered by `scoreValue` cannot use `idx_entity_records_lead_score_value`: the generic store binds the attribute *name* as a parameter, which no constant-expression index matches | recorded in the migration header; the 19-LS.18 query check decides whether a narrow read model or a generated column is worth its complexity |
| U11 | ~~`allowedFieldPaths` / `blockedFieldPaths` stored but unenforced~~ **closed in 19-LS.3** | the validator refuses a path outside the grant, inside the block list, on the protected-characteristic list or on the scoring-output list, and publish re-checks it |
| U12 | ~~nothing consumes a published model~~ **closed in 19-LS.5 for the score half and in 19-LS.6 for the trigger half**: the active model is a settings choice (`scoring.activeModelId`), a recalculation computes, stores and reads back under it, and a committed Lead change queues work under it | still open for the announcement half: publishing emits no `leadScore.modelPublished` event and queues no rebuild of the existing Lead set — a new active model scores Leads as they change, and the backfill is the administrator's `action/recalculate-batch`. 19-LS.9 delivered the *score* side of announcing (`leadScore.updated.v1` / `leadScore.bandChanged.v1` from a stored evaluation), not a publish event. An active model that is archived stops scoring at once: outstanding jobs refuse with `LEADSCORE_NO_ACTIVE_MODEL`/`LEADSCORE_MODULE_DISABLED` rather than scoring against a frozen version |
| U13 | ~~Two rules may share a `priority`~~ **closed in 19-LS.4** | the evaluator orders by `priority`, then `reasonCode`, then `id`, and the unit suite asserts that a shuffled rule array and a same-priority pair produce one score (plan §6.3) |
| U8 | Score-model quality evaluation against historically labeled outcomes (plan §12) | deferred — no labeled outcome dataset exists in this build |
| U9 | EspoCRM parity claims for scoring | none: the reference baseline documents no lead scoring, so scoring is presented as new functionality, never as compatibility behavior |

## 8. Verification record

| Sub-phase | Checks actually run | Outcome |
| --- | --- | --- |
| 19-LS.0 | Source reading and exhaustive greps over `apps/`, `packages/`, `modules/`, `database/`, `i18n/`, `content/`, `docs/`; `database/migrations` listing; script/seed/`boot-api` inspection for destructive setup; baseline re-checked against public EspoCRM docs on 2026-10-24 | Audit produced; no code, no migration, no database write, no new database. Nothing in §3–§6 is runtime behavior yet |
| 19-LS.1 | `npx vitest run apps/api/test/lead-score-module.test.ts` (15 tests); adjacent suites `entity-crud`, `entity-row-actions`, `entity-manager-metadata`, `navigation`, `i18n` (55 tests) and `sales-module`, `admin-internal`, `docs`, `crm-chat` (54 tests); `npm run typecheck`; `npx eslint` on the touched files | all green. The module is registered, discoverable (health + the five `/api/v1/OpenApi` paths) and refused-everything: 11 operations closed, `ready: false`. Lead/Contact/Account/Opportunity CRUD verified unchanged with the module switched on. Settings row and test records removed by exact id afterwards |
| 19-LS.2 | `apps/api/test/lead-score-schema.test.ts` (**24 tests**, including the enforced unique constraints and the write guard) and the LS.1 suite re-run (**15**); adjacent `entity-crud`, `entity-row-actions`, `entity-manager-metadata`, `navigation`, `i18n`, `sales-entity-layouts`, `acl-matrix`, `dynamic-logic` and three Marketing Automation suites (**144**); full `apps/api/test` run; `npm run typecheck`; `npx eslint` on the touched files; migration applied through `database/migrate.ts` and read back from `pg_indexes` | green. Structures and ownership are runtime facts now: no row carries a score, no model publishes, every operation still refuses with its phase |
| 19-LS.3 | `apps/api/test/lead-score-model.test.ts` (**22 tests**) and `apps/api/test/lead-score-validator.test.ts` (**29 pure tests**); LS.1 + LS.2 suites re-run (**15**, **24**); full `apps/api/test` run (**2,210 passed / 34 failed**, the same seven pre-existing shared-state files as the LS.2 baseline); `npm run typecheck`; `npx eslint` on the touched files | green. Invalid models cannot be published and published versions cannot be written — both proved through the record API, not only through the command |
| 19-LS.4 | `apps/api/test/lead-score-evaluator.test.ts` (**65 pure tests**, no database) and `apps/api/test/lead-score-preview.test.ts` (**12 API tests**); LS.1 + LS.2 + LS.3 suites re-run (**15**, **24**, **22**, **29**) — six LeadScore files together **167 passed / 0 failed**; full `apps/api/test` run (**2,287 passed / 34 failed**, the same seven pre-existing shared-state files as the LS.2/LS.3 baseline and zero `lead-score` failures); `npm run typecheck`; `npx eslint` on the module and both new suites; residue check `0 / 0 / 0` with `0` Leads carrying a stored score | green. The same model and the same input snapshot answer the same score, band, reason codes and signature — proved against a second call, a different clock, a different key and rule order, and a changed signal. A preview writes nothing, scores only the Leads the caller may read, and reports a field the caller may not read as unknown rather than empty |
| 19-LS.5 | `apps/api/test/lead-score-calculation.test.ts` (**15 API tests**) and `apps/api/test/lead-score-explanation.test.ts` (**12 API tests**); the other six LeadScore files re-run together — **194 passed / 0 failed** across eight files; full `apps/api/test` run (**2,314 passed / 34 failed**, 161 files, the same seven pre-existing shared-state files as the LS.4 baseline and zero `lead-score` failures); `npm run typecheck`; `npx eslint` on the module and the six touched suites; residue check | green, and two claims are proved rather than asserted in prose: an unchanged re-run writes nothing at all (same evaluation id, `version` and `modifiedAt` unmoved), and a command whose history row is refused by ACL leaves **no** projection behind. Four phase-pointer assertions LS.5 legitimately changes were updated, not weakened |
| 19-LS.6 | `apps/api/test/lead-score-recalculation.test.ts` (**19 API tests**) and `apps/worker/src/handlers/lead-score-handlers.test.ts` (**21 worker tests**, `--config apps/worker/vitest.config.ts`); the other eight LeadScore files re-run together — **213 passed / 0 failed** across nine files; full `npx vitest run` (**2,848 passed / 34 failed**, 200 files, the same seven pre-existing shared-state files as the LS.5 baseline and zero `lead-score` failures); full worker suite (**205 passed / 0 failed**); `npx tsc --noEmit`; `npx eslint` on the module, the worker, both new suites and the five retargeted ones; residue check | green. **No migration and no new database.** Repeat events create one job row and one history row; a change that cannot move the score creates nothing; the projection write's own `changed` list is the proof, read from the real `outbox_events` row. A rebuild is capped, chunked, cursor-based, cancellable and idempotent on replay, and one Lead's failure comes back as a code with the run continuing. Two residue classes this phase creates and LS.5 never had — `jobs` rows and `outbox_events` rows — are swept by exact id and by run coordinate, and the **40 evaluations + 4 job rows four earlier runs left behind were removed by id after a join proved their Lead and model were gone** |
| 19-LS.7 | `npx playwright test e2e/lead-score.spec.ts` (**3 tests**, its own published model, rules and Lead, removed afterwards); `apps/api/test/lead-score-explanation.test.ts` (**16**, +4 for the affordance answer and the both-locale key guard) and `apps/api/test/lead-score-schema.test.ts` (**25**, +1 for the list/detail placement); the other seven LeadScore files re-run together — **218 passed / 0 failed** across nine files; full `npx vitest run` (**2,853 passed / 34 failed**, 200 files, the same seven pre-existing shared-state files as the LS.6 baseline and zero `lead-score` failures); full worker suite (**205 passed / 0 failed**); `npm run typecheck` (API + web); `npx eslint` on the module, the web app, the e2e spec and the touched suites; `npm run build` in `apps/web`; a browser pass on the running app (list columns + filter disclosure, the card, the action, the drawer, the stale state) at 1440 and 390 px; residue check | green, and the phase's criterion is checked as a boundary rather than a look: no evaluator import exists in `apps/web`, the reason block is asserted **not** to contain the rule's own input value, and the two action buttons appear only when `ScoreReadView.actions` says the caller may — including the case where a role holds `LeadScoreRecalculate` but not `Lead:edit`, which is answered `LEAD_NOT_EDITABLE` and really refused. One deviation is recorded rather than hidden: the generic `Score` detail panel LS.2 declared is removed and its fields become `inDetail: false`, because a second surface for one stored number is a defect |
| 19-LS.8 | `npx vitest run apps/api/test/lead-score-editor.test.ts` (**14**, new); the nine pre-existing LeadScore files in two groups (**90** and **142 passed / 0 failed**); full `npx vitest run` (**2,867 passed / 34 failed**, 201 files — the same seven pre-existing shared-state files as the LS.6/LS.7 baseline, +14 being this phase's new suite, and zero `lead-score` failures); worker suite (**205 passed**); `npx playwright test e2e/lead-score-admin.spec.ts e2e/lead-score.spec.ts` (**7 passed**: 4 new + LS.7's 3); `npm run typecheck`; `npx eslint` on every touched path; `pnpm --filter @carocrm/web build` and `--filter @carocrm/api build`; a browser pass in English and Vietnamese at 1440 and 390px (list, draft form, rule builder, validation report, publish confirmation, frozen notice, new version, version diff, preview, rebuild with a working Cancel, settings), then a residue check | green, with the criterion checked as behaviour rather than layout: the browser spec types **no JSON at all** and reads the stored condition back as a sentence; the preview's zero-write claim is asserted from the record on both sides of the run; and the editor's refusals are the validator's own codes, so no option the form offers can fail a publish. Two hazards recorded rather than hidden: the nine LeadScore suites now interfere with one another over the single shared `leadScore` settings row when run as one ad-hoc group (six assertions in LS.1/LS.2/LS.3 fail **with LS.8's file excluded**, and the canonical full run is clean), and a published model cannot be torn down through the API — this phase's e2e residue had to be removed at the database level by run marker |
| 19-LS.9 | `apps/api/test/lead-score-engagement.test.ts` (**9**, new) + the evaluator (**71**, +6), validator (**30**, +1), explanation guard (**16**, extended to every LS.9 word in both locales) and worker (**210**, +5) additions; all eleven LeadScore API files in **one group — 248 passed / 0 failed**; full `npx vitest run` (**2,883 passed / 34 failed**, 202 files — the same seven pre-existing shared-state files as the LS.6/LS.7/LS.8 baseline, +16 being this phase's new API tests, and zero `lead-score` failures); full worker suite (**210 passed / 0 failed**); `npx playwright test e2e/lead-score-admin.spec.ts e2e/lead-score.spec.ts` (**9 passed**: 2 new + LS.8's 4 + LS.7's 3); `npm run typecheck`; `npx eslint` on every touched path; `pnpm --filter @carocrm/web build` and `--filter @carocrm/api build`; migration `074_phase19_lead_score_signals.sql` applied through `database/migrate.ts` and read back from `pg_indexes`; a browser pass on a Lead that really has `marketing_events` rows, in Vietnamese at 1440px, then a residue check by exact id with the settings document and the admin locale restored | green, with the phase's own criterion checked as a refusal of the shortcut rather than a demo of the happy path: the signal being **switched off** and the Lead having **no events** are two tests that still score the Lead-field rules and name which state produced the answer, and the fourth state (`absent`) is the `information_schema` marker itself rather than a scenario this database can produce; a band crossing is asserted from `outbox_events`, `notifications` and `audit_log` — with the immediate second call asserted to write **none of them**. The browser pass is what made the provenance claim true: it found that the explanation service's field-by-field rebuild dropped the new `signal` block and that `signalState` was returned but never stored, so both are now stored, served on the current-score and history paths, and asserted by reading them back. Four deviations recorded in `docs/implementation/lead-score-ls9-completion-report.md` rather than smoothed over: no email-hash fallback (audit G6), no Voice/Activity signal (no contract, G2), no `decay_sweep` evaluation trigger (the sweep's attribution is `jobs.target.source`), and notification text in English like every other writing module |
| 19-LS.10 | Documentation phase: `docs/implementation/lead-score-conversion-contract.md` (new) plus §6 of the audit, this file's §2.1/§2.5/§4.1–§4.3/§5.2/§7 rows and `README.md`. Verification actually run: every load-bearing claim re-read from the file it cites; three facts confirmed against the running dev API because a citation alone would not settle them (a Contact create without `lastName` → `422 VALIDATION_FAILED {lastName: "Field is required."}`; a Contact create with `firstName`+`lastName` only → the response carries `name` mirrored from `lastName`; an administrator `POST /api/v1/LeadConversionOperation` → refused by the LS.2 write guard with `{entity, operation:'create'}`, while an evaluation create passes that gate — the asymmetry that proves the profile change contract §13.2 requires); `npx vitest run` over the eleven LeadScore API files (**248 passed / 0 failed**, all eleven green inside the full run too); full `npx vitest run` (**2,883 passed / 34 failed**, 202 files — identical to the LS.9 baseline, the 34 in the same seven pre-existing shared-state files, zero `lead-score` failures); worker suite **210 / 0**; `npm run typecheck` clean; `git status` showing five documentation paths and no source file | green, and **no code, schema, settings or metadata file was touched** — which is the phase's own exit criterion ("documented before writing conversion behavior"). The test records used for the three API confirmations were deleted by exact id and a residue query over the run marker returned nothing. What this phase produced is obligations: it corrected two stale LS.0 findings (the phone normalizer and the unusable `pg_trgm` indexes), retired a status no code may write, named the two permission/schema edits LS.13 must make before the command can exist at all, and recorded two gaps it did not invent fixes for — G9 (nobody owns the correction workflow that plan §7.6 requires, while every other caller is barred from those fields) and G10 (no per-action rate bound exists) |
| 19-LS.11 | `apps/api/test/lead-score-duplicates.test.ts` (**15**, new: 4 pure keys + 11 API); the twelve LeadScore API files in one group (**263 passed / 0 failed**); full `npx vitest run` (**2,898 passed / 34 failed**, 203 files — the +15 is this phase's suite, the 34 in the same seven pre-existing shared-state files, zero `lead-score` failures); worker suite (**210 / 0**); `npx playwright test e2e/lead-score-admin.spec.ts e2e/lead-score.spec.ts` (**9 passed** — the settings screen already renders delivered features, so the flipped switch and the corrected `implementedPhases` are exercised); `npm run typecheck`; `npx eslint` on every touched path; `pnpm --filter @carocrm/api build`; no migration | green, and the exit criterion is asserted as a *property of the write path*, not a promise: the resolver has no write code, and the suite checks the Lead's `version`/`modifiedAt` and the `audit_log` count are untouched by a call, that a record-ACL-hidden Contact contributes one to `hiddenMatches` and nothing to the payload (id and name asserted absent), that a field-hidden e-mail/phone is masked and an unnameable candidate withheld, and that a Lead outside the caller's `own` scope answers **404** rather than an empty list. Four assertions in `lead-score-module.test.ts` were retargeted rather than weakened (`implementedPhases` now through LS.11, `duplicateDetection` moved to the shipped list, `fieldMapping` became the example of a stored-but-pending switch, and the OpenAPI path list gained the new route). Three deviations recorded: no similarity stage (the only trigram indexes key on field names that do not exist), the phone key is the nine-digit tail rather than `phoneMatchKeys`'s exact forms (a Lead carries no region), and "verified identifiers" have no field in this schema. **Two traps the implementation hit and the tests now pin:** `name` is a physical column (a label read from `attrs` dropped every candidate), and `'\s+'` inside a JS template literal becomes `'s+'` (the SQL fold was replacing the letter *s* until it used `'[[:space:]]+'`) |
| 19-LS.12 | `apps/api/test/lead-score-conversion-preview.test.ts` (**22**, new: 6 pure map/type/hash tests + 16 API); all thirteen LeadScore API files together (**285 passed / 0 failed**); full `npx vitest run` (**2,920 passed / 34 failed**, 204 files at the time — the +22 was this suite, the 34 in the same seven pre-existing shared-state files, zero `lead-score` failures); worker suite (**210 / 0**); `npx playwright test e2e/lead-score-admin.spec.ts e2e/lead-score.spec.ts` (**9 passed**); `npm run typecheck`; `npx eslint` on every touched path; `pnpm --filter @carocrm/api build`; no migration | green, and the exit criterion is asserted in both halves: the preview call leaves the Lead's `version`/`modifiedAt`, the record counts, `audit_log`, `outbox_events` and `jobs` unchanged, and the answer names each value it would write (`origin`), each value it would not (closed `reason`), the required gaps, the before/after of every conflict on a linked record, and a fingerprint over the Lead revision, the mapping versions, the merges, **the merge policy** and **the reader's own visible and writable field sets** — with `409 LEADSCORE_PREVIEW_STALE` naming the component when a pinned revision or mapping version no longer matches, and `422 LEADSCORE_TARGET_DISABLED` for a disabled or still-pending target. Six settings refusals are asserted (unknown source/target, incompatible type, derived `name`/ownership/relationship carrier, outcome source, a changed map that kept its version, an unknown template token). Deviations recorded: two services instead of one, `acknowledged` belongs to LS.13's command rather than the preview, `opportunity_created` cannot be produced until LS.16, no admin screen for the map, and the type matrix is stricter than the audit's sketch for `text → varchar`, `date ↔ datetime` and `enum → enum` |
| 19-LS.13 | `apps/api/test/lead-score-conversion.test.ts` (**17**, new); all fourteen LeadScore API files together (**302 passed / 0 failed**); full `npx vitest run` (**2,937 passed / 34 failed**, 205 files — the +17 is this suite, the 34 in the same seven pre-existing shared-state files, zero `lead-score` failures); worker suite (**210 / 0**, the recovery job registered); `npx playwright test e2e/lead-score-admin.spec.ts e2e/lead-score.spec.ts` — **9/9 on a clean run** (the settings screen renders the two newly-delivered switches), but the same pair run immediately after a fresh API build failed the **LS.8 version-diff** test in two consecutive attempts (8/9, 1.5 min for a suite that normally takes 30 s) and passed again when run alone; that test is not in this phase's code path and the same one flaked once in 19-LS.12, so it is recorded as an intermittent, load-sensitive failure that still needs a real diagnosis rather than a green tick; `npm run typecheck`; `npx eslint` on every touched path; `pnpm --filter @carocrm/api build`; no migration | green, and **both halves of the exit criterion are assertions over the public routes**: the same key replays the stored result with zero new targets and zero new events; a second key against a converted Lead is refused inside the work transaction and leaves the target counts unchanged; and **two keys fired at once produce exactly one 200, one Contact and one converted Lead**. The failure half: a stale fingerprint (`component: 'hash'`) and an unacknowledged set (`component: 'confirmation'`) are refused **with no operation row created**, while a refusal inside the work transaction is recorded (`failed_final` / `already_converted`) with the attempt's id. Recovery is asserted as a decision — a stale retry becomes `needs_review` / `stale` with the Lead untouched, the off-by-default scan settles a stuck row to `failed_retryable` / `interrupted` without touching the Lead, and close works exactly once. The permission change is asserted from both sides: a non-admin with `LeadConversionOperation` create+edit converts and is recorded as requester and as `convertedById`, and a role without the create grant is refused with nothing written. Four suites were retargeted rather than weakened (`lead-score-{module,schema,model}` for the delivered features/phases, and the worker job-registration test). No migration: the columns, the unique key and the schedule are LS.2's and the seed's |
| 19-LS.14 | `e2e/lead-conversion.spec.ts` (**6** new Playwright tests: create, link, duplicate-override, stale-preview refresh, lost-response resume, phone/keyboard) and `apps/api/test/lead-score-conversion.test.ts` (**+3** affordance tests); all fourteen LeadScore API files together (**305 passed / 0 failed**); full `npx vitest run` (**2,941 passed / 33 failed**, 205 files — zero `lead-score` failures, the failures in the same seven pre-existing shared-state files); worker suite (**210 / 0**); the **three** LS Playwright specs together (**15 passed**, 46 s); `npm run typecheck`; `npx eslint` on every touched path; both builds; no migration | green, with the criterion checked on the screen rather than described: the review renders the server's preview (values, required gaps, skipped reasons, before/after conflicts with per-field merge opt-ins, duplicate candidates with the hidden-match count, the confirmations); confirming re-runs the preview and **re-shows it** when the fingerprint moved instead of converting a plan nobody saw; the result separates **Created** from **Linked** with links whose hrefs are the records the API made (asserted by reading them back); the metadata **`Converted To`** panel appears after a conversion; a duplicate refuses until the override box is ticked; and a lost response is resumed with the **same operation key**, still producing exactly one Contact. Residue: the operation rows a conversion writes are append-only, so the run's rows (and the targets the conversions created) were swept at the database level by run marker — 10 rows, 10 events and 21 records, with a final marker query empty |
| 19-LS.15 | `apps/api/test/lead-score-conversion-history.test.ts` (**6** new API tests); the inventory and the deferral in `docs/implementation/lead-score-conversion-history.md`; **no production code changed**; all fifteen LeadScore files together (**311 passed / 0 failed**); full `npx vitest run` (**2,946 passed / 34 failed**, 206 files — zero `lead-score` failures, the 34 in the same seven pre-existing shared-state files); worker suite (**210 / 0**); `npm run typecheck`; `npx eslint` on the touched paths; no migration and no settings change | green, and the exit criterion is checked as a **count**, not a claim: e-mail links to the Lead unchanged and none to the new Contact; `Case.leadId` unchanged; the target-list entry still `Lead`/the Lead id; the consent row count, its `leadId` and its null `contactId` unchanged and no consent row naming the Contact; the attachment count, `parent_type`/`parent_id`/`storage_key` unchanged and nothing attached to the Contact; the Lead's `description`, e-mail and audit trail intact; and ownership/teams absent from the created records with a **404** for a reader who may read the Lead but not what it became. Two honest notes: the target-list fixture is written to the entity store rather than through MA's API because the MA `audience` switch is off here, and "notes" have no entity in this build (`activityRelations` has no `leads`), so there is nothing to preserve — stated, not faked |
| 19-LS.16 | `apps/api/test/lead-score-conversion.test.ts` (**+3**: Opportunity create, Opportunity link + Account disclosure, affordance `targets`) and one retargeted preview test; `e2e/lead-conversion.spec.ts` (**+1** browser test); all **15 LeadScore files together (314 passed / 0 failed)**; full `npx vitest run` (**2,949 passed / 34 failed**, 206 files — the 34 in the same seven pre-existing shared-state files and zero `lead-score` failures); worker suite (**210 / 0**); the **three** LS Playwright specs together (**16 passed**, 49 s); `npm run typecheck`; `npx eslint` on every touched path; both builds; no migration | green, and both halves of the exit criterion are read back from the API: a conversion that names all three targets creates the deal with the operation's `accountId` and the new Contact in `contactIds`, stores `convertedOpportunityId`, names `createdOpportunityId` in the operation **and** its audit view, leaves the stage at the kernel's `Qualification` and writes no amount/probability; a **linked** deal keeps its stage, amount and existing Contact (the new Contact is appended), moves to the chosen Account after the preview showed that as a **read-only before/after**, and a Quote that already named it keeps its `opportunityId`, `accountId` and `draft` state — Sales' document path was not touched. `opportunity_created` is an acknowledgement, and the wizard's rows come from the affordance's `targets` (`['Contact','Account']` while the switch is off, and the preview refuses the type as `notEnabled`). Residue: operation rows are append-only, so every run of the session was swept at the database level by the `E2E_LS14_` marker — 33 records, 18 operations and 18 events removed, final marker queries empty |
| 19-LS.17 | `apps/api/test/lead-score-insight.test.ts` (**13** new: 4 pure evidence/extractor/key + 9 API) and one metadata test in `lead-score-schema.test.ts`; all **16 LeadScore API files together (328 passed / 0 failed)**; full `npx vitest run` (**2,963 passed / 34 failed** across **207 files** — the 34 in the same seven pre-existing shared-state files (`ai-agent-runs`, `service-desk` ×3, `crm-chat` ×3) and **zero `lead-score` failures**; the +14 are this phase's new tests); worker suite (**210 passed / 0 failed** (20 files)); the **three** LS Playwright specs together (**16 passed**, 49 s — the insight block is hidden while the feature is off); a browser pass on a **scratch API running `NODE_ENV=test`** (the e2e server runs `NODE_ENV=production`, where the fake provider adapter is deliberately absent, so a generation test could not be committed as e2e); `npm run typecheck`; `npx eslint` on every touched path; both builds; **one additive, index-only migration** (`075_phase19_lead_score_insights.sql`) | green, and the exit criterion is checked on both sides: with the feature off the deterministic path is byte-for-byte unchanged (the same recalculation, the same 50, the same Lead `version`), and with it on the only write is one append-only `LeadScoreInsight` row — the score, band, model version, timestamp and `version` are identical before and after, so **AI text cannot change a score**. The evidence is read back from AIAgents' own run and asserted to carry the business facts and none of the personal ones; a repeated key produces no second run and no second row; an agent that reads a record or holds a writing tool is refused; a paused AIAgents refuses new work while a replay still answers; a text grounded on a field the reader may not see is withheld. The browser pass shows the answer under an **AI-generated** tag with its agent, provider/model and grounded-field list, and the settings screen picks the agent by name. Two honest notes: the answer is provider output and is not translated, and the e2e suite cannot cover generation because production has no fake provider |
| 19-LS.18 | *not started* | each completion report must list the exact commands run and their outcomes before this table may claim support |
