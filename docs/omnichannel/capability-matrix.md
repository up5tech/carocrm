# Phase 19-OM.0 — Omnichannel capability matrix

> Companion to `docs/omnichannel/repository-audit.md`. `PLAN_Phase_19_Omnichannel.md` §14 `19-OM.0`.
> Read the audit first: every row here refers to it by section (e.g. *audit §4.5*).
>
> **Status legend**
>
> | Status | Meaning |
> | --- | --- |
> | 🟢 **Reuse** | Exists and is directly consumable as-is. |
> | 🟡 **Partial** | Exists but is scoped, simplified or missing a named element. |
> | 🔴 **Missing** | Does not exist. Needs new work in the owning module (not inside Omnichannel). |
> | ⛔ **Blocked** | Externally blocked (provider approval, credentials, credentials/app review). |
> | ⚫ **Out of scope** | Explicitly another module's or another phase's work. |
>
> **Decision legend** — the action Omnichannel takes:
> `Reuse` · `Extend` (in the owning module) · `Build` (new, inside Omnichannel) · `Defer` ·
> `Exclude`.

---

## A. Logical entity mapping (plan §5)

The plan's logical entities against what the repository actually holds.

| # | Plan §5 entity | Existing implementation | Status | Decision | Notes |
| --- | --- | --- | --- | --- | --- |
| A1 | `OmnichannelConnection` (§5.1) | `voice_provider_accounts` + `voice_endpoints` | 🟢 | **Reuse** | Owns provider key, credentials ref, channel, status, health. Unique on `voice_provider_accounts (key)`; `voice_endpoints` unique on `(address)` and `(key)`. |
| A2 | `OmnichannelConversation` (§5.2) | `voice_conversations` | 🟡 | **Extend** | Missing `priority`, `category`, `language`, `tags`, `currentQueueId`, `assignmentVersion`, `lastOutboundAt`, `snoozedUntil`, `closedAt`, `version` (audit §4.5). `channel` is CHECK-constrained to `('sms','mms','whatsapp')`. |
| A3 | `OmnichannelChannelThread` (§5.3) | `voice_conversations.external_thread_id` (1 thread per conversation) | 🟡 | **Defer** (E6) | The plan assumes N provider threads → 1 canonical conversation. Today they are 1:1, and there is no `channelThreadId` on `voice_messages`. |
| A4 | `OmnichannelIdentity` (§5.4) | `voice_conversation_participants` | 🟡 | **Extend** (E5) | Has `address`, `role`, `entity_type`, `entity_id`, `consent_status`. Missing provider-identity id, `verificationState`, `linkConfidence`/`linkReason`, `lastSeenAt`, `sourceProvenance`, and a connection+channel+identity uniqueness rule (audit §4.5, §4.6). |
| A5 | `OmnichannelMessage` (§5.5) | `voice_messages` | 🟢 | **Reuse** | State enum `draft\|queued\|submitted\|sent\|delivered\|read\|failed\|undelivered\|unknown` matches the plan. `is_internal_note` + provider-message CHECK makes internal notes structurally unsendable. |
| A6 | `OmnichannelAssignmentHistory` / `OmnichannelConversationEvent` (§5.6) | `voice_conversation_events` | 🟢 | **Reuse** | Append-only event log (assignment, status change, case link). |
| A7 | `OmnichannelQueue` / `OmnichannelRoutingRule` (§5.7) | `CaseQueue`, `QueueMember`, `RoutingRule` (ServiceDesk) | 🟡 | **Extend** (E8) — *in ServiceDesk* | Full queue/routing engine already exists with `manual\|roundRobin\|leastBusy`, fallbacks, workload, a `CaseAssignment` audit entity. Limits: no business hours, no skills entity, operators limited to `equals\|notEquals\|in`. **Building a second engine is forbidden.** |
| A8 | Webhook operation records (§5.8) | `voice_webhook_events` + `voice_communication_events` | 🟢 | **Reuse** | Dedup `(account_key, dedup_key)`, one normalized event per receipt, `signature_valid`, `payload_redacted`, replay is an authorized admin op. |
| A9 | Send operation records (§5.8) | `voice_messages` + `uq_voice_messages_idem` | 🟢 | **Reuse** | Idempotency key unique; provider message id unique per account. |
| A10 | Campaign touchpoint source (§5.2) | `MarketingSend` + `marketing_recipient_deliveries` | 🟡 | **Reuse** (vocabulary) | The literal term "touchpoint" is **not** a Marketing concept; map the plan's wording onto these artifacts (audit §1.2). |
| A11 | Inbound email message | `Email` metadata entity + `packages/mail` `InboundMailMessage` | 🟡 | **Extend** | `threadId` exists on `InboundMailMessage` and on `Email`; no provider installed (G9). |
| A12 | Portal/web-chat visitor session | — | 🔴 | **Build** | No anonymous principal exists (F5, G8). |

