# Service Desk module (Phase 19-SD)

Implemented in `apps/api/src/service-desk` (backend), registered once in `apps/api/src/app.module.ts`,
with metadata in `database/seed-metadata.ts` and one additive migration,
`database/migrations/033_phase19_service_desk.sql`. Functional reference: the documented product
requirements in [`PLAN_Phase_19_ServiceDesk.md`](../../PLAN_Phase_19_ServiceDesk.md), reproduced as
clean-room TypeScript behaviour — no upstream source, asset, translation or schema is copied.

**Status: phases 19-SD.0 – 19-SD.3 are implemented.** The list of phases actually claimed is
`SERVICE_DESK_MODULE.implementedPhases`
(`apps/api/src/service-desk/service-desk-module.ts`), which `/api/v1/ServiceDesk/action/health`
reports. Everything from 19-SD.4 onward (state machine, queues, email-to-case, SLA, portal
self-service, Knowledge Base, CSAT, dedicated UI) is **not built yet**: the optional feature flags
exist in settings, default **off**, and a settings warning says which phase delivers each one.

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
| Validated module settings (numbering prefix/padding, defaults, optional feature flags) | `GET/POST /api/v1/ServiceDesk/action/settings` |
| Module diagnostics: dependency evidence, optional-integration status, feature state, settings warnings | `GET /api/v1/ServiceDesk/action/health` |

Entity CRUD stays on the generic `/api/v1/:entity` API. The module routes exist only for what a
single record cannot express: diagnostics, the settings document and the numbering preview.

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

Relations: activity links (`emails`, `calls`, `meetings`, `tasks`) through `entity_links`, and
`Account.relations.cases` / `Contact.relations.cases` on the other side. Audit, stream and field ACL
come from the platform; the entity declares `acl.permissions.Case` defaults (`read: all`,
`edit/delete/stream: own`) that an administrator narrows or widens per role.

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
- `features`: `caseManagement` (on), and `queues`, `sla`, `emailToCase`, `portal`, `knowledgeBase`,
  `csat` (**all off** until their sub-phase lands).

Turning an unimplemented feature on stores the flag and returns a warning naming the phase that
delivers it; it never pretends the capability works.

## Tests

- `apps/api/test/service-desk.test.ts` — module health, settings, numbering preview, case CRUD,
  requester validation, server-owned-field refusal, list/filter, concurrent numbering, and record ACL.
- `apps/api/test/service-desk-domain.test.ts` — the pure numbering/validation/change-detection helpers.
