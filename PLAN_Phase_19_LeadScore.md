# Phase 19 — Lead Scoring & Conversion Module (`LeadScore`)

> **Status:** Planned  
> **Parent roadmap:** `PLAN.md` — Advanced CRM Domains  
> **Canonical module name:** `LeadScore`  
> **Module key / frontend slug:** `lead-score`  
> **NestJS module class:** `LeadScoreModule`  
> **Naming rule:** Do not add the `Ua` prefix to module names, classes, routes, migration names, configuration keys, events, packages, or documentation identifiers.  
> **Target runtime:** Existing NestJS / TypeScript backend and React SPA  
> **Persistence:** Existing PostgreSQL and repository-selected SQL layer (Kysely unless repository audit shows a deliberate alternative)  
> **Primary domain owner:** Existing CRM `Lead` entity; `LeadScore` extends lead qualification and conversion behavior without replacing the core Lead, Contact, Account, or Opportunity entities.  
> **Implementation principle:** Clean-room implementation, metadata-aware, server-authorized, explainable, and integrated with the existing CRM kernel and `MarketingAutomation`, `Sales`, `AIAgents`, and other available modules.

---

## 0. Instructions for the Coding Agent

Read `AGENTS.MD`, `PLAN.md`, this plan, and the actual Lead, Contact, Account, Opportunity, ACL, metadata, audit, workflow, job, and UI implementations before changing code.

This plan defines desired behavior; it is not evidence that every dependency already exists. **Begin with Phase `19-LS.0` only.** Inspect the repository, current Lead fields and lifecycle, module registration, migrations, APIs, tests, and configured database before deciding what must be added. Record findings in a repository audit/feature-contract document before implementing later phases.

### 0.1 Non-negotiable implementation rules

1. The module is named **`LeadScore`**. Do not create `UaLeadScore`, `UaLeadScoring`, or other `Ua*` names.
2. Reuse the canonical CRM `Lead`, `Contact`, `Account`, and, where supported by the current product, `Opportunity` entities. Do not build duplicate versions of these entities.
3. Reuse the existing Entity Engine, metadata registry, field validation, relationships, ACL, record-level and field-level permissions, audit/history, Activities, Stream, Notifications, Jobs, Workflows/BPM, Search, Dashboards, Reports, and UI primitives when available.
4. Do not assume `MarketingAutomation`, `AIAgents`, or `Sales` exposes a particular event or API simply because a plan describes it. Audit the actual implementation and agree on a stable contract first. Optional integrations must degrade gracefully when a module is disabled.
5. Lead scoring must be explainable and versioned. Store the score's model version, evaluation time, input freshness, component breakdown, and reason codes. A score must not be an unexplained number.
6. Do not use sensitive or protected personal characteristics, or unjustified proxies for them, as scoring factors. Do not infer health, ethnicity, religion, political views, disability, or other protected/sensitive attributes from communications or demographic data.
7. AI-derived assessments, if added, must be optional, auditable, bounded, and clearly separated from deterministic rule scoring. The model must not invent missing facts or silently override deterministic scoring rules.
8. **Lead conversion must be an explicit business operation, not an in-place entity-type mutation.** Preserve the original Lead as a historical record with `Converted` status and explicit references to created or linked records. Do not delete the Lead after conversion.
9. The conversion flow must support creating or linking a Contact and/or Account, subject to the product's B2B/B2C configuration and the user's permissions. If Opportunity conversion is already part of the CRM's documented Lead workflow, support it through the same conversion command; do not create a second Opportunity implementation.
10. Check for duplicates before creation. Show ambiguous matches to the user; never silently merge records or choose a possibly unrelated record based on fuzzy similarity alone.
11. Conversion must be transactional and idempotent. Repeating a request must not create duplicate Contacts, Accounts, or Opportunities. Use a stable conversion operation ID/idempotency key and unique constraints where appropriate.
12. Keep Lead-to-converted-record links, copied-field provenance, conversion actor, timestamp, and conversion operation identifier for audit and retry recovery.
13. Do not create a test database, shadow database, temporary database, test schema, per-agent database, or per-run database. Follow `AGENTS.MD` and use the configured primary database for permitted targeted checks only.
14. Never reset, truncate, drop, recreate, or broadly delete data. Review migrations before applying them. Use clearly marked `AGENT_TEST_...` records for tests and clean up only records created by the current run, by exact IDs.
15. Do not use real customer records for scoring/conversion tests. Do not send live marketing messages, external notifications, or third-party writes as a side effect of automated tests.
16. Do not introduce a second ORM, scoring engine, workflow engine, queue, or permission system. Follow the architecture and dependency choices already present in the repository.
17. Do not report a sub-phase complete until its acceptance criteria and actual verification results have been recorded.

### 0.2 Clean-room reference boundary

Use official documentation as a source for observable CRM behavior, not as source code. Do not copy or mechanically translate PHP source files, frontend assets, translations, icons, branding, or other copyrighted materials.

Official functional references:

- EspoCRM Sales Management / Leads and Converting: https://docs.espocrm.com/user-guide/sales-management/
- EspoCRM Leads overview: https://www.espocrm.com/features/leads/
- EspoCRM Web-to-Lead: https://docs.espocrm.com/administration/web-to-lead/
- EspoCRM Entity Manager / Layout Manager: https://docs.espocrm.com/administration/entity-manager/ and https://docs.espocrm.com/administration/layout-manager/
- EspoCRM Workflows: https://docs.espocrm.com/administration/workflows/
- EspoCRM developer documentation: https://docs.espocrm.com/development/

The official Sales Management documentation describes Lead conversion through a conversion form where the user selects target record types such as Account, Contact, and/or Opportunity. A converted Lead remains in the system with a Converted status and references to the records created by conversion. The documented B2C mode has a constraint around conversion to Accounts. Verify the repository's selected compatibility baseline and record any intentional differences in `docs/compatibility/lead-score.md`.

---

## 1. Purpose and Product Outcome

Implement a first-class `LeadScore` module that helps sales and marketing teams prioritize Leads with transparent, configurable qualification scores and provides a safe, guided Lead conversion experience.

The module has two closely related capabilities:

1. **Lead scoring and qualification:** calculate and explain how well a Lead matches the target customer profile and how much buying intent or engagement has been observed.
2. **Lead conversion:** guide authorized users through converting a qualified Lead into a Contact and/or Account, optionally including an Opportunity when supported by the existing CRM sales lifecycle, while preventing duplicates and preserving the original Lead's history.

`LeadScore` is not a replacement for core Lead management. It adds scoring fields, score models, score history, qualification actions, and conversion orchestration around the existing Lead entity.

### 1.1 Business outcomes

At completion, authorized users can:

- See the current score, qualification status, score trend, score model version, last-calculated time, and reason breakdown on a Lead.
- Configure one or more scoring models with positive and negative weighted rules.
- Score explicit fit, intent, engagement, completeness, and recency signals using permitted CRM data.
- Recalculate scores on relevant record changes and supported business events, with safe background processing for large volumes.
- Identify hot, warm, cold, stale, incomplete, and disqualified Leads using configurable thresholds and reason codes.
- Filter and sort Lead lists by score, qualification band, score freshness, and score movement.
- See why a Lead gained or lost points and which data or event contributed to a particular result.
- Preview conversion outcomes before creating records, select the Contact/Account conversion path, and map fields safely.
- Link the converted Lead to an existing matching Contact or Account when the user has permission and the match is unambiguous.
- Create an Account and/or Contact from Lead data when appropriate, preserving relationships such as Contact-to-Account.
- Optionally create or link an Opportunity as part of conversion if Opportunity is a supported target in the existing CRM implementation.
- Avoid duplicate conversion records when a user retries, refreshes, double-clicks, or receives a network timeout.
- Keep the original Lead, its activities, notes, campaign attribution, consent history, and audit trail accessible after conversion subject to ACL.
- Trigger existing workflow/job/notification services after a score threshold change or successful conversion where configured.

### 1.2 Product principles

