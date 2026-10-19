# Phase 19-VC.0 — Repository audit and feature contract

> `PLAN_Phase_19_Voice_Communications.md` §15 `19-VC.0`.
> Acceptance: no code or migration before this document; no assumption that a planned service
> exists; provider scope and integration contracts agreed; no test database and no duplicate
> generic entity created.

Audited: `PLAN.md`, `AGENTS.MD`, `pnpm-workspace.yaml`, `apps/api/src`, `packages/*`,
`database/migrations`, `database/seed-metadata.ts`, the module guide and the existing domain
modules (Sales, Service Desk, Customer Success, Marketing Automation, AI Agents, Projects, Portal).

---

## 1. What the platform already provides

| Capability | Where | What the module reuses |
| --- | --- | --- |
| Authentication | `apps/api/src/auth` (`AuthGuard`, `@Public()`, `AuthService.createSession`) | Bearer sessions; public webhook routes opt out explicitly |
| Authorization | `apps/api/src/acl/acl-api.service.ts` | `canUser`, `assertAccess`, `canAccessRecord`, `assertRecordAccess`, `visibleFields`, `stripRestricted`, `assertFieldWrites`, `recordPredicate` |
| Users / Teams / Roles | `users`, `teams`, `roles`, `users_teams` tables; `record.data.teams` | assignment targets; team routing; ACL team scope |
| Metadata entities | `database/seed-metadata.ts`, `apps/api/src/metadata` | `Contact`, `Lead`, `Account`, `Call`, `Case`, `User`; `phoneNumber` fields on Account/Contact/Lead |
| Generic record API | `apps/api/src/entity` (`/api/v1/:entity`) | `Call` activity CRUD, record linking through `entity_links` |
| Audit | `apps/api/src/audit`, `audit_log`, `AuditHookService` | every module mutation is audited by the kernel hook |
| Stream | `apps/api/src/stream`, `stream_items` | record-level activity feed |
| Domain events + outbox | `apps/api/src/events` (`EventBus.dispatch(tx, {type,payload})`), `outbox_events` | module events `voiceCommunications.*` |
| Jobs | `apps/api/src/jobs` (`JobsService.enqueue`, `JOB_NAME` camelCase, `REPORT_WORKER_SECRET` worker door) | asynchronous webhook processing, replay |
| Settings | `app_settings` (`name`, `data` JSON, `modified_at`) | one validated row named `voiceCommunications` |
| Attachments / media | `apps/api/src/attachment`, `attachments`, `PARENT_ACL_CHECK_TOKEN`, private storage driver | message media and recordings (19-VC.15) |
| Notifications | `notifications` table | incoming-call notification (19-VC.9) |
| Secret encryption | `ENCRYPTION_KEY` + `encryptSecret`/`decryptSecret` (`@carocrm/core/utils/crypto`) | provider credentials, webhook secrets |
| Module health pattern | `*-module-health.service.ts` in every domain module | capability evidence, integration detection |
| Navigation | `admin-panel/navigation-defaults.ts` (`NAVIGATION_SUBGROUPS`) | a `voice` submenu whose entries appear when records land |

**No realtime gateway** (no WebSocket/SSE), **no phone library at audit time** (`libphonenumber-js`
was added in 19-VC.6), **no telephony SDK**, **no
provider HTTP client**. Negative findings are as important as positive ones.

---

## 2. Capability matrix

Legend: **Reuse** = platform service used unchanged; **Extend** = platform artifact extended
additively; **Build** = this module must implement it; **Out** = explicitly out of scope.

| Concern | Decision | Evidence / location |
| --- | --- | --- |
| AuthN / AuthZ | Reuse | `AuthGuard`, `AclApiService` |
| Record-level and field ACL | Reuse | `canAccessRecord`, `assertRecordAccess`, `fieldAccess` |
| Provider accounts + credentials | Build (dedicated table) | no provider table exists; `ai_provider_connections` is the precedent |
| Provider adapters | Build | no telephony SDK installed |
| Endpoints / sender numbers | Build (dedicated table) | nothing exists |
| Webhook ingress | Build | only marketing's single-provider inbox exists; it is email-specific |
| Webhook receipts / idempotency | Build | `marketing_provider_webhook_inbox` is the pattern, not reusable |
| Call sessions | Build (dedicated table) + Reuse `Call` Activity | `Call` entity exists with `direction` only |
| Call notes | Reuse `Call.description` + audit | activity conventions |
| Conversations / participants | Build (dedicated tables) | no generic conversation store; Service Desk's case-conversation is case-specific |
| Messages (SMS/MMS/WhatsApp) | Build (dedicated table) | `Email` is a different subsystem, not overloaded |
| Message media | Build metadata + Reuse attachments storage | `attachments` is parent-typed; media records reference it |
| Consent (email) | Reuse MarketingAutomation | `MarketingConsent.channel = ['Email']` only |
| Consent (voice/SMS/WhatsApp) | Build (append-only table) | no non-email consent exists |
| Suppression | Build per channel/address | marketing suppression is email-hash scoped |
| Channel policy / quiet hours / WhatsApp window | Build | no policy service exists |
| Phone normalization | Build behind an adapter seam | no library at audit time; `libphonenumber-js` added in 19-VC.6 |
| Contact resolution | Build on `entity_records` | phone stored as formatted text in `data->>'phoneNumber'` |
| Notifications / popup | Extend (notifications table) | no realtime transport; 19-VC.9 decides |
| Background processing | Reuse Jobs | `JobsService.enqueue`, worker secret |
| Audit | Reuse | kernel audit hook + `audit_log` |
| Domain events | Reuse | `EventBus`, camelCase `EVENT_TYPE` |
| Files / recordings | Extend | attachments + private storage; recording policy off |
| AI enrichment | Reuse AIAgents (later) | no AI runtime in this module |
| ServiceDesk handoff | Reuse Case entity + its API (later) | `Case` entity exists |
| MarketingAutomation integration | Contract only | campaign ownership stays there |
| Reports | Reuse reports platform (later) | no second analytics engine |
| Test database | Out | AGENTS.md §3 forbids creating one |

