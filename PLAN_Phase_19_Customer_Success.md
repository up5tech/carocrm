# Phase 19 — Customer Success Module (`CustomerSuccess`)

> **Parent roadmap:** `PLAN.md` — Phase 19: Advanced Domains  
> **Priority:** Implement after `Sales` and `Projects`. Both are already shipped in this repository and are optional consumers of this module.  
> **Module ID:** `CustomerSuccess`  
> **Display name:** Customer Success  
> **Primary stack:** NestJS, TypeScript, PostgreSQL, Kysely, React, and the existing CRM module/metadata systems.  
> **Planning baseline:** EspoCRM 9.3.x for the core CRM compatibility baseline. There is no upstream first-party Customer Success extension; this is a project-specific domain module informed by common CSM practice (see §2.2).  
> **Reference reviewed:** October 16, 2026.

---

## 0. Instructions for the Coding Agent

Read these files before implementation:

1. `AGENTS.MD`
2. `PLAN.md`
3. `PLAN_Phase_19_Customer_Success.md` (this file)
4. `PLAN_Phase_19_Sales.md` and `docs/implementation/sales-repository-audit.md` — the closest precedent, an already-shipped Phase 19 domain
5. `docs/module-guide.md` — the runtime rules, API conventions and cross-module contracts
6. `PLAN_Phase_19_Projects.md` and `docs/modules/projects/` — the second shipped Phase 19 domain

This plan describes target behavior, not proof that every prerequisite exists. **Start with Phase 19-CS.0 only.** §3 of this plan records what was verified in the working tree on the reference date; re-verify anything you depend on rather than trusting this document. Do not infer implementation from a plan alone.

### Non-negotiable implementation rules

- Implement a clean-room TypeScript/NestJS module. Use official EspoCRM documentation to define observable behavior; do not copy or mechanically translate EspoCRM source code, frontend assets, translations, branding, or icons.
- **`CustomerSuccess` is a kernel domain module, not an extension package.** It is a directory under `apps/api/src/customer-success` with a barrel exporting `CUSTOMER_SUCCESS_CONTROLLERS` and `CUSTOMER_SUCCESS_PROVIDERS`, registered once in `apps/api/src/app.module.ts`. `apps/api/src/sales/sales-module.ts` records the reasoning: the extension SDK deliberately exposes no entity CRUD facade, so a package that owned `CustomerSuccessProfile` records could only write them with raw SQL, bypassing ACL, validation, audit, stream and domain events (`AGENTS.md` §5.2). Do not create a `manifest.json` and do not add anything to `modules/`.
- Reuse existing CRM Core entities and services. Do not create a second implementation of Accounts, Contacts, Opportunities, Subscriptions, Users, Teams, ACL, Activities, Attachments, Stream, Metadata, Entity Engine, Jobs, Reports, Workflows, or BPM. Do not create a second settings store, notification engine, dashboard engine, or queue.
- Follow the repository's established metadata, API, response envelope, transaction, validation, logging and frontend conventions exactly. The Sales module (`apps/api/src/sales/`) and the Projects module (`apps/api/src/projects/`) are the reference implementations.
- **`CustomerSuccessProfile` is a fixed name.** `apps/api/src/sales/sales-module.ts` declares Customer Success as an optional integration whose `markerEntity` is exactly `"CustomerSuccessProfile"`, and `SalesModuleHealthService` reports that marker as present/absent to an operator. Renaming that entity silently turns a shipped, already-tested integration into a permanently "unavailable" one. See §12.8.
- Use PostgreSQL as the first-class target and the established SQL-first persistence layer (Kysely via `DatabaseService`).
- **Do not create a test database, shadow database, temporary database, test schema, per-agent database, or per-run database.** Follow the exact database rules in `AGENTS.MD`; use the existing configured primary database for targeted, safe integration checks when needed.
- Do not reset, truncate, drop, broadly delete, or replace existing data. Review every migration before applying it. Test writes must use explicit `AGENT_TEST_...` identifying values and cleanup may only remove records created by the current run and identified by exact IDs.
- Never let tests send real email, trigger production webhooks, enqueue real payment activity, or create external side effects. In-app `notifications` rows are acceptable; outbound delivery is not.
- Health scoring is a **pure, deterministic domain calculation**. It must be unit-testable without a database, must never execute user-authored SQL or JavaScript, and must never let a missing signal be scored as zero.
- Do not report a sub-phase as complete until its acceptance criteria and verification evidence have been recorded.

---

## 1. Purpose and Product Outcome

`CustomerSuccess` gives Customer Success Managers, account owners and team leads one place to manage onboarding, desired outcomes, relationship health, adoption, risk, renewal readiness, success plans and proactive engagement for each Account.

It is a **domain module on top of the existing CRM**, not a second CRM. The Account stays the authoritative customer record; Activities stay the record of what actually happened; Health is a derived, explainable view over data the platform already holds.

### 1.1 Primary outcomes

At completion, authorized users must be able to:

1. Maintain one Customer Success Profile per Account without duplicating the Account record.
2. Assign a CSM and organize Accounts into a portfolio or segment.
3. Track lifecycle stage, customer objectives, onboarding progress, adoption status, health status and renewal readiness.
4. Calculate a configurable Customer Health Score from transparent, auditable signals.
5. See the score's components, history, trend, freshness and the reason it changed.
6. Create success plans with measurable goals, checkpoints, owners, dates and progress.
7. Register CSM-specific risks, mitigations, escalation actions and resolution outcomes.
8. Execute repeatable onboarding and engagement playbooks that create or link *existing* CRM activities.
9. Record success reviews and touchpoints while reusing the platform's Task/Call/Meeting/Reminder/Email, Calendar, Stream and Notes.
10. Use portfolio dashboards, actionable lists, filters, saved views and reports to prioritize customer work.
11. Consume Sales, Subscriptions and Projects through detected, ACL-safe adapters — and work correctly when any of them is absent.
12. Access everything through secure APIs and metadata-driven UI with the same ACL, audit and validation as the rest of the CRM.

### 1.2 Module boundary: what `CustomerSuccess` owns

| Capability | Owner | `CustomerSuccess` responsibility |
|---|---|---|
| Account identity, contacts, ownership | CRM Core | Reference through metadata relations only. Never copy Account fields onto the Profile for reporting. |
| Activities (Task, Call, Meeting, Reminder, Email) | CRM Core | Link to and read them. Never create a second task/call/meeting entity or scheduler. |
| Users, Teams, Roles | CRM Core | Reference `csmUserId` / `csmTeamId` as links. |
| ACL, field permissions, admin bypass | `@carocrm/acl`, `AclApiService` | Consume. Never evaluate a rule locally. |
| Metadata, relations, validation, serialization, audit, stream | Kernel | Register entities in `database/seed-metadata.ts` and use the generic Entity API. |
| Instance settings | `app_settings` | One validated, versioned row named `customerSuccess`, mirroring Sales' `sales` row. |
| Background jobs, scheduled jobs | Kernel jobs + `apps/worker` | Register handlers in `apps/worker/src/handlers/`, like `registerSalesJobs`. |
| Dashboards, saved filters, search, import/export | `apps/api/src/search`, `apps/api/src/reports` | Contribute entity-list dashlets and reports through them. |
| Workflows, BPM | Kernel | Emit domain events; let workflow/BPM consume them. Do not re-implement. |
| Health scoring, lifecycle policy, success plans, goals, risks, playbooks, renewal readiness | **`CustomerSuccess`** | This is the module's actual content. |
| Billing, invoicing, contracts | `Sales` | Read authorized renewal/commercial summary through a detected adapter. Never write an invoice. |
| Support tickets | Service Desk (not built) | No support signals until that module exists (§12.6). |
| Product usage analytics | External connector (not built) | Adapter contract only (§12.7). No vendor API calls from controllers or the scorer. |

---

## 2. Reference Boundary

### 2.1 What is a reference and what is not

The EspoCRM extension catalog and developer documentation are useful references for the **platform** and **extension architecture**. There is no official first-party Customer Success extension, so:

- This plan is a project-specific domain module informed by common CSM workflow. Do not claim feature parity with an upstream extension.
- Preserve EspoCRM-style architectural concepts where relevant: metadata-driven entities, REST APIs, ACL, activity integration, hooks/events, scheduled jobs and dashboards.
- Do not copy upstream source code, translations, icons, UI assets or branding.

Reference pages:

- EspoCRM extension catalog: https://www.espocrm.com/extensions/
- EspoCRM developer documentation: https://docs.espocrm.com/development/
- EspoCRM modules: https://docs.espocrm.com/development/modules/
- EspoCRM metadata: https://docs.espocrm.com/development/metadata/
- EspoCRM ACL: https://docs.espocrm.com/development/acl/
- EspoCRM API: https://docs.espocrm.com/development/api/
- EspoCRM hooks: https://docs.espocrm.com/development/hooks/
- EspoCRM scheduled jobs: https://docs.espocrm.com/development/scheduled-job/

### 2.2 Product principles

- **Account-centric.** Account remains the authoritative customer record.
- **Explainable health.** A user must be able to answer *why* an Account is Healthy, At Risk or Critical, and which signal drove the change.
- **No phantom data.** A missing signal is `unknown`, never zero, and never evidence of poor health.
- **Actionable insights.** A warning points to evidence and a next step, not just a red badge.
- **Human override with history.** Authorized users may override health or lifecycle, but the calculated value, reason, actor and timestamp are preserved.
- **Safe automation.** Background actions are idempotent, permission-aware, observable, and prevented from duplicating tasks or notifications.
- **Configurable but bounded.** Admins configure weights, thresholds, lifecycle options and playbooks within server-validated constraints. No user-authored SQL or JavaScript.
- **Composable.** Consume existing platform services and domain modules through stable, detected interfaces.

---

## 3. Repository Audit — Verified Baseline

Read this section as *recorded facts from the working tree*, not as assumptions to skip verification. Re-check before relying on it.

### 3.1 Module shape (verified)

| Fact | Evidence |
|---|---|
| Phase 19 domains are kernel directories under `apps/api/src`, not extension packages | `apps/api/src/projects/index.ts`, `apps/api/src/sales/index.ts` |
| Each exports `<NAME>_CONTROLLERS` and `<NAME>_PROVIDERS` from its barrel | same files |
| The integrator registers them **once** in `apps/api/src/app.module.ts` | `docs/module-guide.md` → "Files to register new modules" |
| Domain controllers must be spread **before** `ENTITY_CONTROLLERS` | `apps/api/src/app.module.ts` comments; `apps/api/src/projects/index.ts` header |
| A module descriptor object gives the module a stable id, version, capabilities, optional integrations and feature flags | `apps/api/src/sales/sales-module.ts` → `SALES_MODULE`, `REQUIRED_PLATFORM_CAPABILITIES`, `OPTIONAL_INTEGRATIONS`, `SALES_FEATURES` |
| A health endpoint reports that descriptor and checks each dependency against real platform state | `apps/api/src/sales/sales-module-health.service.ts`, served at `GET /api/v1/Sales/action/health` |
| Kernel domain modules have `loadOrder`; Sales uses `320` | `sales-module.ts` |

### 3.2 API conventions (verified)