---

## B. Channel feasibility matrix (plan §4)

| Channel | Provider / adapter today | Inbound | Outbound | Status | Decision | Blocker |
| --- | --- | --- | --- | --- | --- | --- |
| **SMS** | Twilio (`voice-provider-twilio.ts`, 584 lines) — live adapter | ✅ Twilio message callbacks → `voice-webhook-ingress.service.ts` | ✅ `VoiceMessagingService.send` | 🟢 | **Reuse** | Raw-body hook gap (F3/G4) must be closed for byte-exact Twilio signatures |
| **MMS** | Named in vocabulary, tables, DTOs | ❌ | ❌ | 🔴 | **Defer** | **No adapter declares `messaging.mms.send`/`.receive`** |
| **WhatsApp** | Twilio's WhatsApp API (`voice-provider-twilio.ts`) — **not** Meta Cloud API | ✅ | ✅ (template registry via `voice_whatsapp_templates`) | 🟢 | **Reuse** | Meta Cloud API is a separate connector with its own app review (⛔) |
| **Voice / telephony** | Twilio + Asterisk ARI (428 lines) | ✅ ARI events | ✅ `initiateCall` / `controlCall` | 🟢 | **Reuse** | **Calls are not conversations** — `voice_call_sessions` is a separate store; no voice↔conversation grouping |
| **Email** | `packages/mail` `InboundMailProvider` port; `NullInboundProvider` bound | 🟡 seam only | ✅ SMTP/relay/memory/none transports | 🟡 | **Extend** | No IMAP/Graph provider (G9). ServiceDesk already consumes `Inbound` Email records (F2) |
| **Website / Portal chat** | `WebToCaseService` public intake only | 🟡 abuse controls exist | ❌ no conversation | 🔴 | **Build** | Anonymous-visitor identity (F5); no conversation entity for it |
| **Meta Messenger / Instagram** | none | ❌ | ❌ | ⛔ | **Exclude** | No adapter, no app review, no permissions. Needs a `channel-feasibility.md` record first |
| **Telegram** | none | ❌ | ❌ | ⛔ | **Exclude** | No adapter; bot capability ≠ access to personal conversations |
| **Social publishing / listening** | none | ❌ | ❌ | ⚫ | **Exclude** | Out of scope by plan §3.6 |

---

## C. Processing-flow coverage (plan §6)

