# Voice & Communications — architecture

> Phase 19-VC.0–19-VC.17. Canonical module `VoiceCommunications`, API `/api/v1/VoiceCommunications`,
> webhook prefix `/api/v1/integrations/voice-communications`.
> Audit and capability matrix: `docs/implementation/voice-communications-audit.md`.
> Behavior reference and limitations: `docs/compatibility/voice-communications.md`.

## 1. Where the module lives

`apps/api/src/voice-communications/` — a kernel domain directory, like Sales, Service Desk,
Customer Success, Marketing Automation and AI Agents. It is **not** an installable extension and
does not add a second framework. `apps/api/src/app.module.ts` spreads
`VOICE_COMMUNICATIONS_CONTROLLERS` before `ENTITY_CONTROLLERS` and
`VOICE_COMMUNICATIONS_PROVIDERS` with the other domain providers.

Nothing else in the platform imports a provider adapter, and the module imports no other domain:
optional integrations are detected by a metadata marker, never by an import.

## 2. Components

| Component | File | Responsibility |
| --- | --- | --- |
| Domain vocabulary | `voice-communications-domain.ts` | Channels, capabilities, state machines, event names, error categories, idempotency, policy refusal codes. Pure, no I/O. |
| Phone normalization | `phone-number.ts` | `libphonenumber-js`-backed E.164 normalization (default) plus a dependency-free fallback, behind the `PhoneNormalizer` seam. |
| Settings | `voice-communications-settings.service.ts` | One validated row `voiceCommunications` in `app_settings`. |
| Provider contract + registry | `voice-provider.ts` | `VoiceProviderAdapter`, capability declaration, simulator, disabled adapter, fail-closed resolution. |
| Provider accounts | `voice-provider-accounts.service.ts` | Accounts, endpoints, encrypted credentials (write-only), enable/disable, health checks. |
| Webhook ingress | `voice-webhook-ingress.service.ts` | Body ceiling, replay window, adapter signature validation, durable receipt, dedup, enqueue. |
| Call sessions | `voice-call.service.ts` | Click-to-call, provider correlation, state reconciliation, the single Call Activity, notes, record links, caller context. |
| Incoming-call notifications | `voice-call-notification.service.ts` | One notification row per call and recipient: the assigned user or the endpoint team's members, number only. |
| Messaging | `voice-messaging.service.ts` | Conversations, participants, durable send path, inbound materialization, monotonic delivery status, internal notes, media references. |
| WhatsApp templates | `voice-whatsapp-template.service.ts` | Locally recorded approval status, language, `{{n}}` variable validation. |
| Unified inbox | `voice-inbox.service.ts` | ACL-scoped conversation list with indexed filters, merged message/history timeline, read state, status changes, assignment and case handoff — all with append-only history. |
| Service snippets | `voice-message-template.service.ts` | Local one-to-one snippets with a strict placeholder grammar, render with caller-supplied values only, SMS segment arithmetic, composer validation. |
| Recordings & media | `voice-media.service.ts` | Recording references from callbacks, SSRF-checked fetch into private storage as a worker job, authorized playback, retention sweep. |
| Transcription & AI | `voice-transcription.service.ts` | Provider transcript retrieval, segment storage, opt-in AI summary/topics/actions/suggested reply through the AI gateway, draft-only review state. |
| CRM panels | `voice-panel.service.ts` | Record-ACL-aware panel data (conversations + calls), touchpoint counts for Customer Success, link a conversation to a record. |
| Event processor | `voice-event-processor.service.ts` | Normalize a receipt once, persist `voice_communication_events`, emit `voiceCommunications.*` through the outbox. |
| Contact resolver | `voice-contact-resolver.service.ts` | Normalize, match `phoneNumber` across Contact/Lead/Account, ACL-filter, report ambiguity. |
| Consent + suppression | `voice-consent.service.ts` | Append-only consent evidence, suppression tombstones, last inbound time. |
| Channel policy | `voice-policy.service.ts` | The single send-eligibility decision, with explainable refusals. |
| Health / navigation | `*-module-health.service.ts`, `*-navigation.service.ts` | Facts read from the running platform; ACL-scoped menu visibility. |
| HTTP | `voice-communications.controller.ts`, `voice-webhook.controller.ts` | Static admin prefix and public provider prefix. |
| SPA — inbox | `apps/web/src/pages/VoiceInboxPage.tsx` | Conversation list + timeline + composer + call log; click-to-call; snippet picker; assignment, status, handoff. |
| SPA — call detail | `apps/web/src/components/VoiceCallDetail.tsx` | Recordings (authorized playback) and transcript / AI draft with review state. |
| SPA — record panel | `apps/web/src/components/CommunicationsPanel.tsx` | Communications panel on Account/Contact/Lead/Opportunity/Case detail; lazy call expansion. |
| SPA — incoming call | `apps/web/src/components/IncomingCallBanner.tsx` | Polls `action/calls/incoming`; renders the number, the permitted caller matches and only the `controls` the server granted (Accept / Decline-Hang up), plus a quick note and record association; internal shell only (never the portal). |
| Persistence | `database/migrations/051…054_phase19_voice_communications*.sql` | Fifteen tables, additive only. |

