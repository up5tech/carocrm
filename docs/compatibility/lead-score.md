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
> **19-LS.5 delivered scoring that is computed *and kept*; LS.6 and later are not implemented.** A model can
> be configured, validated, published, frozen, previewed without writing anything, and **recalculated
> per Lead**: the evaluation row and the Lead's current-score projection are stored together, and both are
> readable with an explanation and a freshness verdict. What is still absent is anything that decides *when* to
> score — event-driven and batch recalculation (19-LS.6), signals and notifications (19-LS.9), every UI screen
> (19-LS.7/LS.8) and conversion (19-LS.10–LS.16) — each refused with the sub-phase that owes it.
> Canonical module name: `LeadScore` (no `Ua` prefix). API prefix: `/api/v1/lead-score` plus
> `/api/v1/leads/:leadId/{score,conversion-preview,convert}` semantics.
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
| Convert action | A conversion form lets the user pick target record types — Account, Contact and/or Opportunity | **Contract (LS.12–LS.14).** The wizard offers exactly the combinations in §4; nothing hidden client-side, the backend re-validates every choice |
| Converted Lead | The Lead stays in the system with `Converted` status and references to the records created/linked, shown in a "Converted To" panel | **Contract (LS.13).** The Lead row is never mutated into another entity type and never deleted; references are `convertedAccountId` / `convertedContactId` / `convertedOpportunityId` / `conversionOperationId` / `convertedAt` / `convertedById` (§5.3) |
| B2C mode | When the installation runs in B2C ("no company") mode, conversion **to Account** is not available | **Intentional deviation — see §2.1.** No B2B/B2C mode exists in this build, so the equivalent control is the module setting `conversion.targets` |
| Lead scoring | **No lead scoring is documented** in the reference baseline product's user guide | **Extension, not compatibility surface.** Everything in §3 is `LeadScore`-owned new behavior; it must never be described as upstream-compatible |
| Web-to-Lead | Documented as an inbound lead-capture form producing a Lead | **Out of scope for LS.0–LS.18.** No web-to-lead endpoint exists in this build (verified negative finding). A captured Lead is scored/converted by the same rules as any other Lead once such capture exists |

## 2. Product decisions that differ from the baseline (and why)

### 2.1 No global B2B/B2C mode

`AGENTS.MD` §5 and plan §7.7 forbid inventing a global product mode the existing CRM does not have,
and the audit confirms none exists (no `B2B`/`B2C`/`companyType` in code, settings, preferences or
metadata). Instead:

- the `leadScore` settings row exposes `conversion.targets` (default: `Account`, `Contact`,
  `Opportunity` all enabled);
- an installation that wants B2C-like behavior disables `Account` there;
- the **backend** validates the mode independently of the UI, so a disabled target cannot be created
  even by a direct API call (plan §7.7).

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

---

## 3. Scoring behavior contract

| Aspect | Agreed behavior | Status |
| --- | --- | --- |
| Scale | 0–100 default (`scaleMin`/`scaleMax` per model, registered on `LeadScoreModel` in LS.2); the UI always shows the scale | fields exist (LS.2), validation arrives in LS.3; the module settings row deliberately stores no scale of its own — the model owns it |
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
| Recalculation | event-driven (debounced), manual (rate-limited), batch (chunked, admin-only), decay sweep; all idempotent | manual one-Lead **delivered (LS.5)** synchronously (`action/score/recalculate`, whose duplicate is absorbed by the LS.2 idempotency unique index); event-driven, batch and the decay sweep stay 19-LS.6/19-LS.9 |
| Explanation | score, band, contributing and skipped rules with stable codes, model version, last recalculated | **delivered (LS.5)**: `action/score/:leadId` answers the breakdown labeled in the reader's language and names only rules and outcomes — no Lead value, so it cannot read past field ACL (§6.5, §9.2) |
| Threshold actions | emit `leadScore.updated` / `bandChanged`; **never** auto-convert, never silently rewrite unrelated Lead fields | LS.9 |
| Sensitive attributes | protected characteristics and proxies are excluded; the model's field allowlist is admin-reviewable and a denylist is enforced at save | LS.3 refuses them at validation and publish; **LS.4 re-checks the grant at evaluation time** and never reads a field outside it, so a stored snapshot cannot smuggle one in |
| AI insight | optional, operator-triggered, evidence-grounded, stored separately from the numeric score, off by default; scoring works with AI disabled | LS.17 |
| Signals a rule may read today | the Lead's own declared fields only | engagement (`marketingEvents`, `emailLinks`) is refused at validation with 19-LS.9 named, because the audit found no event and no Lead→Activity relation (gap G2) |

