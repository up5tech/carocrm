# Service Desk — compatibility and known deviations

What this module deliberately does differently from the plan's wording. The module is a clean-room
TypeScript/NestJS implementation informed by common service-desk practice: no upstream source,
frontend asset, translation, icon or schema was copied, and no parity with any upstream extension is
claimed.

## 1. Scope delivered

**19-SD.0 – 19-SD.18** are implemented and covered by the release evidence in
[`../../implementation/service-desk-release.md`](../../implementation/service-desk-release.md):
module scaffold, additive persistence and defaults, the canonical `Case` entity with
numbering/validation and Entity Engine CRUD/search/ACL, the state machine and resolution workflow,
assignment/queues/routing, the visibility-aware conversation, email-to-case, business-time SLA
clocks and the scheduled warning/breach/escalation pass, Knowledge Base, portal self-service,
web-to-case, the operator UI, duplicate detection/merge/CSAT, ACL-scoped metrics, domain events for
workflow/BPM, and the security/performance hardening pass.

Known limitations are listed in §3 rather than presented as missing phases.

## 2. Deliberate design decisions

| Decision | Reason |
|---|---|
| Kernel domain directory, not an extension package | The extension SDK exposes no entity CRUD facade; a package owning `Case` could only write rows with raw SQL, bypassing ACL, validation, audit, stream and domain events (AGENTS.md §5.2). No `manifest.json`; nothing under `modules/`. |
| One canonical `Case` entity, no `ServiceDeskCase` | A second ticket entity would split search, ACL and stream for the same concept. The name `Case` is also the marker the shipped Customer Success `service-desk` integration declares. |
| `Case.name` is the subject (label "Subject"), no separate `subject` field | Mirrors the `Email` entity, whose display field is its subject; lists, search and stream read the display field directly. |
| Numbering from a Postgres sequence, not a counter row or a count of existing cases | The plan (§5.1) explicitly allows a sequence. `nextval` is atomic and non-repeating; counting rows is not concurrency-safe. The sequence is **not gapless** — a failed create consumes a value — which is normal for ticket ids. |
| Optional features default **off** | A fresh installation gets a working case desk; mail, portal, Knowledge Base and surveys are activated deliberately, after their dependencies exist. |
| History in dedicated records, not the generic field audit | The generic audit proves *that* a field changed; it cannot carry a transition's command/reason/resolution code, an assignment's routing decision or a merge command. `reopen` therefore keeps the prior `resolvedAt`/`closedAt` and the closed cycle remains in `CaseTransition`. |
| SLA clocks snapshot the policy version **and** warning thresholds | A later policy edit must not silently rewrite live or historical targets; each clock keeps the thresholds it was created with. |
| Pauses shift the deadline by **business** minutes spent paused | Pausing must not shorten a target, and the pause duration stays auditable on the clock (`pausedAt`, `resumedAt`, `totalPausedBusinessMinutes`). |
| A reopened case starts a new resolution cycle | The previous resolution clock stays `met`; the new clock carries `cycle + 1`, so historical cycles remain reproducible instead of being overwritten. |
| `queueId`/`teamId`/`routingRuleId`/`mergedIntoCaseId` are server-owned | Ownership and merge state are server decisions: the write guard refuses a client write, and the domain commands re-check eligibility and record scope before writing. |
| Round-robin history ordered by insertion, not record id | Record ids are random UUIDs; ordering by `created_at` keeps a history list oldest-first when two rows share a millisecond. |
| Portal uses field ACL plus a presentation-only hidden-field list | Authorization is enforced by `PortalPolicyService` and the write guard; the web list only avoids rendering controls a customer cannot use (§9.6). |
| CSAT tokens are random, hashed at rest, expiring and single-use | A leaked database row cannot be replayed: only the SHA-256 hash is stored, an expiry is enforced and `used` is set on submission. |
| Metrics go through `EntityCrudService.aggregate` | The same Query Engine and record predicate as the list API means a count can never include a case the viewer cannot open; CSAT is restricted to read-all roles because surveys are not a public entity. |

