# PLAN — Phase 19: Voice & Communications Module (`VoiceCommunications`)

> **Status:** Planned  
> **Parent roadmap:** `PLAN.md` — advanced CRM domains  
> **Target runtime:** NestJS / TypeScript backend with the existing React SPA  
> **Canonical module name:** `VoiceCommunications`  
> **Module key / frontend slug:** `voice-communications`  
> **NestJS module class:** `VoiceCommunicationsModule`  
> **Naming rule:** Do not add the `Ua` prefix. Do not name provider adapters as separate CRM modules such as `UaTwilio`, `UaVoipIntegration`, or `UaWhatsapp`.  
> **Persistence:** Existing PostgreSQL + Kysely (or the SQL abstraction already adopted by the repository)  
> **Background work:** Reuse the existing Redis/BullMQ or platform job service if present.  
> **Implementation rule:** Extend the capabilities completed in earlier phases. Do not reimplement generic CRM kernel services.

---

## 1. Purpose and Product Positioning

Implement a first-class **Voice & Communications** module that connects customer-facing conversations and telephony activity to CRM records. It should provide a consistent user experience for making and receiving calls, logging call activity, sending and receiving supported messages, reviewing a customer's communication history, and routing conversations to the right team.

The module should use provider-neutral domain contracts with provider adapters behind them. Initial provider work should prioritize a testable adapter and one production messaging/voice provider, then add PBX integrations incrementally. Provider credentials, endpoint identifiers, delivery receipts, recordings, and vendor-specific status values must not leak into the CRM domain model.

### 1.1 Business outcomes

Authorized users should be able to:

1. Click a phone number in supported CRM views to initiate an outbound call through a configured provider.
2. Receive an incoming-call notification with a best-effort match to Accounts, Contacts, Leads, or other permitted CRM records.
3. Open a caller context panel to inspect permitted contact details and related activities without exposing records the user cannot access.
4. Log inbound, outbound, missed, and completed calls against relevant CRM records.
5. Add call notes and create follow-up activities while reusing the existing Activities, Calendar, Tasks, Stream, and notification services.
6. Send and receive SMS/MMS where the configured provider and destination country support them.
7. Send and receive WhatsApp Business messages through an approved provider integration, subject to channel rules, approved templates, consent and provider capabilities.
8. Review multi-channel message threads in a unified communication inbox, including assignment, unread state, status, contact matching, and record links.
9. View message delivery lifecycle and actionable errors without exposing secrets or internal provider payloads to ordinary users.
10. Access permitted recordings and transcripts when the provider, configuration, consent/legal basis, and retention policy allow them.
11. Hand a conversation to ServiceDesk by linking it to an existing Case, or initiate Case creation through a documented ServiceDesk API when permitted.
12. Use approved AI capabilities from the existing `AIAgents` module for optional call summaries, topic extraction, suggested replies, and next actions, without embedding another AI runtime in this module.
13. Audit communications activity, provider events, user actions, consent state, and administrative configuration.

### 1.2 Product principles

- **Provider-neutral domain:** Domain services must not depend directly on a provider SDK's types or status enums.
- **Record-security first:** Caller lookup, search, conversation contents, recordings, transcripts, and related-record links must enforce server-side ACL.
- **At-least-once webhook reality:** Inbound provider events must be authenticated, idempotently persisted, and safely replayable.
- **Explicit channel policy:** Consent, opt-out, approved templates, rate limits, quiet hours, and channel-specific restrictions must be checked before send.
- **No silent call/message success:** UI state must distinguish requested, accepted/queued, ringing/sending, delivered/completed, failed, and unknown outcomes as supported by the provider.
- **Data minimization:** Persist only the provider payload fields needed for processing, troubleshooting, audit, and configured retention.
- **Human control:** AI-generated summaries or suggestions are advisory unless a separately authorized and auditable action is explicitly approved.
- **Composable:** Reuse Activities, ACL, Notifications, Files, Jobs, audit, Portal, ServiceDesk, MarketingAutomation, and AIAgents when present.

### 1.3 Functional reference boundary

Use public EspoCRM documentation as behavioral inspiration for CRM-oriented telephony: click-to-call, incoming/outgoing call popups, caller history, adding call comments, saving calls, and supported provider/PBX integration patterns. The official VoIP Integration references list integrations such as 3CX, Twilio, Asterisk, Starface, Binotel, and iexPBX. Twilio references also describe voice calls, call recording, SMS/MMS, message status callbacks, and webhook validation.

This plan is a **clean-room reimplementation** for the NestJS application. Do not copy PHP classes, upstream frontend assets, icons, translations, branding, or source code. Treat channel/provider behavior as versioned external contracts and verify current provider documentation while implementing each adapter.

Reference pages:

- EspoCRM VoIP Integration: https://www.espocrm.com/features/voip-integration/
- VoIP Integration overview: https://docs.espocrm.com/extensions/voip-integration/overview/
- VoIP customization and provider hooks: https://docs.espocrm.com/extensions/voip-integration/customization/
- EspoCRM Activities and Calendar: https://docs.espocrm.com/user-guide/activities-and-calendar/
- EspoCRM developer documentation: https://docs.espocrm.com/development/
- Twilio secure webhooks: https://www.twilio.com/docs/usage/webhooks/webhooks-security
- Twilio Voice webhooks: https://www.twilio.com/docs/usage/webhooks/voice-webhooks
- Twilio Messaging API and status callbacks: https://www.twilio.com/docs/messaging/api/message-resource
- Twilio WhatsApp API overview and session policy: https://www.twilio.com/docs/whatsapp/api
- Twilio WhatsApp message templates: https://www.twilio.com/docs/whatsapp/tutorial/send-whatsapp-notification-messages-templates
- Twilio voice recording encryption: https://www.twilio.com/docs/voice/tutorials/voice-recording-encryption

Record implementation decisions and verified behavior in `docs/compatibility/voice-communications.md`.

---

## 2. Scope and Non-Goals

### 2.1 In scope

- Provider registration and configuration for voice and supported messaging channels.
- Provider adapter interfaces and webhook/event ingestion.
- Phone-number normalization and CRM identity matching.
- Click-to-call initiation and call lifecycle tracking.
- Incoming-call events and caller context popup/panel.
- Call activity creation/update and call notes.
- SMS/MMS outbound and inbound messaging, according to provider support.
- WhatsApp Business messaging through an approved provider (initially provider-neutral, with Twilio as a reasonable first implementation target if credentials/access exist).
- Unified inbox for supported interactive conversations.
- Assignment, team queues, unread/read state, conversation status, and handoff to ServiceDesk.
- Media metadata and secure access to provider-hosted or internally stored recordings/attachments.
- Optional transcription, summarization, topic/action extraction, and suggested replies via the existing `AIAgents`/AI gateway capabilities.
- Communication templates/snippets for one-to-one service interactions; MarketingAutomation remains the owner of campaign/journey orchestration.
- Consent, opt-out, channel policy, retention and audit features required to operate supported channels safely.
- Reporting for calls, messages, delivery, agent activity and channel performance.

### 2.2 Explicit non-goals

Do not implement these as part of this module unless repository audit identifies an explicit existing product requirement:

- Building or hosting a complete PBX, SIP carrier, or telecom network.
- Replacing a provider's own routing, billing, number provisioning, WhatsApp Business Account approval, or template review systems.
- Implementing a general-purpose email client or replacing the existing Email subsystem.
- Reimplementing MarketingAutomation campaigns, audience segmentation, consent center, or bulk campaign send engine. This module exposes supported channels/adapters and approved one-to-one conversation functionality; MarketingAutomation may integrate through stable APIs and policy services.
- Implementing a separate support-ticket domain. `ServiceDesk` owns Cases/tickets; this module stores communication objects and links them to Cases.
- Implementing an AI agent runtime, vector store, prompt management platform, or autonomous action engine. Reuse `AIAgents` if available.
- Capturing calls or recording/transcribing by default without explicit system policy, required notice/consent, and configurable retention.
- Supporting arbitrary providers by dynamic code execution or installing unreviewed plugins at runtime.
- Guaranteeing carrier-level delivery or real-time call events when a provider cannot supply that guarantee.

### 2.3 Recommended delivery strategy

Build a provider-neutral foundation and a narrow vertical slice first:

1. Domain model, provider interface, secure webhook ingestion, audit and fake provider.
2. Call logging and click-to-call using one provider adapter.
3. Inbound call matching/context popup.
4. SMS/MMS in the same provider gateway where available.
5. WhatsApp Business messaging through a configured approved provider.
6. Unified inbox, assignment and ServiceDesk handoff.
7. Recording/transcription/AI and additional PBX adapters.

Do not block the initial release on support for every listed PBX vendor. Mark each adapter as Supported, Experimental, or Not Implemented in provider documentation and configuration UI.

---

## 3. Dependency and Integration Contract

### 3.1 Required platform capabilities

Phase 19-VC.0 must verify these before coding:

- Authentication and authorization.
- Users, Teams, Roles, record-level ACL and field-level ACL where supported.
- Metadata-driven entities, relationships, REST API and frontend routing.
- Existing Accounts, Contacts, Leads and phone/email fields.
- Existing Activities/Calls/Tasks and Calendar, if already implemented.
- Files/attachments/media service, or a documented secure storage abstraction.
- Jobs/queue service, scheduler, retry and operational logging.
- Notifications/realtime event delivery, if available.
- Audit trail and system configuration/secret storage.
- Existing provider credential handling and encryption conventions, if any.

If a capability is missing, document the gap and define the smallest reusable platform addition. Do not silently create a duplicate generic service inside `VoiceCommunications`.

### 3.2 Existing modules to integrate with

- **Portal:** optionally expose permitted conversation history and customer-initiated messages only when portal authorization and channel policy support the use case. Portal remains the owner of portal identity/session rules.
- **ServiceDesk:** link a conversation or call to an existing Case; allow authorized agents to create or open a Case through a ServiceDesk contract. Do not create a second Case entity.
- **CustomerSuccess:** expose call/message touchpoints and customer engagement signals through domain events or approved APIs. CustomerSuccess remains the owner of health score and success plans.
- **Sales:** link communications to Accounts, Contacts, Leads, Opportunities, Quotes, Orders, or other configured records through permitted relationship contracts. Do not change financial document state directly.
- **MarketingAutomation:** provide a channel adapter or send capability only through an agreed interface. MarketingAutomation remains the owner of audience, campaign, journey, campaign opt-out policy, and bulk campaign scheduling. Respect campaign consent/suppression before any campaign-triggered send.
- **AIAgents:** call an explicitly configured agent/tool for summaries or suggested actions. Do not let AI bypass ACL, channel policies, approval requirements, or send controls.
- **Projects:** optionally associate communication records with permitted project records/tasks; do not introduce a hard dependency.
- **Notifications/Jobs/Files/Activities:** reuse the existing platform services.

### 3.3 Module naming and dependency policy

- Register exactly one domain module under the name `VoiceCommunications`.
- Suggested class: `VoiceCommunicationsModule`; backend namespace/path must follow actual repository convention.
- Suggested frontend slug: `voice-communications`.
- Provider adapters should be named by vendor/protocol internally (for example `TwilioVoiceAdapter`, `TwilioMessagingAdapter`, `AsteriskEventAdapter`, `ThreeCxAdapter`) and registered through the module's provider registry. They are not separate CRM domain modules.
- Avoid circular dependencies. Communicate across module boundaries through documented service interfaces/events.
- Optional integrations must degrade gracefully when their target module is disabled or unavailable.

---

## 4. Architecture

### 4.1 Recommended logical components

1. **Provider Registry** — lists adapter capabilities and health/configuration state.
2. **Provider Configuration Service** — stores non-secret configuration and references encrypted credentials in the application's secret system.
3. **Voice Gateway** — normalizes call initiation, call status, inbound call and recording callbacks.
4. **Messaging Gateway** — normalizes SMS/MMS/WhatsApp send, receive, delivery status and failure events.
5. **Webhook Ingress** — provider-specific signature validation, rate limiting, replay protection, idempotency, payload validation and event persistence.
6. **Communication Domain Service** — owns conversation, message, call session, participant, assignment and status transitions.
7. **Contact Resolver** — normalizes phone addresses, looks up permitted CRM identities and handles ambiguous matches safely.
8. **Policy Service** — consent, suppression, recipient eligibility, channel-window/template constraints, rate limits, quiet hours and retention policy.
9. **Call UI Event Publisher** — emits permitted incoming-call and call-state events to the current user/team UI.
10. **Media Service Integration** — stores secure media metadata and optionally streams authorized media from provider storage without exposing raw credentials.
11. **AI Enrichment Adapter** — submits eligible content to the existing AIAgents/AI platform for transcript, summary, topic, sentiment or action extraction under configurable policy.
12. **Audit and Analytics Publisher** — records security-relevant changes and emits coarse-grained metrics without leaking message contents into logs.

### 4.2 Layering rules

- Controllers handle transport, DTO validation, authentication and response mapping; domain decisions stay in services.
- Provider SDK calls must be wrapped by adapters and cannot leak SDK objects into repositories, DTOs, frontend state or core domain events.
- Persist provider event receipts before expensive processing when feasible; enqueue processing only after authentication and payload validation.
- Do not keep long-running network calls or transcription in synchronous request handlers.
- Use the existing Entity Engine for metadata-driven CRM records where appropriate. Provider events and high-volume message/call data may use dedicated relational tables if justified by load and lifecycle differences; document this design choice in the repository audit.
- Use transactional outbox or the repository's established durable event mechanism when database changes must result in queue work.
- Use vendor-neutral normalized event names while preserving limited vendor metadata needed for troubleshooting.
- Add adapter conformance tests so a new provider can be introduced without rewriting conversation, ACL, or UI logic.

### 4.3 High-level call and message flow

**Outbound call:** UI action → ACL check → number normalization → provider/account selection → eligibility/rate-limit checks → provider call request → persisted call session → provider callbacks update lifecycle → user UI/Activities receive domain events.

**Inbound call:** provider webhook → signature verification → idempotency/replay check → persisted provider event → call-session update → safe caller matching → realtime popup event to authorized user/team → agent logs notes/links record → existing Activity is created or updated.

**Outbound message:** UI/action or approved module integration → ACL + consent/suppression + channel policy + template validation → enqueue send command → provider adapter sends → external message ID persisted → provider status callbacks update normalized state.

**Inbound message:** provider webhook → authentication and deduplication → inbound media validation/URL safety → message and conversation persisted → identity resolution → assignment/unread update → realtime inbox notification → optionally suggest ServiceDesk handoff.

---

## 5. Data Model and Persistence Requirements

The repository audit must first check whether generic Calls, Activities, Emails, Messages, Attachments, Contacts, phone fields, consent records, or audit entities already exist. Reuse or extend existing records wherever semantically appropriate. Avoid duplicate representations of the same call/message.

The following is a conceptual model, not a command to create every table regardless of current schema.

### 5.1 Provider and endpoint entities

- `CommunicationProvider`: provider key, display name, supported capabilities, status, version, health state, configuration version, timestamps.
- `CommunicationProviderAccount`: provider account/tenant reference, environment, enabled channels, sender/number references, credential secret reference, callback configuration, last health check. Never store raw API secrets in plaintext.
- `CommunicationEndpoint`: configured phone number, SIP endpoint, sender ID, WhatsApp sender, provider identity, channel, country/region, capabilities, active state, ownership/team, limits, and metadata safe for display.
- `ProviderCredentialRef`: use only if this is consistent with the system's established secret model; preferably store a secret-store reference rather than duplicate credentials.
- `ProviderWebhookEvent`: provider, account reference, vendor event ID, normalized event type, received time, processed state, attempt count, payload digest, safe diagnostic fields, and encrypted/redacted payload only where required for replay/troubleshooting.

### 5.2 Communication records