**Not supported by this build** (plan §2.2, restated so no screen claims it): automatic conversion on
threshold, unsupervised Contact/Account merging, bulk conversion without preview and confirmation,
destructive Lead deletion after conversion, and any use of the score outside sales prioritization.

---

## 4. Conversion behavior contract

### 4.1 Valid target combinations (backend-validated)

| Combination | Available when | Notes |
| --- | --- | --- |
| create Contact | `Contact` in `conversion.targets` + `Contact:create` | — |
| link existing Contact | `Contact:read` | a user who cannot read a candidate never sees it |
| create Account | `Account` in `conversion.targets` + `Account:create` | disabled by the B2C-equivalent setting |
| link existing Account | `Account:read` | — |
| Account + Contact | both enabled | Contact receives `accountId` (`seed-metadata.ts:219`) |
| Contact + existing Account | both | user-confirmed relationship |
| existing Contact + existing Account | both read/link | explicit confirmation required |
| ± Opportunity | `Opportunity` enabled + its ACL | available for every combination above |

No invalid partial combination can reach the write layer: an unselected or hidden target is rejected
server-side, not merely filtered in the UI.

### 4.2 Duplicate policy

Staged, in order: normalized email exact → normalized phone exact → Account domain/`website` →
company/name similarity. The first two may produce `same person`, the third `same organization`, the
fourth is **suggestion only** — never an automatic link or merge. Generic mailboxes, shared household
phones and multi-person companies are configured non-exact. Ambiguity always requires an explicit user
choice (link / create with the override capability / cancel).

No new unique constraint is placed on email or phone: the current data and legitimate shared values do
not support one (decision D7). Only the score-projection and conversion-operation-key partial unique
indexes are added, following `database/migrations/032_phase19_customer_success.sql:17-25`.

### 4.3 Failure, retry and concurrency semantics

| Situation | Result |
| --- | --- |
| Same `operationKey`, operation already `succeeded` | the original result is returned; zero new records |
| Different key against an already-`Converted` Lead | `409 LEAD_ALREADY_CONVERTED` |
| Preview fingerprint stale (Lead revised, target changed, mapping changed) | rejected; the user must re-preview and re-confirm |
| Failure inside the transaction | nothing is committed — no orphan target, no half-converted Lead; operation row records `failed_retryable` with a safe failure code |
| Post-commit side effect fails | conversion stays `succeeded`; the side effect is retried through jobs/outbox, entities are never recreated |
| Two concurrent attempts | the Lead `version` (`packages/entity-engine/src/entity-manager/index.ts:122-125`) plus the operation-key unique index let exactly one win |
| Operation stuck in `processing` | the recovery view + sweeper re-check for already-created targets before any retry (LS.18) |
| Correction of a completed conversion | **not** automatic reversal; a separate, admin-controlled procedure (unresolved item U5) |

### 4.4 What conversion does not do

- sends no email, SMS, webhook or other external message (plan §7.5);
- copies no consent: MA consent is keyed by a normalized `emailHash`, not by record id
  (`apps/api/src/marketing-automation/marketing-identity.ts:36-47`), so a converted Contact is
  **not** a consented Contact;