| # | Plan §6 flow | Existing implementation | Status | Decision |
| --- | --- | --- | --- | --- |
| C1 | Inbound webhook receipt | `voice-webhook-ingress.service.ts` → `voice_webhook_events`; dedup, signature check, redaction, replay | 🟢 | **Reuse** (after E2) |
| C2 | Inbound normalization | `VoiceProviderAdapter.normalizeEvent` → `NormalizedProviderEvent` | 🟢 | **Reuse** |
| C3 | Identity resolution | `voice-contact-resolver.service.ts` — libphonenumber → `phoneMatchKeys` → Contact/Lead/Account, entity-ACL then record-ACL, bounded candidates | 🟡 | **Extend** (E5 + a normalized index; currently a `regexp_replace` scan) |
| C4 | Conversation creation / lookup | `voice-messaging.service.ts.ingestInbound` — find-or-create conversation, participant upsert | 🟢 | **Reuse** |
| C5 | Message persistence | `voice_messages` with an explicit state enum | 🟢 | **Reuse** |
| C6 | Outbound send | `voice-messaging.service.ts.send` — policy → consent → idempotency → persist-as-queued → re-check → dispatch | 🟢 | **Reuse** |
| C7 | Delivery-status reconciliation | `applyStatus` + `MESSAGE_STATE_RANK` (no regression) | 🟡 | **Extend** (E7 — **no status polling, no reconcile-unknown command**) |
| C8 | Consent / suppression check | `voice-consent.service.ts` + `voice-policy.service.ts` (quiet hours, CS window, ordered refusal codes) | 🟢 | **Reuse** |
| C9 | Assignment / routing | `voice-inbox.service.ts.assign` + `voice_conversation_events` history | 🟢 | **Reuse** |
| C10 | Queue / workload balancing | `case-assignment.service.ts` (queues, round-robin, least-busy) | 🟡 | **Extend in ServiceDesk** (E8) |
| C11 | Case hand-off | `voice-inbox.service.ts.handoffToCase` — **uses the generic entity API**, so no `CaseTransition` row and no `source` | 🟡 | **Extend in ServiceDesk** (E9 — add `Case.externalId` + a link command) |
| C12 | Live update to the agent UI | `crm_notifications` LISTEN/NOTIFY → per-user SSE at `GET /api/v1/Notification/stream` | 🟡 | **Extend** (E11 — **no generic publish seam**; today the inbox polls at 15–20 s) |
| C13 | AI suggestion + explicit approval | `AIAgentRunService.create/triggerRun` + approval matrix | 🟡 | **Extend** (E16 — **no messaging tool exists**) |
| C14 | Attachment / media on a message | `voice-media.service.ts` → `attachments` storage; download ACL via parent ACL | 🟢 | **Reuse** |
| C15 | Audit of every mutation | `audit_log` via `KERNEL_HOOKS_TOKEN` inside the mutation transaction | 🟢 | **Reuse** |
| C16 | Durable domain events | `EventBus.dispatch(tx, {type, payload})` → `outbox_events` → worker | 🟢 | **Reuse** |

---

## D. Platform capability matrix (plan §7–§8)

| # | Capability | Existing implementation | Status | Decision |
| --- | --- | --- | --- | --- |
| D1 | Provider-neutral adapter contract | `VoiceProviderAdapter` (`voice-provider.ts:569`) — symmetric: `validateWebhook`/`normalizeEvent` in, `initiateCall`/`sendMessage`/`controlCall`/`fetchTranscript` out | 🟢 | **Reuse** — but **not exported** (audit §4.8, E1) |
| D2 | Adapter registry | `VoiceProviderRegistry` (`:645`), code-registered, fail-closed to `DisabledVoiceProvider` | 🟢 | **Reuse** |
| D3 | Error taxonomy | `VoiceProviderError` + 13 `COMMUNICATION_ERROR_CATEGORIES` (`voice-communications-domain.ts:462`) — transient / permanent / auth / rate-limit / unknown all present; policy-blocked split into `consent_required`, `suppressed`, `template_required`, `window_closed` | 🟡 | **Extend** (E3 — only `unsupported` is missing) |
| D4 | Provider HTTP + resilience | Voice has a module-local client (179 lines). AdvancedIntegrations has the complete one: `provider-http-client.ts` (SSRF guards) + `resilience.ts` (equal-jitter retry, `Retry-After`, token-bucket limiter, circuit breaker) | 🟢 | **Reuse** AdvancedIntegrations' (E17) |
| D5 | HMAC / signature helpers | `connectors/kit/webhook-signatures.ts` — the strongest reusable asset in the repo | 🟢 | **Reuse** (E17, zero extension) |
| D6 | Credential storage | `EncryptedCredentialVault` (AES-256-GCM, fails closed without `ENCRYPTION_KEY`); **but** esignature duplicated it and Voice has its own crypto | 🟢 | **Reuse** the shared vault; **do not** create a third stack (R16) |
| D7 | OAuth | `integration_oauth_states` (hashed state, PKCE, single-use) | 🟢 | **Reuse** |
| D8 | Idempotency | `uq_voice_messages_idem`; `send_attempt_id` pattern in esignature | 🟢 | **Reuse** |
| D9 | Internal/external separation | `is_internal_note` CHECK; `stream_items.visibility` + `stream-visibility.ts` | 🟢 | **Reuse** |
| D10 | Record-level ACL | `AclApiService` — `canUser`, `assertAccess`, `recordPredicate`, `canAccessRecord`, `assertRecordAccess` | 🟢 | **Reuse** |
| D11 | Field-level ACL | `fieldAccess`, `visibleFields`, `stripRestricted`, `assertFieldWrites` | 🟢 | **Reuse** |
| D12 | Permission keys | Flat synthetic entity names; `sysAdmin` has a `'*'` wildcard | 🟡 | **Extend** (E18 — non-admin roles need explicit keys) |
| D13 | Audit | `audit_log` + kernel hook inside the mutation transaction | 🟢 | **Reuse** |
| D14 | Background jobs | `JobsService.enqueue` + worker `JobRegistry`; names are metadata, not code | 🟢 | **Reuse** |
| D15 | Durable events | `EventBus.dispatch(tx, …)` + `outbox_events` | 🟢 | **Reuse** |
| D16 | Realtime push | Per-user SSE bound to the `notifications` table | 🟡 | **Extend** (E11 — F4 tension) |
| D17 | Search | Generic over metadata entities; `SEARCH_INDEXED_ATTRS` + trigram indexes must stay in sync | 🔴 | **Build** a projection (G7) — dedicated tables are invisible to search |
| D18 | Reports / analytics | Entity-scoped against metadata; dedicated tables are not reportable | 🔴 | **Build** a projection (G7) |
| D19 | Workflow hooks | `updateRecord`/`createRecord`/`sendEmail`/`runJob` work on a new entity with no engine change; `createNotification` writes to the shared table | 🟡 | **Reuse** with a limit on channel-specific notifications |
| D20 | Attachments | `attachments` + parent-ACL download check + `CompositeScanner` | 🟢 | **Reuse** |
| D21 | AI runtime | `AIAgentRunService.create/triggerRun`; `trigger: 'integration'` exists | 🟡 | **Reuse** (G19 — no typed-task facade; define Omnichannel DTOs on top) |
| D22 | AI approval | Effect-class matrix + `AIAgentApprovalService`; **enforced inside AIAgents, only for registered tools** | 🟡 | **Extend** (E16 — register a `material_write` send tool) |
| D23 | Internal assistant separation | CRMChat has **no** `userType` check | 🟡 | **Exclude** CRMChat from customer-facing use (R17) |
| D24 | Generic search/export scope | `stripRestricted` applies to DTOs, **not** automatically to exports | 🟡 | **Extend** — apply `visibleFields` explicitly on every export path |

