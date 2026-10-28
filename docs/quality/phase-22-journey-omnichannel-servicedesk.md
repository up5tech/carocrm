# Phase 22.11 — Omnichannel conversation to ServiceDesk Case

**Plan:** `PLAN_Phase_22_Integration_E2E_Hardening.md` §13.4.  
**Suite:** `apps/api/test/phase22-journey-omnichannel-servicedesk.test.ts`.  
**Status:** Implemented and verified — the focused journey and the full `pnpm verify` gate both pass.

## Scope and actors

The journey uses the existing configured primary PostgreSQL database and the real application controllers, authorization, identity resolver, routing engine, handoff, stream, and attachment services. It boots without running migrations or seed scripts. No new database or schema is provisioned.

The administrator configures the fixture and handles the conversation. A portal principal is bound to the **same canonical Contact** as the handed-off Case. Another test Contact/Case provides the negative account-isolation case. SMS consent is explicitly granted for a synthetic phone number. Only the in-process `fake` provider is used; its HMAC verifier is exercised with valid and invalid signatures.

Required capabilities are Omnichannel workspace, Voice SMS, ServiceDesk case management, conversation routing, and portal access. The settings documents are snapshotted and restored. SLA is off for this fixture; notification generation remains enabled. The queue transport alone is substituted: `JobsService` still writes real durable jobs, while receipts are processed explicitly through the authenticated processing API with its worker secret. No Redis delivery, live worker, SMTP send, or external provider call is exercised.

## Journey matrix

| Step | Executed contract | Assertion |
|---|---|---|
| 1 | Signed inbound webhook at the Omnichannel prefix | HTTP 202; one receipt under the provider event id, distinct from the receipt UUID |
| 2 | Forged callback followed by the genuine callback with that id | HTTP 401 `AUTHENTICATION_FAILED`; the refusal does not poison the genuine dedup key |
| 3 | Process receipt, then review identity | One canonical conversation and customer message; the participant resolves to the fixture Contact with exact, verified evidence |
| 4 | Replay original webhook | Same receipt UUID; no additional customer message or conversation |
| 5 | Route conversation through Omnichannel → ServiceDesk → Voice | Exact fixture rule/queue/agent selected; assignment persisted on the conversation |
| 6 | Internal conversation note, then handoff | One Case linked to the canonical Contact; customer text included in description, staff note excluded |
| 7 | Repeat handoff | Same Case and no second Case with the conversation's external id |
| 8 | Case internal note/file plus public reply/file | Authorized portal can read the Case, public thread and public file; internal note and attachment id are absent; internal file download and staff-only Voice timeline are denied; staff can still read internal content |
| 8 | Customer data export and case notifications | Conversation export excludes staff notes; case notification payloads do not carry the internal note text or note id |
| 9 | New event id with an existing provider message id | A new receipt does not create another customer message or conversation |
| 10 | `simulateOutage: true` on the fake provider | Outbound attempt persists `failed` / `provider_unavailable`; replaying its key after recovery returns that attempt without sending again; a deliberate new key succeeds; inbound receipt remains accepted |
| 11 | A second Contact with the same synthetic phone | Identity becomes ambiguous/disputed, with no automatic entity link; conflict is available for staff review rather than silently merged |
| 12 | Foreign customer Case, public reply and attachment | Portal's list includes its authorized Case but not the foreign Case; foreign detail/thread/file access is denied |

## Ownership and isolation

