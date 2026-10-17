# Service Desk module (Phase 19-SD)

Implemented in `apps/api/src/service-desk` (backend), registered once in `apps/api/src/app.module.ts`,
with metadata in `database/seed-metadata.ts` and three additive migrations,
`database/migrations/033_phase19_service_desk.sql`,
`database/migrations/034_phase19_service_desk_workflow.sql` and
`database/migrations/035_phase19_service_desk_conversation.sql`. Functional reference: the documented
product requirements in [`PLAN_Phase_19_ServiceDesk.md`](../../PLAN_Phase_19_ServiceDesk.md),
reproduced as clean-room TypeScript behaviour — no upstream source, asset, translation or schema is
copied.

**Status: phases 19-SD.0 – 19-SD.18 are implemented (release gate passed).** (scaffold, persistence, Case CRUD/numbering,
the state machine and resolution workflow, assignment/queues/routing, and the conversation timeline
with public replies and internal notes). The list of phases actually claimed is
`SERVICE_DESK_MODULE.implementedPhases`
(`apps/api/src/service-desk/service-desk-module.ts`), which `/api/v1/ServiceDesk/action/health`
reports. Everything from 19-SD.7 onward (email-to-case, SLA clocks, portal self-service, Knowledge
Base, CSAT) is **not built yet**: the optional feature flags exist in settings, default **off**, and a
settings warning says which phase delivers each one.

| Read next | What it answers |
|---|---|
| [../../implementation/service-desk-audit.md](../../implementation/service-desk-audit.md) | the 19-SD.0 audit: what the repository already offered and the decisions taken |
| [compatibility.md](compatibility.md) | deviations from the plan wording and known gaps, with reasons |
| [`PLAN_Phase_19_ServiceDesk.md`](../../PLAN_Phase_19_ServiceDesk.md) | the full product scope for the remaining sub-phases |

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
| **Business calendars & SLA** (§5.6, §5.7, SD.8): `BusinessCalendar` (timezone, weekly intervals, holidays), `SLAPolicy` (declarative conditions, first/next/resolution targets, warning thresholds, pause rules, version), `CaseSLAClock` (per-case/per-target, start/pause/resume/met/breached), business-time calculator, policy resolver, idempotent breach-check pass, Case-level `slaState`/`slaPolicyId` summary | `apps/api/src/service-desk/sla.service.ts` |
| Module diagnostics: dependency evidence, optional-integration status, feature state, settings warnings | `GET /api/v1/ServiceDesk/action/health` |

Entity CRUD stays on the generic `/api/v1/:entity` API. The module routes exist only for what a
single record cannot express: diagnostics, the settings document, the numbering preview, the case
state machine and assignment/routing.

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
  `knowledgeBase`, `csat` (**all off** until their sub-phase lands).

Turning an unimplemented feature on stores the flag and returns a warning naming the phase that
delivers it; it never pretends the capability works.

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
  and idempotent breach detection.
- `apps/api/test/service-desk-domain.test.ts` — the pure numbering/validation/change-detection helpers,
  the transition model, the resolution requirement, routing-condition validation/matching and the
  round-robin/least-busy pickers.