## 3. Data flow

**Outbound (later sub-phases call the same policy):**
UI/service → `VoicePolicyService.evaluate` → provider adapter → `voice_messages`/`voice_call_sessions`
→ provider callback → ingress → processor → domain event.

**Inbound:**
provider → `POST /api/v1/integrations/voice-communications/{provider}/{account}/{kind}` →
body ceiling → replay window → adapter signature → `voice_webhook_events` receipt →
`JobsService.enqueue('voiceCommunications.processWebhookEvent')` → processor →
`voice_communication_events` (unique per receipt) → `voiceCommunications.message.received` etc.

The HTTP response is `202` with the receipt id and a duplicate flag. Nothing about the CRM is
disclosed to the provider.

## 3.1 Surface map (routes and navigation)

| Route | Component | Gate (server-side) |
| --- | --- | --- |
| `/voice-inbox` | `VoiceInboxPage` | `CommunicationConversation:read` (nav seed `voiceInbox`) |
| `/voice-communications` | `VoiceCommunicationsPage` (diagnostics) | `VoiceProviderAccount:read` |
| record detail panel | `CommunicationsPanel` | the record's own read level via the panel API |

The SPA never decides access: every list is the server's ACL-filtered answer, and a refused action is
rendered with the server's own reason (`ApiError.message`). Media playback is fetched as bytes from
the API, so no provider URL or token ever reaches the browser.

## 4. Persistence choices

`voice_provider_accounts`, `voice_endpoints`, `voice_webhook_events`,
`voice_communication_events`, `voice_call_sessions`, `voice_conversations`,
`voice_conversation_participants`, `voice_messages`, `voice_media`, `voice_consent_events`,
`voice_suppressions`, `voice_whatsapp_templates`, `voice_conversation_events`,
`voice_message_templates`, `voice_transcripts`.

The user-facing **Call** record stays the platform's `Call` Activity; `voice_call_sessions` holds
provider correlation and normalized state and links to it by `activity_id`. One session produces
exactly one Activity, created on the first accepted state and updated afterwards (19-VC.7). No table copies
Contact/Lead/Account fields: a participant or session stores an address and a record reference.

Idempotency is structural:

- `uq_voice_webhook_events_dedup (account_key, dedup_key)`
- `uq_voice_communication_events_receipt (webhook_event_id)`
- `uq_voice_call_sessions_provider_call (account_key, provider_call_id) WHERE provider_call_id IS NOT NULL`
- `uq_voice_messages_provider_message (account_key, provider_message_id) WHERE provider_message_id IS NOT NULL`
- `ck_voice_messages_internal_note` — an internal note cannot carry a provider message id.
- `uq_voice_suppressions_active (channel, address) WHERE revoked_at IS NULL`
- `uq_voice_message_templates_key (key)` — one snippet per key, local only
- `uq_voice_transcripts_call (call_session_id)` — one transcript per call
- `voice_conversation_events` is append-only: assignment and status history are rows, never an
  overwritten column (§9.1).