- `CallSession` or the existing `Call` Activity: direction, provider, endpoint, local/remote address, normalized phone numbers, start/answer/end times, duration, call result, normalized state, initiator, assigned user/team, external call ID, related CRM record references, failure code/category, and recording metadata reference.
- `Conversation`: channel, provider account, external thread/session ID, participants, assigned user/team/queue, status, unread counters, last activity time, first/last inbound time, channel eligibility/window metadata, related CRM records, optional Case reference and archived state.
- `ConversationParticipant`: conversation, normalized address, role/direction, optional permitted CRM Contact/Lead/Account reference, display name snapshot, consent reference/status where available, timestamps.
- `CommunicationMessage`: conversation, direction, channel, sender/recipient participant, normalized body/content reference, safe content type, external message ID, provider status, normalized status, send/receive timestamps, delivery timestamps, failure code/category, reply/template metadata, related record references, and author/actor.
- `CommunicationMedia`: parent message/call, provider media reference, secured storage reference, type, MIME type, size, duration if relevant, hash, scan status, retention date, transcript state, access policy and encryption metadata. Avoid permanent raw external URLs if they contain access tokens.
- `CommunicationAssignmentEvent`: old/new assignee/team/queue, actor, reason and timestamp.
- `CommunicationConsentEvent` or a reference to the system's authoritative consent entity: purpose, channel, status, source, evidence/reference, timestamp, capture context and revocation details. Do not create a second authoritative consent source if MarketingAutomation already owns consent; agree on the canonical service.
- `CommunicationAuditEvent`: use generic audit infrastructure if available; avoid storing full message bodies in audit logs.
- `CommunicationTemplate` / `MessageSnippet`: reusable service-interaction snippets and channel-specific content. Campaign templates and journey templates remain owned by MarketingAutomation.
- `Transcript` and `TranscriptSegment` if supported: language, provider/job, speaker label, time offsets, text, confidence, redaction state and retention metadata. Store transcript only when policy allows it.

### 5.3 Persistence constraints

- Use stable IDs and foreign keys where the repository uses relational references.
- Uniquely identify provider events using `(providerAccountId, providerEventId)` or an equivalent reliable idempotency key when available.
- Uniquely identify externally created messages/calls using provider/account + external ID where available.
- Index normalized phone/address lookup fields without exposing them in logs; consider separate normalized and display values.
- Index conversation fields used for assignment, queue, status, last activity, unread state and related record lookup.
- Consider table partitioning/retention only after measurement demonstrates need; do not prematurely complicate PostgreSQL storage.
- Avoid high-cardinality or unbounded provider JSON blobs in primary hot-path queries. Keep raw payloads limited, redacted and retained for a bounded duration.
- Use transactions for provider event deduplication and domain-state updates where practical.
- All timestamps must be stored consistently (UTC) and displayed using user/account time-zone settings.

---

## 6. Provider Adapter Contracts

### 6.1 Core adapter capability model

Adapters should declare capabilities instead of assuming every provider supports every feature:

- `voice.outboundCall`
- `voice.inboundEvents`
- `voice.callStatusCallbacks`
- `voice.callAnswer` (optional: agent-side answer from the call popup)
- `voice.callHangup` (optional: agent-side decline/hang-up)
- `voice.recordingMetadata`
- `voice.recordingDownload` (optional)
- `messaging.sms.send`
- `messaging.sms.receive`
- `messaging.mms.send`
- `messaging.mms.receive`
- `messaging.whatsapp.send`
- `messaging.whatsapp.receive`
- `messaging.deliveryStatus`
- `messaging.templates`
- `messaging.media`
- `webhook.signatureValidation`
- `provider.healthCheck`

The UI must hide or disable unsupported actions based on capabilities, but the server must still validate the operation.

### 6.2 Conceptual TypeScript contracts

Use the repository's existing naming and validation conventions, but preserve these concepts:

```ts
export interface VoiceProviderAdapter {
  readonly providerKey: string;
  getCapabilities(accountId: string): Promise<VoiceCapabilities>;
  initiateCall(input: InitiateCallInput): Promise<InitiateCallResult>;
  endCall?(input: EndCallInput): Promise<void>;
  validateWebhook(request: ProviderWebhookRequest): Promise<ValidatedProviderEvent>;
  normalizeCallEvent(event: ValidatedProviderEvent): NormalizedCallEvent;
  getRecordingReference?(input: RecordingLookupInput): Promise<RecordingReference | null>;
  healthCheck(accountId: string): Promise<ProviderHealthResult>;
}

export interface MessagingProviderAdapter {
  readonly providerKey: string;
  getCapabilities(accountId: string): Promise<MessagingCapabilities>;
  sendMessage(input: SendCommunicationMessageInput): Promise<SendMessageResult>;
  validateWebhook(request: ProviderWebhookRequest): Promise<ValidatedProviderEvent>;
  normalizeMessageEvent(event: ValidatedProviderEvent): NormalizedMessageEvent;
  getTemplateStatus?(input: TemplateStatusLookupInput): Promise<ProviderTemplateStatus>;
  healthCheck(accountId: string): Promise<ProviderHealthResult>;
}
```

These are conceptual contracts; adapt them to the existing codebase rather than copying them blindly.

### 6.3 Provider strategy

Recommended order:

1. **Fake/simulator adapter** for deterministic tests and local development. It must not send messages or call real phone numbers.
2. **One primary production adapter** covering voice + SMS/MMS when a usable account is available. Twilio is a reasonable first option because its public documentation covers voice webhooks, message callbacks and multiple messaging channels.
3. **WhatsApp Business support** through a provider-approved WhatsApp sender/account, with template and service-window rules enforced by a policy service.
4. **PBX adapters** such as Asterisk or 3CX, selected based on actual infrastructure. Add other providers only when there is a business requirement and test access.

Do not claim a provider is implemented because a shared interface exists. Track status per capability: `not-implemented`, `experimental`, `supported`, `disabled`, `unhealthy`.

---

## 7. Call Lifecycle and Telephony Requirements

### 7.1 Outbound calling

- Add a click-to-call action to configured phone fields and eligible entity views.
- Normalize the destination number to E.164 when possible; preserve a display format for UI.
- Validate the phone number, provider account, allowed source endpoint, user role, team policy, destination restrictions and call rate limits before placing the call.
- Require an explicit user action to start an outbound call. An AI agent, automation or incoming webhook must not place a call without a configured action policy and any required approval.
- Persist an initiated call session before or immediately after the provider accepts the request, with recoverable state if the API response is interrupted.
- Use provider IDs to reconcile callbacks with the persisted session.
- If initiation fails, preserve an actionable failure state without creating a false completed call.
- Support only the call-control features that the adapter explicitly declares; never imply support for hold, transfer, mute or hang-up if it is not implemented.

### 7.2 Incoming call events and caller context

- Accept inbound events only through authenticated provider endpoints.
- Resolve the caller against normalized phone numbers across permitted CRM entities.
- If multiple records match, present a list or safe disambiguation experience; do not silently select a potentially wrong Contact.
- If no record matches, show only the number and a safe option to create or associate a record when the user has permission.
- Show a call popup/panel with matching caller details, relevant authorized history, call controls supported by the provider and quick call-note capture.
- Do not broadcast caller names or CRM details to every logged-in user. Use provider endpoint/team routing and ACL to select recipients.
- Prevent stale or duplicate popups by correlating provider event IDs and call-session state.

### 7.3 Call state machine

Define a normalized state machine. The exact states may be adapted to provider behavior, but must include equivalent representations for:

- `requested`
- `initiated`
- `ringing` (when available)
- `in_progress` / `answered`
- `completed`
- `missed`
- `busy`
- `no_answer`
- `failed`
- `cancelled`
- `unknown` / `reconciliation_required`

Do not force every provider state to fit an incorrect status. Preserve vendor status in an adapter-safe detail field when required, and define explicit mapping tests.

### 7.4 Call logging and activity integration

- Reuse the existing Call Activity entity where it matches the domain. If the generic Call entity is absent, first verify whether it belongs to the core Activities platform before creating a module-local implementation.
- Store direction, outcome, start/end, duration, owner/assignee, phone addresses, provider reference, related entity links and notes using established entity conventions.
- Incoming event reconciliation must update one logical call record, not create one record per callback.
- Allow users to create a follow-up Task or Meeting via existing Activity APIs.
- Make notes editable only according to normal ACL and audit rules; preserve audit history for edits.
- Link calls to one or more authorized CRM records where the existing relationship model permits it.

### 7.5 Call recording

- Recording is disabled by default unless system administrators configure a legal and operational policy.
- Show whether recording is active or available, as the provider can determine it.
- Store a secure internal reference or provider recording ID. Do not expose long-lived, unauthenticated media URLs.
- Authorize every playback/download request server-side.
- Enforce recording notice/consent rules and retention/deletion policy appropriate to the configured deployment. The application must not pretend a single global policy fits every jurisdiction.
- Support signed URLs with short expiry only when the current Files/media infrastructure supports them securely.
- Prevent recordings from being attached to a broadly accessible CRM record without explicit access validation.
- Keep recording encryption, key management, and vendor features documented. Never invent a custom cryptographic scheme.

