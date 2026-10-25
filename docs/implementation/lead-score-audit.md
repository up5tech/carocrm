# Phase 19-LS.0 — Repository audit and feature contract

> `PLAN_Phase_19_LeadScore.md` §16 `Phase 19-LS.0`, with the decisions required by §19.
> Acceptance: documentation only — no code, no migration, no second database, and no duplicate
> Lead/Contact/Account/Opportunity entity or conversion service proposed.
> Companion behavior/deviation record: `docs/compatibility/lead-score.md`.

Audited on **2026-10-24** against this checkout (`master`, latest commit `d2cb53b`):
`PLAN.md`, `AGENTS.MD`, `PLAN_Phase_19_LeadScore.md`, `pnpm-workspace.yaml`, `apps/api/src/**`,
`apps/worker/src/**`, `apps/web/src/**`, `packages/**`, `modules/**`, `database/migrations/**`,
`database/seed.ts`, `database/seed-metadata.ts`, `i18n/**`, `docs/compatibility/**`,
`docs/implementation/**`, root and per-app `package.json`, `docker-compose.yml`, `.env.example`.

Every claim below is either read in the source at the cited line or is an explicit negative finding
from an exhaustive grep over `apps/`, `packages/`, `modules/`, `database/`, `i18n/`, `content/`,
`docs/`. Optional-module contracts were read from the shipped code, not from any plan.

---

## 1. What the platform already provides

| Capability | Where it lives | What `LeadScore` reuses |
| --- | --- | --- |
| Module wiring | barrel `apps/api/src/<module>/index.ts` exporting `<NAME>_CONTROLLERS` / `<NAME>_PROVIDERS`, spread in `apps/api/src/app.module.ts` — `...ENTITY_CONTROLLERS` at **app.module.ts:155**, `...ENTITY_PROVIDERS` at **:203** | same pattern as `sales`, `service-desk`, `customer-success`, `esignature`; module controllers must be spread **before** line 155 so a real route wins over the generic `/api/v1/:entity` controller |
| Module identity / feature flags | `apps/api/src/customer-success/customer-success-module.ts:1-40` (descriptor: id, version, platform evidence, optional integrations detected by **metadata marker entity**, features with settings paths); `apps/api/src/esignature/esignature-module.ts` (`PENDING_FEATURES` + `effective`) | a `LeadScoreModule` descriptor + `leadScore` settings row; optional integration detection stays metadata-based, never a hard import |
| Authentication | `apps/api/src/auth` (`AuthGuard` as `APP_GUARD`), `@Public()` opt-out | all scoring/conversion routes stay authenticated; no public surface is needed |
| Authorization | `apps/api/src/acl/acl-api.service.ts` — `canUser` :109, `assertAccess` :118, `fieldAccess` :127, `visibleFields` :139, `stripRestricted` :153, `assertFieldWrites` :172, `recordPredicate` :192, `canAccessRecord` :232, `assertRecordAccess` :258, `explainFor` :290; predicates (allowAll/denyAll/own/team/portal/projectScoped) `apps/api/src/acl/predicate.ts:55-61` compiled to SQL in `apps/api/src/entity/entity-record.store.ts` | capability keys → synthetic ACL resources, precedent `apps/api/src/ai-agents/ai-agents-module.ts:17-121` and `apps/api/src/esignature/esignature-domain.ts:21`; no new permission table |
| Metadata registry | `metadata_entries(scope,name,data)` (`database/migrations/001_init.sql:99-107`), loaded core → extension → admin override (`apps/api/src/metadata/metadata-store.service.ts:28-89`, `mergeExtensionEntity` :131); zod `EntityDefinitionSchema` `packages/metadata/src/schemas/index.ts:174-189` | new `LeadScore*` entities are seeded entries; Lead fields are added to the core `Lead` entry (see §4) |
| Generic record store | `entity_records` (`001_init.sql:115-134`): `id, entity_type, name, attrs JSONB, assigned_user_id, created_by_id, modified_by_id, team_ids, created_at, modified_at, deleted_at, version`; physical-vs-attrs split `apps/api/src/entity/entity-record.store.ts:116-136` | **all** score/model/rule/evaluation/operation records are metadata entities in `entity_records`; non-physical fields need no table change |
| Canonical CRUD + list | `apps/api/src/entity/entity.controller.ts` (`GET/POST/PATCH/DELETE :entity`, relations :53-71, `action/massUpdate` :24, `action/massDelete` :31, `action/rowActions` :42) → `EntityCrudService` `apps/api/src/entity/entity.service.ts` (`list` :119, `get` :150, `create` :210, `update` :226, `remove` :251, `rowActions` :302-319); query DSL `packages/query-engine/src/index.ts` (operators normalized :220-324) | conversion creates Contact/Account/Opportunity **only** through `EntityCrudService`; score columns/filters/sorting come from metadata, not a bespoke list API |
| Server-driven record actions | `entity.service.ts:302-319` returns an ACL-computed `RowActionSet`; consumed `apps/web/src/pages/EntityListPage.tsx:168,823` | a `Convert`/`Recalculate score` action is expressible without inventing a new frontend contract |
| Audit | `apps/api/src/audit/audit-hooks.ts` (`registerAuditHook` :58, `recordChanges` :133, `recordDelete` :189, audited-field policy :208-213, redaction :80), registered `app.module.ts:404` | record edits made through the entity layer are audited for free; conversion needs a module-owned operation row for the decision trail (see §6) |
| Domain events + outbox | `apps/api/src/events/event-bus.ts:25` (`dispatch(tx, {type,payload})`, `EVENT_TYPE` :14 = 2–4 dot segments), `OutboxService` → `outbox_events` (`001_init.sql:184`) in the caller's transaction; every generic mutation already emits `entity.created/updated/deleted/restored` with a `changed` field list and `version` (`apps/api/src/events/entity-event.hook.ts:24-33`, registered `app.module.ts:407`) | `leadScore.updated`, `leadScore.bandChanged`, `leadScore.modelPublished`, `lead.conversionSucceeded` (+ `entity.updated` already carries the Lead revision for optimistic concurrency) |
| Jobs | `apps/api/src/jobs/jobs.service.ts:52` `enqueue({job,data,id?})` (`JOB_NAME` :22, 32 000-char payload cap :25, duplicate `id` → `DuplicateRecordError`); durable `jobs`/`job_logs`/`scheduled_jobs` (`001_init.sql:197-212`); seeds in `database/seed.ts:335-453`; worker side `apps/worker/src/schedule/scheduler.ts`, handlers `apps/worker/src/handlers/*-handlers.ts` wired `apps/worker/src/app.ts:100-143` | debounced single-Lead recalculation, bounded batch rebuild, decay sweep, operation recovery — with deterministic job ids as the idempotency mechanism (precedent: deterministic ids in `jobs.service.ts:52-64`) |
| Worker → API call pattern | `x-worker-secret` on `@Public()` action routes, e.g. `apps/api/src/marketing-automation/marketing-automation.controller.ts:805-809`, handlers `apps/worker/src/handlers/marketing-handlers.ts:24-29` | batch rebuild and event-driven recalculation execute on the API side through this seam |
| Workflow / BPM | `packages/workflow/src/types/index.ts:25-40` triggers = **only** `entity.created/updated/deleted/restored` × entityType; nodes `action`, `condition`, `delay`, `end` (:31); condition = sandboxed formula string (:53-61); fixed action set `WORKFLOW_ACTIONS` = updateRecord/createRecord/createNotification/sendEmail/runJob (`packages/workflow/src/actions/index.ts:62-98`); no external trigger/action registration API — the seam is `runJob` (:92-97) + `EXTENSION_JOB_ENQUEUER` (`app.module.ts:338,386`); worker subscribes the `DomainEventBus` on `'*'` (`apps/worker/src/workflows/workflow-handlers.ts:40-67`) | LS.9 threshold actions are expressed as existing workflow actions over `entity.updated` on Lead + a `runJob` escape hatch. `LeadScore` must **not** build a second workflow engine |
| Formula sandbox + declarative criteria | `packages/formula`: AST sandbox with function allowlist and budgets (`engine/index.ts:53-80`, `limits/index.ts:14-16`, `functions/index.ts`); **structured criteria DSL** `packages/formula/src/dynamic-logic/index.ts` — `CriteriaOperator` :9-26 (equals/notEquals/contains/notContains/startsWith/endsWith/gt/gte/lt/lte/in/notIn/isEmpty/isNotEmpty/isTrue/isFalse), `CriteriaCondition` :48, `ConditionNode` :54 (`all`/`any`/`not` trees); applied on write by `apps/api/src/logic/record-logic.service.ts:37-60` with `PHYSICAL_FIELDS` guard `apps/api/src/logic/formula.service.ts:8-19` | the criteria **shape** is reused as the score rule condition vocabulary; evaluation is a LeadScore-owned evaluator (§5) |
| Computed-field precedent | field type `formula`/`generated` written by the platform: `modules/account-health-fields/metadata/entities.json` (`healthScore` computed on Account) | proves a per-record score can be a server-owned field, not a report-time join |
| Append-only score snapshot precedent | `CustomerSuccessHealthSnapshot` (`database/seed-metadata.ts:3060-3097`): `score`, `status`, `effectiveStatus`, `coverage`, `configurationVersion`, `source` (`manual`, `scheduled`, `event` or `rebuild`), `resultState` (`success`, `partial` or `failed`), `errorSummary`, `durationMs`, `components`, `signature`, `triggerReason`, `idempotencyKey`, `calculatedAt`; `acl` read/edit/delete = `no` with a profile-scoped command instead; write guard `apps/api/src/customer-success/customer-success-write-guard.service.ts:67`; internal marker `runAsCustomerSuccessInternal` `apps/api/src/customer-success/customer-success-internal.ts:16-22` | the exact template for `LeadScoreEvaluation` (immutability, coverage, version, source, result state) and for "module writes, user cannot" |
| Idempotency precedent | partial unique indexes over `entity_records.attrs` (`database/migrations/032_phase19_customer_success.sql:17-25`), unique `idempotency_key` on `ai_agent_runs` (`045_phase19_ai_agents.sql:148,184-185`), `voice_call_sessions` (`052_…sql:6-16`); **no** generic `Idempotency-Key` HTTP middleware | `operationKey` uniqueness on the conversion operation entity via the same partial-unique-index pattern |
| Settings | one validated versioned row per module in `app_settings` (precedent `apps/api/src/customer-success/customer-success-settings.service.ts`, `crm-chat/crm-chat-settings.service.ts:12-19`); platform documents go through `SettingsRegistryService.register` (`apps/api/src/admin-panel/settings-registry.service.ts:74`) | one `leadScore` settings row (enabled, active model, thresholds, conversion targets, limits) |
| Secret encryption | `ENCRYPTION_KEY` + AES-256-GCM `packages/core/src/utils/crypto.ts` | not needed — no provider credential in scope for LS.0–LS.13 |
| Outbound HTTP / resilience | `apps/api/src/advanced-integrations/provider-http-client.ts` (timeout, SSRF guard, no body/`Authorization` logging), `resilience.ts`, `provider-error.ts` | only for LS.17 optional AI insight, and only through `AIAgents` (§3.3) |
| Attachments / files | `attachments` + `AttachmentService.download` with parent-record ACL (`apps/api/src/attachment/attachment.service.ts:220-225,293-308`) | LS.15: Lead files stay on the Lead; no copying |
| Notifications / Stream | `notifications` table + SSE (`063_notification_realtime.sql`, `apps/api/src/stream/notification-events.service.ts:20`); `StreamService.create` (`stream/stream.service.ts:142`), auto stream hook `app.module.ts:405` | band-change and conversion-completed notifications; no new transport |
| Search / import-export | `GET /api/v1/Search[/:entity]` (`apps/api/src/search/search.controller.ts:30-56`), `import-export.controller.ts` | score fields become searchable automatically once they are metadata fields on Lead |
| Reports / dashboards | `apps/api/src/reports/report.controller.ts:13-89` (+ `report.service.ts` scheduled delivery, worker `apps/worker/src/handlers/report-handlers.ts`); `dashboards` table (`001_init.sql:242`), dashlet runner `apps/api/src/search/dashboard.controller.ts:10-35`; dashlet `kind` is a constrained enum widened per module (`068_phase19_esignature_reporting.sql`) | LS.18 publishes score/conversion metrics through the existing ReportDefinition + dashlet seams; a new dashlet `kind` needs its own additive migration |
| Navigation | seeded page entries with `permission` + `feature` gate (`apps/api/src/admin-panel/navigation-defaults.ts:12-33,58-90,130-133`; gate resolved `app.module.ts:218-242`; Lead is in the `crm` group :176) | `LeadScore` admin pages gated on the new ACL resources |
| i18n | root `i18n/<locale>/*.json` catalogs loaded wholesale (`apps/api/src/i18n/i18n.service.ts:53,61-64`), served `GET /api/v1/I18n`, SPA cache `apps/web/src/state/i18n.ts:6-13` | `i18n/en/leadscore.json` + `i18n/vi/leadscore.json`; **catalog keys must not contain hyphens** (learned in ES.20) |
| API conventions | `/api/v1/<Module>` controllers, Zod `.strict()` DTO shapes in `dto/*-shapes.ts`, error envelope `{ error: { code, message, details } }` (`apps/api/src/common/filters/global-exception.filter.ts:99-158`), OpenAPI via `GET /api/v1/OpenApi` (`apps/api/src/bootstrap.ts:167-175,204`), global rate limit (`bootstrap.ts:181-193`) | every LS endpoint; `details.reason` is overwritten by the filter — use a different details key for refusal reasons (ES lesson) |
| Frontend | metadata-driven generic pages: routes `apps/web/src/AppRoutes.tsx:171-174` (`/:entity`, `/:entity/:id`), `EntityListPage.tsx` (`listEntries`/`filterEntries`/`orderByLayout` :138-140, row actions :168,823, per-user columns :140-158), `EntityDetailPage.tsx`; module panels mount as conditional cards, e.g. `ESignatureRecordActions` `EntityDetailPage.tsx:573-579` gated by a server availability answer (`components/ESignatureRecordActions.tsx:25-27`); band/KPI visuals `components/NextActionBand.tsx:33` (mounted `EntityDetailPage.tsx:441`) and `pages/DashletResult.tsx:71-106`; multi-step wizard precedent `pages/advanced-integrations/ConnectionWizard.tsx:12,177`; admin settings tab `admin/tabs/CustomerSuccessSettingsTab.tsx:4-5` over `admin/tabs/ModuleSettingsTab.tsx:15,29-33`, registered `admin/tabs.ts:18` | score panel, model admin, conversion wizard all use these seams — no new framework, no new component library |
| Test harness | `apps/api/test/support/boot-api.ts` — cached boot against the **configured primary database** (:39-40 states explicitly no extra database; :51-52 `migrateDb` + `seed`), `JOB_QUEUE_NAME=crm-jobs-test` :48, admin login :57-65, `loginAs` :102, `createTestUser/Role/Team` :121/:167/:199, `purgeEntityEvents` :82 | all LS integration/API tests |

