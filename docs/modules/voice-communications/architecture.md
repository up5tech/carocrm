# Voice & Communications — architecture

> Phase 19-VC.0–19-VC.6. Canonical module `VoiceCommunications`, API `/api/v1/VoiceCommunications`,
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
| Event processor | `voice-event-processor.service.ts` | Normalize a receipt once, persist `voice_communication_events`, emit `voiceCommunications.*` through the outbox. |
| Contact resolver | `voice-contact-resolver.service.ts` | Normalize, match `phoneNumber` across Contact/Lead/Account, ACL-filter, report ambiguity. |
| Consent + suppression | `voice-consent.service.ts` | Append-only consent evidence, suppression tombstones, last inbound time. |
| Channel policy | `voice-policy.service.ts` | The single send-eligibility decision, with explainable refusals. |
| Health / navigation | `*-module-health.service.ts`, `*-navigation.service.ts` | Facts read from the running platform; ACL-scoped menu visibility. |
| HTTP | `voice-communications.controller.ts`, `voice-webhook.controller.ts` | Static admin prefix and public provider prefix. |
| Persistence | `database/migrations/051_phase19_voice_communications.sql` | Eleven tables, additive only. |

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

## 4. Persistence choices

`voice_provider_accounts`, `voice_endpoints`, `voice_webhook_events`,
`voice_communication_events`, `voice_call_sessions`, `voice_conversations`,
`voice_conversation_participants`, `voice_messages`, `voice_media`, `voice_consent_events`,
`voice_suppressions`, `voice_whatsapp_templates`.

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
