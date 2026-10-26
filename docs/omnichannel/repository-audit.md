# Phase 19-OM.0 — Omnichannel repository audit

> `PLAN_Phase_19_Omnichannel.md` §14 `19-OM.0`.
> Deliverables: this document and `docs/omnichannel/capability-matrix.md`.
> Acceptance: the audit identifies the current authoritative records/services for every channel that
> already exists; what can be reused directly; what small extension is required; and no duplicate
> transport, inbox, Case, campaign engine, Portal auth or AI runtime is proposed without a
> documented gap.
>
> **This phase produced no code, no migration and no metadata change.** Only documentation.
>
> **Update — decisions locked.** The three architectural questions this audit raised were decided
> after it was written, and are now recorded in `PLAN_Phase_19_Omnichannel.md` §0.2:
>
> - **D1** — the canonical conversation record is the existing **`voice_conversations`**, extended
>   additively. Omnichannel owns the workspace and the multi-channel policy; VoiceCommunications
>   owns the record.
> - **D2** — queues and routing are owned by **`ServiceDesk`** and extended there
>   (`CaseQueue`/`QueueMember`/`RoutingRule`).
> - **D3** — realtime: **extend `NotificationEventsService` with a generic per-user publish seam**,
>   and give Omnichannel **its own module-scoped SSE endpoint** over that seam.
>
> This audit's §4, §5, §7, §8 and §9 remain the evidence base for those decisions; §12 has been
> updated to reflect what is now settled and what is still genuinely open.

Audited on branch `master` at commit `7701d8e`. Sources read: `AGENTS.MD`, `PLAN.md`,
`PLAN_Phase_19_Omnichannel.md` (§0–§13), `PLAN_Phase_19_Voice_Communications.md`,
`PLAN_Phase_19_ServiceDesk.md`, `PLAN_Phase_19_Marketing_Automation.md`,
`PLAN_Phase_19_Advanced_Integrations.md`, `PLAN_Phase_19_AI_Agents.md`,
`PLAN_Phase_19_CRM_Chat.md`, `docs/module-guide.md`, `docs/modules/voice-communications/providers.md`,
`docs/compatibility/voice-communications.md`, `apps/api/src/**`, `apps/web/src/**`, `apps/worker/src/**`,
`packages/*`, `database/migrations/*`, `database/seed.ts`, `database/seed-metadata.ts`,
`vitest.config.ts`, `docker-compose.yml`, `scripts/`.

> **Caution on one document.** `docs/implementation/voice-communications-audit.md` was written at
> 19-VC.0 and is **stale**: it states that only the `fake` simulator ships and that "a production
> adapter (Twilio first candidate) is not claimed". Twilio and Asterisk adapters are shipped and
> registered today. The current source of truth is `docs/modules/voice-communications/providers.md`.

---

## 1. Executive summary — the finding that changes the plan

**The canonical conversation model this plan asks Omnichannel to build already exists in
`VoiceCommunications`, and it is further along than the plan assumes.**

Plan §5 specifies `OmnichannelConnection`, `OmnichannelConversation`, `OmnichannelChannelThread`,
`OmnichannelIdentity`, `OmnichannelMessage`, `OmnichannelAssignmentHistory` /
`OmnichannelConversationEvent`, `OmnichannelQueue` / `OmnichannelRoutingRule`, and webhook/send
operation records. Migrations `051`/`052`/`053` already created, for the voice/SMS/MMS/WhatsApp
channel family, a dedicated-table equivalent of every one of those except the queue/routing pair:

| Plan §5 logical entity | Existing implementation | State |
| --- | --- | --- |
| `OmnichannelConnection` (§5.1) | `voice_provider_accounts` + `voice_endpoints` | **Exists** |
| `OmnichannelConversation` (§5.2) | `voice_conversations` | **Exists, channel-scoped** |
| `OmnichannelChannelThread` (§5.3) | `voice_conversations.external_thread_id` (one thread per conversation) | **Exists, simplified** |
| `OmnichannelIdentity` (§5.4) | `voice_conversation_participants` | **Partial** — no provider-identity uniqueness, no link confidence |
| `OmnichannelMessage` (§5.5) | `voice_messages` | **Exists** — state enum matches the plan exactly |
| `OmnichannelConversationEvent` (§5.6) | `voice_conversation_events` | **Exists** — append-only |
| `OmnichannelQueue` / `OmnichannelRoutingRule` (§5.7) | `CaseQueue` / `QueueMember` / `RoutingRule` (ServiceDesk) | **Exists in ServiceDesk** |
| Webhook + send records (§5.8) | `voice_webhook_events`, `voice_communication_events` | **Exists** |

The shared inbox, composer/timeline, assignment, transfer history, case hand-off, canned snippets,
WhatsApp template registry, delivery-status reconciliation, per-channel consent and suppression,
provider health, webhook replay, and the agent inbox UI **all exist today** under
`VoiceCommunications` (`apps/api/src/voice-communications/`, 34 files / ~10k lines;
`apps/web/src/pages/VoiceInboxPage.tsx`, 852 lines). Two **live** provider adapters ship with it —
Twilio (voice + SMS + WhatsApp) and Asterisk ARI (voice) — plus a fake simulator.

**Consequence.** Building a parallel `OmnichannelConversation`/`OmnichannelMessage` pair would
create exactly the "second inbox" and "second authoritative delivery state" that §0.1 forbids. The
Omnichannel module's real job is therefore narrower and more valuable than the plan's first draft
assumes:

1. **Widen the channel scope of the existing conversation model** (it is hard-scoped to
   `('sms','mms','whatsapp')` by CHECK constraints, and voice calls are *not* conversations) so a
   website/Portal chat, an email thread and a future social adapter can join the same canonical
   timeline — or explicitly decide they do not.
2. **Own the multi-channel workspace**: cross-channel continuity, identity resolution across
   channels, queue/routing policy for conversations, and the agent workspace UI — the parts
   VoiceCommunications (one channel family) does not model.
3. **Consume VoiceCommunications as the transport owner** through its existing
   `VoiceProviderAdapter` / `VoiceProviderRegistry` contract, exactly as §0.1 and §2.3 require.

### 1.1 The five findings that must shape the roadmap

| # | Finding | Consequence for the plan |
| --- | --- | --- |
| **F1** | **ServiceDesk already owns queues and routing.** `CaseQueue`, `QueueMember`, `RoutingRule`; strategies `manual`/`roundRobin`/`leastBusy`; fallbacks `unassigned`/`fallbackOwner`; a workload endpoint; a `CaseAssignment` audit entity. | Plan §5.7 must **reuse**, not build. But routing there ignores business hours, has no skills/language/tier model, and its operators are limited to `equals`/`notEquals`/`in`. |
| **F2** | **The inbound-email path exists as a port, not a provider.** `packages/mail` exposes `InboundMailProvider` + `InboundMailMessage` (with `threadId`), but the API binds `NullInboundProvider`, so polling is a no-op. ServiceDesk's Email-to-Case is **manually triggered only** — no scheduled job. | The email channel is a seam until a provider is configured. If Omnichannel schedules inbound ingestion, it **will** race `EmailToCaseService.processInbound()` unless it honours the `emailToCaseStatus` marker. |
| **F3** | **The raw-body webhook hook does not cover the voice/Omnichannel webhook prefix.** `apps/api/src/bootstrap.ts:153` scopes `preParsing` to the ESignature and AdvancedIntegrations prefixes only. | `/api/v1/integrations/voice-communications/*` falls back to `JSON.stringify(body)`. Fine for the simulator's canonical-JSON HMAC; **wrong for any provider that signs exact bytes**. A one-line prerequisite. |
| **F4** | **Realtime is notification-only.** The single SSE gateway (`stream.controller.ts:185`) is hard-wired to the `notifications` table by a DB trigger (`migration 063`) and carries no payload beyond `(userId, id, type)`. There is **no generic "publish this event to this user's stream" seam**. | Plan §6.3 ("do not implement a second realtime gateway") is **in direct tension** with the platform. This needs an explicit decision in OM.1. |
| **F5** | **There is no anonymous Portal principal.** Every portal route requires an authenticated `users.type='portal'` user with a `contact_id`. | Plan §3.6's website/Portal chat has **no identity to scope against** for an anonymous visitor. The only `@Public()` intake today is ServiceDesk's `webToCase`. |
| **F6** | **VoiceCommunications publishes exactly one cross-module contract** (`voiceCommunications.consent.suppress`). There is **no published send-message or read-inbox contract**. | Plan §2.3 assumes a consumable transport contract. `VoiceMessagingService.send()`/`.ingestInbound()` exist but are not exposed — and `VoiceInboxService`/`VoiceMessagingService` are **not exported from the barrel** (§4.8). |
| **F7** | **The repo's other connector framework cannot send.** `CONNECTOR_OPERATIONS = read\|create\|update\|delete\|upsert\|webhook` — no `send`. | A channel send is not an upsert. Using `upsertObject` would break the port's own promise that `validateConnection` *"never creates, updates, charges, sends or deletes a provider object"*. |

### 1.2 Two traps in the plan's own vocabulary

- **"MarketingAutomation campaign touchpoint"** (plan §5.2, §1.1) has **no literal counterpart** in
  the code. The real artifacts are `MarketingSend` (one message within a campaign),
  `marketing_recipient_deliveries` (the per-recipient ledger) and `MarketingJourneyStepExecution`.
  The word "touchpoint" appears only in Customer Success.