### 1.1 Negative findings (verified by grep over `apps/`, `packages/`, `modules/`, `database/`, `i18n/`, `content/`, `docs/`)

- **No lead conversion exists anywhere.** Zero matches for `convertedAccountId`,
  `convertedContactId`, `convertedOpportunityId`, `leadConversion`, `ConvertLead`. The only trace of
  conversion is the `'Converted'` value inside the Lead status enum
  (`database/seed-metadata.ts:252`). All `convert*` code is Sales *document* conversion
  (`apps/api/src/sales/document/document.service.ts:1170`, `sales.controller.ts:339`).
- **No `Lead` → `Account`/`Contact`/`Opportunity` relationship of any kind.** `Lead.relations` is the
  empty object (`database/seed-metadata.ts:259`).
- **No B2B/B2C (or "company type") mode.** No `B2B`, `B2C`, `companyType` in code, settings,
  preferences (`apps/api/src/preferences/preference-shapes.ts`) or metadata.
- **No scoring/rule engine for leads.** The only score concept shipped is Customer Success health
  scoring (§3.4). No `LeadScore`/`lead_score` identifier exists outside
  `PLAN_Phase_19_LeadScore.md` itself.
- **No generic duplicate-detection service.** Only the pieces listed in §3.5.
- **No phone-number normalizer.** ~~Nothing equivalent to `normalizeEmailAddress` exists for phone; no
  libphonenumber dependency in any `package.json`.~~ **Corrected in 19-LS.10:** this finding is stale.
  `apps/api/src/voice-communications/phone-number.ts` ships `normalizePhone`/`phoneMatchKeys` behind the
  `PHONE_NORMALIZER` token with a conservative and a `libphonenumber-js` implementation
  (`apps/api/package.json:45`), and `VoiceContactResolverService` already does an ACL-gated lookup by phone.
  LS.11 reuses that seam — see `docs/implementation/lead-score-conversion-contract.md` §1.4, §9.1.
- **Calendar activities cannot reference a Lead.** `activityRelations` = `accounts`, `contacts`,
  `users`, `reminders` (`database/seed-metadata.ts:50-55`); `Task`/`Call`/`Meeting` use it verbatim
  (`:304-367`). Only `Email` declares `leads` (`:61-67`). Consequence: activity-based engagement
  scoring for a Lead has no data path today (§7, gap G2).
- **`Sales` does not own Opportunity and dispatches no domain events.** `SALES_ENTITY_TYPES`
  (`apps/api/src/sales/sales-records.ts:30-93`) is Product/PriceBook/Quote/Invoice/Payment/Inventory/
  Subscription; `sales.opportunity.stageChanged` is whitelisted as a journey trigger
  (`apps/api/src/marketing-automation/marketing-journey-trigger.service.ts:17`) but **nothing emits
  it** — only the generic `entity.updated` hook fires.
- **No generic HTTP `Idempotency-Key` middleware**; idempotency is per-feature (unique column/index,
  deterministic job id).
- **No destructive test setup.** No test database, schema, container, truncate, drop or reset. See §8.

---

## 2. Capability matrix

Legend: **Reuse** = platform service used as-is · **Extend** = existing artifact extended additively ·
**Build** = new in this module · **Optional** = consumed only when the audited contract exists ·
**Defer** = documented, not implemented in the initial delivery.

| Concern | Decision | Basis |
| --- | --- | --- |
| Lead / Contact / Account / Opportunity entities | **Reuse** (core `entity_records` metadata entities) | `seed-metadata.ts:170,206,234,267`; plan §0.1-2 |
| Lead CRUD, list, detail, search | **Reuse** `EntityCrudService` + query-engine | `entity.service.ts:119-251`; plan §2.2 |
| Lead status vocabulary incl. `Converted` and `Dead` | **Reuse**, no new enum values | `seed-metadata.ts:252` |
| Lead conversion command + operation record | **Build** (none exists) | negative finding §1.1 |
| Score fields + `Converted To` fields on Lead | **Extend** the core `Lead` metadata entry (attrs JSONB → no table migration) | `entity-record.store.ts:116-136`; Sales precedent for core-entry edits `seed-metadata.ts:187-198,292-296` |
| `LeadScoreModel`, `LeadScoreRule`, `LeadScoreEvaluation`, `LeadConversionOperation` | **Build** as metadata entities in `entity_records` | `CustomerSuccessHealthSnapshot` template `seed-metadata.ts:3060-3097` |
| Indexes (unique current score per Lead+model, operation key, history lookup) | **Build** — one additive migration `073_phase19_lead_score.sql` | `032_phase19_customer_success.sql:17-25` |
| Rule condition vocabulary | **Reuse** criteria shape; **Build** bounded scoring evaluator over it | `dynamic-logic/index.ts:9-54`; §5 |
| Formula sandbox / `RecordLogicService` | **Optional reuse, rejected for rules** (§5.2) | `record-logic.service.ts:37-60` |
| ACL (record + field level) | **Reuse** `AclApiService` + synthetic capabilities | `acl-api.service.ts:109-290` |
| Server-owned write guard (score/converted fields not user-writable) | **Reuse** pattern | `customer-success-write-guard.service.ts:67`, `customer-success-internal.ts:16-22` |
| Audit trail | **Reuse** kernel audit + module operation row | `audit-hooks.ts:58-213` |
| Domain events / outbox | **Reuse** `EventBus.dispatch(tx, …)` | `event-bus.ts:25` |
| Jobs / cron / retry | **Reuse** `JobsService` + `scheduled_jobs` + worker handlers | `jobs.service.ts:52`, `seed.ts:335-453` |
| Workflow/BPM reactions to a band change | **Reuse** existing triggers/actions via `entity.updated` + `runJob`; **no** new trigger API | `packages/workflow/src/types/index.ts:25-40`, `actions/index.ts:62-98` |
| Engagement signal: MA opens/clicks/delivered/bounces | **Optional** table read, keyed by recipient entity id | `marketing-event-ingestion.service.ts:12-43`, migration `042_phase19_marketing_webhook_inbox.sql:25-43` |
| Engagement signal: campaign attribution / audience membership | **Optional** `TargetListEntry memberType/memberId`, `marketing_audience_snapshot_entries` | `marketing-audience.service.ts:268,299-313`, migration `038:127` |
| Engagement signal: consent / suppression | **Optional**, as an explicit negative/neutral signal only | `marketing-consent.service.ts:253-265`, `marketing-event-ingestion.service.ts:258-277` |
| Engagement signal: Email↔Lead links | **Reuse** `entity_links` through `EntityCrudService.related()` | `seed-metadata.ts:62-66` |
| Engagement signal: Call/Meeting/Task per Lead | **Defer** — no data path today (gap G2) | `seed-metadata.ts:50-55` |
| AI fit insight | **Optional** `AIAgentRunsService.create/execute`, manual-trigger only | `ai-agent-runs.service.ts:374,786,416-421` |
| Duplicate detection | **Build** (email/domain exact + name fuzzy suggestion-only); reuse `normalizeEmailAddress` for the *algorithm*, not MA's HMAC identity | `marketing-automation-domain.ts:1385` vs `marketing-identity.ts:36-47` |
| Field mapping Lead→Contact/Account | **Build** as validated settings/config, executed through canonical CRUD | §6.3 |
| Reports / dashlets | **Reuse** existing seams; a dashlet `kind` needs an additive migration | `report.controller.ts:13-89`, migration `068` |
| Notifications / Stream | **Reuse** | `stream.service.ts:142`, `notification-events.service.ts:20` |
| Frontend: score panel, model admin, wizard | **Reuse** generic pages + card seam + antd `Steps` | `EntityDetailPage.tsx:573-579`, `ConnectionWizard.tsx:12` |
| i18n / navigation / settings row | **Extend** seed lists additively | `navigation-defaults.ts:130-133`, `i18n/en/*.json` |
| Test database | **Out** — prohibited by `AGENTS.MD` §3 and plan §0.1-13 | `boot-api.ts:39-40` |

No duplicate entity or service is proposed anywhere in this contract. `LeadScore` adds four
module-owned metadata entities, extends the `Lead` entry, and builds one command service.

---

## 3. The actual CRM core contract (what LS must consume)

### 3.1 Lead — `database/seed-metadata.ts:234-264`

Fields: `standardFields` (`id, name, description, createdAt, modifiedAt, createdById, modifiedById,
assignedUserId, teams, deletedAt` — `:7-18`) plus `firstName`, `lastName`, `title`, `emailAddress`
(email), `phoneNumber` (phone), `company`, `industry`, `source` (varchar), `status` (enum
`New` / `Assigned` / `In Process` / `Converted` / `Dead`, default `New`). Required: `name` (:241) and `lastName`
(:243). `relations: {}` (:259), `indexes: []` (:260), `record.displayField: 'lastName'` (:261).

Consequences:
- `Converted` **already exists** as a lifecycle status; LS does not add a status value.
- `Dead` already exists and is the natural explicit disqualification signal — `Disqualified` must not
  be invented as a new Lead status (plan §3.3 says a band may come from a lifecycle signal, not a
  threshold).
- Lead has **no** `accountId`, no `website`, no `employees`, no `campaignId`, no `score` fields today.
  Fit signals available for scoring from the Lead itself are only `company`, `industry`, `source`,
  completeness of `emailAddress`/`phoneNumber`/`title`, and timestamps/`version`.

### 3.2 Contact / Account / Opportunity

- Contact `:206-222`: required `name`, `lastName`; `accountId` link → Account (:219); `leadSource`
  varchar; `status` enum `Active` / `Left`; `emailAddress`, `phoneNumber`, `title`.
