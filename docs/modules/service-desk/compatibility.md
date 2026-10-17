# Service Desk — compatibility and known deviations

What this module deliberately does differently from the plan's wording, and where it stands relative
to the full phase. The module is a clean-room TypeScript/NestJS implementation informed by common
service-desk practice: no upstream source, frontend asset, translation, icon or schema was copied,
and no parity with any upstream extension is claimed.

## 1. Scope delivered so far

**19-SD.0 – 19-SD.13** are implemented: the module scaffold, the additive persistence and defaults, the
canonical `Case` entity with numbering/validation and the standard Entity Engine CRUD/search/ACL
surface, the case **state machine and resolution workflow**, **assignment, queues and routing**, and
the **conversation timeline with public replies and internal notes**. Everything from 19-SD.7 onward
is a documented gap, not a silent one:

| Not built yet | Sub-phase | How it is reported |
|---|---|---|
| ~~Email-to-case ingestion and idempotency~~ | ~~19-SD.7~~ | **Delivered in 19-SD.7**: `EmailToCaseService` processes inbound emails into cases or appends to threads, idempotent by message/thread key, with mail-loop skipping and outbound email replies |
| ~~SLA policies, clocks and business calendars~~ | ~~19-SD.8~~ | **Delivered in 19-SD.8**: `BusinessCalendar`, `SLAPolicy`, `CaseSLAClock` entities, business-time calculator, policy resolver, clock lifecycle (start/pause/resume/met/breached), Case-level SLA summary, idempotent breach-check pass |
| ~~Knowledge Base integration~~ | ~~19-SD.10~~ | **Delivered in 19-SD.10**: `KnowledgeArticle` + `KnowledgeCategory` entities, publish/archive, portal-safe published list, case suggestions |
| ~~Portal self-service case access~~ | ~~19-SD.11~~ | **Delivered in 19-SD.11**: portal-scoped Case reads (account/contact neighbourhood), hidden-case exclusion, portal-created cases forced to source `Portal` with privileged fields stripped, attachment visibility already gates downloads |
| CSAT surveys | 19-SD.14 | `features.csat` off |
| A full case workspace | 19-SD.13 | entities render through the generic metadata-driven UI; the lifecycle, workload and conversation panels are purpose-built, but a complete agent workspace is not built |

## 2. Deliberate design decisions

| Decision | Reason |
|---|---|
| Kernel domain directory, not an extension package | The extension SDK exposes no entity CRUD facade; a package owning `Case` could only write rows with raw SQL, bypassing ACL, validation, audit, stream and domain events (AGENTS.md §5.2). No `manifest.json`; nothing under `modules/`. |
| One canonical `Case` entity, no `ServiceDeskCase` | A second ticket entity would split search, ACL and stream for the same concept. The name `Case` is also the marker the shipped Customer Success `service-desk` integration already declares, so the integration flips to `available` with no change to Customer Success code. |
| `Case.name` is the subject (label "Subject"), no separate `subject` field | Mirrors the `Email` entity, whose display field is its subject; lists, search and stream read the display field directly. |
| Numbering from a Postgres sequence, not a counter row or a count of existing cases | The plan (§5.1) explicitly allows "a sequence or a transaction-safe allocation service". A sequence's `nextval` is atomic and non-repeating; counting rows is not concurrency-safe. The sequence is **not gapless** — a failed create consumes a value — which is normal for ticket ids. |
| Optional features default **off** | A fresh installation gets a working case desk, and nothing whose infrastructure lands in a later sub-phase (AGENTS.md §5.5). |
| Deferred tables are not created speculatively | Queues, SLA policy versions, SLA clocks, business calendars and mail-idempotency mappings have no reader until their sub-phase; their tables ship with the migration of the phase that reads them. Queues landed with SD.5, which reads them. |
| History in dedicated records, not the generic field audit | The generic audit proves *that* a field changed; it cannot carry a transition's command/reason/resolution code or an assignment's routing decision, which the plan asks to keep (§5.2, §5.3). `reopen` therefore keeps the prior `resolvedAt`/`closedAt` and the closed cycle remains in `CaseTransition`. |
| `queueId`/`teamId`/`routingRuleId` are server-owned | Ownership is a server decision (§5.3): the write guard refuses a client write to them, and the assignment/routing commands re-check eligibility and the actor's scope before writing. |
| Assignment notifications are written to the existing `notifications` store | The platform already owns in-app notifications and delivery; the module writes one row whose `dedupKey` is the assignment-history id, so a retried command never double-notifies (§12.3). Off by default. |
| Round-robin history ordered by insertion, not record id | Record ids are random UUIDs; ordering by `created_at` keeps a history list oldest-first when two rows share a millisecond. |

## 3. Behaviour worth knowing (deviations from naive expectations)

- **`caseManagement` off leaves existing cases readable.** The `beforeValidate` guard refuses
  create/edit for non-internal callers with `403 FEATURE_DISABLED` but does not hide existing
  records, matching the platform's disabled-capability behaviour.
- **A shape failure is `400`, a rule failure is `422`.** The shared `parse()` helper renders a failed
  Zod request shape as `400 INVALID_QUERY`; a domain rule — an unknown settings key, a missing
  requester, a client write to a server-owned field — is `422 VALIDATION_FAILED`.
- **Server-owned fields are refused by name.** A client write that sets `caseNumber`, a timeline
  stamp, `resolvedById`, the SLA summary, the escalation state or the routing/ownership fields
  (`queueId`, `teamId`, `routingRuleId`) is rejected rather than silently ignored. The Service Desk
  domain services (`CaseLifecycleService`, `CaseAssignmentService`) run their `Case` writes under the
  `runAsServiceDeskInternal` marker, so they may set them.
- **A status move is a command, never a bare field edit.** `POST …/case/:id/transition` (and the named
  verbs) validates the source→target pair, the resolution requirement and the actor's permission, then
  writes the case, a `CaseTransition` row and the domain events in one transaction; a refusal leaves
  the record untouched. `close` is only valid from `Resolved`; `reopen` is refused for a `Closed` or
  `Cancelled` case unless the actor holds a broad edit permission.
- **Queues off refuses queue configuration and routing, not case editing.** With `features.queues`
  off, a non-internal write to `CaseQueue`/`QueueMember`/`RoutingRule` and a `route` command are
  refused with `403 FEATURE_DISABLED`; queues do not need to be on to create and work a case by hand.
- **Nothing stored in a routing rule is executed.** Conditions are parsed and validated against a
  field/operator allowlist at save time and matched in `sortOrder` order, first match wins; an
  unparseable rule is skipped, and a queue with no eligible member retains the case rather than
  dropping it.
- **Optional integrations are detected from metadata, never imported.** `email`, `projects` and
  `customer-success` report `available` because those entities are registered; `portal`,
  `knowledge-base` and `workflow` report `unavailable` because no such entity exists yet. An
  unavailable integration never blocks startup.
- **Registering `Case` flips Customer Success's `service-desk` integration to `available`.** This is
  the intended marker mechanism (§12.8 of the Customer Success plan). The Customer Success *support
  signal adapter* is still not implemented (19-SD.16), so the signal itself continues to report
  `unavailable`; only the integration's availability flag changes.
