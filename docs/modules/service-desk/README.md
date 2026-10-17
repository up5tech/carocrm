# Service Desk module (Phase 19-SD)

Implemented in `apps/api/src/service-desk` (backend), registered once in `apps/api/src/app.module.ts`,
with metadata in `database/seed-metadata.ts` and four additive migrations,
`database/migrations/033_phase19_service_desk.sql`,
`database/migrations/034_phase19_service_desk_workflow.sql`,
`database/migrations/035_phase19_service_desk_conversation.sql` and
`database/migrations/036_phase19_service_desk_hardening.sql`. Functional reference: the documented
product requirements in [`PLAN_Phase_19_ServiceDesk.md`](../../PLAN_Phase_19_ServiceDesk.md),
reproduced as clean-room TypeScript behaviour — no upstream source, asset, translation or schema is
copied.

**Status: phases 19-SD.0 – 19-SD.18 are implemented and verified (release gate passed).** The list of
phases claimed is `SERVICE_DESK_MODULE.implementedPhases`
(`apps/api/src/service-desk/service-desk-module.ts`), which `/api/v1/ServiceDesk/action/health`
reports. The optional feature flags remain **off by default** so a fresh installation gets working
case management without the mail, portal, Knowledge Base or survey infrastructure enabled; the
settings endpoint refuses nothing but the health endpoint reports each dependency's real state.

| Read next | What it answers |
|---|---|
| [../../implementation/service-desk-audit.md](../../implementation/service-desk-audit.md) | the 19-SD.0 audit: what the repository already offered and the decisions taken |
| [../../implementation/service-desk-release.md](../../implementation/service-desk-release.md) | release checklist with every phase's status and the commands actually run |
| [case-lifecycle.md](case-lifecycle.md) | statuses, transitions, resolution/reopen/merge semantics |
| [assignment-and-queues.md](assignment-and-queues.md) | assignment algorithms, queues, routing and audit |
| [sla.md](sla.md) | policy model, business time, pauses, reopen cycles and metrics |
| [email-to-case.md](email-to-case.md) | mailbox ingestion, threading, idempotency and replies |
| [portal-security.md](portal-security.md) | portal scope, field projection and public/internal isolation |
| [knowledge-base.md](knowledge-base.md) | article lifecycle and portal-safe visibility |
| [api.md](api.md) | the module command surface |
| [operations.md](operations.md) | jobs, retries, monitoring and failed-ingress operations |
| [testing.md](testing.md) | safe test commands and test-data cleanup rules |
| [compatibility.md](compatibility.md) | deviations from the plan wording and known limitations |
| [`PLAN_Phase_19_ServiceDesk.md`](../../PLAN_Phase_19_ServiceDesk.md) | the full product scope and acceptance criteria |

## What it gives a user