- Account `:170-198`: required `name` only; `website`, `emailAddress`, `phoneNumber`, `type`,
  `industry`, `billingAddress*`; oneToMany `contacts, opportunities, quotes, salesOrders, invoices,
  payments, subscriptions, cases` (:187-198).
- Opportunity `:267-301`: required `name`; `amount` currency, `closeDate` date, `stage` enum
  `Qualification`, `Analysis`, `Proposal`, `Price Negotiation`, `Review`, `Closed Won`, `Closed Lost` default
  `Qualification`, `probability`, `nextStep`, `type`, `leadSource`, `accountId` link (:289),
  `contactIds` linkMultiple (:290), oneToMany `quotes` (:292-296).

**Opportunity exists as a first-class core entity**, so plan §7.2's "optional Opportunity conversion"
is *supported*, not deferred on entity grounds (decision D4). Sales links its documents to it via
`opportunityId`; conversion must not touch `SalesDocumentService.createFromOpportunity`
(`apps/api/src/sales/document/document.service.ts:1257-1312`).

### 3.3 Validation path

`packages/entity-engine/src/entity-manager/index.ts:111-146` (create: hooks → defaults → validate →
id/version → store → relations) with required-field enforcement at `:233-237` and type/format
validation in `packages/entity-engine/src/validation/index.ts` (email/url :40-44). Anything created
by conversion inherits this, which is exactly why conversion must go through it (plan §4.4).

### 3.4 Existing scoring precedent (closest analogue)

Customer Success health scoring: `CustomerSuccessProfile.healthScore/healthScoreAt/scoreTrend` +
`calculatedHealthStatus` + override fields (`seed-metadata.ts:2986-3036`), snapshot entity with
`coverage`, `configurationVersion`, `source`, `resultState`, `components`, `signature`,
`idempotencyKey` (`:3060-3097`), signal providers returning `HealthSignalResult` with a `source`
`{entity,id}` provenance pointer (`apps/api/src/customer-success/customer-success-signals.ts:55-66`),
read model served by a profile-scoped command rather than entity read ACL
(`customer-success-health-snapshot.service.ts:61-101`).

LS adopts the *shape* (current value on the record + append-only snapshot with coverage/version/
components/source + module-scoped read command) but must not reuse the CS settings-versioned
calculator: CS health scoring is account-level, settings-row configured, and its signals are
subscription/CS facts (§5.2 for the rule-configuration difference).

### 3.5 Existing duplicate-detection pieces

- `normalizeEmailAddress` — `apps/api/src/marketing-automation/marketing-automation-domain.ts:1385`.
- `emailIdentity` (keyed HMAC-SHA-256 digest) — `apps/api/src/marketing-automation/marketing-identity.ts:36-47`.
- Audience dedup "prefer a Contact over a Lead, then oldest" — `marketing-audience.service.ts:70`.
- Exact email lookup pattern `lower(attrs->>'emailAddress')` — `apps/api/src/service-desk/email-to-case.service.ts:245-258`.
- Candidate-listing precedent for a merge UI — `apps/api/src/service-desk/case-merge.service.ts:33`.
- **ACL-gated candidate lookup that counts what the caller may not see** — `VoiceContactResolverService`,
  `apps/api/src/voice-communications/voice-contact-resolver.service.ts:101-167` (digit-normalized `IN (keys)`
  SQL at `:147-154`); this is the pattern LS.11's hidden-match rule is built on, not an invention.
- Metadata `record.duplicate` flag exists in `packages/metadata/src/schemas/index.ts`.
- `pg_trgm` is installed with attribute expression indexes (`database/migrations/008_phase12.sql:8-22`) —
  **but two of them key on `'email'` and `'phone'`, which are not field names in this schema** (the fields are
  `emailAddress`/`phoneNumber`), so that index covers nothing usable. Found while deciding LS.10's fuzzy rule.

No unique index on `attrs->>'emailAddress'` or on any phone value, and no cross-entity matcher (both still
true; the phone-normalizer half of this line was corrected above).

---

## 4. Metadata plan (no core-table migration needed for fields)

Non-physical Lead attributes live in `entity_records.attrs` JSONB — the split is enforced by
`PHYSICAL_KEYS` (`entity-record.store.ts:116-136`) and `entity_records` has a GIN index on `attrs`
(`001_init.sql:115-134`). Therefore the following are **metadata-only** changes to
`database/seed-metadata.ts` (the same way Sales/Projects extended core entries, `:187-198`, `:292-296`):

| Group | Fields added to `Lead` | Notes |
| --- | --- | --- |
| Score projection | `scoreValue` (int, `inList`, `sortable`), `scoreBand` (enum `Cold`, `Warm`, `Hot`, `Sales Ready`, `Disqualified`, `Unknown`), `scoreStatus` (enum `current`, `stale`, `pending`, `failed`, `not_scored`), `scoreModelId` (link → `LeadScoreModel`), `scoreModelVersion` (int), `scoreCalculatedAt` (datetime, sortable), `scoreInputsAsOf` (datetime), `scorePreviousValue` (int, for trend), `scoreReasonCodes` (multiEnum, stable codes only) | one current projection for the **active model** (plan §5.3 explicitly permits this simpler policy); `scorePreviousValue`/`scoreCalculatedAt` give the trend without an N+1 history read |
| Conversion result | `convertedAt` (datetime), `convertedById` (link → User), `convertedAccountId` (link → Account), `convertedContactId` (link → Contact), `convertedOpportunityId` (link → Opportunity), `conversionOperationId` (link → `LeadConversionOperation`) | plan §5.6; links to created/linked targets, Lead row untouched |
| Layouts | a `detail` panel `score` and a `detail` panel `converted`; `list` panel gets `scoreValue`, `scoreBand`, `scoreCalculatedAt`; `filter` entries for band/status/score range | consumed by `EntityListPage.tsx:138-140` and `EntityDetailPage.tsx` with no frontend code |
| ACL | `LeadScoreModel/Rule/Evaluation/ConversionOperation` resources; the score/converted fields become **server-owned** through a `LeadScore` write guard | `customer-success-write-guard.service.ts:67` template |

Four new metadata entities (all in `entity_records`): `LeadScoreModel`, `LeadScoreRule`,
`LeadScoreEvaluation`, `LeadConversionOperation`. Shapes are in §5–§6; they follow the
`CustomerSuccessHealthSnapshot` conventions (append-only for evaluation, module-written, read closed
at ACL and served by scoped commands).

Only one SQL migration is anticipated, and it is index-only and additive (LS.2):

Delivered in 19-LS.2 as `database/migrations/073_phase19_lead_score.sql` — 15 partial indexes over
`entity_records`, each scoped `WHERE entity_type = '…' AND deleted_at IS NULL`:

| Group | Indexes |
| --- | --- |
| Lead projection reads | `idx_entity_records_lead_score_value` (`::numeric`), `_band`, `_status`, `_calculated`, `_model` |
| Models | `idx_entity_records_lead_score_model_status`, `uq_entity_records_lead_score_model_version` on `(name, attrs->>'modelVersion')` |
| Rules | `idx_entity_records_lead_score_rule_model`, `uq_entity_records_lead_score_rule_reason` on `(modelId, modelVersion, reasonCode)` |
| Evaluations | `idx_…_evaluation_lead` `(leadId, calculatedAt)`, `idx_…_evaluation_model`, `uq_…_evaluation_key` `(idempotencyKey)` |
| Conversion operations | `uq_entity_records_lead_conversion_operation_key` `(operationKey)`, `idx_…_operation_lead`, `idx_…_operation_status` `(status, requestedAt)` |

Three facts the schema had to learn from the running system, corrected here so the audit matches the
build (each is now an assertion in `apps/api/test/lead-score-schema.test.ts`):

* **no unique index on the projection.** It lives on the Lead row, which is one row per Lead, so
  "one current score per Lead and model" holds structurally (the single-active-model policy plan §5.3
  allows). The earlier sketch of `uq_lead_score_current_lead` on `((attrs->>'scoreModelId'))` was wrong —
  it would have refused a second Lead scored by the same model.
* **`version` is not available as a metadata field name.** It is `entity_records`' concurrency column,
  consumed by `EntityCrudService.update` (`entity.service.ts:229-231`), so a model's version number is
  `modelVersion`, matching `LeadScoreRule.modelVersion` and `Lead.scoreModelVersion`.
* **`name` is a physical column, not an attribute.** An identity index on `attrs ->> 'name'` would index
  NULL for every row; the model index keys on the `name` column plus `attrs->>'modelVersion'`. Metadata
  `indexes` are documentation only — nothing in the repository generates DDL from them.



`032_phase19_customer_success.sql:17-25` is the exact precedent for partial unique indexes over
`attrs`, and `037_phase19_marketing_automation.sql` for the `IS NOT NULL` form on an optional key. The
file was reviewed and applied as written; nothing was dropped, renamed, truncated or backfilled, and no
score was computed during the migration (plan §15.1) — the LS.2 suite asserts no row of any type carries
a Lead Score attribute.

---

## 5. Scoring engine contract

### 5.1 Model and rule lifecycle

- `LeadScoreModel`: `name`, `description`, `status` (`draft`, `published`, `archived`), `version` (int),
  `scaleMin`/`scaleMax` (default 0/100), `baseScore`, `scoreFloor`/`scoreCeiling`, `bands`
  (validated non-overlapping thresholds), `effectiveFrom`/`effectiveTo`, `allowedFieldPaths`
  (explicit allowlist of Lead field paths and approved event sources the model may read),
  `publishedById`/`publishedAt`, `settingsJson` (validated, versioned, non-executable).
  Publishing writes an immutable version; editing a published model forks a new draft version
  (plan §5.1). One **active published** model at a time (settings `activeModelId`).
- `LeadScoreRule`: `modelId`, `modelVersion`, `name`, `enabled`, `dimension`
  (`fit`, `intent`, `engagement`, `completeness`, `recency`, `negative`), `reasonCode` (stable, i18n-able),
  `condition` (declarative criteria only), `points` (clamped), `effect` (`add`, `subtract` or `setBand`),
  `priority`, `missingDataPolicy` (`ignore` or `neutral`), optional `source` (`lead` | `marketingEvents`
  | `emailLinks`) with bounded `lookbackDays` and `decayPolicy`.
  `setBand` is the only effect that can produce `Disqualified`, and it may key off the existing Lead
  `status` (`Dead`) — never off a low number (plan §3.3).

### 5.2 Condition DSL: reuse the shape, own the evaluation

Reuse `CriteriaOperator` + `ConditionNode` (`packages/formula/src/dynamic-logic/index.ts:9-54`) as the
vocabulary, with these module-side constraints — the reason `LeadScore` must not simply reuse
`LogicCondition` strings or `RecordLogicService`:

1. A score rule condition is **always** the structured `ConditionNode` form; the `string` (formula)
   alternative of `LogicCondition` (`:59`) is rejected at validation. Score rules must not be able to
   call the formula engine, and must not run in the record-write path
   (`record-logic.service.ts:37-60` writes fields — a score rule must never write).
2. Field paths validate against `Lead` metadata **and** against the model's `allowedFieldPaths`, at
   save time and again at evaluation time; relation traversal is limited to one hop declared by the
   model, never an arbitrary join (plan §6.2).
3. Depth ≤ 2 nested groups, ≤ 20 predicates and ≤ 60 nodes per rule; `points` bounded to ±50 so one rule
   cannot decide the scale; enforced in the validator and re-run at publish, mirroring the budgets the
   formula engine already applies (`packages/formula/src/limits/index.ts:14-16`). Delivered in 19-LS.3.
4. Operators unsupported for the field's declared type are rejected (e.g. `contains` on `int`) — the whole
   matrix is `OPERATORS_BY_TYPE` in `lead-score-condition.ts`. Relationship traversal is **refused** at this
   phase rather than half-supported: `multiEnum` and link fields are existence-only, and there is no
   Lead→Activity relation to traverse (gap G2), so 19-LS.4 never has to invent semantics a stored score
   already depends on.
5. Missing/unknown follows `missingDataPolicy` and appears in the breakdown as `unknown`, never as 0
   (plan §1.2 "Missing is not negative by default").

Aggregation (deterministic, plan §6.3): `baseScore` → matched rule deltas in `priority` order, each
rule counted once (event de-duplication by `(source, entityId)` within the lookback) → dimension
weights if configured → clamp to `[scoreFloor, scoreCeiling]` → stable rounding → band lookup.
Same `(modelVersion, input snapshot)` ⇒ same output, asserted by unit tests.

