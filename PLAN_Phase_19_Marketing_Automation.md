# Phase 19 — Marketing Automation Module (`MarketingAutomation`)

> **Status:** Complete — Phases 19-MA.0 through 19-MA.19 are implemented and verified; quality gates
> (typecheck, lint, marketing test suite) pass. **Completion report with the evidence:**
> `docs/implementation/marketing-automation-completion-report.md` (13 suites / 225 tests, migrations 037–043,
> the defects found while closing the phase, settings inventory and known limitations).
> A final hardening round (19-MA.19) fixed eight defects that only the missing tests could reveal — a webhook
> event insert that could never succeed (partial-index `ON CONFLICT`), a journey runtime writing a
> non-existent `updated_at` column, a claim that did not exclude a concurrent worker, a hard-coded webhook
> secret fallback, suppression feedback that ran without an identity, an unauthenticated journey trigger, an
> open redirect in `public/click`, and a public form that disclosed CRM record existence. See the report §3.
> MA.5 was built before MA.4 because its eligibility gate is
> what makes the MA.4 preview categories meaningful.
> Delivered records: `Campaign`, `TargetList`, `TargetListEntry`, `CampaignTransition`, `MarketingConsent`,
> `MarketingConsentEvent`, `MarketingSuppression`, `MarketingPublicToken`, `MarketingAudienceSnapshot`
> (+ `marketing_audience_snapshot_entries`), `MarketingTemplateRevision`, `MarketingSend`,
> `MarketingSendTransition` (+ `marketing_recipient_deliveries`, migration 041).
> MA.7 binds no new record: the live adapter wraps the platform's `MailTransport` (`MAIL_TRANSPORT`), the
> deployment names it with the `marketingAutomation.provider.key` setting (empty by default, so nothing is
> sent), credentials stay in `SMTP_*`/`email_accounts`, and the only sending command is the
> allowlist-gated `POST /api/v1/MarketingAutomation/action/campaign/{id}/sendTest`. `start`/`resume` still
> report `PROVIDER_NOT_BOUND` until a deployment configures a live adapter; the queued campaign delivery
> pipeline is MA.9.
> MA.8 binds the decision a send rests on: `MarketingSend` pins one message within a campaign to a sealed
> content revision, a send-bound final audience snapshot, a validation hash and a named approval, and
> `marketing_recipient_deliveries` holds one row per resolved recipient per intended send slot with the
> reason each one was eligible, blocked or skipped. Nothing in MA.8 puts a message on the wire — the
> transitions are `schedule`/`queue`/`pause`/`resume`/`cancel` only, and MA.9 owns the worker that claims the
> `Eligible` rows (§15 `19-MA.8` acceptance: "without sending real mail during tests").
> Audit: `docs/implementation/marketing-automation-audit.md`; compatibility:
> `docs/compatibility/marketing-automation.md`; lifecycle and audience:
> `docs/marketing-automation/campaign-lifecycle.md`; consent, suppression and public links:
> `docs/marketing-automation/consent-and-suppression.md`; placeholders, render safety and revisions:
> `docs/marketing-automation/email-templates.md`; adapters, limits, error classes and test send:
> `docs/marketing-automation/provider-adapters.md`; send definition, dry run and approval:
> `docs/marketing-automation/send-definitions.md`; journey graph, versions, enrollment and recovery:
> `docs/marketing-automation/journey-runtime.md`; metric definitions, event semantics and attribution:
> `docs/marketing-automation/metrics.md`; public surface, tokens, retention and privacy limits:
> `docs/marketing-automation/security-and-privacy.md`; cross-module contracts:
> `docs/marketing-automation/integration.md`; operations:
> `docs/runbooks/marketing-send-operations.md`; incidents:
> `docs/runbooks/marketing-provider-incidents.md`.
> **Parent roadmap:** `PLAN.md` — CRM advanced domains / Marketing Automation  
> **Module name:** `MarketingAutomation` (**do not add a `Ua` prefix**)  
> **Module key / slug:** `marketing-automation` (follow repository conventions if they differ)  
> **Suggested backend class:** `MarketingAutomationModule`  
> **Target runtime:** NestJS + TypeScript, existing React SPA  
> **Persistence:** Existing PostgreSQL + Kysely (or the repository's explicitly adopted SQL abstraction)  
> **Primary references:** EspoCRM Campaigns, Target Lists, Mass Email, Email Templates, Workflow/BPM and public developer documentation  
> **Implementation principle:** Audit the codebase first. Reuse the CRM kernel and existing Portal, Sales, CustomerSuccess and ServiceDesk modules. Do not copy upstream PHP source or rebuild shared platform capabilities inside this module.

---

## 0. Instructions for the Coding Agent

Read `AGENTS.MD`, the relevant sections of `PLAN.md`, and this entire plan before implementing this module.

### 0.1 Non-negotiable rules

1. The module is named **`MarketingAutomation`**. Do not name it `UaMarketingAutomation`, `UaMarketing`, or any other `Ua*` variant.
2. Use the repository's existing module registration, package layout, migration tooling, Entity Engine, metadata, ACL, API conventions, jobs, event bus, notification, email, file, reporting and UI patterns. Do not assume a planned abstraction exists until the audit confirms it.
3. This is a clean-room implementation. Use public documentation to define behavioral requirements; do not copy or mechanically translate EspoCRM source code, translations, UI assets, icons, branding or other copyrighted assets.
4. **Do not create a new database, database container, schema, shadow database, per-agent database or per-test database.** Follow `AGENTS.MD` and use the already-configured primary project database for permitted targeted integration/API testing.
5. Never reset, truncate, recreate or broadly delete data in the configured database. Use uniquely identifiable `AGENT_TEST_` records, precise ownership markers and narrow cleanup. Do not use real customer records for tests.
6. Tests must not send real marketing emails, SMS, webhooks, push notifications or other externally visible messages. Use a fake provider, provider sandbox or a controlled test adapter; do not point a test at a live provider by default.
7. Never expose `DATABASE_URL`, API keys, SMTP credentials, provider secrets, signed unsubscribe tokens, personal data or raw webhook secrets in logs, test output or documentation.
8. Consent and suppression checks are mandatory server-side gates. No UI toggle, workflow, journey action, retry, manual bulk send or API command may bypass them.
9. A published journey must run against an immutable version. Editing a draft must not silently mutate the behavior of already-enrolled contacts.
10. Every sending, retry, event-ingestion and journey-execution path must be idempotent or use a persistent deduplication key. Retries must not cause duplicate messages or actions.
11. Use additive, reviewed migrations. Do not drop or repurpose existing Campaign, Target List, Email, Contact, Lead, Account or consent-related data structures without a migration plan and explicit approval.
12. Implement features phase by phase. Do not generate the whole module in one pass. Complete the audit and feature contract first; record findings and stop before scope-expanding changes.
13. Do not claim completion unless relevant checks were actually executed. State which checks ran and any limitations.

### 0.2 Naming conventions

- Backend module/class: `MarketingAutomationModule`.
- Module directory and web route slug: `marketing-automation`.
- Entity names should follow existing entity naming conventions, for example `MarketingCampaign`, `MarketingSegment`, `MarketingJourney`, `MarketingJourneyEnrollment`, `MarketingMessage`, `MarketingConsent`, and `MarketingEvent` if the repository does not already have equivalent canonical entities.
- Do not introduce generic replacement tables when a suitable platform entity already exists. For example, reuse existing `Campaign`, `TargetList`, `EmailTemplate`, `Contact`, `Lead`, `Account`, `Opportunity`, `Email`, `Activity` or equivalent records where their contracts are suitable.
- Avoid a second email templating system, scheduler, queue, workflow engine, consent database, analytics framework or provider configuration system when a shared capability already exists.

---

## 1. Purpose and Product Outcome

Build a production-minded **Marketing Automation** domain module for the NestJS CRM. It should allow marketing teams to define audiences, design and schedule campaigns, create automated nurture journeys, send personalized messages, collect engagement events, honor communication preferences, and measure influence on CRM outcomes.

Marketing Automation must connect business-facing orchestration with the platform's existing communication infrastructure. It must not become a second CRM, a second email server, or a replacement for generic workflow/BPM.

### 1.1 Primary outcomes

Authorized users must be able to:

1. Create marketing campaigns and organize campaign activity, audience, schedule, content, status and results.
2. Build reusable audiences/segments from CRM records with both manually managed membership and validated dynamic criteria, if the relevant query facilities already exist.
3. Exclude duplicates, invalid recipients, hard-bounced addresses, globally suppressed addresses and recipients without valid consent for the intended channel/purpose.
4. Manage marketing consent, subscription preferences, opt-in evidence, opt-out requests, suppression, and consent history.
5. Create and preview responsive, accessible email content with controlled personalization and safe link tracking.
6. Build automated journeys using supported triggers, conditions, wait steps, branches, goal conditions and actions.
7. Enroll contacts consistently, control re-entry and exit behavior, and inspect the journey execution timeline and failure reasons.
8. Schedule large sends using background jobs, batching, throttling, provider limits, retries and dead-letter handling.
9. Process delivery, bounce, complaint, unsubscribe, open and click events when supplied by the chosen sending provider, with a documented caveat that open tracking is not fully reliable.
10. Build basic lead-capture forms or integrate with the existing lead capture/form capability if one exists; associate submissions with their source campaign.
11. View campaign and journey analytics, attribution evidence, funnel metrics and CRM outcomes without treating correlation as proof of causation.
12. Connect to existing `Portal`, `Sales`, `CustomerSuccess`, `ServiceDesk`, CRM entities, Activities, Notifications and generic automation through optional, documented contracts.
13. Use secure REST APIs and a metadata-driven React UI consistent with the rest of the CRM.

### 1.2 Product principles

- **Consent before convenience:** a send is blocked unless the recipient is eligible under the applicable communication purpose, channel and policy.
- **Suppression wins:** global unsubscribe, address-level suppression, complaint, invalid address and hard bounce take priority over list membership or automation instructions.
- **Immutable execution history:** preserve what version, message content revision, audience snapshot and rules were used for a real send.
- **No duplicate side effects:** idempotent job processing and event ingestion are required, not optional optimizations.
- **Explainable automation:** every enrollment, branch choice, delay, skipped send, exit and failure needs a traceable reason.
- **Safe by default:** draft campaigns do not send; test sending is explicit; production sending requires a preview and confirmation step appropriate to permissions.
- **Small first release:** build reliable email-oriented automation first. Do not attempt a full omnichannel customer data platform in the initial delivery.
- **Reuse over duplication:** existing CRM records remain authoritative. Marketing-specific data should reference them instead of copying contact/account/opportunity identity fields into parallel records.
- **Privacy-aware measurement:** explain tracking limitations, respect applicable privacy preferences, avoid collecting unnecessary identifiers, and allow disabling individual tracking modes.
- **Provider-independent domain model:** journeys and campaigns should not depend directly on one vendor's API.

### 1.3 Clean-room and compatibility boundary

EspoCRM documentation describes Campaigns, Target Lists, Mass Email and related campaign logging/statistics. The advanced visual journey engine, richer event-triggered orchestration, execution model and integrations defined here are the target project's own Marketing Automation features unless a specific documented compatibility requirement is added later.

Maintain a compatibility note at `docs/compatibility/marketing-automation.md`. For every behavior marked as EspoCRM-compatible, include the reference page/version and the tested acceptance rule. Do not label a custom enhancement as an official EspoCRM feature.

---

## 2. Reference Baseline

Use current public documentation as behavioral context, while treating the implementation as an independent TypeScript codebase:

- EspoCRM user guide — Campaigns: https://docs.espocrm.com/user-guide/campaigns/
- EspoCRM user guide — Target Lists: https://docs.espocrm.com/user-guide/target-lists/
- EspoCRM user guide — Mass Email: https://docs.espocrm.com/user-guide/mass-email/
- EspoCRM user guide — Email guidelines and template placeholders: https://docs.espocrm.com/user-guide/emails/
- EspoCRM administration — Workflows: https://docs.espocrm.com/administration/workflows/
- EspoCRM Advanced Pack overview (Workflows and BPM context): https://docs.espocrm.com/extensions/advanced-pack/overview/
- EspoCRM developer documentation — modules: https://docs.espocrm.com/development/modules/
- EspoCRM developer documentation — metadata: https://docs.espocrm.com/development/metadata/
- EspoCRM developer documentation — ACL: https://docs.espocrm.com/development/acl/
- EspoCRM developer documentation — API: https://docs.espocrm.com/development/api/
- EspoCRM developer documentation — scheduled jobs: https://docs.espocrm.com/development/scheduled-job/
- EspoCRM extension catalog: https://www.espocrm.com/extensions/

### 2.1 Reference behavior to consider

The documented Campaigns and Target Lists behavior includes:

- Campaigns for email, newsletter, informational email and non-email campaign types.
- Target lists used to include and exclude groups of CRM records.
- Campaign log events such as sent, opened, clicked, opted out, opted in, bounced and lead created.
- Campaign statistics for sending and engagement outcomes.
- Batch-based mass email sending with scheduling and administrative limits.
- Recipient opt-out behavior and target-list-specific versus global suppression choices.
- Segment population manually or from saved/report criteria where supported.
- Workflow actions that can update CRM records, execute service actions or invoke HTTP APIs when configured.

### 2.2 Baseline policy

- First implement reliable email-based marketing with campaign, audience, content, consent, sending, events and reporting.
- Implement journey automation as a new bounded domain in this project, using the generic workflow/BPM engine when that engine exists and is suitable. Do not reimplement generic workflow conditions/actions solely for marketing.
- Where a core capability is missing, document it in the audit and expose a narrow interface so the module can proceed without silently duplicating the platform.
- Do not attempt direct database compatibility with EspoCRM. The new application schema is independent.

---

## 3. Scope and Non-Goals

### 3.1 In scope

- Module registration and metadata.
- Marketing campaigns, channel/type, owner, status, timing, objectives, budget fields if the platform supports them, and campaign relationships.
- Audience segments and target-list-like inclusion/exclusion behavior.
- Consent and subscription-preference controls for marketing communications.
- Email templates, personalization, test preview and rendered-content snapshots.
- Email campaign recipient selection and execution.
- Journey builder and versioned journey definitions.
- Enrollment, step execution, delays, branch decisions, exit criteria and goal evaluation.
- Provider interface and sending pipeline with bounded rate limits.
- Inbound provider events: delivered, bounced, complaint, unsubscribe, opens, clicks and provider errors as supported.
- Unsubscribe and preference-center endpoints.
- Optional lead capture forms with spam and abuse controls.
- Campaign, segment, journey, engagement, funnel and conversion reporting.
- CRM event integration and optional Sales, CustomerSuccess, ServiceDesk and Portal integrations.
- Access control, audit, settings, scheduled jobs, operational metrics and documentation.

### 3.2 Explicit non-goals for the first release

- Replacing the platform's generic email subsystem, SMTP/IMAP configuration, template engine, workflow/BPM or job queue.
- Full social media publishing, ad buying, direct mail fulfillment, call-center dialing, WhatsApp/SMS orchestration or push notifications. Define provider adapters later if required.
- A complete marketing data warehouse, customer data platform or general-purpose ETL system.
- An unrestricted no-code scripting environment. Journey formulas and templates must use allowlisted expression functionality.
- A full-fidelity drag-and-drop landing-page website builder. Basic forms are enough for the first release.
- Guaranteed email-open accuracy. Open events may be absent or distorted by provider and privacy technologies.
- Automatic AI copy generation as a hard dependency. AI may later be an optional plugin using the project's existing AI/provider abstraction.
- Sending messages to a production audience during tests or as an implicit consequence of publishing a journey.
- Claiming legal compliance for every jurisdiction without configuration, counsel review and operational procedures.

### 3.3 Recommended delivery tiers

**Tier 1 — Safe campaign delivery**

- Campaigns and segments; preferences and consent; templates; send preview and test send; queued email delivery; unsubscribe; suppression; provider events; campaign log and basic reports.

**Tier 2 — Journey automation**

- Versioned journey builder; triggers; waits; conditions; branches; entry/exit rules; idempotent execution; CRM activity/field actions; journey analytics.

**Tier 3 — Growth features**

- Forms/lead capture; A/B tests; send-time optimization hooks; personalization rules; attribution views; lifecycle-specific playbooks; optional Sales, CustomerSuccess, ServiceDesk and Portal event connectors.

Do not block Tier 1 on non-essential Tier 3 capabilities.

---

## 4. Repository Audit and Prerequisites

### 4.1 Inspect before coding

Inspect repository code, metadata, package manifests, migration history and current implementations. Confirm the actual state of each item below.

**Platform foundation**

- Module/extension registration, dependency declaration and module lifecycle.
- Entity Engine and metadata registration for entities, fields, relations, layouts and validation.
- Kysely (or adopted SQL layer), transaction utilities and migration naming/conventions.
- Authentication, user/team/role ACL, record-level/field-level ACL and portal authorization.
- REST API structure, validation, pagination, filtering, error format and OpenAPI workflow.
- Event bus/hooks, job queue, scheduled job runner, distributed locking, retry and dead-letter mechanisms.
- Audit/history, Activity, Notification, Stream, file/attachment, import/export and reporting systems.
- Email template rendering, outbound email service, inbound/group mailbox support, provider configuration, secrets storage and webhook endpoints.
- Existing generic workflow/BPM, saved filters/reports, expression evaluator and rules engine.

**Existing CRM/domain entities**

- Contacts, Leads, Accounts, Users and their email-address representation.
- Campaigns, Target Lists or equivalent audience records.
- EmailTemplate, Email, MassEmail, mailing list, consent, opt-out or suppression records.
- Opportunities, Sales documents, subscriptions, CustomerSuccess profiles/goals, ServiceDesk cases and Portal contacts.
- Forms, web-to-lead, source attribution, website tracking, tracking URLs, URL signing and rate limiting.
- Any analytics events or webhooks already ingested.

**Frontend**

- React routing/navigation patterns, metadata-driven views, layout forms, data tables, relation panels, charts, state handling, design system and test conventions.
- Existing rich-text/HTML editor and sanitization strategy; do not add another editor if a suitable one exists.

### 4.2 Required audit deliverable

Before schema or code changes, create `docs/implementation/marketing-automation-audit.md` containing:

1. Reusable capability inventory and exact module/service names.
2. Entities that already exist and whether to extend or reuse them.
3. Missing capabilities and blockers.
4. Proposed ownership boundaries for Campaign, Target List/Audience, EmailTemplate, consent and journey records.
5. Current provider/email/job/queue architecture and limits.
6. Existing migration state and safe additive migration approach.
7. Proposed API and event contracts.
8. Phase recommendation, unresolved questions and tests that can safely run against the configured database.

Do not add a duplicate Campaign or TargetList entity before completing this audit.

### 4.3 Dependency policy

- MarketingAutomation may require CRM entities such as Contact/Lead and the shared outbound email provider abstraction for full sending capability.
- Portal integration is optional and must use the existing Portal authorization model.
- Sales, CustomerSuccess and ServiceDesk integrations are optional adapters. The module must still load when any one of these modules is absent or disabled.
- Generic Workflows/BPM, reporting, email templates and job infrastructure should be reused when their capabilities satisfy the contract; otherwise isolate missing behavior behind a narrow adapter and document why.
- If consent/suppression currently exists only as Contact fields, audit whether the model can support evidence/history and multiple channels. Extend additively; do not silently invalidate existing preferences.

---

## 5. Functional Requirements

## 5.1 Marketing campaigns

Campaign records represent strategic marketing initiatives and own campaign-level schedule, audience references, content relationship, status, goals and summary metrics.

Required capabilities:

- Create, edit, duplicate as draft, archive and view campaigns.
- Campaign type/channel configuration: start with email, newsletter and informational/non-promotional email only if the business needs it. Do not reuse the informational type to bypass marketing consent rules; informational communication must be classified and authorized separately.
- Fields: name, code/slug where needed, description, owner, team, type, status, start/end timestamps, timezone, objective, source, optional budget/cost fields, primary audience, exclusion audiences, content/message relationship, created/updated metadata and archive state.
- Campaign lifecycle: Draft → Scheduled → Running → Paused → Completed, with Failed/Archived where justified. Define legal transitions in a state machine.
- Prevent a campaign from becoming Scheduled/Running unless audience resolution, consent policy, template, sender/provider, tracking settings and required content validation pass.
- Support schedule preview and recipient-count estimation without sending.
- Support duplicate-as-draft without copying delivery history, sent recipient state, live enrollments, signed links or provider identifiers.
- Campaign membership/results are based on durable recipient records/snapshots, not just current segment definitions.
- Maintain an append-only campaign log for important operational and engagement events.
- Show summary metrics with explicit denominators and calculation timestamps.

Where a canonical Campaign entity already exists, extend it through metadata and migrations rather than introducing a second generic Campaign table. If its semantics cannot support journeys, create a distinct `MarketingJourney` and link it to the campaign record.

## 5.2 Audience segments and recipient resolution

A segment defines who may be considered for a campaign or journey. The recipient resolver must always apply consent and suppression filters after membership resolution.

Supported membership types:

- **Static:** explicitly selected CRM record IDs with membership audit.
- **Dynamic:** validated query criteria evaluated at a defined point in time or refreshed by a scheduled job.
- **Behavioral:** based on marketing event criteria, such as clicked a particular campaign, subject to tracking/privacy settings.
- **Lifecycle-based:** based on allowed CRM attributes/events such as Lead status, opportunity stage, customer lifecycle or support context, only when the related module and permission contract are available.

Required behavior:

- A segment can include one or more compatible record types, initially Contacts and Leads; Accounts/other person or company entities require an explicit compatibility contract and recipient-address rule.
- Include and exclude segments must be supported with exclusion winning over inclusion.
- Resolve by canonical record ID and normalized email identity. De-duplicate a recipient across matching records using documented rules.
- Do not merge records or alter identity merely because email addresses match. Recipient deduplication is a send-time policy, not an identity-resolution system.
- Validate dynamic criteria against entity/field allowlists, types, operators and ACL-aware query rules. Never execute user-provided SQL.
- Dynamic segment previews show count and sample records accessible to the user. Never expose inaccessible fields or records through count/sample APIs.
- Segment membership changes must be auditable where operationally relevant. Use a snapshot for a send, not a query that keeps changing while batches are sent.
- Define whether a dynamic segment is evaluated at journey enrollment time, at each step, or both. Default to snapshot eligibility at entry plus mandatory live consent/suppression checks at each actual send.
- Avoid an unbounded cross-entity join or arbitrary formula query. Enforce query cost/time limits and pagination.

## 5.3 Consent, preferences, and suppression

Consent and suppression are a core domain requirement, not a future enhancement.

Track as appropriate:

- Contact/Lead or canonical person reference.
- Normalized address and channel.
- Communication purpose/category, such as newsletter, product marketing, event updates, or required service notices.
- State: unknown, pending confirmation, subscribed/consented, opted out, suppressed, invalid, or other explicitly defined state.
- Consent basis/type, source, timestamp, capture context, policy/text version and locale when provided.
- Double-opt-in confirmation token hash, issuance/expiry/confirmation timestamps and confirmation result where configured.
- Actor/source, import or API provenance, IP/user-agent only when justified by policy, and audit history with privacy retention rules.
- Scope: global email marketing suppression, channel-wide suppression, purpose-specific preference, and optionally list-specific preference. Global suppression and provider complaint/hard-bounce states take precedence.

Required invariants:

1. A recipient must pass eligibility checks when the send is queued **and again immediately before the provider call**.
2. An unsubscribe or complaint processed after queueing but before delivery blocks the pending message.
3. No duplicate sends occur when one person is present in multiple included segments.
4. Global opt-out cannot be overridden by adding the record back to a segment or restarting a journey.
5. Invalid or unknown consent is handled according to an explicit policy; do not silently interpret missing evidence as consent.
6. Test sends are permitted only to the explicitly supplied, authorized test address and are labelled as tests. They must not be logged as normal campaign delivery or enroll the address into a campaign.
7. Contact data updates and email-address changes must not silently transfer consent evidence from an old address to a new address without the documented policy.
8. A provider complaint or hard bounce adds the appropriate suppression/invalid state according to configurable, reviewed rules.
9. Every consent mutation records actor/source, prior state, new state, timestamp and reason/source where available.
10. Consent endpoints and preference changes are idempotent and safe to call repeatedly.

### 5.3.1 Unsubscribe endpoint

- Provide a secure, low-friction unsubscribe operation that does not require a normal CRM login.
- Use a signed, scoped, expiring token or opaque random token stored as a hash; never put a contact ID/email address or raw personal data into a reusable URL.
- Support one-click unsubscribe POST semantics compatible with email provider/client expectations where required by policy.
- A browser GET may display a confirmation/preferences page but should not unintentionally unsubscribe on link-preview crawler visits; implement a deliberate mechanism to distinguish preview from explicit confirmation.
- Make opt-out fast and idempotent. Pending send jobs must re-check state.
- Do not leak whether an arbitrary email address belongs to the CRM when using public preference endpoints.
- Keep an audit entry without storing raw tokens.

### 5.3.2 Preference center

- Provide a minimal, responsive preference page with unsubscribe-all and, where configured, purpose-specific preferences.
- Explain what each subscription category controls.
- Respect existing opt-out states; a preference change may not silently re-subscribe a globally opted-out recipient.
- Re-subscription requires explicit affirmative confirmation and should record the new source and evidence.
- Revoke old preference tokens when appropriate, and rate-limit public endpoints.

## 5.4 Email content and templates

- Reuse the existing EmailTemplate renderer/editor when compatible.
- Support plain-text and sanitized HTML content, subject, preview text, sender/reply-to selection, footer, preference/unsubscribe link, tracking options and template metadata.
- Support approved placeholders for canonical CRM fields, campaign fields and safe helper values. Unknown placeholders should produce a preview warning or deliberate fallback, not leak internal errors.
- Prevent access to fields the sender cannot read. Template rendering must use a restricted, validated recipient context, not unrestricted entity hydration.
- Apply HTML sanitization and URL validation to avoid scripts, event handlers, unsafe protocols and template-driven injection.
- Escape values based on output context. Avoid building HTML by concatenating untrusted values.
- Support default/fallback values, including missing names, optional fields, locale and timezone.
- Preview with a selected sample contact and display unresolved placeholders, invalid links and missing mandatory footer/preference links.
- Store an immutable content/render version or rendered snapshot for each actual send, according to retention policy, so an audit can reconstruct what was sent.
- Provide test-send, subject/body preview and mobile-width preview. Test sending requires permission and an explicit destination.
- Keep images/assets in the shared file system and apply the existing authorization rules. For assets embedded in external emails, use deliberate public delivery URLs only when designed for that purpose.
- Optional localized variants can be added after MVP; default to safe locale fallback.

## 5.5 Campaign messages and send definitions

A campaign may own one or more send definitions (for example, a newsletter plus a later reminder). Model those separately if it improves clarity and avoids overloading Campaign fields.

Required fields per send:

- Campaign reference, channel, template/version, intended purpose, sender configuration reference, schedule, timezone, audience include/exclude references, consent policy, tracking settings, send limits, status and approval metadata.
- Lifecycle: Draft → Validated → Scheduled → Queued → Sending → Sent/Completed, with Paused, Cancelled and Failed states as needed.
- Dry-run preview: audience estimate, duplicates removed, excluded by segments, unsubscribed, unknown consent, bounced/invalid, missing email, frequency-cap blocked and final eligible count.
- A preview snapshot must be distinguishable from a final send snapshot. Any material change in audience/template/sender/policy after validation invalidates prior approval and requires re-validation.
- Provide explicit scheduling, time zone handling, pause and cancel operations. Define what pause/cancel means for queued but not-yet-sent messages.
- Do not queue one database job per millions of recipients if the platform queue is not designed for that pattern. Use bounded chunks and persistent recipient state.

## 5.6 Journey builder and definition model

A marketing journey is a versioned graph of triggers, conditions, delays and actions. It must be a constrained, validated domain graph, not arbitrary executable code.

Supported node types for the first implementation:

- Entry/trigger.
- Wait/delay.
- Condition/branch.
- Send email.
- Update allowlisted CRM fields or apply a predefined service action.
- Create/link a Task or Activity, where the platform supports it.
- Notify an internal owner/team.
- Exit/end.
- Goal/conversion check.

Potential later nodes, not required for the first release:

- A/B split and deterministic variant assignment.
- Webhook/API action through the platform's secure integration adapter.
- Multi-channel message actions such as SMS or push, if the platform adds an approved provider.
- AI-assisted content suggestions through an existing AI abstraction.

Triggers may include:

- Manual enrollment by an authorized user.
- Added to or entering a dynamic segment.
- Form submission.
- A whitelisted CRM domain event (for example, eligible Lead created, Opportunity stage changed, invoice paid, customer health changed or Case closed).
- A date/time field or scheduled trigger with explicit timezone/recurrence semantics.

Required journey semantics:

- Draft, published, paused, archived and retired states.
- Each publish creates an immutable version with a validated node graph, settings and content references.
- Version a journey before changing live logic; define whether new enrollments use the new version while existing enrollments stay on their original version. Default: new version for new enrollments; existing enrollments retain their pinned version unless an explicit migration operation is performed.
- Validate a graph for a single valid entry path, reachable nodes, valid branch outputs, bounded/correct loops (prefer no arbitrary loops in MVP), reachable terminal states and no disconnected required nodes.
- Detect cycles and reject unbounded loops.
- Define node input/output types and allowed transitions. Prevent arbitrary function evaluation, unbounded expressions, SQL, file-system access or network calls from node configuration.
- Configure re-entry policy: no re-entry, after exit, or limited re-entry after a defined interval. Consent/suppression always applies separately.
- Configure exit conditions: unsubscribe, hard bounce, complaint, customer conversion/goal reached, segment loss when enabled, manual removal or journey termination.
- Support goal conditions and conversion windows; report goals separately from simple message delivery.
- Give journey owners a complete execution trace with node timestamps, branch evaluation result, wait schedule, message reference, skipped action reason and error details safe for display.

## 5.7 Journey enrollment and step execution

Each enrollment is a durable process record. Do not rely solely on an in-memory workflow or a delayed queue message to preserve journey state.

Required data:

- Journey and pinned version.
- Canonical contact/lead record reference and normalized recipient identity as needed.
- Enrollment source/trigger and dedupe key.
- Status: active, waiting, completed, exited, cancelled, failed or suspended.
- Current node, next eligible time, created/updated/finished timestamps and exit reason.
- Snapshot of enrollment data required for repeatable decisions, with privacy/retention limits.
- Per-step execution record and idempotency key.

Execution rules:

- A single enrollment cannot execute the same node/action twice unless that node is explicitly designed for safe repeat.
- Multiple workers must not advance the same enrollment concurrently. Use atomic claims, row-level locking/optimistic versions or the existing distributed execution primitive.
- A crash after provider acceptance but before local acknowledgement must not cause a duplicate email. Where the provider supports idempotency keys, use them; otherwise persist provider submission state and document the remaining uncertainty.
- Wait nodes store a durable `next_run_at`; process restarts must not reset or duplicate delays.
- Separate transient failures (retryable) from permanent failures (invalid configuration, ineligible consent, invalid address or invalid journey version).
- Use bounded retries, exponential backoff with jitter, maximum attempt counts and a dead-letter/error status with operator visibility.
- Pausing a journey must stop new steps safely. Define whether a currently running send is allowed to finish; no new send may be initiated while paused.
- Unsubscribe, complaint, hard bounce and global suppression cause immediate eligibility re-check and, where appropriate, exit/suspend the recipient from marketing journeys.
- Support authorized manual enroll, suspend, resume, exit and retry operations with audit history.
- Manual retry may re-run a failed step only if safe and idempotent; it must not silently repeat already accepted external side effects.

## 5.8 Email delivery pipeline

The module should orchestrate delivery through an existing shared provider interface; it must not embed provider-specific SDK calls throughout campaign/journey code.

Provider abstraction should expose, as appropriate:

- Capabilities and verified sender/configuration identity.
- Send one message or bounded batch.
- Provider message ID and accepted/rejected result.
- Rate limits, quota status and retryable/permanent failure classification.
- Event/webhook verification and event normalization.
- Bounce/complaint/unsubscribe semantics supported by that provider.

Required pipeline behavior:

- Queue campaign recipients as durable records before sending.
- Deduplicate recipient records by send-definition plus canonical recipient identity.
- Re-check consent, suppression, recipient validity, campaign status, frequency cap and provider limits immediately before sending.
- Render the approved content revision, then persist the rendered content/hash and minimal audit facts required by policy before/around provider submission according to the delivery consistency design.
- Use bounded batch sizes and a global/per-provider/per-sender rate limiter.
- Respect provider daily/hourly quotas and `Retry-After` responses.
- Retry network timeouts and temporary 4xx/5xx/provider failures within policy; do not indefinitely retry invalid recipient, rejected authentication, malformed content or permanent errors.
- Treat ambiguous provider submission outcomes carefully to avoid duplicate sends. Track `submission_unknown` or equivalent if the provider response cannot be reliably established.
- Pause a sender/campaign automatically after repeated authentication/provider errors or a configurable bounce/complaint threshold, and notify authorized operators.
- Support campaign pause/cancel and global emergency send-stop.
- Never log full message bodies, tokens or recipient lists at normal log level.
- Provide per-provider health/latency/error metrics without exposing recipient personal data.

## 5.9 Delivery, engagement and event tracking

Normalize provider events into a stable internal event model. Supported event categories may include:

- queued, accepted/sent, delivered, deferred, soft bounce, hard bounce, rejected, spam complaint, unsubscribed, opened, clicked and provider-specific error.
- Form submitted, journey goal reached, segment entered/exited and conversion attributed when applicable.

Requirements:

- Verify webhook signature/authentication and timestamp/replay policy before accepting an event.
- Store provider event ID and deduplication key. Replayed webhook calls must not double-count or repeat side effects.
- Handle out-of-order events. An event received later must not incorrectly roll back a stronger terminal state such as hard-bounced/suppressed.
- Use an append-only event log where practical and derive aggregates/reduced status from explicit rules. Do not silently edit past event history to force metrics to match.
- Do not assume events will arrive exactly once, immediately or in order.
- Open-tracking is optional/configurable and must be described as approximate. Privacy proxies, image caching and mail-client behavior can distort results.
- Click tracking must use safe redirect IDs, validate destination URLs against allowed schemes, prevent open redirects and avoid exposing internal IDs or personal data.
- Tracking configuration must allow disabling tracking where privacy policy or jurisdiction requires it.
- Respect retention settings and data-minimization policies for IP address, user agent and raw provider payload. Store raw payload only if needed for support/audit, redact secrets and expire it under a documented retention rule.
- Separate click/open/bounce events from successful business conversion. A click must not itself be interpreted as verified human intent unless the metric expressly defines it that way.

## 5.10 Public forms and lead capture

Implement simple forms only if no suitable shared form/web-to-lead feature exists. If one exists, add campaign and consent integration rather than creating a new form builder.

Possible form fields:

- Form name/ID, public slug, campaign/source, status, allowed domains/origins, form version and submit destination.
- Field definitions based on an allowlist of public-safe CRM fields.
- Consent checkbox/preferences with versioned consent wording and evidence.
- Optional double-opt-in requirement.
- Success/error state, redirect URL and notification configuration.

Security requirements:

- Validate field schema and input on the server; do not accept arbitrary entity or field names from a public request.
- Apply per-IP/per-form rate limits, honeypot or approved bot protection, payload size limits and abuse monitoring.
- Do not expose internal CRM record IDs, stack traces, existing-contact matches or account-level data to unauthenticated users.
- Prevent duplicate submissions using a dedupe strategy that does not treat attacker-controlled fields as authoritative identity.
- Public endpoint may create/update a lead only through a documented service contract and safe field allowlist.
- Do not auto-enroll into promotional email merely because a form was submitted. Enrollment depends on the consent/purpose captured and configured policy.
- If Portal already supports authenticated forms, prefer its identity and permission model for Portal-facing forms.

## 5.11 Attribution and conversion tracking

The initial attribution implementation must be transparent and conservative.

- Associate each recipient/send event with campaign, send definition, journey/version and canonical CRM record when allowed.
- Capture first-touch and last-touch campaign references only if the CRM attribution model supports them; otherwise add an explicit, documented model.
- Link marketing outcomes to Leads, Opportunities, Accounts and Sales records through stable references rather than duplicated revenue records.
- Support optional attribution windows and simple models such as first touch, last touch and campaign-influenced. Name each model precisely.
- Distinguish sourced revenue, influenced revenue, pipeline amount and closed-won revenue.
- Do not claim causality from an observed interaction. Reports must show the model and window used.
- If an opportunity is linked to multiple campaigns, do not sum the full opportunity amount into every campaign in a way that produces misleading total revenue. Use explicit fractional allocation or label metrics as non-additive influenced values.
- Respect record permissions and field restrictions in aggregate and drill-down reports.

## 5.12 A/B tests and experimentation (after MVP)

- Define a campaign-level experiment with variants, eligible audience split, allocation method, success metric, start/stop time and winner policy.
- Use deterministic assignment keyed by recipient + experiment so a recipient does not switch variant on retry.
- Avoid running overlapping experiments that violate the same audience/frequency constraints unless explicitly supported.
- Minimum sample rules and winner calculation must be documented. Do not declare a statistical winner when volume is inadequate.
- Do not auto-send a winner to the rest of an audience without a configured rule, threshold and explicit publishing approval.

## 5.13 Cross-module integration contracts

### CRM Core

- Use canonical Contacts/Leads/Accounts and platform email-address models.
- Subscribe to domain events rather than polling tables where a reliable event bus exists.
- Use platform Activity, Tasks, notifications, audit, files, reports and workflow services.
- Respect CRM ACL when selecting audiences, previewing records, and showing drill-down data.

### Portal

- Reuse the existing Portal. Add public-safe preference and form surfaces only as needed.
- Do not expose marketing campaigns, raw recipient logs, other contacts, internal segmentation criteria, journey execution data or internal notes to Portal users.
- If a portal contact updates preferences, use the same consent command/service as the public unsubscribe endpoint and record the actor/source.

### Sales

- Optional triggers: lead created/qualified, opportunity stage changed, quote accepted, invoice paid, subscription started/renewed/cancelled, subject to actual event availability and permissions.
- Do not block MarketingAutomation from booting when Sales is missing.
- Do not create or update commercial amounts as an implicit marketing action. Any action affecting Sales must use a documented, permission-checked command.

### CustomerSuccess

- Optional triggers: onboarding completed, customer health state changed, renewal readiness changed, success goal reached.
- Use only documented events and avoid circular dependencies. CustomerSuccess may consume campaign-engagement summaries but must not depend on internal journey tables.

### ServiceDesk

- Optional triggers: eligible service case opened/closed or satisfaction event, if marketing policy permits it.
- Transactional service communications must remain distinct from marketing messages. Do not add a ServiceDesk customer to promotional journeys just because a ticket was opened or closed.

### Workflow/BPM and other automation

- Expose explicit domain commands and events that generic workflow/BPM can call.
- Avoid a recursive event cycle in which MarketingAutomation triggers a workflow that re-triggers the same journey indefinitely. Use causation IDs, correlation IDs, origin markers and loop guards.
- Do not execute arbitrary HTTP calls directly from journey definitions. Delegate to a validated integration action with secret management, network restrictions and timeouts.

## 5.14 Reporting and dashboards

Minimum reporting:

- Campaign list with status, target size, eligible size, queued, accepted/sent, delivered, bounce, complaint, unsubscribe, click, lead-created and goal/conversion values.
- Journey dashboard: enrolled, active, waiting, completed, exited, failed, step drop-off, goal attainment and average time-to-goal.
- Email deliverability dashboard: accepted/delivered, hard/soft bounce, complaint, suppression and provider error trends.
- Audience/segment preview: raw members, duplicates, missing email, exclusions, suppressed, consent-ineligible and eligible recipients.
- Funnel: eligible audience → queued → accepted → delivered → click/response → CRM conversion, with denominators and time windows clearly specified.
- Attribution reports for campaigns, leads and opportunities using the configured attribution model.
- Failure and dead-letter view for operators.

Rules:

- Metrics must expose the event definitions and denominators used.
- Avoid dividing by zero; show “N/A” when there are no eligible recipients or observations.
- Distinguish recipient count, message count, event count and unique person count.
- Deduplicate provider event IDs; don't count webhook retries as extra clicks/deliveries.
- Apply ACL to both summary and row-level drill-down data.
- Use asynchronous aggregation for large event volumes. Do not calculate all historical events in an unbounded synchronous list request.

---

## 6. Domain Model and Persistence Design

> The entity names below are suggestions, not permission to duplicate existing CRM entities. Confirm canonical ownership in the repository audit before implementing migrations.

## 6.1 Campaign and audience records

### `MarketingCampaign` / existing `Campaign`

Suggested fields:

- `id`, `name`, `code`, `description`, `type`, `status`, `owner_user_id`, `team_id`.
- `starts_at`, `ends_at`, `timezone`, `objective`, `source`, optional `budget_amount`/`budget_currency`.
- `primary_segment_id` or relationship to included segments; excluded segment relationships.
- `created_at`, `updated_at`, `created_by`, `updated_by`, `deleted_at`/archive metadata according to platform conventions.
- Optimistic version/concurrency token if the existing entity contract supports it.

### `MarketingSegment` / existing `TargetList`

Suggested fields:

- `id`, `name`, `description`, `membership_mode` (`static` or `dynamic`), `entity_types`, validated `criteria_json`, refresh policy, status, owner/team and timestamps.
- Query schema version and `last_refreshed_at`, `refresh_status`, `last_error_code` if dynamic syncing exists.
- Do not store raw SQL or executable code in `criteria_json`.

### `MarketingSegmentMember`

Use only if the canonical target-list implementation cannot already persist suitable membership.

- `segment_id`, `entity_type`, `entity_id`, `added_by`, `added_at`, `source`, optional removal metadata.
- Unique constraint on `(segment_id, entity_type, entity_id)`.
- Index by `(entity_type, entity_id)` for reverse lookups.

### Audience/send snapshot

Store a durable, immutable snapshot of recipient identity/record references and eligibility outcome for each send definition. Use encrypted or minimized recipient-address snapshot fields according to the privacy design. Avoid storing the same PII in numerous tables unnecessarily.

## 6.2 Message and template records

### `MarketingSend` / campaign send definition

- `id`, `campaign_id`, send name, channel, purpose, status, template reference and template version.
- Included/excluded segment relationships, schedule/timezone, sender/provider reference, tracking policy, frequency-cap policy, max recipients/batch and approval fields.
- `audience_snapshot_id`, preview results, validation hash, validation timestamp, approved hash/actor/time.
- Lifecycle timestamps, pause/cancel metadata, failure summary and correlation ID.

### `MarketingTemplateRevision`

If the shared EmailTemplate has no immutable revision/version mechanism, add a marketing revision wrapper rather than forking the template renderer.

- `id`, template reference, revision number, subject, preheader, HTML/text body or content references, sender policy, purpose and locale.
- Content hash, created by/time and archive state.
- Avoid persisting duplicate rendered bodies indefinitely; apply explicit retention.

## 6.3 Consent and suppression records

### `MarketingConsent`

- Canonical person/contact/lead reference where available.
- Normalized email-address identity, channel and purpose/category.
- State, source, consent type/basis, capture timestamp, policy wording/version, locale and evidence metadata.
- Confirmed/withdrawn timestamps, actor/source, reason and audit correlation ID.
- Optional reference to the CRM email-address record; do not assume a person has only one address.

### `MarketingConsentEvent`

Append-only history of state changes with prior/new state, source, timestamp, policy reference and actor/system identity. Avoid storing raw token values or unnecessary request metadata.

### `MarketingSuppression`

- Normalized address identity or provider-recipient identity, channel, scope/reason (global opt-out, complaint, hard bounce, invalid, operator block, legal restriction), source, effective timestamp and last-seen provider event.
- Ensure suppression logic supports global and purpose-specific scopes. Do not duplicate a global suppression into every individual segment.
- Store minimal data needed to prevent future sends, while respecting deletion/retention obligations; design a privacy-reviewed suppression tombstone policy.

## 6.4 Journey definition and runtime records

### `MarketingJourney`

- `id`, name, description, status, owner/team, trigger family, enrollment policy, exit policy, goals, settings and timestamps.
- A pointer to the current published version; not a mutable live graph.

### `MarketingJourneyVersion`

- `journey_id`, monotonically increasing `version`, immutable graph definition JSON, validated graph hash, schema version, publisher/time, content dependencies and release notes.
- Store graph config as data with strict validation, not source code.
- Unique constraint on `(journey_id, version)`.

### `MarketingJourneyEnrollment`

- `id`, journey/version, canonical person reference, normalized recipient identity, enrollment source/event ID, dedupe key, state, current node ID, `next_run_at`, entry/exit timestamps, exit reason and correlation ID.
- Unique/dedupe index enforcing the configured no-re-entry/re-entry policy.
- Use a version counter or lock metadata for concurrent advancement.

### `MarketingJourneyStepExecution`

- Enrollment, journey version, node ID, attempt number, execution status, start/end time, scheduled time, safe input/output summary, error code, retryable flag and idempotency key.
- Unique idempotency index for an action instance.
- Keep raw sensitive payloads out of step logs unless explicitly required and protected.

### `MarketingJourneyEvent`

Optional normalized event/inbox record used for event-trigger matching and replay control. Reuse an existing event inbox/outbox where possible.

## 6.5 Recipient delivery and event records

### `MarketingRecipientDelivery`

One record per send definition and canonical recipient identity.

- Campaign/send reference, journey enrollment/step reference when applicable, contact/lead reference, normalized email reference/snapshot, state, eligibility decision, decision reasons, template revision/hash, message idempotency key, provider reference/message ID, provider response class, retry count and timestamps.
- Unique constraint on the send definition + canonical recipient identity + intended message slot.
- Consent/suppression outcome must be recorded without exposing more PII than necessary.

### `MarketingEvent`

- Internal event ID, event type, occurrence and receipt timestamps, campaign/send/journey/version/enrollment/delivery references, canonical recipient reference where permitted, provider event ID, provider name, tracking ID, URL reference and normalized event properties.
- Deduplication unique constraint where provider event IDs are available; robust composite fallback where absent.
- Append-only event data where feasible. Aggregations can be rebuilt.

### `MarketingProviderWebhookInbox`

Use the platform's general webhook inbox if suitable; otherwise create a narrow inbox table with provider, dedupe key, received timestamp, signature-validation result, processing status and redacted failure reason. Do not store raw secrets or trust arbitrary unverified payloads.

## 6.6 Forms and conversion records

If no reusable form subsystem exists:

- `MarketingForm`: public ID/slug, form schema version, allowed fields, linked campaign, allowed origin/domain, consent options, success behavior, status and owner.
- `MarketingFormSubmission`: form/version, created time, canonical record reference, dedupe key, consent event reference, source/UTM data and safe processing status.
- Avoid storing all submitted PII a second time. Keep only fields required for audit and integration; reference the canonical Lead/Contact record.

## 6.7 Constraints and indexes

At minimum, evaluate these index classes based on measured queries:

- Segment memberships by segment and by CRM record.
- Dynamic segment and campaign statuses for operational lists.
- Scheduled sends by `(status, scheduled_at)`.
- Recipient delivery by `(send_id, status)`, unique dedupe key and provider message ID.
- Active journey enrollments by `(status, next_run_at)`.
- Journey executions by enrollment/version/node/status and unique idempotency key.
- Events by campaign, delivery, journey, type and occurrence time; provider event ID uniqueness.
- Consent by canonical person/email identity, channel, purpose and current state.
- Suppression by normalized address hash/identity and scope.
- Form submission dedupe key and campaign/source.

Use appropriate FK deletion policies. Historical event/consent/execution records generally require restricted deletion or privacy-reviewed anonymization rather than cascading away on ordinary campaign deletion.

## 6.8 Migration and data-retention policy

- Follow the existing migration framework. Never create a parallel migration system.
- Prefer additive tables/columns and backward-compatible rollout.
- Review migrations before applying them to the configured primary database.
- No destructive data migration without an explicit impact plan and approval.
- Define retention separately for content snapshots, provider payloads, event details, analytics aggregates, form submissions, consent evidence and execution logs.
- Avoid deleting suppression evidence in a way that could cause a previously opted-out person to be emailed again. Have the privacy/data deletion design reviewed before release.

---

## 7. Domain Services and Runtime Architecture

## 7.1 Suggested service boundaries

Use existing repository naming conventions. Suggested responsibilities:

- `MarketingCampaignService`: campaign lifecycle, validation and orchestration.
- `MarketingAudienceService`: query validation, preview, membership resolution, exclusion and deduplication.
- `MarketingEligibilityService`: centralized consent, suppression, validity, frequency-cap and policy decisions.
- `MarketingConsentService`: subscription state transitions, opt-in confirmation, unsubscribe and preference updates.
- `MarketingTemplateService`: renderer integration, preview, safe personalization and revision snapshots.
- `MarketingSendService`: send definition validation, scheduling, campaign pause/cancel and recipient creation.
- `MarketingDeliveryWorker`: queue claim, final eligibility gate, provider call, result persistence and retries.
- `MarketingProviderRegistry`: provider selection and capability lookup.
- `MarketingProviderAdapter`: narrow interface for the selected provider.
- `MarketingEventIngestionService`: webhook authentication, normalization, deduplication, suppression updates and campaign logs.
- `MarketingJourneyDefinitionService`: graph validation and immutable publishing.
- `MarketingJourneyEnrollmentService`: enrollment, re-entry rules, exits and lifecycle operations.
- `MarketingJourneyExecutor`: atomic execution of the next node and durable wait scheduling.
- `MarketingGoalService`: goal matching and completion.
- `MarketingAttributionService`: explicit attribution model and outcome associations.
- `MarketingReportingService`: metrics, aggregates and drill-down access control.
- `MarketingFormService`: public form validation, abuse prevention and safe CRM record handling if forms are in scope.

Do not create all these classes mechanically if the codebase follows a different service granularity. Keep responsibilities testable and avoid a monolithic service class.

## 7.2 Transaction boundaries

- Campaign state changes and send validation metadata must be committed atomically.
- Audience snapshots and recipient delivery rows must be persisted before workers attempt delivery.
- Enrollment creation and deduplication must be atomic.
- Journey step claim/state transition and step execution record must be coordinated so concurrent workers cannot advance the same enrollment.
- Provider network calls cannot generally participate in the database transaction. Use an outbox/state-machine design and explicit submission states rather than holding database transactions open across network calls.
- Event inbox insertion and deduplication must occur before side effects such as suppression updates, journey triggers or metric counters are processed.
- Consent/suppression updates and eligibility checks should be serialized sufficiently to prevent a known unsubscribe being ignored by a pending send. Recheck as close as possible to provider submission and document unavoidable race windows.
- Use the platform's existing transaction and outbox/event patterns where available.

## 7.3 Domain events

Publish versioned events using the platform's event conventions. Candidate events:

- `marketing.campaign.created.v1`
- `marketing.campaign.scheduled.v1`
- `marketing.campaign.started.v1`
- `marketing.campaign.paused.v1`
- `marketing.campaign.completed.v1`
- `marketing.send.recipient.queued.v1`
- `marketing.message.accepted.v1`
- `marketing.message.delivered.v1`
- `marketing.message.bounced.v1`
- `marketing.message.complaint.v1`
- `marketing.message.unsubscribed.v1`
- `marketing.message.clicked.v1`
- `marketing.consent.changed.v1`
- `marketing.segment.entered.v1`
- `marketing.segment.exited.v1`
- `marketing.journey.enrolled.v1`
- `marketing.journey.step.completed.v1`
- `marketing.journey.goal.reached.v1`
- `marketing.journey.exited.v1`
- `marketing.form.submitted.v1`
- `marketing.conversion.attributed.v1`

Event contract requirements:

- Include event ID, version, occurred-at time, tenant/organization scope if the platform has tenancy, entity reference, correlation ID, causation ID and origin/source.
- Avoid including full contact objects, rendered email body, tokens, or unnecessary personal data in event payloads.
- Consumers must tolerate retries and duplicate delivery.
- Event schema changes require backward-compatibility consideration and contract tests.

## 7.4 Error model

- Validation errors: invalid audience criteria, missing template, invalid sender, invalid graph, missing consent purpose, impossible schedule.
- Policy blocks: opted out, suppressed, unknown consent, invalid email, frequency cap, campaign paused.
- Transient execution errors: provider timeout, rate limit, network failures, queue unavailability.
- Permanent execution errors: invalid credentials, unsupported provider feature, malformed content, unreachable node reference, permanently rejected recipient.
- Security errors: invalid webhook signature, expired/invalid public token, unauthorized action, forbidden record/field.

Expose stable error codes and safe diagnostic messages. Do not leak SQL, stack traces, provider secrets or hidden entity details.

---

## 8. API Design

Follow the existing `/api/v1` conventions. The paths below are illustrative; align them with established controller and entity naming rules.

## 8.1 Standard resources

Potential resources, only when not already exposed by generic Entity Engine:

- `/api/v1/MarketingCampaign`
- `/api/v1/MarketingSegment`
- `/api/v1/MarketingSend`
- `/api/v1/MarketingJourney`
- `/api/v1/MarketingJourneyVersion`
- `/api/v1/MarketingJourneyEnrollment`
- `/api/v1/MarketingTemplateRevision`
- `/api/v1/MarketingConsent`
- `/api/v1/MarketingSuppression`
- `/api/v1/MarketingEvent`
- `/api/v1/MarketingForm`

Use the actual existing canonical entity names when they already exist. Standard list/detail/create/update behavior should use the shared Entity Engine where possible.

## 8.2 Domain command endpoints

Potential command endpoints:

- `POST /api/v1/MarketingCampaign/{id}/validate`
- `POST /api/v1/MarketingCampaign/{id}/preview-audience`
- `POST /api/v1/MarketingCampaign/{id}/schedule`
- `POST /api/v1/MarketingCampaign/{id}/start`
- `POST /api/v1/MarketingCampaign/{id}/pause`
- `POST /api/v1/MarketingCampaign/{id}/cancel`
- `POST /api/v1/MarketingCampaign/{id}/send-test`
- `POST /api/v1/MarketingSend/{id}/preview`
- `POST /api/v1/MarketingSegment/{id}/preview`
- `POST /api/v1/MarketingJourney/{id}/validate`
- `POST /api/v1/MarketingJourney/{id}/publish`
- `POST /api/v1/MarketingJourney/{id}/pause`
- `POST /api/v1/MarketingJourney/{id}/resume`
- `POST /api/v1/MarketingJourney/{id}/enroll`
- `POST /api/v1/MarketingJourneyEnrollment/{id}/suspend`
- `POST /api/v1/MarketingJourneyEnrollment/{id}/resume`
- `POST /api/v1/MarketingJourneyEnrollment/{id}/exit`
- `POST /api/v1/MarketingJourneyEnrollment/{id}/retry-step`
- `POST /api/v1/MarketingConsent/{id}/change-state`
- `POST /api/v1/MarketingForm/{id}/preview`

Commands should be explicit operations with server-side state-transition validation rather than generic unrestricted updates of fields such as `status`, `publishedVersion` or `consentState`.

## 8.3 Public and provider endpoints

Possible public endpoints:

- `GET /public/marketing/preferences/{token}`
- `POST /public/marketing/unsubscribe/{token}`
- `POST /public/marketing/subscribe/{token}/confirm`
- `POST /public/marketing/forms/{publicId}/submit`
- `GET /public/marketing/click/{trackingId}` (only when click tracking is enabled)
- `GET /public/marketing/open/{trackingId}` (only when open tracking is enabled and policy allows it)
- `POST /webhooks/marketing/{providerKey}`

Security requirements:

- Use opaque/signed high-entropy tokens, expiry and scope constraints; persist token hashes when practical.
- Rate-limit and validate payload size.
- Verify webhook signatures using constant-time comparison where applicable, enforce replay/idempotency protection, and rotate secrets safely.
- Reject unknown provider keys, unsigned events and arbitrary destination URLs.
- Never reveal whether an arbitrary email/person exists.
- Public endpoints must not use a general admin/service credential or bypass business invariants.

## 8.4 API contract requirements

- Validate DTOs at runtime; reject unknown/unsafe graph node properties according to the schema policy.
- Use consistent pagination/filtering and avoid unbounded event-list responses.
- Apply ACL to campaign/segment/journey data and every drill-down row.
- Use optimistic concurrency or explicit version checks on journey editing and publishing.
- Return a validation report listing blocking errors and non-blocking warnings for campaign/journey validation.
- Keep public API and provider webhook contracts in OpenAPI or focused contract documentation, as appropriate.
- Avoid returning raw recipient-level PII or internal segment criteria to users who can only view summary metrics.

---

## 9. Permissions, Privacy, and Security

## 9.1 Permission areas

Define permissions following the existing ACL system, with capabilities such as:

- View campaign, segment, journey, template and aggregate analytics.
- Create/update/archive campaigns and segments.
- Preview audiences and access recipient-level details.
- Manage marketing consent and suppression.
- Preview content and send a test message.
- Approve, schedule, start, pause, cancel or resume campaign sends.
- Create/edit/publish journey versions and manage enrollments.
- View individual journey execution and delivery logs.
- Configure providers, rate limits, tracking, public forms and settings.
- View/export recipient-level reports.

Avoid one `MarketingAdmin` permission that grants every action by default. Use least privilege and existing role/team/record ACL.

## 9.2 Record and field access

- Campaign owner/team/record rules must be enforced server-side.
- Audience preview must honor record and field ACL; row count must not be used to infer unauthorized records if that would be a disclosure concern.
- Only authorized users can inspect recipient-level logs, email addresses, consent evidence or raw provider event details.
- Sensitive fields must not be exposed in templates simply because a user can send a campaign. Use the template field allowlist and effective permissions.
- Background jobs act under an explicit service identity and permission model; they must not rely on an expired human session or silently become an all-powerful bypass.
- Portal users can only manage their own permitted preferences and view their own authorized form submissions, if any.

## 9.3 Data protection and compliance

- Support configurable lawful-purpose, consent and retention policies. A software feature alone cannot establish legal compliance in every jurisdiction; obtain appropriate legal/privacy review before launch.
- Make marketing versus transactional/required communication explicit. Transactional email must not be used as a loophole for promotional content.
- Apply privacy/data-subject deletion/access/export workflows through the platform's existing data privacy mechanisms where available.
- Minimize collection and retention of IP address, user-agent, raw payload, recipient snapshots and rendered content.
- Ensure audit logging avoids raw email bodies, secrets and tokens unless there is a reviewed operational need.
- Document retention/deletion interaction with opt-out suppression so a deleted profile is not inadvertently re-contacted if a legally required suppression tombstone is needed.
- Support configurable open/click tracking and privacy notices. Do not assume tracking is permitted in every deployment.

## 9.4 Secure content and integration handling

- Sanitize email HTML and public form content; validate link schemes; block `javascript:`, `data:` and unintended local/private network URLs.
- Validate webhook payloads and signatures before parsing business events into actions.
- Keep provider secrets in the platform's secrets/configuration mechanism, never in entity fields returned to clients.
- Outbound webhook/integration actions must have SSRF defenses, hostname/URL allowlists as appropriate, request timeouts and response-size caps.
- Do not allow journey conditions to access raw secret values or execute arbitrary code.
- Enforce permission and validation checks for imports that update consent or suppression. Imported files must not be able to overwrite stronger opt-out state without the allowed explicit re-consent process.

---

## 10. UI and User Experience

## 10.1 Navigation

Suggested menu structure, adapted to the existing navigation system:

- Marketing
  - Campaigns
  - Segments / Audiences
  - Journeys
  - Email Templates (link to the existing template area where possible)
  - Forms (if included)
  - Reports / Analytics
  - Consent & Suppression (restricted to authorized roles)
  - Settings (restricted)

Do not add duplicate navigation entries for entities already managed in a shared Email/Template area.

## 10.2 Campaign list and detail

- Display status, channel, schedule, owner, audience/eligible count, sent/delivered results and last error.
- Provide saved filters for Draft, Scheduled, Running, Paused, Completed, Failed and campaigns needing attention.
- Campaign detail tabs/panels: Overview, Audience, Send definitions, Content, Recipients (permissions restricted), Activity/Log, Analytics and related CRM records.
- Use explicit confirmation for schedule/start/cancel where production messages are affected.
- Show test/preview state clearly so test sends cannot be mistaken for campaign delivery.

## 10.3 Segment builder

- Guided entity selection and criteria builder with field/operator/value validation.
- Explain included/excluded segments and why a record is removed.
- Show a privacy-aware estimate, duplicate count, missing email count, ineligible consent count, suppression count and final eligible count.
- Dynamic query execution must be asynchronous when potentially expensive and should have a clear timeout or progress/error state.
- Prevent users from storing a segment that relies on fields they cannot query.

## 10.4 Journey builder

- Use the repository's existing graph/diagram UI library if it exists and is approved; do not add a second diagram framework without justification.
- Nodes are typed, with a configuration panel and validation markers.
- Show a readable path for entry, wait, branch, action and exit. Expose node IDs and execution status to operators without making IDs the primary user concept.
- Validate graph on save and again on publish.
- Publish a new immutable version with an impact preview showing active enrollments and version behavior.
- Execution inspector: enrollment timeline, current node, next run, branch evaluations, skipped actions, retries and safe failure reasons.
- Support keyboard-accessible node configuration and a structured/list view alternative for accessibility.

## 10.5 Template editor and preview

- Integrate with the existing rich-text/template editor.
- Provide subject, preheader, body, unsubscribe/preference link validation, preview-as-contact, test send and plain-text fallback.
- Distinguish unsafe/unresolved placeholders from optional unresolved values.
- Provide clear warnings for missing footer, sender identity, empty audience or invalid destination link.

## 10.6 Analytics UX

- Give every metric an accessible definition/help label.
- Distinguish sends, unique recipients, delivered, clicks, click-through rate, conversions and influenced revenue.
- Offer filters for campaign, journey, date window, team, owner and segment subject to ACL.
- Make event timestamps/timezones clear.
- Explain that opens are approximate and that attribution depends on the selected model.

## 10.7 Accessibility and responsive behavior

- Follow the existing design system and accessibility rules.
- Forms and graph-node settings need labels, keyboard navigation, visible focus, error association and screen-reader status updates.
- Do not communicate campaign/journey status only with color.
- Ensure campaign detail, send status and suppression tools remain usable on narrower screens; the full graph editor may have a deliberate simplified mobile view.

---

## 11. Jobs, Scheduling, and Operational Resilience

## 11.1 Candidate jobs

Use the current job/queue infrastructure instead of adding a duplicate scheduler. Candidate jobs:

- `marketing.refresh-dynamic-segments`
- `marketing.prepare-send-audience`
- `marketing.dispatch-recipient-batches`
- `marketing.send-email-batch`
- `marketing.execute-due-journey-steps`
- `marketing.retry-transient-deliveries`
- `marketing.process-provider-events`
- `marketing.reconcile-provider-status` where supported
- `marketing.aggregate-campaign-metrics`
- `marketing.check-frequency-caps`
- `marketing.expire-public-tokens`
- `marketing.apply-retention-policy`
- `marketing.monitor-bounce-complaint-thresholds`

Names are suggestions; follow established job registration conventions.

## 11.2 Job requirements

- Use bounded batch sizes, queue concurrency limits and per-provider rate limits.
- Persist enough state to safely resume after worker restart.
- Enforce idempotency at the domain record level; queue-level deduplication alone is insufficient.
- Separate transient failures from permanent failures and expose a safe operator action for remediation.
- Use exponential backoff with jitter and a maximum retry budget.
- Add job correlation IDs and queue latency/processing metrics.
- Prevent retry storms and provider rate-limit violations.
- Support a global emergency pause for all marketing sends.
- Support campaign-level, sender-level and provider-level pause states.
- Set maximum journey execution time/step count per worker invocation so a large batch cannot starve unrelated jobs.
- On deploy/restart, due wait nodes and scheduled campaigns must be resumed/recovered without duplicate send.
- A send job must re-check campaign state and consent before provider submission.
- A retention job must have a dry-run/summary mode and must not perform destructive bulk cleanup without review.

## 11.3 Observability and alerting

Capture metrics such as:

- Eligible audience counts and segment refresh durations.
- Send queue depth and age, message acceptance/delivery latency, provider error rate and quota/rate-limit responses.
- Hard/soft bounce and complaint rates, unsubscribe rates and suppression growth.
- Journey active/waiting/failed enrollments, due-step lag, step duration, retry count and dead-letter count.
- Webhook signature failures, duplicate event ratio and processing lag.
- Form submissions, spam blocks, validation errors and duplicate rate.

Log structured, safe events. Do not log full HTML bodies, full recipient lists, raw tokens or credentials. Alert on stalled campaigns, repeated provider authorization failures, unusual complaint/bounce levels, growing queue lag and failed scheduled jobs.

---

## 12. Testing and Verification Strategy

All database rules in `AGENTS.MD` apply. No test is permitted to create another database as a default setup step.

## 12.1 Unit tests

At minimum:

- Segment criteria schema validation and safe query mapping.
- Recipient deduplication and include/exclude precedence.
- Consent and suppression decision matrix.
- Frequency cap computation and timezone edge cases.
- Campaign and send state transitions.
- Template variable resolution, escaping, missing-value fallback and HTML sanitization.
- Journey graph validation: cycles, invalid edges, disconnected nodes, unreachable exits and versioning.
- Journey branch conditions and deterministic enrollment rules.
- Idempotency key creation and duplicate event handling.
- Retry classification/backoff policy.
- Attribution calculations and non-additive metrics.
- Webhook signature verification and token expiration.

## 12.2 Integration tests

Using the existing configured primary database with uniquely identified test records:

- Campaign → send definition → audience snapshot → delivery record creation.
- Unsubscribe after queueing blocks sending at the final eligibility check.
- Global suppression wins over multiple included segments.
- The same contact in two included segments results in one recipient delivery per defined message slot.
- Provider accepted response and webhook retry do not double-count sent/delivered events.
- Hard bounce and complaint update suppression, and subsequent journey send is skipped.
- Journey enrollment is unique under concurrent event processing.
- Two workers cannot execute the same step concurrently.
- Delayed journey step survives application restart and resumes correctly.
- Publishing version 2 does not silently change version 1 enrollments.
- Form submission creates or links only authorized/allowed CRM records and captures the intended consent evidence.
- Portal preference updates go through the same consent service and cannot access another contact.
- API ACL works for campaign list, segment preview, recipient logs, aggregate reporting and configuration.

Use a fake provider that records requests in the test process or a controlled adapter. Do not send real email.

## 12.3 End-to-end tests

- Create a segment, preview it and explain the eligible count.
- Create a campaign and template, send a test message through the fake provider and inspect the test outcome.
- Validate and schedule a real campaign in a dry-run/non-delivery mode, then confirm recipient counts and blockers.
- Publish a journey, enroll a test contact, execute wait/branch/email-or-task steps, and verify the audit trace.
- Unsubscribe via public link and verify all queued marketing sends are blocked.
- Simulate provider delivered/bounce/click/complaint events and confirm campaign statistics.
- Verify Portal preference UI cannot see internal marketing history.
- Exercise global emergency pause.

## 12.4 Primary database safety for tests

- Inspect the test scripts and setup hooks before execution.
- Do not create test databases, test schemas, Docker database containers or per-test database copies.
- Do not reset tables, run broad cleanup SQL or seed demo data repeatedly.
- Prefix test-created CRM data with `AGENT_TEST_` or use a unique run marker.
- Use precise IDs for cleanup and only delete records created by the current test run.
- Disable external side effects. Never test with real recipients or provider credentials pointing to live marketing lists.
- If a test framework cannot safely run against the configured database, use a unit/fake-provider path and document the integration limitation instead of creating a database.

## 12.5 Quality gates

- Type checking and linting pass.
- Unit tests cover core state/eligibility/journey rules.
- Safe integration tests pass where database and app configuration permit.
- API/OpenAPI definitions are updated.
- Migrations have been reviewed and are additive/non-destructive.
- ACL and public endpoint abuse tests pass.
- Queue/idempotency/retry tests pass.
- User-visible errors are clear and do not reveal internals.
- Module can start when optional Sales, CustomerSuccess, ServiceDesk or Portal integrations are disabled, unless an explicitly declared required dependency is documented.

---

## 13. Settings and Administration

Add only settings that have an actual consumer and match the existing settings system.

Potential settings:

- Default sender/provider reference and eligible sending domains.
- Default timezone and campaign scheduling policy.
- Default send batch size and concurrency, constrained by global safety ceilings.
- Provider- or sender-level rate limits and quotas.
- Default frequency cap and per-person/per-channel caps.
- Consent policy by purpose/channel and whether double opt-in is required.
- Public unsubscribe/preference token lifetime and public endpoint rate limits.
- Open/click tracking defaults and privacy controls.
- Default retention periods for event details and payloads.
- Bounce/complaint thresholds that trigger automatic pausing.
- Global emergency stop and a safe operator runbook.
- Allowed public form domains/origins and approved bot controls.
- Attribution model/default attribution window.

Security requirements:

- Restrict provider credentials and global sending controls to administrators/authorized operators.
- Store secrets using the existing secrets/config mechanism.
- Do not let a campaign author exceed global rate/volume limits.
- Require explicit acknowledgement/confirmation for the global emergency stop reset when appropriate.
- Audit sensitive settings changes with actor, timestamp, previous/new non-secret values and reason.

---

## 14. Documentation and Operational Runbooks

Add/update these documents as the module is implemented:

- `docs/compatibility/marketing-automation.md` — reference behavior and project-specific additions.
- `docs/implementation/marketing-automation-audit.md` — audit and module boundary decisions.
- `docs/marketing-automation/campaign-lifecycle.md` — campaign/send states and allowed transitions.
- `docs/marketing-automation/consent-and-suppression.md` — eligibility, unsubscribe, re-consent, complaint and hard-bounce rules.
- `docs/marketing-automation/journey-runtime.md` — graph schema, published versions, enrollment, waits, execution and recovery.
- `docs/marketing-automation/provider-adapters.md` — provider capabilities, secrets, limits, webhook verification and test adapter.
- `docs/marketing-automation/metrics.md` — metric names, denominators, event semantics and attribution model.
- `docs/marketing-automation/security-and-privacy.md` — public endpoints, tracking, retention and privacy review points.
- `docs/runbooks/marketing-send-operations.md` — test send, review, scheduling, pause, cancel, emergency stop and troubleshooting.
- `docs/runbooks/marketing-provider-incidents.md` — credential failures, bounce/complaint spikes, webhook failures and provider outage response.

Runbooks must explain how to stop all sends safely and how to resume them without duplicate messages.

---

## 15. Implementation Roadmap — Phase 19-MA

Implement in the order below. Each sub-phase needs its own review and acceptance check. Do not begin with the visual journey builder before the underlying audience, consent, delivery and execution contracts are stable.

### Phase 19-MA.0 — Repository Audit and Feature Contract

**Tasks**

1. Read `PLAN.md`, `AGENTS.MD` and current module conventions.
2. Inventory shared Email, EmailTemplate, Campaign, TargetList, Contact, Lead, Account, Opportunity, consent/preference, Workflow/BPM, job, queue, event bus, ACL, report and Portal components.
3. Determine whether an inbound/outbound provider layer already exists and identify its guarantees, rate-limits, event handling and tests.
4. Identify existing CRM campaign analytics and tracking functions to reuse.
5. Write `docs/implementation/marketing-automation-audit.md` and `docs/compatibility/marketing-automation.md` baseline.
6. Specify module dependency declarations and optional integrations.
7. Decide what is new and what must be extended. Do not add schema yet.

**Acceptance criteria**

- A named owner exists for Campaign, Segment/TargetList, consent, EmailTemplate, delivery, event ingestion and journey runtime.
- Missing infrastructure and high-risk decisions are documented.
- The audit confirms no duplicate database, email engine or workflow engine will be created.
- A sub-phase implementation order is approved before coding proceeds.

### Phase 19-MA.1 — Module Scaffold, Registration, Permissions, and Navigation

**Tasks**

1. Register `MarketingAutomation` using the current module system and key `marketing-automation` unless repository convention dictates another key.
2. Add dependency metadata only for actual required platform capabilities.
3. Add localized labels using project-owned wording; do not copy upstream translations.
4. Register baseline ACL scopes/actions and admin settings entry points.
5. Add navigation containers without duplicating existing Campaign, Target List or Email Template navigation entries.
6. Add health/diagnostic hooks for module readiness and optional integrations.

**Acceptance criteria**

- Module loads and can be enabled/disabled using established conventions.
- No `Ua` prefix appears in module/package/class names added by this phase.
- Missing optional integrations do not crash application startup.
- ACL scopes appear only for implemented resources/actions.

### Phase 19-MA.2 — Domain Contracts, Enums, Settings, and Migration Baseline

**Tasks**

1. Define campaign/send/journey/enrollment/delivery/consent/event status enums and transition tables.
2. Define DTOs, domain types, event schemas and service interfaces.
3. Define provider adapter contract and fake provider interface.
4. Define consent/suppression decision matrix in executable code and tests.
5. Add additive migrations only for confirmed missing tables/columns.
6. Define indexes, foreign keys, data retention metadata and audit fields.

**Acceptance criteria**

- Domain states and transition rules are documented and unit-tested.
- No duplicate canonical entities are introduced.
- Migration review confirms no destructive operations.
- Provider adapter can be faked without network calls.

### Phase 19-MA.3 — Campaign Lifecycle and Validation

**Tasks**

1. Reuse or extend Campaign records.
2. Implement campaign CRUD through the platform entity conventions.
3. Implement create/update/archive/duplicate-as-draft operations.
4. Implement campaign status transition commands.
5. Add campaign validation report and audit history.
6. Add campaign list/detail API and metadata UI.

**Acceptance criteria**

- Illegal transitions are rejected server-side.
- Duplicating a campaign does not copy delivery history or active enrollments.
- Scheduling cannot proceed when required sender/content/audience/policy checks fail.
- Record and field ACL apply to all API paths.

### Phase 19-MA.4 — Audience Segments, Inclusion/Exclusion, and Preview

**Tasks**

1. Reuse or extend TargetList/segment capability.
2. Implement static membership management if not already available.
3. Implement dynamic criteria schema and safe criteria-to-query mapping.
4. Implement include/exclude composition, canonical-record deduplication and normalized email deduplication.
5. Implement preview counts and explainable eligibility categories.
6. Add snapshot generation for a send definition.

**Acceptance criteria**

- No user-provided SQL is executed.
- Exclusion always wins over inclusion.
- A send snapshot is stable even if the segment changes later.
- ACL does not leak record data through sample results or unauthorized query fields.
- Duplicate recipient selection behavior is covered by tests.

### Phase 19-MA.5 — Consent, Preferences, Suppression, and Public Unsubscribe

**Tasks**

1. Inventory existing opt-out fields and consent data before making schema changes.
2. Implement centralized eligibility and consent services.
3. Support channel/purpose preference state and consent event audit.
4. Implement global and scoped suppression with hard-bounce/complaint linkage.
5. Implement signed/opaque public token generation, token hash storage, expiry and scope.
6. Implement idempotent unsubscribe, preference page and optional opt-in confirmation.
7. Add suppression checks to every sending entry point and manual retry path.

**Acceptance criteria**

- Global opt-out always overrides segment/journey membership.
- A post-queue unsubscribe prevents a not-yet-submitted message from being sent.
- Public endpoints do not leak contact existence or permit token enumeration.
- Re-consent requires explicit, auditable affirmative action.
- Consent policy is documented and does not make unsupported legal-compliance claims.

### Phase 19-MA.6 — Email Template Integration and Render Preview

**Tasks**

1. Reuse the current template renderer and editor.
2. Define approved marketing placeholders and recipient-context construction.
3. Add output escaping, HTML sanitization and link validation.
4. Implement contact preview, unresolved-placeholder reporting, fallback values and plain-text generation.
5. Implement immutable template revision/content hashing where missing.
6. Validate sender, reply-to, footer, preference and unsubscribe links.

**Acceptance criteria**

- Unsafe HTML and URLs are rejected or safely sanitized.
- Unreadable fields cannot be extracted via templates.
- Missing optional fields use documented fallbacks.
- A sent message can be associated with the content revision/hash actually used.

### Phase 19-MA.7 — Provider Adapter and Safe Test Send

**Tasks**

1. Define a provider-neutral adapter that wraps the existing outbound email service or the existing vendor integration.
2. Add fake provider and provider capability metadata.
3. Implement explicit test-send command, recipient allowlist/confirmation and test markers.
4. Add provider identity/credential configuration using existing secrets management.
5. Add rate-limit/concurrency interfaces and normalized provider errors.
6. Document sandbox versus production configuration.

**Acceptance criteria**

- Unit/E2E tests cannot accidentally use a live provider.
- Test sends are not counted as campaign sends or journey outcomes.
- Credentials are never returned in APIs/logs.
- Provider errors are classified into retryable, permanent and unknown-submission states.

### Phase 19-MA.8 — Send Definition, Audience Snapshot, and Dry Run

**Tasks**

1. Implement a send definition attached to a campaign or compatible canonical equivalent.
2. Create a durable audience snapshot and recipient delivery records.
3. Calculate eligible recipients and categorized exclusions.
4. Implement validation hash, preview report and send approval metadata.
5. Invalidate approval when audience/content/sender/purpose settings materially change.
6. Implement schedule/pause/cancel state transitions without sending real mail during tests.

**Acceptance criteria**

- Preview shows the reasons each recipient category is excluded.
- One recipient has one delivery record per intended send slot.
- No campaign starts from draft state or without explicit authorized action.
- Changing content or target audience invalidates stale approval.

### Phase 19-MA.9 — Queue-Based Delivery, Throttling, Retry, and Recovery

**Tasks**

1. Enqueue bounded recipient chunks through existing queue/job services.
2. Persist per-recipient delivery state and provider submission status.
3. Implement atomic worker claims and a final consent/suppression/frequency-cap check.
4. Add per-provider/sender rate limiting, quotas and pause conditions.
5. Add bounded retry/backoff, permanent failure handling and operator-visible dead letters.
6. Implement emergency stop, campaign pause/cancel and restart recovery.
7. Add operational metrics and safe structured logs.

**Acceptance criteria**

- Worker restarts do not produce duplicate submissions under normal provider idempotency guarantees.
- A known global unsubscribe blocks the final send step.
- Provider limits are observed and retry loops are bounded.
- Operators can see why a recipient failed without revealing secrets.

### Phase 19-MA.10 — Provider Webhooks, Event Normalization, and Suppression Feedback

**Tasks**

1. Implement provider webhook signature verification and replay protection.
2. Normalize event types and provider IDs into the internal event model.
3. Implement event inbox/deduplication and out-of-order transition logic.
4. Link events to delivery, send, campaign and journey where safe.
5. Update suppression on valid hard bounce/complaint/unsubscribe events.
6. Add optional click redirects/open pixels according to policy and existing tracking conventions.

**Acceptance criteria**

- Duplicate webhook events do not duplicate counters or actions.
- Invalid signatures are rejected and safely logged.
- Hard bounce and complaint policy blocks subsequent marketing sends.
- Open tracking is explicitly marked approximate and can be disabled.
- Redirect endpoints cannot be abused as open redirects.

### Phase 19-MA.11 — Campaign Log, Statistics, and Initial Reports

**Tasks**

1. Implement campaign event log with filters and permission-aware recipient drill-down.
2. Calculate accepted/sent, delivered, bounced, complaint, unsubscribe, clicks, leads created and goal/conversion metrics where events exist.
3. Add campaign overview charts and saved filters.
4. Add background aggregate processing for large event volumes.
5. Document event counting rules and denominators.

**Acceptance criteria**

- Event retries do not increase unique recipient counts.
- Statistics are consistent with underlying normalized events and show an `as of` timestamp where asynchronous.
- Inaccessible recipient records are never revealed via reports.
- Clicks, opens and conversions are not conflated.

### Phase 19-MA.12 — Journey Graph Schema, Validation, and Version Publishing

**Tasks**

1. Define versioned graph schema and supported node type registry.
2. Implement graph validation for entries, reachable nodes, output ports, conditions, cycles and terminal paths.
3. Implement draft editing and immutable published versions.
4. Add publish impact preview and explicit versioning behavior for active enrollments.
5. Implement simple editor/list-view UI using existing graph library if available.
6. Add journey definition API and optimistic concurrency protection.

**Acceptance criteria**

- Invalid/unbounded graphs cannot be published.
- Published graph versions cannot be mutated in place.
- Existing enrollments remain pinned to their version unless explicitly migrated.
- Node types and conditions are allowlisted and never execute arbitrary code.

### Phase 19-MA.13 — Journey Enrollment, Waits, Conditions, and Runtime Engine

**Tasks**

1. Implement triggers for manual entry and a minimal supported set of CRM/form events.
2. Implement idempotent enrollment and re-entry policy.
3. Implement atomic step claim, durable wait node and next-run scheduling.
4. Implement condition/branch evaluation using a safe, bounded expression interface.
5. Implement end/exit/goal checks, pause/suspend/resume/exit commands and audit traces.
6. Implement crash recovery, retry budgets and per-step execution history.

**Acceptance criteria**

- Concurrent duplicate triggers create no duplicate enrollments.
- A worker restart preserves wait state and next-run times.
- Two workers cannot execute the same action instance concurrently.
- Global opt-out and suppression exit/block marketing actions regardless of journey graph.
- Journey trace explains each branch, delay, action and skip/failure.

### Phase 19-MA.14 — Journey Actions and CRM Event Integration

**Tasks**

1. Implement send-email node using the same delivery pipeline as campaigns.
2. Implement safe wait/condition/goal nodes and field updates limited to allowlisted values/actions.
3. Add Activity/Task creation and internal notification through existing platform services.
4. Subscribe to whitelisted CRM domain events through the event bus.
5. Add correlation, causation and loop guards against recursive event chains.
6. Add optional adapters for Sales, CustomerSuccess and ServiceDesk only when their event contracts exist.

**Acceptance criteria**

- Journey email follows identical consent, provider limit and suppression rules.
- A journey cannot bypass ACL to update CRM records.
- Optional integrations can be disabled independently.
- Event loops and repeated trigger cascades are bounded and observable.

### Phase 19-MA.15 — Public Forms and Lead Capture

**Tasks**

1. Confirm whether web-to-lead/form infrastructure already exists.
2. If missing and required for MVP, implement a constrained form schema and public submission endpoint.
3. Add source/campaign/UTM attribution and versioned consent capture.
4. Add rate limiting, input validation, anti-abuse protection and deduplication.
5. Integrate forms with Lead creation and optional journey enrollment using the consent gate.
6. Add admin preview and submission diagnostics.

**Acceptance criteria**

- Public requests cannot choose arbitrary entity/field targets.
- Promotional journey enrollment only occurs under the consent/purpose policy.
- Duplicate submissions do not create uncontrolled duplicate leads.
- Public responses do not disclose CRM record existence or internal errors.

### Phase 19-MA.16 — Sales, CustomerSuccess, ServiceDesk, and Portal Integration

**Tasks**

1. Document supported events/commands per optional module.
2. Integrate Sales outcomes with campaign conversion and attribution without duplicating financial data.
3. Integrate CustomerSuccess lifecycle and health events only when explicitly configured.
4. Integrate selected ServiceDesk events for approved, non-promotional use cases; keep transactional service notices separate from marketing permission.
5. Extend the existing Portal preference center and form surfaces where appropriate.
6. Add contract tests and module-disabled startup tests.

**Acceptance criteria**

- No optional module creates a hard dependency unintentionally.
- Cross-module events are versioned, idempotent and ACL/privacy aware.
- Customer support activity cannot silently enroll contacts into promotional messaging.
- Portal users can affect only their own allowed preferences.

### Phase 19-MA.17 — Attribution, Funnel Analytics, and Optimization

**Tasks**

1. Implement documented first-touch/last-touch and/or campaign-influenced attribution as selected in audit.
2. Add lead/opportunity outcome links and optional revenue views from Sales.
3. Implement journey funnel, stage drop-off, goal/time-to-conversion reports and segment analysis.
4. Add metrics aggregate jobs and a defined freshness window.
5. Add A/B testing only if MVP delivery, consent and event normalization are stable.

**Acceptance criteria**

- Reports state model, time window and denominator.
- Influenced revenue is not misleadingly added as fully incremental revenue across every campaign.
- Aggregates can be reconciled with event data in bounded checks.
- A/B winner selection is not automatic without explicit configuration and sufficient sample conditions.

### Phase 19-MA.18 — Administration, Retention, and Operational Runbooks

**Tasks**

1. Complete provider sender settings, quotas, global emergency stop and safe reset flow.
2. Implement privacy-aware retention jobs with dry-run summaries.
3. Complete bounce/complaint thresholds, provider health diagnostics and stuck-job views.
4. Document backup/recovery considerations for journey state, tokens, event history and content revisions.
5. Add admin views for consent settings, suppression reasons and delivery errors.
6. Write operating runbooks for launch, pausing, provider incidents and safe resume.

**Acceptance criteria**

- Authorized operators can stop all marketing sends quickly.
- Retention behavior is documented and does not silently erase needed suppression safeguards.
- Secrets are stored through approved configuration and never exposed in settings API responses.
- Operational issues have actionable diagnosis and recovery guidance.

### Phase 19-MA.19 — Security, Performance, Reliability, and Compatibility Hardening

**Tasks**

1. Audit all API endpoints for ACL, authorization bypass, parameter validation and mass-assignment.
2. Perform abuse testing for public unsubscribe/form/click/open/webhook endpoints.
3. Review journey graph validation, expression evaluation, URL fetching and SSRF risks.
4. Review idempotency, out-of-order events, concurrency, retry and shutdown/restart behavior.
5. Optimize heavy segment queries, large recipient batches, event aggregates and journey-due scans with measured indexes.
6. Run safe migration/integration tests against the configured primary database.
7. Complete compatibility note, OpenAPI docs, operational docs and release checklist.

**Acceptance criteria**

- Type checks/lint and required test suites pass, or limitations are explicitly documented.
- No test infrastructure creates new databases, schemas or database containers.
- Production sends are disabled in automated tests by default.
- Critical consent, suppression, idempotency, ACL and webhook-verification tests pass.
- No unresolved critical/high-severity security finding remains without an explicit risk acceptance.
- The module can be released behind a feature flag or disabled state if the project supports it.

---

## 16. Definition of Done

MarketingAutomation is not complete until all of the following are true:

- [x] Module key, class names, navigation and documentation use `MarketingAutomation` / `marketing-automation`; no `Ua` prefix was added. — `MARKETING_AUTOMATION_MODULE` (`marketing-automation-module.ts`), `@Controller("api/v1/MarketingAutomation")`, settings row `marketingAutomation`.
- [x] The repository audit confirms canonical ownership and no duplicate Campaign, TargetList, Email, Template, Consent, Job or Workflow system was created unnecessarily. — audit §2–§3; the module owns no mail transport, queue, scheduler or expression language.
- [x] Campaign lifecycle, recipient eligibility and send preview are validated on the server. — `marketing-automation.test.ts` (26), `marketing-automation-send.test.ts` (15).
- [x] Audience criteria are safe, ACL-aware, explainable and stable for a specific send snapshot. — `marketing-automation-audience.test.ts` (16), `…-audience-domain.test.ts` (22).
- [x] Consent, opt-out, suppression, hard bounce, complaint and unknown-consent policies are centralized and enforced before every marketing send. — `marketing-automation-consent.test.ts` (16), `…-delivery.test.ts` (global unsubscribe blocks the final step), `…-events.test.ts` (bounce/complaint/unsubscribe feedback).
- [x] Unsubscribe and preference endpoints are secure, idempotent, rate-limited and do not leak whether arbitrary people exist in the CRM. — `marketing-automation-consent.test.ts`; one generic failure message, hashed tokens, 25-attempt budget. Rate limiting is the platform's global limiter (see §17 caveat).
- [x] Email templates render safely, are previewable and retain an immutable revision/content hash for actual sends as required. — `marketing-automation-template.test.ts` (8), `…-template-render.test.ts` (24), migration 040.
- [x] Sending uses the shared provider interface, bounded batch/rate limits, durable delivery state, retries and no-duplicate safeguards. — `marketing-automation-delivery.test.ts` (6), `marketing.deliveryBatch` worker job, `marketing_recipient_deliveries`.
- [x] Provider webhooks are verified, deduplicated and safe under retries/out-of-order events. — `marketing-automation-events.test.ts` (21): signature, replay window, dedupe, terminal-state protection, fail-closed secret.
- [x] Journey graph validation, immutable published versions, idempotent enrollment, durable waits, safe conditions and execution traces are complete for the supported node set. — `marketing-automation-journey.test.ts` (7), `…-journey-runtime.test.ts` (6: racing triggers, lease claim, wait, completion, suppression exit).
- [x] Optional integrations with Portal, Sales, CustomerSuccess and ServiceDesk use explicit contracts and do not silently create hard dependencies. — `OPTIONAL_INTEGRATIONS` detected by metadata marker/table; `GET …/action/health` reports each as `available`/`unavailable`; no module imports another.
- [x] Reporting defines metrics and denominators, distinguishes delivery/engagement/conversion and applies ACL to drill-downs. — `docs/marketing-automation/metrics.md`; `…/campaign/:id/{stats,log,attribution,funnel}` behind campaign record ACL.
- [x] Public forms, if included, have server-side schema validation, anti-abuse controls, dedupe and explicit consent handling. — `marketing-form.service.ts` + `…-events.test.ts` (fixed shape, honeypot, per-IP limit, idempotency key, address dedupe, `{accepted:true}` for every outcome).
- [x] Migrations are version-controlled, reviewed and additive unless destructive changes receive explicit task-specific approval. — 037–043, `CREATE … IF NOT EXISTS` only; no existing column altered or dropped.
- [x] Tests use the existing configured database where database integration is needed and do not create test databases, schemas or containers. — every API suite boots `bootApi()` against `DATABASE_URL`.
- [x] Automated tests use fake/sandbox providers and do not send actual marketing messages. — `ScriptedLiveProvider` in `…-delivery.test.ts`; `MAIL_TRANSPORT` is never live in a test.
- [x] `AGENTS.MD`, OpenAPI, compatibility notes and operational runbooks are followed/updated as applicable. — OpenAPI from the running app (`/docs`, `/api/v1/OpenApi`, tag `marketing-automation`); compatibility matrix refreshed to MA.19; both runbooks written.
- [x] The final implementation report lists changed areas, tests run, migration effects, feature flags/settings and known limitations. — `docs/implementation/marketing-automation-completion-report.md` §1–§8.

---

## 17. Release Checklist

### Functional

- [x] Campaign and segment CRUD/permissions.
- [x] Audience preview and recipient deduplication.
- [x] Consent/suppression gate before send.
- [x] Content preview and explicit test send.
- [x] Schedule/pause/cancel and durable recipient states.
- [x] Provider event ingestion and deduplication.
- [x] Journey publish/version/enroll/wait/branch/exit and recovery.
- [x] Reporting and operational error visibility.
- [x] Optional Portal/forms and CRM integrations verified.

### Security and privacy

- [x] Public token entropy/expiry/scope reviewed. — 256-bit token, only the digest stored, per-scope TTL, new link revokes the old.
- [x] Unsubscribe is idempotent and not triggered by link preview alone. — GET renders, POST acts; `markUsed` makes a replay a success without a second history row.
- [x] Webhook signatures and replay handling verified. — `marketing-automation-events.test.ts`: unsigned, forged, stale, unconfigured secret, duplicate id.
- [x] Public forms and tracking endpoints rate-limited. — **Caveat:** the form has a per-IP limiter (10/min, in-process); the other public routes rely on the platform's global `RATE_LIMIT_MAX`. A deployment exposing them to the internet must add a proxy/WAF limit (see `security-and-privacy.md` §6).
- [x] HTML sanitization, placeholder allowlists and redirect URL validation tested. — `…-template-render.test.ts`; `public/click` is same-origin only and refuses `//`, `/\` and third-party origins.
- [x] No secret or unnecessary personal data in logs. — no body/recipient/token/credential logging; webhook payloads redacted before storage.
- [ ] Consent, retention, tracking and data-subject processes reviewed for the deployment's jurisdictions. — **deployment action, not code.** The controls exist (`docs/marketing-automation/consent-and-suppression.md`, `security-and-privacy.md` §4); the review and any jurisdiction-specific policy are the operator's.

### Operations

- [ ] Sender/provider verified. — **deployment action:** `MAIL_TRANSPORT`, `provider.key` and a successful allowlisted test send.
- [x] Safe sending limits and emergency stop configured. — `delivery.chunkSize`/`maxAttempts`/`staleClaimMinutes`/`autoPauseAfterAuthFailures`, `provider.limits`, `safety.globalSendPaused`.
- [ ] Alerts for provider errors, high bounce/complaint levels and stalled queues configured. — **deployment action:** `GET …/action/diagnostics` exposes the signals (`deadLetters`, `stuckSending`, `deliveryStates`); wiring them to the deployment's alerting is not part of the code.
- [ ] Backup/restore and worker restart behavior tested where the environment permits. — **deployment action.** Restart recovery is implemented and tested (`staleClaimMinutes`, lease claim), but a restore drill was not run here.
- [x] Runbooks published and owners assigned. — `docs/runbooks/marketing-send-operations.md`, `docs/runbooks/marketing-provider-incidents.md`.
- [x] Production sending remains disabled until a human operator verifies settings and target audience. — defaults: `provider.key = ""`, `MAIL_TRANSPORT = none`, `MARKETING_WEBHOOK_SECRET = ""` (fail closed).

---

## 18. Final Instructions to the Coding Agent

Start with **Phase 19-MA.0 — Repository Audit and Feature Contract** only.

Do not immediately build the visual journey editor. First determine what Campaign, Target List, Email, EmailTemplate, Consent, provider, job queue, workflow, event, form, report and Portal capabilities already exist. The core architecture should be settled before the implementation begins.

Then proceed in the roadmap order. Before each sub-phase, state the files/services to inspect, intended changes, migration impact and targeted verification. After each sub-phase, report:

1. What was implemented.
2. Which existing shared capabilities were reused.
3. Which migrations were added and whether they were applied.
4. Which tests/checks were run and their actual results.
5. Any remaining limitations or follow-up work.

Never create another database to satisfy a test runner. Never send production marketing email from a test. Most importantly, never allow campaigns, manual actions, retries, journey nodes or cross-module automations to bypass consent, suppression, provider safety limits or server-side ACL.