| Capability | Where |
|---|---|
| One canonical support case (`Case`) with subject, classification, requester and ownership | `GET/POST /api/v1/Case`, the generic Entity Engine |
| A transaction-safe, unique case number allocated at creation | Postgres sequence `service_desk_case_number_seq`; `GET /api/v1/ServiceDesk/action/caseNumberPreview` previews the next one |
| Server-owned fields a client cannot forge (case number, timeline stamps, SLA summary, escalation state) | `beforeValidate` write guard (`service-desk-write-guard.service.ts`) |
| A case must carry a requester: a CRM record (Account/Contact/Lead) or a channel-supplied name/email | the same write guard |
| List, search, filter, sort, pagination, export, stream, audit and record/field ACL | the generic Entity Engine and `AclApiService`, reused unchanged |
| Validated module settings (numbering prefix/padding, defaults, resolution requirement, optional feature flags) | `GET/POST /api/v1/ServiceDesk/action/settings` |
| The case **state machine**: `start`, `setPendingCustomer`, `setPendingInternal`, `escalate`, `deEscalate`, `resolve`, `close`, `reopen`, `cancel` — server-validated, atomic, with history and domain events | `POST /api/v1/ServiceDesk/action/case/:id/{transition,resolve,close,…}`; `GET …/capabilities`; `GET …/history` |
| **Assignment, queues and routing**: manual/team assignment, round-robin, least-busy, declarative routing rules with safe fallback | `POST /api/v1/ServiceDesk/action/case/:id/{assign,route}`; `GET …/assignments`; `GET /action/queues`, `GET /action/queues/:id/workload` |
| Case-lifecycle and queue-workload UI | `apps/web/src/components/CaseLifecycleActions.tsx`, `CaseQueueWorkload.tsx`, rendered by `EntityDetailPage.tsx` |
| **Conversation timeline** (§5.4, SD.6): explicit public/internal/system visibility on every Stream item and attachment; `reply` (customer-visible) and `note` (internal-only) commands; visibility-safe timeline; attachments inherit their message's visibility; public replies stamp the response clocks, internal notes never do; in-app notifications for public replies (dedup by message/recipient) | `apps/api/src/service-desk/case-conversation.service.ts`; `apps/api/src/stream/stream-visibility.ts`; `apps/web/src/components/CaseConversation.tsx` |
| **Email-to-Case** (§5.5, SD.7): inbound email processing into a `Case` (new thread) or appended as a customer-visible message (existing thread); idempotent by `messageId`/thread key; mail-loop/auto-reply/DSN skipping; contact resolution; outbound email reply command that queues a send through the kernel mail transport and records delivery status | `apps/api/src/service-desk/email-to-case.service.ts` |
| **Business calendars & SLA** (§5.6, §5.7, SD.8): `BusinessCalendar` (timezone, weekly intervals, holidays), `SLAPolicy` (declarative conditions, first/next/resolution targets, warning thresholds, pause rules, version), `CaseSLAClock` (per-case/per-target, start/pause/resume/met/breached), timezone-aware business-time calculator, policy resolver, idempotent breach-check pass, Case-level `slaState`/`slaPolicyId` summary | `apps/api/src/service-desk/sla.service.ts` |
| **Scheduled SLA operations** (SD.9): `serviceDesk.slaScan` runs every five minutes through the `scheduled_jobs` table; the worker calls the worker-authorised `/action/sla/run-scheduled-check`; warning thresholds fire once per clock, breach notifications and escalation are deduplicated, and closed/merged cases are never escalated | `database/seed.ts`, `apps/worker/src/handlers/service-desk-handlers.ts`, `SlaService.runScheduledCheck` |
| **Knowledge Base** (SD.10): `KnowledgeArticle`/`KnowledgeCategory`, publish/archive, audited publication status, scheduled expiry sweep, portal-safe published list and case suggestions | `apps/api/src/service-desk/knowledge-base.service.ts` |
| **Portal self-service** (SD.11): the seeded portal role reads only the contact/account neighbourhood, internal fields are projected out by field ACL, customers create cases (source forced to `Portal`, requester derived), reply through the public-only stream and see published KB suggestions; a token-based CSAT page is available without a CRM session | `database/seed.ts`, `apps/web/src/components/PortalCaseConversation.tsx`, `apps/web/src/pages/PortalCsatPage.tsx` |
| **Web-to-Case** (SD.12): unauthenticated intake endpoint with a strict allowlist, honeypot, per-IP rate limit and idempotency key that returns only the reference number | `apps/api/src/service-desk/web-to-case.service.ts` |
| **Duplicate detection, merge and CSAT** (SD.14): ACL-filtered candidates, an atomic merge command that requires edit access, records a `merge` transition and emits an event, and hashed single-use expiring survey tokens | `case-merge.service.ts`, `csat.service.ts` |
| **ACL-scoped metrics** (SD.15): one aggregate endpoint for volume, active backlog, unassigned, breached, escalated, reopen rate, status/priority/source buckets and CSAT (CSAT only for read-all roles); every count uses the same record predicate as the case list | `GET /api/v1/ServiceDesk/action/metrics`, `service-desk-metrics.service.ts` |
| **Workflow/BPM events** (SD.16): `serviceDesk.case.{created,assigned,statusChanged,resolved,closed,reopened,escalated,replySent,noteAdded,slaBreached,merged}` are published through the platform outbox, and the Customer Success `support` health signal scores from the account's cases | `apps/api/src/service-desk/*.service.ts`, `apps/api/src/customer-success/customer-success-signals.ts` |
| Module diagnostics: dependency evidence, optional-integration status, feature state, settings warnings | `GET /api/v1/ServiceDesk/action/health` |