- Root `/api/v1`. Auth: `Authorization: Bearer <jwt>` or `Authorization: ApiKey <keyId>:<secret>`, or the `CRM-SESSION` cookie (unsafe methods also need `x-csrf-token` matching the `CRM-CSRF` cookie).
- **Static PascalCase domain prefixes** are the convention: `/api/v1/Settings`, `/api/v1/Project`, `/api/v1/Sales/action/*`, `/api/v1/Report`. There is no kebab-case domain route anywhere in the repository.
- Domain commands live under `/api/v1/<Domain>/action/*` (`docs/implementation/sales-repository-audit.md` §3).
- Entity CRUD uses the **generic** `/api/v1/:entity` endpoint — a new metadata entity gets list/detail/create/update/delete/relations for free and needs no controller.
- List envelope: `{ list, total, offset, count }`.
- Errors: `{ "error": { "code", "message", "details?" } }`, produced by throwing `AppError` subclasses from `@carocrm/core`.
- DTO validation uses **Zod** schemas; `.strict()` rejects unknown fields; parse failures return `422`. See `apps/api/src/sales/dto/sales-shapes.ts` and the `parse()` helper in `apps/api/src/sales/sales.controller.ts`.
- `RequestScope.isAdmin` (user type `admin`) is the documented admin bypass.

### 3.3 Persistence and metadata (verified)

- Every generic entity record lives in one table, `entity_records`: physical columns `id, entity_type, name, assigned_user_id, created_by_id, modified_by_id, created_at, modified_at, deleted_at, version, attrs (JSONB)`. `attrs` holds everything else.
- `version` is the optimistic-concurrency column. `deleted_at` is soft delete.
- Relations are link fields in `attrs` (`accountId`, `contactIds`); reverse relations resolve through metadata (`oneToMany` + `mappedBy`). `entity_links` backs explicit link/unlink endpoints.
- **Kernel entity metadata lives in `database/seed-metadata.ts`** — 51 entities are registered there, including every Sales and Projects entity. Extension packages register metadata through `metadata/entities.json` instead (`modules/project-domain/metadata/entities.json`). A kernel domain module uses `seed-metadata.ts`.
- Each entity entry carries `fields`, `relations`, `indexes` (declarations), `layouts` (list/detail/edit with `panels` + `position`), `record` and `acl.permissions`.
- Index *declarations* in metadata are not DDL. Physical indexes are reviewed migrations.
- The established physical-index pattern for a metadata attribute is a partial expression index over `entity_records ((attrs ->> 'field'))` filtered by `entity_type` (`docs/implementation/sales-repository-audit.md` §4).

### 3.4 Migrations (verified)

