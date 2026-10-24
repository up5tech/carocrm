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
> **LS.3 and later are not implemented.** The *structures* exist and are enforced; the *behavior* does
> not: nothing computes a score, nothing publishes a model and nothing converts a Lead, so every
> operation is still refused with the sub-phase that owes it and no Lead carries a score value.
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
| Formula | `baseScore` → matched rule deltas in `priority` order → optional dimension weights → clamp `[scoreFloor, scoreCeiling]` → stable rounding → band lookup | LS.4 |
| Reproducibility | same model version + same input snapshot ⇒ identical score, identical reason codes, identical signature | LS.4 unit test |
| Missing data | `missingDataPolicy: ignore` or `neutral`, recorded as `unknown` in the breakdown; never silently 0 | LS.4 |
| Rule vocabulary | declarative `{field, operator, value}` with `all`/`any`/`not`, operators limited to the audited set (`packages/formula/src/dynamic-logic/index.ts:9-26`), field paths validated against `Lead` metadata and the model's `allowedFieldPaths` | LS.3 |
| Non-executable | no formula string, SQL, script, template or arbitrary join is accepted as a score rule | LS.3 |
| Explainability | every displayed score carries band, model version, `calculatedAt`, `inputsAsOf`, positive/negative reason codes, coverage and evaluation status | LS.5 |
| Freshness | `evaluationStatus` of `current`, `stale`, `pending`, `failed` or `not_scored` | LS.5 |
| History | append-only, immutable, ACL-gated through a Lead-scoped command rather than entity read permission | LS.5 |
| Recalculation | event-driven (debounced), manual (rate-limited), batch (chunked, admin-only), decay sweep; all idempotent | LS.6; the idempotency key it needs is already a unique index (LS.2) |
| Threshold actions | emit `leadScore.updated` / `bandChanged`; **never** auto-convert, never silently rewrite unrelated Lead fields | LS.9 |
| Sensitive attributes | protected characteristics and proxies are excluded; the model's field allowlist is admin-reviewable and a denylist is enforced at save | LS.3 |
| AI insight | optional, operator-triggered, evidence-grounded, stored separately from the numeric score, off by default; scoring works with AI disabled | LS.17 |

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
| U11 | `allowedFieldPaths` / `blockedFieldPaths` are stored on a model but enforced nowhere yet | 19-LS.3's validator is where the sensitive-attribute and field-path boundary actually applies; declaring the fields early makes that a check rather than a redesign |
| U8 | Score-model quality evaluation against historically labeled outcomes (plan §12) | deferred — no labeled outcome dataset exists in this build |
| U9 | EspoCRM parity claims for scoring | none: the reference baseline documents no lead scoring, so scoring is presented as new functionality, never as compatibility behavior |

## 8. Verification record

| Sub-phase | Checks actually run | Outcome |
| --- | --- | --- |
| 19-LS.0 | Source reading and exhaustive greps over `apps/`, `packages/`, `modules/`, `database/`, `i18n/`, `content/`, `docs/`; `database/migrations` listing; script/seed/`boot-api` inspection for destructive setup; baseline re-checked against public EspoCRM docs on 2026-10-24 | Audit produced; no code, no migration, no database write, no new database. Nothing in §3–§6 is runtime behavior yet |
| 19-LS.1 | `npx vitest run apps/api/test/lead-score-module.test.ts` (15 tests); adjacent suites `entity-crud`, `entity-row-actions`, `entity-manager-metadata`, `navigation`, `i18n` (55 tests) and `sales-module`, `admin-internal`, `docs`, `crm-chat` (54 tests); `npm run typecheck`; `npx eslint` on the touched files | all green. The module is registered, discoverable (health + the five `/api/v1/OpenApi` paths) and refused-everything: 11 operations closed, `ready: false`. Lead/Contact/Account/Opportunity CRUD verified unchanged with the module switched on. Settings row and test records removed by exact id afterwards |
| 19-LS.2 | `apps/api/test/lead-score-schema.test.ts` (**24 tests**, including the enforced unique constraints and the write guard) and the LS.1 suite re-run (**15**); adjacent `entity-crud`, `entity-row-actions`, `entity-manager-metadata`, `navigation`, `i18n`, `sales-entity-layouts`, `acl-matrix`, `dynamic-logic` and three Marketing Automation suites (**144**); full `apps/api/test` run; `npm run typecheck`; `npx eslint` on the touched files; migration applied through `database/migrate.ts` and read back from `pg_indexes` | green. Structures and ownership are runtime facts now: no row carries a score, no model publishes, every operation still refuses with its phase |
| 19-LS.3 … LS.18 | *not started* | each completion report must list the exact commands run and their outcomes before this table may claim support |
