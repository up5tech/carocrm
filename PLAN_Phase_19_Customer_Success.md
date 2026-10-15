# Phase 19 — Customer Success Module (`CustomerSuccess`)

> **Status:** Planned  
> **Parent roadmap:** `PLAN.md` — Phase 19: Advanced Domains  
> **Target runtime:** NestJS / TypeScript backend with the existing React SPA  
> **Primary module key:** `customer-success` (use the repository's established module-key convention if it differs)  
> **Suggested package/class name:** `CustomerSuccessModule` / `CustomerSuccessModule`  
> **Persistence:** Existing PostgreSQL + Kysely (or the repository's explicitly adopted SQL abstraction)  
> **Functional reference:** General customer-success management practices; EspoCRM's documented core CRM, ACL, metadata, Activities, API, jobs, and extension concepts  
> **Implementation rule:** Build on capabilities completed in Phases 0–18. Do not reimplement kernel functionality inside this module.

---

## 1. Purpose

Implement a first-class **Customer Success Management (CSM)** domain module for the NestJS CRM. The module gives Customer Success Managers (CSMs), account owners, and team leads a consistent way to manage customer onboarding, desired outcomes, relationship health, adoption signals, risks, renewal readiness, success plans, and proactive engagement.

This is a **clean-room, domain-oriented implementation**. It must use this repository's module conventions and platform services rather than porting PHP code or duplicating generic CRM capabilities.

### 1.1 Important reference boundary

The official EspoCRM extension catalog and developer documentation are useful references for the CRM platform and extension architecture, but the official extension catalog does not currently list a first-party extension specifically named **Customer Success**. Therefore:

- Treat this plan as a custom domain module designed for this project, informed by common CSM workflows.
- Do not claim exact feature parity with a non-existent or unverified upstream Customer Success extension.
- Preserve EspoCRM-style architectural concepts where relevant: metadata-driven entities, REST APIs, ACL, activity integration, extension registration, hooks/events, scheduled jobs, and dashboards.
- Record product-specific behavior as this project's own requirements in `docs/compatibility/customer-success.md`.
- Do not copy upstream source code, translations, icons, UI assets, or branding.

Reference pages:

- EspoCRM extension catalog: https://www.espocrm.com/extensions/
- EspoCRM developer documentation: https://docs.espocrm.com/development/
- EspoCRM modules: https://docs.espocrm.com/development/modules/
- EspoCRM metadata: https://docs.espocrm.com/development/metadata/
- EspoCRM ACL: https://docs.espocrm.com/development/acl/
- EspoCRM API: https://docs.espocrm.com/development/api/
- EspoCRM hooks: https://docs.espocrm.com/development/hooks/
- EspoCRM scheduled jobs: https://docs.espocrm.com/development/scheduled-job/
- EspoCRM attachments: https://docs.espocrm.com/development/attachments/

### 1.2 Business outcomes

At completion, authorized users must be able to:

1. Maintain one Customer Success Profile for an Account without duplicating the Account record.
2. Assign a CSM and organize the Account into a success portfolio or segment.
3. Track lifecycle stage, customer objectives, onboarding progress, adoption status, health status, and renewal readiness.
4. Calculate a configurable Customer Health Score from transparent, auditable signals.
5. View the score's components, history, trend, freshness, and reasons for changes.
6. Create success plans with measurable goals, checkpoints, owners, dates, and progress.
7. Register customer-success-specific risks, mitigations, escalation actions, and resolution outcomes.
8. Execute repeatable onboarding and engagement playbooks that create or link existing CRM activities.
9. Record success reviews and touchpoints while reusing the platform's Activities, Calendar, Stream, and Notes where possible.
10. Use portfolio dashboards, actionable lists, filters, saved views, and reports to prioritize customer work.
11. Connect to existing Opportunities, Subscriptions, Cases/Service Desk, Projects, Notifications, and Jobs only when those modules actually exist.
12. Access the module through secure APIs and metadata-driven UI with the same ACL, audit, validation, and conventions as the rest of the CRM.

### 1.3 Product principles

- **Account-centric:** Account remains the authoritative customer record.
- **Explainable health:** Users must be able to answer why an Account is Healthy, At Risk, or Critical.
- **No phantom data:** Missing signals are not treated as zero or as evidence of poor health.
- **Actionable insights:** A warning should point to evidence and a next step, not merely display a red badge.
- **Human override with history:** Authorized users may override health or lifecycle classification, but the system must preserve the calculated value, override reason, actor, and audit trail.
- **Safe automation:** Background actions are idempotent, permission-aware, observable, and prevented from generating duplicate tasks or notifications.
- **Configurable but bounded:** Admins may configure weights, thresholds, lifecycle options, playbooks, and rules within supported validation constraints.
- **Composable:** Use existing platform services and domain modules through stable interfaces.

---

## 2. Scope and Non-Goals

### 2.1 In scope

- Customer Success Profile associated one-to-one with an Account.
- CSM portfolio and assignment management.
- Lifecycle stages and customer segmentation.
- Customer health rules, calculation, score snapshots, history, explainability, and recalculation.
- Onboarding tracking and onboarding checklists/playbooks.
- Success plans, success goals, milestones/checkpoints, and progress summaries.
- Customer success risks, mitigation plans, escalation, and churn-risk workflow.
- Renewal-readiness tracking and links to existing renewal Opportunities/Subscriptions when supported.
- Success reviews/touchpoints with relevant Account/Contact/Activity links.
- Playbook templates, execution instances, steps, and completion tracking.
- Dashboards, portfolio views, health/risk queues, reminders, saved filters, and standard exports if supported by the platform.
- CSM-specific permissions and team/record-level access.
- REST endpoints, module metadata, migrations, module settings, seed/default configuration, translations, audit events, tests, and documentation.

### 2.2 Explicit non-goals for this phase

Do **not** build any of the following unless already present as a generic platform service and merely needed for integration:

- A second Account, Contact, User, Team, Activity, Calendar, Notification, Stream, Attachment, or generic task implementation.
- A separate billing/subscription engine, invoicing engine, payment gateway, or contract-signature system.
- A product analytics ingestion platform, SDK for customer applications, event warehouse, or data lake.
- A full customer-support ticketing system; integrate with Cases/Service Desk when available.
- A full project-management engine; optionally link goals or onboarding actions to the Projects module if it has been implemented.
- A full marketing automation engine, email campaign engine, or email delivery system.
- A predictive AI churn model, generative AI assistant, or opaque AI-generated score as a required MVP capability.
- A customer-facing portal or external user permissions model unless the platform's Portal module already supports this and a later sub-phase explicitly enables it.
- Automatic renewal creation, billing changes, or customer communications without explicit rules and auditable approval.
- PHP source compatibility or direct compatibility with an upstream Customer Success database schema.

### 2.3 Optional feature dependencies

The module must declare optional integration points and work sensibly when a provider is absent:

| Existing domain/service    | Use in Customer Success                                | Behavior if absent                                                                                                         |
| -------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Accounts and Contacts      | Core account, stakeholder, and contact relationships   | Required prerequisite; do not duplicate them                                                                               |
| Users and Teams            | CSM ownership, team portfolios, escalation             | Required prerequisite                                                                                                      |
| Activities / Calendar      | Calls, meetings, tasks, reminders, reviews             | Use the platform's supported fallback or mark activity automation as unavailable; do not create a parallel activity system |
| Notifications              | In-app alerts, reminders, escalation                   | Keep risk/task records visible; do not send direct external messages                                                       |
| Stream / Notes             | Timeline and relationship context                      | Omit the panel or use a supported generic note link; do not create a new stream engine                                     |
| Jobs / scheduler / queue   | Health recalculation, reminders, playbook automation   | Provide explicit manual actions for operations that cannot be scheduled; do not create a custom scheduler                  |
| Dashboard / reports        | Portfolio dashboards and saved reports                 | Provide standard list views until the generic dashboard/report framework is available                                      |
| Formula / dynamic logic    | Optional user-defined supported calculations           | Ship safe built-in rules first; do not execute arbitrary JavaScript/SQL from settings                                      |
| Cases / Service Desk       | Ticket volume, severity, SLA, resolution trends        | Ignore unsupported support signals and disclose that the data source is unavailable                                        |
| Sales / Opportunities      | Renewal opportunity and commercial status              | Allow manual renewal date/status; do not invent an Opportunity model                                                       |
| Sales Pack / Subscriptions | Active subscription, term dates, payment/billing state | Treat as optional; never create subscription or invoice logic inside CSM                                                   |
| Projects                   | Onboarding delivery and project milestones             | Store an optional reference only when Projects exists; do not require it for core onboarding                               |
| Email integration          | Customer communications and email touchpoints          | Continue with Activities/manual logging; do not assume a provider exists                                                   |
| Import/export              | Bulk portfolio administration                          | Use generic platform import/export if available; otherwise defer bulk workflows                                            |

---

## 3. Prerequisites and Repository Audit

Before changing code, the coding agent MUST read `AGENTS.MD`, `PLAN.md`, and the existing module plans relevant to the features being integrated. Inspect the actual codebase: a planned subsystem is not necessarily implemented just because it appears in a plan.

### 3.1 Verify platform capabilities

Record the existing implementation path and test command for each:

- Module registration, manifests, module dependencies, and extension hooks.
- Entity Engine, entity metadata, relationship metadata, custom fields, layouts, validation, and serialization.
- PostgreSQL/Kysely migration, query, transaction, index, and JSONB conventions.
- `/api/v1` route registration, DTO validation, error responses, pagination, filtering, sorting, and OpenAPI.
- Authentication, request context, record ACL, global role ACL, field-level ACL, teams, ownership, and admin bypass rules.
- Audit/history, domain events, hooks, Stream, Notes, Attachments, Activities, Calendar, Notifications, dashboard/dashlets, jobs, scheduler, search, reports, and formula/dynamic logic.
- React routing, generic entity views, metadata-driven forms, list filters, record panels, timeline components, and reusable chart components.
- Existing Account fields/relations and whether Account custom fields can be contributed through metadata safely.
- Existing Sales, Projects, Service Desk/Cases, email integration, and subscription entities, if any.
- Existing test lifecycle and `AGENTS.MD` database-safety requirements.

### 3.2 Audit output

Create or update `docs/implementation/customer-success-repository-audit.md` with:

- Verified prerequisites and exact code locations.
- Available module integration contracts.
- Missing capabilities that block only optional features.
- Any minimal reusable platform enhancement needed before the module.
- Known data-model or API conventions.
- A list of assumptions that were verified or rejected.

Do not use this document to restate the whole master plan. Keep it specific to the codebase findings.

### 3.3 Dependency handling

If a required generic capability is missing:

1. Identify the smallest missing abstraction and verify that no equivalent exists.
2. Decide whether the implementation belongs in the platform kernel or the Customer Success module.
3. If it is generic and reusable, implement it in the kernel only when necessary and keep its API minimal.
4. Do not duplicate ACL, activity management, background jobs, metadata handling, or dashboards inside Customer Success.
5. Document the resulting platform change separately from CSM domain features.

### 3.4 Database safety

Follow `AGENTS.MD` exactly:

- Use the already-configured primary project database for targeted integration/API/smoke tests when database verification is needed.
- Do **not** create `test_db`, `*_test`, `*_e2e`, shadow, temporary, per-agent, per-run, or other test databases or schemas.
- Inspect test scripts and test-framework lifecycle hooks before executing them; disable or fix automatic database creation/reset logic if encountered.
- Do not reset, truncate, drop, replace, or broadly delete database contents.
- Use unmistakably marked records such as `AGENT_TEST_...`; clean up only records created by the current test run and identified by exact IDs/run markers.
- Do not use real customers for tests; never send real emails, notifications, webhooks, or other outbound communications during tests.
- Review every migration before applying it to the configured database. Prefer additive, backward-compatible migrations.

---

## 4. Domain Concepts and Terminology

Use these concepts consistently in metadata, APIs, UI labels, code, and docs.

- **Account:** Existing CRM customer organization; remains the source of truth for the customer identity.
- **Customer Success Profile:** CSM-specific operational profile for an Account.
- **Customer Health Score:** Numeric value from 0 to 100 calculated from known and fresh signals under an enabled scoring configuration.
- **Health Status:** Human-readable classification, such as Healthy, Monitor, At Risk, Critical, or Unknown, derived from thresholds unless an authorized override is active.
- **Health Snapshot:** Immutable or append-only record of score/status/components at a point in time.
- **Health Signal:** A normalized metric produced from an available data source, including freshness and source metadata.
- **Lifecycle Stage:** Where the customer is in the relationship journey, for example Onboarding, Adoption, Value Realization, Renewal, or Churned. Options must be configurable but ship with validated defaults.
- **Success Plan:** Time-bound plan for desired customer outcomes, goals, owners, dates, and checkpoints.
- **Success Goal:** Measurable outcome in a plan, with a target, current value, unit, direction, due date, source, and progress calculation.
- **Customer Success Risk:** A discrete problem or warning with severity, evidence, owner, mitigation, due date, and resolution.
- **Playbook Template:** Reusable set of steps and trigger rules for a known customer scenario.
- **Playbook Run:** A specific execution of a template against an Account/Profile.
- **Touchpoint / Success Review:** Structured CSM interaction record or view linked to existing Activities, not a replacement for meetings, calls, or tasks.
- **Renewal Readiness:** A summary view of the known renewal date, commercial references, health, risks, goals, and next actions; not a billing system.
- **Portfolio:** Set of Accounts a CSM or team is responsible for.

### 4.1 Naming rules

- Use `CustomerSuccess...` prefixes for new domain entities and services to prevent collisions.
- Follow established Entity Engine naming rules rather than inventing a parallel naming convention.
- Use stable machine keys for lifecycle values, health states, risk types, event names, and API fields; display labels must be translatable.
- Do not use display labels as internal identifiers.

---

## 5. Functional Requirements

### 5.1 Customer Success Profile

Create a profile associated with one existing Account. Prefer a one-to-one relation with a unique constraint on `accountId`, unless the repository's relation engine requires an equivalent mapping.

Suggested fields:

| Field                    | Type / behavior                                                                                                 | Required                          |
| ------------------------ | --------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `accountId`              | Relation to Account; unique for active profiles                                                                 | Yes                               |
| `csmUserId`              | Relation to User responsible for the Account                                                                    | Configurable; may be unassigned   |
| `csmTeamId`              | Optional owner team/portfolio                                                                                   | No                                |
| `lifecycleStage`         | Configurable lifecycle key                                                                                      | Yes; default from module settings |
| `healthStatus`           | Calculated classification; can be overridden with permission                                                    | System managed                    |
| `calculatedHealthStatus` | Latest status before any manual override                                                                        | System managed                    |
| `healthScore`            | Latest calculated score 0–100 or null when unknown                                                              | System managed                    |
| `healthScoreAt`          | Latest successful calculation time                                                                              | System managed                    |
| `healthOverride`         | Optional manual override key                                                                                    | No                                |
| `healthOverrideReason`   | Required when override is active                                                                                | Conditional                       |
| `healthOverrideByUserId` | User who set override                                                                                           | System managed                    |
| `healthOverrideAt`       | Timestamp of override                                                                                           | System managed                    |
| `segment`                | Configurable segment such as SMB/Mid-Market/Enterprise                                                          | Optional                          |
| `onboardingStatus`       | Derived from onboarding workflow or manually managed where no playbook exists                                   | Yes/default                       |
| `onboardingStartedAt`    | Date/time                                                                                                       | No                                |
| `onboardingTargetDate`   | Date                                                                                                            | No                                |
| `onboardingCompletedAt`  | Date/time                                                                                                       | No                                |
| `renewalDate`            | Optional manual date; may be enriched from an enabled source                                                    | No                                |
| `renewalStatus`          | Unknown, Not Due, Preparing, In Progress, Renewed, At Risk, Churned (configurable only within validated states) | Default Unknown                   |
| `lastMeaningfulTouchAt`  | Derived from qualifying, permitted activities/touchpoints                                                       | System managed                    |
| `nextSuccessReviewAt`    | Date/time for next planned review                                                                               | No                                |
| `lastHealthReviewAt`     | Date/time of last documented manual review                                                                      | No                                |
| `customerSince`          | Optional, only if this does not conflict with Account fields                                                    | No                                |
| `notes`                  | Use generic Notes/Stream when supported; avoid storing duplicate timeline text                                  | No                                |
| Standard audit fields    | Follow Entity Engine convention                                                                                 | System managed                    |

Functional rules:

- Creating a profile must never create a duplicate Account.
- A user may open the Account from a profile and the profile from an Account detail panel, subject to ACL.
- The module must handle Accounts with no profile without breaking Account list/detail screens.
- Profile creation must be idempotent where initiated by a workflow or migration.
- Decide and document whether deleted Accounts cascade, restrict, or soft-delete linked CSM records according to established platform deletion semantics. Do not silently delete historical health snapshots or risk records.
- Unassigning a CSM must be audited and may optionally trigger a reassignment task/notification based on settings.
- Manual profile creation, automated profile creation, and backfill jobs must all pass through the same domain validation and access policy.

### 5.2 Customer portfolio and ownership

Required views:

- My Customer Portfolio.
- Team Portfolio (subject to team/record ACL).
- Unassigned Customers.
- Customers with Unknown, Monitor, At Risk, or Critical health.
- Customers onboarding now or overdue.
- Customers with upcoming renewals.
- Customers missing a success plan or next review.

Capabilities:

- Assign/reassign one or multiple profiles only if the actor has the relevant permission and may access those Accounts.
- Bulk actions must validate every selected record, return per-record failures, and avoid partial silent failures.
- Filter by CSM, team, Account, segment, lifecycle, health status, renewal window, onboarding status, last touch, next review, active risk, and available optional integration status.
- Support saved filters and configurable list columns via the existing list/view system.
- Provide sort by health score, renewal date, next review date, risk severity, overdue work, and Account name, where the chosen sort has an explicit null-ordering rule.
- For each row, show actionable context: current health, trend, next action/date, renewal horizon, and number of open risks without leaking inaccessible related records.

### 5.3 Lifecycle management

Ship default lifecycle keys that can be changed through module settings without code changes. Suggested defaults:

1. `onboarding`
2. `adoption`
3. `value_realization`
4. `mature`
5. `renewal`
6. `at_risk`
7. `churned`

Do not make the list unconditionally fixed in code. The final configured state model must be validated and versioned. The default lifecycle values are a practical local design, not a claim about EspoCRM's built-in status list.

Requirements:

- Configure enabled stage keys, labels, order, descriptions, and optional allowed transition rules.
- Validate transitions on the server. A client-side dropdown is not sufficient.
- For important transitions (e.g., to `churned`), require a reason and optionally a churn date based on settings.
- Keep lifecycle and health separate: an Account can be in onboarding while Healthy, or Mature while At Risk.
- Support manual transitions by authorized users and optional automation driven by explicit rules.
- Record lifecycle changes in audit/history and publish a domain event.
- Do not automatically move a customer to Churned merely because a Subscription or Opportunity is missing; only an enabled, configured source may drive such a transition.
- Provide lifecycle-transition preview/explanation for bulk operations and automation when supported by the UI framework.

### 5.4 Customer Health Score engine

Health scoring is the core feature and must be transparent, deterministic, testable, and auditable.

#### 5.4.1 Score semantics

- Score range: integer 0–100 for user-facing display; retain precise intermediate values only if the platform convention requires them.
- `null` / Unknown means insufficient eligible data, not a score of zero.
- A health status is derived from configurable thresholds, with validated non-overlapping ranges, for example:
  - Healthy: 80–100
  - Monitor: 60–79
  - At Risk: 40–59
  - Critical: 0–39
  - Unknown: no valid score
- These thresholds are defaults, not permanent constants. Settings must guarantee coverage from 0 to 100 and no gaps/overlaps.
- A manual health override is independent from the calculated result. Show both the effective status and the underlying calculated score/status.
- Whenever a manual override is set, store a non-empty reason, the actor, and timestamp. An override can have an optional expiry/review date. Expiry returns the effective classification to calculated status through an auditable transition.

#### 5.4.2 Signals and component scores

Provide an extensible `HealthSignalProvider` interface. Implement built-in providers only for existing platform data sources. Potential signal families:

- Engagement: time since last qualifying call/meeting/review; overdue customer-facing activities.
- Success plan: progress against active goals, overdue goals, milestone completion, and goal recency.
- Relationship coverage: presence of active customer contacts/stakeholders and a defined executive sponsor (only if the needed data is available).
- Support: open severe cases, recently reopened cases, or resolution/SLA trends when a Cases/Service Desk module exists.
- Adoption: manually entered adoption metrics or data from an explicitly configured provider. Do not invent usage metrics without a source.
- Renewal/commercial: renewal horizon, known renewal risk, relevant Opportunity/Subscription state only when those providers exist.
- Onboarding: completion ratio and overdue onboarding checkpoints.
- Risks: open risk severity, age, and overdue mitigation actions.

Each signal provider returns a normalized result with:

- stable signal key and label key;
- raw/normalized value or a safe summarized representation;
- component score in range 0–100 when scoreable;
- weight from the active scoring configuration;
- measurement time and freshness/expiry information;
- source module/entity/record references if accessible;
- explanation code and safe display parameters;
- whether the signal is applicable, missing, stale, or failed.

Do not include secrets or sensitive raw event payloads in the score explanation.

#### 5.4.3 Weighted score rules

- Store scoring configurations as versioned configuration records or the repository's standard system-settings entity, not as arbitrary executable code.
- Weights must be non-negative and normalized/validated by the server; configured applicable weights must sum to 100 or be safely normalized according to one documented policy.
- If an input is absent or stale, apply the configured missing-data policy: exclude and renormalize, reduce confidence, or return Unknown when minimum coverage is not met. Never silently score missing data as zero.
- A profile may have `Unknown` health when fewer than the configured minimum number/weight of signals are valid.
- Calculate a score from the configuration version used. Store that version on the snapshot for explainability.
- Define rounding consistently; use the same algorithm in the API, UI, job and tests.
- Do not let signal providers query arbitrary table names or accept unvalidated SQL conditions from user settings.
- Validate configuration changes and show a preview using a non-persistent sample/eligible record before activation, if practical.

#### 5.4.4 Snapshots and history

Create append-only Health Snapshot records (or an equivalent existing audit-history pattern if it supports all required fields). Each snapshot should record:

- Profile and Account references;
- score and calculated status;
- effective status at calculation time, clearly separated from calculated status;
- component scores, normalized inputs, weights, missing/stale signal states, and short explanation codes;
- scoring configuration version;
- calculation source (`manual`, `scheduled`, `event`, `rebuild`);
- calculated timestamp and duration;
- result state (`success`, `partial`, `failed`) and safe error summary when appropriate;
- deduplication/idempotency key when work is queued.

Requirements:

- Preserve previous snapshots; new calculations do not overwrite history.
- Avoid generating a new snapshot if no material input, configuration, or status change occurred, unless an explicit periodic snapshot policy requires it.
- Do not write sensitive customer content into a score history blob. Store only the minimum explanation necessary.
- Provide a trend view and component-change explanation for authorized users.
- A historical snapshot must reflect the configuration used at the time, even after a scoring rule changes.

#### 5.4.5 Recalculation modes

Support:

- On-demand recalculation for one profile, permission-checked and rate-limited.
- Scheduled batch recalculation through the existing job/scheduler system.
- Event-triggered recalculation for eligible changes such as qualifying activity completion, risk updates, plan goal updates, subscription/renewal changes, and Case changes when those event providers exist.
- Admin-only recalculation for a selected set of records with progress and error reporting.

Prevent event loops: writing a health snapshot must not itself trigger endless health recalculation. Use event filters, outbox/idempotency rules, or the established event architecture.

### 5.5 Onboarding

Implement onboarding as an Account-specific process using playbooks/checklists and existing Activities wherever possible.

Required capabilities:

- Start onboarding manually or through a configured, idempotent rule.
- Record start date, target completion date, status, owner/CSM, and completion date.
- Provide a checklist/playbook with ordered steps, due-date offsets, optional/required flags, dependencies, step owners, and completion criteria.
- Create/link existing CRM tasks or activities for steps that require human work. Do not create a second generic task entity.
- Track blockers, overdue steps, completion ratio, and next action.
- Allow an authorized user to skip an optional step with a reason. Required steps need an explicit override permission and audit reason to bypass.
- Permit pause/cancel/restart only through validated state transitions. Restart must not silently duplicate already completed steps.
- Complete onboarding only when mandatory steps are complete or a properly permissioned override with reason is recorded.
- Surface onboarding state on the Profile and Account views, portfolio list, dashboard, and health explanations.
- Do not automatically email the customer unless an existing email integration and explicit, reviewed opt-in configuration are available.

Suggested onboarding states: `notStarted`, `inProgress`, `blocked`, `completed`, `canceled`. Keep the set configurable only to the extent supported by the current state-machine conventions.

### 5.6 Success Plans

A Success Plan documents the intended business outcomes for one Account over a defined period.

Required fields:

- name;
- `profileId` and `accountId`;
- owner/CSM and optional internal collaborators;
- start/end date;
- status (`draft`, `active`, `onHold`, `completed`, `canceled`, subject to the repository's enum conventions);
- plan type/template;
- customer-stated outcomes and baseline summary;
- executive sponsor and involved Contacts if supported by relation metadata;
- next review date;
- completion date and close-out summary;
- audit fields.

Requirements:

- Support multiple historical plans for the same Account but define whether more than one active plan is allowed (default: one primary active plan; any secondary plan behavior must be explicit).
- Support plan templates with configurable default goals/checkpoints and owner suggestions.
- Record plan state transitions in the audit stream.
- Preserve completed/canceled plans as history; do not hard-delete them during routine cleanup.
- Provide a copy-from-template operation and a safe duplicate-plan operation with new IDs and no copied completion metadata.
- Support an Account-level summary of active plan status and overall progress.
- A Success Plan may optionally link to a Projects record or Project Task only if the Projects module is installed; the link is supplementary, never a hard dependency.

### 5.7 Success Goals and checkpoints

Success Goals are measurable outcomes, not generic CRM Tasks.

Suggested fields:

- `successPlanId`, `profileId`, and `accountId`;
- name and description;
- goal category/type;
- baseline value/date;
- target value/date;
- current value/date;
- unit label/key;
- direction (`increase`, `decrease`, `maintain`, `boolean`, `manual`);
- owner and optional customer Contact;
- source type (`manual`, `linkedEntity`, `provider`);
- optional linked record/data-source configuration;
- status (`notStarted`, `inProgress`, `achieved`, `missed`, `canceled`, `blocked`);
- progress percentage and calculation timestamp;
- checkpoint/milestone dates and notes;
- audit fields.

Rules:

- Validate numeric type, unit, direction, target, and baseline values.
- Avoid division-by-zero and reversed-direction mistakes in progress calculation.
- For an increase goal, calculate progress using baseline and target; for a decrease goal, reverse the direction safely; for `maintain`, use a configured tolerance range; for boolean goals, use explicit completion state; for manual goals, require controlled progress updates.
- If the needed value cannot be read from a safe, authorized source, require a manual update rather than silently inventing a value.
- Keep progress in the range 0–100 for UI purposes while exposing actual current/target values separately.
- Goal completion and overdue behavior must be deterministic and unit-tested.
- Changes to goal values, targets, statuses, or due dates must recalculate the plan summary and enqueue health recalculation only when relevant.
- Provide goal checkpoint history or use the standard audit system if it retains prior values adequately.

### 5.8 Customer Success Risks and churn prevention

Create a structured Customer Success Risk entity linked to a Profile and Account. A Risk is not the same as health status: a customer may have several specific risks that contribute to its overall health.

Suggested fields:

- title and description;
- `profileId`, `accountId`, optional `successPlanId`, related Contact, and optional linked Case/Opportunity/Subscription record;
- stable risk type key (e.g. adoption, engagement, support, stakeholder, value-realization, renewal, commercial, implementation, competitor, unknown);
- severity (`low`, `medium`, `high`, `critical`);
- probability/impact fields only if the UI clearly explains them;
- lifecycle status (`open`, `mitigating`, `escalated`, `resolved`, `accepted`, `closed`);
- owner/assignee and optional escalation team;
- detected date, next review date, target resolution date, resolved date;
- evidence summary and source references;
- mitigation plan and next action;
- resolution/outcome reason;
- whether it contributes to health scoring;
- audit fields.

Requirements:

- A risk must have an accountable owner or explicitly be placed in an unassigned queue.
- High/Critical risks require a mitigation action or documented reason for deferral.
- Overdue unresolved risk items must appear in designated queues and optionally trigger a configured in-app notification.
- Escalation must be permission-checked and idempotent.
- Resolve/close operations must record the outcome; reopening preserves the earlier resolution history.
- Risk severity, age, status, and due-date changes may trigger health recalculation.
- Support manual risk creation and, later, rules-based detection using verified data sources.
- Never automatically label an Account as Churned because a risk is Critical; health, lifecycle, and risk are separate concepts.

### 5.9 Renewal readiness

Renewal readiness provides visibility and workflow support. It is **not a replacement for Sales, Subscriptions, invoices, or contracts**.

Requirements:

- Show known renewal date, days to renewal, renewal status, responsible CSM, commercial owner if available, active success plan, goal progress, health trend, open high/critical risks, and next action.
- Allow authorized users to manually manage renewal date/status when no commercial source is installed.
- If an Opportunity/Subscription/contract source exists, provide an adapter that reads only allowed fields and links to the source record.
- Define data precedence for renewal date. A source-supplied date should not silently overwrite a manual date unless the setting explicitly defines that behavior. Show the source and last-sync time.
- Provide configurable date windows (e.g. 30/60/90/120 days) and queues such as Upcoming, Needs Preparation, At Risk, Overdue, Renewed, and Churned.
- A renewal alert should include actionable evidence and a recommended follow-up, not only a status.
- Do not create or update an Opportunity, Subscription, invoice, or payment without an explicit, separately permissioned action.
- A `Renewed` state must have a traceable source reference or a documented manual confirmation. Do not infer that the customer renewed merely because the renewal date changed.
- Renewal data source failures must be visible and must not erase a previously valid value.

### 5.10 Touchpoints and success reviews

Reuse existing Activity, Calendar, Stream, Notes, and Contact records. The module should add CSM context without forking generic collaboration features.

Requirements:

- Show recent qualifying calls, meetings, completed tasks, customer reviews, and notes in a unified Account/CS Profile context if the platform provides these sources.
- Allow a CSM to schedule a Success Review by creating or linking an existing Meeting/Activity.
- Provide an optional structured review template with objectives, outcomes achieved, open risks, goal progress, customer sentiment, action items, and next review date.
- Store customer sentiment only as a clearly labeled human-entered value unless an explicit compliant external source is configured.
- Support links from a touchpoint/review to Account, relevant Contacts, Profile, Success Plan, Goals, and Risks without duplicating the actual Activity record.
- Define what counts as a `meaningful touch` for health scoring; exclude internal-only tasks, automated noise, and events without a customer/account link unless configuration says otherwise.
- Make a clear distinction between activity creation date and activity completion date for recency calculations.
- Prevent users from seeing an Activity or Note they are not otherwise authorized to read, even if it is connected to a visible Profile.

If the generic Activity model cannot support a structured review form safely, add a small `CustomerSuccessReview` record that links to an existing Activity rather than replacing the Activity. Do not build a standalone call/meeting/task scheduler.

### 5.11 Playbook templates and execution

A playbook is a reusable checklist/automation recipe for onboarding, adoption, risk mitigation, renewal preparation, or executive reviews.

#### 5.11.1 Template model

A Playbook Template should define:

- name, description, type/category, version, active flag;
- trigger mode (`manual`, `lifecycleTransition`, `healthTransition`, `renewalWindow`, `onboardingStarted`, or another explicitly supported domain event);
- validated trigger configuration;
- eligible segment/lifecycle/health criteria;
- steps in stable order, with stable IDs/keys;
- step type (`manual`, `createActivity`, `createTask`, `createRisk`, `createSuccessPlan`, `notifyOwner`, `waitUntil`, or another explicitly supported type);
- required/optional flag, offset due dates, assignee policy, dependencies, instructions, and completion rule;
- template version and audit fields.

Do not execute arbitrary code in a step or allow an administrator to type raw SQL or unrestricted JavaScript into a playbook. Step types are implemented as allow-listed providers with validated schemas.

#### 5.11.2 Run model

A Playbook Run should store:

- Profile/Account and template/version references;
- trigger source and idempotency key;
- start/end time, status, initiating actor or system source;
- a snapshot of the template steps required for this run so edits to the template do not mutate in-flight work;
- per-step status, due date, assignee, linked Activity/Task/record, completion time, skip reason, and safe error summary;
- cancel/pause reason and run-level audit data.

#### 5.11.3 Execution rules

- Manual playbook start is supported in MVP; automated triggers may be enabled incrementally.
- Every trigger must have a deterministic idempotency key to avoid duplicate runs after event retries.
- Use the existing queue/job infrastructure for work that should not block a user request.
- A repeated event must not duplicate tasks, risk records, or notifications.
- Step failure must be visible and retryable without repeating completed external side effects.
- Support run cancellation and controlled retry; preserve partial progress and history.
- Avoid hidden cascading automation. Show which trigger started a run and which actions it performed.
- `waitUntil` must use the existing scheduler/queue abstraction and must not spawn in-memory timers.
- Never send customer-facing mail or invoke external APIs unless an existing integration and explicit admin/user configuration permit it.

### 5.12 Dashboards, reports, and operational queues

Contribute dashlets/widgets to the existing dashboard framework when it is implemented. Suggested views:

1. My portfolio health distribution.
2. Health score trend over time.
3. Customers with falling health scores.
4. At Risk/Critical customers with no next action.
5. Onboarding completion and overdue steps.
6. Open risks by severity, owner, and age.
7. Upcoming renewals by 30/60/90-day windows.
8. Success-plan and goal progress.
9. Overdue or missing customer reviews.
10. Active playbook runs and failed steps.
11. Unassigned profiles and portfolio workload.

Dashboard rules:

- Every aggregate must respect record-level ACL, team scope, and field-level restrictions.
- Do not leak counts or names of inaccessible Accounts through filters or chart tooltips.
- Date-window definitions and timezone behavior must be explicit.
- Health distributions must distinguish `Unknown` from a low score.
- Dashlets should drill down to the exact filtered list when permitted.
- Use existing Reports/Dashboard capabilities if available; do not add a new reporting engine just for this module.
- If dashboards are not yet implemented in Phases 0–18, ship useful saved list views and a compact portfolio overview first, then add dashlets when the generic framework arrives.

### 5.13 Configuration and administration

Provide a Customer Success settings area through the existing administration/settings framework. At minimum configure:

- enabled lifecycle stages and valid transitions;
- segment options;
- default owner/assignment policy;
- health thresholds and enabled scoring configuration;
- signal weights, signal applicability, freshness windows, missing-data behavior, and minimum coverage;
- manual override permissions, optional expiry, and review requirement;
- renewal windows and data-source precedence;
- meaningful-touch definition and recency window;
- playbook auto-trigger enablement and per-trigger guardrails;
- notification/escalation rules;
- default onboarding playbook and success-plan template;
- job batch size/limits where appropriate.

Configuration safeguards:

- Validate all settings server-side.
- Save new settings as a new version where the scoring/history model depends on historical reproducibility.
- Preview changes before enabling potentially high-impact automations.
- Keep system defaults idempotent and version-controlled.
- Do not reset administrator settings on app start or routine migration.
- Do not allow settings to weaken global ACL or make record-level access more permissive.

### 5.14 Search, filters, import/export, and bulk operations

- Register profile, success plan, goal, risk, playbook template/run, and review entities with the generic Entity Engine where appropriate.
- Add searchable fields for Account name, profile owner, lifecycle, health state, segment, active risk title, goal name, and renewal date subject to existing search limits.
- Register filters using the generic query/filter framework; do not concatenate client strings into SQL.
- Support import/export only through the existing framework and its ACL checks.
- If profile imports reference Account IDs, validate that the actor may access each Account and prevent duplicate active profiles.
- Bulk actions include assignment, lifecycle transition, health recalculation, plan activation (where allowed), and playbook start only if the generic bulk-action contract supports per-record results.
- Do not provide bulk destructive delete for health history, risks, plans, or playbook runs by default.

---

## 6. Data Model and Persistence Design

Use the Entity Engine for ordinary entity CRUD, metadata, relations, validation, and serialization. Use domain services for score calculation, state transitions, playbook execution, and other multi-record business operations. Do not create a second ORM or entity registry.

The names below are logical recommendations. Adapt them to the actual naming strategy while preserving field semantics and constraints.

### 6.1 Required domain entities

#### A. `CustomerSuccessProfile`

- One profile per Account.
- Main portfolio-facing record.
- Holds current lifecycle, CSM owner/team, latest health summary, onboarding/renewal summaries, and manual override state.
- Latest values are a read-optimized summary; snapshots/history remain the source for explaining changes.

#### B. `CustomerSuccessHealthSnapshot`

- Append-only calculation result.
- Stores score, calculated/effective state, source, configuration version, components, signal coverage, calculation time, and result status.
- Must have indexes for profile/date and common portfolio trend queries.

#### C. `CustomerSuccessScoringConfig` (or versioned system config)

- Holds versioned signal definitions, weights, status thresholds, freshness windows, minimum coverage, missing-data policy, and enabled/disabled state.
- Do not store executable script bodies.
- If the platform has a standard versioned system-settings store, use it instead of creating redundant configuration tables.

#### D. `CustomerSuccessPlan`

- Account/profile outcome plan with owner, timeframe, status, summary, and optional template/source links.

#### E. `CustomerSuccessGoal`

- Measurable goal inside a plan, including baseline/target/current value, unit, direction, owner, due date, source, progress, and status.

#### F. `CustomerSuccessRisk`

- Risk/mitigation record with severity, type, owner, evidence, next action, due dates, status, and resolution.

#### G. `CustomerSuccessPlaybookTemplate`

- Reusable, versioned template and validated step configuration.

#### H. `CustomerSuccessPlaybookRun`

- Execution instance with idempotency key, template version snapshot, status, and relationship to step records.

#### I. `CustomerSuccessPlaybookStepRun`

- Individual step execution status, due date, assignee, linked record, completion/skip reason, and retry-safe failure state.

#### J. `CustomerSuccessReview` (conditional)

- Add only if generic Activities cannot safely represent the structured success-review content. It must link to an existing Activity when one exists and must not duplicate its scheduling/lifecycle semantics.

#### K. Onboarding entities (conditional)

- Prefer Playbook Run + Step Run for onboarding. Do not create separate onboarding task/checklist tables if the playbook model already covers the use cases.
- Add a dedicated onboarding record only if it materially simplifies lifecycle/status reporting and cannot be represented safely in Profile + Playbook Run.

### 6.2 Relationships

At minimum:

- Account 1 — 0..1 CustomerSuccessProfile.
- User 1 — many owned CustomerSuccessProfiles.
- Team 1 — many profiles, where team ownership is supported.
- Profile 1 — many HealthSnapshots.
- Profile 1 — many SuccessPlans.
- SuccessPlan 1 — many SuccessGoals.
- Profile 1 — many CustomerSuccessRisks.
- PlaybookTemplate 1 — many PlaybookRuns.
- Profile 1 — many PlaybookRuns.
- PlaybookRun 1 — many PlaybookStepRuns.
- A playbook step run may link to an existing Activity/Task/Notification or an allowed record produced by the step.
- Optional relations to Contact, Project, Project Task, Opportunity, Subscription, Case, and Activity must only be registered when the target entity is present.

All relations must be checked server-side and obey ACL on both endpoints. A relationship to a visible Profile must not grant access to an otherwise inaccessible related record.

### 6.3 Database constraints and indexing

Add, where supported by the existing migration/query layer:

- Unique constraint on active Profile `accountId`.
- Foreign-key behavior consistent with the current repository's deletion/soft-deletion model.
- Indexes on Profile owner/team, lifecycle, health status, segment, renewal date, onboarding state, and last-touch/next-review dates according to observed query patterns.
- Composite index on HealthSnapshot `(profileId, calculatedAt DESC)` or the closest supported equivalent.
- Indexes on active/open risk lists by `(profileId, status, severity, dueDate)` as query patterns justify.
- Unique/idempotency constraint on PlaybookRun trigger key when a trigger must run once per record/window/template version.
- Indexes for open PlaybookStepRuns by assignee/status/due date.
- Indexes on SuccessGoal plan/status/due date.

Do not over-index every field. Capture the query patterns and verify important indexes with the configured database's query plans when practical.

### 6.4 JSON and structured fields

If PostgreSQL JSONB is the repository's established pattern, it may be used for versioned score components or playbook step snapshots, with schema validation in TypeScript. However:

- Frequently filtered and joined fields must remain typed columns/metadata fields, not buried only in JSON.
- Every JSON payload needs an explicit version field and validated schema.
- Do not store raw unbounded activity bodies or large customer data blobs in score snapshots.
- Do not interpolate JSON values into SQL strings.
- Any JSONB indexes must be justified by a real query pattern.

### 6.5 Migration strategy

- Use versioned, reviewable, additive migrations.
- Register metadata and relation definitions through the existing metadata/migration mechanism.
- Prefer nullable fields and staged rollouts before introducing required values on populated tables.
- Backfill CustomerSuccessProfile records only through an explicit, resumable, idempotent job or administrator-triggered command.
- Do not silently create a profile for every Account on application boot.
- Backfill jobs must support dry-run/preview if feasible, progress reporting, restartability, and per-record error reporting.
- Seed default lifecycle/scoring/template records using idempotent keys and never overwrite user-modified settings.
- Do not drop historical tables/columns as part of normal upgrade or module disable.
- An uninstall/deactivation operation must not delete customer plans, risks, snapshots, or run history. If uninstall is supported, preserve domain tables and clearly document retained data.

---

## 7. Domain Services and Events

Keep controllers thin. Implement business behavior in injected application/domain services and expose stable interfaces to jobs, event handlers, and the UI API.

### 7.1 Suggested services

- `CustomerSuccessProfileService`: create/update, assignment, Account binding, lifecycle summary.
- `CustomerSuccessPortfolioService`: portfolio queues and ACL-filtered aggregates.
- `CustomerSuccessLifecycleService`: validated lifecycle transitions and reasons.
- `CustomerHealthScoringService`: signal collection, weight normalization, score calculation, threshold classification, configuration version resolution.
- `CustomerHealthSnapshotService`: history writes, deduplication, trend queries, and snapshot retention policy (retention must not delete required audit history).
- `HealthSignalRegistry`: registers built-in and optional provider adapters.
- `CustomerSuccessOnboardingService`: onboarding start, completion, pause, cancel, blocker, and progress summary.
- `CustomerSuccessPlanService`: plan creation, transition, copy-from-template, summary.
- `CustomerSuccessGoalService`: value updates, progress calculation, checkpoint, overdue logic.
- `CustomerSuccessRiskService`: triage, ownership, mitigation, escalation, resolution, health impact.
- `CustomerSuccessRenewalService`: renewal summary, source precedence, due windows, source references.
- `CustomerSuccessTouchpointService`: meaningful-touch eligibility and structured review integration.
- `CustomerSuccessPlaybookService`: template validation, start, run state transitions, cancellation, retry, and step linking.
- `CustomerSuccessAutomationService`: guarded automation rules and idempotency.
- `CustomerSuccessNotificationService`: create in-app notifications through the existing notification service only.
- `CustomerSuccessSettingsService`: validated configuration and immutable/versioned scoring settings as required.

Use the project's established naming and module layering. Do not create a service solely to wrap one trivial repository call unless that is the repository convention.

### 7.2 Suggested domain events

Follow the existing domain-event naming and payload contract. Events should include stable IDs, timestamps, tenant/context where supported, and correlation IDs.

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

- Publish only after the associated database transaction has committed, or use the repository's transactional outbox mechanism.
- Consumers must be idempotent.
- Do not publish a payload that exposes fields the consumer's context is not allowed to access.
- Avoid embedding full entities in events; prefer IDs and small, non-sensitive domain facts.
- Define retry and poison-message handling using the existing queue conventions.
- Health update events must not recursively cause unbounded recalculation.

---

## 8. API Design

Use the existing REST and CRUD conventions under `/api/v1`. Names below are illustrative; first inspect how the generic Entity Engine exposes entity endpoints and how custom domain actions are registered. Prefer generic entity endpoints for ordinary CRUD and dedicated actions only for business operations.

### 8.1 Entity resources

Expose entities using the repository's standard route pattern, expected to be similar to:

- `/api/v1/CustomerSuccessProfile`
- `/api/v1/CustomerSuccessHealthSnapshot` (read-only for normal users)
- `/api/v1/CustomerSuccessPlan`
- `/api/v1/CustomerSuccessGoal`
- `/api/v1/CustomerSuccessRisk`
- `/api/v1/CustomerSuccessPlaybookTemplate`
- `/api/v1/CustomerSuccessPlaybookRun`
- `/api/v1/CustomerSuccessPlaybookStepRun`
- `/api/v1/CustomerSuccessReview` only if conditionally implemented

Do not expose internal storage table names as a separate external contract if the rest of the project is metadata-driven.

### 8.2 Domain actions

Use consistent HTTP verbs, DTO validation, response formats, and error codes. Candidate action endpoints (adapt to the established action-routing pattern):

- `POST /api/v1/customer-success/profiles/:id/recalculate-health`
- `GET /api/v1/customer-success/profiles/:id/health-history`
- `GET /api/v1/customer-success/profiles/:id/health-explanation`
- `POST /api/v1/customer-success/profiles/:id/set-health-override`
- `POST /api/v1/customer-success/profiles/:id/clear-health-override`
- `POST /api/v1/customer-success/profiles/:id/transition-lifecycle`
- `POST /api/v1/customer-success/profiles/:id/start-onboarding`
- `POST /api/v1/customer-success/profiles/:id/start-playbook`
- `GET /api/v1/customer-success/portfolio/summary`
- `GET /api/v1/customer-success/portfolio/queues`
- `POST /api/v1/customer-success/plans/:id/activate`
- `POST /api/v1/customer-success/plans/:id/complete`
- `POST /api/v1/customer-success/goals/:id/update-progress`
- `POST /api/v1/customer-success/risks/:id/escalate`
- `POST /api/v1/customer-success/risks/:id/resolve`
- `GET /api/v1/customer-success/renewals/summary`
- `POST /api/v1/customer-success/playbook-runs/:id/cancel`
- `POST /api/v1/customer-success/playbook-runs/:id/retry-failed-steps`
- `POST /api/v1/customer-success/admin/recalculate-health` (admin-only, async/batched)

These are proposed domain actions, not an instruction to add duplicate controllers if the current API framework represents actions differently.

### 8.3 API rules

- Authenticate every non-public route.
- Apply the same global, team, record, and field-level ACL used by normal entity APIs.
- Validate related IDs against the current actor's accessible records.
- Validate every state transition on the server.
- Use DTO schemas and reject unknown/unsupported fields per repository convention.
- Use pagination and bounded page sizes on lists/history endpoints.
- Add optimistic concurrency/version checks for state transitions if that pattern exists in the platform.
- Use transactions for multi-record operations such as starting a playbook and generating the first step records.
- Return stable error codes for permission denied, invalid transition, stale version, duplicate profile, configuration invalid, and missing integration.
- Prevent IDOR: possession of a Profile ID must not grant access to its Account, Contacts, Activities, health snapshots, or external-linked records.
- Health snapshot writes and calculated fields must not be accepted from ordinary create/update payloads.
- Document endpoints in the existing OpenAPI system and add request/response examples without real customer data.
- Avoid exposing stack traces, SQL, raw provider errors, or secret configuration in API responses.

---

## 9. Permissions and Security

Authorization is a server-side requirement. UI hiding is not access control.

### 9.1 Permission scopes

Register module scopes using the repository's role/ACL pattern. Suggested scopes:

- Customer Success Profile: read, create, edit, delete/archive if supported, assign CSM, bulk assign.
- Health: read current health/history, request recalculation, set/clear override, manage scoring settings.
- Success Plans: read, create, edit, activate, complete, cancel, copy template.
- Success Goals: read, create, edit, update measurements, mark complete/blocked.
- Risks: read, create, edit, assign, escalate, resolve, close/reopen.
- Playbook Templates: read, create, edit, activate/deactivate.
- Playbook Runs: read, start, cancel, retry, override a step.
- Reviews: read/create/edit structured review if implemented.
- Administration: configure lifecycle/scoring/renewal/playbook settings, manage module defaults, run bulk recalculation.

Use the established permission levels and naming; avoid a parallel ACL vocabulary if the platform already has a scope model.

### 9.2 Record access policy

- Admins access records according to existing platform admin semantics.
- CSMs can access profiles assigned to them when that corresponds to current role rules.
- Team leads can access team portfolios only where team ACL grants it.
- Account owners may receive access through existing Account ACL; do not assume ownership means access if platform policy says otherwise.
- Other users require role/team/record ACL permission.
- Assignment or reassignment requires both permission to assign and permission to access the destination user/team and Account.
- Related Activities, Contacts, Cases, Opportunities, Projects, and Subscriptions retain their own ACL.
- Aggregate SQL must scope rows before aggregation, not filter inaccessible names after building the result.

### 9.3 Field and operation security

- Protect health overrides, scoring configuration, lifecycle policy, playbook automation, and source precedence with elevated permission.
- A normal client cannot write calculated score, health snapshot, calculation state, audit actor, or system-managed timestamps.
- A user cannot assign a risk or goal to an inaccessible User/Team or link to an inaccessible record.
- Prevent users from executing arbitrary expressions, SQL, JavaScript, URLs, file paths, or provider calls through rules/configuration.
- Use safe escaping and parameterized queries for search and filters.
- Validate uploaded artifacts using the existing Attachments/file policy if playbooks permit files; otherwise do not add upload handling.
- Keep a complete audit trail for security-sensitive operations.

### 9.4 Privacy and retention

- Retain only information needed for operational CSM workflows.
- Do not store credentials, access tokens, payment details, or raw third-party event payloads inside CSM entities.
- Health explanations should identify a source by permitted label/reference and avoid displaying sensitive Activity/Case body content.
- Follow platform data export, deletion, privacy, and retention behavior. Where audit requirements conflict with deleting operational content, use the system's established anonymization/retention policy rather than inventing ad hoc behavior.

---

## 10. React UI and User Experience

Use the existing React SPA, router, design system, metadata layouts, forms, field components, tables, filter engine, and permission hooks. Do not build a standalone frontend or second component system.

### 10.1 Navigation

Suggested top-level menu area: **Customer Success**. Register menu entries using the established module navigation metadata.

Suggested pages:

- Portfolio Overview
- Customer Profiles
- Onboarding
- Success Plans
- Goals
- Risks
- Renewals
- Playbooks
- Administration / Settings (permission-gated)

Hide or disable unavailable optional features instead of navigating users to broken pages.

### 10.2 Customer profile experience

Profile detail should contain a readable summary with:

- Account name and link;
- CSM and team;
- lifecycle stage and segment;
- effective health status and numeric score;
- calculated status vs manual override indicator;
- health trend and last calculation date;
- most important score component explanations;
- active Success Plan and goal progress;
- onboarding state and next incomplete step;
- open risks and mitigation due dates;
- renewal date/window and renewal source;
- last meaningful touch and next planned review;
- authorized quick actions such as Recalculate Health, Create Success Plan, Start Playbook, Schedule Review, Assign CSM, and Log Risk.

Suggested panels/tabs:

- Overview
- Health History
- Success Plans & Goals
- Risks
- Onboarding / Playbooks
- Activities & Reviews
- Stream / Notes (reuse generic component)
- Related Records

Only render tabs when the data source is available and the user has permission to access it.

### 10.3 Visual health explanation

The health display must show more than a color. Include:

- score/status;
- trend (improving/stable/declining/unknown) based on a documented comparison window;
- last calculation time;
- valid signal coverage or completeness;
- main positive/negative factors with explanatory labels;
- whether the status is manually overridden;
- link to history and relevant source records when readable.

Do not use color alone to communicate health. Provide text/icon/accessible labels, keyboard support, and appropriate contrast.

### 10.4 Portfolio and queue UX

- Default portfolio view should prioritize actionable records and allow user-selected filters.
- Provide clear empty/loading/error states; do not represent provider failure as an empty healthy portfolio.
- Add filters for CSM/team, health, lifecycle, segment, onboarding, renewal window, overdue risks, goals, last touch, and next review.
- Use server-side filtering/pagination for portfolio-sized data; do not fetch all customers to the browser and filter locally.
- Preserve existing list conventions (column configuration, saved views, search, selection, row actions).
- Bulk operations must preview scope and report failures per record.

### 10.5 Responsive and accessible behavior

- Support existing desktop/tablet/mobile breakpoints.
- Forms must be keyboard operable, labels associated with controls, and dynamic validation messages announced appropriately.
- Do not rely only on green/yellow/red for status.
- Ensure chart details are available through accessible legends/tooltips or equivalent data tables.
- Confirm that long Account names, translated labels, large goal names, and missing data do not break layouts.

---

## 11. Notifications and Scheduled Jobs

Use only the current platform job queue, scheduler, and notification system. Do not create per-feature worker processes or in-memory timers.

### 11.1 Scheduled jobs

Potential jobs (register only after confirming the scheduler contract):

1. `customerSuccess.recalculateHealthBatch` — recalculate profiles due for refresh using bounded batches.
2. `customerSuccess.expireHealthOverrides` — expire overrides and restore effective calculated status with history.
3. `customerSuccess.updateGoalOverdueState` — update overdue indicators without unnecessary row churn.
4. `customerSuccess.evaluateRenewalWindows` — detect newly entered configured renewal windows.
5. `customerSuccess.evaluateRiskEscalations` — find overdue/high-severity risks requiring review.
6. `customerSuccess.evaluateReviewReminders` — notify owners about upcoming/overdue success reviews.
7. `customerSuccess.processPlaybookWaitSteps` — resume runs whose wait steps are due.
8. `customerSuccess.repairStalePlaybookRuns` — identify stuck runs; repair only through explicitly safe transitions.

Each job must:

- Use bounded batch sizes and stable ordering/cursors.
- Be idempotent and safe to retry.
- Record start/end time, processed count, skipped count, errors, and duration without logging sensitive customer content.
- Avoid selecting records the executor cannot access if job context enforces user-level access; system jobs must use the documented service authority model.
- Never perform unbounded full-table work in a web request.
- Support pause/disable through the normal operations/settings mechanism.
- Use distributed locking or idempotency if the scheduler may run more than one instance.
- Avoid recurring notifications for the same condition unless a reminder cadence is explicitly configured.

### 11.2 Notification rules

Use in-app notifications initially. Candidate triggers:

- Health status dropped to At Risk/Critical.
- Manual health override is about to expire or needs review.
- A Critical risk was created, escalated, or became overdue.
- Onboarding has overdue required steps or a target date is at risk.
- A success goal passed its due date or target.
- A renewal window opened and no owner/action is configured.
- A success review is due/overdue.
- A playbook run/step failed and requires intervention.
- A Profile was reassigned or left unassigned.

Every rule must define recipient selection, deduplication key, severity, cadence, opt-out/admin setting where applicable, and deep link ACL behavior. Do not leak Account details through notification previews to users without access.

---

## 12. Integrations with Other Modules

Implement adapters so optional modules can be absent without breaking Customer Success. Avoid direct imports from an optional module in a way that creates a mandatory boot-time dependency.

### 12.1 Accounts and Contacts

- Required foundation.
- Account remains the canonical customer company record.
- Use Contacts for stakeholders, sponsor, and review participants.
- Use current relations and field-level ACL.

### 12.2 Activities and Calendar

- Use existing Meetings, Calls, Tasks, reminders, and Calendar integration for work planning.
- Define the qualifying touchpoint logic separately from generic Activity CRUD.
- Keep the CSM context as additional relation/metadata, not a second scheduler.

### 12.3 Sales and Subscriptions

- If Sales/Opportunities exists, permit a link to a renewal Opportunity and show authorized summary fields.
- If Subscriptions exists, use it as a commercial source for term and subscription state only through a defined adapter.
- No duplicate price book, contract, invoice, or billing tables.
- Do not let a CRM user infer payment details they are not permitted to view merely because a CSM Profile links to a subscription.

### 12.4 Cases / Service Desk

- Register support-related health signals only when a provider exists and can apply its access policy.
- Prefer aggregate, permission-safe values (open critical count, recent reopen count, SLA breach count) over copying ticket content into HealthSnapshot.
- If data cannot be accessed or has never been synced, represent that signal as unavailable/unknown.

### 12.5 Projects

- If the Projects module from the adjacent Phase 19 plan is implemented, optionally link a Success Plan/onboarding step to a Project or Project Task.
- Do not create Project/Task records in an inconsistent way; use the Projects module's public service/API contract.
- Avoid bidirectional event loops between Project completion and CSM goal progress. Map events and idempotency explicitly.
- If Projects is not installed, onboarding must still work with existing Activities/Playbook steps.

### 12.6 Stream, Notes, Attachments, Audit

- Reuse generic panels and services.
- Add only CSM-specific event types/labels and metadata.
- Preserve ACL at the source record and attachment level.

### 12.7 External adoption analytics (future extension point)

For product usage data, define an adapter contract before implementing a connector:

- source/provider ID;
- last successful sync time;
- customer/account mapping and mapping confidence;
- normalized metric key, value, period, and unit;
- freshness and backfill behavior;
- source permission and retention classification;
- duplicate/out-of-order event handling.

Do not make direct vendor API calls from controllers or score calculators. Any external connector must use the repository's integration/secrets/job infrastructure and must be an explicit later integration task.

---

## 13. Configuration, Events, and State-Machine Invariants

The following invariants must hold regardless of which UI or API path is used:

1. One active CustomerSuccessProfile per Account.
2. Health score is null/Unknown when configured minimum signal coverage is not met.
3. A manual health override never overwrites the calculated score or calculated status.
4. Health snapshots cannot be created/edited by normal CRUD requests.
5. Every override has a reason, actor, timestamp, and configured review/expiry behavior.
6. Lifecycle state transitions are validated and audited server-side.
7. `Churned` is never inferred solely from a score, missing subscription, missing opportunity, or Critical risk.
8. Success Goal progress is bounded and computed with the direction-specific algorithm.
9. Completing a plan does not automatically mark every goal achieved; goal outcomes remain explicit.
10. Starting the same triggerable playbook twice with the same idempotency key does not create duplicate runs/steps/actions.
11. A completed playbook step is not rerun when retrying a failed step.
12. A failed optional integration signal does not cause the whole Profile read to fail.
13. User-visible related records are independently authorization-checked.
14. Events that initiate jobs are published after transaction commit or via transactional outbox.
15. Background jobs do not send external customer communications by default.
16. Seed/default operations are repeatable and never overwrite administrator-edited settings.
17. Deactivating the module must not destroy customer success history by default.

---

## 14. Implementation Roadmap — Phase 19-CS

Build the module incrementally. Do not implement every feature in a single code-generation pass. Sub-phase identifiers use `19-CS.*` to coexist with the separate Projects sub-phase identifiers.

### Phase 19-CS.0 — Repository Audit and Feature Contract

Tasks:

- Read `AGENTS.MD`, relevant `PLAN.md` sections, and relevant current module plans.
- Inspect actual Entity Engine, API, ACL, event, Activity, Calendar, Job, Notification, Dashboard and settings implementations.
- Verify whether Accounts/Contacts, Projects, Sales, Subscriptions, Cases/Service Desk, and health/score-related abstractions exist.
- Write `docs/implementation/customer-success-repository-audit.md`.
- Write/define `docs/compatibility/customer-success.md` with custom-module behavior and known differences.
- Finalize the minimum CSM entities/relations using existing metadata conventions.

Exit criteria:

- No unsupported subsystem is assumed to exist.
- All mandatory prerequisites are verified.
- Optional integrations are clearly marked as installed/unavailable.
- No code changes duplicate generic platform services.

### Phase 19-CS.1 — Module Scaffold and Registration

Tasks:

- Add module manifest/registration using the established extension SDK.
- Register `CustomerSuccessModule` providers, controllers/actions, metadata, navigation entries, translations, and permissions.
- Ensure module startup works when optional integration modules are absent.
- Add module settings namespace and health checks/diagnostics if the platform supports them.
- Add minimal module-level automated tests.

Exit criteria:

- The application boots with the module enabled.
- The module can be disabled or omitted without breaking core CRM startup.
- No duplicate providers or naming conflicts are introduced.

### Phase 19-CS.2 — Metadata, Schema, and Core Profile

Tasks:

- Define Profile metadata, relation to Account, fields, layouts, ACL scope, validation, and unique active Account rule.
- Add versioned additive migrations for required fields/indexes/tables only after reviewing actual platform conventions.
- Register profile CRUD through the Entity Engine.
- Implement server-side Account/owner/team relation validation.
- Add safe, permission-aware Profile creation and update services.
- Register idempotent initial settings/default lifecycle values without overwriting existing settings.

Exit criteria:

- A permitted user can create/read/update a Profile linked to an existing permitted Account.
- Duplicate active profiles are blocked by both service validation and database constraint.
- Ordinary API input cannot set system-calculated fields.
- Schema migration preserves all existing CRM data.

### Phase 19-CS.3 — Portfolio, Assignment, and Lifecycle

Tasks:

- Implement CSM assignment and reassignment with audit/events.
- Implement lifecycle configuration, server-side transition rules, reason requirements, and history.
- Implement My Portfolio, Team Portfolio, Unassigned, and lifecycle queues through ACL-scoped queries.
- Add filters, sort rules, pagination, saved views and bulk assignment/transition where supported.
- Add per-record bulk-operation results and validation.

Exit criteria:

- CSM, team lead, admin, and unauthorized-user tests pass.
- Lifecycle and assignment cannot be changed by bypassing UI rules.
- Portfolio aggregates do not leak inaccessible Account records.

### Phase 19-CS.4 — Health Scoring Configuration and Built-in Signals

Tasks:

- Implement the HealthSignalProvider contract/registry.
- Implement only signal providers backed by verified existing data.
- Implement versioned scoring configuration, weight/threshold validation, freshness windows, missing-data policy, and minimum coverage.
- Add deterministic weighted score computation and health classification.
- Add unit tests for no-signal, stale-signal, partial-coverage, rounding, weight normalization, threshold boundaries, and invalid configuration.

Exit criteria:

- Health score computation is a pure/testable domain operation where practical.
- Unknown is not treated as zero.
- Configuration invalidity is rejected with actionable errors.
- No optional integration is assumed available.

### Phase 19-CS.5 — Health Snapshots, Explanation, and History

Tasks:

- Add append-only HealthSnapshot persistence and score-history queries.
- Store configuration version, signal coverage, component values/weights, calculation source, and result state.
- Implement snapshot deduplication/material-change rules.
- Add manual on-demand recalculation and rate limits.
- Add explanation and trend APIs; register read-only access controls.
- Add manual health override/clear override flow with reason, audit, expiry/review policy, and separate calculated/effective status.

Exit criteria:

- Users can explain a health result and trace it to permitted data sources.
- A manual override does not rewrite the calculated score.
- Normal CRUD cannot forge or delete snapshots.
- Repeated identical recalculation follows the documented deduplication policy.

### Phase 19-CS.6 — Success Plans and Goals

Tasks:

- Implement Success Plan and Success Goal metadata/entities, relationships, permissions, layouts, and API.
- Add plan state transitions, one-primary-active-plan rule if selected, and plan templates/copy behavior.
- Implement direction-aware goal progress calculations and checkpoint/audit history.
- Recalculate plan summary and queue health updates on relevant changes.
- Add Account/Profile related panels and goal/plan views.

Exit criteria:

- Goal metrics and progress behave correctly for increase, decrease, maintain, boolean, and manual goals.
- Historical plans/goals remain auditable.
- Optional Project links work only when Projects is available; the module works without Projects.

### Phase 19-CS.7 — Risks, Mitigation, and Escalation

Tasks:

- Implement CustomerSuccessRisk entity and transitions.
- Add severity, owner, due dates, evidence references, mitigation action, escalation, resolution reason, and reopening behavior.
- Add queues for High/Critical, overdue, unassigned, and recently changed risks.
- Add health-signal adapter for open risks.
- Add in-app alerts through the existing Notification service if available.

Exit criteria:

- Risk transitions are validated, permission-checked, and audited.
- High/Critical risks have mitigation or a documented exception.
- A risk may influence health but never automatically sets lifecycle to Churned.

### Phase 19-CS.8 — Onboarding and Playbook Core

Tasks:

- Implement Playbook Template, Run, and Step Run entities/services.
- Add step-schema validation and supported step-type registry.
- Implement manual run start, snapshot of template version, step completion/skip, pause/cancel, and safe retry.
- Add onboarding defaults and Profile onboarding summaries.
- Link human-work steps to existing Activities/Tasks when supported.
- Add idempotency keys and transaction-safe run creation.

Exit criteria:

- A user can start and execute an onboarding playbook end-to-end.
- Duplicate requests/events do not duplicate runs or tasks.
- Editing a template does not mutate an existing run.
- No arbitrary script execution or direct external communication exists.

### Phase 19-CS.9 — Success Reviews and Touchpoint Integration

Tasks:

- Integrate generic Activities, Calendar, Stream, and Contacts.
- Define and test meaningful-touch eligibility rules.
- Add Success Review form/record only if generic Activities cannot represent structured review fields safely.
- Link reviews to existing Activity records and track next review date.
- Add recent activity, last meaningful touch, and next review summaries.

Exit criteria:

- No duplicate scheduling or activity system exists.
- Activity ACL remains intact across Profile/Account panels.
- Engagement signals exclude unrelated/internal events according to the rule set.

### Phase 19-CS.10 — Renewal Readiness and Optional Domain Adapters

Tasks:

- Implement manual renewal readiness and window queries.
- Define source precedence and freshness for external/commercial renewal dates.
- Add adapters for Opportunity, Subscription, Case/Service Desk, and Projects only when the actual modules are present.
- Add data-source health/diagnostic indicators and safe fallbacks.
- Add renewal queues and source-record links.

Exit criteria:

- Customer Success works if every optional module is absent.
- Source errors never erase valid manual data.
- CSM cannot view linked commercial/support details beyond existing ACL.

### Phase 19-CS.11 — Jobs, Triggers, and Notifications

Tasks:

- Register batch health recalculation, override expiry, overdue goal/risk/review evaluation, renewal windows, and playbook wait-step jobs as applicable.
- Add event-triggered recalculation for supported sources.
- Add transaction/outbox integration, idempotency, concurrency controls, retry and observability.
- Configure notification deduplication and recipient rules.
- Ensure tests disable outbound email/webhooks and use in-app notification records only.

Exit criteria:

- Jobs are retry-safe, bounded, monitored, and can be paused through established operations controls.
- No event recursion or notification storms occur in tests.
- No in-memory timer/scheduler or custom queue is introduced.

### Phase 19-CS.12 — React UI and Navigation

Tasks:

- Add navigation and Portfolio Overview using existing route/metadata conventions.
- Implement Profile list/detail, health explanation/history, plan/goal panels, risk queues, onboarding/playbook views, review links, and renewal queues.
- Add Admin configuration pages for stages, health scoring, playbook defaults, and renewal windows.
- Add accessibility, loading/error/empty states, responsive behavior, and permission-gated quick actions.
- Use existing design system and chart components.

Exit criteria:

- Main CSM workflows can be completed through the SPA without manual API calls.
- UI does not reveal unauthorized records or rely on colors alone.
- All critical mutations are validated server-side.

### Phase 19-CS.13 — Dashboards, Search, Bulk Operations, and Export

Tasks:

- Add CSM dashlets/portfolio summaries through the existing dashboard/report framework.
- Register searchable/filterable fields and safe drill-down behavior.
- Add bulk recalculate/assign/transition/playbook-start only where supported and safe.
- Reuse generic import/export when available.
- Add performance indexes based on measured query patterns.

Exit criteria:

- Dashboard aggregates honor ACL.
- Large lists are paginated and filtered server-side.
- Bulk operations return precise per-record success/failure results.

### Phase 19-CS.14 — Security, Compatibility, and Data Safety Review

Tasks:

- Review every route/action for authorization bypass and IDOR.
- Review scoring/configuration validation, query construction, JSON payloads, event consumers, and job authority.
- Test migrations on the already-configured primary database after inspection; do not create another database.
- Verify module disable/enable behavior and retention of CSM history.
- Document custom behavior, optional integration status, limitations, and operator setup.
- Run unit tests, type-check, lint, safe integration/API tests, and critical UI flows using the existing test lifecycle.

Exit criteria:

- Required acceptance criteria are met.
- No extra database has been created.
- No destructive data change was made without explicit task-specific authorization.
- Actual test commands and results are recorded in the implementation summary.

---

## 15. Testing Strategy

All database-backed tests MUST follow `AGENTS.MD`. Do not create a new database to satisfy a test framework default.

### 15.1 Unit tests

Cover at least:

- Health score normalization, weighted calculation, threshold edges, missing/stale signal policies, rounding, and configuration version selection.
- Health `Unknown` behavior for absent/insufficient signals.
- Manual override, expiry, calculated-vs-effective status separation, and reasons.
- Lifecycle transitions and required reasons.
- Goal progress for all supported directions, zero/negative values, equal baseline/target, and overdue outcomes.
- Plan summary calculations and active-plan rule.
- Risk transition rules and required mitigation/resolution details.
- Playbook template schema validation, run snapshotting, idempotency keys, step dependencies, retry behavior, and wait-step logic.
- Meaningful-touch qualification and recency calculation.
- Renewal-window boundaries, timezone, null values, and source precedence.
- Portfolio filter/sort semantics and privacy-safe aggregation rules.

### 15.2 Integration tests

Using the already-configured primary database and the established migration lifecycle, verify:

- Profile-to-Account uniqueness and referential integrity.
- Health snapshot append-only behavior and profile summary update.
- Transactions for starting playbooks and changing state.
- Goal/plan/risk persistence and relation access.
- Job idempotency and safe retry markers.
- Event/outbox behavior if supported.
- Optional integration adapters return an explicit unavailable state when no provider exists.
- Migrations are additive and do not alter unrelated records.

Do not provision a separate database, shadow schema, per-test database, or database container.

### 15.3 API/security tests

For each key route, test success, invalid input, unauthenticated access, unauthorized access, inaccessible related ID, invalid state transition, stale/concurrent update where supported, and field-level restrictions.

Specifically test:

- A user cannot query or update another CSM's profile when ACL prohibits it.
- A user cannot access a HealthSnapshot by guessing its ID.
- A user cannot link an inaccessible Contact, Activity, Case, Project, Opportunity, or Subscription.
- A client cannot spoof calculated scores, audit actor, or system status.
- Aggregation endpoints do not reveal names or counts outside the user's authorized scope.
- Playbook retries do not duplicate already-completed actions.
- Malformed JSONB/configuration payloads are rejected safely.

### 15.4 UI tests

Use the already-configured browser test environment only if it does not create another database. Verify:

- Create Profile, assign CSM, change lifecycle, and find it in portfolio.
- View health explanation and history.
- Create a Success Plan and Goal; update goal progress.
- Create/mitigate/resolve a Risk.
- Start and complete an onboarding/playbook run.
- Schedule a Success Review using the existing Activity framework.
- Review renewal readiness and drill into a source record only when permitted.
- Check permission-based hiding/denial and mobile/responsive layout basics.

### 15.5 Regression tests

- Core Accounts/Contacts CRUD remains unchanged.
- Existing Entity Engine, API, ACL, Activities, Calendar, Stream, Notifications, and Jobs continue to work.
- The module can boot with optional Sales, Projects, Cases, and Subscription modules not installed.
- Turning off the Customer Success module does not delete historical data or prevent core CRM startup.
- No existing Account or Contact is modified by test setup unless it was created specifically for that test run.

---

## 16. Acceptance Criteria

The module is considered complete only when all required criteria below are met.

### 16.1 Core CSM

- [ ] CustomerSuccessProfile is linked to Account and has a unique active profile constraint.
- [ ] Portfolio views support CSM ownership, team scope, lifecycle, health, renewal, onboarding, and risk filters.
- [ ] Lifecycle transitions are validated, auditable, and configurable.
- [ ] Customer-facing context is visible without duplicating the Account or Activity model.

### 16.2 Health scoring

- [ ] Health scoring is deterministic, versioned, and configurable.
- [ ] Missing signals are not silently interpreted as zero.
- [ ] Score/status explanation and snapshots are available to authorized users.
- [ ] Manual overrides preserve the underlying calculated result and require a reason.
- [ ] Scheduled/event-triggered/on-demand calculation cannot produce an infinite loop or runaway writes.

### 16.3 Plans, goals, risks, onboarding

- [ ] Success Plans support lifecycle, owners, timeframe, goals, and progress summary.
- [ ] Goal progress is correct for all supported directions and edge cases.
- [ ] Risks support owner, severity, mitigation, due date, escalation, resolution, and history.
- [ ] Onboarding/playbooks can generate or link existing Activities without creating a duplicate generic task system.
- [ ] Playbook execution is idempotent, observable, resumable, and safe to retry.

### 16.4 Renewals and integration

- [ ] Renewal readiness works with manual fields alone.
- [ ] Optional domain integrations are feature-detected and ACL-safe.
- [ ] Absence/failure of an optional provider does not break core Profile operations.
- [ ] Customer Success is not a billing, support-ticketing, or project-management replacement.

### 16.5 Security, data, and operations

- [ ] All API operations use server-side ACL and DTO validation.
- [ ] Entity relations and aggregate queries prevent IDOR/information leakage.
- [ ] Migrations are reviewed, versioned, additive where possible, and preserve existing CRM data.
- [ ] Tests used only the already-configured database; no extra test database/schema was created.
- [ ] No broad data cleanup, database reset, truncation, or drop was performed.
- [ ] Unit tests, type checking, lint, targeted integration/API tests, and critical UI tests pass, or the report explains exactly what could not be run.
- [ ] OpenAPI and module documentation are updated.
- [ ] `docs/compatibility/customer-success.md` describes custom behaviors and known deviations.

---

## 17. Performance, Reliability, and Observability

- Portfolio pages must use server-side filtering, pagination, and authorized aggregates.
- Score calculation must avoid N+1 queries; load signal data in batches where possible.
- Health batch jobs must have bounded batch sizes, resumable cursors, and backpressure compatible with the existing queue.
- Do not calculate every Profile synchronously during application startup or every portfolio page load.
- Cache only where the project's caching conventions are established; invalidate on the events that can change the value.
- Cache keys must include relevant ACL/user scope when caching authorization-dependent aggregates.
- Use stable, bounded queries and add indexes based on measured plans.
- Track job duration, processed/skipped/failed counts, retry counts, stale profiles, unknown-health count, and playbook failure count via the existing logging/metrics system.
- Do not log customer message bodies, confidential notes, tokens, API keys, or full database connection URLs.
- Handle deleted/inaccessible linked records without turning the entire portfolio page into a server error.
- For partial scoring failure, preserve the last valid snapshot and separately mark that the last attempted calculation failed; do not silently replace a good score with an incorrect zero.

---

## 18. Operational Documentation and Deliverables

The coding agent should deliver/update:

- `docs/implementation/customer-success-repository-audit.md`
- `docs/compatibility/customer-success.md`
- Module README describing setup, entities, routes, permission scopes, scoring semantics, jobs, and optional integrations.
- Metadata/entity definitions and versioned migrations.
- REST/OpenAPI documentation and sample payloads using synthetic values.
- Admin guide for scoring weights, thresholds, signal availability, lifecycle options, playbooks, notifications, and renewal windows.
- Operator guide for scheduled jobs, failed playbook runs, recalculation, diagnostics, and migration rollback/forward-fix strategy.
- Tests and test result summary.
- A completion report mapping each sub-phase to files changed, migrations, checks actually run, results, unresolved gaps, and any data writes performed.

Do not report a test as passed unless the command was actually executed and passed. Clearly separate completed work, skipped work, known issues, and recommendations.

---

## 19. Coding Agent Execution Rules

1. Read `AGENTS.MD` and relevant `PLAN.md` sections before touching code.
2. Begin with Phase 19-CS.0 and inspect the real repository before implementing assumptions.
3. Implement one sub-phase at a time; keep each change reviewable and test it before moving on.
4. Reuse generic platform services. Do not build a second ORM, ACL system, Activity scheduler, notification engine, job queue, dashboard framework, or settings store.
5. Preserve existing code and user changes; inspect `git status` first and do not overwrite unrelated work.
6. Follow existing TypeScript style, DTO conventions, migration conventions, error handling, and module registration patterns.
7. Do not introduce new third-party dependencies without checking existing packages and documenting the reason.
8. Never trust UI-only authorization or client-provided calculated values.
9. Inspect any script or command before running it if it may create/reset a database, run seeds, trigger external communication, or perform destructive migrations.
10. Use the configured primary database for targeted integration verification when needed. **Do not create another database or schema for tests.**
11. Test data must be identifiable, narrowly scoped, and cleaned up only by exact IDs/run markers created by the current run.
12. Do not use real customer records or send real external communications in tests.
13. Do not weaken assertions, bypass ACL, swallow errors, or mark failed migrations as applied to achieve a green test result.
14. If a required capability is missing, document the gap and implement only the smallest reusable dependency needed; do not silently ship a degraded feature as if it works.
15. Finish each sub-phase with a concise report: files changed, behavior delivered, migrations/seed changes, tests actually run, test results, and remaining work.

---

## 20. Definition of Done

Phase 19 Customer Success is done when the module provides a secure, explainable, maintainable CSM workflow on the existing CRM platform: profiles and portfolios; lifecycle tracking; health scoring with auditable history; success plans and goals; risk mitigation; onboarding/playbooks; touchpoint and renewal readiness; useful portfolio UI; and optional integrations that degrade safely.

The implementation must use the established NestJS modular-monolith architecture, Entity Engine, `/api/v1` conventions, ACL, event/job infrastructure, React SPA, and configured database. It must preserve existing CRM data, avoid duplicate platform subsystems, and include tests/documentation for its domain behavior.

**Recommended coding-agent starting prompt:**

> Read `AGENTS.MD`, `PLAN.md`, and `PLAN_Phase_19_Customer_Success.md`. Execute Phase 19-CS.0 only: audit the actual codebase, verify available kernel/domain capabilities and optional integrations, and write the repository audit plus compatibility contract. Do not implement later phases until the audit is complete. Do not create any database or schema. Preserve existing data and changes.