- Voice owns receipts, conversations and messages. ServiceDesk owns Case creation and the handoff trail. The integration uses the existing `OmnichannelHandoffService` → `CaseHandoffService` contract; it does not write Case state directly.
- Portal filtering is tested on a readable Case, not just by denying the entire Case. Public and internal files are downloaded through the real attachment API.
- Routing category is an explicitly seeded attribute on **only the fixture conversation**, since no public category writer exists. The test's routing rule matches that run-unique category, not all SMS conversations. After routing, automatic Case queue routing is disabled for fixture creation so installation-wide rules cannot assign the test Case to unrelated users.
- Created records are tracked by exact id. Case-owned transitions, stream items, attachment relations, notifications and events are removed only via those Case ids. Voice rows are limited to the newly created provider account key; consent is limited to the run's unique evidence marker and address. Uploaded storage objects, dedicated portal/user/role rows, test session and durable jobs are cleaned up as well. Cleanup errors fail the suite instead of being swallowed.
- No broad time-based cleanup or name-only deletion is used by this suite. Database sequences may advance during normal Case creation; they are not reset.

## Verification

| Check | Result |
|---|---|
| Focused Vitest journey (`phase22-journey-omnichannel-servicedesk.test.ts`), after the privacy/outage/isolation revisions and the `sql`-template rewrite | 12 tests passed |
| `pnpm exec tsc --noEmit -p tsconfig.json` | no diagnostic for this suite |
| `pnpm lint:changed` | 0 errors, 0 warnings |
| Leftover scan in the configured database for this suite's markers (`AGENT_TEST_LS22D_*` in `entity_records`, `portals`, `portal_roles`, `voice_*`, `attachments`, `jobs`, `stream_items`) | 0 rows after the run |
| `pnpm exec vitest run apps/api/test/phase22-replay-contract.test.ts` (after its `jobs` cleanup fix) | 8 tests passed |
| Final `pnpm verify` | Passed — lint 0/0, typecheck clean, `pnpm test` 241 files / 3,241 tests, `pnpm test:web` 5 files / 21 tests |

An earlier full run (before the privacy/outage/isolation revisions) passed with the same 241/3,241/21 shape; the row above is the run against the version in this commit. Note kept from that work: a **whole-suite** run leaves orphan stream rows behind — in the run above, 570 rows across 31 entity types (152 `SubscriptionPeriod`, 68 `LeadScoreModel`, 49 `MarketingSend`, … and one `Case`) whose subject record was hard-deleted while its `stream_items` row stayed. None of them belongs to this suite (its own rows are all gone; see the leftover scan), and the platform has no rule that would remove them — recorded as G30.

## Findings

- **G29 — a webhook delivery leaks its durable `jobs` row.** Building this journey surfaced that `phase22-replay-contract.test.ts` (22.7) deleted its connection and delivery rows but not the `jobs` row the delivery created: 14 `pending` rows named its provider keys in the configured database. The suite now deletes `jobs where target->>'connectionId' = …`, and its earlier rows were removed by exact id. `advanced-integrations-engine.test.ts` still leaks the same way (29 rows since 2026-10-20). See `known-gaps.md` G29.
- **G30 — a hard delete leaves the record's stream behind.** This suite has to delete its Case `stream_items` by `entity_id` precisely because nothing else does: `stream_items` is polymorphic with no foreign key to `entity_records`, and `stream-hooks.ts` only inserts. The database already carries 4,640 orphan `Case` rows (plus 13,528 `SubscriptionPeriod`, 5,127 `LeadScoreModel`, …) from hard deletes over the past days. That is a product decision, not a test fix. See `known-gaps.md` G30.
- **The Voice staff timeline is staff-only by design.** `GET …/action/conversations/:id/timeline` forces `includeInternalNotes: true` (controller `voice-communications.controller.ts`), so a portal principal is denied the route outright rather than shown a filtered view. The journey asserts both halves: staff reads the internal note there, the portal gets 403, and the customer-facing surfaces (portal Case stream, file download, data export, notifications) never carry it.

## Limits

- API journey, not browser testing or real vendor certification.
- The visitor web-chat channel and live BullMQ scheduling/retry loop are not exercised by this SMS/portal suite.
- Staff timelines intentionally contain internal notes. The tested customer-facing boundaries are portal Case streams/files and the customer data export; this is not a claim to have exhaustively audited every serializer or notification type.
- Twelve ordered steps share one fixture; later steps depend on earlier setup. Separate runs use unique identifiers and restore their settings.