- duplicates no attachment or file;
- moves no note, stream item or activity out of the Lead's provenance without an explicit authorized
  action (LS.15).

---

## 5. Data mappings

### 5.1 Reused storage

Lead/Contact/Account/Opportunity stay core `entity_records` metadata entities
(`database/migrations/001_init.sql:115-134`). All `LeadScore` records are metadata entities in the
same table; score and conversion-result fields on the Lead are non-physical attributes, so no core
table change is required (`apps/api/src/entity/entity-record.store.ts:116-136`). One additive,
index-only migration is planned (`073_phase19_lead_score.sql`), reviewed before it is applied.

### 5.2 Default field map (audited against the actual field lists)

| Lead | → Contact | → Account | → Opportunity |
| --- | --- | --- | --- |
| `firstName` | `firstName` | — | — |
| `lastName` | `lastName` | — | — |
| `name` | `name` | — | — |
| `title` | `title` | — | — |
| `emailAddress` | `emailAddress` | `emailAddress` (account-only mode) | — |
| `phoneNumber` | `phoneNumber` | `phoneNumber` | — |
| `company` | — | `name` (required field satisfied) | — |
| `industry` | — | `industry` | — |
| `source` | `leadSource` | — | `leadSource` |
| — | — | `website` — **unmapped: Lead has no website field** | — |
| — | — | — | `name` — required; defaulted from the Lead and editable in the wizard |
| `assignedUserId`, teams | carried as create defaults through the canonical service | same | same |

Never mapped by any generic rule: `password`, `apiKey`-shaped fields, files/attachments, consent
evidence, the Lead's own score/diagnostic attributes, and any field the actor cannot write on the
target (`acl-api.service.ts:172`).

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
| U3 | No phone normalization facility exists (gap G3) | LS.11 builds a bounded, dependency-free normalizer; E.164 accuracy is explicitly not claimed, and behavior is documented in the LS.11 report |
| U4 | `database/seed.ts:458-469` overwrites `metadata_entries` and the `entity` settings document on every seed/boot, so runtime admin overrides to entity metadata are lost (pre-existing, affects LS field definitions) | all LS field definitions live in `seed-metadata.ts`; LS settings live in a separate `leadScore` row. Reported, not worked around |
| U5 | Reopen/correct a completed conversion | not implemented; requires an explicit admin procedure that accounts for targets edited or used in transactions since conversion (plan §7.6) |
| U6 | Bulk conversion | out of initial delivery; requires preview + per-record confirmation + permission checks before it can be enabled |
| U7 | Multi-model concurrent scoring (one projection per model) | MVP is single active model, and LS.2 made that structural: the projection is a set of attributes on the one Lead row, so a second live model needs its own projection entity and unique index — not a reinterpretation of these fields |
| U10 | A Lead list sorted or range-filtered by `scoreValue` cannot use `idx_entity_records_lead_score_value`: the generic store binds the attribute *name* as a parameter, which no constant-expression index matches | recorded in the migration header; the 19-LS.18 query check decides whether a narrow read model or a generated column is worth its complexity |
| U11 | ~~`allowedFieldPaths` / `blockedFieldPaths` stored but unenforced~~ **closed in 19-LS.3** | the validator refuses a path outside the grant, inside the block list, on the protected-characteristic list or on the scoring-output list, and publish re-checks it |
| U12 | ~~nothing consumes a published model~~ **closed in 19-LS.5 for the score half**: the active model is a settings choice (`scoring.activeModelId`), and a recalculation computes, stores and reads back under it | still open for the announcement half: publishing emits no `leadScore.modelPublished` event and queues nothing, and no recalculation is triggered by a Lead change — that is 19-LS.6. An active model that is archived stops scoring at once, with `LEADSCORE_NO_ACTIVE_MODEL` naming the state |
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
| 19-LS.6 … LS.18 | *not started* | each completion report must list the exact commands run and their outcomes before this table may claim support |