- **"ServiceDesk hand-off"** (plan §1.1 outcome #10, OM.17) is **not a contract that exists**.
  `Case` has no `externalId`/`sourceRef`, no `conversations` relation, and no create/link command.
  Voice worked around this by calling the **generic entity API** (`voice-inbox.service.ts:398`),
  which produces no `CaseTransition` history row and sets no `source`.

Nothing in the audit requires a destructive migration, a new database, or a second transport.

---

## 2. Repository shape, tooling and conventions

| Concern | Fact | Evidence |
| --- | --- | --- |
| Monorepo | pnpm workspace; root `package.json` + `pnpm-workspace.yaml` | `package.json` (`packageManager: pnpm@10.0.0`, `engines.node >=22`) |
| Backend | NestJS + Fastify adapter, TypeScript strict | `apps/api/src/bootstrap.ts:135` (`new FastifyAdapter(...)`) |
| Frontend | React + Vite SPA (`apps/web`), Ant Design | `apps/web/src/pages/`, `apps/web/src/AppRoutes.tsx` |
| Worker | Separate `apps/worker` process (BullMQ + cron) | `apps/worker/src/handlers/` |
| Persistence | PostgreSQL via Kysely; generic records in `entity_records` | `packages/query-engine/src/index.ts:45-74` |
| Migrations | Plain `.sql`, filename order, one transaction each, tracked in `schema_migrations` | `database/migrate.ts:11` |
| Package manager / lockfile | pnpm, single `pnpm-lock.yaml` | `package.json` |
| Lint / typecheck / test | `eslint . --max-warnings=0`; `tsc --noEmit` (api + web); `vitest run` | `package.json` scripts |
| CI | **None.** `.github/workflows/` does not exist | `ls .github/workflows` → no such directory |
| Local infra | `docker-compose.yml` — postgres 17 + redis 7 only (no app container, no test DB) | `docker-compose.yml` |
| E2E | Playwright specs under `e2e/` (21 specs) via `scripts/e2e-smoke.sh` | `e2e/`, `package.json` `test:e2e` |
| Docs conventions | `docs/implementation/*-audit.md`, `docs/compatibility/<module>.md`, `docs/modules/<module>/`, `content/docs/{en,vi}/` | `docs/modules/voice-communications/` |

### 2.1 Naming and route conventions (confirmed)

- Module id `Omnichannel`, class `OmnichannelModule`, slug `omnichannel`. **No `Ua` prefix**
  (plan §0, §0.1). The same rule already governs `VoiceCommunications`, `ServiceDesk`,
  `ESignature`, `LeadScore`.
- Kernel domain modules live as directories under `apps/api/src/<slug>` and export
  `<NAME>_PROVIDERS` / `<NAME>_CONTROLLERS` from a barrel; `apps/api/src/app.module.ts` spreads
  them (`docs/module-guide.md:71`, `:86-87`).
- API prefix for module commands: `/api/v1/<ModuleName>/action/...` (e.g.
  `/api/v1/VoiceCommunications/action/...`, `app.module.ts:141`). Provider webhooks live under
  `/api/v1/integrations/<slug>/...` (`voice-webhook.controller.ts:24`).
- **Controller ordering is load-bearing.** Every static prefix must be spread **before**
  `...ENTITY_CONTROLLERS` (the generic `/api/v1/:entity` wildcard) — `app.module.ts:159-160`,
  `entity.module.ts:19-28`. The full must-be-before list: `METADATA_`, `STREAM_`, `CALENDAR_`,
  `LOGIC_`, `SEARCH_`, `WORKFLOW_`, `PROCESS_`, `EXTENSION_`, `SETTINGS_`, `SETUP_CHECKLIST_`,
  `ADMIN_PANEL_`, `ATTACHMENT_`, `AUDIT_`, `CALENDAR_`, `EMAIL_`, `PREFERENCES_`, `PORTAL_`,
  `PROJECTS_`, `SALES_`, `CUSTOMER_SUCCESS_`, `SERVICE_DESK_`, `MARKETING_AUTOMATION_`,
  `AI_AGENTS_`, `CRM_CHAT_`, `VOICE_COMMUNICATIONS_`, `ADVANCED_INTEGRATIONS_`, `ESIGNATURE_`,
  `LEADSCORE_`, `DOCUMENT_`, `DOCS_`.
- Frontend route convention: kebab-case path + `apps/web/src/AppRoutes.tsx` + a navigation entry
  in `apps/api/src/admin-panel/navigation-defaults.ts` with a `permission` gate.
- Synthetic capability entities (`CommunicationConversation`, `CommunicationMessage`,
  `VoiceProviderAccount`, `IntegrationConnection`, `CRMChatConversation`) are **not** metadata
  entities. They are role permission keys only: `roles.permissions` is a JSON map keyed by entity
  name (`database/seed.ts:136-142`, `docs/module-guide.md:64-68`). A module adds one by adding the
  key to a role's permission map. **This is a convention, not a framework feature** — nothing
  validates that a module's resources are declared anywhere, so a typo silently yields `no` for
  everyone (fail-closed, but debug-hostile).

### 2.2 A metadata tripwire to carry into OM.3

`EntityDefinitionSchema` declares both `fields` and `relations` as required records with **no
default**. An entity definition that omits `relations` passes the seed but fails at app bootstrap
as `ValidationError: Invalid metadata for entity "X"` — which reads like a database problem
(`.trail/learnings/2026-10-17-service-desk-sd-4-sd-5-jacky.md`). The invariant currently holds:
**96 of 96** `scope: 'entity'` entries in `database/seed-metadata.ts` carry a `relations` key.

---

## 3. The platform layer Omnichannel will build on

Everything here is reusable as-is. Omnichannel owns no auth, ACL, audit, queue, event bus or file
store.

| Capability | Where | What Omnichannel uses it for |
| --- | --- | --- |
| Authentication | `apps/api/src/auth` (`AuthGuard`, `@Public()`, `AuthService.createSession`) | Bearer sessions; the public web-chat route opts out explicitly |
| Authorization | `apps/api/src/acl/acl-api.service.ts` — `canUser`, `assertAccess`, `fieldAccess`, `visibleFields`, `stripRestricted`, `assertFieldWrites`, `recordPredicate`, `canAccessRecord`, `assertRecordAccess`, `portalRecordVisible`, `canUserAs` | Every inbox, message, export, attachment and count endpoint |
| Record engine | `apps/api/src/entity/entity.service.ts` (`EntityCrudService`), `packages/entity-engine` | Generic CRUD; `runInTransaction`/`currentTx` (`apps/api/src/entity/tx-context.ts:8,22`) |
| Physical vs `attrs` | `packages/query-engine/src/index.ts:45-74` — 11 physical columns (`id`, `name`, `entity_type`, `created_at`, `modified_at`, `assigned_user_id`, `created_by_id`, `modified_by_id`, `deleted_at`, `team_ids`, `version`); **everything else in `attrs` JSONB** | A new metadata entity gets **no** physical columns — every field lands in `attrs`, so filtering/sorting is GIN-on-whole-JSONB unless a hand-added index exists |
| Metadata | `packages/metadata`, `apps/api/src/metadata/metadata-store.service.ts`, `database/seed-metadata.ts` | Entity/field/layout definitions; extension merge; admin overrides in `app_settings` (precedence: core → extensions → admin, `docs/module-guide.md:349-351`) |
| Audit | `apps/api/src/audit`, `audit_log`, `AuditHookService` via `KERNEL_HOOKS_TOKEN` | Writes flow **through the kernel hook inside the mutation transaction** (`entity-record.store.ts:165-171`); a module must not append to `audit_log` by hand |
| Stream / Activity | `apps/api/src/stream`, `stream_items`, `visibility` column | Case timeline model; the internal/public rule (`stream-visibility.ts:19,56`) |
| Attachments | `apps/api/src/attachment`, `attachments`, `PARENT_ACL_CHECK_TOKEN`, `packages/files` | Message media; download ACL on read; SHA-256 in one pass; `CompositeScanner` fails closed |
| Notifications | `notifications` table (`002_stream.sql:45-53`) | Assignment and new-message notifications. **No shared `NotificationService`** — six modules hand-roll `insertInto('notifications')`, and `type` is free-form TEXT with no registry |
| **Realtime** | PostgreSQL `LISTEN/NOTIFY` on `crm_notifications` (`migration 063`; `notification-events.service.ts:20,97`) → per-user **SSE** at `GET /api/v1/Notification/stream` (`stream.controller.ts:185`) | The **only** live push path. **Notification-only**: the DB trigger fires on `notifications` inserts and the payload is `(userId, id, type)` — no generic publish seam (see **F4**) |
| Jobs | `apps/api/src/jobs/jobs.service.ts` (`enqueue`, `runScheduleNow`), `jobs`/`job_logs`, worker `JobRegistry` (`apps/worker/src/app.ts:74,240`) | Async inbound processing, retention sweeps, replay. Job names are camelCase 2–4 dot segments; **only a registered name can run — metadata stores names, never code** |
| Outbox / domain events | `apps/api/src/events/event-bus.ts` — `EventBus.dispatch(tx, {type, payload})`; `outbox_events` | Durable conversation events. Naming convention `<module>.<resource>.<action>` with `schemaVersion` in the payload. **Relation link/unlink and notification writes publish no events** — conversation lifecycle events must be dispatched explicitly |
| Secrets | `ENCRYPTION_KEY` + `encryptSecret`/`decryptSecret` (`@carocrm/core/utils/crypto`) | Provider credentials, webhook secrets |
| Settings | `app_settings` (one validated row per module, e.g. `voiceCommunications`) | Module feature flags; every optional capability defaults **off** |
| Search | `apps/api/src/search` — generic over **metadata entities**; `SEARCH_INDEXED_ATTRS = ['firstName','lastName','emailAddress','phoneNumber']` (`search/portal-shapes.ts:29`) | **Gap:** dedicated-table modules (Voice) are **not** searchable. A new searchable attribute needs both the attr-list change **and** a matching trigram index migration, or every search degrades to a sequential scan (`docs/module-guide.md:299-307`) |
| Reports | `apps/api/src/reports`, `packages/reports` — dedicated `reports` table, **entity-scoped**, field readability enforced per field (`report.service.ts:419`) | **Gap:** reports resolve field paths against **metadata**, so a dedicated-table conversation is **not reportable** without new work |
| Workflow / BPM | `apps/api/src/workflows`, `packages/workflow`, `packages/bpm` | `updateRecord`/`createRecord`/`sendEmail`/`runJob` work on a new metadata entity with no engine change. **`createNotification` writes to the shared `notifications` table**, so a channel-specific notification needs a new action port (an engine change) |
| Email | `apps/api/src/email`, `packages/mail` | The **email channel seam** — see §5.2 |
| Hooks | `apps/api/src/hooks` (`HookRegistry`, `KERNEL_HOOKS_TOKEN`), `apps/api/src/events/entity-event.hook.ts` | Write guards; entity event fan-out. `HookPhase` is a `string`, not a closed enum — a module may add a phase |

---

## 4. VoiceCommunications — the existing transport and conversation owner

`apps/api/src/voice-communications/` — 34 files, ~10,049 lines. Migrations `051`, `052`, `053`,
`054`. Descriptor in `voice-communications-module.ts` (`loadOrder: 390`, `apiPrefix:
"/api/v1/VoiceCommunications"`, `webhookPrefix: "/api/v1/integrations/voice-communications"`,
`slug: "voice-communications"`, `entityTypes: []` — it owns **no** metadata entity).

### 4.1 The adapter contract already satisfies plan §4.2

`VoiceProviderAdapter` (`voice-provider.ts:569-593`) is a **symmetric** provider-neutral contract:

```ts
export interface VoiceProviderAdapter {
  readonly info: VoiceProviderInfo;
  hasCapability(capability: ProviderCapability): boolean;
  validateWebhook(request: ProviderWebhookRequest, account: ResolvedProviderAccount): Promise<ValidatedProviderEvent>;
  normalizeEvent(event: ValidatedProviderEvent, account: ResolvedProviderAccount): NormalizedProviderEvent;
  healthCheck(account: ResolvedProviderAccount): Promise<ProviderHealthResult>;
  initiateCall?(input: InitiateCallInput): Promise<InitiateCallResult>;
  controlCall?(input: CallControlInput): Promise<CallControlResult>;
  sendMessage?(input: SendMessageInput): Promise<SendMessageResult>;
  fetchTranscript?(input: { account; providerRef }): Promise<TranscriptFetchResult>;
}
```

- **Capability lookup** — `hasCapability` + `VoiceProviderInfo.capabilities` +
  `effectiveCapabilities(info, accountCapabilities)` (`voice-provider.ts:244`).
- **Normalized event union** — `NormalizedProviderEvent` = call | message | status | recording |
  unknown (`voice-provider.ts:155`), i.e. the plan's `NormalizedInboundEvent`.
- **Error taxonomy** — `VoiceProviderError` carries `category` + `retryable` + `status`
  (`voice-provider.ts:257`); `retryable` is true only for `rate_limit`, `timeout`,
  `provider_unavailable`. `categorizeHttpStatus` (`:275`) maps an HTTP status to a category.
  `COMMUNICATION_ERROR_CATEGORIES` (`voice-communications-domain.ts:462`) declares **13**
  categories: `auth`, `rate_limit`, `timeout`, `invalid_request`, `invalid_recipient`,
  `consent_required`, `suppressed`, `template_required`, `window_closed`, `provider_unavailable`,
  `invalid_response`, `media_rejected`, `unknown`.
  This already covers plan §4.2's list almost completely — transient (`timeout`,
  `provider_unavailable`, `rate_limit`), permanent (`invalid_request`, `invalid_recipient`,
  `invalid_response`, `media_rejected`), authentication (`auth`), rate-limited (`rate_limit`),
  unknown (`unknown`), and **policy-blocked is represented by four more precise categories**
  (`consent_required`, `suppressed`, `template_required`, `window_closed`) rather than one
  umbrella term. **The single genuinely missing category is `unsupported`** — a capability the
  adapter does not implement.