Entity CRUD stays on the generic `/api/v1/:entity` API. The module routes exist only for what a
single record cannot express: diagnostics, settings, numbering preview, ACL-scoped metrics, the case
state machine, assignment/routing, the conversation commands, mail ingestion/replies, SLA scans,
Knowledge publication and CSAT/merge commands.

## The `Case` entity

Registered in `database/seed-metadata.ts`, stored in the generic `entity_records` table. `name` is
the case **subject** (label "Subject", the display field), so lists and stream posts read what an
agent recognises. Fields:

- **Identity/content**: `caseNumber` (server-allocated), `name` (Subject), `description`.
- **Classification** (§5.1): `status`, `priority`, `severity`, `type`, `source` — configurable enums.
- **Requester**: `accountId`, `contactId`, `leadId`, `requesterName`, `requesterEmail`.
- **Timing** (§6.1, server-owned): `lastActivityAt`, `firstResponseAt`, `lastCustomerResponseAt`,
  `lastAgentResponseAt`, `resolvedAt`, `closedAt`, `reopenedAt`.
- **SLA summary / escalation** (§5.6, §5.7, server-owned): `slaPolicyId`, `slaState`, `isEscalated`,
  `escalationLevel`, `escalatedAt`.
- **Resolution**: `resolutionCode`, `resolutionSummary`, `resolvedById`, `isHiddenFromPortal`.
- **Routing/ownership** (§5.3, SD.5, server-owned): `queueId`, `teamId`, `routingRuleId` — set only
  through the assignment/routing commands, never by the record API.
- **Merge** (SD.14, server-owned): `mergedIntoCaseId` — written only by the merge command.

Relations: activity links (`emails`, `calls`, `meetings`, `tasks`) through `entity_links`, and
`Account.relations.cases` / `Contact.relations.cases` on the other side. Audit, stream and field ACL
come from the platform; the entity declares `acl.permissions.Case` defaults (`read: all`,
`edit/delete/stream: own`) that an administrator narrows or widens per role.

## Configuration and history records

SD.5 adds four metadata records, all in `entity_records`, so configuration is listable, auditable and
importable through the generic API like any entity:

- **`CaseQueue`** — a queue: `code`, `strategy` (`manual`/`roundRobin`/`leastBusy`),
  `fallbackBehavior` (`unassigned`/`fallbackOwner`), `defaultTeamId`, `defaultAssignedUserId`, the
  server-owned round-robin cursor `lastAssignedUserId`/`lastAssignedAt`, `isActive`, `sortOrder`.
- **`QueueMember`** — one membership per `(queueId, userId)` with `priority` and `isActive`.
- **`RoutingRule`** — declarative conditions (a validated JSON array of `{ field, operator, value }`),
  a target (`queueId`/`teamId`/`userId`), `strategy`, `fallbackBehavior`, `isActive`, `sortOrder`.
- **`CaseTransition`** / **`CaseAssignment`** — the durable case history, written by the domain
  services only (`read: no` for regular roles). Each carries the reason, the command, the resolution
  code/summary and the routing decision, plus an optional `idempotencyKey`.

Queue, membership and rule writes require the `queues` capability and are administrator-scoped; the
routing-rule write guard parses and re-validates every condition at save time, so no stored rule can
become executable code (§5.3).

## Numbering

A case number is `prefix + zero-padded sequence value` (default prefix `C`, padding `6` →
`C000001`). Uniqueness is a Postgres sequence's `nextval`, which is atomic across sessions and
transactions, so concurrent creations cannot collide; migration `033` backs the stored value with a
partial unique index as a second line of defence. The sequence is deliberately **not gapless**: a
create that fails after allocation consumes its value, which is normal for ticket ids.

## Configuration

One validated `serviceDesk` row in the existing `app_settings` store (no second settings table):

- `numbering`: `prefix`, `padding`.
- `defaults`: `status`, `priority`, `type`, `source` applied by entity-metadata defaults.
- `resolution`: `requireCode` (on), `requireSummary` (off), `codes` (the configurable list of
  resolution codes), `reopenWindowDays` (`0` = unlimited).