---

## E. Frontend, admin, reporting and docs (plan §9–§12)

| # | Item | Existing implementation | Status | Decision |
| --- | --- | --- | --- | --- |
| E1 | Agent inbox UI | `apps/web/src/pages/VoiceInboxPage.tsx` (852 lines) — list, timeline, composer, snippets, handoff | 🟢 | **Reuse**; Omnichannel adds a cross-channel workspace around it |
| E2 | Admin surface | `apps/web/src/pages/VoiceCommunicationsPage.tsx` — accounts, endpoints, templates, health, webhook events | 🟢 | **Reuse** |
| E3 | Module route | `AppRoutes.tsx:138` `/voice-communications`; `navigation-defaults.ts:101` `voiceCommunications` | 🟢 | **Reuse** the pattern for `/omnichannel` |
| E4 | Nav visibility report | `VoiceCommunicationsNavigationService.visibility()` — reports, does not gate | 🟢 | **Reuse** |
| E5 | Customer-facing chat UI | none | 🔴 | **Build** (G8) — and it must never read `is_internal_note` rows |
| E6 | i18n | `i18n/en/voice.json` + `i18n/vi/voice.json` | 🟢 | **Reuse** the pattern |
| E7 | OpenAPI | `@ApiTags('voice-communications')` on the controller | 🟢 | **Reuse** — new tag `omnichannel` |
| E8 | Module docs | `docs/modules/voice-communications/{architecture,operations,providers,webhooks,privacy-and-retention}.md` | 🟢 | **Reuse** the pattern |
| E9 | Compatibility doc | `docs/compatibility/voice-communications.md` | 🟢 | **Reuse** the pattern |
| E10 | Audit doc | `docs/implementation/voice-communications-audit.md` — **stale** (claims no live adapter ships) | 🟡 | **Reuse** the pattern; **do not copy the staleness** |
| E11 | Channel feasibility doc | none | 🔴 | **Build** in OM.1 (`docs/omnichannel/channel-feasibility.md`) |
| E12 | Conversation analytics | none | 🔴 | **Build** (G7) |

---

## F. Testing, database and safety (plan §11)