- **Registry** — `VoiceProviderRegistry` (`:645`) with `resolve/register/has/keys/describeAll/
  simulator`. Registration is a code-time `Map`, not data: "an operator can configure an account,
  but cannot install an adapter at runtime" (`voice-provider-binding.service.ts:7-13`).
- **Fail-closed** — an unknown key resolves to `DisabledVoiceProvider` (`:540`); `fake` resolves to
  disabled under `NODE_ENV=production` (`:653-655`).
- **Implemented adapters** — `TwilioProviderAdapter` (`voice-provider-twilio.ts`, 584 lines: voice +
  SMS + **WhatsApp via Twilio's WhatsApp API**, not Meta Cloud API) and
  `AsteriskProviderAdapter` (`voice-provider-asterisk.ts`, 428 lines, ARI voice only), both
  registered at module init (`voice-provider-binding.service.ts:19-22`).
- **HTTP boundary** — `voice-provider-http.ts`: 15 s timeout, 1 MB response cap, injectable
  `fetchImpl`, SSRF guard. It is **module-local and not exported** — there is no shared
  provider-HTTP package.
- **Signature primitives** — `voice-provider-crypto.ts`: canonical-JSON HMAC-SHA256 over
  `timestamp + "." + stableStringify(body)`, Twilio `X-Twilio-Signature` HMAC-SHA1, constant-time
  compare.

**MMS is a stub.** It is named in the channel vocabulary, the table CHECKs and the DTOs, but **no
adapter declares `messaging.mms.send`/`.receive`** (`docs/modules/voice-communications/providers.md`
§2). WhatsApp templates, recordings and transcripts are simulator-only for Twilio/Asterisk.

### 4.2 Inbound pipeline already exists

`voice-webhook.controller.ts` — `@Public()`, `@HttpCode(202)`,
`POST :providerKey/:accountKey/:kind` (kinds `voice-events | message-events | status-events |
media-events`) → `voice-webhook-ingress.service.ts` (350 lines) → durable receipt in
`voice_webhook_events` → `voice-event-processor.service.ts` → `voice-messaging.service.ts.ingestInbound`.

- **Dedup** — `uq_voice_webhook_events_dedup (account_key, dedup_key)`; `dedup_key` is the provider
  event id or a digest of type+object+time (`migration 051:62,77`). The insert is
  `on conflict … do nothing` (`ingress:299`); a duplicate is detected by read-back and returns
  `{duplicate: true}` (`ingress:186-190`).
- **One normalized event per receipt** — `uq_voice_communication_events_receipt (webhook_event_id)`
  (`migration 051:102`).
- **Signature check before any effect** — the adapter must declare
  `webhook.signatureValidation` (`ingress:97`); an invalid signature raises
  `AuthenticationFailedError` (`ingress:126`, `:156`). A receipt that failed validation is still
  persisted with `signature_valid = false` (auditable) but **cannot be replayed** (`ingress:255`).
- **Replay window** — `WEBHOOK_REPLAY_WINDOW_MS = 5 min` (`domain:527`); a stale timestamp is
  refused before any signature work (`ingress:109`). Body cap `WEBHOOK_MAX_BODY_BYTES = 256 KB`
  (`domain:530`).
- **Redacted payload only** — `payload_redacted`, credential-like keys stripped (`migration 051:72`).
- **Replay is an authorized admin operation** — `POST action/webhook-events/:id/replay`
  (`voice-communications.controller.ts:240`).
- **Inbound contract available today** — the platform EventBus carries
  `voiceCommunications.message.received` / `.queued` / `.sent` / `.delivered` / `.failed`
  (`domain:395-411`), dispatched at `voice-event-processor.service.ts:170`. The payload carries
  **identifiers only, never a message body or recording URL** (`domain:390-392`), so a consumer must
  re-read content through an authorization-aware service.

**Gap (F3).** The raw-body `preParsing` hook (`apps/api/src/bootstrap.ts:153-176`) is scoped to
`ESIGNATURE_WEBHOOK_PREFIX` and `ADVANCED_INTEGRATIONS_WEBHOOK_PREFIX` only. The voice prefix
`/api/v1/integrations/voice-communications` is **not** covered, so `voice-webhook-ingress.service.ts:91`
falls back to `JSON.stringify(input.body)`. The simulator's canonical-JSON HMAC still verifies, but
**any provider that signs exact bytes cannot be verified** until the prefix is added to the hook.

### 4.3 Outbound pipeline already exists

`voice-messaging.service.ts` (`VoiceMessagingService`, 570 lines):

- `send(input)` (`:150`) — ACL assert (`:151`) → idempotency lookup (`:166`) → **policy check #1**
  (`:186`) → **message row written in state `queued` with its idempotency key before any external
  dispatch** (`:455-460`) → **policy check #2 immediately before dispatch** (`:226`, so a revoked
  consent cancels a queued message) → `adapter.sendMessage` → provider acceptance.
  The module doc states the durable order explicitly (`:31-32`).
- `ingestInbound(...)` (`:284`) — inbound normalization → find-or-create conversation → participant
  upsert → message insert.
- `applyStatus({providerMessageId, state, ...})` (`:325`) — delivery-status reconciliation; returns
  `{changed, messageId}`. `MESSAGE_STATE_RANK` + `advanceMessageState()`
  (`voice-communications-domain.ts:293-317`) enforce **no regression** — a stale status cannot
  overwrite a newer terminal one. `unknown` never overrides a known state.
- **Idempotency** — `uq_voice_messages_idem (idempotency_key)` (`migration 052:14`);
  `uq_voice_messages_provider_message (account_key, provider_message_id)` (`migration 051:230`).
- **Internal notes are structurally excluded from external sends** — DB CHECK
  `CHECK (NOT (is_internal_note AND provider_message_id IS NOT NULL))` (`migration 051:227-228`).
  This satisfies plan §5.5 and §1.2's "no public/internal ambiguity" at the schema level.
- `recordMedia(...)` references `attachments` storage rather than creating a second file store.

**Message state enum** (`migration 051:212-214`, mirrored at `domain:274-284`) —
`draft | queued | submitted | sent | delivered | read | failed | undelivered | unknown`. Directly
reusable for plan §0.1's "explicit states … only where the channel actually supports them".

**Conversation state enum** (`migration 051:156-158`) — `open | pending_customer | pending_internal |
resolved | closed | spam`. Deliberately separate from `Case` status:
`voice_conversations.case_id` is a reference and "Conversation status never mutates Case status"
(`migration 051:167`).

