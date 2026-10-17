# Phase 19 — Service Desk Module (`ServiceDesk`)

> **Status:** Planned  
> **Parent roadmap:** `PLAN.md` — Phase 19: Advanced Domains  
> **Module name:** `ServiceDesk`  
> **Backend module class:** `ServiceDeskModule`  
> **Frontend route/slug:** `service-desk`  
> **Naming rule:** Do not add a `Ua` prefix to this module or to its classes, package names, event names, configuration keys, migration names, or documentation identifiers. Use the repository's established casing and path conventions while preserving the module name `ServiceDesk`.  
> **Target runtime:** NestJS / TypeScript backend and the existing React SPA  
> **Database:** Existing PostgreSQL database and the repository's established SQL persistence layer (Kysely unless the repository has deliberately adopted another implementation)  
> **Implementation rule:** Reuse platform and domain capabilities already implemented in Phases 0–18, plus the completed `Projects`, `Sales`, and `CustomerSuccess` modules. Audit the actual repository before assuming a dependency exists.  
> **Reference baseline:** EspoCRM Case Management, Email-to-Case, Knowledge Base, Portal, ACL, Stream, Jobs, and Workflow documentation; project-specific service-operations enhancements are identified separately below.

---

## 0. Instructions for the Coding Agent

Read these files before implementation:

1. `AGENTS.MD`
2. `PLAN.md`
3. `PLAN_Phase_19_ServiceDesk.md`
4. `PLAN_Phase_19_Projects.md`
5. `PLAN_Phase_19_Sales.md`
6. `PLAN_Phase_19_Customer_Success.md`
7. Existing API, module, metadata, portal, email, activity, attachment, workflow, jobs, notification, reporting, and migration documentation in the repository.

This plan describes the desired behavior. It does **not** prove that a dependency is already implemented. Start with **Phase 19-SD.0 only**. Inspect the actual codebase, migration history, metadata registry, entity model, mail adapters, portal implementation, test scripts, module manifests, and all database-backed test setup before progressing.

### 0.1 Non-negotiable implementation rules

- Implement `ServiceDesk` as a clean-room TypeScript/NestJS domain module. Use public documentation as a behavioral reference; do not copy or mechanically translate upstream PHP code, frontend assets, icons, translations, or branding.
- Use `ServiceDesk` / `ServiceDeskModule` / `service-desk` naming according to each layer's naming convention. **Do not introduce the `Ua` prefix.**
- Reuse the existing CRM Kernel, Entity Engine, metadata, ACL, record and field permissions, audit/history, Stream, Attachments, Activities, Email, Notifications, Jobs, Search, Workflow/BPM, Reports, Portal, and UI primitives where they already exist.
- Do not recreate Accounts, Contacts, Leads, Users, Teams, Roles, Activities, Attachments, generic Stream, generic Knowledge Base, portal authentication, mail transport, or dashboard infrastructure inside this module. Extend an existing capability when it is the correct domain boundary; otherwise document the missing dependency and use the smallest compatible implementation.
- Audit existing entity definitions before adding a Case entity. If `Case` already exists, extend its metadata and domain behavior when safe. If no Case entity exists, create one using the repository's metadata-driven entity conventions. If another existing entity makes the name ambiguous, record the decision and use exactly one canonical support-case entity; never create parallel `Case` and `ServiceDeskCase` entities unintentionally.
- Follow the repository's actual API response envelope, validation patterns, transactions, event system, logging, frontend route conventions, package manager, and SQL query patterns.
- Preserve the modular monolith. Do not introduce microservices, a second ORM, a parallel metadata system, or a new queue provider solely for ServiceDesk.
- **Database safety is mandatory.** Follow `AGENTS.MD`. Do not create a test database, shadow database, test schema, temporary database, per-agent database, or per-run database. Use the existing configured primary project database for safe, targeted checks when appropriate.
- Never reset, truncate, drop, or replace the database. Do not delete or modify real customer records during tests. Test-created records must be clearly marked with `AGENT_TEST_` or a unique run marker and cleaned up only by exact identifiers created by the current run.
- Do not send real emails, portal messages, surveys, webhooks, or customer notifications from tests. Stub outbound integrations or use explicit fake transport configuration.
- Review migration SQL before applying it. Prefer additive, reversible-compatible migrations. Do not run a destructive migration without explicit task-specific approval.
- Do not report a sub-phase complete unless its acceptance criteria and actual verification results are documented.

---

## 1. Purpose and Product Outcome

Implement a first-class **Service Desk** module for customer-support and service-request operations. It gives support agents and managers a unified place to receive, classify, assign, investigate, respond to, escalate, resolve, and report on customer cases. Customers should be able to create and track their own cases through authorized channels without seeing internal notes, private attachments, other customers' records, or internal operational information.

The module must be useful as a standalone support workflow inside the CRM and must integrate with existing CRM records and other modules through stable contracts. It must not require the Projects, Sales, or CustomerSuccess modules to be enabled for basic case management.

### 1.1 Primary outcomes

At completion, authorized internal users can:

1. Create, read, update, assign, prioritize, categorize, search, filter, and close customer cases.
2. Track the complete case lifecycle, including reopening and escalation, with immutable transition history.
3. Organize work into queues and teams with explicit assignment and routing rules.
4. Communicate with customers using a case conversation timeline that distinguishes customer-visible messages from internal-only notes.
5. Associate cases with Accounts, Contacts, Leads where appropriate, and relevant CRM activities or commercial/customer-success records.
6. Ingest support requests through manual creation, authenticated APIs, email-to-case, customer portal, and an abuse-protected web form where configured.
7. Calculate first-response, next-response, and resolution targets using configurable service-level policies and business calendars.
8. Receive actionable notifications before and after SLA deadlines and record breaches reliably.
9. Search and relate knowledge articles to cases and expose only published, portal-authorized content to customers.
10. Give portal users secure access to cases belonging to their permitted Contact/Account scope, with safe customer-facing updates and attachments.
11. Collect optional customer satisfaction feedback after resolution and analyze service performance with dashboards and reports.
12. Reuse the platform's ACL, metadata, audit, jobs, notifications, search, workflow/BPM, attachments, portal, and reporting capabilities wherever available.

### 1.2 Product principles

- **One canonical case:** all channels converge on the same case entity and lifecycle.
- **Private-by-default internals:** internal notes, internal attachments, routing metadata, and agent-only fields are never exposed to portal users or outbound customer messages.
- **Explicit transitions:** status, resolution, reopening, merge, and close operations use validated domain commands rather than arbitrary field updates when invariants are involved.
- **SLA transparency:** targets, pauses, due times, breach state, and policy version must be inspectable and auditable.
- **Safe automation:** jobs and inbound processing are idempotent; retries must not create duplicate cases, messages, notifications, or surveys.
- **Least privilege:** all channels apply record ACL and field-level security server-side; frontend visibility is not a security control.
- **Reuse before build:** do not create a separate implementation of a platform capability just because ServiceDesk needs it.
- **No hidden assumptions:** optional module dependencies are runtime-checked and degraded gracefully when unavailable.

### 1.3 Compatibility and scope boundary

EspoCRM documents standard Case Management capabilities including manual/API/email/portal/workflow case creation, a case Stream with internal posts, email threading, Knowledge Base association, customer-portal access rules, and collaborator/access behavior. This is the main functional reference for baseline behavior.

This project's ServiceDesk plan adds operational capabilities such as configurable queues, multi-target SLAs, business-hour calendars, breach/escalation automation, CSAT surveys, and service-operations dashboards. Those are **project requirements**, not claims that every feature exists in EspoCRM core.

Record important compatibility decisions and deviations in `docs/compatibility/service-desk.md`.

---

## 2. Reference Baseline

Use the following public documentation as the functional and architecture reference:

- Case Management: https://docs.espocrm.com/user-guide/case-management/
- Email administration and Email-to-Case: https://docs.espocrm.com/administration/emails/
- Knowledge Base: https://docs.espocrm.com/user-guide/knowledge-base/
- Portal and Portal Roles: https://docs.espocrm.com/administration/portal/
- Roles and ACL: https://docs.espocrm.com/administration/roles-management/
- Workflows: https://docs.espocrm.com/administration/workflows/
- Modules: https://docs.espocrm.com/development/modules/
- Metadata: https://docs.espocrm.com/development/metadata/
- API: https://docs.espocrm.com/development/api/
- Hooks: https://docs.espocrm.com/development/hooks/
- Scheduled Jobs: https://docs.espocrm.com/development/scheduled-job/
- Attachments: https://docs.espocrm.com/development/attachments/
- Working-time calendar: https://docs.espocrm.com/user-guide/working-time-calendar/

### 2.1 Compatibility policy

- Match documented user-visible behavior where it fits the project architecture.
- Use the new CRM's metadata, API, database, module, event, ACL, and frontend conventions even when the implementation differs internally.
- Do not copy upstream database schemas or PHP class names.
- Distinguish **baseline compatibility** from **ServiceDesk-specific enhancements** in docs and tests.
- Do not claim full EspoCRM source compatibility or database compatibility.
- Any deliberate behavior change must be documented, covered by tests, and reflected in OpenAPI or UI documentation.

---

## 3. Scope and Non-Goals

### 3.1 In scope

#### Case lifecycle and records

- Canonical Case entity and case-number generation.
- Subject, description, status, priority, category/type, source/channel, severity, requester, related Account/Contact, owner/assignee, team, queue, tags, due dates, solution, resolution code, and audit trail.
- State-transition rules, reopen rules, closure validation, duplicate detection, merge workflow, and cancellation where allowed.
- Case links to emails, calls, meetings, notes, attachments, Accounts, Contacts, Leads, and permitted domain-module records.

#### Team operations

- Queues/inboxes, members, supported categories, default assignment, team assignment, manual assignment, round-robin assignment, and least-busy assignment.
- Explicit configuration for fairness, eligibility, capacity bounds, and fallback behavior.
- Agent views such as unassigned, mine, my queues, waiting for customer, breached, escalated, and recently updated.

#### Conversation and communications

- Timeline of customer-visible replies and internal-only notes.
- Email-to-case ingestion and outbound email replies tied to the Case.
- Email threading, loop prevention, de-duplication, attachment policy, and safe handling of malformed or hostile input.
- Portal responses and secure case attachment download.
- Optional web-to-case submission with rate limits and anti-abuse protections.

#### Service-level management

- SLA policies and policy conditions.
- First-response, next-response, and resolution targets.
- Business hours, time zones, holidays, pause rules, warning thresholds, and escalation rules.
- SLA clocks/snapshots that preserve which policy/version applied to a case.
- Breach records and operational reporting.

#### Knowledge and self-service

- Reuse existing Knowledge Base if implemented.
- If Knowledge Base is not implemented, add the minimum necessary article/category capabilities only after confirming the project does not already have a reusable Knowledge Base module.
- Draft, review, published, and expired article lifecycle; categories; versioning where supported; related cases; search; portal visibility.
- Suggested articles on case create/view surfaces, without exposing restricted content.

#### Customer experience and analytics

- Portal case creation and tracking with strict account/contact scoping.
- Customer satisfaction survey configuration and response tracking.
- Dashboards, filters, saved views, reports, service-volume metrics, response/resolution metrics, SLA achievement, backlog aging, reassignment, and CSAT.

#### Administration and automation

- ServiceDesk settings, case numbering, statuses, priorities, categories, queues, routing, SLA policies, working schedules, escalation rules, templates, and safe retention options.
- Notifications and workflow/BPM integration through existing platform mechanisms.
- Job observability, audit history, OpenAPI and operational documentation.

### 3.2 Explicit non-goals for the first release