| # | Item | Existing implementation | Status | Decision |
| --- | --- | --- | --- | --- |
| F1 | Test harness | `bootTestApp()` (`apps/api/test/helper.ts:23`) and `bootModuleTestApp()` (`module-test-app.ts:58`) — the **configured primary database**, `globalSetup: []` | 🟢 | **Reuse** — never create a second database |
| F2 | Test markers | `AGENT_TEST_<runId>` + cleanup by exact id | 🟢 | **Reuse** |
| F3 | Fake provider | `FakeVoiceProvider` + `signFakeWebhook` + `registry.simulator()`; Twilio/Asterisk tests inject `fetchImpl` | 🟢 | **Reuse** — the only outbound path in automated tests |
| F4 | Generic fake adapter | `FakeProviderAdapter` (AdvancedIntegrations) — provider-agnostic | 🟢 | **Reuse** the pattern |
| F5 | Security test reference | `crm-chat-security.test.ts` — cross-user isolation, unauthenticated access, entity-name validation, rate limiting, no raw SQL / shell / unrestricted HTTP | 🟢 | **Reuse** as the template for the Omnichannel security suite |
| F6 | Migrations | `database/migrate.ts` — plain `.sql`, filename order, one transaction each, tracked in `schema_migrations` | 🟢 | **Reuse**; additive only |
| F7 | No-destructive-ops posture | No live `CREATE/DROP DATABASE`, `DROP SCHEMA` or `TRUNCATE` in source | 🟢 | **Preserve** (one stale compiled artifact noted in audit R14) |

---

## G. Cross-cutting platform gaps (not Omnichannel's to own)

| # | Gap | Owner | Extension |
| --- | --- | --- | --- |
| G1 | Raw-body capture is a **hardcoded two-prefix allowlist** (`bootstrap.ts:154-155`) — no registry, no decorator | shared platform | E2 |
| G2 | No generic per-user realtime publish seam | shared platform | E11 |
| G3 | No shared `NotificationService`; `notifications.type` is free-form TEXT with no registry (six modules hand-roll the insert) | shared platform | E12 (optional) |
| G4 | Workflow action set is closed (`updateRecord\|createRecord\|createNotification\|sendEmail\|runJob`); a channel-specific notification needs a new port | shared platform | defer |
| G5 | ACL "permission key" is a convention, not a framework feature — nothing validates that a module's resources are declared | shared platform | accept |
| G6 | `EntityDefinitionSchema` requires `relations` on every entity (fails at bootstrap, not at seed) | shared platform | accept — carry as a template rule |
| G7 | `roles.permissions` has no per-module defaults or assertions | shared platform | E18 |

---

## H. Ownership summary — the one-table answer

| Domain | Authoritative owner | Omnichannel's role |
| --- | --- | --- |
| Channel transport (voice/SMS/WhatsApp) | **VoiceCommunications** | Consumer |
| Email transport | `packages/mail` + the `Email` entity | Consumer (provider not installed) |
| Conversation, message, participant, consent (non-email) | **VoiceCommunications** | Consumer + policy owner |
| Queue, routing, assignment | **ServiceDesk** | Consumer (extension requested) |
| Case lifecycle, SLA | **ServiceDesk** | Consumer (hand-off requested) |
| Campaign, audience, journey, consent (email), suppression | **MarketingAutomation** | Consumer |
| Portal identity and scope | **Portal** | Consumer |
| AI runtime, approvals, runs | **AIAgents** | Consumer (tool requested) |
| Internal assistant | **CRMChat** | **Do not use** |
| Connector framework, vault, HTTP, resilience | **AdvancedIntegrations** | Consumer |
| Audit, ACL, jobs, outbox, attachments, realtime, metadata | **shared platform** | Consumer |

---

## I. Sub-phase readiness (plan §14)

A blunt readiness read for the 23 sub-phases, **after the three OM.0 decisions were locked**
(plan §0.2). **This is OM.0 output, not a commitment** — OM.1 re-derives it.