**Gap.** There is **no status-polling job** — reconciliation happens only through inbound provider
callbacks. There is no "reconcile an unknown send" command, so plan §3.5 ("reconcile using provider
IDs or status checks before repeating the send") **cannot be satisfied today**.

**Gap.** No **inbound STOP/UNSUBSCRIBE keyword scanner** exists. `stop_keyword` is only a
*suppression reason* (`voice-consent.service.ts:58`); opt-out today depends on an external caller
invoking the suppression API or the `voiceCommunications.consent.suppress` contract
(`advanced-integrations/contracts/voice-contracts.ts:46-71`).

### 4.4 The shared inbox already exists

`voice-inbox.service.ts` (`VoiceInboxService`, 506 lines):

| Method | Line | Capability |
| --- | --- | --- |
| `list(query)` | 117 | Inbox list with filters |
| `timeline(conversationId, {limit, offset})` | 158 | Chronological message + event timeline |
| `markRead` | 233 | Unread projection |
| `setStatus` | 243 | State transition |
| `assign({userId, teamId, reason})` | 269 | Agent/team assignment |
| `history` | 324 | Assignment/state event history |
| `linkCase` | 357 | Link an existing Case |
| `handoffToCase({subject, description, reason})` | 380 | **Hand-off that creates a Case** |

Plus `voice-panel.service.ts` (customer context panel; `assertAccess('CommunicationConversation',
'edit')` at `:182`), `voice-message-template.service.ts` (canned snippets),
`voice-whatsapp-template.service.ts` (provider-approved template registry, status
`pending|approved|rejected|disabled`).

`handoffToCase` calls `this.entities.create('Case', {...})` — the **generic entity API**
(`voice-inbox.service.ts:398`), not a ServiceDesk command. Consequences: no `CaseTransition` history
row, no `source` set, and `assignedUserId` written directly (which works only because it is not
server-owned — see §5.1). The link back to the conversation lives **only** in
`voice_conversations.case_id`; the Case has no pointer to the conversation.

**Frontend:** `apps/web/src/pages/VoiceInboxPage.tsx` (852 lines) — conversation list, timeline,
composer, snippets, handoff; polls on 15–20 s intervals. `VoiceCommunicationsPage.tsx` — the
admin/diagnostics surface.

### 4.5 Field-level gaps against plan §5

`voice_conversations` (`migration 051:151-172`) has: `account_key`, `channel`, `external_thread_id`,
`status`, `subject`, `assigned_user_id`, `assigned_team_id`, `unread_count`, `last_activity_at`,
`last_inbound_at`, `related_entity_type`, `related_entity_id`, `case_id`, `archived`.

**Absent** (plan §5.2 asks for them): `priority`, `category`, `language`, `tags`, `currentQueueId`,
`assignmentVersion`, `lastOutboundAt`/`lastMessageAt` (only `last_activity_at` exists),
`snoozedUntil`, `closedAt`, `version` (no optimistic-concurrency column), campaign/touchpoint
source. Verified: no column matching `priority|category|language|tags|snoozed|closedAt|version|
queueId|lastOutbound|lastMessage` exists in migration 051.

`voice_conversation_participants` (`migration 051:185-201`) has `address`, `role`, `entity_type`,
`entity_id`, `display_name`, `consent_status`, unique `(conversation_id, address, role)`.

**Absent** (plan §5.4): a **provider identity id distinct from the address**, `verificationState`,
`linkConfidence`/`linkReason`, `lastSeenAt`, `sourceProvenance`, and a uniqueness rule over
*connection + channel + provider identity*. **The address is the identity key today.** There is no
channel-identity table anywhere in the module.

`voice_conversations.channel` is CHECK-constrained to `('sms','mms','whatsapp')`
(`migration 051:154`) — **voice calls are not conversations**; they live in `voice_call_sessions`
with only `related_entity_type`/`related_entity_id` links. There is no voice↔SMS grouping and no
`ConversationChannelThread` equivalent (plan §5.3 assumes N provider threads → 1 canonical
conversation).

### 4.6 Identity resolution today

`voice-contact-resolver.service.ts` (19-VC.6): normalize with `libphonenumber-js`
(`phone-number.ts`) → `phoneMatchKeys(normalized)` → search entity types **in order**
`["Contact","Lead","Account"]` (`RESOLUTION_ENTITIES`, `:55`) → per entity, entity-level ACL first
(`:110`), then record-level ACL (`:114`); unreadable matches are counted but **not named**
(`hiddenMatches`, `:116`).

The match itself is a **`regexp_replace` digit-stripping scan over `entity_records`**
(`:148-152`) — because *"a normalized phone index does not exist yet"* (`:31`). It is bounded
(`MAX_CANDIDATES = 10`, `MAX_ROWS = 50`) but is a scan per inbound message. Plan §3.3's "keep
identity resolution queries bounded and indexed" is only partly met.

### 4.7 Consent, suppression and policy already exist (and are correctly split)

- `voice-consent.service.ts` (303 lines) — `CONSENT_STATUSES = granted|denied|revoked|unknown`
  (`:31`), `CONSENT_BASES` (`:34`), `CONSENT_SOURCES` (`:44`), `SUPPRESSION_REASONS` (`:56-64`,
  including `stop_keyword` and `administrative_stop`); append-only `voice_consent_events` +
  `voice_suppressions` with at most one active suppression per `(channel, address)`
  (`migration 051:292-294`).
- `voice-policy.service.ts` (260 lines) — channel policy, quiet hours (default `21:00`–`08:00`,
  `voice-communications-settings.service.ts:80-84`), the WhatsApp 24 h customer-service window
  (`DEFAULT_WHATSAPP_WINDOW_HOURS = 24`, `domain:676`), and ordered refusal codes
  (`POLICY_REFUSAL_CODES`, `domain:623`).
- **The split is correct and must not be disturbed**: MarketingAutomation owns **email**
  (`MarketingConsent.channel = ['Email']`; identity = `emailHash` digest), VoiceCommunications owns
  **voice/SMS/MMS/WhatsApp** by normalized address. Two different identity models and vocabularies
  — no overlap, but **two places to look**, which plan §8.4 must route explicitly per channel.
- Governing invariants (`marketing-consent.service.ts:38-45`): *"missing evidence is never consent"*
  and *"an address change does not carry consent over"*.

### 4.8 The barrel gap — the single highest-value extension

`apps/api/src/voice-communications/index.ts` exports (`:78-90`): `VoiceCallService`,
`VOICE_COMMUNICATIONS_MODULE`, `VOICE_FEATURES`, `VoiceCommunicationsSettingsService`,
`VoiceConsentService`, `VoiceContactResolverService`, `VoiceEventProcessorService`,
`VoicePolicyService`, `FakeVoiceProvider`, `signFakeWebhook`, `VoiceProviderRegistry`,
`VoiceProviderAccountsService`, `AsteriskProviderAdapter`, `TwilioProviderAdapter`,
`VoiceWebhookIngressService`.

**Not exported**: `VoiceInboxService`, `VoiceMessagingService`, and the `VoiceProviderAdapter`
**interface** (they are DI providers inside the module, but not importable by another module).

Consequence: Omnichannel cannot consume the existing inbox/messaging services or implement a
channel adapter without a deep import into another module's internals. Exporting them is a
zero-behaviour-change, three-line change in the owning module — **and it is the precondition for
every reuse decision below.**

---

## 5. Adjacent domain modules

### 5.1 ServiceDesk — owns Case lifecycle, queues and routing

`apps/api/src/service-desk/` (23 files). **No dedicated tables**: migrations `033`/`034`/`036`
create only indexes; the 12 ServiceDesk entities live in `entity_records`:
`Case` (`seed-metadata.ts:3550`), `CaseQueue` (`:3674`), `QueueMember` (`:3721`),
`RoutingRule` (`:3750`), `CaseTransition` (`:3801`), `CaseAssignment` (`:3838`),
`BusinessCalendar` (`:3880`), `SLAPolicy` (`:3903`), `CaseSLAClock` (`:3932`),
`KnowledgeCategory` (`:3969`), `KnowledgeArticle` (`:3990`), `CsatSurvey` (`:4020`).

- **Case lifecycle** — status enum `New | Open | Pending Customer | Pending Internal | Escalated |
  Resolved | Closed | Cancelled` (`service-desk-domain.ts:11-20`); transition graph
  `CASE_TRANSITIONS` (`:142-153`); commands `start|setPendingCustomer|setPendingInternal|escalate|
  deEscalate|resolve|close|reopen|cancel` (`:155-192`). A transition writes the record, a
  `CaseTransition` history row and the domain event **in one transaction**
  (`case-lifecycle.service.ts:238-263`). Ownership is ServiceDesk-exclusive: the generic record API
  cannot set `status` for a portal principal, and `resolvedAt`/`closedAt`/`reopenedAt`/`slaState`
  are server-owned (`service-desk-internal.ts:54-73`).
- **Queues and routing (F1)** — `CaseAssignmentService.assign/route/workload/queues`
  (`case-assignment.service.ts:196,247,270,288`). `CaseQueue` carries `strategy`
  (`manual|roundRobin|leastBusy`, `domain:290`), `fallbackBehavior` (`unassigned|fallbackOwner`,
  `:129`), `defaultTeamId`, `sortOrder`, and the server-owned round-robin cursor
  `lastAssignedUserId`/`lastAssignedAt` advanced under `SELECT … FOR UPDATE`
  (`case-assignment.service.ts:49-51`). `QueueMember` carries `priority` and a unique
  `(queueId, userId)` index. `RoutingRule.conditions` is a JSON array of
  `{field, operator, value}` validated at save (`service-desk-write-guard.service.ts:140-160`)
  with an operator allowlist of **`equals`/`notEquals`/`in`** only (`domain:306`) — so
  language/tier/skill/capacity conditions **cannot be expressed** today. `CaseAssignment` is the
  audit row (with a unique `idempotencyKey` index).
  **Two limitations:** `BusinessCalendar` is consumed **only** by `sla.service.ts` — routing does
  **not** consult business hours; and there is **no skills entity** — teams are the only skill unit.
- **Case conversation** — `case-conversation.service.ts` adds **no second store**: "a public reply
  and an internal note are two visibilities of the same generic Stream item" (`:24-28`).
  `stream_items.visibility` (`public|internal|system`) was added by `migration 035:17`, and
  `attachments.visibility` by `:23`; `stream-visibility.ts:19,56` is the single decision shared by
  the Stream filter and the Attachment download gate. Internal notes do **not** move response
  clocks or satisfy first-response SLA (`:188-199`).
- **Email-to-Case (F2)** — `email-to-case.service.ts` (`EmailToCaseService.processEmail`, `:47`):
  requires `features.emailToCase`, an `Email` record with `status === 'Inbound'`, honours the
  `emailToCaseStatus` marker (`:60-65`), resolves a thread key
  `threadId ?? inReplyTo ?? messageId ?? emailId` (`:77`) and **appends to the existing Case's
  Stream** when a thread match exists (`:112-126`) rather than creating a second Case, else creates
  a Case with `source: "Email"` (`:84-92`).
  **It is manually triggered only** — two routes (`service-desk.controller.ts:213,220`), **no
  scheduled job, no worker handler, no event hook**. `processInbound()` (`:129`) polls then sweeps
  every `Inbound` Email record.
  ⚠️ The marker fields `caseId`, `streamItemId`, `emailToCaseStatus` are **not declared metadata** —
  they are raw attrs, unindexed, unvalidated, invisible to the SPA. Any Omnichannel handler must
  read them the way `email-to-case.service.ts:57-59` does.
- **Website intake** — `web-to-case.service.ts` (`WebToCaseService.submit`, `:43`): `@Public()`,
  an allowlist of customer-facing fields only, a **honeypot**, length caps, a **per-IP in-memory
  rate limit**, idempotency by client key or normalized content hash, and server-set
  `source`/`status`/`priority`. **This is the closest existing thing to the plan's website chat,
  and its abuse controls are the reusable part.**
- **The hand-off contract the plan assumes does not exist.** No `externalId`/`sourceRef`/
  `externalKey` on `Case` (verified: absent from `seed-metadata.ts` and the whole codebase); no
  `Case.conversations` relation (Case declares only `emails`/`calls`/`meetings`/`tasks`,
  `seed-metadata.ts:3605-3608`); no create-or-link command. `CASE_SOURCES` is
  `["Web","Email","Portal","API","Web Form","Workflow","Phone"]` (`domain:36`) — a `"WhatsApp"` or
  `"Chat"` source would need adding.
- **An existing ownership bypass (relevant to any routing Omnichannel does).** `assignedUserId` is
  **not** in `SERVER_OWNED_CASE_FIELDS` (`service-desk-internal.ts:54-73`); it is stripped only for
  **portal** principals (`service-desk-write-guard.service.ts:96`). A regular user with `Case` edit
  rights can set the owner via `PATCH /api/v1/Case/:id`, bypassing `CaseAssignment` and leaving no
  history row — contradicting `case-assignment.service.ts:37-38`. No test covers it.
- **The repo's canonical cross-module hand-off pattern** —
  `apps/api/src/advanced-integrations/contracts/marketing-contracts.ts` (a machine-readable
  "MarketingAutomation owns consent and suppression" declaration) plus
  `MarketingIntegrationService.handleCrossModuleEvent()` (`marketing-integration.service.ts:75-100`)
  with an explicit event whitelist and a depth cap of 3. **This is the template Omnichannel should
  follow**, and `advanced-integrations/contracts/voice-contracts.ts:46-71` is its Voice-side
  counterpart.

### 5.2 Email — the channel seam exists; the provider does not

- `packages/mail/src/inbound/index.ts` defines `InboundMailMessage` (with `providerMessageId`,
  **`threadId`**, `inReplyTo`, headers) and the port `InboundMailProvider` (`:37`), plus
  `inboundToEmailRecord` (`:53`) which normalizes a message into `Email` record fields with
  `status: 'Inbound'`, `direction: 'Inbound'`.
- The API binds `NullInboundProvider` (`apps/api/src/email/index.ts:66-67`), so
  `EmailService.pollInbound()` (`email.service.ts:212`) is a **safe no-op**; the route is
  `POST /api/v1/Email/action/pollInbound` (`email.controller.ts:47`).
- `Email` is a **metadata entity**, so CRUD/ACL/audit/stream/domain events come free from the
  kernel. Its declared fields include `threadId` (`seed-metadata.ts:549`) but **not** `caseId`,
  `streamItemId` or `emailToCaseStatus`.
- **Double-processing risk is real but currently latent.** Nothing auto-polls today, so
  ServiceDesk's manual `processInbound` and any future Omnichannel ingestion would both act on the
  same `entity_records` rows. The existing guard is the `emailToCaseStatus` marker on the **Email**
  record — Omnichannel must read and honour it and must not write a second, competing marker.
  There is also a **semantic** duplication risk: two timelines (Case Stream + Omnichannel
  conversation) for one customer message.

### 5.3 Portal — authentication and scope to reuse; no widget, no anonymous principal

`apps/api/src/portal/` (8 files). Portal is **Phase 18**, not a NestJS module — controllers are
registered via `PORTAL_CONTROLLERS` (`app.module.ts:117`). `Portal`, `PortalRole`, portal nav and
dashlets are **dedicated tables** (`migration 016`), managed by `PortalAdminService` — not metadata
entities.

- **Authentication** — an ordinary user JWT with portal linkage on the principal: `users` gains
  `portal_id`, `contact_id`, `portal_role_ids` (`migration 016:94-96`); `auth.service.ts:451-462`
  attaches `portalId`/`contactId` for `user.type === 'portal'`, so the portal ACL policy never
  re-reads the user row and an internal role list cannot be grafted onto a portal session.
- **Roles** — a **separate role space**: `portal_roles` with `permissions` and
  `field_permissions` (`seed.ts:173-188`); `/api/v1/Role` cannot read or write them. The
  `Portal Customer` role already exposes `Case` with field-level read/edit and denies assignment,
  SLA and merge internals (`seed.ts:152-171`).
- **Scope enforcement — two layers** — portal-role permissions
  (`portal-policy.service.ts:202-211`) **and** a record-neighbourhood rule (`:212-220`):
  `recordVisible()` (`:230-244`) requires the record to be the contact/account, to carry a link
  attribute to it, or to be linked via the entity-link store in either direction.
  `Case.isHiddenFromPortal === true` → never visible (`:235`).
  **Good news for Omnichannel:** `recordVisible()` is entity-generic via `linkFieldsFor(entity)`, so
  a new entity carrying `contactId`/`accountId` link fields is covered **automatically**.
- **F5 — no anonymous principal.** Every portal route requires an authenticated
  `users.type='portal'` user with a `contact_id`. `PortalController` has **no public route**; the
  only `@Public()` intake in the repo is ServiceDesk's `webToCase`
  (`service-desk.controller.ts:326-328`). An anonymous website chat widget therefore has **no
  identity to scope against**, and Omnichannel must define its own visitor identity (and consent
  basis) without weakening `PortalPolicyService.recordVisible()`.
- **Existing customer-facing conversation UI** — `apps/web/src/components/PortalCaseConversation.tsx`
  posts through the **generic `POST /api/v1/Note`**, relying on the portal principal being forced
  to `public` visibility.

### 5.4 AdvancedIntegrations — a real connector framework, but **not** a channel adapter

`apps/api/src/advanced-integrations/` (72 files). No `@Module()` class — the convention is a barrel
spread into `AppModule` (`app.module.ts:145`, `:201`).

**A genuine provider-agnostic framework exists here** — more complete than Voice's:

| Concern | Name | Evidence |
| --- | --- | --- |
| Base adapter port | `ConnectorAdapter` | `connector-adapter.port.ts:248` |
| Adapter registration | `IntegrationRegistry` + `ConnectorRegistrar.registerAll()` | `integration-registry.service.ts`; `connector-registrar.service.ts:57` |
| Capability declaration | `ConnectorCapabilities` / `CONNECTOR_OPERATIONS` | `provider-capabilities.ts:79,87` |
| Capability↔adapter consistency | `assertConnectorContract()` | `connector-contract.ts:265` |
| Credential vault | `EncryptedCredentialVault` (token `CREDENTIAL_VAULT`), AES-256-GCM, **fails closed** if `ENCRYPTION_KEY` is unset | `credential-vault.ts:199-225` |
| OAuth | `integration_oauth_states` stores the **SHA-256 hash** of the state, never the state; PKCE `code_verifier`; single-use `consumed_at` | `migration 056:84-98` |
| HTTP client | `createProviderHttpClient()` — 20 s timeout, SSRF guards (`isLoopbackAddress`/`isPublicAddress`), header redaction | `provider-http-client.ts:95,105,303,313` |
| Resilience | `computeRetryDelay`/`decideRetry` (exponential, capped, **equal-jitter**, honours `Retry-After`), `ProviderRateLimiter` (token bucket), `ProviderCircuitBreaker` | `resilience.ts:63,79,125,182` |
| Normalized error | `ProviderError` + `PROVIDER_ERROR_CATEGORIES` | `provider-error.ts` |
| Secret hygiene | `assertConfigIsSafe()`, `redactSecrets`, `redactContainer` | `advanced-integrations-domain.ts:194-230` |
| Executor | `ConnectorExecutor` — the single engine→connector path (limiter → breaker → call → breaker outcome) | `connector-executor.service.ts:98-124` |
| HMAC kit | `connectors/kit/webhook-signatures.ts` — `timingSafeEquals`, `hmacSha256Hex/Base64`, `verifyTimestampedHmacSha256Hex`, `verifyStripeStyleSignature`, `verifyBase64HmacSha256`, `verifyMailchimpStyleSignature`, `parseVersionedSignature` | `connectors/kit/webhook-signatures.ts:43-223` |
| 15 shipped connectors | `fake`, `generic-rest`, `stripe`, `shopify`, `mailchimp`, `quickbooks-online`, `meta-lead-ads`, `google-workspace`, `microsoft-365`, `zoom`, `accounting`, `ecommerce`, `enrichment` | `connectors/` |

**⚠️ The decisive gap for Omnichannel: `ConnectorAdapter` cannot send.**
`CONNECTOR_OPERATIONS = ['read','create','update','delete','upsert','webhook']`
(`provider-capabilities.ts:87`) — there is **no `send` operation**. Using `upsertObject` to "send a
WhatsApp message" would be semantic abuse and would break the port's own documented promise that
`validateConnection` *"never creates, updates, charges, sends or deletes a provider object"*
(`connector-adapter.port.ts:270`). This is a **shipped module's public contract**, so extending it
is AdvancedIntegrations' owner's decision, not Omnichannel's to make unilaterally.

**Second decisive gap: VoiceCommunications publishes exactly one cross-module contract.**
`apps/api/src/advanced-integrations/contracts/voice-contracts.ts` declares only
`voiceCommunications.consent.suppress`. `VoiceMessagingService.send()` and `.ingestInbound()`
exist but are **not exposed as a contract** — so there is currently **no published
send-message or read-inbox contract for the channel transport Omnichannel is meant to consume**.
This is the single largest missing seam.

**Persisted model** — dedicated relational tables, no metadata entities (`migration 056`/`057`/`060`):
`integration_connections`, `integration_credential_secrets`, `integration_oauth_states`,
`integration_webhook_deliveries`, `integration_outbound_operations`,
`integration_object_mappings`, `integration_field_mappings`, `integration_external_links`,
`integration_sync_runs`, `integration_sync_operations`, `integration_sync_checkpoints`,
`integration_conflicts`, `integration_rate_limit_buckets`, `integration_circuit_states`,
`integration_dead_letters`, `integration_record_origins`.

This is fundamentally a **CRM-record synchronization engine** (object/field mapping, conflict
resolution, checkpoints), not a channel transport. `integration_webhook_deliveries` is *outbound*
delivery to a customer-configured endpoint, not an inbound provider inbox. Plan §2.2's prohibition
targets this module, not VoiceCommunications' adapter.

**Inbound webhook inbox precedents — four separate, module-scoped implementations, no shared
service:**

| Table | Module | Migration | Shape |
| --- | --- | --- | --- |
| `integration_webhook_deliveries` | AdvancedIntegrations | `057` | dedup `(connection_id, delivery_id)`; 5 states; **no payload hash, no content length, no attempt count** |
| `signature_webhook_inbox` | ESignature | `064` | **the best in the repo** — `dedup_key UNIQUE`, `payload_hash` (sha256 check), `content_length`, `signature_status ∈ (verified,invalid,not_required)`, 7-state machine, `attempt_count`, `purge_after` |
| `marketing_provider_webhook_inbox` | MarketingAutomation | `042` | dedup index |
| `voice_webhook_events` | VoiceCommunications | `051` | dedup `(account_key, dedup_key)`, `signature_valid`, `payload_redacted` |

Omnichannel would be the **fifth**. It should either reuse `voice_webhook_events` (if it shares the
voice transport) or add an `omnichannel_*` receipt table **copying esignature's column shape** — it
should not build a fifth generic framework, and it should not refactor the other four. Note the
established (bad) precedent: **esignature duplicated** the vault, the OAuth state table and the
inbox because `integration_credential_secrets.connection_id` FKs `integration_connections(id)`
(`esignature-credential-vault.ts:18-24`) — Omnichannel must not create a **third** credential
stack.

### 5.4.1 The module registration surface (for 19-OM.2)

Exactly thirteen files must be touched to register a kernel module. This is the checklist the
Omnichannel module will follow:

1. `apps/api/src/<module>/index.ts` — `export const X_CONTROLLERS` / `X_PROVIDERS`
2. `apps/api/src/app.module.ts` — import and spread, **before** the `:entity` wildcard
3. `apps/api/src/<module>/<module>-module.ts` — descriptor: `id`, `name`, `version`, `loadOrder`,
   `apiPrefix`, `frontendRoute`, `implementedPhases`, `tables`, `dependsOn`
4. `apps/api/src/admin-panel/navigation-defaults.ts` — a `NavigationSeed` entry
   (`{key, kind:'page', route, labelKey, icon, order, permission?, feature?}`)
5. `apps/api/src/admin-panel/navigation-features.ts` — feature-gate seam (usually no change)
6. `apps/api/src/<module>/<module>-permission.service.ts` — ACL gate over synthetic resources
7. `apps/api/src/<module>/<module>-navigation.service.ts` — visibility report
8. `i18n/en/<module>.json` **and** `i18n/vi/<module>.json` — module, nav and page labels
9. `apps/web/src/AppRoutes.tsx` — React route **before** the entity wildcard
10. `apps/web/src/pages/…` — the page component
11. `@ApiTags('…')` on each controller — OpenAPI tag
12. `database/migrations/NNN_….sql` — tables
13. `apps/api/src/bootstrap.ts` — **only if the module has a webhook prefix** (see G4/F3)

**There is no `manifest.json` for kernel modules** — `manifest.json` exists only for out-of-tree
extension packages (`modules/*`), which is a different mechanism.

**Permission key convention** — flat synthetic entity names, **no dotted namespacing** (the evaluator
is entity-name based): `AdvancedIntegrations`, `IntegrationConnection`, `SignatureRequest`,
`CRMChatConversation`, `AIAgentApproval`, `VoiceProviderAccount`, `CommunicationConversation`.
Actions are the fixed `AclAction` set (`create|read|edit|delete|stream|export|massUpdate`) with
values `yes|no|all|team|own`. `sysAdmin` holds a `'*'` wildcard, so **a new module works for admins
without touching the seed** — but it is **absent from every non-admin role** until an operator adds
it, and there is no migration or assertion that a module's keys exist.

### 5.5 AIAgents — the AI runtime to call, but with **no typed-task API**

`apps/api/src/ai-agents/` (26 files). Tables (`migration 045`/`046`/`048`/`050`):
`ai_provider_connections`, `ai_agents`, `ai_agent_versions`, `ai_agent_tool_grants`,
`ai_agent_runs`, `ai_agent_run_events`, `ai_agent_tool_calls`, `ai_agent_approvals`,
`ai_agent_provider_requests`, `ai_agent_budget_policies`, `ai_agent_pricing_snapshots`,
`ai_agent_eval_suites`/`_cases`/`_runs`.

Public contract for an external caller (`apps/api/src/ai-agents/ai-agent-runs.service.ts`):

- `create(agentId, RunCreateInput)` (`:374`) — `RunCreateInput` is
  `{ input?: { text?, record?: {entity,id} }, idempotencyKey?, trigger?, conversationId? }` (`:65-70`)
- `triggerRun({ agentId, trigger, runInput?, idempotencyKey?, causationId?, depth? })` (`:567`) —
  **`trigger: 'integration'` already exists** (`:569`) and is the intended door for an external
  module. Feature-gated (`:577`), recursion depth capped at 3 (`:586`), idempotency dedup
  (`:590-600`).
- `get` / `events` / `toolCalls` / `list` (`:187`/`:193`/`:218`/`:164`)
- `retry` / `cancel` / `resume` / `provideInput` (`:633`/`:680`/`:733`/`:715`)
- `settleFromApproval(...)` (`:921`), `requestExecution(runId)` (`:942`)
- `AIAgentApprovalService` — `approve()`/`reject()`/`expireDue()`/`invalidate()`
  (`ai-agent-approvals.service.ts:142,146,269,299`); approval statuses
  `pending|approved|rejected|changes_requested|expired|invalidated|executed` (`:27`)
- `AIToolRegistry` + `AIToolDefinition.requiresApproval` (`ai-agent-tools.ts:64`);
  `AIToolProposal` `{summary, targets[], detail}` (`:44`)
- `AIAgentsPermissionService`, `AIAgentsPolicyService`

Providers: `AIProviderRegistry` (`ai-provider.ts`), `ai-provider-fake.ts`,
`ai-provider-anthropic.ts`, `ai-provider-openai-compatible.ts`, `ai-provider-presets.ts`.

**⚠️ There is no typed-task submission API.** The closest thing in the repo is
`CRMChatAIAgentsClientService.submitTurn` (`crm-chat-ai-agents-client.service.ts:62`), which is
**chat-shaped** — its input is `CrmChatTurnSubmission` (`{prompt, agentId, contextRefs,
idempotencyKey, conversationId}`) and it hardcodes `input.text = input.prompt` (`:66`). Promoting
it to a general task API would drag chat turn identity and chat memory into Omnichannel. Plan §4.2's
"submit typed tasks" is therefore satisfied by **calling `create()`/`triggerRun()` directly and
defining Omnichannel's own request/response DTOs on top**, or by adding a domain-neutral
`AIAgentTaskService` to ai-agents (cleaner, but touches a shipped module).

**The approval model is the answer to plan §8.5's "human confirmation is the default" — but the
enforcement point is inside AIAgents, not in the caller.** The chain is: a tool declares an
`effectClass` (`ai-agents-module.ts:159`: `read|low_write|material_write|high_impact`) →
`approvalRequired(grant, definition)` (`ai-agent-runs.service.ts:2129-2139`) → the run pauses
(`pauseForApproval`, `:1540`) → a **human** approves via `AIAgentApprovalService.approve()`
(`ai-agent-approvals.service.ts:142`) → `settleFromApproval()` resumes. Default matrix:
`approval.requireFor = ['material_write', 'high_impact']` (`ai-agent-config.ts:208`, `:272`),
overridable per agent and per tool (`ai-agent-tools.ts:64`).

**⚠️ But no messaging tool exists.** The current tool registry holds CRM read tools and limited
field-update tools (`READABLE_ENTITIES` `ai-agent-tools.ts:83`, `WRITABLE_FIELDS` `:97`) — there is
**no channel-send tool**. So Omnichannel must either register a send tool with
`effectClass: 'material_write'` (a change in ai-agents) or implement its own approval gate. A
timed-out/interrupted tool call becomes `outcome_unknown` and is **never auto-retried**
(`ai-agent-runs.service.ts:57`, `:953`).

Voice already uses the same shape for call transcripts: `voice_transcripts.ai_review_status` starts
at `pending` and nothing external happens until an authorized user moves it to `approved`
(`migration 053:57-61`). Omnichannel's AI-suggestion flow should mirror that: a suggestion is a
**draft**, never a sent message.

### 5.6 CRMChat — internal only, and it must stay that way

`apps/api/src/crm-chat/crm-chat.controller.ts` — `@Controller('api/v1/CRMChat')` (`:113`). All routes
are under the authenticated staff API: `action/capabilities`, `action/health`,
`action/conversations`, `action/turns`, `action/help/search`, `action/query/execute`,
`action/settings`, `action/prompts`, `action/actions/:approvalId/confirm|reject`. There is **no
public/unauthenticated route and no portal-facing surface**. Its tables are `crm_chat_citations`,
`crm_chat_feedback`, `crm_chat_prompts` (`migration 062`) — internal assistant state. The
`workspace` flag defaults on but issues no model call by itself (`crm-chat-module.ts:90`).

It is also the repo's **second SSE precedent** (`crm-chat-streaming.service.ts:94`), i.e. the repo
already tolerates per-module SSE endpoints even though there is no shared gateway.

**Risk to name explicitly — the internal-only boundary is data-driven, not code-enforced.** There is
**no `userType !== 'portal'` check anywhere in `crm-chat/`**. The separation holds today only
because the portal role grants no `CRMChat*` resource (`seed.ts:190-199` — `portalCustomerRole`
grants only `Account, Contact, Opportunity, Task, Email, Case`). If an admin grants
`CRMChatConversation: {read: 'yes'}` to a portal role, the internal assistant becomes customer-facing
with no code obstacle. `CRMChatConversation` is a synthetic resource, so a role editor has no UI
warning about what it exposes, and `action/capabilities` (`crm-chat.controller.ts:139`) leaks the
assistant's capability model to whoever can reach it.

**Do not simply re-point a CRMChat route at a widget.** The plan's "do not expose internal CRMChat
as the external customer chat widget" is correct, and the code confirms why. Omnichannel must not
reuse CRMChat's conversation tables (`crm_chat_*`; conversation storage lives in
`ai_agent_conversations`, owner-scoped). **Omnichannel → AIAgents is the correct direction.**