## 3. Behaviour worth knowing (deviations from naive expectations)

- **`caseManagement` off leaves existing cases readable.** The `beforeValidate` guard refuses
  create/edit for non-internal callers with `403 FEATURE_DISABLED` but does not hide existing
  records, matching the platform's disabled-capability behaviour.
- **A shape failure is `400`, a rule failure is `422`.** The shared `parse()` helper renders a failed
  Zod request shape as `400 INVALID_QUERY`; a domain rule — an unknown settings key, a missing
  requester, a client write to a server-owned field — is `422 VALIDATION_FAILED`.
- **Server-owned fields are refused by name.** A client write that sets `caseNumber`, a timeline
  stamp, `resolvedById`, the SLA summary, the escalation state, ownership/routing fields or
  `mergedIntoCaseId` is rejected rather than silently ignored. Domain services run their `Case`
  writes under the `runAsServiceDeskInternal` marker, so they may set them.
- **A status move is a command, never a bare field edit.** The command validates the source→target
  pair, the resolution requirement, and both entity-level and record-level edit scope before writing
  the case, a `CaseTransition` row and domain events in one transaction. A portal principal has no
  edit permission on `Case`, so customer state changes stay staff-mediated; the portal can still
  create a case and reply.
- **Queues off refuses queue configuration and routing, not case editing.** With `features.queues`
  off, a non-internal write to `CaseQueue`/`QueueMember`/`RoutingRule` and a `route` command are
  refused with `403 FEATURE_DISABLED`; queues do not need to be on to work a case by hand.
- **Nothing stored in a routing rule is executed.** Conditions are parsed and validated against a
  field/operator allowlist at save time and matched in `sortOrder` order, first match wins; an
  unparseable rule is skipped, and a queue with no eligible member retains the case rather than
  dropping it.
- **Business time is evaluated in the calendar's IANA time zone**, including daylight-saving
  transitions and local holiday dates. A calendar without intervals falls back to calendar time.
- **The SLA scan records what it fired.** Warning thresholds are stored on the clock and each fired
  threshold is appended to `firedWarnings`; breach notification/escalation flags are set once. A
  resolved, closed, cancelled or merged case is not escalated, and its clock is marked so a later
  tick does not retry forever.
- **Optional integrations are detected from metadata, never imported.** `email`, `portal`,
  `knowledge-base`, `projects` and `customer-success` report `available` once their marker/table
  exists; `workflow` reports `unavailable` because workflow definitions live in dedicated tables, not
  a metadata entity. An unavailable integration never blocks startup; the platform outbox still
  publishes Service Desk events for any workflow subscriber that exists.
- **The Customer Success support signal reads `Case` rows but never mutates them.** The signal scores
  open/breached/escalated/reopened cases for an account and returns `missing` when no support history
  or no Service Desk entity is present. Health scoring remains Customer Success's decision.
- **Portal CSAT links are token-only.** `/csat?token=…` works without a CRM session and does not name
  or load the case; the server verifies hash, expiry and single-use state.
- **Knowledge expiry is a scheduled state change, not a hidden filter.** Published articles whose
  `expiresAt` passed are updated to `Expired` by the scheduled pass, so portal search and suggestions
  stop serving them and the change is audited.

### Known limitations

- The portal cannot perform status transitions or merge cases; those remain staff commands. If a
  customer needs a case reopened, a new case or staff action is required.
- Web-to-case rate limiting is per API process (in-memory, five requests per minute per IP). A
  multi-instance deployment should put a shared limiter in front of the endpoint.
- SLA recalculation is a deliberate per-clock/command operation, not a bulk administrative preview
  UI; changing a policy does not rewrite existing clocks.
- Service metrics expose status/priority/source buckets and defined summary counts. Arbitrary
  dimension/aggregation reports use the platform Report Builder over `Case`; there is no dedicated
  Service Desk report pack.
- The agent workspace is the metadata-driven list/detail with purpose-built lifecycle, workload and
  conversation panels. There is no separate kanban/skills-routing workspace.