- Full omnichannel contact-center infrastructure, live chat routing, social media inboxes, call-center telephony, workforce management, and real-time agent presence.
- Building a mail server or replacing the project's mail transport/IMAP integration.
- Building a full customer identity provider or a separate portal authentication stack.
- Replacing the generic Knowledge Base, Stream, Attachments, Activities, Workflow/BPM, Notifications, Jobs, Search, Reporting, or ACL engines.
- Replacing Sales order/invoice/payment processing or CustomerSuccess health scoring.
- Building a complete ITIL CMDB, change-management process, problem-management suite, on-call paging platform, or asset discovery engine.
- AI-only autonomous case resolution. AI-assisted summarization/classification can be a later optional integration behind a provider interface.
- Requiring Projects, Sales, or CustomerSuccess to be installed for core ServiceDesk to run.

### 3.3 Delivery tiers

- **P0 — Support MVP:** Case CRUD, transitions, assignment, case timeline, internal/public visibility, ACL, attachments, notifications, list/detail UI, and audit trail.
- **P1 — Operational Service Desk:** Queues and routing, email-to-case threading, portal case access, business calendar and SLA clocks, escalation jobs, KB linking, and basic dashboards.
- **P2 — Advanced service operations:** Web-to-case, CSAT surveys, advanced routing/rules, merge/duplicate workflow, trend reports, automated KB suggestions, and deeper cross-module integrations.

The overall plan includes all tiers; use these tiers to sequence delivery, not to silently remove requirements.

---

## 4. Repository Audit and Prerequisites

### 4.1 Inspect these existing capabilities

Before writing application code, verify whether each item is implemented, partially implemented, or planned only:

- Module registry, manifest format, module enable/disable lifecycle, menu registration, migrations, settings, event subscribers, and extension points.
- Entity Engine, metadata registry, field/relation validation, standard CRUD endpoints, query filtering, sorting, pagination, serialization, and record locking/concurrency conventions.
- Account, Contact, Lead, User, Team, Role, Portal, Portal User, and portal-role semantics.
- Existing `Case` entity or another support/ticket entity. Inspect metadata, migrations, APIs, relations, UI, existing seed data, and ACL before deciding whether to extend or create.
- Stream/timeline model, post visibility, follower/collaborator behavior, history/audit, attachment ACL, and notifications.
- Email accounts, inbound email polling, outbound sending, templates, message threading headers, attachment handling, and mail-provider test fakes.
- Knowledge Base/article/category implementation and portal publishing rules.
- Business-time/date utilities, scheduled jobs, recurring jobs, distributed locks, retry strategy, and dead-letter/failed-job visibility.
- Workflow/BPM triggers, job/notification dispatch, reporting/dashlet framework, global search, and saved filters.
- Completed `Projects`, `Sales`, and `CustomerSuccess` module interfaces and dependency guards.
- Existing test commands, migration runner behavior, test fixtures, and database target settings, following `AGENTS.MD`.

### 4.2 Required audit deliverable

Create or update `docs/implementation/service-desk-audit.md` with:

- Verified existing components and their import/service contracts.
- Existing Case, portal, mail, Stream, attachment, and Knowledge Base entities/tables, if any.
- Missing dependencies and whether they block P0, P1, or P2.
- Naming, directory, module-registry, API, metadata, and migration conventions found in the repository.
- Safe testing commands and whether they operate on the existing configured primary database.
- A short implementation order with file-level targets.
- Open compatibility questions and chosen defaults.

### 4.3 Dependency behavior

- If generic Knowledge Base exists, reference it and add only the relations/indexing needed for ServiceDesk.
- If portal infrastructure exists, add ServiceDesk's portal scope and components; do not implement a parallel portal login.
- If Email infrastructure exists, extend it with a case ingestion adapter/processor; do not implement another mail client.
- If Activities or Stream exists, use it. If visibility rules are insufficient, add a narrow, backward-compatible visibility capability through the shared service rather than building an isolated timeline without documenting why.
- If generic Workflow/BPM does not exist, implement small explicit service-domain events and rules only where needed; do not create an unplanned general-purpose workflow engine.
- If the Projects, Sales, or CustomerSuccess modules are disabled, case CRUD and SLA behavior must remain functional.

---

## 5. Functional Requirements

## 5.1 Canonical Case entity

Use the established metadata-driven Entity Engine. Before creating a new entity, determine whether the platform already has a compatible Case/support entity. Reuse exactly one canonical entity for tickets.

### Required field groups

**Identity and content**

- `caseNumber`: system-generated, unique, immutable after creation, safe to display publicly but not used as an authorization secret.
- `subject`: required, length-bounded.
- `description`: optional initial description; sanitize/escape on rendering according to the rich-text policy.
- `status`: configured enum backed by a validated transition model.
- `priority`: configured enum such as Low, Normal, High, Urgent.
- `severity`: optional impact/severity scale, distinct from priority where configured.
- `type` / `category`: configurable taxonomy (for example, Incident, Question, Service Request, Problem); do not hard-code customer vocabulary throughout code.
- `source`: UI, Portal, Email, API, Web Form, Workflow, or configured channel.
- `tags`: use the existing tag mechanism if available.

**Customer and ownership**

- `accountId`, `contactId`, optional `leadId` if leads are valid requesters.
- `requesterName` and `requesterEmail` only when the requester is not a resolvable CRM Contact or the channel requires a frozen sender identity. Validate format, normalize email carefully, and protect personal data.
- `assignedUserId`, `teamId`, `queueId` (only if the queue subsystem is implemented), and optional collaborators/followers.
- `createdBy`, timestamps, last activity, and last customer/agent response timestamps derived consistently from canonical events/messages.

**SLA and escalation**

- `slaPolicyId` and applied policy version/snapshot reference.
- First-response, next-response, and resolution due timestamps as appropriate.
- `slaState`: NotApplicable, OnTrack, Warning, Breached, Paused, Met, or a documented equivalent.
- `firstResponseAt`, `resolvedAt`, `closedAt`, `reopenedAt`, `nextResponseAt` where these timestamps are semantically valid.
- `isEscalated`, `escalationLevel`, `escalatedAt`, and a reason/history record rather than relying only on one mutable flag.

**Resolution and access**

- `resolutionCode`, `resolutionSummary`/`solution`, `resolvedBy`, and closure reason where applicable.
- `isHiddenFromPortal` or equivalent record visibility control when the platform supports such a concept.
- `mergedIntoCaseId` or an explicit merge relation, if merge is supported; preserve access and redirects from merged records.
- Soft-delete/retention behavior must follow the existing Entity Engine conventions. Closed cases should not be deleted by automated cleanup.

### Required invariants

- Case numbers are unique even under concurrent creation. Use a sequence or a transaction-safe number allocation service; do not compute a number by counting existing rows.
- Cases cannot reference nonexistent or inaccessible Account, Contact, User, Team, Queue, or SLA records.
- A portal requester cannot set an arbitrary owner, team, queue, SLA policy, source override, escalation state, or internal-only field.
- Direct status updates cannot bypass required transition side effects; transition commands are required for state-sensitive operations.
- Customer-facing fields and messages must be explicitly separated from agent-only operational fields.
- A merged case remains auditable and cannot silently duplicate further notifications or active SLA timers.

## 5.2 Case lifecycle and state machine

Provide configurable labels but retain a server-side state-transition model. The default lifecycle should support:

- `New`: case has been accepted but has not completed initial triage.
- `Open`: actively being investigated by an agent/team.
- `Pending Customer`: waiting for a customer response; SLA pause depends on policy.
- `Pending Internal`: waiting for another internal team or dependency; SLA pause depends on policy.
- `Escalated`: explicitly routed for higher urgency/ownership; it should not automatically mean the case is otherwise uneditable.
- `Resolved`: solution provided; may be reopened within policy.
- `Closed`: terminal for standard operation, with controlled administrative reopening if authorized.
- `Cancelled`: optional terminal state for invalid/withdrawn requests.

The repository may already standardize other values. The agent must map these semantics to the existing convention and document any changes.

### Transition commands

At minimum:

- Create / submit.
- Start work / open.
- Assign / reassign.
- Set pending customer.
- Set pending internal.
- Escalate / de-escalate.
- Resolve.
- Close.
- Reopen.
- Cancel.
- Merge into another case (P2).

### Transition rules

- Validate source state, target state, actor permissions, required fields, and related side effects on the server.
- Resolving a case requires a resolution code or summary according to configuration.
- Closing a case can require a prior Resolved state, customer confirmation, or a configured cooling-off period; keep the default policy simple and explicit.
- Reopening creates a history event and recalculates/resumes the applicable SLA according to policy. Never erase the prior resolution timestamps or SLA snapshots.
- Reassignment records the previous and new owner, actor, reason, and timestamp.
- A state change, transition event, audit entry, and associated notification/outbox record should be committed atomically where the platform permits.
- Internal notes do not constitute a customer response and must not satisfy first-response SLA unless a policy explicitly defines an agent's public response as the requirement.
- Automated transitions must identify their system/job actor and be idempotent.

## 5.3 Queues, teams, and routing

Queues represent operational inboxes, not a replacement for Teams or Users.

### Queue configuration

A queue should support:

- Name, code, description, active/inactive state, default Team, optional default SLA policy, allowed categories, supported channels, default priority, and fallback owner.
- Queue members or a reference to an existing Team membership model.
- Assignment strategy and strategy-specific settings.
- Optional business-hours/SLA defaults.
- Queue order, capacity/eligibility settings if supported by the existing platform.
- Audit fields and management permissions.

### Assignment strategies

P0 should include manual assignment and team assignment. P1 should add configurable strategies:

- **Round-robin:** choose the next eligible member while updating a concurrency-safe cursor.
- **Least-busy:** choose the eligible agent with the fewest active cases counted under the queue's documented filters.
- **Fallback:** if no member is eligible, retain the case in an unassigned queue or assign the configured fallback owner; never silently drop it.

### Routing rules

Rules can match validated attributes such as channel, category, priority, language, customer/account segment, product, or configured tags. Routing order must be deterministic and visible to administrators.

- Rules should be data-driven and validated at save time.
- Never evaluate arbitrary JavaScript or SQL stored in a routing rule.
- Evaluate ACL and user/team eligibility before assignment.
- Do not assign disabled users or users who are not members of the target queue/team.
- Keep a routing-decision record (rule, inputs summary, result, fallback reason) without storing unnecessary sensitive message content.
- Manual override is allowed only for actors with assignment permission and must leave an audit record.

## 5.4 Case conversation, Stream, and visibility

The case detail view needs a unified chronological timeline for customer messages, agent replies, internal notes, assignment/status events, and relevant system events.

### Message visibility model

Use the existing Stream/conversation service if it supports the necessary visibility semantics. Every case conversation item must have an unambiguous visibility classification, such as:

- `public`: permitted for the customer/requester and authorized portal users.
- `internal`: staff-only; never included in portal APIs or customer-bound email.
- `system`: internal audit/event entry, with a separate safe display representation if exposed to customers.

Do not infer visibility only from the UI or the item's author. Enforce visibility in backend query and serialization paths.

### Posting behavior

- Internal users can send a customer-visible reply or an internal note, depending on permissions.
- Portal users can only create customer-visible messages and cannot select `internal` or `system` visibility.
- The composer must clearly show whether a reply is public or internal and require confirmation when the selected mode changes if that prevents accidental disclosure.
- Attachments inherit the visibility of their message. An attachment linked to an internal note must not be downloadable from the portal, even if its generic attachment URL is otherwise valid.
- Sanitise content, validate attachment type/size, and use the existing file storage/security pipeline.
- Preserve author, created timestamp, edited/deleted state where policy allows, and source channel.
- Edits to customer-visible messages need an audit trail and should not silently rewrite what was sent by email.

### Customer communication notifications