**Delivered in 19-LS.4**, with the choices §6.3 left to be defined (all of them are now asserted in
`apps/api/test/lead-score-evaluator.test.ts`):

1. **evaluation order** is `priority`, then `reasonCode`, then `id`, so a tie cannot make a stored score
   depend on the order a list query returned (compat U13).
2. **the sign comes from the `effect`**, not from the stored number: `add` contributes `|points|`,
   `subtract` contributes `-|points|`, `setBand` contributes 0 and may assign its band. The last matched
   `setBand` in that order wins.
3. **conditions are three-valued** — `matched`, `not_matched`, `unknown` (Kleene `all`/`any`/`not`, so
   `not unknown` stays unknown). A signal is `unknown` when it was **not supplied to the evaluation at
   all**, which is how a field hidden by field-level ACL differs from a field that is empty; the signature
   records `not_supplied` separately for the same reason. Supplied-and-empty answers `isEmpty`/`isNotEmpty`
   definitely and any comparison `unknown`.
4. **weights are normalized relative influence**: `Σ(delta_d × weight_d) / Σ(weight_d)` over the dimensions
   the evaluation actually attempted, applied after the rule deltas and before the clamp. A skipped rule
   leaves the denominator, so it cannot dilute a score; a weight total of 0 falls back to the unweighted
   delta and flags `LS_EVALUATION_WEIGHTS_ZERO_TOTAL`.
5. **rounding is half away from zero** (`Math.round` sends `-0.5` to `-0`, which would make the sign of a
   delta decide the rule), and the clamp runs first because `scoreFloor`/`scoreCeiling` are integers.
6. **coverage** is the known share of attempted rule weight, where a rule's weight is `|points|` (1 for a
   `setBand` rule or a draft rule with no points yet): definite answers in both sides, `neutral` unknowns
   and errors in the denominator only, `ignore` unknowns and skips out of both. A `neutral` policy means
   "the model wanted this weight and the Lead did not answer" — visible as a hole; `ignore` means "this
   rule asks nothing when the signal is absent".
7. **a band gap is reported, not invented**: a score no band covers answers `Unknown` with
   `LS_EVALUATION_SCORE_OUTSIDE_BANDS`, and the projection writer (19-LS.5) decides whether that keeps the
   previous band.
8. **only a structural failure refuses a number** — an unparseable condition, a field outside the grant, or
   more rules than `MAX_EVALUATED_RULES`. Every rule failing gives `resultState: failed` and
   `scoreValue: null`; a model whose rules all asked nothing gives the base score at coverage 0, because
   "nothing known" is the model's declared neutral start, not a server error.

### 5.3 Evaluation record and explanation

`LeadScoreEvaluation` (append-only, `read: 'no'` at ACL, served by `GET /leads/:id/score/history`):
`leadId`, `modelId`, `modelVersion`, `scoreValue`, `qualificationBand`, `evaluationStatus`,
`calculatedAt`, `inputsAsOf`, `sourceRevision` (the Lead `version`), `trigger`
(`lead_change`, `engagement_event`, `manual_recalculate`, `model_publish`, `batch_rebuild`, `decay_sweep`),
`ruleResults` (per-rule matched/not_matched/unknown/skipped/expired/error + points),
`positiveReasonCodes`/`negativeReasonCodes`, `coverage`, `resultState`, `errorSummary` (safe code),
`correlationId`, `jobId`, `idempotencyKey`.

Reason text is generated from stable codes through the i18n catalogs, and only for fields the reading
user may see — `stripRestricted`/`visibleFields` (`acl-api.service.ts:139,153`) decide what the
breakdown may contain (plan §6.5).

**Delivered in 19-LS.5**, with four decisions the plan left open:

1. **freshness is measured on the inputs, not on the Lead's `version`.** Storing a score is itself a write,
   so `version` moves every time a score is kept and can never answer "has this record changed since it was
   scored". The evaluation therefore carries `inputsHash` — the hash over exactly the fields the engine read,
   in LS.4's canonical form — and the read re-computes it. `sourceRevision` is kept as provenance ("which
   revision did this describe"), never as the staleness test. A reader whose own field ACL hides one of the
   model's inputs gets **no claim either way** rather than a false `stale`, because their view of the inputs
   is a different set from the one the score was computed from.
2. **the breakdown names rules, not values.** Each entry carries the stable reason code, the rule's own name,
   its dimension, its effect, its outcome and the points it contributed — and no Lead data. A reason that
   quoted `industry = Software` would let an explanation endpoint read a field the caller's ACL hides, which
   is the boundary LS.4 found the engine had to respect. Localized labels come from the module's own
   `i18n/<locale>/leadscore.json` (`outcome.*`, `dimension.*`, `score.freshness.*`, `score.staleBecause.*`),
   resolved in the reader's language, which is their stored preference — `Accept-Language` is only the
   pre-auth fallback.
3. **history is one row per (Lead, model version, inputs).** The `idempotencyKey` is a digest over exactly
   those, so a repeated recalculation of unchanged data returns the existing row and — when the projection
   already says the same thing, with `scorePreviousValue` and `scoreInputsAsOf` preserved rather than
   rewritten — leaves the Lead alone. An edit and its reversal therefore produce two rows, not three. The key
   is looked up **before** the insert: inside a transaction, a rejected statement aborts it, so an
   insert-then-catch design could not read the row back and would answer a duplicate with a failure instead of
   a no-op.
4. **creating the history row is part of the recalculate right.** `LeadScoreEvaluation` is `create: 'yes'` /
   `read: 'no'` by LS.2's profile, so a role that may recalculate is granted create on it and still cannot read
   it except through the Lead-scoped commands. The alternative — a module that writes a row the caller may not
   create — would make the projection's content depend on a permission nobody can see or manage; and because
   the evaluation and the projection are one transaction, a refusal leaves neither half behind (asserted).

### 5.4 Recalculation

Delivered by 19-LS.6; the shape below is what exists, with the two deviations from this file's original row
recorded where they belong.

- Trigger: the already-emitted `entity.created`/`entity.updated` on `Lead` with its `changed` list
  (`events/entity-event.hook.ts:24-33`) → worker subscriber → `POST action/work/lead-changed`, which
  **decides** and enqueues. Optional MA engagement stays a table-read sweep, not an MA event (§3.5/§7), and
  belongs to LS.9.
- Jobs: `leadScore.recalculateLead` (one Lead; row id = `sha256(job|leadId|modelVersion|revision)`, so a
  duplicate delivery hits the `jobs` primary key and the outstanding-`pending`/`active`-job check collapses a
  burst into one row), `leadScore.batchRecalculate` (chunked at `MAX_BATCH_CHUNK = 50`, capped at
  `MAX_BATCH_TOTAL = 2_000`, cursor = last Lead id, continuation row id
  `sha256(job|runId|cursor)` so a repeated hand-off cannot fork the run).
  **Deviation 1:** `leadScore.decaySweep` is not here — plan §16 puts the decay sweep in LS.9 with the
  engagement signals, and a sweep needs `settings.scoring.decay` which nothing validates yet.
  **Deviation 2:** "retry with bounded backoff" is the platform queue's (`config.jobAttempts`,
  `jobBackoffBaseMs`), not a Lead Score policy: the worker throws on a transport/server failure and on a wrong
  capability, and *completes* on a refusal the module means (`LEADSCORE_*`, a vanished Lead), because an
  at-least-once delivery that retries an operator's switch forever is an outbox outage.
- Duplicate delivery is absorbed twice over: the deterministic job id above, and LS.5's
  `(leadId, modelVersion, inputsHash)` evaluation key, which records nothing and moves nothing for unchanged
  inputs.
- Cost rule: never compute during a list read; list/detail read the projection fields only (plan §4.2). The
  subscriber does not read a Lead at all — it posts three fields to the API, and the API's decision is where
  `requiredInputFields` lives.
- Loop break: a job is queued only when `changed ∩ requiredInputFields ≠ ∅`. Because LS.3 refuses scoring
  outputs as rule inputs, the fields LS.5 and LS.6 write (`scoreValue`, `scoreStatus`, …) can never appear in
  that intersection, so a score write or a pending marker cannot re-trigger itself. No in-process flag.
- Attribution: the job runs under the documented service authority (`lead-score-authority.ts`, same shape as
  `customer-success-authority.ts`) through the worker route, so record scope, field masking, validation, the
  LS.2 write guard and audit all stay on the one path. `correlationId` on the evaluation names the job
  (`leadScore:recalculate`, `leadScore:recalculate-batch-chunk`).

---

## 6. Conversion contract

> **Decided in 19-LS.10 — the authoritative contract is
> `docs/implementation/lead-score-conversion-contract.md`.** What follows is the LS.0 sketch, kept because this
> file is the pre-implementation audit, and it is **not** the spec. Where the two differ, the contract wins;
> the deltas LS.10 took are these five, and each is argued in the contract's own §-reference:
>
> 1. **`previewed` is retired** and `LeadConversionOperation` starts at `processing` (contract §3.1) — a status
>    no code path may legitimately write, because a preview must write nothing (plan §8.3), is a lie in the
>    schema and a burden on the recovery screen.
> 2. **Concurrency is decided by a `SELECT … FOR UPDATE` on the Lead inside the work transaction**, with the
>    optimistic `version` check as the second line and the loser settled to `failed_final`
>    (`failureCode: 'already_converted'`) rather than answered with a bare 409 (contract §4.3).
> 3. **`Lead.name` is not a mappable source and `assignedUserId`/`teams` are not copied.** `name` is mirrored
>    from the metadata display field by `EntityCrudService.withName` (`entity.service.ts:509-519`) and the
>    Contact's display field is `lastName` — so `Contact.lastName` is the person's required field, verified
>    against the running API (`422 … "Field is required."`), and copying a Lead's team list onto a new Contact
>    would widen access rather than preserve it (contract §7.2, §7.6).
> 4. **The duplicate stages reuse existing seams instead of building them**: voice's `PHONE_NORMALIZER` +
>    `phoneMatchKeys` (so no second normalizer, and no E.164 claim — a Lead carries no country to default
>    against), MA's `normalizeEmailAddress` but explicitly **not** its consent `emailHash`, and the Voice
>    resolver's hidden-match counting for the ACL rule. The `pg_trgm` indexes LS.0 would have relied on key on
>    field names that do not exist (§3.5 above) (contract §1.4, §9.1-§9.4).
> 5. **Two schema/permission facts LS.13 must change before the command can exist**: the operation entity's
>    `create: 'no'` profile makes the command's own insert impossible for any non-admin role
>    (`EntityCrudService.create` asserts the caller's create grant; only the LS field guard is exempted by
>    `runAsLeadScoreInternal` — LS.5 solved the identical problem by seeding evaluations with `create: 'yes'`),
>    and the `conversionAuditRead` capability currently maps to that entity's own `read`, so granting it would
>    open the generic record list for operation rows — contradicting the design that keeps them reachable only
>    through the module command (contract §13.2).
>
> A sixth item is a gap rather than a delta: **no sub-phase in plan §16 owns the correction/reopen workflow**
> the plan itself requires (§7.6). LS.10 states the policy (contract §11.4: a correction is a new operation row,
> it may re-point or clear one reference, never delete a target or un-convert a Lead) and records the missing
> owner as G9, because the fields it must change are server-owned for every other caller — so today nobody at
> all can correct a wrong reference.

### 6.1 Command semantics

`LeadConversionService.convert(input)` is a domain command, not a Lead field write and not an entity
type mutation. Valid target combinations, validated server-side regardless of what the UI offers:

| Mode | Combination | Gate |
| --- | --- | --- |
| `contact` | create **or** link Contact | Contact create/read/write ACL |
| `account` | create **or** link Account | Account ACL |
| `account_contact` | Account + Contact, Contact linked to Account | both + Contact `accountId` (`seed-metadata.ts:238`) |
| `contact_existing_account` | Contact + selected existing Account | both |
| `existing_contact_existing_account` | link both, relationship consistency confirmed by the user | read/link ACL |
| `+ opportunity` | optional add-on for any of the above | Opportunity ACL + required `name`; Sales untouched |

### 6.2 Operation state machine and idempotency