---

## 8. Messaging Requirements: SMS, MMS and WhatsApp

### 8.1 Common message behavior

- Support one-to-one conversation-oriented messaging first.
- Distinguish submitted-to-provider, queued, sent, delivered, read (only if channel/provider supplies it), failed, undelivered and unknown states. Do not infer delivery/read status if a callback is absent.
- Persist an outbound message attempt and idempotency key before external dispatch where possible; use a transactional outbox or equivalent so process restarts do not lose sends.
- Associate provider message IDs, callbacks and retry history with the same logical message.
- Avoid automatic duplicate sends after a timeout where the provider may have accepted the original request. Reconcile status before retrying uncertain outcomes.
- Support plain text and supported media types within provider, channel and configured size/format limits.
- Validate message size, encoding, media MIME type, destination country, user quota, and account/channel capability before enqueueing.
- Maintain a clear distinction between an internal note and an external message. Internal notes must never be sent to recipients.
- Make reply behavior channel-aware; do not use an SMS/WhatsApp sender for a provider/account that does not own the conversation.

### 8.2 SMS/MMS

- Support inbound and outbound SMS where enabled by the provider and local regulations.
- Support MMS attachments only when the provider, destination carrier and region permit them.
- Model delivery callbacks and error codes with normalized categories plus safe vendor detail.
- Prevent automatic retry for permanent errors, opt-outs, invalid addresses or policy violations.
- Handle inbound STOP/START or similar opt-out/opt-in keywords through a configurable compliance/policy flow where applicable; verify legal/provider requirements for each region before enabling automated interpretation.
- Apply suppression rules before every outbound send, including delayed queue jobs.

### 8.3 WhatsApp Business

- Use a supported WhatsApp Business Platform provider, not an unofficial consumer-account automation or reverse-engineered client.
- Require configuration for an approved WhatsApp Business sender/account before enabling the channel.
- Persist the last inbound customer message/time and derive an explicit channel conversation-window state from current provider rules.
- During an eligible customer-service window, permit supported free-form replies. Outside the permitted window, require the correct approved template and template identifiers/variables when provider policy requires it.
- Do not hardcode pricing or policy assumptions into generic code. Template categories, approval status, locale, variable schema and eligibility must be read from or synchronized with the provider when supported.
- Require and record applicable WhatsApp consent/opt-in, honor opt-out, and do not infer consent from the mere existence of a phone number.
- Handle template rejection, approval changes, delivery failures, media limits and unsupported features as explicit states.
- Keep WhatsApp-specific implementation inside an adapter; common inbox and conversation services remain channel neutral.

### 8.4 Consent and messaging eligibility

Before sending an outbound SMS, MMS, WhatsApp message, or campaign-triggered communication, check:

1. The current actor/service is authorized for the requested send action.
2. The contact address is valid and normalized.
3. Consent/opt-in is present if required for the purpose/channel/jurisdiction.
4. Contact/channel is not suppressed, opted out, blocked, or subject to a complaint/administrative stop.
5. The channel's template or session-window constraints are satisfied.
6. Account/provider quota and rate limits permit the send.
7. Any configured quiet-hours or business-hours rule permits it.
8. The message payload, attachments and variables pass validation.

Recheck eligibility immediately before actual provider dispatch, not merely when a user creates or schedules a message. A queued message must be cancellable when recipient eligibility changes.

---

## 9. Unified Inbox and Conversation Management

### 9.1 Inbox user experience

Provide a unified inbox for enabled interactive channels, with:

- Conversation list grouped/filtered by channel, status, assignment, team/queue, unread state, last activity and SLA/priority if integrated with ServiceDesk.
- Search by permitted contact name, normalized address, message ID or approved full-text fields.
- Conversation timeline ordered by event time with inbound/outbound direction and delivery status.
- Distinct presentation for internal notes, user messages, media, call events, system events and AI suggestions.
- Contact/context panel showing only CRM records the current user is allowed to access.
- Assignment controls and action history.
- Quick reply/snippets with placeholder validation.
- Safe handling of duplicate inbound message callbacks and out-of-order delivery updates.
- Loading, error, empty, reconnecting and channel-disconnected states.

### 9.2 Conversation states and assignment

Suggested normalized states:

- `open`
- `pending_customer`
- `pending_internal`
- `resolved`
- `closed`
- `spam` / `blocked` where appropriate

Keep communication-conversation state separate from ServiceDesk Case status. A conversation may link to a Case, but it must not independently change the Case's workflow state unless the ServiceDesk API explicitly performs that transition.

Assignment requirements:

- Direct user assignment.
- Team/queue assignment when the repository supports teams/queues.
- Manual assignment in MVP.
- Optional round-robin or load-aware routing only after a repository audit confirms required availability/capacity signals.
- Reassignment audit trail with actor, previous value, new value and reason.
- Prevent unauthorized users from viewing or assigning conversations outside their scope.
- Do not leak conversation content in notifications sent to users without record access.

### 9.3 Templates and snippets

- Provide admin-managed snippets/templates for one-to-one service communications.
- Validate placeholders against an explicit allowed-variable schema and escape output appropriate to the channel.
- Preview the final rendered message before sending where possible.
- For WhatsApp templates, distinguish locally saved snippets from provider-approved WhatsApp templates.
- Do not replicate MarketingAutomation campaign templates, audience lists, journey templates or bulk scheduling. Provide an integration contract instead.
- Version or audit changes to shared templates when a change could alter customer-facing content.

---

## 10. AI Enrichment and Conversation Intelligence Integration

### 10.1 Scope

AI features are optional and must reuse the existing `AIAgents` module or shared AI provider gateway. `VoiceCommunications` is responsible for supplying eligible input, recording the result, showing provenance and applying access controls—not for implementing agent orchestration.

Potential features:

- Call transcript generation when no provider transcript is available and the feature is explicitly configured.
- Call/message summarization.
- Action-item extraction and suggested follow-up activities.
- Topic/category suggestions for ServiceDesk handoff.
- Suggested responses for an agent to review and edit.
- Searchable transcript summaries if permissions and retention settings permit.
- Customer-success touchpoint summaries for `CustomerSuccess` where that module opts in.

### 10.2 Safeguards

- Default to human review for externally visible messages and CRM mutations suggested by AI.
- An AI tool must not initiate calls, send messages, download recordings, or expose conversation data unless its registered tools and permissions explicitly permit it.
- Apply the caller's/acting user's ACL when retrieving source data; background processing must use a constrained service identity and documented scope.
- Configure which providers may receive content, which channels/content classes are excluded, regional processing requirements if applicable, and whether content may be used for provider training according to the chosen provider's current terms.
- Redact or exclude payment data, secrets, authentication codes, and sensitive personal data where feasible.
- Store AI output provenance, provider/model, prompt/template version, source reference, completion time and review state without logging hidden reasoning or unnecessary raw prompts.
- Allow admins to disable AI enrichment globally or by channel/provider.
- Do not send entire CRM records when a minimal transcript/message excerpt is sufficient.

---

## 11. Public API and Event Contracts

Follow the repository's `/api/v1` conventions, DTO validation, error format, pagination and OpenAPI generation. The exact route layout must follow the existing codebase after audit; the examples below define logical operations, not a mandate to duplicate existing routes.

### 11.1 Admin/provider API concepts

- List provider adapters and capabilities.
- Create/update/enable/disable provider account configuration.
- Validate a provider connection and run a health check.
- View endpoint/number configuration.
- Inspect webhook processing status and safe diagnostic errors.
- Test a provider with a non-delivering validation operation or provider sandbox where available.

Credential values must be write-only or masked in responses. Never return a provider auth token after it is saved.

### 11.2 Calls API concepts

- Initiate outbound call.
- Request supported call control (hang up/transfer/etc.) only if adapter capabilities and ACL allow it.
- List/view permitted call sessions.
- Add/update notes and related CRM links.
- Request recording metadata or authorized streaming/download via the media service.
- Reconcile call status from provider where supported.

### 11.3 Messaging/conversation API concepts

- List/search conversations with ACL-scoped filtering.
- Retrieve a conversation and paginated timeline.
- Send SMS/MMS/WhatsApp message to an existing permitted conversation.
- Create a new conversation only when policy and provider account permit it.
- Mark conversation/message as read where the channel/product supports this local state; do not invent provider read receipts.
- Assign/reassign/resolve/reopen conversation.
- Add internal note.
- Upload or reference media with MIME/size validation.
- Link conversation to an Account, Contact, Lead, Opportunity, Case or other permitted entity.
- Link/unlink a Case via ServiceDesk contract.