- Notify authorized followers/requesters on relevant public replies and state changes according to preferences.
- Do not email customers about internal-only notes.
- Avoid notifying every user in the CRM by default; use explicit follow, assignment, queue, and notification rules.
- Deduplicate notifications by event identity and recipient.

## 5.5 Email-to-Case and case email replies

Email integration must use the current mail infrastructure. Do not create an independent mail poller if a generic incoming-email pipeline exists.

### Inbound processing

- Support configured group/shared email accounts or addresses mapped to one or more queues.
- Parse sender, recipients, subject, body, headers, sent date, and attachments using the project's approved MIME parser.
- For an unmatched new thread, create a Case using a safe subject/body, queue mapping, source `Email`, and a configured default status/priority.
- For a reply to a known thread, append a customer-visible message to the existing case rather than creating another case.
- Use `Message-ID`, `In-Reply-To`, `References`, mailbox/provider IDs, and a normalized thread key where available. Treat subject matching as a fallback, not the sole identity mechanism.
- Store processing idempotency markers so mailbox polling retries do not duplicate cases/messages.
- Detect and prevent mail loops, automated out-of-office messages, delivery status notifications, spoofed headers, and messages originating from the system's own sender addresses where appropriate.
- Route unknown or ambiguous messages to a review/unmatched queue rather than attaching them to a guessed customer's case.
- Validate attachment sizes/types and apply malware scanning if the platform supports it. Reject or quarantine unsupported content safely.
- Preserve original email headers and raw-message references only according to retention/privacy policy; never expose raw MIME to portal users.

### Outbound replies

- Provide an explicit customer reply action that uses configured outbound transport and a case-associated sender address.
- Preserve message threading headers and a reply-to address that routes subsequent customer replies to the correct group mailbox.
- Record the outgoing message status and safe delivery/error details.
- Do not mark an SLA as met merely because an outbound send was queued. Define whether successful transport submission or confirmed delivery satisfies the configured response rule.
- Retry transient errors safely; do not send the same reply twice on retry. Use an outbox/idempotency key where supported.
- If no email infrastructure exists, define a narrow adapter contract and ship the ServiceDesk API/UI first; do not pretend email-to-case is operational until an adapter is implemented and verified.

## 5.6 SLA policies and business calendars

SLA is a project-specific enhancement and must be implemented as a standalone domain service integrated with Jobs and Notifications.

### SLA policy configuration

A policy may define:

- Name, code, active state, priority/order, effective dates, and version.
- Conditions such as case priority, category, source, customer segment, queue, or Account service tier, limited to supported declarative conditions.
- First-response target duration.
- Next-response target duration, optional and reset on each customer message.
- Resolution target duration.
- Warning thresholds (for example 50%, 75%, and 90% elapsed business time).
- Business-hours calendar, time zone, holidays, and exception dates.
- Pause conditions and whether waiting on Customer, Internal, or another explicit state pauses each target.
- Escalation actions and target queue/team/user, within configured limits.

### Time calculation

- Store timestamps as timezone-aware instants using the repository's database/time conventions.
- Store the policy ID and version that applied when a case was created or when a policy is deliberately recalculated.
- Calculate target deadlines with a business-time service, not ad hoc arithmetic sprinkled through controllers.
- Handle time zones, daylight-saving transitions, overnight shifts, holidays, and exceptional working days when supported by the chosen calendar model.
- Define whether SLA pauses stop the clock or adjust the deadline, and maintain an auditable timeline of pause/resume intervals.
- The UI must distinguish calendar-time age from business-time elapsed.
- If the policy changes, do not silently rewrite the target history of all open cases. Make recalculation a deliberate, audited operation with a dry-run or preview where a large change is involved.
- Reopened cases need explicit policy semantics: resume the prior resolution clock, create a new resolution cycle, or use a configured rule. Preserve past cycle data.

### SLA state

- `OnTrack`: no warning threshold exceeded.
- `Warning`: one or more configured warning thresholds reached.
- `Breached`: the target has elapsed without the target condition being satisfied.
- `Paused`: the clock is paused under the applied policy.
- `Met`: the response/resolution event occurred before the target deadline.
- `NotApplicable`: no policy applies or this target is not configured.

A case can have distinct outcomes for first-response, next-response, and resolution targets; avoid compressing multiple clocks into one misleading status. Expose a summarized case-level SLA state only if it is derived consistently from the individual clocks.

## 5.7 Escalations and service notifications

- Configure warning and breach actions per SLA policy or escalation rule.
- Supported actions may include notify assigned agent, notify queue/team lead, reassign to a target queue/user, raise priority, mark escalated, create an Activity/task, or emit a workflow event.
- Escalation actions must be idempotent and include the case, target, rule, triggering clock, and policy version in their idempotency key.
- A failed notification must not prevent the SLA clock from recording the breach.
- Avoid escalating a resolved/closed/merged case unless a rule specifically covers those states.
- Do not repeatedly emit the same warning every scheduler tick. Record when a threshold/action was fired and re-fire only when the rule explicitly defines repeat behavior.
- Provide a visible audit/event history for escalation and manual de-escalation.

## 5.8 Knowledge Base

Reuse an existing Knowledge Base entity and search service if present. Do not create a duplicate just for ServiceDesk.

### Article lifecycle

- Draft, In Review, Published, Archived/Expired states, adapted to existing metadata conventions.
- Title, slug/key, summary, body, category, tags, language, author, reviewer, published/expiry dates, and portal visibility.
- Published versions should not be silently overwritten where version tracking is supported; at minimum, keep audit history of editorial changes.
- Only approved, published, in-date articles may be served to customers.
- Internal-only articles must never appear in portal search, suggested articles, public APIs, or customer email snippets.
- Article category and article record permissions must apply on lists, details, related-article APIs, search, and exports.
- Permit linking articles to cases and optionally recording whether the article helped resolve the case.
- Provide related-article suggestions based on text/category/tags only if a supported search capability exists. Suggestions must follow the same visibility checks.

### Article administration UI

- List/search/filter by state, category, language, and expiration.
- Article editor using the existing safe rich-text or Markdown editor.
- Preview portal-facing content before publication.
- Approve/publish, unpublish, archive, and expire actions with permission checks and audit history.

## 5.9 Customer portal case access

Reuse the platform Portal and Portal Roles system. A portal user must not gain access to any case simply by guessing its ID or case number.

### Portal capabilities

- Create a case under the portal user's allowed Contact/Account context.
- View cases created by that user or cases explicitly allowed by the configured account/contact scope.
- View customer-visible conversation entries and permitted attachments only.
- Reply to a case while it is in a customer-reply-allowed state.
- Upload allowed attachments with quotas and validation.
- View status, priority label if desired, timestamps, and public resolution summary.
- Search published Knowledge Base articles.
- Reopen a resolved case only within configured rules and only if portal policy permits it.

### Portal restrictions

- Portal clients cannot set `assignedUserId`, `teamId`, `queueId`, SLA policy, escalation fields, internal tags, internal note visibility, arbitrary source values, or privileged status transitions.
- Never return internal notes, private attachments, queue routing details, internal escalation comments, hidden cases, unredacted email headers, internal audit payloads, or inaccessible linked records.
- Apply account/contact scope at query time on every list and detail request, not only after fetching the entity.
- Validate that a Contact belongs to the Account context before associating or exposing a case.
- Portal API tests must exercise ID enumeration and cross-account isolation.

## 5.10 Web-to-Case and public intake

P2 feature. Public intake is an attack surface; do not simply expose unrestricted generic entity creation.

- Provide a dedicated, limited intake endpoint or form contract.
- Accept only explicitly allowed customer-facing fields.
- Enforce rate limits, request-size limits, email validation, spam/abuse protections, and CAPTCHA or equivalent challenge only if the platform already supports it or its integration is approved.
- Use a secure confirmation flow when required by deployment policy; avoid revealing whether an arbitrary email address already exists in CRM.
- Sanitize body content and validate attachment count, type, size, and storage policy.
- Apply default queue, status, priority, source, and SLA server-side.
- Do not expose internal IDs, debug messages, or authorization details in public error responses.
- Add correlation IDs and abuse counters without logging raw personal data unnecessarily.

## 5.11 Case assignment, merge, duplicates, and reopen

### Reassignment

- Support single-record assignment and permitted bulk assignment.
- Validate target user/team/queue membership and assignment permission.
- Record previous assignment, new assignment, actor, timestamp, and optional reason.
- Recompute routing-dependent notifications and queue counters without resetting SLA clocks unless the policy explicitly requires it.

### Duplicate detection

- P2: support a configurable candidate search using exact case number, external message/thread ID, contact/account, normalized subject, and recent time window.
- Never automatically merge based only on subject similarity.
- Present confidence/reason information to an authorized agent before merging.

### Merge behavior

- Require explicit permission and a chosen surviving case.
- Preserve both case numbers, history, messages, attachments, relations, and source records. A merged case must have a durable link to the surviving case rather than being hard-deleted.
- Move or relate content transactionally where possible and prevent duplicated notifications.
- Recalculate active SLA clocks on the survivor using an explicit policy; preserve source-case clock histories.
- Provide redirect/read-only behavior for merged records and include merge metadata in exports/audits.

### Reopen behavior

- A reopen operation requires permission and an allowed current status.
- Record reopen reason, actor, and timestamp.
- Resume/start SLA clocks according to the selected policy; do not overwrite previous resolution cycles.
- Notify the assigned queue/owner and update case lists and dashboard metrics.

## 5.12 Customer satisfaction (CSAT)

P2 feature, unless already provided by a reusable platform survey module.

- Support a simple configurable rating scale (for example, 1–5), optional free-text feedback, and a survey invitation lifecycle.
- Generate one eligible invitation per configured case-resolution cycle unless policy allows an explicit resend.
- Use a cryptographically random, expiring, single-use token for unauthenticated response links. Store only a hashed token where practical; never use a case ID as the secret.
- Validate that survey tokens cannot reveal case detail, contact information, account details, or internal messages.
- Rate-limit submissions and make duplicate submissions idempotent or explicitly rejected.
- Allow administrators to configure invitation timing, response window, reminder policy, and minimum privacy/reporting thresholds.
- Reports must avoid exposing individual free-text feedback to users lacking permission.
- Do not send actual survey emails during tests.

## 5.13 Cross-module integration

Integrations are optional and must use stable interfaces.

### CRM Core

- Account and Contact are the primary customer relations.
- Link permitted Leads only if the core model supports them as requesters.
- Use Users and Teams for ownership and assignments.
- Use Activities, Attachments, Stream, Notifications, Email, Search, and Reports through their shared APIs.

### Projects

- A case may link to an existing Project or Project Task when the support issue is work tracked by delivery/engineering.
- Do not create project tasks automatically unless a configured rule or user action requests it.
- Respect Project and Project Task ACL when showing related records.
- ServiceDesk must not depend on Projects being enabled.

### Sales

- A case may relate to products, subscriptions, invoices, orders, or other Sales records if the relevant entity exists and policy permits.
- Use these links as context for support agents only; do not alter financial documents or create refunds from a case without an explicitly approved Sales-domain command.
- ServiceDesk must not depend on Sales being enabled.

### CustomerSuccess

- Provide an optional event/relationship contract so a qualifying severe or repeated case can be surfaced as a customer risk or health signal.
- Do not directly modify CustomerSuccess health-score tables or business rules from ServiceDesk.
- The receiving module decides how service events affect health scoring.
- ServiceDesk must not depend on CustomerSuccess being enabled.

### Workflow/BPM and integrations

- Publish domain events for case created, assigned, status changed, public reply sent/received, SLA warning/breach, escalation, resolution, reopen, merge, and CSAT response.
- Consume configured workflow actions through the existing Workflow/BPM API when present.
- Do not create circular imports. Inter-module communication should use shared contracts/events, optional providers, or guarded relation metadata.