| Sub-phase | Readiness | Note |
| --- | --- | --- |
| OM.1 — channel set + first path | 🟡 | Two credible paths: website chat into `voice_conversations`, or email-thread ingestion. Both force a decision (F5 / F2). The D1–D3 decisions are already fixed and carried in. |
| OM.2 — module skeleton | 🟢 | 13-file registration checklist is known (audit §5.4.1). |
| OM.3 — schema | 🟡 | **Unblocked by D1** — the work is an additive extension of `voice_conversations`/`voice_conversation_participants`, not a new model. Still needs the thread-cardinality design (E6). |
| OM.4 — adapter contract | 🟢 | `VoiceProviderAdapter` already satisfies §4.2 — but must be exported (E1) and published as a contract (E14). |
| OM.5 — inbound pipeline | 🟡 | Reuse `voice-webhook-ingress.service.ts`; close the raw-body gap (E2). |
| OM.6 — outbound pipeline | 🟡 | Reuse `send`; add reconcile-unknown (E7). |
| OM.7 — consent | 🟢 | Owners are clear; Omnichannel adds no store. |
| OM.8 — routing | 🟡 | **Unblocked by D2** — the work is an additive ServiceDesk extension of `CaseQueue`/`RoutingRule`, not a new engine. |
| OM.9 — website/Portal chat | 🔴 | Needs the anonymous-visitor identity decision (F5). |
| OM.10 — AI assistance | 🟡 | Needs a registered `material_write` send tool (E16). |
| OM.11 — reporting | 🔴 | Dedicated tables are outside generic reports/search (G7). |
| OM.12 — realtime | 🟡 | **Decided by D3** — extend `NotificationEventsService`, then add a module-scoped SSE endpoint over it (E11). |
| OM.13 — permission model | 🟡 | Flat synthetic keys; E18 for non-admin roles. |
| OM.14–OM.18 — channels, AI, campaigns | 🟡 | Depends on OM.1's channel set. |
| OM.19–OM.23 — hardening, docs, verification | 🟢 | The doc/test patterns are known. |

---

## J. Decisions locked at Phase 19-OM.0

Recorded in `PLAN_Phase_19_Omnichannel.md` §0.2. They are binding on every later sub-phase.

| # | Decision | Replaces |
| --- | --- | --- |
| **D1** | The canonical conversation record is the existing **`voice_conversations`**, extended additively. `OmnichannelMessage` = `voice_messages`, `OmnichannelChannelThread` = `voice_conversations.external_thread_id`, `OmnichannelIdentity` = `voice_conversation_participants`, `OmnichannelConversationEvent` = `voice_conversation_events`, `OmnichannelConnection` = `voice_provider_accounts` + `voice_endpoints`. Omnichannel owns the **workspace, multi-channel policy and projection**; VoiceCommunications owns the **record**. | Building `OmnichannelConversation` + `OmnichannelMessage` as new stores |
| **D2** | Queues and routing are owned by **`ServiceDesk`** and extended there: `OmnichannelQueue` = `CaseQueue` (+`QueueMember`), `OmnichannelRoutingRule` = `RoutingRule`. The extension (conversations as routed objects, a wider operator allowlist, business-hours routing, skills) is an additive ServiceDesk change. | Building `OmnichannelQueue` / `OmnichannelRoutingRule` |
| **D3** | Realtime: **extend `NotificationEventsService` with a generic per-user publish seam** (a shared-platform change), and give Omnichannel **its own module-scoped SSE endpoint** over that seam — following the `CRMChat` precedent. One platform gateway implementation; no second `LISTEN/NOTIFY` channel, connection pool, or auth path. | A second generic realtime gateway, or reusing the notification-bound stream as a conversation transport |

**Two prerequisites that are edits, not decisions:**

1. `bootstrap.ts` must learn the Omnichannel webhook prefix before any real provider can sign bytes (E2).
2. The Voice barrel must export `VoiceInboxService`, `VoiceMessagingService` and the
   `VoiceProviderAdapter` interface before Omnichannel can consume them without a deep import (E1).

**Still open, and genuinely OM.1's to make:**

- The first channel set and the first end-to-end path (website chat vs. email-thread ingestion).
- The **anonymous-visitor identity** and its consent basis (F5) — Portal has no anonymous principal.
- The **email double-processing** contract against `EmailToCaseService` (F2).
- The **conversation↔thread cardinality** (E6) — one thread per conversation today.
- The **Case hand-off contract** in ServiceDesk (E9): `Case.externalId`, a `Case.conversations`
  relation, and a create-or-link command.
- Whether to route channel transport through `AdvancedIntegrations`' `ConnectorAdapter` (which
  cannot send) or through Voice's own adapter (E15).