### 11.4 Webhook API concepts

Use separate provider-specific endpoints or a safe adapter routing convention, for example:

- `POST /api/v1/integrations/voice-communications/{providerKey}/{accountKey}/voice-events`
- `POST /api/v1/integrations/voice-communications/{providerKey}/{accountKey}/message-events`
- `POST /api/v1/integrations/voice-communications/{providerKey}/{accountKey}/status-events`

Do not expose `accountKey` as a secret. It is only a routing identifier. Authentication comes from provider signature validation or a similarly strong provider-specific mechanism.

For each webhook:

1. Reconstruct the exact signed request input as required by the provider SDK.
2. Validate signature using the official/current provider SDK or documented implementation; do not invent a signature algorithm.
3. Resolve the configured provider account safely.
4. Apply replay/idempotency checks and bounded request/body limits.
5. Persist a durable event receipt and respond within the provider's timeout.
6. Perform heavier processing asynchronously where suitable.
7. Record safe diagnostic context and expose retry/replay to authorized administrators.

### 11.5 Domain events

Use names consistent with the project's event bus. Suggested normalized events:

- `voice-communications.call.initiated`
- `voice-communications.call.ringing`
- `voice-communications.call.answered`
- `voice-communications.call.completed`
- `voice-communications.call.missed`
- `voice-communications.call.failed`
- `voice-communications.message.received`
- `voice-communications.message.queued`
- `voice-communications.message.sent`
- `voice-communications.message.delivered`
- `voice-communications.message.failed`
- `voice-communications.conversation.assigned`
- `voice-communications.conversation.resolved`
- `voice-communications.recording.available`
- `voice-communications.transcript.completed`

Events should carry identifiers and minimal metadata by default, not full bodies/recordings. Consumers must reload content through authorization-aware services.

---

## 12. Frontend Requirements

### 12.1 Telephony controls

- Click-to-call action for configured phone fields, respecting permission and provider state.
- Inbound call popup/panel showing number, safe record matches and call state.
- Call controls only where the provider supports them.
- In-progress duration/timer derived from event timestamps, not by persisting every second.
- Quick note, select related record, save call, create follow-up activity.
- Reconnection/error handling and stale-call cleanup.

### 12.2 Communication inbox

- Responsive inbox layout, conversation list and message timeline.
- Filter/search, channel icon/label, unread count, assignment, team and status.
- Composer with channel-specific validation, template support and attachment constraints.
- Explicit send confirmation/error state; prevent accidental double click/duplicate command.
- Show a clear explanation when WhatsApp template/session policy prevents a free-form message.
- Distinguish provider delivery status from internal queue processing state.
- Keep keyboard accessibility, focus management, loading skeletons, empty states and error recovery consistent with the existing React/Ant Design conventions.

### 12.3 Record-level panels

Where the CRM has a record detail page, show an authorized Communications panel on Accounts, Contacts, Leads, Opportunities and Cases/ServiceDesk records. Only show the entity types and relationship data configured in metadata. Use lazy pagination and avoid loading all media/transcripts on initial page load.

### 12.4 Admin pages

- Provider/account setup and credential rotation.
- Endpoint/number configuration and capability display.
- Connection status and last successful health check.
- Queue/backlog and webhook failure overview.
- Recording/transcription settings and retention policies.
- Channel consent/opt-out configuration and template status.
- Feature flags per channel, provider account and team.

Admin UI must not display secret values after save. Use explicit confirmation before disabling a provider that owns active conversations or has pending messages.

---

## 13. Security, Privacy, Compliance and Operational Controls

### 13.1 Provider credentials

- Reuse the platform's secrets service or secret-encryption convention. If none exists, make it a shared platform decision rather than creating a weak module-only secret system.
- Never store raw API tokens in logs, exception messages, audit details, responses, fixtures or screenshots.
- Support credential rotation without code changes; record the rotation time/actor without persisting the secret value in the audit event.
- Separate provider accounts/environments and make test/sandbox mode explicit.
- Use least-privilege credentials and endpoint allowlists where supported.

### 13.2 Webhook security

- Require HTTPS in deployment environments exposed to provider callbacks.
- Use official SDK signature verification or provider-recommended validation.
- Validate request signatures before trusting sender, event IDs, recording URLs or message content.
- Preserve raw body only where signature validation requires it; avoid logging it.
- Apply request size limits, rate limiting, bounded parsing and content-type validation.
- Use idempotency keys/provider event IDs and store duplicate receipts safely.
- Avoid SSRF when fetching media: allowlist provider hosts, resolve/validate addresses, reject local/private IP ranges where applicable, and enforce redirect limits.
- Provider callbacks must not be allowed to invoke arbitrary CRM mutations outside the event handler's explicit contract.

### 13.3 Authorization

- Apply authentication and ACL for every call/message/conversation/media API.
- Check record-level access for all related CRM entities and every participant/record shown in a popup or inbox panel.
- Enforce server-side access to recordings and transcripts independently from the related Contact/Case visibility.
- Internal notes must be hidden from external portal users and from provider send adapters.
- Ensure unread counts, search suggestions, notifications and aggregate metrics do not disclose restricted communications.
- A provider integration account is not automatically authorized to read all CRM records. Use constrained service roles and domain-specific permissions.

### 13.4 Consent, opt-out and local legal requirements

- Define channel/purpose consent as an explicit policy input; do not infer consent from a phone number or prior unrelated CRM interaction.
- Honor opt-outs and suppression lists on every send path, including retries, scheduled sends and messages queued by other modules.
- Maintain a durable audit record of opt-in, opt-out, source, timestamp and policy version, while reusing the existing canonical consent service if available.
- Make recording and transcription disabled by default until the administrator configures jurisdiction, notice/consent behavior, permitted purposes and retention.
- Provide retention/deletion processes for messages, recordings and transcripts; preserve only records that must remain under an explicitly documented retention/legal requirement.
- Do not present this plan as legal advice. The deploying organization must validate telecom, privacy, recording, marketing and messaging requirements for its locations and customer markets.

### 13.5 Media and transcript protection

- Validate uploaded/inbound media size, content type, file signature where practical, scan status and storage policy.
- Store private media using the existing file service/private bucket model; do not rely on unguessable URLs alone.
- Do not permanently persist vendor URLs that carry bearer-like query parameters.
- Apply retention expiry and deletion job behavior; retain an audit tombstone where required by the system policy.
- Apply redaction to transcripts/exports as configured. Restrict download and bulk export privileges.

### 13.6 Reliability and availability

- Use bounded retries with exponential backoff and jitter for transient provider failures.
- Treat timeouts as uncertain outcomes; reconcile before retrying a call/message that may already have been accepted.
- Implement dead-letter/retry status and authorized replay for failed webhook events.
- Use an outbox or durable send queue to avoid losing messages between database commit and queue dispatch.
- Include correlation IDs across API request, domain record, provider request, webhook event and job attempt.
- Add circuit-breaker or provider-health gating if the shared infrastructure supports it; never repeatedly hammer an unhealthy provider.
- Define cleanup for abandoned call sessions and incomplete webhook processing without fabricating successful state.

---

## 14. Observability, Reporting and Cost Awareness

### 14.1 Operational metrics

- Provider health and request success/failure rates.
- Webhook validation failure rate and processing latency.
- Duplicate events discarded and events needing replay.
- Outbound call initiation success/failure counts.
- Call completion/missed/failed counts and duration where supplied.
- Message queue depth, queue latency, provider send latency, delivery and failure rates.
- Conversation backlog, unassigned conversations and time to first response where event data permits accurate calculation.
- Media fetch, scan, transcription and summarization job outcome.
- Provider usage/cost data only when available, and clearly label estimates versus authoritative invoices.

### 14.2 User-facing reports

- Calls by direction, owner/team, outcome and period.
- Missed calls and call follow-up backlog.
- Message volume and delivery/failure by channel/provider.
- Conversation assignment and response-time summaries.
- Active/unassigned/overdue conversations.
- Provider error trends and media/AI processing status.

All reports must enforce ACL and avoid exposing message content unless the viewer has permission. Do not label a callback as “delivered” unless the provider/channel actually reported delivery. Clearly distinguish internal queue acceptance from external network delivery.