---

## 6. Domain Model and Persistence Design

Follow the existing Entity Engine and persistence conventions. The following are logical entities/tables, not permission to create duplicate generic platform tables.

## 6.1 Core records

### Case

Prefer the existing canonical Entity Engine entity/table if it exists. Key logical attributes include:

- Identity: `id`, `caseNumber`, `subject`, `description`.
- Classification: `status`, `priority`, `severity`, `type`, `categoryId`, `source`, `tags`.
- Customer: `accountId`, `contactId`, optional `leadId`, `requesterName`, `requesterEmail`.
- Routing: `assignedUserId`, `teamId`, optional `queueId`, `routingRuleId` where metadata conventions allow.
- Timing: `createdAt`, `updatedAt`, `lastActivityAt`, `firstResponseAt`, `lastCustomerResponseAt`, `lastAgentResponseAt`, `resolvedAt`, `closedAt`, `reopenedAt`.
- SLA summary: policy reference/version, target summaries, escalation summary, but detailed clock history belongs in normalized domain records.
- Resolution: `resolutionCode`, `resolutionSummary`, `resolvedById`, `resolvedAt`.
- Portal/access: `isHiddenFromPortal` or equivalent, subject to platform ACL semantics.
- Standard audit/soft-delete fields required by the Entity Engine.

Do not add redundant columns if these concepts are already implemented as generic metadata fields or relation fields.

### CaseQueue

Logical properties:

- `id`, `name`, `code`, `description`, `isActive`, `defaultTeamId`, `defaultAssignedUserId`, optional `defaultSlaPolicyId`.
- Routing strategy and validated settings.
- Supported categories/channels, if represented as normalized relations or metadata.
- Working schedule reference, fallback behavior, sort order, and standard audit fields.

### QueueMember / QueueMembership

Use an existing Team membership model if sufficient. Otherwise use a narrow join model with:

- Queue ID, User ID or Team ID, eligibility/active state, optional skill/language metadata, priority/weight, and timestamps.
- A uniqueness constraint to prevent duplicate membership.
- No duplicated global roles or permissions.

### RoutingRule

- Name, active state, sort order/priority, supported declarative conditions, target Queue/Team/User, assignment strategy, fallback behavior, and audit fields.
- Conditions must use a validated JSON/schema contract, not executable scripts or SQL.

### SLAPolicy

- Name/code, version, active state, effective dates, conditions, calendar ID/time zone, response/resolution durations, warning thresholds, pause rules, escalation actions, and audit fields.
- Version applied to a case must be stable and retrievable for audit.

### SLATarget / CaseSLAClock

Prefer normalized per-case/per-target records. Logical fields:

- Case ID, target type (first response, next response, resolution), policy/version reference, start/due/met/breached timestamps, elapsed business duration, pause intervals/state, status, and recalculation metadata.
- Uniqueness should prevent duplicate active clocks for the same case, target, and lifecycle cycle.
- Preserve historical clocks for prior resolution/reopen cycles.

### BusinessCalendar / BusinessCalendarInterval / Holiday

Reuse a shared working-time calendar if available. If not, create a minimal, timezone-aware schedule abstraction instead of hard-coding business hours in SLA services.

- Calendar ID, timezone, weekly opening intervals, holiday dates, exception dates, effective ranges, and audit metadata.
- Validate overlapping intervals and invalid time ranges at save time.
- Store exception days in normalized records or a validated structured format consistent with repository practices.

### CaseAssignmentHistory / CaseTransitionHistory

Reuse generic audit/history where it already provides durable old/new values, actor, timestamp, and source. Add dedicated domain history only for information that generic audit cannot represent reliably, such as transition reason, routing decision, or workflow command.

### Email ingestion idempotency record

Reuse the mail system's idempotency store if present. Otherwise persist a narrow mapping from provider/mailbox identity and message ID to processing result/case/message IDs. Enforce uniqueness so retries are safe.

### CSATSurvey / CSATResponse

Only for P2 or when no existing survey module is reusable. Store invitation cycle, case relationship, token hash/expiry, delivery state, rating, optional free text, submission timestamp, and necessary privacy/audit metadata. Never store a reusable raw public token unless there is a justified security design.

## 6.2 Knowledge Base persistence

If reusable Knowledge Base entities exist, use them. Otherwise, any new Article/ArticleCategory entities must follow the generic Entity Engine and include at least:

- Article: title, slug, summary, body, category relation(s), locale, publication state, author/reviewer, published/expiry timestamps, portal visibility, version/audit fields.
- Category: name, parent category relation if hierarchical categories already fit the Entity Engine, sort order, active state.
- Explicit publication and portal-read rules, enforced by the backend for list, detail, search, related articles, and exports.

## 6.3 Database constraints and indexes

Add indexes only after checking existing indexes and actual query patterns. Candidate constraints/indexes:

- Unique case number.
- Case lists by `(status, priority, updated_at)`, `(assigned_user_id, status)`, `(team_id, status)`, `(queue_id, status)`, and SLA due/breach query fields.
- Case relations by `account_id`, `contact_id`, and other supported foreign keys.
- Unique routing/config codes where code-based lookups are used.
- Unique queue membership keys.
- Unique inbound message idempotency key per mailbox/provider.
- Unique active clock key for a target/cycle when expressible safely.
- Survey token hash uniqueness and expiration lookup index.

Use actual repository naming conventions and validate query plans before adding speculative indexes. Keep foreign-key behavior consistent with the Entity Engine's relation/deletion policy.

## 6.4 Migrations and seeds

- Add version-controlled additive migrations using the project's migration runner.
- Check existing entity metadata before adding columns/tables to avoid duplicates.
- Seed only minimal configuration needed for a fresh module activation (for example, default case priorities/statuses or one disabled sample policy if this matches existing patterns). Do not seed demo cases in production.
- Seeds must be idempotent and must not delete or overwrite user configuration on module upgrade.
- Do not create a new database or schema for ServiceDesk tests.

---

## 7. Backend Architecture

## 7.1 Module boundaries

Register `ServiceDeskModule` using the existing module loader. Suggested conceptual service boundaries (adapt names and folders to repository conventions):

- `CaseCommandService`: creation, state transitions, resolution, reopening, merging.
- `CaseQueryService`: authorized list/detail and dashboard queries.
- `CaseAssignmentService`: assignment, queue routing, least-busy/round-robin selection.
- `CaseConversationService`: public replies, internal notes, visibility-safe timeline.
- `EmailToCaseProcessor`: inbound parsing, thread resolution, idempotency, case creation/update.
- `CaseReplyService`: customer-visible outbound email and delivery state.
- `SlaPolicyResolver`: resolves applicable policy and immutable policy version.
- `SlaClockService`: starts, pauses, resumes, meets, breaches, and recalculates clocks.
- `BusinessTimeCalculator`: computes elapsed/remaining business time.
- `ServiceDeskEscalationService`: idempotent warning and breach actions.
- `KnowledgeArticleService`: only if KB is implemented within this scope; prefer existing generic KB service.
- `PortalCaseService`: applies portal-scoped operations and safe projections.
- `CsatService`: invitation and response lifecycle, only for P2.
- `ServiceDeskSettingsService`: validated settings and configuration access.

Controllers should validate/translate API inputs and invoke domain services. Do not put routing, SLA calculations, or visibility policy in controllers or React components.

## 7.2 Transaction boundaries

Use transactions for operations whose invariants span multiple writes, including:

- Create case + allocate case number + initial history + SLA clocks + queue decision (where possible).
- Transition + transition history + audit/outbox event + clock changes.
- Assignment + assignment history + queue membership decision + notification/outbox intent.
- Add message + update last-response timestamps + evaluate target clock + record message idempotency key.
- Merge cases + relation/content mapping + source-case marker + SLA state updates.
- CSAT response persistence + token consumption.

Do not hold database transactions open during remote calls such as sending email, external webhook calls, or scanning uploaded files. Use the platform's outbox/job patterns if available.

## 7.3 Concurrency and idempotency

- Case-number allocation must be safe under concurrent create requests.
- Round-robin state must be updated atomically or through a safe lock/claim method.
- Least-busy assignment must account for simultaneous assignments or explicitly tolerate bounded imprecision while avoiding systematic overload.
- Email ingress must have durable idempotency keys and unique constraints.
- Repeated transition requests with the same idempotency key must not create duplicate transition history or customer notifications.
- SLA jobs must safely handle cases updated concurrently by agents.
- Use optimistic concurrency/version columns where that matches platform conventions; return a stable conflict response for stale writes.

## 7.4 Domain events

Use the existing event bus/outbox conventions. Recommended events:

- `serviceDesk.case.created`
- `serviceDesk.case.assigned`
- `serviceDesk.case.statusChanged`
- `serviceDesk.case.priorityChanged`
- `serviceDesk.case.publicReplyReceived`
- `serviceDesk.case.publicReplySent`
- `serviceDesk.case.internalNoteAdded`
- `serviceDesk.case.resolved`
- `serviceDesk.case.closed`
- `serviceDesk.case.reopened`
- `serviceDesk.case.escalated`
- `serviceDesk.case.slaWarning`
- `serviceDesk.case.slaBreached`
- `serviceDesk.case.merged`
- `serviceDesk.kbArticle.published`
- `serviceDesk.csat.responseReceived`

Follow the repository's naming syntax if it differs; keep the `ServiceDesk` domain identifier and do not prefix these events with `Ua`.

Events should include stable IDs and a minimal, non-sensitive payload. Consumers must load related records under their own authorization/system context as appropriate. Events must not include raw email bodies, private attachments, or unnecessary customer PII.

## 7.5 Error handling

Use the platform's standard error envelope and stable codes for at least:

- `CASE_TRANSITION_NOT_ALLOWED`
- `CASE_ASSIGNMENT_FORBIDDEN`
- `CASE_NOT_VISIBLE`
- `CASE_RESOLUTION_REQUIRED`
- `QUEUE_HAS_NO_ELIGIBLE_AGENT`
- `SLA_POLICY_INVALID`
- `SLA_RECALCULATION_REQUIRES_CONFIRMATION`
- `EMAIL_MESSAGE_ALREADY_PROCESSED`
- `PUBLIC_REPLY_NOT_ALLOWED`
- `PORTAL_CASE_ACCESS_DENIED`
- `CASE_MERGE_CONFLICT`

Do not disclose internal record existence to unauthorized portal clients. Return the platform's established not-found/forbidden pattern to avoid ID enumeration.

---

## 8. API Plan

Follow the project's existing `/api/v1` and Entity Engine conventions. The routes below are conceptual: adapt them to the route registry and standard entity API. Do not create a second API style solely for ServiceDesk.

## 8.1 Standard entity operations

Use generic entity operations for supported metadata-driven Case, Queue, SLA Policy, Knowledge Article, and related CRUD. The implementation must enforce module-specific domain validation in addition to generic field validation.

Representative resources:

- `GET /api/v1/cases`
- `POST /api/v1/cases`
- `GET /api/v1/cases/:id`
- `PATCH /api/v1/cases/:id`
- Related records and authorized timeline endpoints according to established conventions.
- Queue, routing-rule, SLA-policy, calendar, knowledge-base, and survey resources only when enabled by the roadmap and repository conventions.

## 8.2 Domain commands

Representative command endpoints or service actions:

- `POST /api/v1/cases/:id/assign`
- `POST /api/v1/cases/:id/transition`
- `POST /api/v1/cases/:id/resolve`
- `POST /api/v1/cases/:id/reopen`
- `POST /api/v1/cases/:id/escalate`
- `POST /api/v1/cases/:id/de-escalate`
- `POST /api/v1/cases/:id/reply`
- `POST /api/v1/cases/:id/internal-notes`
- `POST /api/v1/cases/:id/merge` (P2)
- `GET /api/v1/cases/:id/sla`
- `POST /api/v1/service-desk/sla/recalculate-preview` (admin-only; final operation must be confirmed and audited)
- `POST /api/v1/service-desk/sla/recalculate` (admin-only and bounded)
- `GET /api/v1/service-desk/queues/:id/workload`
- `GET /api/v1/service-desk/dashboard/summary`