CRMChat is also the repo's **second SSE precedent** (`crm-chat-streaming.service.ts:94`) — the repo
already tolerates per-module SSE endpoints even though there is no shared gateway.

### 5.7 MarketingAutomation — campaign and consent ownership

`apps/api/src/marketing-automation/` (43 files), 16 metadata entities: `Campaign` (`:4065`),
`TargetList` (`:4175`), `TargetListEntry` (`:4235`), `CampaignTransition` (`:4274`),
`MarketingConsent` (`:4311`), `MarketingConsentEvent` (`:4381`),
`MarketingSuppression` (`:4422`), `MarketingPublicToken` (`:4474`),
`MarketingAudienceSnapshot` (`:4512`), `MarketingTemplateRevision` (`:4560`),
`MarketingSend` (`:4604`), `MarketingSendTransition` (`:4685`), `MarketingJourney` (`:4724`),
`MarketingJourneyVersion` (`:4755`), `MarketingJourneyEnrollment` (`:4788`),
`MarketingJourneyStepExecution` (`:4831`). Dedicated tables: `marketing_events` (`042`),
`marketing_recipient_deliveries` (`041`), `marketing_audience_snapshot_entries` (`038`).

- **Consent identity is a digest, never the address** — `MarketingConsent.emailHash` (`:4322`),
  `channel` (`:4323`), `purpose` (`:4324`), unique `(emailHash, channel, purpose)` (`:4349`).
  `CONSENT_CHANNELS = ["Email"]` only (`marketing-automation-domain.ts:721`).