---

## 15. Testing Strategy

### 15.1 Unit tests

- Phone/address normalization and CRM match ambiguity.
- Provider status mapping and call/message state machines.
- Consent/suppression/channel policy decisions.
- WhatsApp template/window eligibility based on injectable policy clock and provider state.
- Retry/idempotency decisions and uncertain-send outcomes.
- ACL checks for calls, messages, recordings, transcripts and linked CRM records.
- Media URL/host validation and MIME/size checks.
- Placeholder/template validation and output escaping.
- AI enrichment redaction and approval rules.

### 15.2 Adapter contract tests

Every adapter must pass a common suite covering:

- Capability reporting.
- Valid and invalid webhook signature cases (using provider SDK/test utilities where available).
- Supported payload normalization.
- Unknown/new provider fields without crashes.
- Duplicate and out-of-order callbacks.
- Rate-limit and transient error classification.
- Safe logging and credential masking.
- Provider error response mapping.
- Timeouts and uncertain results.

### 15.3 Integration tests

- Outbound call request persists and reconciles provider callback to the same CallSession/Activity.
- Inbound call matches one eligible Contact or safely returns multiple candidates.
- Inbound SMS/WhatsApp creates one message when the same callback is replayed.
- Message status callbacks update one message without status regression from out-of-order events.
- A revoked consent/opt-out prevents a queued message from being sent.
- A user without ACL cannot open a conversation, related CRM record, recording or transcript.
- Portal users cannot see internal notes or conversations belonging to another contact/account.
- Case linking and handoff use ServiceDesk contracts and do not create duplicate Case records.
- MarketingAutomation integration cannot bypass the canonical consent/suppression/send policy.
- AI suggestions remain non-executing unless separately approved.

### 15.4 End-to-end checks

- Configure a fake provider, make a simulated call and log it to a test CRM record.
- Simulate inbound caller event and verify the UI popup is shown only to the intended authorized user/team.
- Send/receive fake SMS/WhatsApp events and verify conversation timeline and delivery states.
- Fail and retry a webhook processing job without duplicating messages.
- Verify provider disablement blocks new sends and clearly shows pending work.
- Verify redacted logs and authorized recording access.

Do not send real calls or messages to customer numbers during tests. If a real provider sandbox test is explicitly configured, use allowlisted test recipients and a clearly marked test account.

### 15.5 Database test safety

Follow `AGENTS.MD` exactly:

- Do not create a new database, shadow database, schema copy, test container or per-agent database for routine tests.
- Use the existing configured primary project database only for narrowly scoped, non-destructive integration tests after verifying the test target.
- Prefix test records with `AGENT_TEST_` or use a unique run marker.
- Mock/fake providers and suppress all outbound calls/messages in automated tests.
- Clean up only records created by the current test run and positively identified by exact IDs/markers.
- Never reset, truncate or broadly delete existing data.

---

## 16. Documentation and Deliverables

Keep these documents updated:

- `docs/compatibility/voice-communications.md` — behavior references, decisions and compatibility limits.
- `docs/modules/voice-communications/architecture.md` — module boundaries and data flow.
- `docs/modules/voice-communications/providers.md` — provider setup, capability matrix, tested versions and known limitations.
- `docs/modules/voice-communications/webhooks.md` — endpoint setup, signature verification requirements, safe replay and troubleshooting.
- `docs/modules/voice-communications/privacy-and-retention.md` — consent assumptions, recording/transcription settings and retention behavior.
- `docs/modules/voice-communications/operations.md` — health checks, queue recovery, dead-letter handling, credential rotation and incidents.
- OpenAPI documentation for all public/admin routes.
- Admin setup UI help and provider configuration instructions.
- A provider capability matrix showing `not-implemented`, `experimental`, `supported`, `disabled` or `unhealthy` for each adapter/channel.

Do not document a feature as supported until its adapter and end-to-end behavior have passed the relevant tests.

---

## 17. Implementation Roadmap — Sub-Phases

Execute these sub-phases sequentially unless the repository audit identifies an explicit reason to reorder them. Each sub-phase must have code, tests, documentation and acceptance evidence before it is marked complete. Avoid generating the entire module in one step.

### Phase 19-VC.0 — Repository Audit and Feature Contract

**Goal:** Understand the real repository before designing new code.

Tasks:

- Read `PLAN.md`, `AGENTS.MD`, package/workspace structure and conventions from neighboring modules.
- Inspect existing entities/services for Calls, Activities, Emails, Messages, phone fields, Files, consent, audit, Notifications, Jobs, provider settings, and API/webhook infrastructure.
- Inspect `ServiceDesk`, `MarketingAutomation`, `AIAgents`, `CustomerSuccess`, `Sales`, `Projects`, and Portal integration contracts.
- Inspect test scripts and migration infrastructure before executing any database-backed command.
- Build a capability matrix: existing/reuse, extend, missing, explicitly out of scope.
- Document one initial provider and its exact supported capabilities, based on available credentials and current official docs.

Acceptance criteria:

- No code or migration is written before the audit is documented.
- No assumptions are made that planned services are already implemented.
- Provider scope and integration contracts are agreed in a feature-contract document.
- No test database or duplicate generic entity is created.

### Phase 19-VC.1 — Domain Contract and Status Taxonomy

**Goal:** Establish stable neutral domain contracts.

Tasks:

- Define normalized call, message, conversation, participant, provider account and webhook-event types.
- Define state transitions and mapping rules for each provider capability.
- Define event names, idempotency requirements and error categories.
- Define which entity owns call records: reuse existing Call Activity where appropriate.
- Define data classification, retention classes, and ACL matrix for messages, recordings, transcripts and internal notes.

Acceptance criteria:

- State machine and event contracts are documented and tested with representative fixtures.
- Domain types contain no provider SDK types.
- Required decisions are documented before schema design.

### Phase 19-VC.2 — Module Registration and Administration Skeleton

**Goal:** Register `VoiceCommunications` using existing module conventions.

Tasks:

- Register module name `VoiceCommunications`, class `VoiceCommunicationsModule`, slug `voice-communications`.
- Add navigation/admin entry points through existing metadata/menu mechanisms.
- Define module enable/disable settings and feature flags for voice, SMS/MMS, WhatsApp, recordings, transcripts and AI enrichment.
- Add translation keys using the repository's localization workflow.
- Do not add provider credentials in source control or sample `.env` files containing real values.

Acceptance criteria:

- Module loads without changing unrelated modules.
- Navigation respects module/ACL availability.
- No `Ua` prefix appears in module identifiers/classes/slugs.

### Phase 19-VC.3 — Additive Data Model and Migrations

**Goal:** Add only the domain persistence that the audit proved is missing.

Tasks:

- Add provider/account/endpoint tables only where not already represented by shared configuration services.
- Add provider event receipts and idempotency constraints.
- Add message/conversation/session tables only where existing entities cannot satisfy the contract without unsafe overloading.
- Add required foreign keys/indexes/unique constraints and retention metadata.
- Review migration SQL for destructive or locking operations; prefer additive/backward-compatible changes.

Acceptance criteria:

- Migration applies to the configured database without destructive reset.
- Existing data and migration history are preserved.
- Schema and indexes are verified afterward.

### Phase 19-VC.4 — Provider Registry, Secret References and Health Checks

**Goal:** Provide provider lifecycle management without channel-specific UI assumptions.

Tasks:

- Implement adapter registry and capability declarations.
- Integrate with the established credential/secret service.
- Add masked configuration readback, enable/disable, health check and credential rotation handling.
- Validate provider account configuration server-side.
- Add fake provider for local/integration tests.

Acceptance criteria:

- Admin can see provider capabilities and health without exposing credentials.
- Disabled/unhealthy providers cannot accidentally receive new send/call commands.
- Fake adapter never contacts external services.

### Phase 19-VC.5 — Secure Webhook Ingress and Durable Event Processing

**Goal:** Securely accept provider events before implementing complex channel workflows.

Tasks:

- Add routing to the correct configured adapter/account.
- Verify provider signatures using provider SDK/documented utilities.
- Add request validation, request-size limits, rate limiting and replay/idempotency protection.
- Persist accepted webhook event receipts and process them using the existing Jobs/BullMQ service when available.
- Add safe replay/dead-letter inspection for authorized administrators.

Acceptance criteria:

- Invalid signatures are rejected before event effects occur.
- Duplicate callbacks do not duplicate communication records.
- Slow provider events do not exceed provider response timeout unnecessarily.
- Payloads/secrets are not leaked to logs.

### Phase 19-VC.6 — Contact Resolution, Identity and Consent Policy

**Goal:** Normalize phone addresses and make safe identity/eligibility decisions.

Tasks:

- Normalize phone numbers and sender addresses using a maintained library/adapter selected in repository conventions.
- Match addresses to CRM entities according to indexed fields and ACL.
- Provide safe ambiguity handling when multiple CRM records match.
- Integrate with the canonical consent/opt-out service; if absent, document a reusable platform requirement and avoid duplicate ownership with MarketingAutomation.
- Provide channel policy evaluation and explainable block reasons.

Acceptance criteria:

- Invalid/ambiguous addresses are not silently matched to a wrong record.
- Restricted CRM records are not revealed by the resolver.
- Consent/opt-out is checked centrally before send and can be rechecked at dispatch time.

### Phase 19-VC.7 — Call Session and Call Activity Integration

**Goal:** Normalize call events and link calls to CRM Activities.

Tasks:

- Implement or extend CallSession/Call Activity persistence based on Phase 19-VC.0 findings.
- Implement provider call-event normalization and state mapping.
- Track initiated, ringing/answered, completed, missed, failed and unknown outcomes where supported.
- Store provider correlation IDs and prevent duplicate Activity creation.
- Add permitted record linking and call-note handling.

Acceptance criteria:

- Replayed/out-of-order events update the same logical call record.
- Provider unknown status does not falsely become success.
- Call records respect regular ACL, field permissions, Activity conventions and audit rules.

### Phase 19-VC.8 — Outbound Click-to-Call

**Goal:** Initiate calls from supported CRM records.

Tasks:

- Add a click-to-call action to configured phone fields/detail/list layouts where the UI architecture supports it.
- Validate number, user permission, source endpoint, destination policy and provider health.
- Persist call intent and reconcile uncertain provider responses.
- Surface initiation success, failure and pending state in the UI.
- Add provider timeout and duplicate-click protection.

Acceptance criteria:

- A permitted user can initiate a call via the configured adapter.
- An unauthorized user cannot use the endpoint to call a number directly.
- A network timeout does not cause an uncontrolled duplicate call on retry.

### Phase 19-VC.9 — Incoming Call Popup and Caller Context

**Goal:** Show the call to the correct authorized agent/team.

Tasks:

- Publish real-time call events through the existing realtime/notification mechanism, or implement the minimum compatible event channel if missing.
- Resolve contacts and display only authorized caller context.
- Add quick note and record association actions.
- Handle multiple matches, unknown callers, missed call events and popup timeout/cleanup.
- Prevent duplicate popups after callback retries.

Acceptance criteria:

- Popup only reaches intended user/team.
- No private CRM information is disclosed through unauthorized popup events.
- Agent can create/update the associated Call Activity.

### Phase 19-VC.10 — SMS/MMS Messaging Adapter

**Goal:** Implement the first production messaging channel.

Tasks:

- Implement outbound send, inbound receive and status callback mapping for the selected provider.
- Add media validation and secure media references for supported MMS types.
- Persist message intent and provider IDs with retry/idempotency handling.
- Implement status timeline and safe failure descriptions.
- Recheck consent/suppression immediately before provider dispatch.

Acceptance criteria:

- Test messages can be sent only to configured/allowlisted sandbox recipients during automated tests.
- Inbound duplicate callback creates one logical message.
- Delivered state is set only when supported provider callbacks report it.

### Phase 19-VC.11 — WhatsApp Business Adapter and Template Policy

**Goal:** Add compliant WhatsApp Business messaging through an approved provider.

Tasks:

- Verify the account/sender setup, current API capabilities and applicable provider documentation.
- Implement inbound and outbound events through the generic messaging adapter.
- Track inbound-message time and service-window eligibility where required.
- Validate approved template ID, status, category, language and variables for sends that require templates.
- Handle template approval/rejection and unsupported media/features.
- Enforce opt-in/suppression and safe delivery-state reconciliation.

Acceptance criteria:

- Free-form sends are blocked when current channel/provider policy requires an approved template.
- Template variables are validated and rendered safely.
- No unofficial consumer WhatsApp automation is used.
- Policy windows are tested with an injectable clock and provider fixture.

### Phase 19-VC.12 — Conversation and Unified Inbox Domain

**Goal:** Bring supported interactive channels into one agent workspace.

Tasks:

- Add or extend Conversation, Participant, Assignment and Timeline records according to audit results.
- Link inbound/outbound messages and calls to conversations when channel/provider provides a stable grouping key; avoid falsely merging unrelated threads.
- Implement conversation status, unread state, assignment history and record links.
- Support internal notes that never reach provider adapters.
- Provide pagination and indexed query paths for inbox list/detail.

Acceptance criteria:

- Inbox shows normalized events from supported channels without leaking vendor-specific assumptions.
- Internal notes are never delivered externally.
- Read/write actions are ACL protected and audited.

### Phase 19-VC.13 — Assignment, Queue and ServiceDesk Handoff

**Goal:** Make customer conversations operationally useful.

Tasks:

- Implement direct user assignment and team/queue assignment where supported by existing team infrastructure.
- Add manual routing first. Add round-robin only if there is a reliable capacity signal and clear policy.
- Allow authorized agents to link a conversation to an existing ServiceDesk Case.
- Use ServiceDesk API to create/open a Case where permission and product policy allow it.
- Add handoff reason and preserve conversation-to-case links.

Acceptance criteria:

- Assignment changes preserve actor/time history.
- Conversation state and Case status remain separate.
- Handoff never creates a duplicate Case due to repeated button clicks/webhook delivery.

### Phase 19-VC.14 — Shared Service Templates and Composer UX

**Goal:** Improve agent speed without duplicating MarketingAutomation.

Tasks:

- Add one-to-one service snippets/templates with a validated placeholder schema.
- Add preview and channel-specific message validation.
- Distinguish local snippets from provider-approved WhatsApp templates.
- Provide attachment controls, character/segment hints if reliable and confirmation for potentially sensitive messages.
- Establish a documented API so MarketingAutomation can reuse the transport layer without delegating campaign ownership.

Acceptance criteria:

- Templates cannot inject arbitrary HTML/scripts or unauthorized CRM fields.
- The module does not create a competing campaign/journey entity model.
- All send paths pass through the same policy gate.

### Phase 19-VC.15 — Recording and Secure Media Handling

**Goal:** Make recordings and message media available safely.

Tasks:

- Add provider recording callbacks/lookups for adapters that support them.
- Fetch media asynchronously into private storage only when configured, or proxy access through the authorized provider adapter.
- Validate remote URL destinations to prevent SSRF and require safe MIME/size checks.
- Add playback/download authorization, retention, deletion and audit records.
- Add recording-notice/consent configuration and visible recording metadata.

Acceptance criteria:

- Unauthorized users cannot access media by guessing an ID or URL.
- Provider tokens are not exposed to the browser.
- Recording is not enabled by default without explicit configured policy.

### Phase 19-VC.16 — Transcription and AI Enrichment

**Goal:** Add optional transcription and AI features by reusing `AIAgents`.

Tasks:

- Add job interface for transcription or provider transcript retrieval.
- Add transcript segments with offsets/speaker metadata when available.
- Add opt-in summary/topic/action extraction using existing AI capabilities.
- Apply source access checks, content minimization, redaction, review status and retention policy.
- Offer AI summary/suggested reply as draft-only until an authorized user approves it.

Acceptance criteria:

- AI processing can be disabled by provider/channel/recording class.
- AI cannot send messages or mutate unrelated records without a separate approved tool and policy.
- Provenance and review state are visible to authorized users.

### Phase 19-VC.17 — CRM Panels, Portal and Customer Success Integration

**Goal:** Surface communication history in the right customer context.

Tasks:

- Add optional Communications panels to supported Account, Contact, Lead, Opportunity and Case views through existing layout/metadata conventions.
- Integrate allowed conversation summaries/touchpoints with `CustomerSuccess` using stable events/APIs.
- Extend Portal only for explicit supported customer-facing use cases with portal ACL and internal-note exclusion.
- Ensure no duplicate Activities are created when an event is consumed by multiple modules.
- Use lazy loading for message timelines, recordings and transcripts.

Acceptance criteria:

- CRM panels are record-ACL aware.
- Portal cannot read internal notes, staff-only conversations or another customer's records.
- CustomerSuccess receives permitted activity signals without becoming an owner of messaging data.

### Phase 19-VC.18 — Administration, Provider Health and Operations

**Goal:** Make the feature operable after deployment.

Tasks:

- Complete provider setup/edit/disable pages and credential-rotation flow.
- Add health check and safe diagnostics.
- Add webhook event backlog, dead-letter and authorized replay UI/commands.
- Add queue depth, retry and provider failure metrics.
- Add retention configuration, recording/transcription toggles and channel feature flags.
- Document provider onboarding, call routing, webhook setup, sandbox recipient allowlists, and incident response.

Acceptance criteria:

- Admin can diagnose provider/configuration problems without seeing secret material.
- Disabling a provider safely prevents new operations and exposes pending work state.
- Failed events can be replayed without duplicated call/message records.

### Phase 19-VC.19 — Reporting and Analytics

**Goal:** Provide accurate communication KPIs.

Tasks:

- Implement calls by outcome/direction/team/period.
- Implement message volume, delivery/failure and provider reliability reports.
- Implement conversation backlog, unassigned count, first response and handling-time metrics where event data supports them.
- Integrate existing Reports/Dashboard instead of building a competing analytics engine.
- Document all metric definitions, time zones and data caveats.

Acceptance criteria:

- Metrics match persisted event history on test fixtures.
- Reports enforce ACL and avoid leaking restricted message bodies.
- Provider acceptance is never mislabeled as end-user delivery.

### Phase 19-VC.20 — Security, Resilience and Compatibility Hardening

**Goal:** Validate difficult failure/security cases.

Tasks:

- Test invalid signatures, body tampering, replayed callbacks, oversized payloads, malicious media URLs and provider credential leakage.
- Test concurrent callbacks, out-of-order statuses, provider outages, slow API responses and worker restart recovery.
- Verify channel consent, WhatsApp template/window policy, SMS opt-outs and queue-time rechecks.
- Test ACL for records, notifications, recordings, transcripts, exports and portal views.
- Review DB indexes/queries, rate limits, queue pressure, logging and retention jobs.
- Check current SDK/API compatibility and pin supported provider API versions where applicable.

Acceptance criteria:

- No known critical/high-severity security defect remains open at release.
- Replayed/out-of-order provider callbacks do not duplicate side effects or regress terminal states incorrectly.
- Automated tests do not send real calls/messages.

### Phase 19-VC.21 — End-to-End QA and Release Readiness

**Goal:** Deliver a supportable first release.

Tasks:

- Run lint/type checks/unit tests and integration/E2E suites using existing scripts after verifying their safety.
- Test the fake-provider vertical slice from click-to-call/message to callback, timeline, ACL, and reporting.
- Perform a controlled provider sandbox test only if explicit test credentials and allowlisted recipients are already configured.
- Update OpenAPI, developer/admin documentation, setup instructions, provider support matrix and known limitations.
- Review every migration, feature flag, queue behavior and rollback/disable procedure.
- Record unsupported features and provider-specific caveats honestly.

Acceptance criteria:

- A fresh developer setup can run the fake-provider scenario without external side effects.
- At least one selected provider adapter has a documented, tested end-to-end happy path if sandbox credentials are available.
- If credentials are unavailable, adapter contract tests and explicit limitations are documented; no false claim of live provider validation is made.
- All checks and skipped checks are reported accurately.

---

## 18. Definition of Done

The module is complete for the selected release scope only when all relevant statements are true:

- [ ] `VoiceCommunications` is registered with no `Ua` prefix and follows repository conventions.
- [ ] Existing core services and modules are reused instead of duplicated.
- [ ] Provider adapter contracts and capabilities are explicit and tested.
- [ ] Provider credentials are stored safely and masked from all public/admin read responses.
- [ ] Provider webhooks are authenticated, validated, idempotent and operationally replayable.
- [ ] Calls are logged once and linked to the correct Activity/CRM record under ACL.
- [ ] Messaging uses a durable send path and accurate provider status mapping.
- [ ] Consent/suppression and channel-specific rules are checked before dispatch and during retries.
- [ ] WhatsApp sends respect current provider/template/window rules and opt-in requirements.
- [ ] Internal notes cannot escape to external channels or portal users.
- [ ] Conversations, media, transcripts and notifications enforce record and field permissions.
- [ ] ServiceDesk handoff uses its API and does not duplicate Case entities.
- [ ] AIAgents enrichment is optional, provenance-aware and unable to bypass user approval/policy.
- [ ] Recordings/transcripts are not enabled without explicit policy and retention settings.
- [ ] Queue retry, uncertain outcomes, dead-letter handling and provider disablement are tested.
- [ ] Reports define metrics precisely and enforce ACL.
- [ ] OpenAPI, admin docs, provider setup, privacy/retention and operations docs are updated.
- [ ] Tests use fake providers by default and do not send real customer communications.
- [ ] No additional test database is created; `AGENTS.MD` database rules are followed.
- [ ] Final report states verified outcomes, checks run, skipped checks, supported capabilities and known limitations.

---

## 19. Coding-Agent Execution Instructions

1. Read `PLAN.md` and `AGENTS.MD` first, then inspect the actual repository structure and neighboring modules.
2. Start with **Phase 19-VC.0 only**. Deliver the repository audit and feature contract before implementing provider-specific code.
3. Implement one sub-phase at a time. Do not generate all provider adapters, UI and schemas in one large change.
4. Before choosing a provider SDK, check installed dependencies, current provider docs and the repository's package manager/lockfile. Do not add multiple SDKs without a concrete scope.
5. Do not create modules or files named `UaTwilio`, `UaWhatsapp`, `UaVoipIntegration`, or `UaOmnichannel`. They are not the naming convention for this NestJS project. Provider adapters belong inside `VoiceCommunications` unless a future explicit architecture decision says otherwise.
6. Do not copy EspoCRM PHP source or upstream UI assets. Implement the required behavior independently in TypeScript/React.
7. Do not call real phone numbers, send real SMS/WhatsApp messages, or enable call recording during automated tests. Use fake adapters and provider sandboxes with allowlisted test destinations only when explicitly configured.
8. Never use unverified AI output to send external messages automatically. Human review is the default for suggested content.
9. Before each database-backed test, inspect the command and its hooks. Use the configured existing project database for safe, targeted checks only. Do not create new test databases, shadow databases, schemas, containers or volumes.
10. Review all diffs for leaked secrets, customer data, unsafe media fetching, missing ACL, accidental provider calls, unrelated refactors and generated artifacts.
11. Report progress as a factual summary of the specific sub-phase completed, tests actually run, checks skipped, and current limitations.

---

## 20. Final Acceptance Scenario

The selected first release should demonstrate the following safe end-to-end flow with a fake provider (and with one supported real provider only when sandbox credentials are configured):

1. An authorized user opens a Contact with a valid phone number and clicks **Call**.
2. The backend validates permission and provider availability, creates a call session, and sends an initiation request through the selected adapter.
3. The fake/provider callback changes the call state; the existing Call Activity is created or updated exactly once.
4. An inbound simulated call from a known phone number creates a single event, resolves the authorized Contact and displays the incoming-call panel only to the intended user/team.
5. The agent records a note and creates a follow-up Task using the existing Activities service.
6. The agent sends an SMS from the Contact panel; the consent and sender policies are checked and the UI shows queued/sent/delivered/failure states based only on actual simulated callbacks.
7. A duplicate inbound messaging webhook does not create a duplicate message or notification.
8. A WhatsApp free-form send outside the allowed service window is blocked and the UI explains that an approved template is required; a valid approved-template fixture can pass validation.
9. A conversation can be linked to a ServiceDesk Case through the ServiceDesk contract without duplicating the Case or confusing conversation and Case statuses.
10. An authorized user can request an AI draft summary; the result is labeled as AI-generated and remains a draft until reviewed.
11. An unauthorized user cannot view the conversation body, call recording, transcript or linked restricted CRM record, even with a guessed resource ID.
12. Logs contain correlation IDs and safe error codes but not API secrets, message bodies or full signed webhook payloads.
13. All integration tests use a fake provider by default, create identifiable test data, and clean only the data they created.

If the repository is missing any prerequisite platform feature, record the dependency and narrow the first release to the verified capabilities rather than faking success or duplicating the shared platform.