- **Explainability over mystery:** every displayed score must have an understandable breakdown and a timestamp.
- **Deterministic baseline first:** implement a rule-based score engine before adding AI-based fit prediction.
- **Score is not truth:** a high score is a prioritization signal, not proof that a prospect will buy.
- **Missing is not negative by default:** missing signals must be represented as unknown or neutral unless a rule explicitly defines otherwise.
- **No hidden mutation:** conversion is previewed and confirmed; there is no silent Lead-to-Contact row rewrite.
- **One canonical person/company record:** prefer linking existing Contacts/Accounts over duplication.
- **Preserve history:** Lead remains as the original acquisition/qualification record after conversion.
- **Authorization at every layer:** score calculation, related-record matching, conversion preview, and conversion execution enforce server-side ACL.
- **Reproducible results:** the score engine should produce the same result for the same model version, input snapshot, and rule event history.
- **Small, composable domain module:** reuse CRM Core, MarketingAutomation, Sales, Workflows/BPM, Jobs, AIAgents, and Reports only through actual, audited contracts.

---

## 2. Scope and Non-Goals

### 2.1 In scope

- Rule-based lead scoring models, rule groups, conditions, weights, decay, thresholds, and versioning.
- Score evaluation, score breakdown, score history, evaluation status, freshness indicators, and recalculation.
- Qualification bands such as Cold, Warm, Hot, Sales-Ready, and Disqualified, configurable per model.
- Scoring input from permitted Lead fields and related CRM signals.
- Optional event-based engagement inputs from MarketingAutomation or VoiceCommunications when those sources exist and their contracts permit it.
- Optional AI-assisted fit summary/classification through AIAgents, not as a prerequisite for core scoring.
- Lead list filters, score badges, score trend panels, rule/model administration, and conversion wizard UI.
- Field mapping and default-value configuration for Lead-to-Contact/Account conversion.
- Duplicate detection, candidate selection, merge/link choices, preview, confirmation, transactional creation/linking, audit, retry recovery, and post-conversion references.
- Optional Opportunity creation/linking if the current repository has Opportunity and its conversion contract supports it.
- APIs, metadata, permissions, translations, tests, monitoring, and operational documentation.

### 2.2 Out of scope for the initial delivery

- Replacing the core Lead entity or its ordinary CRUD/list/detail/search behavior.
- Replacing MarketingAutomation's audience segmentation, email journeys, campaign delivery, or consent system.
- Replacing Sales or implementing a second Opportunity pipeline.
- An opaque proprietary predictive model trained on customer data without documented governance, evaluation, and consent.
- Automatically converting Leads solely because a score threshold was reached.
- Unsupervised automatic merges across Contact/Account records.
- Bulk conversion of large sets without preview, permission checks, and explicit user confirmation.
- Destructive deletion of source Leads after conversion.
- Using the score to make legal, credit, hiring, healthcare, or other high-impact decisions unrelated to CRM sales prioritization.
- Rewriting CRM history or moving Lead-related activities in a way that loses their original provenance.

### 2.3 Explicit ownership boundaries

| Capability | Owner | `LeadScore` responsibility |
|---|---|---|
| Lead entity and base Lead lifecycle | CRM Core | Extend metadata/commands through existing patterns; do not duplicate Lead CRUD |
| Contact and Account entities | CRM Core | Create/link them through their authoritative services and ACL |
| Opportunity pipeline | Core Sales / existing CRM domain | Invoke documented creation/linking contract only when supported |
| Campaign journeys and engagement collection | MarketingAutomation | Consume approved engagement events/aggregates; do not recalculate marketing delivery analytics |
| Agent orchestration | AIAgents | Optional fit insight or assisted explanation through its public contract; do not embed another agent runtime |
| Workflows, scheduled jobs, queues | Platform | Register actions/jobs through existing services |
| Reports and dashboards | Platform / Reports | Publish score metrics or saved report definitions if supported |
| Record permissions, audit and metadata | CRM Kernel | Reuse existing mechanisms throughout |

---

## 3. Definitions and Core Concepts

### 3.1 Lead score

A numeric value generated from a versioned score model. Recommended initial range: 0–100, configurable only if the repository's current numeric scoring conventions require another range. The UI must always show the scale.

Each evaluated result must include:

- `leadId`.
- `modelId` and immutable `modelVersion`.
- `scoreValue` and normalized scale.
- `qualificationBand`.
- `calculatedAt`.
- `inputAsOf` / freshness metadata.
- `ruleResults`: matched, not matched, unknown, skipped, expired, and error states where appropriate.
- `positiveReasons` and `negativeReasons`.
- `coverage` or `knownSignalRatio` where it helps users interpret incomplete information.
- `evaluationStatus`: `current`, `stale`, `pending`, `failed`, or `not_scored`.

### 3.2 Scoring dimension

An optional grouping such as:

- **Fit:** industry, organization size, region served, role/title, business type, or other non-sensitive ICP fields approved by administrators.
- **Intent:** pricing-page inquiries, demo requests, explicit buying requests, high-intent form submissions, or approved CRM events.
- **Engagement:** permitted email clicks, event attendance, replies, inbound calls, meetings, or meaningful interactions from modules that provide trusted events.
- **Completeness:** presence of useful business data such as verified work email or a known organization; do not reward collection of unnecessary personal data.
- **Recency:** how recently a qualified engagement event occurred, with bounded decay to avoid stale activity inflating a score indefinitely.
- **Negative signals:** explicit disqualification, invalid/bounced contact information, not-in-market status, or no longer interested, provided rules are transparent and do not conflict with lawful consent/retention needs.

The exact dimensions are configurable. These are examples, not hard-coded universal sales rules.

### 3.3 Qualification band

A human-readable label derived from score thresholds and/or an explicit rule, for example `Cold`, `Warm`, `Hot`, `Sales Ready`, and `Disqualified`. Bands must be configurable and versioned. `Disqualified` may be controlled by an explicit lifecycle signal instead of a numeric threshold; do not imply that a low score means a Lead is disqualified.

### 3.4 Lead conversion

A domain operation that creates and/or links target records from the source Lead. It does not change the Lead's database table or delete it. Successful conversion records:

- Source Lead ID.
- Target Contact ID, when selected.
- Target Account ID, when selected.
- Target Opportunity ID, when the existing CRM supports and the user selected it.
- Conversion operation ID and status.
- Actor and timestamp.
- Target choices, field mapping/version, and match decisions.
- A compact audit summary of created versus linked records.

### 3.5 Conversion combinations

The conversion wizard should support valid combinations determined by configuration and available entity relationships:

- Create a new Contact; optionally associate it with an existing Account.
- Create a new Account and a new Contact associated with it.
- Create a new Account without a Contact, if business rules allow an organization-only Lead.
- Link an existing Contact and/or Account selected by the user after duplicate review.
- Link a Contact to an existing Account when the relationship is confirmed.
- Create or link an Opportunity only if enabled and available in the current implementation.
- Contact-only conversion for person-oriented/B2C flows where Account is disabled or not applicable.

Never create an invalid partial combination due to a hidden frontend condition. The backend must validate configuration and selected targets.

---

## 4. Architecture and Integration Design

### 4.1 Modular-monolith placement

Follow current repository structure. Suggested responsibility layers, adapting naming to existing conventions:

- `LeadScoreModule`: module wiring, route/controller registration, permissions, event subscribers, jobs, and metadata registration.
- `LeadScoreModelService`: CRUD/publishing/version lifecycle for scoring models.
- `LeadScoreRuleValidator`: validates rule schemas and limits.
- `LeadScoreEvaluator`: deterministic evaluation of a model against a validated snapshot of Lead inputs and approved events.
- `LeadScoreCalculationService`: orchestrates snapshots, caching, current-result updates, history persistence, and emitted events.
- `LeadScoreRecalculationJob`: performs bounded batch recalculation and handles retries.
- `LeadScoreExplanationService`: builds human-readable, localized reasons from stable rule codes and result data.
- `LeadQualificationService`: optional transition from score band to existing Lead qualification/status using allowed, configured behavior.
- `LeadConversionService`: preview, validate, deduplicate, create/link targets, and persist conversion outcome.
- `LeadDuplicateResolver`: retrieves candidate matches through permitted canonical entity queries and produces transparent match reasons.
- `LeadFieldMappingService`: validates field mappings and derives target payload previews.
- `LeadConversionAuditService`: stores conversion operation status, actor, mapping version, and result links using platform audit facilities and any minimal module-specific operation record.
- `LeadScoreController` / `LeadConversionController`: API boundary; no business logic in controllers.
- `LeadScore UI`: score panel, model administration, list filters, and conversion wizard in the existing React SPA.