- **Suppression is never deleted** — only revoked with `revokedAt`/`revokedById`/`revokedReason`;
  only overridable reasons can be lifted (`marketing-suppression.service.ts:29-35`).
- **Public opt-in/unsubscribe** — `MarketingPublicToken` + public routes
  (`marketing-automation.controller.ts:626-656`).
- **Eligibility gate before send** — `MarketingEligibilityService.decide()`
  (`marketing-eligibility.service.ts:79`) consults **both** consent and suppression.
- **Campaign "touchpoint" mapping** — the plan's vocabulary has no literal counterpart; use
  `MarketingSend` + `marketing_recipient_deliveries` (+ `MarketingJourneyStepExecution` for
  journeys).
- **Cross-module event contract** — `MARKETING_CAMPAIGN_EVENTS` with `schemaVersion`
  (`marketing-automation-events.ts:20-35`).

**Consent ownership verdict: clean split, no overlap.** ServiceDesk and Portal contain **zero**
consent or suppression code. MarketingAutomation owns email; VoiceCommunications owns
voice/SMS/MMS/WhatsApp. **The unit of ownership is the channel, not the module** — Omnichannel must
resolve consent **per channel** through the owning module and must **not** create a third store.

---

## 6. Source-of-truth ownership

| Fact | Authoritative owner | What Omnichannel must do |
| --- | --- | --- |
| Voice call state | `voice_call_sessions` | Read only, via VoiceCommunications |
| SMS/MMS/WhatsApp message + delivery state | `voice_messages` | Read/projection only; never a second status column |
| Provider receipt / dedup | `voice_webhook_events`, `voice_communication_events` | Reuse; add only if a new transport is added |
| Conversation state + assignment | `voice_conversations` + `voice_conversation_events` | Extend only with the additive fields in §4.5 |
| Conversation message timeline | `voice_messages` | Read only |
| Customer identity for a phone address | `voice_conversation_participants` (`entity_type`/`entity_id` reference) | Extend for provider-identity semantics; do not copy CRM fields |
| Marketing consent / suppression (email) | `MarketingConsent` / `MarketingSuppression` | Consult via MarketingAutomation; never copy |
| Channel consent / suppression (voice/SMS/MMS/WhatsApp) | `voice_consent_events` / `voice_suppressions` | Consult via VoiceCommunications; never copy |
| Channel policy, quiet hours, customer-service window | `voice-policy.service.ts` | Consult; never re-implement |
| WhatsApp template approval | `voice_whatsapp_templates` | Read only; the provider owns approval |
| Case lifecycle, status, SLA | `Case` (ServiceDesk) | Link/handoff only; never mutate Case status from a conversation |
| Queue + routing rule + assignment strategy | `CaseQueue` / `QueueMember` / `RoutingRule` | **Reuse or extend in ServiceDesk — do not build a second routing engine** |
| Case conversation timeline | `stream_items` with `visibility` | Reuse the visibility model |
| Email message + inbound normalization | `Email` entity + `packages/mail` | Consume the same records; do not poll a second mailbox |
| Email → Case interpretation | `EmailToCaseService` + the `emailToCaseStatus` marker | Do not double-process; honour the marker |
| AI run/approval/trace | `ai_agent_runs`, `ai_agent_approvals`, `ai_agent_run_events` | Submit typed tasks; render run progress; require explicit send approval |
| Attachment bytes + download ACL | `attachments` + `AttachmentService` | Reference only |
| Platform audit | `audit_log` + `AuditHookService` (kernel hook) | Reuse; do not use the domain event table to bypass audit |
| Realtime fan-out | `crm_notifications` channel → per-user SSE | Reuse; **but there is no generic publish seam (F4)** |
| Background execution | `jobs` / `job_logs` + `apps/worker` | Reuse; register new job names |
| Cross-module contract declaration | `advanced-integrations/contracts/*-contracts.ts` | Add an `omnichannel-contracts.ts` in the same style |

