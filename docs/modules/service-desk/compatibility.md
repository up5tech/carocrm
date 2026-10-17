# Service Desk — compatibility and known deviations

What this module deliberately does differently from the plan's wording, and where it stands relative
to the full phase. The module is a clean-room TypeScript/NestJS implementation informed by common
service-desk practice: no upstream source, frontend asset, translation, icon or schema was copied,
and no parity with any upstream extension is claimed.

## 1. Scope delivered so far

Only **19-SD.0 – 19-SD.3** are implemented: the module scaffold, the additive persistence and
defaults, and the canonical `Case` entity with numbering, validation and the standard Entity Engine
CRUD/search/ACL surface. Everything from 19-SD.4 onward is a documented gap, not a silent one:

| Not built yet | Sub-phase | How it is reported |
|---|---|---|
| Case state machine and resolution workflow (resolve/close/reopen/cancel commands) | 19-SD.4 | `features` flags exist; `status` transitions are free-form metadata edits, not validated commands |
| Queues and routing | 19-SD.5 | `features.queues` defaults off, with a warning naming the phase |
| Email-to-case ingestion and idempotency | 19-SD.7 | `features.emailToCase` off; `email` integration detected as available for later use |
| SLA policies, clocks and business calendars | 19-SD.8 | `features.sla` off; `Case.slaState` exists as a server-owned summary field but nothing computes it yet |
| Knowledge Base integration | 19-SD.10 | `knowledge-base` integration reported **unavailable** (no `KnowledgeArticle` entity) |
| Portal self-service case access | 19-SD.11 | `portal` integration reported **unavailable** (no `Portal` entity); `Case.isHiddenFromPortal` exists but no portal scope reads it yet |
| CSAT surveys | 19-SD.14 | `features.csat` off |
| Dedicated React screens | 19-SD.13 | entities render through the generic metadata-driven UI; a purpose-built workspace is not built |

## 2. Deliberate design decisions

| Decision | Reason |
|---|---|
| Kernel domain directory, not an extension package | The extension SDK exposes no entity CRUD facade; a package owning `Case` could only write rows with raw SQL, bypassing ACL, validation, audit, stream and domain events (AGENTS.md §5.2). No `manifest.json`; nothing under `modules/`. |
| One canonical `Case` entity, no `ServiceDeskCase` | A second ticket entity would split search, ACL and stream for the same concept. The name `Case` is also the marker the shipped Customer Success `service-desk` integration already declares, so the integration flips to `available` with no change to Customer Success code. |
| `Case.name` is the subject (label "Subject"), no separate `subject` field | Mirrors the `Email` entity, whose display field is its subject; lists, search and stream read the display field directly. |
| Numbering from a Postgres sequence, not a counter row or a count of existing cases | The plan (§5.1) explicitly allows "a sequence or a transaction-safe allocation service". A sequence's `nextval` is atomic and non-repeating; counting rows is not concurrency-safe. The sequence is **not gapless** — a failed create consumes a value — which is normal for ticket ids. |
| Optional features default **off** | A fresh installation gets a working case desk, and nothing whose infrastructure lands in a later sub-phase (AGENTS.md §5.5). |
| Deferred tables are not created speculatively | Queues, SLA policy versions, SLA clocks, business calendars and mail-idempotency mappings have no reader until their sub-phase; their tables ship with the migration of the phase that reads them. |

## 3. Behaviour worth knowing (deviations from naive expectations)

- **`caseManagement` off leaves existing cases readable.** The `beforeValidate` guard refuses
  create/edit for non-internal callers with `403 FEATURE_DISABLED` but does not hide existing
  records, matching the platform's disabled-capability behaviour.
- **A shape failure is `400`, a rule failure is `422`.** The shared `parse()` helper renders a failed
  Zod request shape as `400 INVALID_QUERY`; a domain rule — an unknown settings key, a missing
  requester, a client write to a server-owned field — is `422 VALIDATION_FAILED`.
- **Server-owned fields are refused by name.** A client write that sets `caseNumber`, a timeline
  stamp, `resolvedById`, the SLA summary or the escalation state is rejected rather than silently
  ignored. A Service Desk domain service marked with `runAsServiceDeskInternal` may set them; no such
  service ships in 19-SD.1 – 19-SD.3 (future commands use the marker).
- **Optional integrations are detected from metadata, never imported.** `email`, `projects` and
  `customer-success` report `available` because those entities are registered; `portal`,
  `knowledge-base` and `workflow` report `unavailable` because no such entity exists yet. An
  unavailable integration never blocks startup.
- **Registering `Case` flips Customer Success's `service-desk` integration to `available`.** This is
  the intended marker mechanism (§12.8 of the Customer Success plan). The Customer Success *support
  signal adapter* is still not implemented (19-SD.16), so the signal itself continues to report
  `unavailable`; only the integration's availability flag changes.