`LeadConversionOperation`: `operationKey` (unique partial index), `sourceLeadId`,
`sourceLeadRevision`, `requestedTargets`, `status` (`previewed`, `processing`, `succeeded`, `failed_retryable`, `failed_final`, `needs_review`), `requestedBy/At`, `confirmedAt`, `completedAt`, `previewHash`,
`mappingVersion`, `selectedMatchIds`, `createdAccountId`/`linkedAccountId`/
`createdContactId`/`linkedContactId`/`createdOpportunityId`/`linkedOpportunityId`,
`resultSummary`, `failureCode`, `correlationId`.

The persistence layer **can** be atomic here: `EntityCrudService` writes run on one PostgreSQL
connection and `EventBus.dispatch(tx, …)` takes the caller's transaction (`event-bus.ts:25`), so
targets + Lead status + references + operation row + outbox event commit together. The state machine
is still implemented (not as a fallback but as the audit trail): a replay with the same
`operationKey` returns the stored result; a different key against an already-`Converted` Lead returns
`409 LEAD_ALREADY_CONVERTED`; a `processing` row that never committed is recovered by the sweeper,
which re-checks for existing created targets before retrying (plan §4.3, §7.8).

Optimistic concurrency uses the record `version` already stored in `entity_records`
(`entity-manager/index.ts:122-125`) plus `previewHash`.

### 6.3 Field mapping

Versioned configuration inside the `leadScore` settings row (no new entity needed at MVP): a
`source → target` list per target entity, validated against metadata (existence, type compatibility,
writability), plus `createDefaults`, and a `existingTargetPolicy: skip` — the default that never
overwrites a non-empty target field (plan §7.4). `password`/`file`/`attachmentMultiple` sources and
the Lead's own score/diagnostic fields are non-mappable by rule, not by convention.

Default map against the audited core fields:

| Lead | Contact | Account | Opportunity |
| --- | --- | --- | --- |
| `firstName`,`lastName` | same (`lastName` is **required** on Contact; `name` is not mapped — the kernel mirrors it from the display field, contract §7.2) | — | — |
| `title` | `title` | — | — |
| `emailAddress` | `emailAddress` | `emailAddress` (only in account-only mode) | — |
| `phoneNumber` | `phoneNumber` | `phoneNumber` | — |
| `company` | — | `name` | — |
| `industry` | `industry`? **no such Contact field** → skip | `industry` | — |
| `source` | `leadSource` | — | `leadSource` |
| — | — | `website` (**Lead has no website field** — unmappable) | — |
| — | — | — | `name` ← required, defaulted from Lead name (`<Last name> — <company>`), user-editable in the wizard |

### 6.4 Duplicate resolution

`LeadDuplicateResolver` returns only ACL-visible candidates, staged:
1. exact normalized email (`lower(trim())` on `attrs->>'emailAddress'`, pattern
   `email-to-case.service.ts:245-258`) → `same person`;
2. exact phone on the normalized form (new bounded normalizer, no new dependency) → `same person`;
3. Account `website`/domain, then `company` name → `same organization` / weaker signals;
4. name similarity → suggestion only, never an automatic link (plan §7.3).
Generic mailboxes (`info@`), shared household phones and multi-person companies are configured
non-exact. The user must choose link / create-with-override / cancel; an override needs an explicit
capability. Candidate answers never include records the actor cannot read, and may only carry a
generic "a possible match exists but is not visible to you" flag.

### 6.5 Post-conversion preservation

The Lead row is not deleted or rewritten in place: `status → 'Converted'`, plus
`convertedAt/ById/AccountId/ContactId/OpportunityId/conversionOperationId`. Existing links stay put —
`Email.leads` (`seed-metadata.ts:62-66`) keeps the Lead as a parent, `Case.leadId` (`:3443`) and
`MarketingConsent.leadId` (`:4204`) keep their source attribution. Nothing is copied to the Contact as
implied consent (§7.4 of the plan; MA consent is keyed by `emailHash`, not by record id).

---

## 7. Optional-module contracts actually available

### 7.1 MarketingAutomation

- Entities are `entity_records` rows allowlisted in
  `apps/api/src/marketing-automation/marketing-automation-domain.ts:24-85`; a Lead is addressable as a
  `TargetListEntry` member (`memberType`/`memberId`, `marketing-audience.service.ts:268,299-313`).
- **Engagement truth is table-read, not event-driven.** `marketing_events` (migration
  `042_phase19_marketing_send_delivery.sql:25-53`) carries `normalized_type`
  (`delivered`, `soft_bounce`, `hard_bounce`, `complaint`, `unsubscribed`, `opened`, `clicked`,
  `rejected`, `deferred`, `provider_error`), `occurred_at`, `campaign_id`, `send_id`, `recipient_entity_type`,
  `recipient_entity_id`, `email_hash`, `url`. Attribution conversions also land there
  (`marketing-integration.service.ts:48-61`). MA publishes only
  `marketingAutomation.campaign.*` / `send.*` / `consent.changed` / `template.revisionSealed`
  (`marketing-automation-events.ts:24-35`, `marketing-send.service.ts:427-1491`) — **no open/click
  event**. Therefore LS.9 reads `marketing_events` with a bounded, indexed query; it must not invent
  an event subscription.
- Consent/suppression: `MarketingConsent` keyed by normalized `emailHash` × channel × purpose with its
  own status machine (`domain.ts:720-793`); suppression scopes Global/Channel/Purpose/TargetList
  (`domain.ts:795`); hard bounce/complaint/unsubscribe auto-suppress
  (`marketing-event-ingestion.service.ts:258-277`). Governance: LS may use `unsubscribed`/
  `hard_bounce`/`complaint` only as an explicit negative/band rule with its own reason code; it must
  never use consent *exercise* as a proxy for a protected attribute, and must not copy consent to a
  converted Contact.
- If MA is absent or disabled, scoring still works — detection is the metadata-marker pattern
  (`customer-success-module.ts:27-33`), not an import.

### 7.2 Sales

No Opportunity ownership, no events (§1.1). LS consumes Opportunity as a core entity only, and must
not add stage semantics; `SalesDocumentService.createFromOpportunity` remains the Sales-side path.

### 7.3 AIAgents