---

## 7. What is missing, blocked, or out of scope

### 7.1 Missing (new work, and where it belongs)

| # | Gap | Belongs in | Why |
| --- | --- | --- | --- |
| G1 | Conversation has no `priority`, `category`, `language`, `tags`, `queueId`, `snoozedUntil`, `closedAt`, `version`, `lastOutboundAt` | VoiceCommunications (additive migration) | Plan §5.2; the inbox UI needs them |
| G2 | Participant has no provider identity id, verification state, link confidence, last-seen or provenance | VoiceCommunications | Plan §5.4; without it, cross-channel identity matching has no evidence model |
| G3 | Conversation ≡ thread (no `channelThreadId`); voice calls are not conversations | VoiceCommunications | Plan §5.3 assumes N provider threads → 1 canonical conversation |
| G4 | Raw-body capture does not cover the voice/Omnichannel webhook prefix | `apps/api/src/bootstrap.ts:153` | Byte-exact provider signatures cannot be verified without it (F3) |
| G5 | `unsupported` is missing from the 13-category communication error taxonomy (the other 12 cover plan §4.2, with policy-blocked split into four precise categories) | `voice-provider.ts` / `domain` | Plan §4.2; a missing capability must be an explicit refusal, not a silent success |
| G6 | No queue entity for conversations; `CaseQueue` is Case-shaped and its rule operators are limited to `equals`/`notEquals`/`in`; routing ignores business hours; no skills entity | **Decision required** — extend ServiceDesk's queue/rules, or let Omnichannel reuse them directly | Plan §5.7 (F1); a second routing engine is forbidden |
| G7 | Dedicated-table records are invisible to generic search and to reports | New work in the search/reports modules or an Omnichannel projection | Plan §3.x "searchable interaction history" and §10.1 analytics |
| G8 | No web-chat route, visitor session, or chat widget; **no anonymous Portal principal** | New — Portal (session/auth) + Omnichannel (transport) | Plan §3.6 / OM.9 (F5) |
| G9 | No inbound email provider installed | `packages/mail` — `NullInboundProvider` is the default binding | Plan §4.5; the email channel is a seam until a provider is configured |
| G10 | No "reconcile an unknown send" command and no status-polling job | VoiceCommunications | Plan §3.5 explicitly requires reconciliation before repeating a send |
| G11 | No inbound STOP/UNSUBSCRIBE keyword scanner | VoiceCommunications' ingress (it owns the suppression list) | Plan §3.1/§3.2 implies keyword-driven opt-out |
| G12 | `Case` has no `externalId`, no `conversations` relation, no create-or-link command | ServiceDesk | Plan §1.1 outcome #10 and OM.17 cannot be implemented otherwise |
| G13 | No generic realtime publish seam | `NotificationEventsService` (shared platform) | Plan §6.3's constraint vs. the platform's actual capability (F4) |
| G14 | No shared `NotificationService`; no notification-type registry | Shared platform | Six modules hand-roll the insert; channel-specific notification types will drift |
| G15 | No `Case.conversations`-style relation for a conversation, and no per-conversation SLA/priority vocabulary | ServiceDesk / VoiceCommunications | Plan §5.2 |
| G16 | **VoiceCommunications publishes only one cross-module contract** (`voiceCommunications.consent.suppress`) — no send-message, no read-inbox contract | VoiceCommunications + AdvancedIntegrations contracts registry | Plan §2.3 assumes a consumable transport contract; today there is none |
| G17 | **`ConnectorAdapter` has no `send` operation** (`CONNECTOR_OPERATIONS` = read/create/update/delete/upsert/webhook) | AdvancedIntegrations | A channel send is not an "upsert"; reusing `upsertObject` would break the port's documented promise |
| G18 | **No messaging tool exists in the AIAgents registry** | ai-agents | Plan §8.5's "explicit send approval" cannot be delegated to AIAgents until a send tool with `effectClass: 'material_write'` is registered |
| G19 | **No typed-task API in AIAgents**; the only facade is chat-shaped (`CRMChatAIAgentsClientService.submitTurn`) | ai-agents | Plan §4.2's "submit typed tasks" has no existing target |
| G20 | **CRMChat's internal-only boundary is data-driven, not code-enforced** (no `userType` check) | crm-chat (or shared platform) | A portal role granted `CRMChatConversation` would expose the internal assistant |
| G21 | **Non-admin roles have no Omnichannel permission keys** and there is no assertion that a module's keys exist | `database/seed.ts` | `sysAdmin`'s `'*'` wildcard hides this until a real user hits it |

### 7.2 Externally blocked

| Item | Status |
| --- | --- |
| Meta Messenger / Instagram | No adapter, no app review, no permissions. Must stay "not implemented" until a feasibility record exists (`docs/omnichannel/channel-feasibility.md`, plan §4.3) |
| Meta Cloud API WhatsApp | **Not present.** WhatsApp ships through **Twilio's** WhatsApp API; a Meta connector would be a separate adapter with separate credentials and app review |
| Telegram | No adapter. Plan §4.1(6) warns that bot capability ≠ access to personal conversations |
| Real inbound email | Seam only; an IMAP/Graph provider must be configured by an operator |
| MMS | Named everywhere, implemented by **no** adapter |
| Recordings / transcripts / `messaging.media` | Simulator-only for Twilio and Asterisk |

### 7.3 Explicitly out of scope for Omnichannel

Transport duplication (VoiceCommunications owns it) · Case/ticket lifecycle (ServiceDesk) ·
campaigns/audiences/journeys/mass send (MarketingAutomation) · portal identity (Portal) · AI runtime
and approvals (AIAgents) · internal assistant (CRMChat) · mass marketing sends · telephony engine ·
social publishing/scheduling/social listening · scraping or unofficial private APIs.

---

## 8. Required extensions — smallest change in the owning module

None of these may be implemented inside Omnichannel without a documented gap.

| # | Extension | Owning module | Size |
| --- | --- | --- | --- |
| **E1** | **Export `VoiceInboxService`, `VoiceMessagingService` and the `VoiceProviderAdapter` interface (plus the input/result types) from the barrel** | `apps/api/src/voice-communications/index.ts` | ~3 lines, no behaviour change. **Precondition for every reuse decision.** |
| E2 | Add the webhook prefix to the raw-body `preParsing` hook | `apps/api/src/bootstrap.ts:153` | 1 line + a prefix constant |
| E3 | Add the `unsupported` category to the communication error taxonomy | `voice-provider.ts` / `domain` | small, additive |
| E4 | Add the plan §5.2 conversation fields + a `version` column | VoiceCommunications migration | additive migration |
| E5 | Add provider-identity columns + a connection/channel/identity unique index | VoiceCommunications migration | additive migration |
| E6 | Make the conversation↔thread relationship explicit (or document the 1:1 rule) | VoiceCommunications | design decision in OM.1 |
| E7 | Add `reconcileMessage` / `refreshMessageStatus` to `VoiceMessagingService` | VoiceCommunications | small |
| E8 | Decide whether `CaseQueue`/`RoutingRule` serve conversations; if not, extend them additively (operators, business hours, skills) | ServiceDesk | contract change in ServiceDesk, not a new engine |
| E9 | Add `Case.externalId` + a `Case.conversations` relation + a `createCaseForConversation`/`linkConversation` command; add `assignedUserId` to `SERVER_OWNED_CASE_FIELDS` | ServiceDesk | one additive migration + one command |
| E10 | Publish a provider-neutral conversation facade over the existing services | VoiceCommunications | a service, not a schema change |
| E11 | Add a generic per-user publish seam to `NotificationEventsService` | shared platform | small; decides F4 |
| E12 | Extract a shared `NotificationService` with a type registry | shared platform | small; optional if Omnichannel's types are unique |
| E13 | Configure an inbound mail provider for the email channel | `packages/mail` | operator configuration |
| E14 | **Publish the voice transport as cross-module contracts** (`voiceCommunications.message.send`, `voiceCommunications.inbox.read`) in `advanced-integrations/contracts/voice-contracts.ts` | VoiceCommunications (+ the contracts registry) | Closes G16 — the precondition for plan §2.3 |
| E15 | Add a `send` operation to `ConnectorAdapter` + `CONNECTOR_OPERATIONS` + `adapterSupports()` — **only if** Omnichannel routes channel transport through AdvancedIntegrations rather than through Voice's own adapter | AdvancedIntegrations | 3 small edits to shipped shared files; needs the owner's sign-off |
| E16 | Register a channel-send tool with `effectClass: 'material_write'` in the AIAgents tool registry | ai-agents | Closes G18 — makes "explicit send approval" enforceable by the existing approval matrix |
| E17 | Reuse `connectors/kit/webhook-signatures.ts` (HMAC kit) and `provider-http-client.ts` + `resilience.ts` for any new channel adapter | AdvancedIntegrations | **Zero extension** — import directly |
| E18 | Add the Omnichannel permission keys to the non-admin roles in `database/seed.ts` | `database/seed.ts` | `sysAdmin`'s `'*'` covers admins only |

**E1 and E10 are the load-bearing ones.** If VoiceCommunications exports a provider-neutral facade
(`listConversations`, `getConversation`, `timeline`, `send`, `ingestInbound`, `applyStatus`,
`assign`, `handoffToCase`) whose types do not mention SMS/MMS/WhatsApp, then Omnichannel can consume
it as plan §2.3 requires — without importing provider SDK types and without a second authoritative
record. Until then, Omnichannel would have to deep-import another module's internals, which is
exactly the coupling §2.4 warns against.

---

## 9. Risks

