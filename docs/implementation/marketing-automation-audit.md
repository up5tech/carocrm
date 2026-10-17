# Phase 19-MA.0 — Marketing Automation repository audit and feature contract

> **Plan:** `PLAN_Phase_19_Marketing_Automation.md` §4.2 (required audit deliverable), §15 Phase 19-MA.0.
> **Delivered in:** 19-MA.0. No schema, entity or code change was made by this phase — the audit's own
> rule (§4.2: "Do not add a duplicate Campaign or TargetList entity before completing this audit").
> **Method:** every claim below was read out of this checkout (file:line). Nothing is assumed from
> `PLAN.md`, from an upstream EspoCRM layout, or from a previous session's report.

---

## 1. Headline: the marketing domain does not exist yet

The plan repeatedly says "reuse the existing `Campaign`, `TargetList`, `MassEmail`, consent and opt-out
records". **None of them exist in this repository.**

| Candidate canonical record | State in this checkout | Evidence |
| --- | --- | --- |
| `Campaign` | **absent** — no metadata entry, no table, no code | `database/seed-metadata.ts` has no `Campaign` entry; repo-wide grep for `'Campaign'` in `apps/`, `packages/`, `database/`, `modules/` returns nothing |
| `TargetList` / segment / audience | **absent** | same |
| `MassEmail` | **absent** | same |
| `CampaignLog` / campaign statistics | **absent** | same |
| `EmailTemplate` | **exists** — metadata entity, 5 fields | [database/seed-metadata.ts:409-430](file:///Users/up5techjacky/Documents/projects/carocrmv2/database/seed-metadata.ts#L409-L430) |
| `Email` | **exists** — full outbound/inbound message record | [database/seed-metadata.ts:361-408](file:///Users/up5techjacky/Documents/projects/carocrmv2/database/seed-metadata.ts#L361-L408) |
| Contact/Lead/Account opt-out, `doNotEmail`, consent, unsubscribe | **absent** — no such field on any entity | Contact [seed-metadata.ts:181](file:///Users/up5techjacky/Documents/projects/carocrmv2/database/seed-metadata.ts#L181) (`emailAddress` only), Lead [:209](file:///Users/up5techjacky/Documents/projects/carocrmv2/database/seed-metadata.ts#L209), Account [:143](file:///Users/up5techjacky/Documents/projects/carocrmv2/database/seed-metadata.ts#L143) |
| Provider bounce/complaint/webhook ingestion | **absent** | only hits for `bounce` are test fixtures in [packages/mail/src/record/index.test.ts:33](file:///Users/up5techjacky/Documents/projects/carocrmv2/packages/mail/src/record/index.test.ts#L33) |
| Marketing journey / enrollment runtime | **absent** | — |

Consequence for the whole module: the entities this plan asks us to "extend" must be **created**, and the
decision of *which* names become canonical is made here, once, and is binding for MA.1–MA.19 (§2 below).
Nothing else in the platform may introduce a competing campaign or audience record.

---

## 2. Reusable capability inventory (what the module builds on, with names)

### 2.1 Entity Engine, metadata and record store

- Entity/field/relation/layout/ACL metadata is one seed array: `coreMetadata` in
  [database/seed-metadata.ts:131](file:///Users/up5techjacky/Documents/projects/carocrmv2/database/seed-metadata.ts#L131),
  validated by `EntityDefinitionSchema` ([packages/metadata/src/schemas/index.ts:149-168](file:///Users/up5techjacky/Documents/projects/carocrmv2/packages/metadata/src/schemas/index.ts#L149-L168)).
  Field types available include `varchar, text, int, float, decimal, bool, date, datetime, enum, multiEnum, currency, url, email, link, linkMultiple, manyMany(via relations), formula` ([:3-32](file:///Users/up5techjacky/Documents/projects/carocrmv2/packages/metadata/src/schemas/index.ts#L3-L32)).
- Records live in one JSONB table `entity_records` (`id, entity_type, name, attrs, assigned_user_id,
  created_by_id, modified_by_id, team_ids, created_at, modified_at, deleted_at, version`) —
  [database/migrations/001_init.sql:115-134](file:///Users/up5techjacky/Documents/projects/carocrmv2/database/migrations/001_init.sql#L115-L134).
- Load order `metadata_entries → extension packages → admin overrides (app_settings.entity)`:
  [apps/api/src/metadata/metadata-store.service.ts:40-80](file:///Users/up5techjacky/Documents/projects/carocrmv2/apps/api/src/metadata/metadata-store.service.ts#L40-L80).
- Generic CRUD/list/detail/search/import/export/audit/stream/attachments for a new entity are free:
  `ENTITY_CONTROLLERS` / `EntityCrudService` (`apps/api/src/entity/`).

**Verdict:** marketing entities are metadata entries + additive indexes. No new table is needed for any
record type the plan lists, and none may be invented for convenience.

### 2.2 ACL

- Actions are fixed: `create, read, edit, delete, stream`; levels `yes, all, team, own, no`
  ([packages/acl/src/types/index.ts:1-10](file:///Users/up5techjacky/Documents/projects/carocrmv2/packages/acl/src/types/index.ts#L1-L10),
  [packages/metadata/src/schemas/index.ts:34-36](file:///Users/up5techjacky/Documents/projects/carocrmv2/packages/metadata/src/schemas/index.ts#L34-L36)).
- Entity defaults ship inside the entity's own metadata `acl.permissions` (example: `Case` at
  [seed-metadata.ts:3482-3486](file:///Users/up5techjacky/Documents/projects/carocrmv2/database/seed-metadata.ts#L3482-L3486));
  record-level checks run through `AclApiService.canAccessRecord / assertRecordAccess`
  ([apps/api/src/acl/acl-api.service.ts:61](file:///Users/up5techjacky/Documents/projects/carocrmv2/apps/api/src/acl/acl-api.service.ts#L61)).
- Field-level permissions exist (`acl.fieldPermissions`, [:91](file:///Users/up5techjacky/Documents/projects/carocrmv2/packages/metadata/src/schemas/index.ts#L91)) and are enforced by the engine.

There is **no arbitrary-permission mechanism** — §9.1's "permission areas" (schedule/approve a send,
manage consent, configure providers) must be expressed as entity ACL plus record/field ACL plus admin
gating, which is exactly how Service Desk expressed its lifecycle commands (`CaseLifecycleService.transition`
asserts record `edit` and raises the bar for reopening a closed case —
[apps/api/src/service-desk/case-lifecycle.service.ts:155-161](file:///Users/up5techjacky/Documents/projects/carocrmv2/apps/api/src/service-desk/case-lifecycle.service.ts#L155-L161), [:274-293](file:///Users/up5techjacky/Documents/projects/carocrmv2/apps/api/src/service-desk/case-lifecycle.service.ts#L274-L293)).

### 2.3 Outbound mail: transport, accounts, queue, delivery ledger

This is the platform's provider layer and the module must use it, not rebuild it.

| Piece | Name and location | Guarantee |
| --- | --- | --- |
| Transport port | `MailTransport` — `prepare/send/verify/info`, [packages/mail/src/message/index.ts:78-96](file:///Users/up5techjacky/Documents/projects/carocrmv2/packages/mail/src/message/index.ts#L78-L96) | provider-independent; `mode: 'live' \| 'disabled'` |
| Implementations | `SmtpTransport` (nodemailer) [packages/mail/src/smtp/index.ts:226](file:///Users/up5techjacky/Documents/projects/carocrmv2/packages/mail/src/smtp/index.ts#L226); `DisabledTransport` + `MemoryTransport` [packages/mail/src/offline/index.ts:55-129](file:///Users/up5techjacky/Documents/projects/carocrmv2/packages/mail/src/offline/index.ts#L55-L129) | `memory` = the fake used by every test; **no** Mailgun/SendGrid/SES/Graph adapter exists |
| Factory / config | `createMailTransport(mode, raw)` [packages/mail/src/index.ts:92](file:///Users/up5techjacky/Documents/projects/carocrmv2/packages/mail/src/index.ts#L92); env `MAIL_TRANSPORT` ∈ `none,memory,smtp,relay`, default `none` [apps/api/src/config.ts:42](file:///Users/up5techjacky/Documents/projects/carocrmv2/apps/api/src/config.ts#L42) | a deployment with no mail config sends nothing (`none`) |
| Per-account SMTP | `email_accounts` table [007_email_accounts.sql:8-32](file:///Users/up5techjacky/Documents/projects/carocrmv2/database/migrations/007_email_accounts.sql#L8-L32) + `EmailAccountsService` (AES-256-GCM secrets, `resolveTransportConfig`, `defaultAccountId`) [apps/api/src/email/email-accounts.service.ts:92](file:///Users/up5techjacky/Documents/projects/carocrmv2/apps/api/src/email/email-accounts.service.ts#L92) | credentials never returned to clients (`hasPassword` only) |
| Queue send | `EmailService.queueSend(emailId)` [apps/api/src/email/email.service.ts:149](file:///Users/up5techjacky/Documents/projects/carocrmv2/apps/api/src/email/email.service.ts#L149) | status gate `Draft\|Failed` ([:22](file:///Users/up5techjacky/Documents/projects/carocrmv2/apps/api/src/email/email.constants.ts#L22)), renders template+signature, writes one `email_deliveries` row per recipient, enqueues job `system.sendEmail` |
| Actual delivery | `sendEmailJob` in the worker [apps/worker/src/handlers/mail-handlers.ts:227-327](file:///Users/up5techjacky/Documents/projects/carocrmv2/apps/worker/src/handlers/mail-handlers.ts#L227-L327) | nothing sends inside the API process |
| Delivery ledger | `email_deliveries` (per recipient, `status`, `transport`, `provider_message_id`, `error`, `attempts`, `sent_at`, unique `(email_id, recipient)`) [006_email_deliveries.sql:8-26](file:///Users/up5techjacky/Documents/projects/carocrmv2/database/migrations/006_email_deliveries.sql#L8-L26) | idempotent per recipient by construction |
| Retry | transient vs permanent classified by SMTP code [packages/mail/src/smtp/index.ts:207-215](file:///Users/up5techjacky/Documents/projects/carocrmv2/packages/mail/src/smtp/index.ts#L207-L215); record reset to `Queued` + rethrow so BullMQ retries; attempts default 3 with capped exponential backoff [apps/worker/src/env.ts:30](file:///Users/up5techjacky/Documents/projects/carocrmv2/apps/worker/src/env.ts#L30), [apps/worker/src/queue/job-consumer.ts:26-44](file:///Users/up5techjacky/Documents/projects/carocrmv2/apps/worker/src/queue/job-consumer.ts#L26-L44) | no dead-letter table; per-attempt trail in `job_logs` |
| Rate limit / batch | **only** a per-message recipient ceiling (`MAIL_MAX_RECIPIENTS`, default 50, max 500 [smtp/index.ts:156](file:///Users/up5techjacky/Documents/projects/carocrmv2/packages/mail/src/smtp/index.ts#L156)) | no throttle, no batch splitter — MA.9 must add them |
| Template render | `renderTemplate` / `renderTemplateParts` — `{{placeholder}}` substitution only, unknown → `''` [packages/mail/src/template/index.ts:14-32](file:///Users/up5techjacky/Documents/projects/carocrmv2/packages/mail/src/template/index.ts#L14-L32) | **not** handlebars; no conditionals; personalization today is per-`Email`-record, not per-recipient ([email.service.ts:91-98](file:///Users/up5techjacky/Documents/projects/carocrmv2/apps/api/src/email/email.service.ts#L91-L98)) |
| Inbound | `InboundMailProvider` port, bound to `NullInboundProvider` which returns `[]` [packages/mail/src/inbound/index.ts:37-50](file:///Users/up5techjacky/Documents/projects/carocrmv2/packages/mail/src/inbound/index.ts#L37-L50) | `POST /api/v1/Email/action/pollInbound` is a documented no-op — README's claim is accurate |
| Attachments | generic `attachments` table keyed `(parent_type, parent_id)` + `FileStorage` (`local`/`s3`) [packages/files/src/storage/index.ts:44-51](file:///Users/up5techjacky/Documents/projects/carocrmv2/packages/files/src/storage/index.ts#L44-L51) | an Email's files are `parent_type='Email'`; worker loads bytes at send time |

### 2.4 Jobs, scheduling, events, hooks

- `JobsService.enqueue({ job, data, id? })` writes a durable `jobs` row then publishes to BullMQ
  ([apps/api/src/jobs/jobs.service.ts:52](file:///Users/up5techjacky/Documents/projects/carocrmv2/apps/api/src/jobs/jobs.service.ts#L52));
  `JobQueuePort.enqueue` accepts `delayMs` ([job-queue.service.ts:28-40](file:///Users/up5techjacky/Documents/projects/carocrmv2/apps/api/src/jobs/job-queue.service.ts#L28-L40)).
- **Redis is mandatory.** There is no DB-poll or noop fallback: unreachable Redis → `InternalServerError`
  ([job-queue.service.ts:109-114](file:///Users/up5techjacky/Documents/projects/carocrmv2/apps/api/src/jobs/job-queue.service.ts#L109-L114)). Marketing sending therefore has a hard runtime dependency to declare honestly (§5).
- Cron rows in `scheduled_jobs`, claimed by `Scheduler` with `cron-parser` and cross-worker dedupe on
  `last_run_at` ([apps/worker/src/schedule/scheduler.ts:41-54](file:///Users/up5techjacky/Documents/projects/carocrmv2/apps/worker/src/schedule/scheduler.ts#L41-L54), [:80-183](file:///Users/up5techjacky/Documents/projects/carocrmv2/apps/worker/src/schedule/scheduler.ts#L80-L183)).
- `EventBus.dispatch/dispatchMany(tx, event)` writes the transactional outbox; event type grammar is
  `^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*){1,3}$` — **2 to 4 dot segments**
  ([apps/api/src/events/event-bus.ts:14](file:///Users/up5techjacky/Documents/projects/carocrmv2/apps/api/src/events/event-bus.ts#L14)).
- Entity write pipeline extension point: `HookRegistry.register({ name, phase, entity, handler })` with
  phases `beforeValidate … afterSave` ([apps/api/src/hooks/hook.registry.ts:6-36](file:///Users/up5techjacky/Documents/projects/carocrmv2/apps/api/src/hooks/hook.registry.ts#L6-L36), [packages/entity-engine/src/types/index.ts:105-131](file:///Users/up5techjacky/Documents/projects/carocrmv2/packages/entity-engine/src/types/index.ts#L105-L131)). Transaction-scoped side effects use `KERNEL_HOOKS_TOKEN` ([apps/api/src/entity/hooks.ts:14-27](file:///Users/up5techjacky/Documents/projects/carocrmv2/apps/api/src/entity/hooks.ts#L14-L27)).
- Module service identity: an async-local "this write is internal" marker plus a `sysAdmin`-scoped
  system principal, per module ([service-desk-internal.ts:17-25](file:///Users/up5techjacky/Documents/projects/carocrmv2/apps/api/src/service-desk/service-desk-internal.ts#L17-L25), [service-desk-authority.ts:17-31](file:///Users/up5techjacky/Documents/projects/carocrmv2/apps/api/src/service-desk/service-desk-authority.ts#L17-L31)).

### 2.5 Automation engines — what can and cannot host a journey

- `packages/workflow` definition is pure data: entity-event triggers, `action|condition|delay|end`
  nodes, sandboxed formula conditions, persistent `workflow_runs` / `workflow_run_steps`
  ([packages/workflow/src/types/index.ts:25-85](file:///Users/up5techjacky/Documents/projects/carocrmv2/packages/workflow/src/types/index.ts#L25-L85), [apps/worker/src/workflows/workflow-store.ts:45-53](file:///Users/up5techjacky/Documents/projects/carocrmv2/apps/worker/src/workflows/workflow-store.ts#L45-L53)).
  Action catalog is 5 entries: `updateRecord, createRecord, createNotification, sendEmail, runJob`
  ([packages/workflow/src/actions/index.ts:62-98](file:///Users/up5techjacky/Documents/projects/carocrmv2/packages/workflow/src/actions/index.ts#L62-L98)).
- `packages/bpm` is a token state machine with human tasks, gateways and task timers
  ([packages/bpm/src/types/index.ts:29-109](file:///Users/up5techjacky/Documents/projects/carocrmv2/packages/bpm/src/types/index.ts#L29-L109)).
- **Boundary:** a workflow run is *record-scoped, one-shot, one run per (workflow, version, record)*.
  It has no cross-contact state, no re-entry policy, no branch-by-audience, no provider side-effect
  ledger. Encoding a marketing journey in `WorkflowDefinition` would mean contorting the generic engine
  for one domain — the thing §0.1 rule 2 and §5.4 of `PLAN.md` forbid.
- **Decision:** `MarketingJourney` gets its own *runtime* (enrollment + step execution records, MA.12–MA.14)
  and reuses everything that is genuinely generic: `@carocrm/formula` for conditions, the `jobs` queue and
  `scheduled_jobs` for waits, the outbox `EventBus` for triggers, and the workflow **action catalog seam**
  (`runJob`) so a journey action can call platform automation without a second engine.

### 2.6 Expression / formula sandbox

`FormulaEngine.validate/evaluate/evaluateCondition` — allowlisted functions (~60), banned prototype keys,
node/step/depth budgets, bare identifiers always rejected
([packages/formula/src/engine/index.ts:58-129](file:///Users/up5techjacky/Documents/projects/carocrmv2/packages/formula/src/engine/index.ts#L58-L129), [src/limits/index.ts:12-20](file:///Users/up5techjacky/Documents/projects/carocrmv2/packages/formula/src/limits/index.ts#L12-L20)).
This is the allowlisted expression functionality §3.2 demands for journey conditions; nothing else may be
made executable.

### 2.7 Query and reporting

- `packages/query-engine` exposes exactly 13 operators ([src/index.ts:14-40](file:///Users/up5techjacky/Documents/projects/carocrmv2/packages/query-engine/src/index.ts#L14-L40)); a report definition is
  validated metadata, executed through `parseQueryRequest` ([apps/api/src/reports/report.service.ts:318](file:///Users/up5techjacky/Documents/projects/carocrmv2/apps/api/src/reports/report.service.ts#L318)).
  **This is the safe criteria-to-query mapping MA.4 must reuse** — a dynamic segment stores a filter tree,
  never SQL.
- Reports are kernel `ReportDefinition`s shipped in a module catalog (Sales precedent:
  [apps/api/src/sales/report/sales-report-catalog.service.ts:23-338](file:///Users/up5techjacky/Documents/projects/carocrmv2/apps/api/src/sales/report/sales-report-catalog.service.ts#L23-L338));
  dashlets the same way ([sales/dashboard/dashlet.ts:26-120](file:///Users/up5techjacky/Documents/projects/carocrmv2/apps/api/src/sales/dashboard/dashlet.ts#L26-L120)).
- `SavedFilter` is per-user data, not a shippable artifact — **a module cannot seed default list filters**;
  the shipped-catalog precedent is dashlets/reports (recorded as a §10.2 gap).

### 2.8 Other modules (optional integrations)

`Portal` (`apps/api/src/portal/`, marker `Portal`), `Sales` (`Opportunity`, documents), `CustomerSuccess`
(profiles/goals), `ServiceDesk` (`Case`), `knowledge-base` (`KnowledgeArticle`), `ExtensionHost` +
`webhook-integration` (outbound delivery only — see §4.4), `packages/document` (render), `packages/search`.
Existing modules detect each other through a **metadata marker entity**, never an import
([service-desk-module.ts:128-165](file:///Users/up5techjacky/Documents/projects/carocrmv2/apps/api/src/service-desk/service-desk-module.ts#L128-L165)) — MarketingAutomation follows that.

### 2.9 Frontend

- SPA: Vite + React + Ant Design. Entity list/detail/edit views render from metadata automatically
  (`/:entity`, `/:entity/:id` in [apps/web/src/AppRoutes.tsx:116-120](file:///Users/up5techjacky/Documents/projects/carocrmv2/apps/web/src/AppRoutes.tsx#L116-L120));
  navigation membership is `isEntity && client.web !== false` ([apps/web/src/state/metadata.ts:172-178](file:///Users/up5techjacky/Documents/projects/carocrmv2/apps/web/src/state/metadata.ts#L172-L178)).
- A module's nav submenu = a hardcoded group in `AppShell` plus a server visibility probe
  (`GET /Sales/action/nav`, [apps/web/src/components/AppShell.tsx:106-122](file:///Users/up5techjacky/Documents/projects/carocrmv2/apps/web/src/components/AppShell.tsx#L106-L122), [:426-433](file:///Users/up5techjacky/Documents/projects/carocrmv2/apps/web/src/components/AppShell.tsx#L426-L433)).
- **Record action buttons are not metadata-driven**: `EntityDetailPage` hardcodes
  `entity === 'Case' ? <CaseLifecycleActions/>` ([apps/web/src/pages/EntityDetailPage.tsx:292](file:///Users/up5techjacky/Documents/projects/carocrmv2/apps/web/src/pages/EntityDetailPage.tsx#L292));
  the button set itself comes from a **server capabilities** response ([apps/web/src/components/CaseLifecycleActions.tsx:33-67](file:///Users/up5techjacky/Documents/projects/carocrmv2/apps/web/src/components/CaseLifecycleActions.tsx#L33-L67)).
  Marketing follows this exact shape — the server decides, the SPA renders, hiding a control is never authorization.
- i18n catalogs are auto-discovered by file name = namespace, `en` and `vi` mirrored
  ([apps/api/src/i18n/i18n.service.ts:62-96](file:///Users/up5techjacky/Documents/projects/carocrmv2/apps/api/src/i18n/i18n.service.ts#L62-L96)).

---

## 3. Canonical ownership decisions (binding for MA.1–MA.19)

One owner per concern. A later sub-phase may not introduce a competing record for the same fact.

| Concern | Canonical record | Owner service (module-internal) | Decision |
| --- | --- | --- | --- |
| Strategic campaign, its schedule, status, budget, objective | **`Campaign`** (new metadata entity, singular name, no `Marketing` prefix) | `MarketingCampaignService` | §5.1 asks for "the existing Campaign entity, extended". Since none exists, the canonical name is the plain `Campaign`, matching how the repo took the plain `Case` for Service Desk (§0.2 rule, `service-desk-module.ts:10-13`). `MarketingCampaign` would be a second name for one concept. |
| Audience definition (static/dynamic, include/exclude) | **`TargetList`** (new) | `MarketingAudienceService` | EspoCRM's documented audience record is the target list; §0.2 says reuse `TargetList` where the contract suits. It is an audience *definition*, never a recipient list. |
| Static audience membership | **`TargetListEntry`** (new, `oneToMany` rows) | `MarketingAudienceService` | Needed because `entity_records` cannot express a `(targetListId, entityType, entityId)` unique membership. |
| Send definition (one message within a campaign) | **`MarketingSend`** (new) | `MarketingSendService` (MA.8) | Campaign fields must not be overloaded (§5.5). |
| Immutable message content revision | **`MarketingTemplateRevision`** (new wrapper) | `MarketingTemplateService` (MA.6) | `EmailTemplate` has **no** revision/version field ([:411-429](file:///Users/up5techjacky/Documents/projects/carocrmv2/database/seed-metadata.ts#L411-L429)); §6.2 says wrap it rather than fork the renderer. |
| Email body / template authoring | **`EmailTemplate`** (existing, unchanged) | platform `email` module | Not duplicated. Marketing references it and snapshots it. |
| Consent state per address × channel × purpose | **`MarketingConsent`** (new) | `MarketingConsentService` (MA.5) | Nothing exists today to extend (§1). |
| Consent history | **`MarketingConsentEvent`** (new, append-only) | `MarketingConsentService` | §5.3 invariant 9. |
| Suppression / opt-out tombstone | **`MarketingSuppression`** (new) | `MarketingEligibilityService` (MA.5) | §5.3; global scope beats segment membership. |
| Actual outbound message | **`Email`** (existing, unchanged) | platform `email` module | A marketing send produces `Email` records; `email_deliveries` stays the transport ledger. |
| Recipient-level marketing delivery state | **`MarketingRecipientDelivery`** (new) | `MarketingSendService` (MA.8–MA.9) | `email_deliveries` is per-`Email`/recipient of transport, not per send-definition/campaign/eligibility decision; §6.5 asks for eligibility reasons and idempotency keys that transport rows cannot hold. |
| Engagement events | **`MarketingEvent`** (new, append-only) | `MarketingEventIngestionService` (MA.10) | No existing analytics event store (§1). |
| Inbound provider webhook envelope | **`MarketingProviderWebhookInbox`** (new, narrow) | `MarketingEventIngestionService` | `webhook-integration` is **outbound-only** (§4.4): it signs what it sends and never verifies or receives. |
| Journey definition / published graph | **`MarketingJourney`** + **`MarketingJourneyVersion`** (new) | `MarketingJourneyDefinitionService` (MA.12) | Own runtime, §2.5. |
| Journey runtime state | **`MarketingJourneyEnrollment`** + **`MarketingJourneyStepExecution`** (new) | `MarketingJourneyRuntimeService` (MA.13) | |
| Campaign operations/engagement log | **`CampaignLog`** (new) | `MarketingCampaignLogService` (MA.11) | Deferred to MA.11 with the statistics; MA.3 uses kernel audit for lifecycle history. |
| Public capture form | **`MarketingForm`** + **`MarketingFormSubmission`** (new) | (MA.15) | No form subsystem exists. |

Module boundary: **`MarketingAutomation`** (no `Ua` prefix, §0.1 rule 1), kernel directory
`apps/api/src/marketing-automation/`, settings row `marketingAutomation`, API prefix `/api/v1/MarketingAutomation`,
`loadOrder: 380` (after Service Desk `360`).

---

## 4. Missing infrastructure and blockers

These are the high-risk decisions §4.2 asks to record.

### 4.1 No consent substrate at all

There is no opt-out, no do-not-mail, no preference, no suppression record, and no unsubscribe header
handling anywhere. §5.3 calls consent "a core domain requirement, not a future enhancement", and §0.1
rule 8 makes it a non-bypassable server gate.

**Consequence and decision:** MA.5 (consent/suppression/unsubscribe) is a **hard prerequisite of MA.8–MA.9**
(anything that queues or sends). No send path may be released before the eligibility gate exists. Between
MA.3 and MA.5 a campaign can therefore be created, validated, scheduled *and refused*: the campaign
validation report (§5.1 "Prevent a campaign from becoming Scheduled/Running unless … consent policy …
pass") treats "no consent policy is configured because the consent subsystem is not delivered yet" as a
**blocking finding**, and the delivered sub-phases say so rather than letting a send through.

### 4.2 No provider feedback loop

No inbound webhook receiver, no bounce/complaint ingestion, no `List-Unsubscribe` handling. Delivery truth
stops at SMTP acceptance (`email_deliveries.status`).

**Consequence:** MA.10 introduces the receiver. Until then, §1.1 item 9's "when supplied by the chosen
provider" is unsatisfiable and engagement numbers must not be presented as provider-verified. The fake
provider contract defined in MA.2 (§6) is what MA.7/MA.10 test against.

### 4.3 Per-recipient personalization does not exist

`EmailService.renderContent` renders **once per Email record** at queue time, from the Email's own fields
([email.service.ts:247-277](file:///Users/up5techjacky/Documents/projects/carocrmv2/apps/api/src/email/email.service.ts#L247-L277)). A campaign that addresses 500 contacts needs per-recipient variables and a
rendered-content snapshot per recipient (§5.4, §6.2).

**Consequence:** MA.6/MA.8 must add a recipient-context renderer inside the marketing module that feeds
`EmailService`/the worker a already-personalized `Email` (or, at MA.9, renders in the worker at send
time). The field context must be allowlisted and ACL-checked — never unrestricted entity hydration (§5.4).
Recorded as a design risk: rendering per recipient multiplies `Email` records; bounded chunks (§5.5) are the mitigation.

### 4.4 `webhook-integration` is outbound-only

`signBody` produces an HMAC for what it sends; there is no verification path, no inbound route, no inbox
table ([modules/webhook-integration/src/delivery.ts:52-97](file:///Users/up5techjacky/Documents/projects/carocrmv2/modules/webhook-integration/src/delivery.ts#L52-L97), [src/shared.ts:169-171](file:///Users/up5techjacky/Documents/projects/carocrmv2/modules/webhook-integration/src/shared.ts#L169-L171), [src/endpoint.controller.ts:16-61](file:///Users/up5techjacky/Documents/projects/carocrmv2/modules/webhook-integration/src/endpoint.controller.ts#L16-L61)).

**Decision:** a narrow marketing-owned inbox (`MarketingProviderWebhookInbox`), signature verified with a
constant-time compare (precedent: `assertWorkerSecret`, [service-desk.controller.ts:389-399](file:///Users/up5techjacky/Documents/projects/carocrmv2/apps/api/src/service-desk/service-desk.controller.ts#L389-L399)), and the SSRF/url-guard helpers reused. Not a general inbound webhook platform — that is out of scope (§3.2).

### 4.5 No HTML sanitizer

`Email.bodyHtml` and `EmailTemplate.bodyHtml` are passed through raw; no sanitizer dependency exists
anywhere (§5.4 and §9.4 both require sanitization).

**Decision:** MA.6 adds one narrow, allowlist-based sanitizer used by the marketing render path, and any
campaign content write goes through it. Recorded as a **blocking security prerequisite for any send of
non-admin-authored HTML**. Adding a dependency requires a `package.json`/lockfile check first (AGENTS.md §2).

### 4.6 Queue and Redis are mandatory for sending

`JobQueueService.enqueue` throws when Redis is unreachable; the worker hard-requires `REDIS_URL`
(§2.4). So "campaign scheduled" is not "message will go out" unless the queue is up.

**Decision:** MarketingAutomation declares `jobs` and `mail` as **required capabilities** in its descriptor
with evidence, and the health endpoint reports them, so an operator sees a red dependency instead of a
silently stalled campaign. Durable `jobs` rows + `MarketingRecipientDelivery` state make recovery possible
without duplicate sends (§0.1 rule 10).

### 4.7 No batching/throttling layer

Only a per-message recipient ceiling exists (§2.3). §5.5/§11 forbid one job per recipient and require
bounded chunks and provider limits.

**Decision:** MA.9 owns this (chunker + token-bucket throttle + dead-letter state on the delivery row).
Nothing before MA.9 may create per-recipient jobs.

### 4.8 Open questions for the product owner

1. Which provider is first-class for this deployment? It decides MA.7 (adapter) and MA.10 (event vocabulary,
   signature scheme, whether click/open tracking is provider-side or ours). Today only SMTP exists.
2. Jurisdictions and channels in scope for launch: is `unknown consent` block or allow (§5.3 invariant 5
   demands an explicit answer)? The MA.2 decision matrix needs the configured default.
3. Double opt-in: required by policy, or optional per purpose? (MA.5 token flow differs materially.)
4. Are Accounts or non-email channels ever recipients? If yes, MA.4 needs the compatibility contract §5.2
   mentions; if not, recipients stay Contact/Lead only and the resolver is simpler.
5. Retention periods for rendered content, provider payloads and event details (§6.8, §9.3) — privacy review
   is a human/organizational task, not something this module can decide.
6. Whether engagement tracking is on by default per deployment (§9.3: "do not assume tracking is permitted").
7. Do marketing persons need Portal self-service preferences (MA.16), and if so, is a portal contact always
   resolvable for a marketing recipient?

---

## 5. Module dependency declaration (what MA.1 will encode)

**Required platform capabilities** — each proven by an evidence fact, per the descriptor convention:

| id | evidence |
| --- | --- |
| `entity-engine` | entity `Campaign`, table `entity_records`, `metadata_entries` |
| `crm-core-records` | entities `Contact`, `Lead`, `Account`, `User` |
| `email-outbound` | entity `Email`, `EmailTemplate`; table `email_deliveries`; `MailTransport` bound via `MAIL_TRANSPORT` |
| `jobs` | table `jobs`, `scheduled_jobs`; `JobsService` |
| `domain-events` | table `outbox_events`; `EventBus` |
| `acl` | entity `Role`, `AclApiService` |
| `hooks` | hook phase `beforeValidate`, registered `marketingAutomation.campaignWriteGuard` |
| `audit-stream` | tables `audit_records`/`stream`... (evidence read from schema) |
| `settings` | `app_settings` row `marketingAutomation` |
| `query-engine` | used by dynamic segments (MA.4) — declared when MA.4 lands, not before (§MA.1: "dependency metadata only for actual required capabilities") |

**Optional integrations** (marker entity detection; module must load with any of them absent, §4.3):
`portal` → `Portal`; `sales` → `Opportunity`; `customer-success` → `CustomerSuccessProfile`;
`service-desk` → `Case`; `knowledge-base` → `KnowledgeArticle`; `workflow` → `Workflow`;
`documents` → `DocumentTemplate`.

**Feature flags** (all default **off**, one dotted path each inside the `marketingAutomation` row):
`campaigns` (MA.3), `segments` (MA.4), `consent` (MA.5), `templates` (MA.6), `provider` (MA.7),
`sending` (MA.8), `deliveryQueue` (MA.9), `providerEvents` (MA.10), `analytics` (MA.11),
`journeys` (MA.12–MA.14), `forms` (MA.15), `attribution` (MA.17).

---

## 6. Proposed API and event contracts (forward-declared, not implemented by MA.0)

Resources come free from the Entity Engine for each entity in §3 (`/api/v1/Campaign`, `/api/v1/TargetList`,
`/api/v1/MarketingSend`, …). Domain commands live under the module prefix, matching the
`/api/v1/<Module>/action/...` convention:

| Sub-phase | Endpoint | Purpose |
| --- | --- | --- |
| MA.1 | `GET /api/v1/MarketingAutomation/action/health` | descriptor + evidenced capabilities + integrations + checks (admin) |
| MA.1 | `GET/POST /api/v1/MarketingAutomation/action/settings` | validated settings document + version + warnings (write admin-only) |
| MA.1 | `GET /api/v1/MarketingAutomation/action/nav` | ACL-scoped visibility for the SPA submenu |
| MA.3 | `POST …/action/campaign/:id/validate` | validation report: blocking findings + warnings |
| MA.3 | `GET …/action/campaign/:id/capabilities` | allowed lifecycle commands for this actor and state |
| MA.3 | `POST …/action/campaign/:id/{schedule,start,pause,resume,cancel,complete,archive}` | one named command each, never a bare `status` write |
| MA.3 | `POST …/action/campaign/:id/duplicateAsDraft` | config only — no history, no recipients, no provider ids |
| MA.4 | `POST …/action/segment/:id/preview`, `…/campaign/:id/previewAudience` | counts + explainable eligibility, ACL-safe |
| MA.5 | `POST …/action/suppression/:emailHash/check`, public `GET/POST /public/marketing/unsubscribe/:token` | eligibility + public opt-out |
| MA.6 | `POST …/action/send/:id/preview`, `…/campaign/:id/sendTest` | render preview, explicit test destination |
| MA.8 | `POST …/action/send/:id/{validate,schedule,cancel}`, `…/send/:id/dryRun` | snapshot + eligibility forecast |
| MA.9 | `POST …/action/send/:id/pause`, worker twin `POST …/action/delivery/run-scheduled-batch` | bounded chunk execution |
| MA.10 | `POST /webhooks/marketing/:providerKey` | verified inbound provider events → `MarketingEvent` |
| MA.12+ | `…/action/journey/:id/{validate,publish,pause,resume}`, `…/enrollment/:id/{suspend,resume,exit,retryStep}` | journey runtime |

**Events** — kernel grammar is 2–4 dot segments, so the plan's `.v1` suffix cannot be carried in the type
(`marketing.send.recipient.queued.v1` is 5 segments and `EventBus` rejects it). Convention here follows the
repo: **camelCase module prefix + resource + action, with a `schemaVersion: 1` field in every payload.**

`marketingCampaign.created | .scheduled | .started | .paused | .resumed | .cancelled | .completed | .archived | .validated`,
`marketingSegment.previewed`, `marketingConsent.changed`, `marketingSuppression.added`,
`marketingRecipient.queued | .delivered | .bounced | .complaint | .unsubscribed | .opened | .clicked`,
`marketingJourney.published | .enrolled | .stepCompleted | .goalReached | .exited`, `marketingForm.submitted`.

Payloads carry ids and decisions only — never a contact object, rendered body, token, or raw provider
payload (§7.3).

---

## 7. Migration state and the additive approach

- Runner `runMigrations` applies sorted `.sql` files inside a transaction and records them in
  `schema_migrations` ([database/migrate.ts:11-45](file:///Users/up5techjacky/Documents/projects/carocrmv2/database/migrate.ts#L11-L45)); `db:seed` runs migrations then upserts metadata
  ([seed.ts:433-444](file:///Users/up5techjacky/Documents/projects/carocrmv2/database/seed.ts#L433-L444)).
- Latest applied file: `036_phase19_service_desk_hardening.sql`. Next is **`037_phase19_marketing_automation.sql`**.
- Convention proven by 032/033/036: additive only, every statement `IF NOT EXISTS`, and the objects are
  sequences + expression/partial indexes over `entity_records.attrs`, because records stay in the JSONB store.
  Sales is the only module that created tables, and only for non-record state (number series, stock) —
  [021_phase19_sales.sql:19](file:///Users/up5techjacky/Documents/projects/carocrmv2/database/migrations/021_phase19_sales.sql#L19).
- MarketingAutomation follows the same rule: **new entities are metadata + indexes, not new tables**, unless
  a unique row-level constraint cannot be expressed on JSONB — which is the case for
  `TargetListEntry` membership, `MarketingRecipientDelivery` dedupe, `MarketingConsent` current-state
  uniqueness and `MarketingSuppression` address scope. Those get their own tables in MA.2's migration, and
  the reason is stated in the migration header. Records that *are* user-editable entities stay in `entity_records`.
- No destructive operation is planned or permitted without task-specific approval (AGENTS.md §3.5).

---

## 8. Phase recommendation and order

The audit confirms the plan's roadmap with two adjustments:

1. **MA.5 must precede MA.7–MA.9 in practice** (already the plan's order) — recorded as a hard gate, not a
   preference (§4.1 above).
2. **MA.6's sanitizer precedes MA.7's live provider** (§4.5).

Order for the delivered phases: MA.0 (this audit) → MA.1 scaffold/registration/ACL/navigation/health →
MA.2 domain contracts + enums/transition tables + settings + provider port + fake + decision matrix +
migration baseline → MA.3 campaign lifecycle and validation. MA.4 onward is not started.

Sub-phase acceptance for MA.0 (§15):

- **Named owner per concern** — §3 table.
- **Missing infrastructure and high-risk decisions documented** — §4 (8 items, 7 open questions).
- **No duplicate database, email engine or workflow engine** — §2.3 (reuse `MailTransport`), §2.5 (own
  journey *runtime* only, reusing formula/jobs/events; no second generic engine), §7 (one configured
  primary database, per AGENTS.md §3).
- **Sub-phase order approved** — §8.

---

## 9. Tests that can safely run against the configured primary database

Per AGENTS.md §3, the configured primary database is the integration target; no test database is created.

Safe: metadata-shape unit tests (pure, import `coreMetadata`); entity CRUD through the booted API with
`AGENT_TEST_<runId>` records deleted by exact id in `afterAll`; lifecycle-command tests including illegal
transitions and ACL denials; settings read/patch; health; nav visibility. `MAIL_TRANSPORT=memory` is forced
in the API test env so nothing reaches a network ([apps/api/test/email.test.ts:12](file:///Users/up5techjacky/Documents/projects/carocrmv2/apps/api/test/email.test.ts#L12)).

Unsafe / not to be run by MA.0–MA.3: any job that enqueues real delivery, anything touching a live provider,
broad deletes, or a test that reads/modifies a record it did not create. Known side effect to keep in mind:
booting the API re-seeds metadata and therefore re-applies `coreMetadata` over the `entity` settings row.