`AIAgentRunsService.create(agentId, {input:{text?|record:{entity,id}}, idempotencyKey?, trigger?})`
then `execute(runId)` (`apps/api/src/ai-agents/ai-agent-runs.service.ts:374,786`), HTTP
`POST /api/v1/AIAgents/action/agents/:id/runs` (`ai-agents.controller.ts:77`). Non-manual triggers are
rejected outright (`ai-agent-runs.service.ts:416-421`, "Only manual runs are implemented in this
release"), so an automatic per-Lead AI insight is **not available today**. Governance that LS.17 must
respect: kill switch/pause, concurrency, quota pre-check and locked re-check (:375,417-453), per-run
step/model/token/cost budgets (:1062-1148), output validated against a captured JSON Schema
(:1267-1268), durable audit in `ai_agent_runs` / `ai_agent_run_events` (migration
`045_phase19_ai_agents.sql:137-344`). LS.17 therefore ships as an operator-clicked "explain fit"
action reading an already-audited run, separate from the numeric score, off by default.

### 7.4 Cross-module precedent to follow

HTTP action route + `x-worker-secret` for worker-driven work
(`marketing-automation.controller.ts:805-809` + `marketing-handlers.ts:24-29`), outbox → workflow
consumer (`workflow-handlers.ts:40-67`), direct import of `EntityCrudService` for ACL-preserving
reads (`crm-chat-cross-module.service.ts:5-6`), and a server-gated record entry card
(`esignature-record-entry.service.ts` + `ESignatureRecordActions.tsx:25-27`). LS uses exactly these;
it adds no new integration mechanism.

---

## 8. Migration, script and test-safety audit

- `database/migrate.ts:16-32` creates `schema_migrations(name, applied_at)`, skips
  already-applied names (`:24`) and applies sorted `.sql` files per-file in a transaction (`:31`). Naming `NNN_phaseXX_topic.sql`; the three highest are
  `070_phase19_esignature_api_key_credential.sql`, `071_phase20_retire_inert_preferences.sql`,
  `072_two_factor_authentication.sql` → **LS takes `073`**.
- Root `package.json`: `db:migrate` = `tsx database/migrate.ts`, `db:seed` = `tsx database/seed.ts`,
  `test` = `vitest run`, `test:e2e` = `bash scripts/e2e-smoke.sh`. No test-db provisioning anywhere.
- `database/seed.ts:128` runs migrations first; the seed is idempotent by design (`:29` comment,
  `ON CONFLICT DO NOTHING`).
- **Known destructive-to-metadata side effect (pre-existing, not introduced by LS):**
  `seed.ts:458-463` `INSERT INTO metadata_entries … ON CONFLICT (scope,name) DO UPDATE SET
  data = EXCLUDED.data` and `:466-469` `INSERT INTO app_settings (name,data) VALUES ('entity',$1)
  ON CONFLICT (name) DO UPDATE SET data = EXCLUDED.data`. Every boot/test run overwrites entity
  metadata and the `entity` settings document with `seed-metadata.ts` content, so runtime admin
  overrides in those scopes are lost. Recorded in
  `…/memory/project-test-harness-side-effects` and `docs/compatibility/lead-score.md`. Because LS
  keeps its own settings in a **separate `leadScore` row**, its configuration survives; its *field
  definitions* must live in `seed-metadata.ts` (not an admin patch) or they vanish on the next seed.
- Also pre-existing: `seed.ts:136,140` roles `DO UPDATE SET permissions`, `:312-318` admin user row
  refresh (password only with `options.resetAdminPassword`).
- No `TRUNCATE`/`DROP`/`reset` in any script, test setup or teardown; the only destructive-looking
  words are migration comments asserting the opposite (e.g. `021_phase19_sales.sql:10`). Test cleanup
  is row-scoped (`boot-api.ts:82-90`). `apps/api/test/helper.ts:21-29` states "No database is created,
  reset or truncated".
- `.env`/`.env.example` and `database/env.ts` target the single configured dev database
  (`carocrm_dev` on `127.0.0.1:5432`); `docker-compose.yml` runs `postgres:17-alpine` +
  `redis:7-alpine` for that one database. LS adds none of these and provisions nothing.

**LS test policy:** pure unit tests for evaluator/validator/mapping/state machine (no DB);
targeted API/integration tests against the configured primary database using `AGENT_TEST_`-prefixed
Lead/Contact/Account/Opportunity records with unique values, cleaned by exact id in `afterAll`; no
external sends (conversion never emails; MA/AI adapters are faked).

---

## 9. Key design decisions (§19 of the plan)

| # | Question | Decision |
| --- | --- | --- |
| D1 | Canonical Lead status; does `Converted` exist? | Reuse the existing enum value `'Converted'` (`seed-metadata.ts:252`); do **not** add or rename statuses. `Dead` is the explicit disqualification signal for a `setBand` rule |
| D2 | Existing conversion API/service/relationships? | **None.** `LeadScore` becomes the canonical conversion owner; no second Lead/Contact/Account/Opportunity implementation, and the generic entity API is used for the writes |
| D3 | Target links as fields or relationships? | Explicit link fields on Lead (`convertedAccountId`/`convertedContactId`/`convertedOpportunityId`/`conversionOperationId`), matching the `Contact.accountId` / `Opportunity.accountId` convention, plus a `converted` detail panel. Polymorphic "Converted To" is not needed and would break metadata typing |
| D4 | Are Accounts enabled / B2C behavior? | No B2B/B2C mode exists in the repo (negative finding). LS does **not** invent a global mode; it exposes `conversion.targets` in its own settings row, defaulting to Contact+Account+Opportunity. Documented as an intentional deviation from the EspoCRM baseline |
| D5 | Does Opportunity exist and support conversion? | Yes, core entity (`seed-metadata.ts:267-301`) — Opportunity conversion is **in scope** for LS.16, created through `EntityCrudService` with only `name` required; no Sales semantics duplicated |
| D6 | Required target fields / safe default mappings | Contact `name`+`lastName`; Account `name`; Opportunity `name` (`entity-manager/index.ts:233-237`). Safe map in §6.3; Lead has no `website`, so Account `website` is unmappable at MVP; Contact has no `industry`, so Lead `industry` maps to Account only |
| D7 | Exact vs fuzzy policy; unique constraints | Exact = normalized email, normalized phone (new bounded normalizer), Account domain; fuzzy = suggestion only, never auto-link. **No new unique index on email/phone** — legitimate shared values exist and no current data supports uniqueness. Only score-projection and operation-key partial unique indexes are added |
| D8 | Existing rules/scoring engine safe to reuse? | The formula engine is sandboxed but **executable and write-capable** (`record-logic.service.ts`); LS reuses the *declarative criteria shape* (`dynamic-logic/index.ts:9-54`) and builds its own non-executable evaluator. No raw formula string is accepted as a score rule |
| D9 | Score history / audit / jobs / outbox infrastructure | All exist and are reused (§1, §5.3): append-only metadata entity template `seed-metadata.ts:3060-3097`, audit `audit-hooks.ts`, outbox `event-bus.ts:25`, jobs `jobs.service.ts:52` |
| D10 | Which MA data may be consumed | Table reads of `marketing_events` / `marketing_recipient_deliveries` / audience snapshots keyed by recipient entity id, and consent/suppression as an explicit negative signal only. No MA event exists for open/click, so none is subscribed |
| D11 | Which related data stays on the Lead | Everything: `Email.leads` links, `Case.leadId`, `MarketingConsent.leadId`, notes, stream items, campaign attribution all remain attached to the Lead. Linking history to targets is an explicit, authorized, per-record action in LS.15 — never a bulk copy; attachments are never duplicated |
| D12 | Already-converted / partial-failure / correction | Same `operationKey` → prior result (200); different key on a converted Lead → `409 LEAD_ALREADY_CONVERTED`; a failed transaction leaves nothing committed (shared tx) and records `failed_retryable`; recovery view + admin retry in LS.18. Correction/reopen is a separate admin procedure, explicitly **not** auto-reversal |
| D13 | Feature flags and rollout | `LeadScore` module descriptor + `leadScore.enabled`, `scoring.enabled`, `conversion.enabled` and `aiInsight.enabled` (default off) settings paths, staged per plan §15.2; disabling the module must leave Lead CRUD and the core entities untouched |

---

## 10. Gaps and risks to carry forward

| # | Finding | Handling |
| --- | --- | --- |
| G1 | Lead has no `website`/company-size/region fields, so most *fit* signals are unrepresentable at MVP | LS.3 previews fit rules only over the audited Lead fields; LS.18 documents which ICP fields an install would add via Entity Manager (metadata-only, `AGENTS.MD` §5.2) |
| G2 | Activities (Task/Call/Meeting) cannot reference a Lead (`seed-metadata.ts:50-55`) | Engagement from activities is **deferred**; adding a `leads` manyMany to core activities is a cross-module metadata change that needs its own approval, and is recorded as an unresolved item rather than done silently |
| G3 | ~~No phone normalizer and no E.164 support anywhere~~ **superseded by 19-LS.10** — `voice-communications/phone-number.ts` (`normalizePhone`, `phoneMatchKeys`, `PHONE_NORMALIZER`) and `libphonenumber-js` both exist | LS.11 reuses that seam on `phoneMatchKeys` (international **and** national digit forms) and still claims no E.164 accuracy, because a Lead carries no country to default a national-form number against; the region caveat and the accepted collision cost are written in `docs/implementation/lead-score-conversion-contract.md` §1.4, §9.1 |
| G4 | `seed.ts:458-469` overwrites metadata on every seed | LS keeps all field definitions in `seed-metadata.ts` and its settings in its own `leadScore` row; documented in the compatibility file |
| G5 | MA/AI/Sales availability changes under us; `sales.opportunity.stageChanged` is declared but never emitted | LS consumes only what the code emits (generic `entity.*`); the journey-trigger whitelist is not treated as a contract |
| G6 | MarketingAutomation open/click rows are keyed partly by `email_hash` and partly by recipient entity id | **resolved in LS.9 against the suggestion**: the read uses `recipient_entity_type/id` only and *deliberately has no email fallback* — an address is shared by Contact/Account/Lead, so falling back to it would attribute another record's engagement to this Lead. A Lead with no recipient rows is a definite zero, recorded as the `no_events` state |
| G7 | Score fields on a core entity could be abused as a covert export path (plan §9.2) | `scoreReasonCodes` are opaque stable codes, not field values; list filtering is bounded by the query-engine max offset and Lead ACL; no raw rule data is ever serialized |
| G8 | Broad Lead rebuild is expensive | Batch jobs are chunked with checkpoints and admin-only; no synchronous scoring on list reads; `scheduled_jobs` sweep is bounded |
| G9 | **Found in LS.10:** the correction/reopen workflow plan §7.6 requires has no owning sub-phase in §16, and LS.2 made `convertedAt`/`converted*Id`/`conversionOperationId` server-owned for *every* caller — so today an administrator has no path at all to fix a wrong conversion reference | Policy is decided in `docs/implementation/lead-score-conversion-contract.md` §11.4 (a correction is a new operation row; it may re-point or clear one reference; it never deletes a target or un-converts a Lead). The mechanism needs a plan owner before LS.13's exit criterion can be met — LS.10 records it rather than absorbing it silently into LS.13's transaction |
| G10 | **Found in LS.10:** plan §9.4's per-action abuse bound has no kernel primitive — the only limiter is the global HTTP one (`apps/api/src/config.ts`, `bootstrap.ts`, `RATE_LIMIT_MAX`), and the LeadScore module contains no rate-limit call at all | LS.11–LS.13 bound by *shape* instead: hard per-stage candidate caps, a preview of exactly one Lead, and an in-flight operation whose own `processing` row is the retry mutex (contract §12.3). Whether a per-user action budget is worth adding is LS.18's rollout decision, not something LS.10 invents |

---

## 11. Sub-phase plan (what LS.1 → LS.18 will do here)

Each phase stays scoped to one commit, ends with a completion report
`docs/implementation/lead-score-lsN-completion-report.md`, and is verified against the configured
database only when it touches data.

| Phase | Scope in this repository | Main files | Verification |
| --- | --- | --- | --- |
| LS.1 ✅ **delivered 2026-10-24** | `apps/api/src/lead-score/` module dir + barrel, `LEADSCORE_CONTROLLERS/PROVIDERS` spread before `app.module.ts:160/:212`, descriptor + `leadScore` settings row + 14 capability→ACL resources + 11-operation feature gate + health view. **Deviation from this plan row:** no nav entry and no `leadscore.json` catalog yet — the sidebar would point at an SPA route that only LS.7/LS.8 create, and the catalog's two real consumers at this phase are the module's error codes, which went into `i18n/*/errors.json` | `apps/api/src/lead-score/*`, `app.module.ts`, `i18n/{en,vi}/errors.json`, `docs/implementation/lead-score-ls1-completion-report.md` | 15 LS tests + 109 adjacent tests green, typecheck and lint clean, Lead CRUD proven unchanged |
| LS.2 ✅ **delivered 2026-10-24** | 4 metadata entities + 16 Lead score/conversion attributes + the `score`/`converted` detail panels + declarative indexes; `073_phase19_lead_score.sql` (15 partial indexes, 3 unique, all enforced by test); `lead-score-write-guard.service.ts` + `lead-score-internal.ts` marker; `lead-score-vocabulary.ts` | `database/seed-metadata.ts`, `database/migrations/073_*`, `apps/api/src/lead-score/*` | migration reviewed pre-apply; schema read-back; existing Leads untouched; direct user write to `scoreValue`/`converted*` rejected |
| LS.3 ✅ **delivered 2026-10-24** | `lead-score-condition.ts` (declarative tree only, platform `CRITERIA_OPERATORS`, per-type operator matrix, protected + scoring-output denylists, depth/predicate/node/value bounds) + `lead-score-validator.ts` (42 stable codes, errors vs warnings) + `lead-score-model.service.ts` (`validate`/`publish`/`archive`/`new-version`, all through the gate and `EntityCrudService`) + the lifecycle half of the write guard, including a **separate `beforeDelete` hook** because `EntityManager.delete` never reaches `beforeValidate` | `apps/api/src/lead-score/lead-score-{condition,validator,model.service,write-guard}.ts`, `dto/lead-score-shapes.ts`, `lead-score.controller.ts`, `i18n/{en,vi}/errors.json` | **51 LS.3 tests** (22 lifecycle + 29 pure), LS.1/LS.2 re-run green: invalid cannot publish, published cannot be written, role gates proven |
| LS.4 ✅ **delivered 2026-10-24** | `lead-score-evaluator.ts` (pure: no DB, no settings row, no clock) — three-valued condition evaluation with the platform's meaning for all 16 criteria operators, `matched`/`not_matched`/`unknown`/`skipped`/`error` rule outcomes, effect-decided sign, dimension weights as **normalized relative influence**, clamp → half-away-from-zero rounding → threshold or `setBand` resolution, coverage by rule weight, positive/negative/unknown/skipped reason codes, SHA-256 signature + inputs hash, `requiredInputFields` as the narrow projection a recalculation must fetch. **Plus the only door it opens:** `POST action/model/preview` (`lead-score-preview.service.ts`) scores a bounded ACL-owned sample and writes nothing, which is plan §15.2 stage 3. New `scoringPreview` switch; `scoring` now names **19-LS.5** because that is the phase that keeps a score | `apps/api/src/lead-score/lead-score-{evaluator,preview.service}.ts`, `dto/lead-score-shapes.ts`, `lead-score.controller.ts`, `lead-score-module.ts`, `lead-score-module-health.service.ts` | **65 pure table-driven unit tests** (reproducibility: same snapshot twice, other clock, key order, array order, whitespace, priority tie; every operator, including both readings a `bool` field admits; every missing-data shape; weights; clamp; rounding; band; every error outcome) + **12 API tests** (per-Lead scores, zero writes proved by row identity + evaluation and audit counts, record ACL, **field ACL turns a hidden signal into unknown rather than empty**, no Lead value in the answer, §9.4 bounds, gate refusal with the switch off) |
| LS.5 ✅ **delivered 2026-10-24** | Evaluation persistence + the current projection + `GET score`/`score/history` + staleness. `lead-score-records.ts` (the module's own structural reads — models, a model's whole rule set, a Lead's paged evaluations, a row by idempotency key), `lead-score-calculation.service.ts` (recalculate **one** Lead under the *active published model*, evaluation row + projection in one internal transaction, `inputsHash` watermark, one row per Lead/version/inputs), `lead-score-explanation.service.ts` (score with labeled per-rule breakdown, derived freshness with a named reason per case, paged history), 4 routes on the existing prefix, `features.scoringPreview`→ plus `scoring`/`manualRecalculation`/`scoreExplanation` flipped to delivered, `settings.scoring.activeModelId` (read by this phase), `inputsHash` on the evaluation entity, health reporting which model a score would use, `LEADSCORE_NO_ACTIVE_MODEL` + `i18n/{en,vi}/leadscore.json` | `apps/api/src/lead-score/lead-score-{records,calculation.service,explanation.service}.ts`, `lead-score-errors.ts`, `lead-score-settings.service.ts`, `lead-score-module*.ts`, `database/seed-metadata.ts`, `dto/lead-score-shapes.ts`, `i18n/{en,vi}/{errors,leadscore}.json` | **15 API tests** (projection+history written together, provenance incl. the watermark, unchanged re-run records nothing and does not move the Lead, an edit keeps the old row and reports movement, no audit rows for the score fields, a client still cannot write them, three `LEADSCORE_NO_ACTIVE_MODEL` states, record/field/capability doors, whole rule set read internally for an operator without model rights, refused history **rolls the projection back**, switches, one-Lead shape) + **12 read tests** (labels per rule, unknowns without leaking values, never-scored, reader's language, four staleness reasons, "cannot tell" for a hidden signal, paging, entity read still closed while the command works, health view) |
| LS.6 ✅ **delivered 2026-10-24** | `entity.created`/`entity.updated` Lead subscriber + the two job names + the decision service. `lead-score-recalculation.service.ts` (six decisions for a committed change, never a throw for a configuration reason; debounce from `settings.scoring.debounceSeconds`; outstanding-job collapse; chunked rebuild with cursor hand-off, per-record error codes and a cancel that ends the chain), `lead-score-authority.ts` (the documented `system`/`sysAdmin` service principal), `JobsService.enqueue(… delayMs)` passthrough to the queue's own `options.delay`, four routes (`action/recalculate-batch` behind `LeadScoreBatch`, three `@Public()` worker routes behind `x-worker-secret`), `apps/worker/src/handlers/lead-score-handlers.ts` + wiring in `apps/worker/src/app.ts`, a **new gate operation** `eventRecalculate` so the event kill switch stops jobs already queued and not only new ones, `features.eventRecalculation`/`features.batchRecalculation` flipped to delivered, stored `trigger` now distinguishes `lead_change`/`batch_rebuild`/`manual_recalculate`. **Deviation:** no `lead-score-events.ts`/`lead-score-recalculation.job.ts`/`seed.ts` scheduled row — the decision is a route in the module (so a switch change needs no worker redeploy), the job lives in the module's own service, and the decay sweep moves to LS.9 with the engagement signals it decays | `apps/api/src/lead-score/lead-score-{recalculation.service,authority}.ts`, `dto/lead-score-shapes.ts`, `lead-score.controller.ts`, `lead-score-{module,feature-gate.service,settings.service}.ts`, `apps/api/src/jobs/jobs.service.ts`, `apps/worker/src/handlers/lead-score-handlers.ts`, `apps/worker/src/app.ts` | **19 API tests** (capability refused in both directions and before any parsing, six decisions as 200s, deterministic job id + burst collapse, `changed ∩ inputs = ∅` proven from the **real outbox payload** of a score write, pending marker without row churn, job path writes the same projection with `trigger: lead_change` and `correlationId: leadScore:recalculate` and repeats as a no-op, event switch off stops an already-queued job, deleted Lead answers without queueing, chunk clamp + cursor hand-off + no successor, cancel (flag and terminal row) ends the run, per-Lead failure returns `LEADSCORE_NO_ACTIVE_MODEL` and the run continues, capability + switch doors, OpenAPI + health) + **21 worker tests** (job names, inert without a capability, route + header + payload, refusal-vs-retry classification, cancellation before the call, subscriber scope) |
| LS.7 ✅ **delivered 2026-10-25** | The Lead Score card on a Lead (`apps/web/src/components/LeadScorePanel.tsx`): stored number, band, freshness verdict + reason, coverage, movement, model version and timestamps, the rule-by-rule reason list, the paged history in a drawer with each evaluation's own breakdown, and the two actions the server authorised. `ScoreReadView.actions` is new on the API side (`gate.assess` + core `Lead:edit`), so a button appears exactly where the command would accept it. The projection enters the list through metadata (`inList`/`inFilter`), and `filterEntries` now honours an explicit `inFilter: false` and protects asked-for fields from the twelve-field cap; the list's filter panel gained a disclosure because it silently showed five controls. **Deviation from this plan row:** the generic `Score` detail panel LS.2 declared is *removed* and its nine fields become `inDetail: false` — the card is the stricter surface (no Lead value, gated by `viewScore` + record ACL) and two surfaces for one number is a defect; no `list`/`edit` layout is declared, so an administrator's arrangement stays the default | `apps/web/src/components/LeadScorePanel.tsx`, `apps/web/src/pages/{EntityDetailPage,EntityListPage}.tsx`, `apps/web/src/{state/metadata,api/client,api/types}.ts`, `apps/web/src/styles/carocrm.css`, `apps/api/src/lead-score/lead-score-explanation.service.ts`, `database/seed-metadata.ts`, `i18n/{en,vi}/{leadscore,web}.json`, `e2e/lead-score.spec.ts` | **3 Playwright tests** (columns + band pill + value from the record, the filter disclosure, the card's reason list with the rule's input value asserted **absent**, the action + history drawer, 390px with zero horizontal overflow, `:focus-visible` + Enter) + **4 API tests** on the affordance answer (admin, badge-only, right-without-`Lead:edit`, switch-off) + **1 catalog test** that resolves every key the card uses in both locales + **1 metadata placement test**; browser pass on the running app in Vietnamese |
| LS.8 ✅ **delivered 2026-10-25** | The scoring model workspace. `GET action/editor` (`lead-score-editor.ts`) is the phase's mechanism: the fields, the operators each type can answer, the value control, the parser's budgets, the vocabularies and the command limits all come from the module's own tables, so the form cannot offer what the validator would refuse — and a refused field is returned with the validator's reason code instead of being hidden. Four tabs on `/lead-score`: models (list, draft form with band rows / dimension weights / field grant pickers, rule table, validate, publish behind the server's own report, archive, new version, version diff), preview (bounded sample, distribution, per-Lead result, `writes: false`), operations (bounded rebuild + the module's job rows with cancel), settings (module switch, 16 features with requirements and pending phases, active model, debounce). **Deviation from this plan row:** no `admin/tabs/LeadScoreSettingsTab.tsx` — the module owns its screen at `/lead-score` with a settings tab, the same shape ESignature, AI Agents and Advanced Integrations use, and the sidebar entry is gated on `LeadScoreModel:read` plus the module's `enabled` switch | `apps/api/src/lead-score/lead-score-editor.ts`, `lead-score.controller.ts`, `dto/lead-score-shapes.ts`, `index.ts`, `apps/api/src/{app.module,admin-panel/navigation-defaults}.ts`, `apps/web/src/pages/LeadScorePage.tsx`, `apps/web/src/pages/lead-score/*` (9 new), `apps/web/src/api/{client,types}.ts`, `apps/web/src/styles/carocrm.css`, `i18n/{en,vi}/leadscore.json`, `e2e/lead-score-admin.spec.ts` | **14 API tests** (operators per type from real metadata, refusals with their codes, budgets imported not restated, a grant that never overrides a denylist, `modelRead` on both doors, no Lead value in the body, strict query shape) + **4 Playwright tests** (draft→validate→publish **without typing JSON**, the preview's zero-write assertion read from the record before and after, new version + diff, 390px + keyboard) + a browser pass in both locales; the audit's own check — *preview proves zero writes to `scoreValue`* — is an assertion in the spec, not a note |
| LS.9 ✅ **delivered 2026-10-25** | The score gets a second input and a voice. **Engagement read**: `lead-score-signals.ts` is the only place the module touches another module's data — a bounded, indexed window over `marketing_events` addressed to *this* Lead (`recipient_entity_type='Lead'`), one query per source rather than per rule, capped at 200 rows per plan and 20 plans per model, with absence detected by the `information_schema` + `Campaign`-marker test this audit chose (§7.1), never an MA import. **Engine**: metrics (`eventCount`/`lastEventAt`/`daysSinceLastEvent`, `clickCount`/`lastClickedAt`/`daysSinceLastClick`) and `linear`/`halfLife` decay are derived against the caller's `evaluatedAt`, so the evaluator still has no clock and LS.4's reproducibility assertion survives; the reading's state (`available`/`no_events`/`disabled`/`absent`) and each rule's `signal` block are stored on the evaluation, and the idempotency key became `(lead, model, version, inputsHash, signalsHash)` — `inputsHash` keeps its freshness meaning alone, so a decayed signal is a new evaluation and an identical re-run still absorbs. **Threshold actions**: `lead-score-threshold.service.ts` publishes `leadScore.updated.v1` (+ `leadScore.bandChanged.v1` on a real crossing), one in-app notification for the Lead's owner behind `thresholdNotifications`, and one `leadScore.thresholdAction` audit row — the notification id and audit id digested from the crossing and inserted `on conflict do nothing`, inside the score transaction, with no record body and no Lead name in the payload. **Decay sweep**: `settings.signals.decaySweep` + a `scheduled_jobs` row + the worker's `leadScore.decaySweep` → `action/work/decay-sweep`, which *is* the LS.6 chunked rebuild with `target.source='decay_sweep'` and answers `disabled`/`noDecayingRules` instead of scanning. Three gate operations (`engagementSignals`, `thresholdAction`, `decaySweep`; 16 total), both features flipped to delivered, and the editor catalog now lists each source's metrics, event types and window bounds so the rule form cannot offer what the validator refuses. **Deviations from this plan row:** (1) audit G6's email-hash fallback is *not* built — an address is shared by Contact/Account/Lead, so it would attribute somebody else's engagement; a Lead with no recipient rows is a definite zero and the state says so; (2) no Voice or Activity signal, because the audit itself found no Lead→Activity relation and no open/click event (G2) — there is no contract to read; (3) no `lead-score-signals` metadata entity — `marketing_events` is MA's table and stays MA's; (4) the sweep's evaluations store `trigger: 'batch_rebuild'` with the sweep's own attribution in `jobs.target.source`, not a new `decay_sweep` trigger; (5) Workflow is not extended: a custom domain event is not in the platform's trigger vocabulary, so the administrator's reaction point remains the `entity.updated` on Lead whose `changed` names `scoreBand` | `apps/api/src/lead-score/lead-score-{signals,threshold.service}.ts`, `lead-score-{evaluator,validator,vocabulary,calculation.service,recalculation.service,preview.service,explanation.service,editor,module-health.service,settings.service,feature-gate.service,module,controller,index}.ts`, `database/migrations/074_phase19_lead_score_signals.sql`, `database/seed.ts`, `apps/worker/src/handlers/lead-score-handlers.ts`, `apps/web/src/pages/lead-score/{RuleEditorModal,ConditionBuilder,PreviewTab,SettingsTab,shared}.tsx`, `apps/web/src/components/LeadScorePanel.tsx`, `apps/web/src/api/types.ts`, `i18n/{en,vi}/leadscore.json`, `apps/api/test/lead-score-engagement.test.ts`, `e2e/lead-score-admin.spec.ts` | **8 new API tests + 6 evaluator + 1 validator + 5 worker + 2 Playwright**, and the exit criterion is asserted rather than argued: with the signal switched off, absent, or empty the Lead-field rules still score the same number and the evaluation *names* which state it was, and one crossing leaves exactly two events, one notification and one audit row while the redelivered second call leaves nothing. The loop cannot close for a second reason now — an engagement rule's input is not a Lead field, so it can never appear in the `changed` list LS.6 proved against the real outbox payload |
| LS.10 ✅ **delivered 2026-10-25** | The conversion contract, written before any conversion behavior. `docs/implementation/lead-score-conversion-contract.md` is the artifact: the five-state operation machine with its transition table, guards and *what each committed state means to a reader*; the T1-claim / T2-work / T3-settle commit choreography with the evidence that `PostgresRecordStore` joins the caller's transaction (`entity-record.store.ts:145-155`, `tx-context.ts:22-32`) and the two prior arts that prove it (`project-clone.service.ts:66-190`, `case-merge.service.ts:100-121`); the idempotency-key scope, format and replay/refusal answer table; a row-lock-plus-version decision for the two-concurrent-attempts case; the eight-row target matrix with an ACL gate, a data gate and a settings gate per row; `conversion.targets` + `conversion.fieldMergeAllowed` + the versioned `conversion.mapping` shape as the whole B2B/B2C surface; the linking rules including **when a link is allowed to write to the target** and the re-parent triple lock; the mapping policy (`name` is derived so it is not a source; `assignedUserId`/`teams` are never copied; the type-compatibility matrix; the never-mappable classes; `skip` as the only existing-target behaviour); the `previewHash` composition with the deliberate **reader-scope** component and the `confirmationTypes` set the command must see acknowledged; the duplicate stages built on existing seams; the failure classification with a closed `failureCode` token list; the retry-accounting rule; the never-do list; the error-code table LS.12/13 must add; and the ownership map LS.11–LS.16. **Corrections it forced on this audit:** the LS.0 "no phone normalizer / no libphonenumber dependency" finding is stale (§1.1, §3.5, G3 — voice's `PHONE_NORMALIZER` and `phoneMatchKeys` are the reuse target, and the `pg_trgm` attr indexes key on field names that do not exist); `Contact.accountId` is at `seed-metadata.ts:238`, not `:219`; `previewed` is retired from `CONVERSION_STATUSES`; and two schema/permission facts make the LS.13 command impossible as seeded — the operation entity's `create:'no'` profile versus `EntityCrudService.create`'s ACL assert, and `conversionAuditRead` mapping to the entity's own `read` (which would open the generic list for rows the design keeps closed). **New gaps:** G9 (no sub-phase owns the correction workflow, though every other caller is barred from those fields), G10 (no per-action rate bound; plan §9.4 is met only by the global HTTP limiter today). **Deviation from this plan row:** the routes keep the plan's semantics under `/api/v1/LeadScore/action/conversion/*` rather than `/api/v1/leads/:leadId/convert`, because the kernel has no per-record action route (`entity.controller.ts:24-98`) and LS.5 set that precedent for `action/score/*`. | `docs/implementation/lead-score-conversion-contract.md` (new), this file §1.1/§3.5/§6/§10/§11, `docs/compatibility/lead-score.md` §2.1/§4.1-§4.3/§5.2/§7/§8, `README.md` | **No code and no schema change** — the verification is that every load-bearing claim is a citation, checked by reading the file it names and, for the three facts a citation alone would not settle, by calling the running API: a Contact create without `lastName` answers `422 VALIDATION_FAILED {lastName: "Field is required."}`; a Contact create with only `firstName`+`lastName` comes back with `name` mirrored from `lastName`; and an administrator POSTing a `LeadConversionOperation` is refused by the LS.2 guard with `{entity, operation:'create'}` (an evaluation create, by contrast, passes the ACL gate — the asymmetry that proves the profile change LS.13 needs). The existing suites were then re-run to prove the documentation moved nothing: eleven LeadScore API files **248/0**, full `npx vitest run` and the worker suite at their LS.9 totals, `npm run typecheck` clean |
| LS.11 ✅ **delivered 2026-10-25** | The duplicate resolver. `lead-duplicate-resolver.ts` scans four **exact** stages — Contact e-mail (trimmed + case-folded), Contact phone (the last nine significant digits, so `+84 912 345 678`, `0912 345 678` and `(091) 234-5678` are one number), Account domain (the host of the Lead's e-mail domain vs the host of `Account.website`, both folded by one rule mirrored in SQL and TypeScript) and Account company name (whitespace-collapsed, compared against the **`name` column**, not the attribute) — each a type-filtered predicate with a hard `LIMIT`, each row then checked with `AclApiService.canAccessRecord` and every returned value filtered through `visibleFields`. A record the caller may not read, *or* one whose display name is hidden, contributes exactly one thing: `hiddenMatches`. The answer is a decision, not an action: `requiresChoice`, `canOverride` (the `duplicateOverride` capability), `allowedDecisions` ∈ {`link`, `create_with_override`, `cancel`}, and a `stages` array naming why a stage could not run (`no_value`, `free_mail`). New gate operation `duplicateCheck` (capability `convertPreview`, feature `duplicateDetection`, no write) and `POST action/conversion/candidates`; `features.duplicateDetection` flipped to delivered. **Deviations from this plan row and from contract §9.1/§9.4:** (1) **no similarity stage shipped** — contract §9.4 allowed this, and the reason is measured, not assumed: the `pg_trgm` attribute indexes in `008_phase12.sql:8-22` key on `'email'`/`'phone'`, which are not field names here, so a fuzzy suggestion would be a full scan, and no new index is added on a hunch (LS.18's query check owns it); (2) the phone comparison uses the **nine-digit tail** rather than `phoneMatchKeys`'s exact international/national forms, because an exact form needs a region a Lead does not carry (contract §1.4) — the tail is what survives a trunk zero and a `+84` spelling, and a cross-country collision can only produce a candidate, never a link; (3) "verified identifiers" have no field to read in this schema, so the stage plan §7.3 listed third does not exist and is not faked. **Two traps this phase hit that the schema already knew:** `name` is a *physical column* (a label read from `attrs` was `null`, which silently dropped every candidate — caught by the organization test), and a JS template literal turns `'\s+'` into `'s+'`, so the SQL fold expression was replacing the letter *s* with a space until it used `'[[:space:]]+'`. **Also fixed:** `implementedPhases` in the module descriptor still stopped at LS.6 while LS.7–LS.10 had shipped — the health view repeated the lie | `apps/api/src/lead-score/lead-duplicate-resolver.ts` (new), `lead-score-vocabulary.ts` (`domainOf`, `FREE_MAIL_DOMAINS`, `normalizedEmail`, `normalizedName`, `phoneMatchTail`, the candidate/scan caps), `lead-score-feature-gate.service.ts` (operation 17), `lead-score-module.ts` (feature flipped, `implementedPhases` corrected), `lead-score.controller.ts`, `dto/lead-score-shapes.ts`, `index.ts`, `apps/api/test/lead-score-duplicates.test.ts` (new), `apps/api/test/lead-score-module.test.ts` (four retargeted assertions) | **15 new tests** (4 pure: e-mail/phone/domain/name keys; 11 API: exact e-mail with the Lead's `version`, `modifiedAt` and the `audit_log` count unmoved; phone across three spellings; organization by company *and* by domain; free-mail never an organization; stage reporting; the cap with `bounded`; a record-ACL-hidden candidate counted not named and the payload asserted not to contain its id or name; field-hidden values masked and an unnameable candidate withheld; the capability door (`403 {capability:'convertPreview'}`); the feature door (switch off → `LEADSCORE_MODULE_DISABLED` naming `duplicateDetection`, and back on); a Lead the caller may not read → **404**, not an empty list). The exit criterion is the first test: the resolver's answer cannot write, and every match it cannot show is a number |
| LS.12 ✅ **delivered 2026-10-25** | The field map and the side-effect-free preview, decided as configuration that writes records and therefore validated twice. **`lead-field-mapping.service.ts`**: the conversion section of the settings document (`targets`, `fieldMergeAllowed`, a versioned map per target with `createDefaults`) plus its *semantic* validation, which zod cannot do — source and target fields must exist in metadata, the types must be compatible under a documented matrix (`text → varchar` refused because the target would truncate, `datetime → date` because the time would vanish, `enum → enum` because there is no value map, `link` only into the same `entityKey`), and three classes are refused by policy whatever their types say: the Lead's own outcomes and system fields (`score*`, `converted*`, `status`, ids), ownership (`assignedUserId`, `teams` — a copy widens who can read the new record), and the relationship carriers plus `Contact.name` (derived by the kernel from `lastName`, `entity.service.ts:509-519`). A changed map **must raise its version** (`version_not_bumped`), because stored conversions and preview fingerprints name it. Templates (`{{lastName}} — {{company}}`) are checked for their tokens at write time and for their value at preview time. **`lead-conversion-preview.service.ts`**: `POST action/conversion/preview` runs the exact code path LS.13 will — the map, the duplicate resolver, the ACL — and writes nothing (a separate file from the map, because the map is pure policy and the preview is a command; this is a deviation from the single file this row named). Per target it answers `proposed` (with `origin`: mapped / createDefault / merge / contextual), `skipped` (a closed reason list, including `source_hidden` for a field this reader's ACL hides and `link_keeps_values` for the rule that a link applies nothing), `required` (target-required values the plan would still lack), `conflicts` (the before/after of every differing value on a linked record — what the wizard must show), `notCopied`, and `relationship` (the links the command will set, from the same request). `permission` is the server's own answer (`canExecute` + reasons), `confirmationTypes` is what the person must be shown (`simple`, `duplicates_present`, `values_will_be_skipped`, `field_merge`, `contact_reparent`), and `previewHash` is SHA-256 over the Lead revision, each target's mapping version, the explicit merges, the duplicate choice, **the mapped Lead fields this reader can see** and **the target fields they can read *and* write** — so a permission change between preview and confirm invalidates the fingerprint instead of letting LS.13 write values the actor can no longer read. Pinned `expectedLeadRevision` / `mappingVersion` that no longer match are refused with the new `409 LEADSCORE_PREVIEW_STALE` naming the component; a disabled or still-pending target is `422 LEADSCORE_TARGET_DISABLED` (`{target, state:'notEnabled'|'pending', pendingPhase}`). Both codes are in the catalog for `en`/`vi`. `features.fieldMapping` and `features.conversionPreview` flipped to delivered. **Deviations/refinements:** (1) two services instead of one (above); (2) the fingerprint also covers `fieldMergeAllowed` — a test caught that the same plan produced one hash whether or not the merge could run, which is exactly what a fingerprint must never do; (3) the contract's `acknowledged` input is **not** on the preview: a preview acknowledges nothing, and LS.13's command is where the exact set is required; (4) `opportunity_created` is declared for the contract's shape but cannot be produced until 19-LS.16 makes an Opportunity target reachable; (5) an admin UI for the map is **not** part of this phase — the settings document is the configuration surface, and the wizard (LS.14) is the consumer; (6) `Text → varchar` and `date ↔ datetime` are refused although the contract's table did not name them, in the same spirit as the one row it did | `apps/api/src/lead-score/lead-field-mapping.service.ts` (new), `lead-conversion-preview.service.ts` (new), `lead-score-settings.service.ts` (section + semantic validation), `lead-score-errors.ts` (+2 codes), `lead-score-module.ts` (two features flipped), `lead-score.controller.ts`, `dto/lead-score-shapes.ts`, `index.ts`, `i18n/{en,vi}/errors.json`, `apps/api/test/lead-score-conversion-preview.test.ts` (new), `apps/api/test/lead-score-module.test.ts` and `lead-score-schema.test.ts` (pending-feature examples retargeted to LS.13) | **22 new tests** (6 pure: default map shape, the strict section, the type matrix, per-value checks, template composition, and a fingerprint that changes with every component *including* the merge policy; 16 API: a Contact+Account create described with the Lead's `version`/`modifiedAt`, record counts, `audit_log`, `outbox_events` and `jobs` all unmoved; Account-only gets the Lead's e-mail/phone as `contextual`; a custom map that drops `lastName` yields `required: ['lastName']` and `canExecute:false`; a link proposes nothing and lists before/after conflicts; a merge is refused by policy then proposed once allowed (and the hash changes); stale revision and stale mapping are refused by name; the fingerprint moves when the Lead moves; six settings refusals (unknown source/target, incompatible type, derived `name`/ownership/relationship carrier, outcome source, version-not-bumped, unknown template token) and the accepted version bump; four malformed target requests; the feature door; a hidden Lead field becomes `source_hidden` + a blocking required value with the value absent from the payload; an unreadable link target yields `target_unreadable` without confirming it exists; duplicates appear only while that switch is on). All thirteen LeadScore files **285/0** |
| LS.13 | `convert` command: transactional create/link through `EntityCrudService`, Lead `Converted` + references + operation + outbox in one tx; idempotency; concurrency | `lead-conversion.service.ts`, `lead-conversion-audit.service.ts` | unit state machine + API: same key replay, two concurrent attempts, forced failure, permission bypass attempts |
| LS.14 | Wizard UI (antd `Steps`, ConnectionWizard precedent), Converted-To panel, Created vs Linked, timeout recovery by operation lookup | `apps/web/src/pages/leadscore/LeadConversionWizard.tsx`, mounted in `EntityDetailPage.tsx` + `AppRoutes.tsx` | browser end-to-end on a fake `AGENT_TEST_` Lead incl. a mid-flow reload |
| LS.15 | Preservation checks: Email↔Lead, notes, attachments, campaign attribution; optional authorized linking of history | verification + documented behavior | before/after counts on a seeded test Lead with an Email + note + TargetListEntry |
| LS.16 | Optional Opportunity create/link inside the same command (Sales stage semantics untouched) | LS.13 seams + wizard step | API + browser: Opportunity created with correct `accountId`/`contactIds`, Sales documents unaffected |
| LS.17 | Optional AI fit insight via `AIAgents` manual run only, separate from numeric score, off by default | `lead-score-insight.service.ts` | unit + API with a stubbed run; scoring and conversion pass with AI disabled |
| LS.18 | Reports/dashlet metrics, OpenAPI, security/ACL/perf/concurrency sweep, runbook, rollout and limits | `reports`, `docs/runbooks/lead-score-operations.md`, README module list | full LS suite, lint/typecheck/build, accessibility + perf checks, no extra DB confirmed |

---

## 12. Exit criteria evidence

- Documentation only: no source file, no migration, no metadata entry was created or modified by
  LS.0 beyond this file and `docs/compatibility/lead-score.md`.
- Every dependency named in the plan was resolved to a real file:line, or recorded as absent in §1.1
  and §10.
- No duplicate entity, service, ORM, queue, workflow engine, permission system or component library is
  proposed; §2 marks each concern Reuse/Extend/Build/Optional/Defer against existing code.
- The §19 decision list is answered in full (D1–D13).
- No database was created, reset or written to during this audit; the only runtime side effect was the
  automatic `.trail` graph refresh reported by the search tooling.
- **19-LS.10 held the same line.** Its deliverable,
  `docs/implementation/lead-score-conversion-contract.md`, decides the state machine, the combination matrix,
  the mapping policy and the recovery semantics, and its verification section is honest about the only runtime
  writes it made: three probe calls against the running API to confirm what the write path *does* rather than
  what the metadata *says*, each record removed by exact id afterwards. No source, settings or migration file
  is in that phase's diff, and the LS.11–LS.16 obligations (including the two permission/schema edits §6 lists
  as LS.13's first work) are handed forward rather than half-applied.