- Files live in `database/migrations/`, named `<NNN>_phase<NN>_<slug>.sql`. Currently `001_init.sql` … `031_phase19_sales_reporting.sql`.
- **`032` is the next free number.** Name the CS migration `032_phase19_customer_success.sql`.
- `database/migrate.ts` reads the directory, **sorts by filename**, skips files already in `schema_migrations`, and applies each remaining file inside a single transaction. A failure rolls back that file and aborts the run.
- Migrations are additive: `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `CREATE UNIQUE INDEX IF NOT EXISTS`.
- Do not edit an applied migration, mark a failed migration as applied, or regenerate schema to fix an error.

### 3.5 Platform capabilities available (verified)

| Capability | Evidence |
|---|---|
| Entity Engine, metadata registry, relations, validation | `packages/entity-engine`, `packages/metadata`, `apps/api/src/entity/` |
| ACL: roles, field permissions, record access | `packages/acl`, `apps/api/src/acl/acl-api.service.ts`, tables `roles`, `users_roles`, `roles.field_permissions` |
| Hooks, phases `beforeValidate` / `afterSave` | `apps/api/src/hooks/`, `KERNEL_HOOKS_TOKEN` |
| Audit log, Stream, transactional outbox | `apps/api/src/audit/`, `apps/api/src/stream/`, `apps/api/src/common/outbox.service.ts`, tables `audit_log`, `stream_items`, `outbox_events` |
| Domain events | `apps/api/src/events/`, `apps/worker/src/events/domain-event-bus.ts` |
| Jobs, scheduled jobs, job logs | `apps/api/src/jobs/`, `apps/worker/src/queue/`, tables `jobs`, `scheduled_jobs`, `job_logs` |
| Activities | Metadata entities `Task`, `Call`, `Meeting`, `Reminder`, `Email` in `seed-metadata.ts`; reminders by the `system.sendReminders` job (seeded cron `scheduledReminders`, `* * * * *`) |
| Calendar | `apps/api/src/calendar/` |
| Search, saved filters, dashboards, import/export | `apps/api/src/search/` (`search.controller.ts`, `saved-filter.service.ts`, `dashboard.service.ts`, `import-export.service.ts`) |
| Dashlets | An entity-list dashlet + option set; see `apps/api/src/projects/project-dashlet.service.ts` and migration `019_phase19_dashlet_kind.sql` |
| Reports | `apps/api/src/reports/`, `packages/reports`, migrations `013`/`015` |
| Attachments / file storage | `apps/api/src/attachment/`, `packages/files` |
| Email | `apps/api/src/email/`, `packages/mail` |
| Formula (sandboxed) | `packages/formula`; metadata `formula` fields evaluate on write, not editable by clients |
| Workflows, BPM | `apps/api/src/workflows`, `apps/api/src/processes`, `packages/workflow`, `packages/bpm` |
| Instance settings | table `app_settings`, `POST /api/v1/Settings`; Sales' validated row pattern is `apps/api/src/sales/sales-settings.service.ts` |
| Portal | `apps/api/src/portal/` (Phase 18) |
| i18n | `apps/api/src/i18n/`, migration `017_phase7a_i18n.sql` |

### 3.6 Platform capabilities **not** available (do not assume them)

- **No notification service.** There is no `apps/api/src/notification`. The `notifications` table exists and is written by a worker job (`apps/worker/src/handlers/job-handlers.ts:132`, the `system.sendReminders` handler). See §11.3 for the rule this implies.
- **No Cases / Service Desk module.** No ticket entity, so no support-derived health signals. See §12.6.
- **No external adoption-analytics connector.** No product-usage data source. See §12.7.
- **No generic `Activity` entity.** Activities are four separate metadata entities; a "touchpoint" must name which of them it reads.
- **No module-level toggle.** There is no platform facility that can disable a kernel domain directory. "The module can be disabled" (§16, Sales' pattern) is not available to a kernel module; §16.5 replaces it with feature flags inside the module's settings row.
- **No `notification`/`dashlet`/`dashboard`/`saved-filter` directories** — these live under `apps/api/src/search` and `apps/api/src/projects`. Do not invent new top-level directories for them.

### 3.7 Optional integrations this module can consume

| Provider | Present? | Detection |
|---|---|---|
| Sales (renewal/commercial source) | **Yes** — `apps/api/src/sales` | metadata entity `Subscription` |
| Projects (delivery milestones) | **Yes** — `apps/api/src/projects` | metadata entity `Project` |
| Opportunities | **Yes** — core entity | metadata entity `Opportunity` |
| Subscriptions | **Yes** — `Subscription`, `SubscriptionPeriod` | metadata entity `Subscription` |
| Activities | **Yes** — `Task`/`Call`/`Meeting`/`Email` | metadata entities |
| Cases / Service Desk | **No** | marker absent; report as unavailable |
| Adoption analytics provider | **No** | no marker; do not attempt |

**Detect optional providers through the metadata registry, never by importing them.** `SalesModuleHealthService` reads `metadata.registry.getEntities()`; do the same. An absent optional module must never break startup.

### 3.8 Audit output

Phase 19-CS.0 must create `docs/implementation/customer-success-repository-audit.md` recording: verified prerequisites with exact code locations, available module integration contracts, capabilities missing that block only optional features, any minimal reusable platform enhancement needed, and each assumption marked verified or rejected. Do not restate this plan there.

### 3.9 Dependency handling

If a required generic capability is missing: identify the smallest missing abstraction, confirm no equivalent exists, decide whether it belongs in the kernel or in this module, and implement it in the kernel only if it is genuinely generic and reusable. Never duplicate ACL, activity management, jobs, metadata handling or dashboards inside `CustomerSuccess`.

### 3.10 Database safety

Follow `AGENTS.MD` exactly:

- Use the already-configured primary project database for targeted integration/API/smoke tests when database verification is needed.
- Do **not** create `test_db`, `*_test`, `*_e2e`, shadow, temporary, per-agent or per-run databases or schemas.
- Inspect test scripts and framework lifecycle hooks before executing them.
- Do not reset, truncate, drop, replace or broadly delete database contents.
- Use unmistakably marked records such as `AGENT_TEST_...`; clean up only records created by the current run, by exact ID or run marker.
- Do not use real customers for tests; never send real email, notifications or webhooks during tests.
- Review every migration before applying it. Prefer additive, backward-compatible changes.

---

## 4. Domain Concepts and Terminology

Use these terms consistently in metadata, APIs, UI labels, code and docs.

- **Account:** existing CRM customer organization; source of truth for customer identity.
- **Customer Success Profile (`CustomerSuccessProfile`):** CSM-specific operational profile for one Account.
- **Customer Health Score:** integer 0–100 calculated from known, fresh signals under an enabled scoring configuration; `null` when unknown.
- **Health Status:** classification — `healthy`, `monitor`, `atRisk`, `critical`, `unknown` — derived from configured thresholds unless an authorized override is active.
- **Health Snapshot:** append-only record of score, status, components and configuration version at a point in time.
- **Health Signal:** a normalized metric from an available data source, carrying freshness and source metadata.
- **Lifecycle Stage:** where the customer is in the journey — `onboarding`, `adoption`, `valueRealization`, `mature`, `renewal`, `atRisk`, `churned`. Configurable; ships with validated defaults.
- **Success Plan (`CustomerSuccessPlan`):** time-bound plan of desired outcomes, goals, owners, dates and checkpoints.
- **Success Goal (`CustomerSuccessGoal`):** measurable outcome with target, current value, unit, direction, due date and progress.
- **Customer Success Risk (`CustomerSuccessRisk`):** discrete problem with severity, evidence, owner, mitigation, due date and resolution. A risk is *not* a health status.
- **Playbook Template / Run / Step Run:** reusable recipe, one execution, one step's execution state.
- **Touchpoint / Success Review:** CSM context layered on existing Task/Call/Meeting records; never a replacement for them.
- **Renewal Readiness:** a summary view of renewal date, health, risks, goals and next actions. Not a billing system.
- **Portfolio:** the set of Accounts a CSM or team is responsible for.

### 4.1 Naming rules (binding)

- **Module id is `CustomerSuccess`. No prefix.** Not `cs`, not `csm`, not `customer-success`, not `success`. Use `CustomerSuccess` as the module id, the barrel's exported constant names, the descriptor `id`, and the API prefix.
- **Domain directory:** `apps/api/src/customer-success/` (directory names are kebab-case; module ids are PascalCase — this mirrors `apps/api/src/sales` / `id: "sales"`).
- **Entity names keep the `CustomerSuccess` prefix** (`CustomerSuccessProfile`, `CustomerSuccessPlan`, `CustomerSuccessRisk`, …). §12.8 explains why this specific rule survives even though the module id does not use one: the shipped Sales module already hard-codes `CustomerSuccessProfile` as its detection marker.
- Service names follow the same prefix: `CustomerSuccessProfileService`, `CustomerSuccessHealthService`, … matching `SalesSettingsService`, `SalesNumberingService`.
- Use stable machine keys for lifecycle values, health states, risk types, event names and API fields. Display labels must be translatable through the i18n catalogs (`apps/api/src/i18n`, migration `017`).
- **Never use a display label as an internal identifier.** Existing core entities use PascalCase enum values (`Planned`, `Held`, `Not Held`); new CS enums should match that style for display-facing values and use camelCase machine keys for event/API namespaces.

---

## 5. Functional Requirements

### 5.1 Customer Success Profile

One profile per Account, enforced by a unique constraint on `accountId`.

| Field | Type / behavior | Required |
|---|---|---|
| `accountId` | Relation to Account; unique | Yes |
| `csmUserId` | Relation to User responsible for the Account | Configurable; may be unassigned |
| `csmTeamId` | Optional owner team/portfolio | No |
| `lifecycleStage` | Configurable lifecycle key | Yes; default from settings |
| `healthStatus` | Calculated classification; overridable with permission | System managed |
| `calculatedHealthStatus` | Latest status before any manual override | System managed |
| `healthScore` | Latest calculated score 0–100, or null | System managed |
| `healthScoreAt` | Latest successful calculation time | System managed |
| `healthOverride` | Optional manual override key | No |
| `healthOverrideReason` | Required while an override is active | Conditional |
| `healthOverrideByUserId` | Actor | System managed |
| `healthOverrideAt` | Timestamp | System managed |
| `healthOverrideExpiresAt` | Optional review/expiry date | No |
| `segment` | Configurable, e.g. SMB / Mid-Market / Enterprise | No |
| `onboardingStatus` | Derived from the onboarding workflow, or manual where no playbook exists | Yes/default |
| `onboardingStartedAt` / `onboardingTargetDate` / `onboardingCompletedAt` | Dates | No |
| `renewalDate` | Manual date; enrichable from an enabled source | No |
| `renewalStatus` | `unknown`, `notDue`, `preparing`, `inProgress`, `renewed`, `atRisk`, `churned` | Default `unknown` |
| `renewalSource` / `renewalSyncedAt` | Which source supplied the date, and when | No |
| `lastMeaningfulTouchAt` | Derived from qualifying, permitted activity | System managed |
| `nextSuccessReviewAt` | Next planned review | No |
| `lastHealthReviewAt` | Last documented manual review | No |
| `customerSince` | Only if it does not conflict with Account fields | No |

Functional rules:

- Creating a profile must never create a duplicate Account.
- A user can open the Account from a profile and the profile from an Account panel, subject to ACL on both.
- Accounts without a profile must not break Account list/detail screens.
- Profile creation must be idempotent when initiated by a workflow, a job or a migration.
- Decide and document cascade/restrict/soft-delete behavior for linked CSM records under the platform's existing soft-delete model (`deleted_at`). **Do not silently delete historical health snapshots or risk records.**
- Unassigning a CSM is audited and may trigger a configured reassignment notification.
- Manual creation, automated creation and backfill all pass through the same domain validation and access policy.

### 5.2 Portfolio and ownership

Required views:

- My Customer Portfolio
- Team Portfolio (subject to team/record ACL)
- Unassigned Customers
- Customers with `unknown` / `monitor` / `atRisk` / `critical` health
- Customers onboarding now or overdue
- Customers with upcoming renewals
- Customers missing a success plan or a next review

Capabilities:

- Assign/reassign one or many profiles only if the actor holds the permission **and** may access each Account.
- Bulk actions validate every selected record, return per-record successes and failures, and never fail partially silently.
- Filter by CSM, team, Account, segment, lifecycle, health status, renewal window, onboarding status, last touch, next review, active risk, and available optional-integration status.
- Support saved filters and configurable list columns via the existing `SavedFilter` / list-view system.
- Sort by health score, renewal date, next review date, risk severity, overdue work and Account name, with an explicit null-ordering rule for each sort.
- Each row shows actionable context: current health, trend, next action/date, renewal horizon, open-risk count — without leaking inaccessible related records.

### 5.3 Lifecycle management

Ship configurable default stage keys: `onboarding`, `adoption`, `valueRealization`, `mature`, `renewal`, `atRisk`, `churned`. These are a practical local design, not a claim about any upstream status list.

- Configure enabled stage keys, labels, order, descriptions and allowed transitions through settings.
- **Validate transitions server-side.** A client-side dropdown is not access control.
- Require a reason (and optionally a churn date) for important transitions such as to `churned`.
- Keep lifecycle and health separate: an Account can be onboarding while `healthy`, or `mature` while `atRisk`.
- Support manual transitions by authorized users and optional rule-driven automation.
- Record lifecycle changes in the audit stream and publish a domain event.
- **Never move a customer to `churned` because a Subscription or Opportunity is missing.** Only an enabled, configured source may drive that transition.
- Provide a transition preview for bulk operations and automation.

### 5.4 Customer Health Score engine

The core feature. It must be transparent, deterministic, testable and auditable.

#### 5.4.1 Score semantics

- User-facing score is an integer 0–100. Retain precise intermediate values only where the repository convention requires them.
- `null` / `unknown` means insufficient eligible data — **not** a score of zero.
- Status comes from configurable thresholds with validated, non-overlapping ranges. Default: `healthy` 80–100, `monitor` 60–79, `atRisk` 40–59, `critical` 0–39, `unknown` when there is no valid score.
- Settings must guarantee coverage of 0–100 with no gaps and no overlaps.
- A manual override is independent of the calculated result. Show both effective and calculated status.
- An override stores a non-empty reason, the actor and a timestamp, plus an optional expiry. Expiry returns the effective status to the calculated status through an auditable transition.

#### 5.4.2 Signals and component scores

Provide an extensible `HealthSignalProvider` interface. Implement built-in providers **only** for data sources §3.7 confirms exist. Candidate signal families:

| Family | Source | Availability |
|---|---|---|
| Engagement | Time since last qualifying Task/Call/Meeting; overdue customer-facing activities | Available now |
| Success plan | Progress against active goals, overdue goals, milestone completion | Available now |
| Relationship coverage | Active customer contacts and a defined executive sponsor | Available now |
| Onboarding | Completion ratio and overdue onboarding steps | Available now |
| Risks | Open risk severity, age, overdue mitigations | Available now |
| Renewal/commercial | Renewal horizon and renewal risk from the detected Sales/Subscription source | Available when the marker is present |
| Support | Open severe cases, reopened cases, SLA trends | **Not available** — no Service Desk module |
| Adoption | Product usage metrics | **Not available** — no connector; manual entry only |

Each provider returns a normalized result carrying: a stable signal key and label key; a raw or safely summarized value; a component score 0–100 when scoreable; its weight from the active configuration; measurement time and freshness/expiry; source module/entity/record references when accessible; an explanation code with safe display parameters; and an applicability state (`applicable`, `missing`, `stale`, `failed`).

Do not put secrets or raw event payloads in a score explanation.

#### 5.4.3 Weighted score rules

- Store scoring configuration as versioned configuration records, or as the module's versioned `app_settings` row. Never as arbitrary executable code.
- Weights must be non-negative and normalized server-side. Configured applicable weights sum to 100, or are renormalized under one documented policy.
- Missing or stale inputs follow the configured missing-data policy: exclude and renormalize, reduce confidence, or return `unknown` when minimum coverage is not met. **Never silently score missing data as zero.**
- A profile is `unknown` when fewer than the configured minimum number/weight of signals are valid.
- Store the configuration **version** used on the snapshot, so a historical score remains explainable after a rule changes.
- Define rounding once and use the same algorithm in the API, the UI, jobs and tests.
- Signal providers must not query arbitrary table names or accept unvalidated SQL conditions from settings.
- Validate configuration changes and preview them against a non-persistent sample before activation.

#### 5.4.4 Snapshots and history

Append-only `CustomerSuccessHealthSnapshot` records. Each records:

- Profile and Account references;
- score and calculated status;
- effective status at calculation time, kept clearly separate;
- component scores, normalized inputs, weights, missing/stale states, short explanation codes;
- the scoring configuration version;
- calculation source (`manual`, `scheduled`, `event`, `rebuild`);
- calculation timestamp and duration;
- result state (`success`, `partial`, `failed`) with a safe error summary where appropriate;
- a deduplication/idempotency key when the work was queued.

Requirements:

- Preserve previous snapshots; a new calculation never overwrites history.
- Avoid writing a new snapshot when no material input, configuration or status change occurred, unless an explicit periodic-snapshot policy requires it.
- Do not write sensitive customer content into a score-history blob. Store the minimum explanation needed.
- Provide a trend view and a component-change explanation for authorized users.
- A historical snapshot reflects the configuration in force at the time.

#### 5.4.5 Recalculation modes

- On-demand, for one profile; permission-checked and rate-limited.
- Scheduled batch, through the existing job/scheduler system.
- Event-triggered, for qualifying activity completion, risk updates, goal updates, and Subscription/renewal changes where those events exist.
- Admin-only, for a selected record set, with progress and error reporting.

**Prevent event loops:** writing a health snapshot must not itself trigger unbounded recalculation. Use event filters, the transactional outbox, or the established event architecture.

### 5.5 Onboarding

Onboarding is an Account-specific process built from playbooks/checklists plus existing Activities.

- Start onboarding manually or through a configured, idempotent rule.
- Record start date, target date, status, owner/CSM and completion date.
- Provide a checklist with ordered steps, due-date offsets, required/optional flags, dependencies, step owners and completion criteria.
- Create or link **existing** CRM tasks/activities for steps needing human work. Never a second generic task entity.
- Track blockers, overdue steps, completion ratio and next action.
- An authorized user may skip an optional step with a reason. Bypassing a required step needs an explicit override permission and an audit reason.
- Pause/cancel/restart only through validated transitions. Restart must not duplicate already-completed steps.
- Complete onboarding only when mandatory steps are complete, or a properly permissioned override with a reason is recorded.
- Surface onboarding state on the Profile, the Account, portfolio lists, dashboards and health explanations.
- **Never email the customer automatically** unless an existing mail integration and explicit, reviewed opt-in configuration are present.

Suggested states: `notStarted`, `inProgress`, `blocked`, `completed`, `canceled`.

### 5.6 Success Plans

Required fields: name; `profileId` and `accountId`; owner/CSM and optional collaborators; start/end date; status (`draft`, `active`, `onHold`, `completed`, `canceled`); plan type/template; customer-stated outcomes and baseline summary; executive sponsor and involved Contacts where relation metadata supports it; next review date; completion date and close-out summary; audit fields.

- Support multiple historical plans per Account, with at most one primary active plan by default; any secondary-plan behavior must be explicit.
- Support plan templates with configurable default goals/checkpoints and owner suggestions.
- Record plan state transitions in the audit stream.
- Preserve completed/canceled plans as history; routine cleanup must not hard-delete them.
- Provide copy-from-template and a safe duplicate-plan that issues new IDs and copies no completion metadata.
- Support an Account-level summary of active plan status and overall progress.
- A plan may optionally link to a `Project` or `ProjectTask` **only when the Projects module is present**; the link is supplementary, never a hard dependency.

### 5.7 Success Goals and checkpoints

Suggested fields: `successPlanId`, `profileId`, `accountId`; name/description; category/type; baseline value+date; target value+date; current value+date; unit; direction (`increase`, `decrease`, `maintain`, `boolean`, `manual`); owner and optional customer Contact; source type (`manual`, `linkedEntity`, `provider`); optional linked record configuration; status (`notStarted`, `inProgress`, `achieved`, `missed`, `canceled`, `blocked`); progress percentage and calculation timestamp; checkpoint dates and notes; audit fields.

Rules:

- Validate numeric type, unit, direction, target and baseline.
- Avoid division-by-zero and reversed-direction mistakes.
- `increase` computes progress from baseline and target; `decrease` reverses direction safely; `maintain` uses a configured tolerance; `boolean` uses explicit completion state; `manual` requires a controlled progress update.
- If a value cannot be read from a safe authorized source, require a manual update — never invent one.
- Keep progress in 0–100 for display while exposing actual current/target values separately.
- Goal completion and overdue behavior must be deterministic and unit-tested.
- Changes to goal values, targets, statuses or due dates recalculate the plan summary and enqueue health recalculation only when relevant.
- Provide goal checkpoint history, or rely on the standard audit system if it retains prior values adequately.

### 5.8 Risks and churn prevention

`CustomerSuccessRisk` is linked to a Profile and an Account. A risk is not a health status: a customer may have several risks that together contribute to health.

Suggested fields: title/description; `profileId`, `accountId`, optional `successPlanId`, related Contact, and an optional linked Case/Opportunity/Subscription record when present; a stable risk type key (`adoption`, `engagement`, `support`, `stakeholder`, `valueRealization`, `renewal`, `commercial`, `implementation`, `competitor`, `unknown`); severity (`low`, `medium`, `high`, `critical`); optional probability/impact fields, only if the UI explains them clearly; lifecycle status (`open`, `mitigating`, `escalated`, `resolved`, `accepted`, `closed`); owner/assignee and optional escalation team; detected date, next review date, target resolution date, resolved date; evidence summary and source references; mitigation plan and next action; resolution/outcome reason; a flag for whether it contributes to health scoring; audit fields.

Requirements:

- A risk must have an accountable owner, or be explicitly placed in an unassigned queue.
- High/Critical risks require a mitigation action or a documented reason for deferral.
- Overdue unresolved risks appear in designated queues and may trigger a configured in-app notification.
- Escalation is permission-checked and idempotent.
- Resolve/close records the outcome; reopening preserves earlier resolution history.
- Severity, age, status and due-date changes may trigger health recalculation.
- Support manual creation now, and rules-based detection later against verified data sources.
- **Never automatically label an Account `churned` because a risk is Critical.** Health, lifecycle and risk are separate concepts.

### 5.9 Renewal readiness

Renewal readiness provides visibility and workflow support. It is **not** a replacement for Sales, Subscriptions, invoices or contracts.

- Show known renewal date, days to renewal, renewal status, responsible CSM, commercial owner where available, active plan, goal progress, health trend, open high/critical risks and next action.
- Authorized users manage renewal date/status manually when no commercial source is installed.
- If an Opportunity/Subscription source exists, provide an adapter that reads **only allowed fields** and links to the source record.
- Define data precedence explicitly. A source-supplied date must not silently overwrite a manual date unless a setting says so. Always show the source and last-sync time.
- Provide configurable date windows (e.g. 30/60/90/120 days) and queues: Upcoming, Needs Preparation, At Risk, Overdue, Renewed, Churned.
- A renewal alert carries actionable evidence and a recommended follow-up, not only a status.
- **Never create or update an Opportunity, Subscription, invoice or payment** without an explicit, separately permissioned action.
- A `renewed` state requires a traceable source reference or a documented manual confirmation. Never infer renewal from a changed date.
- A source failure must be visible and must not erase a previously valid value.

### 5.10 Touchpoints and success reviews

Reuse existing Task, Call, Meeting, Email, Calendar, Stream and Contact records. The module adds CSM context without forking generic collaboration features.

- Show recent qualifying calls, meetings, completed tasks and notes in a unified Profile context.
- Let a CSM schedule a Success Review by creating or linking an existing Meeting/Activity.
- Provide an optional structured review template: objectives, outcomes achieved, open risks, goal progress, customer sentiment, action items, next review date.
- Store customer sentiment only as a clearly labelled human-entered value unless an explicit compliant external source is configured.
- Link a touchpoint/review to Account, Contacts, Profile, Plan, Goals and Risks **without duplicating the Activity record**.
- Define what counts as a `meaningful touch` for health scoring. Exclude internal-only tasks, automated noise, and events without a customer/account link unless configuration says otherwise.
- Distinguish activity **creation** date from activity **completion** date for recency calculations.
- A user must never see an Activity or Note they could not otherwise read, even when it is connected to a visible Profile.

If the generic Activity model cannot carry a structured review form safely, add a small `CustomerSuccessReview` record that **links** to an existing Activity rather than replacing it. Do not build a standalone call/meeting/task scheduler.

### 5.11 Playbook templates and execution

#### 5.11.1 Template model

A Playbook Template defines: name, description, type/category, version, active flag; a trigger mode (`manual`, `lifecycleTransition`, `healthTransition`, `renewalWindow`, `onboardingStarted`, or another explicitly supported domain event); validated trigger configuration; eligible segment/lifecycle/health criteria; steps in stable order with stable IDs/keys; a step type (`manual`, `createActivity`, `createTask`, `createRisk`, `createSuccessPlan`, `notifyOwner`, `waitUntil`, or another explicitly supported type); required/optional flag, offset due dates, assignee policy, dependencies, instructions and completion rule; template version and audit fields.

**Never execute arbitrary code in a step.** No raw SQL, no unrestricted JavaScript. Step types are allow-listed providers with validated schemas.

#### 5.11.2 Run model

A Playbook Run stores: Profile/Account and template/version references; trigger source and idempotency key; start/end time, status, initiating actor or system source; **a snapshot of the template steps required for this run** so later template edits cannot mutate in-flight work; per-step status, due date, assignee, linked Activity/Task/record, completion time, skip reason and safe error summary; cancel/pause reason and run-level audit data.

#### 5.11.3 Execution rules

- Manual start in MVP; automated triggers enabled incrementally.
- Every trigger has a deterministic idempotency key, so an event retry cannot create a duplicate run.
- Non-blocking work uses the existing queue/job infrastructure.
- A repeated event must not duplicate tasks, risk records or notifications.
- Step failure is visible and retryable without repeating completed external side effects.
- Support run cancellation and controlled retry; preserve partial progress and history.
- No hidden cascading automation. Show which trigger started a run and which actions it performed.
- `waitUntil` uses the existing scheduler/queue abstraction — never in-memory timers.
- Never send customer-facing mail or call external APIs unless an existing integration and explicit configuration permit it.

### 5.12 Dashboards, reports and operational queues

Contribute dashlets to the existing dashboard framework. The established pattern is an entity-list dashlet plus an option set (`apps/api/src/projects/project-dashlet.service.ts`), ACL-filtered server-side. Suggested views:

1. My portfolio health distribution
2. Health score trend over time
3. Customers with falling health scores
4. At Risk/Critical customers with no next action
5. Onboarding completion and overdue steps
6. Open risks by severity, owner and age
7. Upcoming renewals by 30/60/90-day window
8. Success-plan and goal progress
9. Overdue or missing customer reviews
10. Active playbook runs and failed steps
11. Unassigned profiles and portfolio workload

Rules:

- Every aggregate respects record-level ACL, team scope and field-level restrictions.
- Do not leak counts or names of inaccessible Accounts through filters or chart tooltips.
- Date-window definitions and timezone behavior must be explicit.
- Health distributions distinguish `unknown` from a low score.
- Dashlets drill down to the exact filtered list when permitted.
- Use the existing `Report` and `Dashboard` capabilities. Do not add a reporting engine.
- Until a richer framework exists, saved list views plus a compact portfolio overview are an acceptable first delivery.

### 5.13 Configuration and administration

Provide a Customer Success settings area backed by one validated, versioned `app_settings` row named `customerSuccess`, mirroring `apps/api/src/sales/sales-settings.service.ts` (`GET`/`POST /api/v1/CustomerSuccess/action/settings`). Configure at minimum:

- enabled lifecycle stages and valid transitions;
- segment options;
- default owner/assignment policy;
- health thresholds and the enabled scoring configuration;
- signal weights, applicability, freshness windows, missing-data behavior, minimum coverage;
- manual-override permissions, optional expiry and review requirement;
- renewal windows and data-source precedence;
- meaningful-touch definition and recency window;
- playbook auto-trigger enablement and per-trigger guardrails;
- notification/escalation rules;
- default onboarding playbook and success-plan template;
- module feature flags (§3.6: there is no platform-level module toggle, so optional behaviour is gated by flags here);
- job batch size/limits.

Safeguards:

- Validate all settings server-side with Zod; bump the version on every accepted change.
- Preview changes before enabling high-impact automation.
- System defaults are idempotent and version-controlled.
- **Never reset administrator settings on app start or routine migration.**
- Settings must never weaken global ACL or make record access more permissive.

### 5.14 Search, filters, import/export and bulk operations

- Register all CSM entities with the generic Entity Engine so search, import/export and the Entity Manager UI come for free.
- Make searchable: Account name, profile owner, lifecycle, health state, segment, active risk title, goal name, renewal date — subject to existing search limits.
- Register filters through the generic query/filter framework. Never concatenate client strings into SQL.
- Support import/export only through the existing framework and its ACL checks.
- If a profile import references Account IDs, validate the actor may access each Account and prevent duplicate active profiles.
- Bulk actions: assignment, lifecycle transition, health recalculation, plan activation, playbook start — only where the generic bulk-action contract supports per-record results.
- No bulk destructive delete for health history, risks, plans or playbook runs by default.

---

## 6. Data Model and Persistence Design

Use the Entity Engine for ordinary CRUD, metadata, relations, validation and serialization. Use domain services for score calculation, state transitions and playbook execution. **Do not create a second ORM or entity registry.**

### 6.1 Required domain entities

**A. `CustomerSuccessProfile`** — one per Account. The portfolio-facing record: current lifecycle, CSM owner/team, latest health summary, onboarding/renewal summaries, override state. Latest values are a read-optimized summary; snapshots remain the source for explaining changes.

**B. `CustomerSuccessHealthSnapshot`** — append-only calculation result: score, calculated/effective state, source, configuration version, components, signal coverage, calculation time, result status. Index for profile/date and portfolio trend queries.

**C. `CustomerSuccessScoringConfig`** (or a versioned slice of the module settings row) — signal definitions, weights, status thresholds, freshness windows, minimum coverage, missing-data policy, enabled state. No executable script bodies. Prefer the existing versioned `app_settings` store over a redundant table (§3.5).

**D. `CustomerSuccessPlan`** — Account/profile outcome plan with owner, timeframe, status, summary and optional template/source links.

**E. `CustomerSuccessGoal`** — measurable goal inside a plan: baseline/target/current value, unit, direction, owner, due date, source, progress, status.

**F. `CustomerSuccessRisk`** — risk/mitigation record with severity, type, owner, evidence, next action, due dates, status, resolution.

**G. `CustomerSuccessPlaybookTemplate`** — reusable, versioned template with validated step configuration.

**H. `CustomerSuccessPlaybookRun`** — execution instance with idempotency key, template version snapshot, status, and step-record relations.

**I. `CustomerSuccessPlaybookStepRun`** — individual step status, due date, assignee, linked record, completion/skip reason, retry-safe failure state.

**J. `CustomerSuccessReview`** *(conditional)* — only if generic Activities cannot safely represent structured success-review content. Must link to an existing Activity and must not duplicate scheduling/lifecycle semantics.

**K. Onboarding entities** *(conditional)* — prefer Playbook Run + Step Run. Do not create separate onboarding task/checklist tables if the playbook model already covers the use case. Add a dedicated onboarding record only if it materially simplifies status reporting and cannot be represented safely in Profile + Playbook Run.

### 6.2 Metadata registration

- Register all entities in **`database/seed-metadata.ts`** (§3.3), not in an extension `metadata/entities.json`.
- Reuse the shared field helpers already there: `standardFields` for the common columns and `activityFields` when a CS entity links activities.
- Define `relations` so the generic related-records endpoints resolve (`oneToMany` + `mappedBy`, `manyMany` to `Account`/`Contact`).
- Declare `layouts` (list/detail/edit with `panels` and `position`) so the metadata-driven SPA renders them with no custom React.
- Declare `acl.permissions` defaults per entity, following the `Project` example.
- Declare `indexes` as metadata only; create physical indexes in the migration.

### 6.3 Relationships

- Account 1 — 0..1 `CustomerSuccessProfile`
- User 1 — many owned profiles; Team 1 — many profiles
- Profile 1 — many HealthSnapshots, SuccessPlans, Risks, PlaybookRuns
- SuccessPlan 1 — many SuccessGoals
- PlaybookTemplate 1 — many PlaybookRuns; PlaybookRun 1 — many PlaybookStepRuns
- A step run may link to an existing Activity/Task/Notification or to an allowed record produced by the step
- Optional relations to Contact, Project, ProjectTask, Opportunity, Subscription, Case and Activity are registered **only when the target entity is present** (§3.7)

All relations are checked server-side and obey ACL at both endpoints. A relationship to a visible Profile must never grant access to an otherwise inaccessible related record.

### 6.4 Database constraints and indexing

In `032_phase19_customer_success.sql`:

- A **unique index on active Profile `accountId`**. Because records are soft-deleted (`deleted_at`), the index must be partial: exclude rows where `deleted_at IS NOT NULL`, so an archived profile does not block a new one.
- FK/deletion behavior consistent with the platform's soft-delete model.
- Partial expression indexes following the established pattern, e.g. `entity_records ((attrs ->> 'accountId')) WHERE entity_type = 'CustomerSuccessProfile' AND deleted_at IS NULL`.
- Composite index for HealthSnapshot `(profileId, calculatedAt DESC)` or the closest supported equivalent.
- Indexes for open risk lists by `(profileId, status, severity, dueDate)`, for open PlaybookStepRuns by assignee/status/due date, and for Goals by plan/status/due date, as query patterns justify.
- Unique/idempotency constraint on a PlaybookRun trigger key where a trigger must run once per record/window/template version.

Do not over-index. Capture the query patterns and verify important indexes against the configured database's query plans when practical.

### 6.5 JSON and structured fields

JSONB (`attrs`) is the established storage for non-physical attributes. If it is used for versioned score components or playbook step snapshots:

- Frequently filtered and joined fields stay typed metadata fields, not buried only in JSON.
- Every JSON payload carries an explicit version field and a validated schema.
- No raw unbounded activity bodies or large customer blobs in score snapshots.
- No JSON value is ever interpolated into a SQL string.
- Any JSONB index must be justified by a real query pattern.

### 6.6 Migration strategy

- One additive migration: `database/migrations/032_phase19_customer_success.sql`.
- Prefer nullable fields and staged rollouts before introducing required values on populated tables.
- **Do not silently create a Profile for every Account on application boot.** Backfill only through an explicit, resumable, idempotent job or an administrator-triggered command.
- Backfill jobs support dry-run/preview where feasible, progress reporting, restartability and per-record error reporting.
- Seed default lifecycle/scoring/template records under idempotent keys; never overwrite user-modified settings.
- Never drop historical tables/columns during a normal upgrade or module deactivation.

---

## 7. Domain Services and Events

Keep controllers thin. Put business behavior in injected services and expose stable interfaces to jobs, event handlers and the UI API.

### 7.1 Services

Follow the barrel/provider convention: each service is `@Injectable()`, listed in `CUSTOMER_SUCCESS_PROVIDERS`, and constructed with explicit `DatabaseService`/`METADATA_STORE`/`REQUEST_SCOPE_TOKEN` injection as `SalesSettingsService` does.

- `CustomerSuccessProfileService` — create/update, assignment, Account binding, lifecycle summary
- `CustomerSuccessPortfolioService` — portfolio queues and ACL-filtered aggregates
- `CustomerSuccessLifecycleService` — validated transitions and reasons
- `CustomerSuccessHealthService` — signal collection, weight normalization, score calculation, threshold classification, configuration version resolution
- `CustomerSuccessHealthSnapshotService` — history writes, deduplication, trend queries, retention policy that preserves required audit history
- `HealthSignalRegistry` — registers built-in and optional provider adapters
- `CustomerSuccessOnboardingService` — start, completion, pause, cancel, blockers, progress summary
- `CustomerSuccessPlanService` — creation, transition, copy-from-template, summary
- `CustomerSuccessGoalService` — value updates, progress calculation, checkpoints, overdue logic
- `CustomerSuccessRiskService` — triage, ownership, mitigation, escalation, resolution, health impact
- `CustomerSuccessRenewalService` — renewal summary, source precedence, due windows, source references
- `CustomerSuccessTouchpointService` — meaningful-touch eligibility and structured review integration
- `CustomerSuccessPlaybookService` — template validation, start, run transitions, cancellation, retry, step linking
- `CustomerSuccessAutomationService` — guarded automation rules and idempotency
- `CustomerSuccessSettingsService` — validated, versioned configuration in the `app_settings` row
- `CustomerSuccessModuleHealthService` — dependency evidence, optional integrations, features, settings warnings, checks (mirror `SalesModuleHealthService`)
- `CustomerSuccessModule` descriptor in `customer-success-module.ts` — `CUSTOMER_SUCCESS_MODULE`, `REQUIRED_PLATFORM_CAPABILITIES`, `OPTIONAL_INTEGRATIONS`, `CUSTOMER_SUCCESS_FEATURES`

Do not create a service that merely wraps one trivial repository call unless that is already the repository convention.

### 7.2 Domain events

Follow the existing event naming/payload contract: stable IDs, timestamps, context where supported, correlation IDs.

- `customerSuccess.profile.created`
- `customerSuccess.profile.assigned`
- `customerSuccess.lifecycle.changed`
- `customerSuccess.health.recalculation.requested`
- `customerSuccess.health.calculated`
- `customerSuccess.health.statusChanged`
- `customerSuccess.health.overrideSet`
- `customerSuccess.health.overrideExpired`
- `customerSuccess.onboarding.started`
- `customerSuccess.onboarding.completed`
- `customerSuccess.plan.activated`
- `customerSuccess.goal.progressChanged`
- `customerSuccess.goal.overdue`
- `customerSuccess.risk.created`
- `customerSuccess.risk.escalated`
- `customerSuccess.risk.resolved`
- `customerSuccess.renewal.windowEntered`
- `customerSuccess.review.scheduled`
- `customerSuccess.playbook.started`
- `customerSuccess.playbook.stepCompleted`
- `customerSuccess.playbook.failed`
- `customerSuccess.playbook.completed`

Event requirements:

- Publish only after the associated transaction commits, or through the transactional outbox (`apps/api/src/common/outbox.service.ts`).
- Consumers must be idempotent.
- Never publish a payload exposing fields the consumer's context may not access.
- Avoid embedding full entities; prefer IDs and small, non-sensitive facts.
- Define retry and poison-message handling per the existing queue conventions.
- Health update events must not recursively cause unbounded recalculation.

---

## 8. API Design

### 8.1 Entity resources

**No controller needed.** Entities registered in `seed-metadata.ts` are served by the generic `/api/v1/:entity` routes:

- `/api/v1/CustomerSuccessProfile`
- `/api/v1/CustomerSuccessHealthSnapshot` (read-only for normal users)
- `/api/v1/CustomerSuccessPlan`
- `/api/v1/CustomerSuccessGoal`
- `/api/v1/CustomerSuccessRisk`
- `/api/v1/CustomerSuccessPlaybookTemplate`
- `/api/v1/CustomerSuccessPlaybookRun`
- `/api/v1/CustomerSuccessPlaybookStepRun`
- `/api/v1/CustomerSuccessReview` only if conditionally implemented

Do not expose internal storage details as a separate external contract.

### 8.2 Domain actions

Follow the shipped convention exactly: a **PascalCase static prefix** `/api/v1/CustomerSuccess/action/*` registered **before** `ENTITY_CONTROLLERS` in `app.module.ts`. There is no kebab-case route in this repository.

| Method | Route | Access | Purpose |
|---|---|---|---|
| `GET` | `/api/v1/CustomerSuccess/action/health` | administrator | module descriptor, dependency evidence, optional integrations, features, settings warnings, checks |
| `GET` | `/api/v1/CustomerSuccess/action/settings` | authenticated | validated settings document + computed defaults + warnings |
| `POST` | `/api/v1/CustomerSuccess/action/settings` | administrator | validated patch; bumps the settings version |
| `POST` | `/api/v1/CustomerSuccess/action/recalculateHealth` | record ACL | on-demand recalculation for one profile |
| `GET` | `/api/v1/CustomerSuccess/action/healthHistory` | record ACL | score history for one profile |
| `GET` | `/api/v1/CustomerSuccess/action/healthExplanation` | record ACL | component-level explanation |
| `POST` | `/api/v1/CustomerSuccess/action/setHealthOverride` | elevated | set override with reason and optional expiry |
| `POST` | `/api/v1/CustomerSuccess/action/clearHealthOverride` | elevated | clear override, audit the actor and reason |
| `POST` | `/api/v1/CustomerSuccess/action/transitionLifecycle` | record ACL | validated lifecycle transition with reason |
| `POST` | `/api/v1/CustomerSuccess/action/startOnboarding` | record ACL | start onboarding, idempotently |
| `POST` | `/api/v1/CustomerSuccess/action/startPlaybook` | record ACL | start a playbook run, idempotently |
| `GET` | `/api/v1/CustomerSuccess/action/portfolioSummary` | authenticated | ACL-filtered portfolio aggregate |
| `GET` | `/api/v1/CustomerSuccess/action/portfolioQueues` | authenticated | the §5.2 queues |
| `POST` | `/api/v1/CustomerSuccess/action/activatePlan` | record ACL | plan lifecycle transition |
| `POST` | `/api/v1/CustomerSuccess/action/completePlan` | record ACL | plan lifecycle transition |
| `POST` | `/api/v1/CustomerSuccess/action/updateGoalProgress` | record ACL | controlled goal measurement update |
| `POST` | `/api/v1/CustomerSuccess/action/escalateRisk` | record ACL | idempotent escalation |
| `POST` | `/api/v1/CustomerSuccess/action/resolveRisk` | record ACL | resolution with outcome reason |
| `GET` | `/api/v1/CustomerSuccess/action/renewalSummary` | authenticated | renewal readiness view |
| `POST` | `/api/v1/CustomerSuccess/action/cancelPlaybookRun` | record ACL | cancel a run, preserving history |
| `POST` | `/api/v1/CustomerSuccess/action/retryFailedSteps` | record ACL | safe retry of failed steps only |
| `POST` | `/api/v1/CustomerSuccess/action/bulkRecalculateHealth` | administrator | async/batched admin recalculation with progress |

Validate request bodies with **Zod** schemas in `dto/customer-success-shapes.ts`, `.strict()`, returning `422` in the kernel error envelope on failure — mirroring `apps/api/src/sales/dto/sales-shapes.ts`.

### 8.3 API rules

- Authenticate every non-public route.
- Apply the same global, team, record and field-level ACL used by normal entity APIs, via `AclApiService` — never a local re-implementation.
- Validate related IDs against the actor's accessible records.
- Validate every state transition server-side.
- Reject unknown/unsupported fields per repository convention.
- Paginate lists and history with bounded page sizes.
- Use optimistic concurrency on state transitions: the `version` column exists for exactly this (§3.3).
- Use transactions for multi-record operations such as starting a playbook and creating its first step records.
- Return stable error codes for: permission denied, invalid transition, stale version, duplicate profile, configuration invalid, missing integration.
- Prevent IDOR: holding a Profile ID must not grant access to its Account, Contacts, Activities, health snapshots or external-linked records.
- Health snapshot writes and calculated fields must never be accepted from an ordinary create/update payload.
- Document endpoints in the existing OpenAPI system with synthetic examples — never real customer data.
- Never expose stack traces, SQL, raw provider errors or secret configuration.

---

## 9. Permissions and Security

Authorization is a server-side requirement. UI hiding is not access control.

### 9.1 Permission scopes

Register scopes using the repository's role/ACL pattern — entity-level permissions in `acl.permissions` plus field restrictions in `field_permissions`:

- Profile: read, create, edit, delete/archive, assign CSM, bulk assign
- Health: read current health/history, request recalculation, set/clear override, manage scoring settings
- Success Plans: read, create, edit, activate, complete, cancel, copy template
- Success Goals: read, create, edit, update measurements, mark complete/blocked
- Risks: read, create, edit, assign, escalate, resolve, close/reopen
- Playbook Templates: read, create, edit, activate/deactivate
- Playbook Runs: read, start, cancel, retry, override a step
- Reviews: read/create/edit structured review, if implemented
- Administration: configure lifecycle/scoring/renewal/playbook settings, manage defaults, run bulk recalculation

Use the established level vocabulary `yes | all | team | own | no` (`packages/acl`). Do not invent a parallel ACL vocabulary.

### 9.2 Record access policy

- Admins access records under existing platform admin semantics (`RequestScope.isAdmin`).
- CSMs access profiles assigned to them where current role rules allow.
- Team leads access team portfolios only where team ACL grants it.
- Account owners may gain access through existing Account ACL; do not assume ownership implies access where platform policy says otherwise.
- Other users need role/team/record ACL permission.
- Assignment requires permission to assign **and** permission to access the destination user/team and the Account.
- Related Activities, Contacts, Opportunities, Projects and Subscriptions keep their own ACL.
- **Aggregate SQL must scope rows before aggregating**, never filter inaccessible names after building the result.

### 9.3 Field and operation security

- Protect health overrides, scoring configuration, lifecycle policy, playbook automation and source precedence with elevated permission.
- A normal client cannot write a calculated score, health snapshot, calculation state, audit actor or system-managed timestamp.
- A user cannot assign a risk or goal to an inaccessible User/Team, or link to an inaccessible record.
- Prevent users from executing arbitrary expressions, SQL, JavaScript, URLs, file paths or provider calls through rules or configuration. The sandboxed `@carocrm/formula` engine is the only expression facility permitted, and only if a use case genuinely needs it.
- Use safe escaping and parameterized queries for search and filters.
- Validate uploaded artifacts under the existing Attachments/file policy if playbooks permit files; otherwise do not add upload handling.
- Keep a complete audit trail for security-sensitive operations.

### 9.4 Privacy and retention

- Retain only what CSM workflows need.
- Never store credentials, access tokens, payment details or raw third-party event payloads inside CSM entities.
- Health explanations identify a source by a permitted label/reference and never display sensitive Activity/Case body content.
- Follow platform export, deletion, privacy and retention behavior. Where audit requirements conflict with deleting operational content, use the established policy rather than inventing ad hoc behavior.

---

## 10. React UI and User Experience

Use the existing React SPA, router, design system, metadata layouts, forms, field components, tables, filter engine and permission hooks. **Do not build a standalone frontend or second component system.**

Entities registered with `layouts` in `seed-metadata.ts` render through the generic metadata-driven UI with no custom React. Dedicated screens are optional polish, exactly as stated for Sales in `docs/modules/sales/README.md`.

### 10.1 Navigation

Register entries using the established module navigation metadata. Suggested area: **Customer Success**, with pages for Portfolio Overview, Customer Profiles, Onboarding, Success Plans, Goals, Risks, Renewals, Playbooks, and a permission-gated Administration/Settings page. Hide or disable unavailable optional features instead of navigating to broken pages.

### 10.2 Customer profile experience

Profile detail should present a readable summary with: Account name and link; CSM and team; lifecycle stage and segment; effective health status and numeric score; calculated status vs manual override indicator; health trend and last calculation date; the most important score component explanations; active Success Plan and goal progress; onboarding state and next incomplete step; open risks and mitigation due dates; renewal date/window and renewal source; last meaningful touch and next planned review; and authorized quick actions (Recalculate Health, Create Success Plan, Start Playbook, Schedule Review, Assign CSM, Log Risk).

Suggested panels/tabs: Overview; Health History; Success Plans & Goals; Risks; Onboarding / Playbooks; Activities & Reviews; Stream / Notes; Related Records.

Render a tab only when its data source is available and the user may access it.

### 10.3 Visual health explanation

Health must display more than a color: score/status; trend (improving/stable/declining/unknown) over a documented comparison window; last calculation time; valid signal coverage; the main positive/negative factors with explanatory labels; whether the status is manually overridden; and links to history and readable source records.

**Never use color alone.** Provide text/icon/accessible labels, keyboard support and adequate contrast.

### 10.4 Portfolio and queue UX

- Default to an actionable, user-filterable portfolio.
- Clear empty/loading/error states; never represent provider failure as an empty healthy portfolio.
- Filters for CSM/team, health, lifecycle, segment, onboarding, renewal window, overdue risks, goals, last touch and next review.
- Server-side filtering and pagination; never fetch all customers and filter in the browser.
- Preserve existing list conventions (column configuration, saved views, search, selection, row actions).
- Bulk operations preview scope and report failures per record.

### 10.5 Responsive and accessible behavior

- Support existing breakpoints.
- Keyboard-operable forms, labels associated with controls, validation messages announced appropriately.
- Status never conveyed only by green/yellow/red.
- Chart details available through accessible legends/tooltips or an equivalent data table.
- Long Account names, translated labels and missing data must not break layouts.

---

## 11. Notifications and Scheduled Jobs

Use only the current platform job queue, scheduler and notification storage. **Do not create per-feature worker processes or in-memory timers.**

### 11.1 Scheduled jobs

Register handlers in `apps/worker/src/handlers/` via a `registerCustomerSuccessJobs(registry, deps)` following `registerSalesJobs` (`apps/worker/src/handlers/sales-handlers.ts:170`). The seed installs the cron rows.

| Job | Purpose |
|---|---|
| `customerSuccess.recalculateHealthBatch` | recalculate profiles due for refresh, bounded batches |
| `customerSuccess.expireHealthOverrides` | expire overrides, restore effective calculated status with history |
| `customerSuccess.updateGoalOverdueState` | update overdue indicators without unnecessary row churn |
| `customerSuccess.evaluateRenewalWindows` | detect newly entered configured renewal windows |
| `customerSuccess.evaluateRiskEscalations` | find overdue/high-severity risks needing review |
| `customerSuccess.evaluateReviewReminders` | remind owners about upcoming/overdue reviews |
| `customerSuccess.processPlaybookWaitSteps` | resume runs whose wait steps are due |
| `customerSuccess.repairStalePlaybookRuns` | identify stuck runs; repair only through explicitly safe transitions |

Each job must:

- use bounded batch sizes and stable ordering/cursors;
- be idempotent and safe to retry;
- record start/end time, processed/skipped/error counts and duration, without logging sensitive customer content;
- avoid selecting records the executor cannot access — system jobs use the documented service-authority model, not a user context;
- never perform unbounded full-table work inside a web request;
- be pausable through the normal operations/settings mechanism;
- use distributed locking or idempotency if the scheduler may run more than one instance;
- avoid recurring notifications for the same condition unless a cadence is explicitly configured.

### 11.2 Notification triggers

In-app notifications only. Candidates: health dropped to `atRisk`/`critical`; an override about to expire or needing review; a Critical risk created, escalated or overdue; onboarding overdue steps or an at-risk target date; a goal past its due date; a renewal window opened with no owner/action; a review due/overdue; a playbook run/step failed; a profile reassigned or left unassigned.

Every rule defines recipient selection, a deduplication key, severity, cadence, opt-out/admin setting where applicable, and deep-link ACL behavior. Never leak Account details through a notification preview to a user without access.

### 11.3 Notification storage — read this before implementing

There is **no notification service** in the platform (§3.6). The `notifications` table exists and the established writer is a worker job handler (`apps/worker/src/handlers/job-handlers.ts:132`). Therefore:

- Do not invent `CustomerSuccessNotificationService` as a wrapper around a non-existent service.
- Either write `notifications` rows from an established job handler following the `system.sendReminders` pattern, or add the smallest genuinely reusable notification writer to the kernel and document it as a platform change (§3.9).
- Whichever is chosen, state it explicitly in the audit document.
- **Tests may create `notifications` rows; they must never trigger real outbound delivery.**

---

## 12. Integrations with Other Modules

Implement adapters so optional modules can be absent without breaking Customer Success. **Detect through the metadata registry; never import an optional module in a way that creates a mandatory boot-time dependency.**

### 12.1 Accounts and Contacts

Required foundation. Account remains the canonical customer record. Contacts provide stakeholders, sponsor and review participants. Use existing relations and field-level ACL.

### 12.2 Activities and Calendar

Use the existing `Task`, `Call`, `Meeting`, `Reminder` and `Email` entities plus Calendar integration. Define qualifying-touchpoint logic separately from generic Activity CRUD. Keep CSM context as an additional relation/metadata, never a second scheduler.

### 12.3 Sales and Subscriptions

Both are **present** in this repository (§3.7), so:

- Permit a link to a renewal Opportunity and show authorized summary fields.
- Use `Subscription`/`SubscriptionPeriod` as a commercial source for term and subscription state only through a defined adapter.
- **No duplicate price book, contract, invoice or billing tables.**
- A CRM user must not infer payment details they may not view merely because a CSM Profile links to a subscription.

### 12.4 Workflows and BPM

Emit the §7.2 domain events so workflows and BPM can consume them; do not re-implement either. Map event → trigger explicitly and document which recalculation paths are event-driven.

### 12.5 Projects

Projects **is present**. Optionally link a Success Plan or onboarding step to a `Project` or `ProjectTask` through the Projects module's published contract. Do not create Project/Task records inconsistently. Avoid bidirectional event loops between Project completion and CSM goal progress — map events and idempotency explicitly. Onboarding must still work with Activities/Playbook steps alone.

### 12.6 Cases / Service Desk — not available

There is **no Service Desk module** in this repository. Therefore:

- No support-derived health signal is implemented.
- The health configuration surface must still permit a future `support` signal family, reported as `unavailable` rather than `failed`.
- Do not invent a `Case` entity or ticket storage as part of this phase.

### 12.7 External adoption analytics — future extension point

Before implementing any connector, define an adapter contract:

- source/provider ID;
- last successful sync time;
- customer/account mapping and mapping confidence;
- normalized metric key, value, period and unit;
- freshness and backfill behavior;
- source permission and retention classification;
- duplicate/out-of-order event handling.

**Do not make vendor API calls from controllers or the score calculator.** Any connector must use the repository's integration/secrets/job infrastructure and be an explicit later task.

### 12.8 Sales detection constraint — binding

`apps/api/src/sales/sales-module.ts` already declares:

```ts
{
  id: "customer-success",
  label: "Customer Success",
  provides: "Customer health, renewal tracking (consumer of Sales summaries)",
  markerEntity: "CustomerSuccessProfile",
}
```

`SalesModuleHealthService` resolves that marker against `metadata.registry.getEntities()` and reports the integration `available` or `unavailable` to an administrator on `GET /api/v1/Sales/action/health`. Its tests assert the absence case.

Consequences for this module:

1. **`CustomerSuccessProfile` must be registered as a metadata entity with exactly this name.** It is the shipped integration contract, not a stylistic choice.
2. The module id `CustomerSuccess` carries **no prefix**; the entity names keep one. These are independent choices — §4.1 states both.
3. Do not rename, alias or move the marker without also updating `sales-module.ts` **and** `sales-module-health.service.ts` **and** the Sales tests, in the same change. A silent rename turns a working integration into a permanently "unavailable" one with no error.
4. Verify after implementation: with the module present, `GET /api/v1/Sales/action/health` reports Customer Success as `available`.

---

## 13. Configuration, Events and State-Machine Invariants

These hold regardless of which UI or API path is used:

1. One active `CustomerSuccessProfile` per Account.
2. Health score is null/`unknown` when the configured minimum signal coverage is not met.
3. A manual override never overwrites the calculated score or calculated status.
4. Health snapshots cannot be created or edited by normal CRUD requests.
5. Every override has a reason, an actor, a timestamp and configured review/expiry behavior.
6. Lifecycle transitions are validated and audited server-side.
7. `churned` is never inferred solely from a score, a missing subscription, a missing opportunity or a Critical risk.
8. Goal progress is bounded and computed with the direction-specific algorithm.
9. Completing a plan does not automatically mark every goal achieved; goal outcomes remain explicit.
10. Starting the same triggerable playbook twice with the same idempotency key creates no duplicate runs, steps or actions.
11. A completed playbook step is not rerun when retrying a failed step.
12. A failed optional-integration signal does not fail the whole Profile read.
13. User-visible related records are independently authorization-checked.
14. Events that initiate jobs are published after transaction commit or via the transactional outbox.
15. Background jobs never send external customer communications by default.
16. Seed/default operations are repeatable and never overwrite administrator-edited settings.
17. Feature-flag deactivation never destroys customer success history.

---

## 14. Implementation Roadmap — Phase 19-CS

Build incrementally, one sub-phase at a time. Sub-phase identifiers use `19-CS.*` so they coexist with `19-S.*` and the Projects identifiers. **Do not implement later phases in the same pass as an earlier one.**

### Phase 19-CS.0 — Repository Audit and Feature Contract

Tasks:
- Read `AGENTS.MD`, the relevant `PLAN.md` sections, `docs/module-guide.md`, and the Sales and Projects plans plus their audit/module docs.
- Re-verify §3 against the working tree; treat any drift as a finding.
- Confirm which optional providers (§3.7) are present and how each is detected.
- Write `docs/implementation/customer-success-repository-audit.md`.
- Define `docs/modules/customer-success/compatibility.md` recording custom-module behavior and known differences from the EspoCRM baseline.
- Finalize the minimum CSM entity set using existing metadata conventions.

Exit criteria:
- No unsupported subsystem is assumed to exist.
- All mandatory prerequisites are verified with exact code locations.
- Optional integrations are clearly marked present/absent.
- The Sales marker constraint (§12.8) is recorded.

### Phase 19-CS.1 — Module Scaffold and Registration

Tasks:
- Create `apps/api/src/customer-success/` with a barrel exporting `CUSTOMER_SUCCESS_CONTROLLERS` and `CUSTOMER_SUCCESS_PROVIDERS`.
- Add `customer-success-module.ts` with `CUSTOMER_SUCCESS_MODULE` (id `CustomerSuccess`, `loadOrder` after Sales' `320`), `REQUIRED_PLATFORM_CAPABILITIES`, `OPTIONAL_INTEGRATIONS` and `CUSTOMER_SUCCESS_FEATURES`.
- Register providers and controllers in `apps/api/src/app.module.ts`, spreading controllers **before** `ENTITY_CONTROLLERS`.
- Add `CustomerSuccessModuleHealthService` and expose `GET /api/v1/CustomerSuccess/action/health`.
- Add the validated, versioned `app_settings` row named `customerSuccess` via `CustomerSuccessSettingsService`.
- Confirm the app boots with optional integrations absent.

Exit criteria:
- The application boots with the module registered.
- No duplicate providers or naming conflicts.
- The health endpoint reports real evidence, never hard-coded `true`.
- Controller ordering is verified against the generic `:entity` wildcard.

### Phase 19-CS.2 — Metadata, Schema and Core Profile

Tasks:
- Define `CustomerSuccessProfile` metadata in `database/seed-metadata.ts`: fields, relations, layouts, ACL defaults, index declarations.
- Write and review `database/migrations/032_phase19_customer_success.sql` with the partial unique index on active `accountId` and supporting expression indexes.
- Implement server-side Account/owner/team relation validation.
- Add safe, permission-aware Profile creation and update services.
- Register idempotent default settings that never overwrite existing values.

Exit criteria:
- A permitted user can create/read/update a Profile for a permitted Account.
- Duplicate active profiles are blocked by **both** service validation and a database constraint.
- Ordinary API input cannot set system-calculated fields.
- The migration preserves all existing CRM data.

### Phase 19-CS.3 — Portfolio, Assignment and Lifecycle

Tasks:
- CSM assignment/reassignment with audit and events.
- Lifecycle configuration, server-side transition rules, reason requirements, history.
- My Portfolio, Team Portfolio, Unassigned and lifecycle queues via ACL-scoped queries.
- Filters, sort rules, pagination, saved views, and bulk assignment/transition where supported.
- Per-record bulk results.

Exit criteria:
- CSM, team-lead, admin and unauthorized-user tests pass.
- Lifecycle and assignment cannot be changed by bypassing UI rules.
- Portfolio aggregates do not leak inaccessible Accounts.

### Phase 19-CS.4 — Health Scoring Configuration and Built-in Signals

Tasks:
- `HealthSignalProvider` contract and `HealthSignalRegistry`.
- Providers backed only by verified data (§5.4.2) — support and adoption stay unavailable.
- Versioned scoring configuration with weight/threshold validation, freshness windows, missing-data policy and minimum coverage.
- Deterministic weighted score computation and classification.
- Unit tests for no-signal, stale-signal, partial-coverage, rounding, weight normalization, threshold boundaries and invalid configuration.

Exit criteria:
- Score computation is a pure, testable domain operation.
- `unknown` is never treated as zero.
- Invalid configuration is rejected with actionable errors.
- No optional integration is assumed available.

### Phase 19-CS.5 — Health Snapshots, Explanation and History

Tasks:
- Append-only snapshot persistence and score-history queries.
- Store configuration version, signal coverage, component values/weights, calculation source and result state.
- Snapshot deduplication and material-change rules.
- Manual on-demand recalculation with rate limits.
- Explanation and trend actions; read-only access controls.
- Manual override/clear flow with reason, audit, expiry policy and separate calculated/effective status.

Exit criteria:
- Users can explain a health result and trace it to permitted data.
- An override never rewrites the calculated score.
- Normal CRUD cannot forge or delete snapshots.
- Repeated identical recalculation follows the documented deduplication policy.

### Phase 19-CS.6 — Success Plans and Goals

Tasks:
- `CustomerSuccessPlan` and `CustomerSuccessGoal` metadata, relationships, permissions, layouts and API.
- Plan state transitions, one-primary-active-plan rule, templates and copy behavior.
- Direction-aware goal progress and checkpoint/audit history.
- Plan summary recalculation, with health updates queued only when relevant.
- Account/Profile related panels.

Exit criteria:
- Goal progress is correct for `increase`, `decrease`, `maintain`, `boolean` and `manual`, including edge cases.
- Historical plans/goals remain auditable.
- Project links work only when Projects is present, and the module works without it.

### Phase 19-CS.7 — Risks, Mitigation and Escalation

Tasks:
- `CustomerSuccessRisk` entity and transitions.
- Severity, owner, due dates, evidence, mitigation, escalation, resolution reason and reopening.
- Queues for High/Critical, overdue, unassigned and recently changed risks.
- Health-signal adapter for open risks.
- In-app alerts per §11.3.

Exit criteria:
- Risk transitions are validated, permission-checked and audited.
- High/Critical risks have mitigation or a documented exception.
- A risk may influence health but never sets lifecycle to `churned`.

### Phase 19-CS.8 — Onboarding and Playbook Core

Tasks:
- Playbook Template, Run and Step Run entities and services.
- Step-schema validation and a supported step-type registry.
- Manual run start, template version snapshot, step completion/skip, pause/cancel, safe retry.
- Onboarding defaults and Profile onboarding summaries.
- Link human-work steps to existing Activities/Tasks.
- Idempotency keys and transaction-safe run creation.

Exit criteria:
- A user can start and execute an onboarding playbook end to end.
- Duplicate requests/events create no duplicate runs or tasks.
- Editing a template does not mutate an existing run.
- No arbitrary script execution and no direct external communication.

### Phase 19-CS.9 — Success Reviews and Touchpoint Integration

Tasks:
- Integrate the existing Activities, Calendar, Stream and Contacts.
- Define and test meaningful-touch eligibility rules.
- Add `CustomerSuccessReview` only if Activities cannot represent structured review fields safely.
- Link reviews to existing Activity records; track next review date.
- Recent-activity, last-meaningful-touch and next-review summaries.

Exit criteria:
- No duplicate scheduling or activity system exists.
- Activity ACL remains intact across Profile/Account panels.
- Engagement signals exclude unrelated/internal events per the rule set.

### Phase 19-CS.10 — Renewal Readiness and Domain Adapters

Tasks:
- Manual renewal readiness and window queries.
- Source precedence and freshness for external/commercial renewal dates.
- Adapters for Opportunity, Subscription and Projects — the modules that actually exist.
- Data-source health indicators and safe fallbacks.
- Renewal queues and source-record links.

Exit criteria:
- Renewal readiness works with manual fields alone.
- Source errors never erase valid manual data.
- A CSM cannot view linked commercial/support details beyond existing ACL.

### Phase 19-CS.11 — Jobs, Triggers and Notifications

Tasks:
- Register the §11.1 jobs and their cron rows.
- Event-triggered recalculation for supported sources.
- Outbox integration, idempotency, concurrency controls, retry and observability.
- Notification deduplication and recipient rules, following §11.3.
- Ensure tests disable outbound email/webhooks and write only in-app `notifications` rows.

Exit criteria:
- Jobs are retry-safe, bounded, monitored and pausable through established controls.
- No event recursion and no notification storms in tests.
- No in-memory timer, custom scheduler or custom queue is introduced.

### Phase 19-CS.12 — React UI and Navigation

Tasks:
- Navigation and Portfolio Overview using existing route/metadata conventions.
- Profile list/detail, health explanation/history, plan/goal panels, risk queues, onboarding/playbook views, review links, renewal queues.
- Admin configuration pages for stages, health scoring, playbook defaults and renewal windows.
- Accessibility, loading/error/empty states, responsive behavior, permission-gated quick actions.
- Use the existing design system and chart components.

Exit criteria:
- Main CSM workflows complete through the SPA without manual API calls.
- The UI never reveals unauthorized records and never relies on color alone.
- All critical mutations are validated server-side.

### Phase 19-CS.13 — Dashboards, Search, Bulk Operations and Export

Tasks:
- CSM dashlets and portfolio summaries through the existing dashboard framework, following the `project-dashlet.service.ts` pattern.
- Searchable/filterable fields and safe drill-down.
- Bulk recalculate/assign/transition/playbook-start only where safe.
- Reuse generic import/export.
- Performance indexes based on measured query patterns.

Exit criteria:
- Dashboard aggregates honor ACL.
- Large lists are paginated and filtered server-side.
- Bulk operations return precise per-record results.

### Phase 19-CS.14 — Security, Compatibility and Data Safety Review

Tasks:
- Review every route/action for authorization bypass and IDOR.
- Review scoring/configuration validation, query construction, JSON payloads, event consumers and job authority.
- Verify the §12.8 Sales marker actually reports `available`.
- Test migrations against the already-configured primary database after inspection; **do not create another database**.
- Verify feature-flag deactivation behavior and retention of CSM history.
- Document custom behavior, optional-integration status, limitations and operator setup.
- Run unit tests, type-check, lint and safe integration/API checks using the existing test lifecycle.

Exit criteria:
- All required acceptance criteria are met.
- No extra database has been created.
- No destructive data change was made without explicit task-specific authorization.
- Actual test commands and results are recorded.

---

## 15. Testing Strategy

All database-backed tests MUST follow `AGENTS.MD` and `docs/module-guide.md` → "Test database policy". **Do not create a new database to satisfy a test framework default.**

Verified test layout:

- `vitest.config.ts` includes `apps/api/test/**/*.test.ts` and `packages/*/src/**/*.test.ts`. There is **no `globalSetup` and no `setupFiles`** — nothing in the runner creates, resets, drops or clones a database.
- `pool: 'forks'`, `singleFork: true` — suites run serially. `testTimeout` / `hookTimeout` are 120 s.
- Tests boot the API in-process (`apps/api/test/support/boot-api.ts`), create records through the **real HTTP API** with `AGENT_TEST_<runId>` markers, and delete exactly those IDs in `cleanup()`.

A unit test placed in `apps/api/src/customer-success/*.test.ts` **will not run** — it is outside the include globs. Put pure-logic unit tests either in `apps/api/test/` (as the Sales module does: `apps/api/test/sales-money.test.ts`, `sales-allocation-math.test.ts`) or in a `packages/*/src/*.test.ts` file.

### 15.1 Unit tests

Cover at least:

- Score normalization, weighted calculation, threshold edges, missing/stale policies, rounding, configuration version selection.
- `unknown` behavior for absent/insufficient signals.
- Manual override, expiry, calculated-vs-effective separation, reasons.
- Lifecycle transitions and required reasons.
- Goal progress for every direction, zero/negative values, equal baseline/target, overdue outcomes.
- Plan summary calculation and the active-plan rule.
- Risk transition rules and required mitigation/resolution details.
- Playbook template validation, run snapshotting, idempotency keys, step dependencies, retry, wait-step logic.
- Meaningful-touch qualification and recency calculation.
- Renewal-window boundaries, timezone, null values, source precedence.
- Portfolio filter/sort semantics and privacy-safe aggregation rules.

### 15.2 Integration tests

Against the already-configured primary database and the established migration lifecycle:

- Profile-to-Account uniqueness and referential integrity, including that a soft-deleted profile does not block a new one.
- Health snapshot append-only behavior and profile summary update.
- Transactions for playbook start and state change.
- Goal/plan/risk persistence and relation access.
- Job idempotency and safe retry markers.
- Event/outbox behavior.
- Optional adapters return an explicit unavailable state when no provider exists.
- Migrations are additive and do not alter unrelated records.

Do not provision a separate database, shadow schema, per-test database or container.

### 15.3 API/security tests

For each key route: success, invalid input, unauthenticated, unauthorized, inaccessible related ID, invalid transition, stale/concurrent update, field-level restriction.

Specifically:

- A user cannot query or update another CSM's profile where ACL prohibits it.
- A user cannot access a `CustomerSuccessHealthSnapshot` by guessing its ID.
- A user cannot link an inaccessible Contact, Activity, Project, Opportunity or Subscription.
- A client cannot spoof a calculated score, audit actor or system status.
- Aggregation endpoints do not reveal names or counts outside the user's authorized scope.
- Playbook retries do not duplicate completed actions.
- Malformed JSONB/configuration payloads are rejected safely.
- `GET /api/v1/Sales/action/health` reports the Customer Success integration as `available` once this module is registered (§12.8).

### 15.4 UI tests

Use the existing Playwright environment (`pnpm test:e2e`) only if it does not create another database. Verify: create a profile, assign a CSM, change lifecycle, find it in the portfolio; view a health explanation and history; create a plan and goal and update progress; create/mitigate/resolve a risk; run an onboarding playbook to completion; schedule a review through the existing Activity framework; review renewal readiness and drill into a source record only when permitted; check permission-based denial and responsive layout basics.

### 15.5 Regression tests

- Core Account/Contact CRUD unchanged.
- Existing Entity Engine, API, ACL, Activities, Calendar, Stream and Jobs keep working.
- The module boots with optional Sales, Projects and Subscription data absent or marker-detected as missing.
- Deactivating module features via settings does not delete historical data or break core startup.
- No existing Account or Contact is modified by test setup unless the current run created it.

---

## 16. Acceptance Criteria

The module is complete only when all required criteria below are met.

### 16.1 Core CSM

- [ ] `CustomerSuccessProfile` is linked to Account with a unique **active** profile constraint, and the name matches the shipped Sales marker exactly (§12.8).
- [ ] Portfolio views support CSM ownership, team scope, lifecycle, health, renewal, onboarding and risk filters.
- [ ] Lifecycle transitions are validated, auditable and configurable.
- [ ] Customer-facing context is visible without duplicating the Account or Activity model.

### 16.2 Health scoring

- [ ] Scoring is deterministic, versioned and configurable.
- [ ] Missing signals are never interpreted as zero.
- [ ] Score/status explanation and snapshots are available to authorized users.
- [ ] Manual overrides preserve the calculated result and require a reason.
- [ ] Scheduled/event-triggered/on-demand calculation cannot produce an infinite loop or runaway writes.

### 16.3 Plans, goals, risks, onboarding

- [ ] Success Plans support lifecycle, owners, timeframe, goals and a progress summary.
- [ ] Goal progress is correct for all supported directions and edge cases.
- [ ] Risks support owner, severity, mitigation, due date, escalation, resolution and history.
- [ ] Onboarding/playbooks create or link existing Activities without a duplicate task system.
- [ ] Playbook execution is idempotent, observable, resumable and safe to retry.

### 16.4 Renewals and integration

- [ ] Renewal readiness works with manual fields alone.
- [ ] Optional domain integrations are metadata-detected and ACL-safe.
- [ ] Absence or failure of an optional provider never breaks core Profile operations.
- [ ] Customer Success is not a billing, support-ticketing or project-management replacement.

### 16.5 Security, data and operations

- [ ] All API operations use server-side ACL and DTO validation.
- [ ] Entity relations and aggregate queries prevent IDOR and information leakage.
- [ ] Migrations are reviewed, versioned, additive and preserve existing CRM data.
- [ ] Tests used only the already-configured database; no extra test database or schema was created.
- [ ] No broad cleanup, reset, truncation or drop was performed.
- [ ] Unit tests, type checking, lint and targeted integration/API tests pass, or the report states exactly what could not be run.
- [ ] Module documentation is updated under `docs/modules/customer-success/`.
- [ ] `docs/modules/customer-success/compatibility.md` describes custom behavior and known deviations.

---

## 17. Performance, Reliability and Observability

- Portfolio pages use server-side filtering, pagination and authorized aggregates.
- Score calculation avoids N+1 queries; load signal data in batches.
- Health batch jobs use bounded batch sizes, resumable cursors and backpressure compatible with the existing queue.
- **Never calculate every Profile synchronously during startup or on a portfolio page load.**
- Cache only where the repository's caching conventions exist; invalidate on the events that change the value. Cache keys must include the ACL/user scope for authorization-dependent aggregates.
- Use stable, bounded queries and add indexes based on measured plans.
- Track job duration, processed/skipped/failed counts, retry counts, stale profiles, unknown-health count and playbook failure count via the existing logging/metrics system.
- Never log customer message bodies, confidential notes, tokens, API keys or full database connection URLs.
- Handle deleted or inaccessible linked records without turning a portfolio page into a server error.
- On partial scoring failure, **preserve the last valid snapshot** and separately mark that the last attempt failed. Never replace a good score with an incorrect zero.

---

## 18. Documentation and Deliverables

The coding agent should deliver or update:

- `docs/implementation/customer-success-repository-audit.md`
- `docs/modules/customer-success/README.md` — setup, entities, routes, permission scopes, scoring semantics, jobs, optional integrations
- `docs/modules/customer-success/api.md` — routes and payloads
- `docs/modules/customer-success/data-model.md`
- `docs/modules/customer-success/permissions.md`
- `docs/modules/customer-success/compatibility.md` — custom behavior and deviations from the EspoCRM baseline
- `database/migrations/032_phase19_customer_success.sql` (reviewed) and metadata registrations in `database/seed-metadata.ts`
- REST/OpenAPI documentation with synthetic sample payloads
- An admin guide for scoring weights, thresholds, signal availability, lifecycle options, playbooks, notifications and renewal windows
- An operator guide for scheduled jobs, failed playbook runs, recalculation and diagnostics
- Tests and a test result summary
- A completion report mapping each sub-phase to files changed, migrations, checks actually run, results, unresolved gaps and any data writes performed

Do not report a test as passed unless the command actually ran and passed. Separate completed work, skipped work, known issues and recommendations.

---

## 19. Coding Agent Execution Rules

1. Read `AGENTS.MD` and the relevant `PLAN.md` sections before touching code.
2. Begin with Phase 19-CS.0 and inspect the real repository before implementing assumptions.
3. Implement one sub-phase at a time; keep each change reviewable and tested before moving on.
4. Reuse generic platform services. Do not build a second ORM, ACL system, Activity scheduler, notification engine, job queue, dashboard framework or settings store.
5. Preserve existing code and user changes; inspect `git status` first and never overwrite unrelated work.
6. Follow existing TypeScript style, DTO conventions, migration conventions, error handling and module registration patterns — the Sales and Projects modules are the reference.
7. Do not introduce new third-party dependencies without checking existing packages and documenting the reason.
8. Never trust UI-only authorization or client-provided calculated values.
9. Inspect any script before running it if it may create/reset a database, run seeds, trigger external communication or perform destructive migrations.
10. Use the configured primary database for targeted integration verification. **Do not create another database or schema for tests.**
11. Test data must be identifiable, narrowly scoped, and cleaned up only by exact IDs/run markers created by the current run.
12. Do not use real customer records or send real external communications in tests.
13. Do not weaken assertions, bypass ACL, swallow errors, or mark a failed migration as applied to reach a green test.
14. If a required capability is missing, document the gap and implement only the smallest reusable dependency needed; never ship a degraded feature as if it worked.
15. Finish each sub-phase with a concise report: files changed, behavior delivered, migrations/seed changes, tests actually run, results and remaining work.

---

## 20. Definition of Done

Phase 19 Customer Success is done when the module provides a secure, explainable and maintainable CSM workflow on the existing CRM platform: profiles and portfolios; lifecycle tracking; health scoring with auditable history; success plans and goals; risk mitigation; onboarding/playbooks; touchpoint and renewal readiness; useful portfolio UI; and optional integrations that degrade safely.

The implementation must use the established NestJS modular-monolith architecture, the Entity Engine, `/api/v1` conventions, ACL, event/job infrastructure, the React SPA and the configured database. It must preserve existing CRM data, avoid duplicate platform subsystems, and include tests and documentation for its domain behavior.

**Recommended coding-agent starting prompt:**

> Read `AGENTS.MD`, `PLAN.md`, `docs/module-guide.md`, `PLAN_Phase_19_Customer_Success.md`, and `docs/implementation/sales-repository-audit.md`. Execute Phase 19-CS.0 only: re-verify the audit facts against the working tree, confirm which optional providers are present and how each is detected, and write `docs/implementation/customer-success-repository-audit.md` plus `docs/modules/customer-success/compatibility.md`. Note that `CustomerSuccessProfile` is a fixed entity name required by the shipped Sales integration marker. Do not implement later phases until the audit is complete. Do not create any database or schema. Preserve existing data and changes.