Prefer the existing action/command convention instead of forcing these exact URLs when that convention differs.

## 8.3 Portal API

Portal APIs must apply account/contact scopes in the query itself:

- List only cases available to the authenticated portal user.
- Create a case using server-derived requester/account/contact context.
- Read a single case with public-only messages and attachments.
- Add a public reply to an eligible case.
- Download only customer-visible attachments.
- Search only published and portal-enabled KB articles.
- Submit a CSAT response using a validated, expiring survey token if this feature is enabled.

Never rely on client-supplied Account/Contact IDs as proof of relationship. Resolve them from the authenticated portal identity or verify them against portal access policy.

## 8.4 Web-to-Case API

If implemented, use a dedicated public endpoint isolated from generic entity creation. It must:

- Accept a narrow allowlist of fields.
- Apply rate limits and request-size validation.
- Require configured spam/abuse checks.
- Use a server-side idempotency mechanism where the caller has a safe idempotency token.
- Avoid exposing whether an email maps to an existing CRM Contact.
- Return only a submission/reference identifier that does not grant access to case content.

## 8.5 API requirements

- Use server-side DTO validation and stable error codes.
- Apply authentication, ACL, record filters, and field visibility consistently for list/detail/search/export/report/portal paths.
- Never accept internal-only message visibility, SLA policy, target timestamps, routing outcome, or owner assignment from untrusted portal/public requests.
- Support pagination, sorting, filters, and relation expansions through existing query conventions.
- Update OpenAPI definitions and API tests in the same change as contract modifications.
- Add idempotency keys where client/network retry could otherwise duplicate a command.
- Do not expose SQL, tokens, internal stack traces, raw mail headers, or private system configuration.

---

## 9. Frontend and User Experience

Use the existing React SPA, design system, routing, forms, metadata-driven list/detail components, accessibility conventions, and localization infrastructure. Do not add another component library without a concrete repository-backed need.

## 9.1 Navigation and information architecture

Suggested Service Desk navigation, adapted to the existing menu system:

- **Cases** — all cases permitted by ACL.
- **My Cases** — cases assigned to the current user.
- **Queues** — team inboxes and queue workloads.
- **SLA Monitor** — warning, breached, and at-risk cases.
- **Knowledge Base** — article search and administration where permitted.
- **Service Reports** — summary dashboards and reports.
- **Service Desk Settings** — queues, routing, statuses, categories, calendars, SLA policies, escalation rules, templates, and survey settings, restricted to configured admin roles.

Do not show menu entries for disabled capabilities or missing optional dependencies.

## 9.2 Case list and views

Required P0 list capabilities:

- Search by case number and subject.
- Filter by status, priority, category, Account, Contact, assignee, Team, source, creation/update date, and configured fields.
- Saved filters/views through the existing system.
- Sort by updated time, priority, age, due/SLA time, and case number where allowed.
- Bulk assignment and safe bulk updates only for authorized users.
- Clear indicators for unassigned, waiting, escalated, nearing SLA, and breached cases.
- Respect ACL before counts, aggregations, facets, exports, and bulk selection.

P1/P2 views:

- Queue inbox/triage view.
- Kanban or pipeline view by status where consistent with existing UI primitives.
- SLA monitor.
- Aging/backlog view.

## 9.3 Case detail view

Suggested layout:

- Header: case number, subject, status, priority/severity, SLA state, assigned user, Team/Queue, and primary actions.
- Main panel: customer description and conversation timeline.
- Side panel: Account, Contact/requester, source, category, dates, SLA clocks, escalation state, related records, and customer-facing visibility controls.
- Resolution panel: resolution code/summary and resolution timestamps.
- Related panels: Attachments, Activities, linked Knowledge Base articles, and related Sales/Projects/CustomerSuccess records when available and authorized.
- Audit/history: status, owner, priority, queue, policy, and key system transitions.

The public/internal composer must be visually unmistakable. A customer-visible reply and an internal note must never share an ambiguous submit action.

## 9.4 Agent workspace

P1 target:

- Unified inbox with queue selector, unread/new indicators, SLA countdowns, age, priority, and owner.
- Fast assign/reassign and supported quick transitions.
- Keyboard navigation only if existing accessibility patterns support it.
- Avoid auto-refresh behavior that loses a draft or overwrites unsaved user input.
- Show routing decisions and why a case is unassigned when permitted.

## 9.5 Knowledge Base UI

- Search results, article detail, category navigation, related cases, and suggested articles.
- Internal agent view may show draft/internal articles according to ACL.
- Portal view must only show published, non-expired and portal-authorized content.
- Article preview should use the same rendering/sanitization path as the published article.

## 9.6 Portal UI

- Cases list and case detail for authenticated portal users.
- Create case form with customer-safe fields only.
- Public conversation timeline and reply composer.
- Visible attachment list limited to customer-visible files.
- Related published KB suggestions.
- Status and safe resolution information.
- Survey response form if CSAT is enabled.

The internal CRM UI and customer portal must not share an unfiltered data serializer. Use explicit portal DTO/projection types.

## 9.7 Accessibility and responsive design

- Keyboard-accessible list actions, form controls, modal dialogs, and message composer.
- Clear focus state, accessible labels, non-color-only status cues, sufficient contrast, and screen-reader-friendly SLA labels.
- Responsive case detail and conversation layout.
- Confirm destructive or high-impact operations such as merge, close, bulk reassignment, and SLA mass recalculation.
- Preserve drafts where possible; warn before navigating away with unsaved responses.

## 9.8 Localization

- All display labels and user-facing errors must use the existing i18n system.
- Store timestamps in standard instants and render according to user/portal locale and time zone.
- Do not hard-code English status names in business logic; use stable enum/status codes with configurable labels.
- Avoid embedding customer-visible email prose directly in code; use reviewed templates and localization.

---

## 10. Security, Privacy, and Authorization

Security is a release gate, not a post-release improvement.

## 10.1 Authorization dimensions

Use existing platform authorization and add only ServiceDesk-specific scopes/policies:

- Entity-level permission: create/read/edit/delete or archive, if deletion is supported.
- Record-level access: own/assigned, Team, Queue, Account, Contact, or all according to existing ACL conventions.
- Field-level access: requester PII, internal classification, SLA override, and routing configuration.
- Assignment permission: assign/reassign only within allowed queues/teams or with explicit broader privilege.
- Transition permission: resolve, close, reopen, escalate, merge, or override SLA according to role.
- Conversation permission: create public replies, create internal notes, edit/delete posts, and view internal notes.
- Configuration permission: manage queue/routing/SLA/calendar/escalation/KB/CSAT settings.
- Portal scope: own/contact/account-linked cases based on Portal Roles and relation policy.

## 10.2 Authorization matrix (minimum target)

| Capability | Support Agent | Queue/Team Lead | Service Desk Admin | Portal User |
|---|---|---|---|---|
| Read assigned/eligible cases | Yes | Yes | Yes | Own/allowed account scope only |
| Read all cases | No by default | Configurable | Yes, subject to global ACL | No |
| Create internal case | Yes | Yes | Yes | Only through portal-safe create |
| Assign/reassign | Allowed scope | Team/queue scope | All permitted scopes | No |
| Add public reply | Yes | Yes | Yes | Own/allowed case only |
| Add internal note | Yes | Yes | Yes | No |
| View internal notes | Yes, if case readable | Yes, if case readable | Yes | No |
| Resolve/close/reopen | Policy-based | Policy-based | Yes with audit | Only permitted portal reopen action |
| Edit SLA policies/routing | No | Optional limited config | Yes | No |
| View/manage Knowledge Base | ACL-controlled | ACL-controlled | Yes | Published portal articles only |
| Merge cases | No by default | Optional | Yes | No |
| View service-wide reports | Own/queue scope | Team scope | Yes | No internal reports |

Adapt to actual roles rather than introducing hard-coded global role names everywhere.

## 10.3 Internal/public data isolation

- Public visibility must be explicit on each message and attachment.
- The portal serializer must use an allowlist projection, not merely remove a few known internal fields from a full internal entity.
- All attachment download requests must re-check case visibility, message visibility, and the current actor's scope.
- Related-record expansions must run ACL checks; the fact that a case is visible does not grant unrestricted access to all linked Email/Activity/Sales/Project records.
- Exports, search, notifications, audit endpoints, error responses, and dashboards must preserve public/internal separation.
- Do not put internal notes in customer email templates, push events, public webhooks, or portal caches.

## 10.4 Input and infrastructure security

- Sanitize rich text and prevent stored XSS in case bodies, email bodies, KB articles, subject fields, and customer feedback.
- Use parameterized SQL, validated metadata identifiers, attachment content-type/size checks, and the approved upload/file pipeline.
- Apply rate limiting and abuse protection to portal replies, public intake, and survey submission.
- Validate inbound mail sender/headers and guard against mail loops, spoofing, malformed MIME, archive bombs, and unbounded payloads.
- Limit outbound template rendering and prevent header injection.
- Do not log access tokens, raw survey tokens, message bodies, full email addresses unnecessarily, or database URLs.
- Apply retention, deletion, export, and personal-data handling rules already established by the project.

## 10.5 Required security tests

- User without access cannot list, read, update, assign, resolve, export, or download attachments from an inaccessible case.
- Portal User A cannot enumerate or read Portal User B's case, messages, or files by guessing IDs or case numbers.
- Portal users cannot forge account/contact relations, queue, owner, SLA, escalation state, internal visibility, or resolution audit fields.
- Internal notes and their attachments are absent from every portal API and outbound email.
- KB search and related-article routes cannot reveal draft, expired, internal-only, or ACL-restricted articles.
- Assignment, transition, merge, SLA override, and bulk operations enforce server-side permissions.
- No test triggers real email, webhook, SMS, survey, or external provider side effects.

---

## 11. Validation, Business Rules, and Failure Modes

### 11.1 Input validation

- Subject is required and length-bounded.
- Priority, severity, status, category, source, and resolution code must be valid configured values.
- Email addresses and external message identifiers are validated and normalized without destructive normalization that changes mailbox semantics.
- Dates must be valid timezone-aware instants; deadlines are system-derived except for authorized overrides.
- Assignment targets must exist, be active, and be eligible under the selected queue/team policy.
- Queue/routing/SLA/calendar configurations are validated before activation.
- Article publication requires all configured mandatory metadata.
- Public case intake rejects internal-only fields even if clients include them; do not silently persist them.

### 11.2 Business-rule examples

- A new case obtains a unique number and a deterministic source/default status.
- A customer reply to an open/pending case reactivates it only according to an explicit transition policy.
- First-response SLA is met only by a qualifying agent public response according to the configured policy.
- An internal note does not count as a customer response or first response.
- A case waiting for a customer pauses only the specific SLA clocks configured to pause for that state.
- A queue with no eligible members follows a visible fallback path and raises an operational warning; it cannot drop the case.
- A closed case is not automatically reopened by an unrelated email unless thread and reopen rules allow it.
- Reprocessing one inbound email does not create duplicate messages, cases, or notifications.
- A resolved case can be reopened without deleting its previous resolution history.
- A KB article's expiry immediately affects public visibility after the expiry time according to the agreed scheduler/cache invalidation strategy.
- SLA policy edits do not silently rewrite historical clocks or service reports.

### 11.3 Failure modes to handle