These are conceptual service boundaries. Do not create every class mechanically if the repository uses different established patterns; the audit should identify the smallest coherent implementation.

### 4.2 Scoring execution flow

1. A relevant Lead field or approved business event changes.
2. The domain event handler validates the event source, checks applicable permissions/system identity, and schedules a recalculation using the platform job/event mechanism.
3. The job loads the current published model version and only the input fields/relations that model is allowed to use.
4. The rule validator/evaluator executes deterministic, bounded rules with explicit missing-data semantics.
5. Evaluation output is persisted as a current score projection and an immutable historical evaluation record (or the repository's equivalent history pattern).
6. If the score/band meaningfully changes, emit a versioned `leadScore.updated` domain event.
7. Optional notification/workflow actions run through existing infrastructure and are idempotent.
8. UI displays current score, explanations, input freshness, and model version.

Do not synchronously run expensive scoring for every list row or during all Lead reads. Use on-demand calculation only for small/explicit operations and safe background recalculation for events and bulk work.

### 4.3 Conversion execution flow

1. Authorized user clicks Convert from Lead detail/list context.
2. API generates a conversion preview using the current Lead snapshot, configured conversion mode, field mapping, and duplicate candidates visible to that user.
3. UI asks whether to create or link an Account/Contact and, when supported, an Opportunity. It shows target fields, duplicate candidates, required values, and existing related records.
4. User confirms a specific preview and submits a conversion operation ID/idempotency key plus a version/revision token for optimistic concurrency.
5. Backend reloads the Lead and relevant target records, rechecks ACL, checks the Lead is not already converted, validates candidate IDs and mapping, and rejects stale/changed previews that require reconfirmation.
6. Backend starts a transaction or uses the strongest atomic strategy supported by the repository persistence layer.
7. Create/link selected Account and Contact; create/link Opportunity if enabled. Use canonical entity services and normal validation.
8. Set Lead to the converted lifecycle status, store target references and conversion metadata, and preserve notes/activities/attribution relationships according to the migration/relationship strategy.
9. Persist conversion audit and outbox/domain event data in the same transaction where possible.
10. Commit. After commit, notify downstream systems through the existing event/job infrastructure.
11. Return created/linked record IDs and links, plus any non-fatal post-commit integration warnings.
12. A retry with the same operation key returns the existing result rather than creating duplicates.

If the repository cannot guarantee an atomic operation across all target records, implement a durable conversion operation state machine (`pending`, `processing`, `succeeded`, `failed_retryable`, `failed_final`, or equivalent), plus compensation/recovery steps that are explicit and auditable. Do not pretend a partially completed operation was atomic.

### 4.4 Entity Engine and metadata

- Use the existing metadata/entity registration mechanisms for Lead fields, score fields, relationships, and UI layouts.
- Avoid ad hoc direct table queries where the Entity Engine or canonical domain service must enforce ACL and metadata rules.
- The evaluator may use a narrow read model or optimized SQL for score calculation only if it first applies validated model field paths and access policies and never accepts arbitrary SQL from rule definitions.
- Conversion targets must be created through canonical entity/service paths so default values, validation, hooks, audit, ACL, relationships, and events execute consistently.

---

## 5. Data Model and Persistence Strategy

Start by inspecting whether the repository already supports configurable rules, dynamic fields, record history, event tables, idempotency keys, outbox events, and workflow versioning. Reuse existing structures whenever suitable. The following logical entities are requirements, not an instruction to create duplicate infrastructure.

### 5.1 LeadScoreModel

Fields (adapt to platform conventions):

- `id`, `name`, `description`.
- `status`: `draft`, `published`, `archived`.
- `version` / immutable published version identifier.
- `scaleMin`, `scaleMax` (default 0–100).
- `baseScore` or neutral starting point.
- `scoreFloor`, `scoreCeiling`.
- `dimensionWeights` or validated weighted components, where applicable.
- `qualificationBands` with validated, non-overlapping thresholds/conditions.
- `effectiveFrom`, optional `effectiveTo`.
- `createdBy`, `updatedBy`, `publishedBy`, timestamps.
- `settingsJson` only for validated versioned configuration; avoid arbitrary script execution.

A published model version is immutable. Editing a published model creates a new draft/version. Existing score history remains linked to the version that produced it.

### 5.2 LeadScoreRule

Fields:

- `id`, `modelId`, `modelVersion`.
- `name`, `description`, `enabled`.
- `dimension` and stable `reasonCode`.
- `condition` in a validated declarative rule DSL.
- `points` or normalized weight, clamped within configured bounds.
- `effect`: `add`, `subtract`, `setBand`, or another small explicitly supported effect list.
- `priority` and evaluation order where order matters.
- `eventType` and `lookbackWindow` for event-based rules, if supported.
- `decayPolicy` for time-based signals, if supported.
- `missingDataPolicy`: `ignore`, `neutral`, or explicit rule-defined behavior.
- audit/version fields.

Do not allow raw JavaScript, TypeScript, SQL, shell commands, arbitrary templates, or executable formulas from model configuration. If the system already has a secure formula DSL, audit its safety and allowed function set before considering reuse.

### 5.3 LeadScoreCurrent / score projection

One current projection per Lead and scoring model where multiple models are allowed, or one current projection for the active model if the product chooses that simpler policy.

Fields:

- `leadId`, `modelId`, `modelVersion`.
- `scoreValue`, `qualificationBand`, `evaluationStatus`.
- `calculatedAt`, `inputsAsOf`, `staleAfter` if applicable.
- `positiveReasonCodes`, `negativeReasonCodes`, compact `breakdown`.
- `coverage` / `knownSignalsCount` if meaningful.
- `sourceRevision` or equivalent input watermark.
- `lastErrorCode` safe for user/admin visibility, without raw sensitive payloads.
- timestamps.

Enforce uniqueness according to the chosen active model policy. Do not duplicate canonical Lead identity fields into this projection.

### 5.4 LeadScoreEvaluation / score history

Immutable evaluation record or a compatible reuse of the existing audit/history framework. It should preserve:

- Lead ID and model/version.
- Computed score and band.
- Evaluation time and triggering source (`lead_change`, `engagement_event`, `manual_recalculate`, `model_publish`, `batch_rebuild`).
- Input revision/watermark and freshness.
- Per-rule results and stable reason codes.
- Whether evaluation was partial, stale, skipped, or failed.
- Correlation/job ID.

Apply retention/partitioning only when volume demonstrates a need. Never erase conversion history or current projections as a side effect of recalculation.

### 5.5 LeadConversionOperation

Use the platform's existing idempotency/operation pattern if available. Otherwise add a narrowly scoped module-owned record for durable conversion tracking.

Suggested fields:

- `id` / unique `operationKey`.
- `sourceLeadId` and `sourceLeadRevision`.
- `requestedTargets`: Contact, Account, and optional Opportunity.
- `status`: `previewed`, `processing`, `succeeded`, `failed_retryable`, `failed_final`, `needs_review`.
- `requestedBy`, `requestedAt`, `confirmedAt`, `completedAt`.
- `previewHash` or equivalent revision fingerprint.
- `mappingVersion` and selected match IDs.
- `createdAccountId`, `linkedAccountId`, `createdContactId`, `linkedContactId`, optional Opportunity ID.
- structured `resultSummary` and safe failure code.
- `correlationId`, timestamps.

Protect the operation key with a uniqueness constraint scoped to the tenant/organization/user or whatever scope matches the existing system's idempotency model. Avoid storing unnecessary full Lead payload copies in audit rows.

### 5.6 Lead conversion references

Preferred behavior is to extend Lead's existing relationship/reference fields and conversion metadata where appropriate. Depending on the actual Entity Engine, the result may be represented via relationship links and/or explicit references such as:

- `convertedAt`.
- `convertedById`.
- `convertedAccountId` (optional).
- `convertedContactId` (optional).
- `convertedOpportunityId` (optional).
- `conversionOperationId`.
- source status `Converted`.

Use the repository's relationship naming and foreign key conventions. If the schema already supports a `Converted To` panel or polymorphic relation, extend it rather than adding parallel relationships.

### 5.7 Field mapping configuration

Field mapping may be static metadata or a versioned configuration record, depending on repository conventions. Requirements:

- Source entity must be Lead.
- Target entity must be one of the allowed canonical target types.
- Source and target field definitions must be validated.
- Type compatibility is checked (e.g., text-to-text, date-to-date, option mapping).
- Read/write ACL and sensitive-field policies are respected.
- Passwords, API secrets, consent proof artifacts, internal scoring diagnostics, and protected fields must never be copied by a generic rule.
- Mapping includes create defaults and a policy for existing target records; it must not overwrite non-empty target fields without an explicit preview and a documented merge policy.
- Mapping versions are auditable; changing a mapping must not retroactively mutate prior conversions.

---

## 6. Lead Scoring Model and Rule Engine

### 6.1 Scoring model lifecycle

Support these lifecycle actions:

- Create draft.
- Configure dimensions, rules, weights, decay, thresholds, and data source scopes.
- Validate rules and show errors/warnings.
- Preview a model against a small ACL-authorized sample of Leads without modifying current scores.
- Publish a new immutable version.
- Pause or archive a model.
- Recalculate all or filtered Leads under controlled background jobs.
- Roll back operationally by publishing a previous configuration as a new version, not by mutating historical versions.

Only authorized administrators/marketing operations/sales operations roles may edit or publish models. The exact roles must match the repository's role system.

### 6.2 Declarative conditions

Start with a bounded allowlist of conditions:

- string equality/contains/prefix/suffix where sensible.
- numeric/date comparisons.
- `is set` / `is not set`.
- membership in configured options.
- trusted relationship existence or relationship field matching.
- event count or recency within a bounded lookback interval, where an approved event source exists.
- grouped AND/OR conditions with maximum depth and number of predicates.

Do not permit arbitrary joins, arbitrary SQL fragments, dynamic table names, or unbounded relationship traversal. Validate field paths against metadata and model permissions at save and execution time.

### 6.3 Point aggregation and normalization

- Keep a clear scoring formula. Example: start from `baseScore`, apply matched rules, clamp between floor and ceiling, then derive the band using the published model thresholds.
- If using weighted dimensions, define whether weights apply before or after normalization and document the formula.
- Avoid double-counting the same underlying event through both event rules and aggregated fields.
- Make event de-duplication and lookback rules explicit.
- Use deterministic rounding and stable numeric semantics. Score values should be numeric, bounded and consistent across API/UI/export.
- Keep negative rules bounded; a single low-signal or missing field should not arbitrarily drive a Lead to zero unless the model expressly defines that outcome.
- Do not silently change scores when an admin edits a draft. Only publish/recalculate through an explicit lifecycle action.

### 6.4 Recency and score decay

Where decay is supported:

- Configure time windows per rule or dimension.
- Apply decay to the signal, not by mutating old history rows.
- Recompute on scheduled windows or on access only if bounded and well-defined.
- Treat late-arriving events idempotently and document whether they cause historical correction, a new current score, or both.
- Preserve the original evaluation history for audit.

### 6.5 Score reasons and explainability

For each evaluation, show:

- Current score and qualification band.
- The rules that contributed positive and negative points.
- Signal value/summary sufficient to explain the rule, while avoiding unnecessary PII.
- Time window and source of an engagement event where relevant.
- Rules skipped due to missing/unavailable data.
- Staleness and recalculation state.
- Model version and last recalculated time.

User-facing reason text should be localized using stable reason codes. Never expose secret rule internals or fields the current user is not permitted to read.

### 6.6 Threshold and lifecycle integration

- Threshold crossing may emit a score-change event and optionally trigger existing workflow/notification services.
- Threshold crossing must not silently convert the Lead or modify unrelated lifecycle fields.
- Any automatic field update must be explicitly configured, permission-checked, auditable, idempotent, and reversible where possible.
- By default, score is a prioritization signal and user remains responsible for qualification and conversion.

### 6.7 Optional AI-assisted fit

Only after deterministic scoring and evaluation are complete:

- Call `AIAgents` through an existing approved contract to produce an optional, evidence-grounded summary such as “strong fit because the Lead matches configured industry and company-size criteria.”
- AI must not invent facts, use prohibited sensitive data, assign unexplained score points, or override deterministic rules.
- Store model/provider identity, prompt/config version, timestamp, input provenance and confidence/uncertainty where available.
- Separate AI-generated summary from numeric rule score and label it as AI-generated.
- If AIAgents is absent or unavailable, scoring must continue normally.

---

## 7. Lead Conversion Requirements

### 7.1 Conversion UI entry point

Provide a `Convert` action on the Lead detail page and, if list action conventions support it, a single-record action in list context. Bulk conversion is a later controlled enhancement and must not be enabled by default.

The wizard should contain clear steps:

1. **Review Lead:** show source, current status, qualification score/band, key details, source/campaign attribution, and potential duplicate warnings.
2. **Choose target records:** choose create/link Account, create/link Contact, and optional Opportunity if supported. Offer only valid combinations for current business mode/configuration.
3. **Resolve duplicates:** display possible Contacts/Accounts with match reasons and enough permitted information to decide. User can select an existing record, continue creating a new record with an explicit duplicate override permission, or cancel for review.
4. **Review field mapping:** show prefilled values and target relationships; highlight required fields, skipped fields, conflicts, fields not writable, and values not being copied.
5. **Preview result:** show what will be created or linked and what the Lead's final status/references will be.
6. **Confirm:** require explicit confirmation and submit a stable idempotency key/operation ID.
7. **Result:** show links to the resulting records, and distinguish Created from Linked.

For users with no create permission but link permission, only link choices should be available. If the user cannot read a potential duplicate, do not leak that record's existence or details. The duplicate service should return only authorized candidates and may return a generic “possible match exists but is not visible” warning when policy permits.

### 7.2 Target selection scenarios

At minimum support:

- **Contact only:** create or link a Contact for an individual lead.
- **Account only:** create or link an Account for organization-level leads, when B2B mode and business rules allow it.
- **Account + Contact:** create/link the Account and create/link an associated Contact.
- **Contact + existing Account:** create/link a Contact and associate it with a selected existing Account.
- **Existing Contact + existing Account:** link both when relationships are consistent and explicitly confirmed.
- **Optional Opportunity:** when supported, create/link an Opportunity associated with the selected Account/Contact using existing sales services and required validation.

The plan's minimum requirement is Contact and/or Account conversion. Opportunity support is compatibility-driven: use it when the current CRM product design already supports it; otherwise document it as a later extension rather than blocking LeadScore MVP.

### 7.3 Duplicate matching policy

Implement staged detection:

1. Normalize email addresses (trim, canonical case handling) and compare exact normalized values.
2. Normalize phone numbers with the repository's existing phone-number policy; use country context and E.164 where supported.
3. Compare explicit external IDs or verified identifiers if already available.
4. Compare organization website/domain and company name as weaker Account candidate signals.
5. Use name/company fuzzy similarity only to suggest candidates, never as an automatic merge or silent link.

Requirements:

- Return match score/reasons to authorized users but do not expose sensitive hidden fields.
- Support `same person`, `same organization`, and `possible duplicate` distinctions.
- Treat shared addresses, generic inboxes (e.g. `info@`), household phones, and multiple people at one company carefully.
- Allow configurable exact-match rules and a minimum confidence for warnings, but require user choice for ambiguous cases.
- Record whether a target was created or linked and which duplicate rule produced the candidate.
- Enforce relevant unique indexes only if existing data and business rules allow them; do not add aggressive uniqueness constraints that break legitimate shared values.

### 7.4 Field mapping and data preservation

- Ship a sensible default map from standard Lead fields to Contact/Account fields, then allow administrators to configure validated mappings.
- Preserve original Lead values even if the target already contains a conflicting value.
- Do not overwrite non-empty fields on a linked Contact or Account by default.
- Where user chooses to apply a source value to an existing target, show before/after changes and record an audit diff.
- Handle multi-value fields and country/state/industry option mappings according to metadata definitions.
- Validate required fields on target records before confirmation.
- Respect field-level read/write permissions. Never allow the conversion API to write a field the actor cannot normally write through the target entity service.
- Preserve campaign/source attribution through existing relationships where possible. Do not flatten provenance into unstructured text if a proper relationship exists.
- Do not copy consent records or evidence as if the target Contact automatically consented; preserve consent/provenance according to MarketingAutomation's contract and policy.

### 7.5 Activities, notes, files, emails, and relationship history

- Keep the Lead and its history intact.
- Link related Activities/Notes/Emails to the appropriate target record only when the platform's relation model supports it and the user is authorized; retain Lead history/provenance.
- Do not duplicate files or sensitive messages indiscriminately. Reuse links when valid and preserve access control.
- Document exactly which related data is linked, copied, or left associated with the source Lead.
- Conversion must not send emails or external communications automatically unless the user explicitly triggers a separate, separately authorized action.

### 7.6 Lead status and post-conversion behavior

- On success, transition Lead to the existing `Converted` status/enum value or the repository's canonical equivalent.
- If the current system uses another status model, map it through metadata and document compatibility.
- Store links to all created/linked targets and display them in a `Converted To` panel or equivalent.
- Make the conversion action unavailable or return a stable conflict response if the Lead has already been converted, unless the request carries the same idempotency key and is retrieving the prior result.
- Reopening or correcting a conversion must be a separate explicit admin-controlled workflow; do not silently reverse conversion or delete target records.
- A post-conversion correction must account for targets that have since been edited, linked elsewhere, or used in transactions.

### 7.7 B2B/B2C behavior

- Inspect whether a global B2B/B2C mode or equivalent configuration exists.
- If B2C mode is active, follow the repository's existing policy for Account availability and conversion behavior. The EspoCRM reference baseline documents that Lead-to-Account conversion is not available in B2C mode.
- Do not invent global mode support if it is not part of the existing product; use a module setting only if justified and consistent with CRM conventions.
- The backend must validate mode-specific combinations even if the UI hides unavailable options.

### 7.8 Conversion concurrency and rollback/recovery

- Use a transaction for entity creation/linking, Lead status update, relationships, conversion result references, and the operation record wherever the persistence architecture allows.
- Re-check Lead status/revision and target record state inside the transaction.
- Use optimistic concurrency or row locking according to established repository conventions.
- Add a unique idempotency constraint. Replaying a completed operation returns the original result.
- If a transaction fails, do not leave the Lead marked Converted without valid target references.
- If a non-transactional downstream side effect fails after commit, keep the conversion succeeded and record/retry the side effect separately; do not recreate the entities.
- Provide an admin-visible recovery view for operations stuck in processing or failed_retryable state, with safe retry/resolve actions.

---

## 8. API Contract

Adapt names/envelopes to the repository's existing `/api/v1` patterns. These examples are logical contracts, not permission to create duplicate generic CRUD endpoints.

### 8.1 Score-model administration

- `GET /api/v1/lead-score/models`
- `POST /api/v1/lead-score/models`
- `GET /api/v1/lead-score/models/:modelId`
- `PATCH /api/v1/lead-score/models/:modelId`
- `POST /api/v1/lead-score/models/:modelId/validate`
- `POST /api/v1/lead-score/models/:modelId/preview`
- `POST /api/v1/lead-score/models/:modelId/publish`
- `POST /api/v1/lead-score/models/:modelId/archive`
- `POST /api/v1/lead-score/models/:modelId/recalculate`
- `GET /api/v1/lead-score/models/:modelId/jobs/:jobId`

### 8.2 Lead score read/recalculate

- `GET /api/v1/leads/:leadId/score` — return current score, band, model version, freshness and permitted breakdown.
- `GET /api/v1/leads/:leadId/score/history` — paginated score evaluations, subject to permissions and retention.
- `POST /api/v1/leads/:leadId/score/recalculate` — queue a manual recalculation; require permission and rate limiting.
- `POST /api/v1/leads/score/recalculate-batch` — admin-only, filters must use a validated query DSL, with preview/limits for large sets.

If route nesting violates repository conventions, use the existing entity-action API pattern while preserving these semantics.

### 8.3 Conversion preview and execution

- `POST /api/v1/leads/:leadId/conversion-preview`
  - Input: requested target types, selected existing target IDs where applicable, field mapping version, optional Opportunity request, and current Lead revision.
  - Output: proposed created/linked records, mapped field preview, duplicate candidates/reasons, validation warnings/errors, permissions, preview fingerprint, and required confirmation type.
  - Side effects: none; no record writes and no outbound messages.

- `POST /api/v1/leads/:leadId/convert`
  - Input: unique `operationKey`, confirmed preview fingerprint, selected target actions, mapping version, explicit field-merge choices, and request revision.
  - Output: operation status, created/linked target IDs, Lead status, audit summary, and stable operation ID.
  - Must be idempotent and re-validate ACL, Lead state, mapping, target state, and duplicate policy.

- `GET /api/v1/lead-score/conversion-operations/:operationId` — retrieve status and result; only authorized users may inspect it.
- `POST /api/v1/lead-score/conversion-operations/:operationId/retry` — permitted admin/recovery path only for retryable failures; must not duplicate successful target records.

### 8.4 API requirements

- Validate DTOs and enum values at runtime.
- Use stable error codes for invalid mapping, missing required fields, already converted, stale preview, duplicate review required, permission denied, operation conflict, and retryable server failure.
- Use existing request correlation IDs and audit conventions.
- Document APIs in OpenAPI and add examples that contain synthetic values only.
- Do not include hidden duplicate record details, internal rule code secrets, stack traces, SQL, credential data, or unnecessary PII in responses.

---

## 9. Permissions and Security

### 9.1 Permissions matrix

Use the actual role/ACL implementation and map these conceptual capabilities to existing permission primitives:

- View score badge/current score.
- View score explanation and history.
- Recalculate one Lead score.
- View score model configuration.
- Create/edit draft model.
- Preview model.
- Publish/archive model.
- Run batch recalculation.
- Preview Lead conversion.
- Create Contact.
- Create Account.
- Link existing Contact/Account.
- Override duplicate warning.
- Apply field changes to existing records.
- Convert Lead to Opportunity, if supported.
- View conversion operation/audit.
- Recover a failed conversion operation.

### 9.2 Server-side enforcement

- Score calculation must not read fields or related records the executing principal/system context is not allowed to use under the model's defined policy.
- Define whether scheduled scoring runs as a restricted service principal or the Lead owner/user context; this must be explicit and auditable.
- The UI is never the security boundary.
- Conversion preview and execution must separately enforce source Lead read/convert permissions and target entity create/read/write permissions.
- A user who can create a Contact but cannot view a duplicate Contact must not receive hidden candidate details.
- Field mappings cannot elevate permissions or expose restricted field values.
- Do not permit users to use score API filters as a covert data-export path around Lead/Contact ACL.

### 9.3 Sensitive data and scoring governance

- Do not score based on protected/sensitive categories or infer them from unstructured text.
- Allow admins to review which fields and events feed each model.
- Maintain a published model change log and version history.
- Make it possible to disable a rule/model quickly without destroying historic evaluations.
- If AI-assisted analysis exists, store only the minimum input context approved by the existing AI gateway policy and redact unnecessary personal data.
- Never expose raw prompt/provider payloads in general application logs.

### 9.4 Abuse and rate control

- Bound rule complexity, batch sizes, history page size, duplicate candidate limits, conversion retries, and manual re-score requests.
- Protect score recalculation endpoints from being invoked in tight loops.
- Use per-request timeouts and bounded query plans.
- Avoid full-model recalculation during user-facing Lead list requests.

---

## 10. Events, Jobs, and Automation

### 10.1 Candidate event sources

Only subscribe to events that truly exist in the repository. Likely sources include:

- Lead created/updated.
- Relevant Lead field changed.
- Approved MarketingAutomation engagement event received.
- Call/meeting/task completed or logged, if event semantics are stable.
- Model published/archived.
- Manual recalculation requested.
- Lead converted.

### 10.2 Jobs

Implement using the existing job/queue service:

- Recalculate score for one Lead after debounce/coalescing.
- Recalculate a bounded batch after model publication.
- Refresh decay-sensitive scores based on relevant schedule.
- Retry failed evaluations with bounded exponential backoff.
- Detect stale/pending evaluations and recover stuck jobs.
- Process conversion-operation recovery only if the operation state machine is implemented.

All jobs must be idempotent, observable, permission-aware, bounded, and safe under duplicate delivery.

### 10.3 Events

Publish stable, versioned domain events only if the repository's event bus/outbox supports them, for example:

- `leadScore.updated.v1`
- `leadScore.bandChanged.v1`
- `leadScore.modelPublished.v1`
- `lead.conversionSucceeded.v1`
- `lead.conversionFailed.v1`

Event payloads should include IDs, version, score/band where necessary, timestamps and correlation identifiers, not full record payloads. Do not emit secrets or broad PII.

### 10.4 Workflow behavior

- Allow existing Workflow/BPM to react to a band change if this is supported.
- Keep threshold actions opt-in and documented.
- Prevent loops where a score update changes a Lead field that retriggers the same score rule endlessly.
- Never auto-convert on score threshold by default.
- A configured workflow may create a task or notify an owner after a threshold crossing, using existing platform actions and idempotency keys.

---

## 11. User Interface and Experience

### 11.1 Lead detail view

Add a Score panel that displays:

- Current score and scale.
- Qualification band with non-color-only label.
- Trend indicator and recent history.
- Model name/version and calculation timestamp.
- Positive and negative reason cards.
- Staleness/recalculation status.
- Recalculate action for authorized users.
- Link to scoring history/model explanation where permitted.
- A clear separation between deterministic score and optional AI-generated insight.

### 11.2 Lead list view

When supported by the current metadata-driven layout system, expose:

- Score column and qualification band.
- Sort/filter by score range, band, score freshness, and score updated time.
- Saved filters such as Hot Leads, Sales Ready, Stale Scores, and Needs Qualification only when those filters can be expressed by approved query criteria.
- Do not fetch a full score history for every row; use the current score projection/read model.

### 11.3 Score model administration

Provide a metadata-consistent admin UI:

- Model list, status, version, active Lead count and last calculation status.
- Rule editor with supported conditions/operators only.
- Rule weight/dimension/band settings.
- Validate and preview results before publish.
- Show changes between the current published version and the draft.
- Publish/archive confirmation with impact summary.
- Batch recalculation status, progress, failures and retry options.

Do not build a full generic workflow builder inside LeadScore.

### 11.4 Conversion wizard

The conversion UI should:

- Present the current Lead values and relationships.
- Show candidate duplicates and match reasons without exposing unauthorized records.
- Let the user choose which targets to create or link.
- Let the user select or create an Account before creating a Contact associated with it.
- Preview field mapping and highlight target-required fields.
- Distinguish **Create new** from **Link existing** choices.
- Show any field that will not be copied and explain why.
- Require explicit confirmation before writing.
- Display the post-conversion Lead status and target links.
- Recover gracefully from timeout by looking up the operation key, not reissuing a new conversion automatically.

### 11.5 Accessibility and localization

- Follow existing design system, responsive behavior, keyboard navigation, and accessible form validation.
- Labels for score bands must include text in addition to color.
- Provide translations using the repository's existing conventions.
- Ensure number/score/date formatting respects locale without changing canonical API values.

---

## 12. Reporting and Analytics

Provide data/metrics through the existing reporting framework where available:

- Lead count by score band and owner/team.
- Lead score distribution and average/median by segment, with minimum sample controls if required for privacy.
- Time from creation to first score, first qualification, and conversion.
- Conversion rates by score band and model version.
- Score movement over time and rule contribution analysis.
- Stale score percentage and failed evaluation counts.
- Conversion outcomes: created vs linked Contacts/Accounts, duplicate warning frequency, operation failures, and average conversion duration.
- Model quality evaluation using historically labeled outcomes if the repository and data quality support it.

Analytics requirements:

- Clearly define denominators, time windows, and treatment of unconverted/disqualified Leads.
- Do not claim a scoring model caused a conversion merely because high-scoring Leads convert more often; report association and cohort context.
- Avoid exposing records beyond the current user's permissions.
- Ensure data exports apply the same ACL and field restrictions as interactive views.
- Do not build a duplicate reporting engine; expose suitable metrics to existing Reports/Dashboard capabilities.

---

## 13. Testing Strategy

### 13.1 Unit tests

Scoring:

- Condition evaluation for each supported field type/operator.
- Positive, negative, capped, weighted and normalized scores.
- Missing-data behavior.
- Time windows and decay.
- Threshold boundaries and overlapping-band rejection.
- Stable result for the same input/model version.
- Version publication and immutability.
- Explainability/reason code generation.
- Rejection of unsupported fields, sensitive fields, invalid operators, too-deep nested conditions, and unbounded rules.

Conversion:

- Each valid target combination.
- Field mapping/type validation and missing required fields.
- Exact email/phone/external ID matches and fuzzy suggestion-only behavior.
- Existing target link versus new target creation.
- No-overwrite default for non-empty target fields.
- Contact-to-Account relationship validation.
- B2B/B2C configuration behavior.
- Already-converted Lead behavior.
- Idempotency with repeated operation key.
- Concurrent conversion attempts.
- Transaction rollback/failure recovery.
- No unauthorized duplicate details in responses.

### 13.2 API and integration tests

- Lead ACL and field-level ACL remain active for score reads and recalculation.
- Model permissions are checked on every administration endpoint.
- Lead conversion uses canonical entity services and triggers normal validations/audit.
- Related records created during conversion use the intended default values, ownership, teams and relationships.
- MarketingAutomation/AIAgents absent or disabled does not break baseline score or conversion.
- Domain events/jobs are idempotent under duplicate delivery.
- List filtering and sorting use the current projection without N+1 history queries.

### 13.3 Database test policy

- Follow `AGENTS.MD` exactly.
- Do not create test databases, temporary databases, test schemas, Docker database containers, shadow databases, or per-agent/per-run databases.
- Inspect test scripts for destructive setup before running them.
- Use targeted `AGENT_TEST_...` Lead/Contact/Account records against the configured primary database only where appropriate.
- Prefer transactions/rollback when valid, but account for jobs and events that may escape transaction boundaries.
- Use exact IDs and run markers for cleanup; never delete real CRM records.
- Do not use real customer data for scoring-model preview or conversion test fixtures.

### 13.4 Test acceptance examples

1. A Lead with fields matching two published rules receives the expected score and two visible reason codes.
2. A model draft does not alter current scores before publication/recalculation.
3. Publishing model v2 leaves v1 evaluation history unchanged.
4. A missing signal follows the configured missing-data policy and is not silently treated as zero.
5. A Lead with an exact Contact email match shows the existing Contact as a candidate and does not automatically create another one.
6. Conversion to a new Account + Contact creates one Account and one Contact with a consistent relationship, updates the Lead to Converted, and returns links.
7. Contact-only conversion succeeds where allowed and never creates an unintended Account.
8. Account-only conversion is rejected when the current B2C configuration prohibits it.
9. Repeating the same conversion operation key returns the original result and creates no duplicate records.
10. Two concurrent attempts cannot convert the same Lead twice.
11. A failure during the transaction leaves the Lead unconverted or records a recoverable operation state; it never silently creates an orphaned/duplicated target.
12. A user without Account/Contact create permission cannot use conversion to bypass those permissions.
13. An unauthorized user cannot enumerate hidden potential duplicates.
14. Automated tests do not call external systems or send messages.

---

## 14. Observability, Performance, and Operations

### 14.1 Observability

Track through existing structured logging/metrics/tracing where available:

- Scores evaluated, skipped, stale, and failed.
- Evaluation duration and rule count.
- Batch progress and queue age.
- Model version and evaluation correlation ID.
- Conversion previews, confirmed operations, created/linked target counts, failures and retries.
- Duplicate candidate counts and user decisions.
- Idempotency hits and concurrent-conflict counts.

Logs must not include unnecessary field values, full Lead/Contact payloads, credentials, or unrestricted reason snapshots.

### 14.2 Performance

- Keep score calculation off ordinary list reads.
- Index current score lookups by Lead and model as appropriate.
- Page score history and conversion operations.
- Bound candidate search result sets and use normalized indexed identifiers where data rules permit.
- Avoid unbounded fuzzy matching and full-table scans in conversion preview.
- Use chunked jobs with checkpoints for recalculation at scale.
- Use query plans validated against allowed metadata fields and existing indexes.
- Set explicit timeouts and resource limits for model preview and bulk recalculation.

### 14.3 Recovery and administration

Provide safe operational procedures for:

- Pausing a scoring model.
- Re-running a failed batch.
- Marking stale scores for recalculation.
- Identifying unsupported/invalid rules.
- Inspecting a conversion operation that is stuck or failed.
- Retrying a conversion operation only after verifying that previously created target records are accounted for.
- Disabling a problematic event integration without disabling normal Lead CRUD.

---

## 15. Migration and Rollout Strategy

### 15.1 Additive migration rules

- Audit the current Lead schema, status options, conversion relationships, and any score fields before adding migrations.
- Prefer additive score fields, score history/model tables, and conversion operation metadata.
- If the current Lead entity already has conversion fields or a conversion operation, extend and migrate the canonical structure; do not introduce a second parallel set of fields.
- Do not rename/drop existing Lead fields or repurpose an existing field with a different meaning.
- Migrations must be reviewed, version-controlled, idempotent according to repository convention, and safe to apply against existing data.
- Do not automatically calculate scores for every historical Lead during schema migration. Use a separately controlled background recalculation after the model is configured and published.

### 15.2 Feature flags and rollout

Recommended staged rollout:

1. Deploy schema/metadata with scoring disabled and conversion behavior unchanged.
2. Enable score model administration for a small admin group.
3. Preview scoring on a limited authorized sample; compare outputs with expected rules.
4. Publish the first deterministic model and run a bounded recalculation.
5. Expose score fields/panel to selected users.
6. Enable conversion preview and duplicate detection for pilot users.
7. Enable conversion execution after audit, retry, and concurrency tests pass.
8. Enable optional integrations and threshold notifications individually.
9. Enable optional AI-assisted explanations only after governance and provider policy are reviewed.

A rollback should disable score evaluation or hide new UI surfaces without deleting historical score data or conversion records. Conversion rollback is not a database reset; correcting a completed conversion requires an explicit supported business procedure.

---

## 16. Delivery Roadmap / Sub-Phases

Implement in the following order. Each phase must be reviewed and accepted before proceeding to the next. Do not generate the whole module in one coding pass.

### Phase 19-LS.0 — Repository Audit and Feature Contract

- Inspect Lead, Contact, Account, Opportunity, status configuration, entity relationships, field metadata, duplicate detection, ACL, audit, Activities, Campaign/Target Lists, MarketingAutomation, Jobs, Workflow/BPM, Reports, AIAgents, and conversion-related frontend components.
- Inspect migrations, scripts and tests for destructive setup and test database creation.
- Build a capability matrix: `Reuse / Extend / Build / Optional dependency / Defer`.
- Determine whether a canonical Lead conversion service already exists and whether target links are represented through fields or relationships.
- Identify supported B2B/B2C behavior and Opportunity conversion behavior.
- Write `docs/compatibility/lead-score.md` with baseline behavior, product decisions, data mappings, and unresolved items.
- **Exit criteria:** approved feature contract and no duplicate entities/services proposed.

### Phase 19-LS.1 — Domain Boundaries, Naming, and Module Registration

- Register `LeadScoreModule` using repository conventions.
- Add `lead-score` navigation/settings surfaces only if appropriate.
- Declare dependencies explicitly and optionally.
- Register ACL capabilities, metadata contributions, events, jobs, and API routes through existing module systems.
- Ensure module disablement does not break Lead CRUD or conversion behavior owned by existing core services.
- **Exit criteria:** module loads, is discoverable, and does not conflict with existing Lead behavior.

### Phase 19-LS.2 — Schema and Metadata Foundation

- Add reviewed, additive migrations only for missing model/rule/current-score/history/operation structures.
- Add metadata for score fields, relationships and layouts through the Entity Engine.
- Add indexes and constraints for active model/current score, history lookup, idempotency keys, and conversion operation status.
- Verify migrations preserve existing records and history.
- **Exit criteria:** schema and metadata validate against the current project conventions.

### Phase 19-LS.3 — Model and Rule Configuration

- Implement draft/published/archived lifecycle.
- Implement bounded condition DSL, weights, bands, missing-data policy and versioning.
- Validate all rule field references against metadata, type and authorization constraints.
- Reject arbitrary executable scripts and unsafe fields.
- **Exit criteria:** invalid models cannot be published and published versions are immutable.

### Phase 19-LS.4 — Deterministic Scoring Engine

- Implement score calculation, clamping, normalization, threshold resolution, rule results, reason codes and score snapshots.
- Add deterministic unit tests for supported conditions and edge cases.
- Separate current projection from historical evaluations.
- **Exit criteria:** same model/input snapshot produces the same auditable result.

### Phase 19-LS.5 — Scoring History, Explanation, and Freshness

- Persist historical evaluations and reason details.
- Provide current-score and history query APIs with pagination and ACL.
- Implement stale/pending/failed state and stable user-readable reasons.
- **Exit criteria:** users can explain score and know whether it is current.

### Phase 19-LS.6 — Event-Driven and Manual Recalculation

- Subscribe to audited Lead changes and approved domain events.
- Add debounced, idempotent jobs and bounded batch recalculation.
- Add progress/error state and retry controls.
- **Exit criteria:** repeat events do not create duplicate history or unbounded jobs; list reads remain performant.

### Phase 19-LS.7 — Lead Detail/List UI

- Add score panel, score band, history and explanation to Lead detail.
- Add score columns and filters using current projections and existing list conventions.
- Add authorized manual recalculate action.
- **Exit criteria:** UI uses API data and never bypasses field/record ACL.

### Phase 19-LS.8 — Scoring Model Administration UI

- Implement model list, rule editor, test/preview, validation, version comparison, publish/archive and batch job status.
- Add safe sample selection and prevent previews from mutating production scores.
- **Exit criteria:** admin can manage a deterministic model without editing raw JSON manually or running code.

### Phase 19-LS.9 — Qualification Workflow and Signals

- Add score-band change events and optional rules/notifications through existing Workflow/BPM/Jobs.
- Integrate only available trusted signals from MarketingAutomation/VoiceCommunications/Activities where contracts exist.
- Add loop prevention, event deduplication, explicit lookback periods and source provenance.
- **Exit criteria:** optional signal source failure does not break scoring and threshold actions are auditable.

### Phase 19-LS.10 — Conversion Domain Audit and State Contract

- Define valid conversions, state transitions, B2B/B2C constraints, required target fields, target linking policy and allowed corrections.
- Identify canonical creation/linking services for Contact, Account and optionally Opportunity.
- Design operation status/idempotency strategy and transactional boundaries.
- **Exit criteria:** conversion state machine, mapping policy and failure recovery are documented before writing conversion behavior.

### Phase 19-LS.11 — Duplicate Detection and Candidate Review

- Implement normalized exact matches for email, phone and verified identifiers as applicable.
- Add bounded Account company/domain candidate search and fuzzy suggestions where helpful.
- Apply ACL before returning candidates and never reveal hidden duplicate information.
- Add explicit user decision between link, create with override permission, or cancel.
- **Exit criteria:** ambiguous matches cannot result in silent auto-linking or auto-merge.

### Phase 19-LS.12 — Field Mapping and Conversion Preview

- Implement default and configurable Lead-to-Contact/Account mappings.
- Preview target data, relationship choices, required field errors, skipped fields and potential overwrites.
- Add preview fingerprint/revision so stale previews must be refreshed.
- **Exit criteria:** preview is side-effect-free and faithfully describes the operation that would run.

### Phase 19-LS.13 — Conversion Operation and Transactional Execution

- Implement confirmed convert command with operation ID/idempotency key.
- Create/link selected entities through canonical services; persist references and Lead status in the same transaction where possible.
- Handle concurrent requests, already converted Leads and failed writes.
- **Exit criteria:** retrying the same operation cannot create duplicate targets and failed atomic operations do not leave inconsistent state.

### Phase 19-LS.14 — Conversion Wizard UI and Converted-To Panel

- Implement target selection, duplicate review, mapping preview, confirmation, progress/result display and target links.
- Show Created versus Linked outcomes.
- Support timeout/reload recovery via operation lookup.
- **Exit criteria:** user can complete valid Contact/Account conversion end-to-end with clear feedback.

### Phase 19-LS.15 — History, Activities, and Attribution Preservation

- Verify original Lead, notes, activities, emails, files and campaign attribution remain accessible.
- Link history to new targets only through explicit supported relationships.
- Preserve marketing consent provenance instead of copying it as automatic consent.
- **Exit criteria:** conversion does not lose source context or broaden access to related data.

### Phase 19-LS.16 — Optional Opportunity Conversion

- Implement only if Opportunity and its canonical domain service exist and current CRM conversion behavior supports it.
- Let user create/link Opportunity and validate required fields/relationships.
- Ensure Sales module owns opportunity-specific validation and stage semantics.
- If not supported, document deferment; do not block Contact/Account conversion.
- **Exit criteria:** no duplicate Opportunity logic is introduced.

### Phase 19-LS.17 — Optional AI-Assisted Insight

- If AIAgents exists, request evidence-grounded fit explanations only through its approved tool/provider contract.
- Keep AI output separate from deterministic score and allow disablement.
- Evaluate hallucination, prohibited input use, latency and cost limits.
- **Exit criteria:** core scoring works with AI disabled; AI text cannot change scores without explicit deterministic rules.

### Phase 19-LS.18 — Reporting, Security, Performance, and Release

- Publish suitable score/conversion metrics to existing reporting/dashboards.
- Run the complete test plan, ACL review, concurrency tests, query checks, migration review and accessibility checks.
- Verify no new database/test schema was introduced and no unsafe scripts were added.
- Document rollout, recovery, monitoring, feature toggles and limitations.
- **Exit criteria:** every requirement is mapped to an implementation and verification result; no unresolved critical security or data-integrity defect remains.

---

## 17. Definition of Done

The module is not complete until all applicable criteria are met:

### Scoring

- [ ] Module registered with canonical name `LeadScore`; no `Ua` prefix exists in new module identifiers.
- [ ] Rule-based model lifecycle works and published versions are immutable.
- [ ] Rules are declarative, bounded, validated against metadata, and non-executable.
- [ ] Score, qualification band, input freshness, model version and human-readable reasons are available.
- [ ] Score history is immutable and queryable with ACL.
- [ ] Event and manual recalculation are idempotent and bounded.
- [ ] Lead list/detail views display score without N+1 query behavior.
- [ ] Score threshold actions cannot silently convert or disqualify a Lead.
- [ ] Sensitive/protected attributes are excluded from scoring inputs.
- [ ] Optional AIAgents integration is clearly separated and can be disabled.

### Lead conversion

- [ ] Conversion supports Contact-only, Account-only where valid, and Account + Contact flows.
- [ ] Existing Contact/Account linking is supported where permitted.
- [ ] Optional Opportunity conversion is implemented only through the existing canonical service or explicitly deferred.
- [ ] Duplicate detection is visible, ACL-aware and never performs silent fuzzy merges.
- [ ] Field mapping is validated and previewed; non-empty target fields are not overwritten by default.
- [ ] Successful conversion preserves the original Lead and moves it to Converted status/equivalent.
- [ ] Source Lead references each created/linked target and shows a Converted-To panel.
- [ ] Conversion actor, time, target choices, mapping version, and operation ID are auditable.
- [ ] Conversion is transactional or uses a documented durable recovery state machine.
- [ ] Repeated request, timeout retry, and concurrent requests cannot create duplicate target records.
- [ ] Unauthorized users cannot create/link targets or discover hidden duplicates through conversion.
- [ ] Conversion does not send external messages or copy consent without explicit valid policy.

### Platform quality and operations

- [ ] Existing Entity Engine, API, ACL, audit, Jobs, and UI conventions are reused.
- [ ] APIs and errors are documented in OpenAPI.
- [ ] Unit, integration, authorization, concurrency and end-to-end tests pass where runnable.
- [ ] Database test policy in `AGENTS.MD` is followed; no test database or schema was created.
- [ ] Migrations are additive and reviewed; no destructive migration was applied without explicit approval.
- [ ] Automated tests do not use real customer records or trigger real external side effects.
- [ ] Monitoring and recovery instructions exist.
- [ ] `docs/compatibility/lead-score.md` records actual behavior, deviations, and deferred items.
- [ ] Final report lists the code changes, test commands actually run, outcomes, and limitations.

---

## 18. Suggested Implementation Checklist for the Coding Agent

Before each sub-phase:

1. Read the relevant part of `AGENTS.MD` and this plan.
2. Inspect the actual Lead/Contact/Account/Opportunity contracts and nearby implementations.
3. State a small, phase-scoped implementation plan.
4. Implement only the current sub-phase and its prerequisites.
5. Review all SQL/migrations and verify authorization in server-side services.
6. Run relevant unit tests and safe targeted tests against the existing configured database only when needed.
7. Inspect the diff for accidental schema deletion, duplicate entities, secrets, unsafe field copying, duplicate conversion paths, and unrelated edits.
8. Record evidence for each acceptance criterion before moving to the next sub-phase.

Do not continue automatically through every phase after finishing a phase. Stop, report verification and blockers, and wait for the next implementation task as required by the project's working style.

---

## 19. Key Design Decisions to Record During Phase 19-LS.0

The audit must produce explicit decisions for:

- Existing canonical Lead status and whether `Converted` already exists.
- Existing conversion API/service/relationships, if any.
- Whether Accounts are enabled in the current business mode and whether B2C behavior applies.
- Whether Opportunities exist and whether Lead conversion currently supports them.
- Which Contact/Account fields are required and which mappings are safe by default.
- Exact versus fuzzy duplicate policies and any unique constraints already present.
- Whether a scoring/rules engine already exists and whether it is safe to reuse.
- Whether score history/audit/job/outbox infrastructure exists.
- Which MarketingAutomation events/metrics may legally and technically be consumed.
- Which activities, notes, files, emails and attribution relationships should remain linked to Lead versus also be linked to targets.
- How to handle previously converted Leads, partially failed conversions, and authorized corrections.
- Feature-flag and rollout strategy.

If any decision materially conflicts with the repository's current implementation or product requirements, document the discrepancy in the feature contract before proceeding. Do not silently invent a new behavior.