---

## 3. Existing records the module must not duplicate

| Existing | Owns | This module |
| --- | --- | --- |
| `Call` (metadata entity) | user-facing call activity: subject, direction, status, start/end, duration, description, relations | stores provider correlation/state in `voice_call_sessions`; 19-VC.7 creates/updates exactly one `Call` per logical call |
| `Email` / `EmailTemplate` | email transport and content | untouched; no email client is built |
| `Case` (Service Desk) | support ticket lifecycle | conversations may link to a Case; conversation state never mutates Case state |
| `MarketingConsent` | email consent and suppression | not written; consulted only through its own service if a campaign-triggered voice send is ever added |
| `CustomerSuccessProfile` | health/success plans | receives permitted touchpoint events later; owns no messaging data |
| `attachments` | file storage and ACL | media rows reference it; no second file store |

---

## 4. Provider scope agreed for this release

**Initial provider: `fake` (simulator).**

| Capability | Status |
| --- | --- |
| `voice.outboundCall` | experimental (simulator only) |
| `voice.inboundEvents` | experimental |
| `voice.callStatusCallbacks` | experimental |
| `voice.recordingMetadata` | not-implemented |
| `voice.recordingDownload` | not-implemented |
| `messaging.sms.send` / `.receive` | experimental |
| `messaging.mms.send` / `.receive` | not-implemented |
| `messaging.whatsapp.send` / `.receive` | not-implemented |
| `messaging.deliveryStatus` | experimental |
| `messaging.templates` | not-implemented |
| `messaging.media` | not-implemented |
| `webhook.signatureValidation` | supported (HMAC-SHA256, canonical JSON) |
| `provider.healthCheck` | supported |

A production adapter (Twilio first candidate) is **not** claimed. It is added in 19-VC.10/11 with
its own contract tests and a documented API version. The capability matrix in
`docs/modules/voice-communications/providers.md` is the single source for per-adapter status.

---

## 5. Integration contracts agreed

- **ServiceDesk**: `Conversation.caseId` is a reference; handoff calls the ServiceDesk service, never
  creates a Case row directly.
- **MarketingAutomation**: email consent/suppression remains its authority. If MarketingAutomation
  ever sends SMS/WhatsApp, it must call this module's policy service before dispatch; this module
  never writes campaign, audience or journey data.
- **AIAgents**: summaries/suggestions are requested through the AIAgents gateway with the acting
  user's ACL; this module stores provenance and review state only.
- **Portal**: no portal surface in this release; internal notes are structurally excluded from any
  future portal projection.
- **Sales / CustomerSuccess / Projects**: link by record reference (`relatedEntityType`/`relatedEntityId`)
  through permitted relationship contracts; no financial or success state is changed here.

---

## 6. Data model decision

Dedicated tables (migration 051), because their lifecycle, volume and access pattern differ from a
metadata record:

`voice_provider_accounts`, `voice_endpoints`, `voice_webhook_events`,
`voice_communication_events`, `voice_call_sessions`, `voice_conversations`,
`voice_conversation_participants`, `voice_messages`, `voice_media`, `voice_consent_events`,
`voice_suppressions`.

The `Call` Activity remains the user-facing record. No table copies Contact/Lead/Account data: a
participant stores the normalized address and an optional record reference, never a snapshot of the
CRM record's fields.

---

## 7. Test and database safety

- Tests use the configured primary database through `bootTestApp()`; no test/shadow database is
  created (AGENTS.md §3).
- Test rows carry the `AGENT_TEST_` marker or a unique run id and are removed by exact id.
- The fake adapter performs no network I/O; no test sends a real call or message.
- Pure domain suites (state machines, phone normalization, policy evaluation) run without the API
  boot; integration suites boot the API once and assert persisted state.

---

## 8. Acceptance evidence for 19-VC.0

- This document and `docs/compatibility/voice-communications.md` exist before any module code.
- Every capability above is classified from the running repository, not from the plan's wish list.
- The one provider in scope (`fake`) and its exact capabilities are stated, with the production
  adapter explicitly not claimed.
- No test database, no duplicate `Call`/`Case`/`Email` entity, no `Ua` prefix.