- Inbound message could not be parsed or has no usable sender.
- Thread reference matches multiple cases or no case.
- Mail provider is temporarily unavailable.
- Outbound response failed or is pending delivery.
- Routing has no eligible agent or queue is disabled.
- SLA policy/calendar is invalid, missing, or changed while a clock is active.
- Scheduled job runs twice or overlaps another worker.
- Case was resolved/closed while a scheduled escalation job was processing it.
- User loses ACL between opening the UI and submitting an action.
- Uploaded attachment is invalid or exceeds quota.
- Cross-module provider (Projects, Sales, CustomerSuccess) is disabled or fails.

Use stable errors, retryable/non-retryable classifications, safe logs, and an operationally visible failed-processing state where appropriate.

---

## 12. Jobs, Notifications, Audit, and Observability

## 12.1 Candidate scheduled/background jobs

Use the existing Jobs/BullMQ/scheduler infrastructure. Do not introduce another scheduler.

- SLA clock scanner / warning evaluator.
- SLA breach detector and escalation executor.
- Inbound email processing if the existing mail pipeline supports queued processing.
- Failed email retry/reconciliation with bounded retry and dead-letter visibility.
- Auto-close resolved cases after a configured grace period, disabled by default until explicitly configured.
- Knowledge Base expiry/publish scheduling if not already handled by a shared content module.
- CSAT invitation/reminder and token-expiry cleanup, if CSAT is enabled.
- Periodic aggregate refresh only if live queries cannot meet performance needs and the existing reporting architecture supports such projections.

## 12.2 Job requirements

- Jobs are idempotent and safe when retried or executed concurrently.
- Each job has bounded batch size, timeout, retry policy, lock/concurrency behavior, and structured logs.
- Every processed record is scoped and permission-aware; system jobs use a documented service identity rather than bypassing all invariants.
- Jobs must tolerate cases deleted/merged/closed between enqueue and execution.
- Prevent repeated warnings or escalation actions for the same threshold unless explicit repeat behavior is configured.
- Record last-success/checkpoint/failure information for mail processing and SLA scans.
- Failed jobs must not silently mark an SLA met or erase a breach.

## 12.3 Notifications

Use the existing notification system and user preferences where available. Candidate notifications:

- New case assigned to an agent/queue.
- Case reassigned.
- Customer reply received on a case.
- SLA approaching warning threshold.
- SLA breached.
- Escalation applied.
- Case resolved or reopened.
- Case waiting too long in an unassigned queue.
- CSAT response received (authorized staff only).

Respect opt-outs and recipient ACL. Do not send internal notes to customers. Notification generation should be separated from transport delivery and deduplicated by event/recipient.

## 12.4 Audit and observability

- Audit create/update/delete where allowed, status transitions, assignment decisions, queue changes, SLA overrides/recalculations, escalations, merges, public replies, and publication changes.
- Track correlation IDs through API requests, background jobs, and email ingress.
- Metrics should include open-case count, unassigned age, backlog by queue, first response duration, resolution duration, SLA warning/breach count, email processing failures, and job lag.
- Logs should be structured and avoid unnecessary content/PII. Do not log raw email body or internal note content by default.
- Provide a safe admin-visible view for failed inbound messages or unassigned routing decisions where the generic operations tooling supports it.

---

## 13. Reporting and Dashboards

Reports must apply the same ACL as the underlying cases and cannot leak counts or customer data from inaccessible records.

### 13.1 Agent dashboard

- My open cases.
- My unassigned/triage queue if the user's role permits it.
- Cases awaiting my response.
- Cases waiting on customers.
- Cases close to SLA warning/breach.
- Recently updated cases and recent assignments.

### 13.2 Team lead dashboard

- Open cases by status, priority, category, source, queue, and assignee.
- Unassigned backlog and oldest unassigned case.
- SLA at-risk and breached cases.
- First-response and resolution time distribution.
- Reassignment count and queue workload balance.
- Escalations and reopened-case trend.

### 13.3 Service Desk management reports

- Case volume trend by day/week/month and channel.
- First-response and resolution SLA attainment.
- Backlog aging bands.
- Time spent waiting for customer vs. internal teams where reliable data exists.
- Case reopen rate and resolution code distribution.
- Queue/agent workload and assignment fairness indicators.
- CSAT average/distribution/response rate, if enabled.
- Knowledge article view/usefulness indicators only if instrumented with privacy-safe event data.

### 13.4 Metric definitions

Document metric definitions so dashboard totals can be reconciled:

- **First response:** time from case acceptance/creation to the first qualifying public agent response.
- **Resolution time:** time to a qualifying resolved event, clarifying whether it uses calendar or business time and how reopen cycles are handled.
- **SLA attainment:** eligible targets met divided by all eligible targets in the selected cohort; exclude NotApplicable with an explicit denominator rule.
- **Backlog:** cases in configured active states at the selected time; do not count closed/merged cases incorrectly.
- **CSAT:** only submitted valid surveys count in the score; show response count/rate alongside mean score.

Do not calculate historical SLA results solely from current mutable case fields if clock history is available. Any aggregate tables/projections must be rebuildable without destructive database reset.

---

## 14. Settings and Administration

Expose supported configuration through the established metadata/admin screens. Do not store arbitrary executable code in settings.

### 14.1 General settings

- Case number format/sequence strategy.
- Default case status, priority, source, and category.
- Resolution requirements and allowed reopen window.
- Default queue/team/assignee fallback.
- Portal visibility defaults and permitted request fields.
- Attachment limits and allowed types, inheriting global file-policy constraints.
- Retention options consistent with global retention policy.

### 14.2 Queue and routing settings

- Queue name/code, active state, Team/User members, default SLA, supported categories/channels, assignment strategy, routing rules, and fallback behavior.
- Only authorized ServiceDesk administrators can create/modify queues or routing behavior.
- Disable/delete operations must handle active cases safely: require a migration/reassignment choice or block until resolved. Never orphan cases silently.

### 14.3 SLA/calendar settings

- SLA policy priorities/order/effective dates/conditions.
- First response, next response, resolution targets, warning thresholds, pause rules, and escalation actions.
- Business-time schedules, time zones, holiday lists, and exception dates.
- Preview policy match against representative cases and optionally preview the impact of changing a policy.
- Require explicit confirmation for broad recalculation and record the actor, time, inputs, and result.

### 14.4 Knowledge Base and CSAT settings

- Publishing workflow and portal scope.
- Article expiry and locale behavior.
- CSAT scale, invitation delays, response window, privacy threshold, and reminder policy where enabled.

### 14.5 Operational settings

- Inbound mailbox to queue mapping.
- Mail-threading fallback behavior and unmatched-email queue.
- Retry policies and alert thresholds within safe supported bounds.
- Public form rate limits and anti-abuse providers if enabled.
- External integration toggles and credentials must use the platform's secret management mechanism; never store secrets in ordinary metadata.

---

## 15. Testing Strategy

Follow `AGENTS.MD` exactly. Tests must not create another database, schema, container, or persistent volume. Inspect existing scripts for resets before running any database-backed test.

## 15.1 Unit tests

At minimum:

- Case transition graph and authorization decision points.
- Case-number allocation abstraction and uniqueness handling.
- Routing conditions, round-robin cursor update, least-busy ordering, and fallback behavior.
- SLA policy matching and precedence.
- Business-time calculations across weekends, holidays, overnight shifts, time zones, daylight-saving transitions, and pauses.
- First-response/next-response/resolution clock semantics and reopening behavior.
- Public/internal message visibility serialization.
- Email threading/idempotency key generation and loop detection.
- CSAT token expiry, single-use behavior, and duplicate submission handling.
- Case merge invariant and no duplicate side effects.
- Portal projection allowlist and prohibited-field filtering.

## 15.2 Repository and database integration tests

Use the existing configured primary database for targeted, safe checks when appropriate:

- Additive migrations apply and preserve unrelated data.
- Case number uniqueness holds under concurrent creates or simulated collisions.
- Required foreign keys, constraints, indexes, and relations behave correctly.
- Queue membership uniqueness and assignment update behavior are correct.
- SLA clock lifecycle persists target and pause history consistently.
- Email-message idempotency constraints prevent duplicate processing.
- Authorization predicates are applied before pagination/count aggregation.
- Test rows use `AGENT_TEST_` or a unique run marker and cleanup uses exact IDs created by the current run.

If a test would require a destructive reset or a new database, do not run that mode; replace it with an equivalent safe test path and document the limitation.

## 15.3 API tests

- CRUD/list/search/filter/sort/pagination.
- Invalid status/priority/category and prohibited transitions.
- Unauthorized list/detail/assignment/resolve/merge operations.
- Portal cross-account isolation and ID enumeration resistance.
- Portal reply and attachment visibility.
- Internal note cannot leak through portal API, email, search, reports, notifications, or related-record expansions.
- Duplicate inbound email does not duplicate cases/messages.
- Mail provider failure is retryable without duplicate outbound mail.
- SLA recalculation requires permission, bounded scope, audit, and confirmation.
- Optional module integrations degrade gracefully when dependencies are disabled.

## 15.4 Frontend tests

- Case create/edit/detail/list and state-transition controls.
- Clear public-vs-internal composer mode and attachment inheritance.
- Agent queue and SLA warning presentation.
- Portal case list/detail/create/reply and public-only timeline.
- KB internal/portal filters.
- Responsive and accessible keyboard/screen-reader paths for core operations.

## 15.5 End-to-end acceptance scenarios

1. An authenticated agent creates a case for an existing Account/Contact, assigns it, adds an internal note, sends a public reply, resolves it, and sees a complete audit history.
2. A portal user submits a case and can view/reply to it but cannot modify its assignee, queue, SLA, or internal fields.
3. A second portal user from another Account cannot access the case even when given its ID or case number.
4. A duplicate inbound email is processed twice by the worker but produces exactly one case/message.
5. A customer reply to an existing email thread is attached to the correct case and updates the correct response/SLA timestamps.
6. A case approaching an SLA target creates one warning action; the scheduled job retry does not duplicate the notification.
7. A breached SLA produces an audit-visible escalation according to the configured policy, without changing closed cases unexpectedly.
8. A policy pause/resume and reopen cycle preserve historical clock intervals and apply the documented timing rule.
9. A portal user can search published KB articles but cannot see drafts, expired articles, or internal-only documents.
10. An internal note and its attachment remain invisible to the portal and customer email under all tested APIs.
11. If Sales, Projects, or CustomerSuccess are disabled, core ServiceDesk CRUD, routing, and SLA features continue working.
12. Test cleanup removes only records created by the test run; existing business data remains unchanged.

---

## 16. Performance, Reliability, and Scalability

- Paginate all case, message, KB, queue, and history lists.
- Use cursor/keyset pagination for large timelines when the existing API supports it.
- Add indexes only for demonstrated query paths and verify important query plans.
- Avoid N+1 queries for Account, Contact, assignee, queue, SLA, and unread-message decorations.
- Do not load full mail bodies or all attachments just to render the case list.
- Batch SLA scans with bounded limits and indexed due-time predicates. Avoid scanning every case on every tick.
- Use a concurrency/lease mechanism supported by the job infrastructure to prevent overlapping expensive SLA scans.
- Separate mail ingestion, parsing, case command transactions, and outbound delivery through queued jobs/outbox when available.
- Bound MIME size, body size, attachment count, routing-rule complexity, public intake volume, and survey response rate.
- Apply cache invalidation when queue membership, ACL, portal visibility, KB publication state, or SLA policy changes.
- Ensure reports use bounded date ranges and appropriate aggregates. Do not introduce denormalized projections until measurements justify them.
- Record baseline timing for common operations: case create, list, detail timeline, reply, assignment, SLA batch, and portal list/detail.

### Initial service targets

Treat these as engineering goals to validate against the real deployment profile, not universal guarantees:

- Common case list/detail requests should remain responsive under normal indexed data volumes.
- Case creation and transition operations should not wait for email transport or external integrations.
- A retrying background job must not generate duplicate customer-visible effects.
- SLA warning/breach detection should run frequently enough to meet the configured service policy and expose its last successful scan time.
- Queue/agent dashboards should use bounded, indexed queries and respect the caller's data scope.

Record measured results and environment assumptions in `docs/implementation/service-desk-performance.md` before a production-scale claim is made.

---

## 17. Installation, Upgrade, and Module Lifecycle

- Register the module in the existing module registry/manifest system with the exact name `ServiceDesk`.
- Use the repository's existing directory and package conventions; suggested frontend slug is `service-desk`.
- Add settings, metadata, routes, ACL definitions, jobs, event subscribers, and UI menu entries through existing platform registration mechanisms.
- Module disablement must not delete Cases, messages, SLA histories, or KB content. It may disable new automation and hide the menu while leaving records available through safe administration/API mechanisms defined by the platform.
- Migrations must be versioned, additive by default, and safe to apply once.
- Module activation must not create duplicate default statuses, queues, templates, or SLA policies on repeated runs.
- Upgrade logic must preserve user-defined configuration and must not overwrite customized routing/SLA policies.
- If a required dependency is missing, activation should provide a clear diagnostic and disable only dependent functionality rather than breaking the whole CRM.
- Document backup/restore implications for Case records, attachments, mail-ingress idempotency, queue state, SLA clock history, and CSAT tokens/responses.

---

## 18. Documentation Deliverables

The implementation must create or update:

- `docs/implementation/service-desk-audit.md` — initial repository audit and feature contract.
- `docs/compatibility/service-desk.md` — baseline behaviors, project-specific enhancements, deviations, and source references.
- `docs/modules/service-desk/README.md` — module overview and developer setup.
- `docs/modules/service-desk/case-lifecycle.md` — statuses, transitions, resolution/reopen/merge semantics.
- `docs/modules/service-desk/assignment-and-queues.md` — assignment algorithms, configuration, fallback rules, and audit behavior.
- `docs/modules/service-desk/sla.md` — policy model, business time, pauses, reopen cycles, recalculation, and metric definitions.
- `docs/modules/service-desk/email-to-case.md` — mailbox configuration, threading, retries, loop prevention, and troubleshooting.
- `docs/modules/service-desk/portal-security.md` — portal record scope and public/internal isolation.
- `docs/modules/service-desk/knowledge-base.md` — publication and portal visibility rules if KB functionality is included or extended.
- `docs/modules/service-desk/api.md` or OpenAPI updates — endpoints, DTOs, permissions, errors, and examples.
- `docs/modules/service-desk/operations.md` — jobs, retry handling, monitoring, and failed-ingress operations.
- `docs/modules/service-desk/testing.md` — safe test commands and test-data cleanup rules.
- `docs/implementation/service-desk-performance.md` — measurements and query/index notes.

Only document behavior that is actually implemented. Mark planned behavior as planned rather than presenting it as available.

---

## 19. Implementation Roadmap — Phase 19-SD

Implement one sub-phase at a time. Do not ask the agent to generate the entire module in a single pass. At the end of each sub-phase, record changed files, migrations, tests run, tests skipped, outcomes, and remaining blockers.

### Phase 19-SD.0 — Repository Audit and Feature Contract

**Goal:** Establish the actual current codebase baseline before coding.

Tasks:

1. Read `AGENTS.MD`, `PLAN.md`, and the completed `Projects`, `Sales`, and `CustomerSuccess` plans.
2. Inspect the module registry, Entity Engine, metadata, ACL, API, migration runner, frontend routes, tests, mail, Stream, attachment, portal, Knowledge Base, Jobs, Workflow/BPM, notifications, reports, and search.
3. Check whether a canonical Case/ticket entity already exists; inspect schema, metadata, APIs, relations, UI, and access behavior.
4. Identify reusable mail-to-case and public/internal Stream capabilities.
5. Identify how existing modules declare names, classes, package paths, route slugs, events, config, and migrations. Ensure this module has no `Ua` prefix.
6. Inspect all test commands and hooks for database creation/reset/destructive cleanup.
7. Write the audit and feature-contract document with P0/P1/P2 dependencies and a short implementation sequence.

**Acceptance criteria:**

- Audit reflects inspected source files, not assumptions from plans.
- The canonical Case-entity decision is documented.
- Reuse/extension decisions are recorded for Portal, Email, Stream, Attachments, and Knowledge Base.
- Module naming is explicitly `ServiceDesk`, without a prefixed alias.
- The safe test path uses the existing configured database and cannot reset it.
- No application code or database schema is changed during this sub-phase unless correcting a documentation-only issue is required.

### Phase 19-SD.1 — Module Scaffold, Registration, and Metadata

**Goal:** Register the smallest valid `ServiceDesk` module.

Tasks:

1. Create module entrypoint and manifest using repository conventions.
2. Register metadata, menu/nav entries, API routes, ACL scopes, settings, event subscribers, and jobs only through supported registries.
3. Add disabled-capability behavior for optional Portal/Email/KB/Workflow/Reports dependencies.
4. Add module smoke test and a module documentation stub.
5. Validate that module registration is idempotent and does not override configuration from other modules.

**Acceptance criteria:**

- Module loads without circular dependencies.
- Naming across manifest, class, routes, events, and docs follows `ServiceDesk`/`service-desk` conventions and does not use the `Ua` prefix.
- No duplicate shared services or unrelated refactors are introduced.
- Disabled optional dependencies do not prevent core CRM startup.

### Phase 19-SD.2 — Additive Persistence and Default Configuration

**Goal:** Add only the missing ServiceDesk persistence and configuration foundations.

Tasks:

1. Confirm existing tables/entities and migration versions.
2. Add only required tables/metadata for queues, routing, SLA policy versions, SLA clocks, business calendars, mail-idempotency mappings, and other not-yet-supported records.
3. Extend an existing Case entity or create one canonical Case entity based on the audit.
4. Add required indexes, uniqueness constraints, and foreign-key behavior.
5. Add idempotent defaults for statuses, priorities, minimal settings, and other configuration where repository conventions expect defaults.
6. Review all migration SQL and seed behavior before applying.

**Acceptance criteria:**

- Migration is additive and safe to run once through the official runner.
- Re-running module activation does not duplicate configuration.
- Existing CRM/business records are preserved.
- No test DB/schema/container is created.
- Entity metadata and database constraints agree.

### Phase 19-SD.3 — Case CRUD, Numbering, and Domain Validation

**Goal:** Deliver a usable canonical Case entity and stable API.

Tasks:

1. Implement metadata and standard fields/relations.
2. Implement transaction-safe case number allocation.
3. Add create/read/update/list/search/filter/sort/pagination through the standard Entity Engine.
4. Add validation for required subject, classification, requester, and related CRM IDs.
5. Add record/field ACL checks and safe serialization.
6. Add audit/history and standard case views.

**Acceptance criteria:**

- Authorized users can create, list, inspect, and update permitted cases.
- Number collisions are prevented under concurrent writes.
- Generic APIs do not allow unauthorized fields or relations to be modified.
- Search, counts, pagination, and exports respect ACL.

### Phase 19-SD.4 — Case State Machine and Resolution Workflow

**Goal:** Implement explicit status transition commands.

Tasks:

1. Define allowed transitions and terminal/reopen states.
2. Implement resolve, close, reopen, cancel, and standard status commands.
3. Validate resolution requirements and actor permissions.
4. Record transition history and domain events.
5. Update UI controls and errors to match the server-side transition model.

**Acceptance criteria:**

- Invalid transitions fail predictably and do not partially update records.
- Prior resolution/reopen cycles remain auditable.
- Transition side effects are idempotent where retries are possible.

### Phase 19-SD.5 — Assignment, Teams, Queues, and Routing

**Goal:** Make operational ownership reliable.

Tasks:

1. Implement queue configuration and queue membership only if no existing abstraction covers them.
2. Implement manual assignment and team assignment.
3. Add round-robin and least-busy algorithms in bounded, testable services.
4. Implement deterministic routing-rule precedence and safe fallback.
5. Add assignment history and workload API/view.
6. Prevent assignment to inactive or ineligible agents.

**Acceptance criteria:**

- No case can be dropped when a queue has no eligible member.
- Concurrent assignment does not corrupt round-robin cursor state.
- Assignment rules are declarative and never execute arbitrary stored code.
- Access and notifications reflect the new assignment.

### Phase 19-SD.6 — Conversation Timeline, Public Replies, and Internal Notes

**Goal:** Deliver secure case communication within the CRM.

Tasks:

1. Reuse the generic Stream/conversation service.
2. Implement or extend an explicit visibility model for public, internal, and system entries.
3. Add public-reply and internal-note API commands.
4. Integrate attachment visibility with its parent message/case.
5. Build a clear composer and timeline UI.
6. Add notifications with event/recipient idempotency.

**Acceptance criteria:**

- Agents can create public and internal entries according to permission.
- Portal/public APIs can never return internal content or attachments.
- Internal notes do not count as public responses for SLA metrics.
- The UI makes posting mode unambiguous.

### Phase 19-SD.7 — Email-to-Case Ingestion and Outbound Replies

**Goal:** Make email a reliable channel where the platform's email capability is available.

Tasks:

1. Integrate with existing mailbox/IMAP/polling/ingress pipeline.
2. Configure mailbox-to-queue mapping and fallback for unrecognized email.
3. Parse and normalize email safely; preserve thread identity and message processing markers.
4. Create cases for new threads and append replies to matching cases.
5. Implement outbound customer replies with correct threading and group reply address.
6. Add retry, idempotency, loop prevention, attachment validation, and failure visibility.

**Acceptance criteria:**

- A repeated inbound delivery cannot create duplicate case/message records.
- Replies attach to the correct case when reliable thread identity is available.
- Ambiguous thread matches are routed for review, not guessed.
- Tests use a fake mail transport and send no live email.

### Phase 19-SD.8 — Business Calendars and SLA Policy Engine

**Goal:** Compute reliable first-response, next-response, and resolution targets.

Tasks:

1. Reuse a shared working-time calendar or implement a narrow timezone-aware abstraction.
2. Add SLA policy conditions, ordering, versioning, and effective dates.
3. Implement business-time deadline calculation and clock persistence.
4. Implement target-specific pause/resume/met/breach behavior.
5. Add safe policy matching and case-level SLA display.
6. Add administrative preview/recalculation design.

**Acceptance criteria:**

- Calculation tests cover weekends, holidays, time zones, shift boundaries, pauses, and reopen cycles.
- Historical target clocks remain reproducible.
- Policy updates do not silently rewrite live/historical targets.
- Missing or invalid policies have defined safe behavior.

### Phase 19-SD.9 — SLA Jobs, Warnings, Escalations, and Notifications

**Goal:** Turn SLA clocks into operational actions.

Tasks:

1. Add bounded scheduled scanning through the existing job scheduler.
2. Implement warning/breach threshold tracking and idempotent escalation actions.
3. Notify agents/team leads based on queue and policy configuration.
4. Record escalation history and operator-visible failures.
5. Make jobs safe under retries, overlaps, and concurrent case transitions.

**Acceptance criteria:**

- Repeated job execution does not generate duplicate warning/escalation notifications.
- A failed notification does not erase SLA breach state.
- Closed/merged cases are not unexpectedly escalated.
- Job health/last successful scan is observable.

### Phase 19-SD.10 — Knowledge Base Integration and Article Lifecycle

**Goal:** Relate support cases to searchable, customer-safe knowledge.

Tasks:

1. Reuse existing Knowledge Base if present; create the minimal article capability only if the audit proves it is absent and in scope.
2. Implement article-case relationship and agent-side related/suggested articles.
3. Enforce draft/review/published/expired lifecycle and portal visibility.
4. Add category/search/editor UI within the existing metadata and design system.
5. Add publication audit and expiry behavior.

**Acceptance criteria:**

- Agents can relate a permitted article to a case.
- Portal search cannot expose drafts, expired articles, or internal-only content.
- Publication transitions and expiry are audited.
- There is no duplicate Knowledge Base implementation when one already exists.

### Phase 19-SD.11 — Portal Case Lifecycle and Customer-Safe Attachments

**Goal:** Give portal users a safe self-service support experience.

Tasks:

1. Extend existing Portal/Portal Roles scope and navigation.
2. Implement portal case list/detail/create/reply and allowed state behavior.
3. Derive customer Account/Contact from portal identity and enforce scope at query time.
4. Add portal-safe response DTOs and attachment authorization.
5. Integrate KB search and public notification templates.
6. Add security tests for cross-account isolation and ID enumeration.

**Acceptance criteria:**

- Portal user can only see and act on permitted cases.
- Internal fields, notes, files, routing, and SLA configuration are never exposed.
- Customer-created cases cannot set privileged internal fields.
- Portal features reuse existing authentication and ACL infrastructure.

### Phase 19-SD.12 — Web-to-Case and Public Intake Protections

**Goal:** Add optional controlled intake from public forms/integrations.

Tasks:

1. Implement a dedicated endpoint with a strict field allowlist.
2. Add request-size/rate controls and approved anti-abuse checks.
3. Set source, queue, status, priority, and policy server-side.
4. Add safe acknowledgement and correlation tracking.
5. Test malformed, spam-like, oversized, and repeated submissions.

**Acceptance criteria:**

- Public clients cannot use the generic entity API to assign privileged fields.
- Abuse controls prevent uncontrolled case creation.
- Repeated safe idempotent submissions do not create duplicates.
- Errors do not disclose internal customer records.

### Phase 19-SD.13 — Case Workspace, Inbox, and Operator UI

**Goal:** Deliver efficient day-to-day agent workflows.

Tasks:

1. Complete case list/detail/create/edit surfaces.
2. Add queue inbox, assignment actions, quick transitions, and SLA indicators.
3. Add filters, saved views, related CRM panels, audit/history, and accessible keyboard navigation.
4. Add loading, empty, forbidden, stale-update, and transport-failure states.
5. Verify responsive layout and localization.

**Acceptance criteria:**

- Agents can triage, assign, reply, transition, and resolve cases without unsafe UI shortcuts.
- Every action is enforced by the API and reconciles after stale/conflicting writes.
- SLA indicators have accessible text and documented semantics.

### Phase 19-SD.14 — Reopen, Duplicate Detection, Merge, and CSAT

**Goal:** Complete important service-operations workflows.

Tasks:

1. Harden reopen behavior and preserve resolution cycles.
2. Add configurable duplicate candidates with explicit human confirmation.
3. Add an auditable merge command if supported by the chosen canonical entity and relationship model.
4. Add CSAT invitation/response lifecycle if no reusable survey module exists.
5. Implement token hashing/expiry, duplicate submission protection, privacy-safe reporting, and fake email integration tests.

**Acceptance criteria:**

- Reopen and merge preserve source history and prevent duplicate side effects.
- Merge cannot be performed without permission and explicit target selection.
- CSAT tokens do not reveal records and cannot be reused beyond policy.
- Tests send no actual survey emails.

### Phase 19-SD.15 — Dashboards, Reports, and Saved Views

**Goal:** Give agents, team leads, and admins actionable service visibility.

Tasks:

1. Add agent and team-lead dashlets using existing dashboard/report systems.
2. Implement documented case-volume, SLA, backlog, response/resolution, reopen, escalation, and CSAT metrics.
3. Enforce row-level ACL before aggregation or counting.
4. Add bounded date filters and index/query review.
5. Document metric definitions and any known limitations.

**Acceptance criteria:**

- Counts and aggregates match the documented definitions.
- Reports do not leak inaccessible case counts or customer details.
- Dashboards remain bounded and performant against the existing query infrastructure.

### Phase 19-SD.16 — Workflow/BPM and Cross-Module Integration

**Goal:** Enable controlled automations and related-record context.

Tasks:

1. Publish ServiceDesk domain events through the existing event mechanism.
2. Add workflow/BPM triggers/actions only through existing capabilities.
3. Add optional links to Projects, Sales, and CustomerSuccess through guarded relations/contracts.
4. Handle missing/disabled modules and failed consumers safely.
5. Document integration contracts and event payloads.

**Acceptance criteria:**

- No circular dependency is introduced.
- Core ServiceDesk works with optional modules disabled.
- Workflow retries do not duplicate case updates, notifications, tasks, or external side effects.
- ServiceDesk does not mutate Sales financial state or CustomerSuccess scoring internals directly.

### Phase 19-SD.17 — Security, Performance, and Reliability Hardening

**Goal:** Close cross-cutting gaps before compatibility review.

Tasks:

1. Run the full authorization and public/internal isolation matrix.
2. Review attachment access, public intake, email parsing, survey token handling, and XSS protections.
3. Review migrations, indexes, query plans, N+1 behavior, pagination, job batch sizes, retries, and concurrency controls.
4. Verify logs contain no secrets or excessive customer data.
5. Verify behavior on job retry, worker restart, mail-provider outage, and optional module unavailability.
6. Record measured performance and operational troubleshooting steps.

**Acceptance criteria:**

- Required security tests pass.
- No test mode resets/recreates the configured database.
- No known high-severity public/internal data-leak path remains.
- Background tasks are observable, bounded, and idempotent.

### Phase 19-SD.18 — Compatibility Review, Documentation, and Release Gate

**Goal:** Verify the end-to-end module and close documentation gaps.

Tasks:

1. Compare implemented baseline workflows with the documented Case Management, email, Knowledge Base, and Portal reference behavior.
2. Review every item in this plan and mark Implemented, Deferred, Not Applicable, or Blocked with evidence.
3. Run lint/typecheck/unit/API/UI checks and safe integration tests according to `AGENTS.MD`.
4. Verify module install/enable/disable and upgrade behavior.
5. Verify OpenAPI and all required docs are current.
6. Produce a release checklist with actual test commands and outcomes.

**Acceptance criteria:**

- P0 acceptance scenarios pass.
- P1 behavior is implemented or explicitly listed as a known gap before calling the release operationally complete.
- No duplicate Case/Knowledge Base/portal/email infrastructure was introduced unintentionally.
- The module name is consistently `ServiceDesk` without a `Ua` prefix.
- Release documentation distinguishes verified behavior from deferred roadmap items.

---

## 20. Release Gates and Priorities

### P0 — Required for a usable first release

- Module registered as `ServiceDesk` with no prefix.
- Canonical Case entity with numbering, metadata, CRUD, list/detail, and ACL.
- State machine, transition history, resolution, close, and reopen basics.
- Manual assignment to users/teams.
- Secure case timeline with public replies and internal notes.
- Attachment visibility tied to message visibility.
- Notifications for assignment and public replies through existing infrastructure.
- Audit history and API/OpenAPI coverage.
- Tests proving no public/internal data leak and no test database creation.

### P1 — Required for operational Service Desk

- Queues, routing rules, round-robin/least-busy assignment, and fallback handling.
- Email-to-case and outbound replies with threading/idempotency, where mail infrastructure is available.
- Portal case management using existing portal authentication and roles.
- Business-time SLA policy engine, clocks, pause/resume, warnings, and escalation jobs.
- Knowledge Base relation/search and portal-safe article visibility.
- Agent and team-lead dashboards plus core service metrics.

### P2 — Advanced functionality

- Protected web-to-case form.
- Duplicate detection and merge workflow.
- CSAT surveys.
- Advanced queue/skills routing and workload views.
- Automated KB suggestions and useful-article feedback.
- Advanced report aggregates and deeper integrations with Projects, Sales, and CustomerSuccess.

### Definition of Done for every sub-phase

- Implementation follows the audited repository conventions.
- New code is scoped to the current sub-phase and avoids unrelated refactors.
- Type checks/lint/tests relevant to the change have been run; skipped checks are documented.
- API and UI changes have tests and OpenAPI/metadata updates where applicable.
- Authorization and privacy behavior are verified server-side.
- Migrations are reviewed, additive by default, and safely applied only when appropriate.
- Existing user data is preserved; tests use exact identifiers for their own records.
- No additional test database/schema/container is created.
- Documentation reflects actual behavior and known limitations.
- The agent reports files changed, commands run, results, and unresolved issues honestly.

---

## 21. Final Acceptance Checklist

### Architecture and naming

- [ ] `ServiceDesk` is registered using the project's established module loader.
- [ ] No `Ua` prefix is introduced for the module, class, package, events, configuration identifiers, or new docs.
- [ ] Domain logic lives in services and policies, not controllers or React components.
- [ ] Existing metadata, Entity Engine, ACL, audit, mail, Stream, files, jobs, portal, and reporting services are reused where available.
- [ ] No duplicate generic infrastructure or unintended duplicate Case/Knowledge Base entity exists.

### Core workflow

- [ ] Case create/list/detail/update works under ACL.
- [ ] Case numbers remain unique under concurrent writes.
- [ ] Valid transitions work and invalid transitions are rejected.
- [ ] Assignment, queue fallback, resolution, close, and reopen are auditable.
- [ ] Public replies and internal notes are visibly and technically separate.
- [ ] Attachments inherit correct access from their case/message.

### Channels and SLA

- [ ] Email-to-case is idempotent and safely threaded where implemented.
- [ ] Customer portal enforces Account/Contact scope for all reads and writes.
- [ ] SLA clocks use the documented target definitions, time zone, business calendar, and pause rules.
- [ ] Warnings and escalation jobs are idempotent and observable.
- [ ] KB public results contain only published and authorized content.
- [ ] Public intake is rate-limited and accepts only allowed fields if implemented.
- [ ] CSAT tokens are expiring, single-use, and privacy-safe if implemented.

### Quality and operations

- [ ] Unit, API, security, repository, and UI tests cover the implemented scope.
- [ ] Tests do not create a second database or run destructive cleanup.
- [ ] Migrations preserve existing records and follow the official runner.
- [ ] Reports and dashboards enforce ACL before aggregation.
- [ ] Job retry, service restart, email outage, and missing optional modules have safe outcomes.
- [ ] Documentation, OpenAPI, compatibility notes, and release checklist are updated.

---

## 22. Reference Links

Use these references to define observable behavior and platform integration contracts. The project implementation remains an independent TypeScript reimplementation.

1. EspoCRM Case Management — https://docs.espocrm.com/user-guide/case-management/
2. EspoCRM Emails and Email-to-Case — https://docs.espocrm.com/administration/emails/
3. EspoCRM Knowledge Base — https://docs.espocrm.com/user-guide/knowledge-base/
4. EspoCRM Portal — https://docs.espocrm.com/administration/portal/
5. EspoCRM Roles Management — https://docs.espocrm.com/administration/roles-management/
6. EspoCRM Workflows — https://docs.espocrm.com/administration/workflows/
7. EspoCRM Modules — https://docs.espocrm.com/development/modules/
8. EspoCRM Metadata — https://docs.espocrm.com/development/metadata/
9. EspoCRM API — https://docs.espocrm.com/development/api/
10. EspoCRM Hooks — https://docs.espocrm.com/development/hooks/
11. EspoCRM Scheduled Jobs — https://docs.espocrm.com/development/scheduled-job/
12. EspoCRM Attachments — https://docs.espocrm.com/development/attachments/
13. EspoCRM Working-Time Calendar — https://docs.espocrm.com/user-guide/working-time-calendar/