| # | Risk | Severity | Mitigation |
| --- | --- | --- | --- |
| R1 | Building a parallel `OmnichannelConversation` + `OmnichannelMessage` creates a second inbox and a second delivery state | **High** | Adopt E1 + E10; Omni owns the *workspace and multi-channel policy*, Voice owns the *record* |
| R2 | Building a second queue/routing engine beside `CaseQueue`/`RoutingRule` | **High** | E8 decided in OM.1 before any Omni schema work |
| R3 | Double-processing inbound email (Omnichannel + Email-to-Case) | **High** | One ingestion path; honour `emailToCaseStatus`; never write a second marker |
| R4 | Duplicate consent sources drifting (marketing vs channel) | **High** | Never copy consent; consult the owner per channel (plan §8.4); add no third store |
| R5 | The fake adapter gives false confidence for byte-signature providers | Medium | E2 before any non-simulator channel; feasibility gate in OM.1 |
| R6 | Conversation growth is unbounded in dedicated tables, outside generic retention/archival | Medium | Define retention before OM.3; `voice_media.retention_at` is the precedent |
| R7 | Dedicated-table records bypass generic search, reports, field policies and import/export | Medium | G7; read-only projection endpoints instead of a second generic entity |
| R8 | Internal notes leaking to a customer-facing surface (portal or widget) | **High** | The existing `is_internal_note` CHECK + `stream_items.visibility` are the pattern; a widget must never read internal notes |
| R9 | Cross-channel identity auto-linking merges the wrong customer | **High** | E5's confidence/provenance fields; §1.2 "visible uncertainty" — never auto-merge without evidence |
| R10 | Reusing `CaseQueue` couples the inbox to the Case lifecycle | Medium | E8: queue reuse is a *reference*, not a Case dependency |
| R11 | The plan's realtime requirement cannot be met by the platform as built | Medium | E11/F4: decide in OM.1 between a generic publish seam and a module-scoped SSE endpoint |
| R12 | `assignedUserId` can be set outside `CaseAssignment`, so any routing that trusts `Case.assignedUserId` is unsound | Medium | E9; also note that conversation assignment already goes through `VoiceInboxService.assign` |
| R13 | No CI pipeline exists, so "checks pass" is a local claim | Low | State the exact commands run; do not imply CI coverage |
| R14 | `apps/api/dist/database/ensure-db.js` is a stale compiled artifact containing a `CREATE DATABASE` path (the TS source no longer exists) | Low | Harmless today (nothing imports it, `dist/` is build output). Flagged, not fixed — this phase changed no files. Consider removing stale `dist/` from the tree |
| R15 | Omnichannel becomes the **fifth** independent inbound-webhook inbox (`integration_webhook_deliveries`, `signature_webhook_inbox`, `marketing_provider_webhook_inbox`, `voice_webhook_events`, + `omnichannel_*`) | Medium | Copy esignature's column shape; keep it module-scoped; do not refactor the other four |
| R16 | A **third credential/OAuth stack** if Omnichannel creates its own connection + secret + OAuth tables (esignature already duplicated AdvancedIntegrations' because of an FK constraint) | Medium | Reuse `EncryptedCredentialVault` + `integration_oauth_states`; do not create `omnichannel_credential_secrets` |
| R17 | CRMChat's internal assistant becomes customer-facing if a portal role is granted `CRMChatConversation` | Medium | Do not expose CRMChat; keep Omnichannel → AIAgents; consider a `userType` guard |
| R18 | A channel send implemented via `ConnectorAdapter.upsertObject` would be a semantic abuse and would break the port's documented "never sends" promise | Medium | Use Voice's own `sendMessage` (E14/E15), never `upsertObject` |
| R19 | Omnichannel permission keys exist only for admins (`sysAdmin`'s `'*'`); a real user sees an empty module with no diagnostic | Low | E18 + `*-navigation.service.ts` visibility report |

---

## 10. Test and database safety posture (observed, not assumed)

- `vitest.config.ts`: `include: ['apps/api/test/**/*.test.ts', 'packages/*/src/**/*.test.ts']`,
  `pool: 'forks'`, `singleFork: true`, 120 s timeouts, **`globalSetup: []`** — no global setup hook,
  so no test framework can create or reset a database behind the scenes.
- `apps/api/test/helper.ts:23` `bootTestApp()` boots the real `AppModule` against **the configured
  project database** (`DATABASE_URL`), runs `migrateDb` + `seed` idempotently, and logs in as admin.
  Its own comment states the policy: *"No database is created, reset or truncated; test records
  carry unique run markers."*
- `apps/api/test/module-test-app.ts:58` `bootModuleTestApp()` builds a throwaway Nest root module
  for modules not yet wired into `AppModule`, against the same `.env` database — again without
  creating a database.
- `apps/api/test/support/boot-api.ts` → `migrateDb(config.databaseUrl)` — applies pending `.sql`
  migrations to the configured primary DB; it does **not** create a database.
- Repo-wide scan for `CREATE DATABASE | DROP DATABASE | DROP SCHEMA | TRUNCATE | migrate reset |
  db push --force-reset` finds **no live source hit**. The only matches are negative assertions in
  `apps/api/test/lead-score-release.test.ts:397,436` and the stale compiled artifact noted in R14.
- Existing suites follow the `AGENT_TEST_<runId>` marker convention and delete **only their own rows
  by exact id**, restoring mutated settings rows in `afterAll`
  (`.trail/learnings/2026-10-17-service-desk-*.md`).
- `database/migrate.ts` applies each `.sql` file in its own transaction and records it in
  `schema_migrations`; there is no `down`/reset path in the repo.
- `docker-compose.yml` provisions **postgres + redis only**. No test-database service, no
  `DATABASE_URL` pointing at a `*_test` schema, and no `docker compose down -v` in any script.
- The reusable fake-adapter pattern: `FakeVoiceProvider` (`voice-provider.ts:317`),
  `signFakeWebhook` (`:605`), `VoiceProviderRegistry.simulator()` (`:678`),
  `registry.register(adapter)` (`:660`), plus a mandatory `sandboxRecipients` allowlist and
  `simulateOutage` flag. Twilio/Asterisk tests inject `fetchImpl`
  (`voice-provider-http.ts:24`), so **no test sends a real message or places a real call**.

**Omnichannel inherits this policy unchanged:** use `bootTestApp()` / `bootModuleTestApp()` against
the configured primary database, mark every record `AGENT_TEST_<runId>`, delete by exact id, never
truncate, never create a second database, and keep the fake adapter as the only outbound path in
automated tests.

---

## 11. OM.0 acceptance evidence

| Acceptance criterion (plan §14, 19-OM.0) | Evidence |
| --- | --- |
| The audit identifies current authoritative records/services for every channel that already exists | §6 — voice call/messages/conversations (`voice_*`), email (`Email` + `packages/mail`), Case (`Case`), campaigns (`MarketingAutomation`), AI runs (`ai_agent_*`), website intake (`WebToCaseService`), portal (`portal_roles`) |
| The agent explains what can be reused directly and what small extension is required | §4 (reuse: adapter contract, inbox, messaging, consent, policy, templates) and §8 (E1–E18, each owned by its current module) |
| No duplicate transport, inbox, Case, campaign engine, Portal auth or AI runtime is proposed without a documented gap | §5.4 (no generic webhook inbox → reuse or add a module-scoped one, explicitly not a 4th framework), §5.1 (`CaseQueue`/`RoutingRule` already exist → E8), §5.3 (Portal has no widget and no anonymous principal → G8/F5), §5.5/§5.6 (AIAgents is the runtime; CRMChat stays internal) |
| A capability matrix is built (existing/reusable, partially implemented, missing, externally blocked, out of scope) | `docs/omnichannel/capability-matrix.md` |
| Source-of-truth ownership identified for messages, call/SMS/WhatsApp status, consent, Case lifecycle, campaign events and AI run records | §6 |
| Naming and route conventions confirmed, `Omnichannel`/`omnichannel` without `Ua` | §2.1 |
| Missing prerequisites and risks recorded | §7.1, §9 |
| No broad refactor and no destructive migration | This phase changed **only** `docs/omnichannel/repository-audit.md` and `docs/omnichannel/capability-matrix.md` |
| Stop at the end of this phase and report findings before starting 19-OM.1 | Phase 19-OM.1 has **not** been started |

---

## 12. Inputs for Phase 19-OM.1

**Already settled by the decisions recorded in plan §0.2 — OM.1 refines, it does not re-open:**

- **The conversation record** — reuse `voice_conversations` (D1). The remaining OM.1 design task is
  the **conversation↔thread cardinality** (E6): one provider thread per conversation today, and
  voice calls are not conversations at all.
- **The queue and routing owner** — extend ServiceDesk's `CaseQueue`/`RoutingRule` (D2). The
  remaining OM.1 work is to specify the **extension contract**: conversations as routed objects,
  a wider operator allowlist, business-hours routing, and skills.
- **The realtime seam** — extend `NotificationEventsService` and add a module-scoped SSE endpoint
  (D3). The remaining OM.1 work is the **publish payload contract** and the reconnect/cursor
  semantics.

**Genuinely still OM.1's to decide:**

1. **The first channel set and the first end-to-end path.** The audit narrows this to two credible
   paths: (a) website/Portal chat into the existing conversation model, reusing
   `WebToCaseService`'s abuse controls — which forces the **anonymous-visitor identity** question
   (F5, G8); and (b) email-thread ingestion through the existing `packages/mail` seam — which
   forces the **double-processing** question against `EmailToCaseService` (F2, G9).
2. **The feasibility gate** (`docs/omnichannel/channel-feasibility.md`) applies to every channel,
   including website/Portal chat, because that channel's public surface, spam controls and
   unauthenticated-upload policy are provider-independent requirements of its own. Note that
   **WhatsApp already passes through Twilio**, so a Twilio feasibility record covers SMS and
   WhatsApp; **MMS has no adapter** and **Meta Cloud API is not present**.
3. **The ServiceDesk hand-off contract** OM.17 depends on (E9): `Case.externalId`, a
   `Case.conversations` relation, and a create-or-link command that writes the audit row — today
   `handoffToCase` uses the generic entity API and produces no `CaseTransition`.
4. **Whether channel transport routes through `AdvancedIntegrations`' `ConnectorAdapter`** (which
   cannot send — E15) or through Voice's own adapter. The HMAC kit, HTTP client and resilience
   helpers are reusable either way (E17).
5. **The AI posture** (§8.5): AI suggestions are drafts that reuse `voice_transcripts.
   ai_review_status`'s pending→approved pattern, and `AIAgentRunService`'s approval flow is the
   enforcement point — once a `material_write` channel-send tool is registered (E16). No autonomous
   reply policy in the first release.
6. **The plan's vocabulary mapping**: "MarketingAutomation campaign touchpoint" →
   `MarketingSend` + `marketing_recipient_deliveries`; "ServiceDesk hand-off" → the (currently
   absent) `Case.externalId` + link contract; "channel thread" →
   `voice_conversations.external_thread_id`; "campaign events" → `marketingAutomation.campaign.*`
   with `schemaVersion`.

**Two prerequisites that are edits, not decisions, and should be scheduled early because several
sub-phases depend on them:** `bootstrap.ts` must learn the Omnichannel webhook prefix (E2), and the
Voice barrel must export `VoiceInboxService`, `VoiceMessagingService` and the `VoiceProviderAdapter`
interface (E1).