- `assignment`: `defaultQueueId` (used by routing when no rule matches).
- `features`: `caseManagement` (on), and `queues`, `sla`, `notifications`, `emailToCase`, `portal`,
  `knowledgeBase`, `csat` (**all off by default**; switching one on activates the delivered
  capability, and module health reports any missing optional dependency).

Turning an optional capability on never bypasses server-side checks: queued/routed assignment,
mail ingestion, portal access and surveys each re-check their feature flag and dependency on every
command.

## State machine and assignment

Status moves are **commands**, not field writes. `CaseLifecycleService` narrows a base transition map
by the command's allowed source statuses, checks the resolution requirement, verifies the actor's
record permission (the update runs as the actor, so a denied edit rolls the whole command back) and
writes the case, a `CaseTransition` row and the domain events in one transaction. `reopen` never
erases a prior `resolvedAt`/`closedAt`, so every resolve→reopen cycle stays auditable; an optional
`idempotencyKey` makes a retried command a no-op.

`CaseAssignmentService` converges manual, queue/team and routing assignment into one validated path:
it checks the target exists, the user is an active internal user and is eligible under the target
queue/team, and that the actor may assign within their scope. Round-robin advances a row-locked
cursor on the queue (`SELECT … FOR UPDATE`) so concurrent claims cannot corrupt it; least-busy counts
active cases. Routing matches declarative rules in `sortOrder` order, first match wins, and never
drops a case when a queue has no eligible member — it is retained in the queue (or given the configured
fallback owner) and the decision is recorded.

## Tests

- `apps/api/test/service-desk.test.ts` — module health, settings, numbering preview, case CRUD,
  requester validation, server-owned-field refusal, list/filter, concurrent numbering, and record ACL.
- `apps/api/test/service-desk-workflow.test.ts` — the state machine and resolution workflow, reopen
  history, idempotent transitions, version conflicts, manual/team/queue assignment, round-robin,
  least-busy, safe fallback, declarative routing precedence, routing-rule validation, workload and
  assignment notifications.
- `apps/api/test/service-desk-conversation.test.ts` — reply/note visibility, response-clock stamping,
  portal exclusion of internal notes and system updates, forged-visibility refusal, attachment
  inheritance, read-only posting, reply notifications and idempotency, empty-entry rejection, plus the
  pure visibility helper.
- `apps/api/test/service-desk-email.test.ts` — inbound processing into a new case, thread append,
  idempotency, auto-reply skipping, outbound email reply, and feature gating.
- `apps/api/test/service-desk-sla.test.ts` — clock creation on case create, markMet on public reply,
  idempotent breach detection, timezone/holiday business-time calculation, pause/resume deadline
  shifting, configurable warning thresholds and the reopen resolution cycle.
- `apps/api/test/service-desk-csat.test.ts` — invitation after resolution, submission, duplicate and
  expiry protection, unresolved-case refusal and edit-permission refusal.
- `apps/api/test/service-desk-merge.test.ts` — ACL-filtered duplicate candidates, an auditable atomic
  merge, permission refusal, cancelled-source refusal and the server-owned merge field.
- `apps/api/test/service-desk-portal.test.ts` — portal list scope, cross-account IDOR, internal-field
  projection, public-only timeline, forced-public replies, portal-created source/requester and
  privileged-field refusal.
- `apps/api/test/service-desk-metrics.test.ts` — own-scope vs read-all aggregates, CSAT restriction,
  missing-permission refusal and invalid range handling.
- `apps/api/test/service-desk-security.test.ts` — IDOR, forged server-owned fields, record-scope
  transition refusal, admin-only SLA scans and worker-capability checks.
- `apps/worker/src/handlers/service-desk-handlers.test.ts` — the scheduled SLA job is registered,
  inert without a capability, calls the worker endpoint with the secret and reports counts.
- `apps/api/test/service-desk-domain.test.ts` — the pure numbering/validation/change-detection helpers,
  the transition model, the resolution requirement, routing-condition validation/matching and the
  round-robin/least-busy pickers.