### 4.1 Omnichannel extensions (19-OM.3, migration 077) — reused, not rebuilt

Decision D1 keeps the canonical conversation here; the Omnichannel workspace consumes these records
through the Voice facade rather than owning a parallel store (the schema shows **no**
`omnichannel_conversation`/`message`/`queue` table). All changes are additive — no column was dropped,
renamed or re-typed and existing rows are preserved:

- `voice_conversations` gained the workspace columns `priority` (`low|normal|high|urgent`, default
  `normal`), `category`, `language`, `tags` (`jsonb` array), `current_queue_id`,
  `assignment_version`, `last_message_at`, `last_outbound_at`, `snoozed_until`, `closed_at` and
  `version`. `current_queue_id` references `entity_records` **ON DELETE SET NULL** — D2 keeps the queue
  a ServiceDesk `CaseQueue` reference, never a Case dependency, and dropping a queue must never take a
  conversation with it.
- **N provider threads → 1 conversation** (extension E6): the new `voice_conversation_threads` table
  (`conversation_id` CASCADE, `account_key`, `channel`, `external_thread_id`, `address`,
  `provider_identity`) with unique `uq_voice_conversation_threads_external (account_key, channel,
  external_thread_id)`; `voice_messages` gained `thread_id`. `voice_conversations.external_thread_id` is
  kept and still written (deprecated) so nothing that reads it breaks. Each pre-existing 1:1 conversation
  was backfilled exactly one thread and its messages linked; the backfill copies only facts already
  present and invents none (`closed_at`/`last_outbound_at` stay NULL on historical rows).
- `voice_conversations.channel` and `voice_messages.channel` CHECK widened to `('sms','mms','whatsapp','web_chat')`
  for the first-release web-chat channel; no adapter ships MMS, so it stays vocabulary-only.
- `voice_conversation_participants` gained the identity-evidence columns (extension E5):
  `provider_identity`, `account_key`, `channel`, `verification_state` (`unverified|verified|disputed`),
  `link_confidence` (`none|exact|manual|heuristic`), `link_reason`, `last_seen_at`, `source_provenance`,
  and partial-unique `uq_voice_participants_provider_identity (account_key, channel, provider_identity,
  conversation_id) WHERE provider_identity IS NOT NULL` — the schema half of "duplicate external identity
  refused under concurrent delivery". Historical address-matched customer links were labelled
  `verified/exact/migrated_address_match`; agent/system participants keep the honest default because their
  entity reference is a platform assignment, not an address resolution.

**Retention and access** (OM.3 acceptance): the new columns belong to the same retention classes as their
host row — the conversation metadata and `message-body`/`webhook-diagnostic` clocks in
`privacy-and-retention.md`; thread rows and provider-identity values carry no new message content and
follow their conversation's lifecycle via `ON DELETE CASCADE`. Provider identities are channel addresses of
the same class as the existing `address` column, so reading a participant (and thus its identity evidence)
still requires the conversation's record ACL — no new surface bypasses it. The writers land in OM.6/OM.7;
OM.3 is schema and constraints only.

## 5. Service authority

Webhook processing has no human principal, so it runs as the module's documented system identity
(`voice-communications-authority.ts`, `sysAdmin` capability, `system` actor) — the same mechanism
Marketing Automation uses. It does not bypass record ACL: the processor writes only the module's own
tables and the outbox. Call/message materialization in later phases must still pass the acting user's
ACL or the documented service scope.

## 6. What is deliberately absent in this scope

The **inbox UI**, ServiceDesk handoff, recordings, transcripts and AI enrichment are later
sub-phases. The call/message API surface exists (click-to-call, call list/detail/note/link/context,
message send, conversation list/detail) but the dedicated screens arrive in 19-VC.12/19-VC.17.
