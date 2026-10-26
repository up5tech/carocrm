# PLAN — Phase 19: Omnichannel (`Omnichannel`)

> **Status:** Planned  
> **Parent roadmap:** `PLAN.md` — Advanced CRM Domains  
> **Canonical module name:** `Omnichannel`  
> **NestJS module class:** `OmnichannelModule`  
> **Module key / frontend slug:** `omnichannel`  
> **Suggested frontend route:** `/omnichannel` (follow the application's routing conventions)  
> **Naming rule:** Do not add the `Ua` prefix to the module, class, routes, migration names, events, configuration keys, or documentation identifiers.  
> **Runtime:** Existing NestJS / TypeScript backend and existing React SPA  
> **Persistence:** Existing PostgreSQL and the repository's established SQL abstraction (Kysely unless the repository deliberately uses another approach)  
> **Architecture:** Modular monolith; provider-neutral, event-driven, metadata/ACL-aware  
> **Implementation principle:** Audit the real repository first. Reuse completed modules and shared platform services rather than duplicating them.

---

## 0. Instructions for the Coding Agent

Read the following before making code or schema changes:

1. `AGENTS.MD`
2. `PLAN.md`
3. `PLAN_Phase_19_Voice_Communications.md`
4. `PLAN_Phase_19_ServiceDesk.md`
5. `PLAN_Phase_19_Marketing_Automation.md`
6. `PLAN_Phase_19_Advanced_Integrations.md`
7. `PLAN_Phase_19_AI_Agents.md`
8. `PLAN_Phase_19_CRM_Chat.md`
9. Existing Portal, Activities, Email, Attachments, Notifications, Jobs, ACL, Search, Reporting, Workflow/BPM, consent, and module-registration implementations.

This plan expresses intended behavior. It does not prove that every dependency or channel connector exists. Start with **Phase 19-OM.0 only**. Inspect the actual repository, schema and migration history, module manifests, existing channel adapters, and test scripts before deciding what to create or extend.

### 0.1 Non-negotiable implementation rules

- The module name is `Omnichannel`; the backend class is `OmnichannelModule`; the module slug is `omnichannel`. **Do not use the `Ua` prefix.**
- Treat this as a clean-room, project-specific implementation. Use public documentation to establish supported channel behavior. Do not copy EspoCRM or third-party source code, UI assets, translations, icons, or branding unless the applicable license clearly permits the exact use.
- Preserve the current modular-monolith architecture. Do not introduce microservices or a second queue, event bus, ORM, ACL engine, or metadata system for this module.
- **Do not duplicate existing channel transport.** `VoiceCommunications` owns existing voice, SMS/MMS, WhatsApp, call lifecycle, and provider integrations where implemented. Omnichannel should consume its documented capabilities through an adapter/facade contract. If an existing connector is absent or lacks a capability, document the gap and propose the smallest extension to its owning module; do not silently create a second competing connector.
- **Do not duplicate ServiceDesk.** ServiceDesk owns Case/ticket lifecycle, support SLAs, knowledge base behavior, and case-resolution workflows. Omnichannel owns channel conversation continuity, shared inbox experience, identity resolution, assignment/routing for conversations, and handoff to ServiceDesk.
- **Do not duplicate MarketingAutomation.** MarketingAutomation owns campaigns, audience membership, consent for marketing purposes, mass sends, and journeys. Omnichannel is for inbound and one-to-one/agent-managed conversations. It may display a campaign-originated touchpoint and hand a conversation to MarketingAutomation through a contract, but it must not become a second campaign engine.
- **Do not duplicate Portal.** Reuse Portal authentication, account/contact scope, route conventions, and customer-facing UI infrastructure. Add a chat widget or portal conversation feature only where it fits the existing Portal architecture.
- **Do not duplicate AIAgents or CRMChat.** AIAgents owns agent runtime, tools, orchestration, and approvals; CRMChat is the internal CRM assistant. Omnichannel may call AIAgents for controlled reply suggestions, conversation summaries, classification, and authorized automation. Do not create a second AI runtime or expose internal CRMChat as the external customer chat widget.
- Reuse the existing Entity Engine, metadata, ACL, field/record permissions, audit/history, Stream, Activities, Attachments, Notifications, Search, Jobs, Reports, workflow engine, realtime transport, secrets management, and feature-flag/configuration systems when they exist.
- All external input is untrusted. Validate payloads, provider signatures, channel identifiers, message types, attachment metadata, URLs, and user-supplied content.
- Process webhook/event delivery as at-least-once. Persist durable event identity and deduplicate before applying side effects. Use transactions and outbox/inbox patterns where available.
- Do not report message delivery or agent action as successful unless the provider or the relevant domain service provides evidence. Use explicit states such as queued, accepted, sent, delivered, read, failed, or unknown only where the channel actually supports them.
- Channel rules vary and change. At implementation time, re-check current provider documentation, account capabilities, permitted scopes, approval requirements, rate limits, messaging windows, template policies, and regional availability. Do not infer that a social platform exposes a general-purpose business DM API merely because its consumer app supports DMs.
- Never use browser automation, private APIs, credential sharing, scraping, or unofficial endpoints to bypass official provider access restrictions. If a channel cannot be connected through a supported official API, record it as unsupported or integration-blocked instead of faking functionality.
- **Database rules are mandatory.** Follow `AGENTS.MD`. Do not create a new test database, schema, database container, shadow database, per-agent database, or per-run database. Use the already-configured primary project database only for safe, targeted verification when suitable.
- Never reset, truncate, drop, recreate, or broadly delete database data. Review every migration before applying it. Use clearly marked `AGENT_TEST_...` records and clean up only exact records created by the current run.
- Automated tests must not send real customer messages, launch live marketing campaigns, initiate calls, create real tickets for customers, or trigger external side effects. Use fake adapters or provider sandboxes and assert that outbound side effects are intercepted.
- Do not claim any sub-phase is complete until its acceptance criteria and actual verification results have been recorded.

### 0.2 Decisions locked at Phase 19-OM.0

The repository audit (`docs/omnichannel/repository-audit.md`, `docs/omnichannel/capability-matrix.md`)
established that most of the model this plan describes already exists in `VoiceCommunications`,
`ServiceDesk`, `AdvancedIntegrations`, `AIAgents` and the shared platform. The following three
decisions are **binding on every later sub-phase**. A later phase may refine their details, but it
must not reverse them without an explicit, recorded decision.

**D1 — The canonical conversation record is `voice_conversations` (reused, not rebuilt).**

- `OmnichannelConversation` is a **logical name for the existing `voice_conversations` record**, not
  a new table and not a new entity. Omnichannel must not create a second conversation store.
- `OmnichannelMessage` is the existing `voice_messages`; `OmnichannelChannelThread` is
  `voice_conversations.external_thread_id`; `OmnichannelIdentity` is
  `voice_conversation_participants`; `OmnichannelConversationEvent` is `voice_conversation_events`;
  `OmnichannelConnection` is `voice_provider_accounts` + `voice_endpoints`.
- The gaps that remain are **additive** and must be applied as an additive migration to the
  existing tables, owned by `VoiceCommunications`: `priority`, `category`, `language`, `tags`,
  `currentQueueId`, `assignmentVersion`, `lastOutboundAt`/`lastMessageAt`, `snoozedUntil`,
  `closedAt`, `version`; and on participants a provider-identity id distinct from the address,
  `verificationState`, `linkConfidence`/`linkReason`, `lastSeenAt`, `sourceProvenance`, plus a
  uniqueness rule over connection + channel + provider identity.
- `voice_conversations.channel` is currently CHECK-constrained to `('sms','mms','whatsapp')` and
  **voice calls are not conversations** (`voice_call_sessions` is a separate store). Widening the
  channel scope, and representing more than one provider thread per conversation, are explicit OM.1
  and OM.3 design tasks.
- Omnichannel owns the **workspace, multi-channel policy and projection**; `VoiceCommunications`
  owns the **record**. Its contract must be consumed through an exported facade, never by deep
  import.

**D2 — Queues and routing are owned by `ServiceDesk` and extended there.**

- `OmnichannelQueue` is the existing `CaseQueue` (+ `QueueMember`); `OmnichannelRoutingRule` is the
  existing `RoutingRule`. Omnichannel must not build a second queue or routing engine.
- The extension belongs to `ServiceDesk`, as an additive change: `CaseQueue`/`RoutingRule` must
  accept conversations (not only Cases), and the rule model must be able to express the conditions
  §3.4 requires — currently the operator allowlist is limited to `equals`/`notEquals`/`in`, routing
  does not consult `BusinessCalendar`, and there is no skills/language/tier model.
- Routing reuse is a **reference**, not a Case dependency: a conversation may occupy a queue
  without a Case existing.
- `ServiceDesk` also owns the Case hand-off contract that OM.17 needs — `Case` currently has no
  `externalId`, no `conversations` relation, and no create-or-link command.

**D3 — Realtime: extend `NotificationEventsService` with a generic publish seam, and give
Omnichannel its own SSE endpoint.**

- The existing single gateway (`GET /api/v1/Notification/stream`) is bound to the `notifications`
  table by a DB trigger and carries only `(userId, id, type)`. It is **not** a general
  conversation-event transport, so §6.3's "do not implement a second realtime gateway" is satisfied
  by *extending* the shared service rather than by reusing it as-is.
- `NotificationEventsService` gains a **generic per-user publish seam** (an explicit, minimal
  payload contract) that Omnichannel and any other module can use. This is a **shared-platform**
  change owned with the platform, not an Omnichannel-local one.
- Omnichannel additionally exposes **its own module-scoped SSE endpoint** for conversation events,
  following the precedent `CRMChat` already sets (`crm-chat-streaming.service.ts`). The endpoint
  is not a second generic gateway: it is a module-scoped stream over the shared publish seam.
- The constraint still holds: **one** platform-level gateway implementation is not duplicated. The
  Omnichannel endpoint is a consumer of the shared seam, and no second `LISTEN/NOTIFY` channel, no
  second connection pool and no second auth path are created.
- Events carry identifiers and minimal safe payloads; the client re-reads permitted data through
  normal APIs. Message content is never broadcast to every connected user.

**Consequence for §2.3 and §5.** The names in §5 are logical domain names, not new tables. Where
§5 says "add", read "extend the existing record additively, in its owning module, with a migration
that preserves existing rows". Where §2.4 says Omnichannel may maintain a conversation projection,
that projection is a **read model over `voice_conversations`**, not a second authoritative store.

---

## 1. Purpose and Product Outcome

Build a first-class **Omnichannel** module so authorized employees can manage customer conversations from supported digital channels in one consistent workspace. It should preserve conversation context when a customer changes channels, identify the correct CRM person/account where possible, route conversations to the right team or agent, and retain a searchable, auditable interaction history.

Omnichannel is a **conversation coordination and agent-workspace layer**, not a replacement for the modules that transport messages, run campaigns, own support tickets, or execute AI agents.

### 1.1 Business outcomes

At completion, authorized users should be able to:

1. View inbound customer conversations from configured and officially supported channels in one shared inbox.
2. Reply through the correct original channel when provider rules and conversation state permit it.
3. See the customer's matched CRM identity and only those Accounts, Contacts, Leads, Sales, CustomerSuccess, Projects, and ServiceDesk records the current user is permitted to access.
4. Preserve a canonical conversation timeline across channel handoffs, while retaining the channel-specific message/thread IDs and delivery states.
5. Assign a conversation to a team, queue, or individual; transfer ownership with a recorded reason; and prevent conflicting simultaneous ownership.
6. Support queue routing using explicit skills, channel support, business hours, workload/capacity, priority, language, customer tier, and escalation rules where data is available.
7. Allow agents to add internal notes, labels, canned replies, follow-up reminders, and permitted attachments without accidentally exposing internal-only content to customers.
8. Embed a website/Portal chat entry point and deliver customer messages to the shared agent workspace when the website chat capability is included and enabled.
9. Integrate WhatsApp Business, SMS/MMS, voice-call context, email, Messenger, Instagram, Telegram, and other channels only through current supported adapters and explicit feature availability. Not all channel connectors are required for the first release.
10. Hand off a conversation to ServiceDesk by linking it to an existing Case or asking ServiceDesk to create one through its public domain contract.
11. Reuse VoiceCommunications for voice/SMS/WhatsApp transport and call details when available; reuse MarketingAutomation for campaign origin and consent; and reuse AIAgents for approved AI assistance.
12. Measure message volume, first response time, response-time distribution, queue backlog, assignment load, handoffs, channel status, and customer satisfaction where supporting data exists.
13. Apply channel-specific consent, opt-out, permitted-contact windows, template rules, privacy controls, and retention policies before outbound communication.
14. Maintain reliable event processing and transparent troubleshooting for webhooks, delivery failures, retries, and provider disconnections.

### 1.2 Product principles

- **One conversation model, multiple transports:** normalize common interaction fields, but preserve native channel semantics and IDs.
- **One customer identity, multiple channel identities:** a phone number, social-scoped ID, email address, web chat session, and CRM contact are not automatically the same person without adequate evidence.
- **Conversation continuity without false merging:** cross-channel messages may be grouped under a customer interaction view, but separate provider conversations must remain traceable and may need to remain separate canonical conversations.
- **Least privilege by default:** CRM data, conversation content, attachments, internal notes, and exports enforce server-side authorization.
- **No public/internal ambiguity:** internal notes and private attachments are separate types; the outbound send path must reject them.
- **Provider-neutral business logic:** provider SDK types, tokens, error codes, and statuses stay behind adapters.
- **Visible uncertainty:** show an unmatched/ambiguous contact state rather than guessing identity.
- **Safe retries:** retrying webhook processing or outgoing send commands must not duplicate customer messages or domain side effects where the provider supports idempotency or reconciliation.
- **Customer context, not surveillance:** collect only the identifiers and event details required for service operations, with configurable retention and access controls.
- **Incremental channel rollout:** start with a reliable shared conversation model and a small number of supported channels; add channels only after official API and account-access feasibility is verified.

---

## 2. Scope and Boundaries

### 2.1 In scope

- Canonical conversation model and customer/participant identities.
- Cross-channel inbox and agent workspace.
- Channel adapter contract and connector capability discovery.
- Inbound message normalization and outbound message command orchestration.
- Contact/account identity matching, manual linking, and conflict review.
- Conversation state, labels, internal notes, assignments, queues, ownership locks, transfers, and routing.
- Website/Portal live chat connector/widget where the shared Portal infrastructure can support it.
- Integration with existing VoiceCommunications adapters for voice, SMS/MMS, and WhatsApp capabilities already present.
- Additional official social messaging adapters only after explicit feasibility checks, starting with Meta Messenger/Instagram if permissions and app review are available.
- Optional email conversation integration if an existing shared email ingestion capability exists or is implemented by its owning module.
- Reuse of consent/suppression policies, message templates, files, jobs, notifications, and realtime updates.
- Handoff to ServiceDesk and contextual links into other completed CRM modules.
- Agent response suggestions, summarization, classification, and approved workflow delegation through AIAgents.
- Operational reports, message/event audit, retention, provider health, and administration.

### 2.2 Explicit non-goals

- A second provider integration framework when AdvancedIntegrations or VoiceCommunications already provides the relevant contract.
- A second SMS, WhatsApp, telephony, or recording subsystem.
- A mass-marketing campaign sender, marketing journey builder, marketing contact list manager, or replacement for MarketingAutomation.
- A second ticketing, SLA, knowledge-base, or Case lifecycle implementation.
- A second customer portal identity/authentication system.
- An internal employee collaboration chat product intended to replace Slack, Teams, or CRMChat.
- A second AI runtime, LLM gateway, long-term AI memory subsystem, or prompt registry.
- General-purpose social media publishing, content scheduling, comment moderation, or social listening unless separately approved as future scope.
- Unsupported scraping or unofficial private APIs for consumer messaging platforms.
- Automatic identity merges, silent transcript mutation, or irreversible deletion without an authorized retention/deletion workflow.
- A full omnichannel contact-center telephony engine; use VoiceCommunications for provider-controlled telephony and call signaling.

### 2.3 Ownership matrix

| Capability | Owning module | Omnichannel responsibility |
|---|---|---|
| Shared conversation inbox and cross-channel context | `Omnichannel` | Primary owner of the **workspace and multi-channel policy** |
| Canonical conversation, message, participant, conversation-event and connection **records** | `VoiceCommunications` (`voice_conversations`, `voice_messages`, `voice_conversation_participants`, `voice_conversation_events`, `voice_provider_accounts`) | **Consume** through an exported facade (decision D1). Omnichannel owns the read/projection model and the workspace |
| Voice call, SMS/MMS, WhatsApp provider connection and delivery mechanics | `VoiceCommunications` | Consume and normalize supported events; request sends through its contract |
| Queues, routing rules, assignment strategies and workload | `ServiceDesk` (`CaseQueue`, `QueueMember`, `RoutingRule`) | **Consume and extend in ServiceDesk** (decision D2). Omnichannel owns conversation-facing policy, not the engine |
| Case, ticket lifecycle, support SLA, resolution and case-specific public/internal updates | `ServiceDesk` | Link/hand off conversation; do not duplicate case business rules |
| Campaigns, target audiences, marketing journeys, mass email and marketing consent | `MarketingAutomation` | Show campaign source metadata; never start bulk marketing from agent reply controls |
| Customer-facing portal login and account/contact authorization | `Portal` | Add conversation UI within existing authentication and scope |
| AI planning, tools, execution runtime, approvals and run trace | `AIAgents` | Submit typed tasks; render run progress; enforce user policy and explicit send approval |
| Internal AI-assisted CRM chat | `CRMChat` | Separate product experience; not the customer-facing web chat |
| Shared OAuth/connector/secret/HTTP integration infrastructure, if implemented | `AdvancedIntegrations` | Reuse connector lifecycle primitives without duplicating credentials or sync engine |
| Realtime publish seam | CRM Kernel (`NotificationEventsService`) | Extend the shared seam; Omnichannel adds a module-scoped SSE endpoint over it (decision D3) |
| CRM Contact, Account, Lead, User, Team, Activities, Files, Audit, Notifications, Jobs | CRM Kernel / existing owners | Reference and reuse |
| Business-hours and agent queue SLA related to support cases | `ServiceDesk` if already modeled | Reuse its policy for linked cases; do not invent a competing Case SLA |
| Conversation response analytics | `Omnichannel` | Own conversation-level metrics; do not replace ServiceDesk's case metrics |

### 2.4 Canonical integration rule

Before adding any new entity or service, inspect the current implementation. If VoiceCommunications already stores the message or call as a domain record, Omnichannel should reference that record through a stable ID and canonical adapter/event contract. Do not copy the entire provider payload or create a second authoritative status for the same outbound message. Omnichannel may maintain a conversation projection and normalized message index for workspace queries, but it must define reconciliation and source-of-truth ownership explicitly.

---

## 3. Functional Requirements

### 3.1 Unified agent inbox

The workspace should provide:

- Inbox views: My Conversations, Unassigned, Team Queue, All Permitted, Waiting on Customer, Waiting on Agent, Snoozed, and Closed.
- Filters for channel, team, assignee, queue, state, priority, tag, language, customer/account, time range, unread status, last message direction, and SLA indicator where appropriate.
- A conversation list with customer identity, channel icon/name, latest message excerpt, timestamp, unread count, assignment, priority, status, and linked Case indicator.
- A conversation details pane with paginated message history, internal notes, attachment previews, delivery statuses, related-record context, assignment actions, and a composer.
- Search across permitted message content and customer identity; ACL must be applied before returning results.
- Keyboard-accessible navigation and standard CRM responsive behavior.
- Realtime updates for new messages, assignment changes, read state, and delivery events using existing WebSocket/SSE infrastructure where available.
- Explicit loading, empty, offline, reconnecting, stale, permission-denied, and channel-error states.
- Optimistic UI only where the command can be reconciled; failed sends must be visibly marked and retryable without accidental duplicates.

### 3.2 Conversation and message lifecycle

- A conversation has a stable internal ID, one or more participant records, channel/thread references, a current status, assignment, queue, last activity timestamp, and linked CRM records.
- Channel-specific message records preserve native external IDs and safe provider metadata.
- Messages distinguish inbound/outbound direction, sender type, content type, text/body, attachment references, provider delivery state, timestamps, and visibility classification.
- Internal notes are not outbound messages and must never be accepted by a provider adapter.
- Edited/deleted messages, reactions, read receipts, typing indicators, and delivery states are optional channel capabilities, not universal fields assumed to work everywhere.
- A customer may start another thread on the same channel; adapter-provided conversation/thread IDs and configurable continuity rules determine whether it belongs to an existing canonical conversation.
- A canonical conversation can link multiple channel threads through explicit `ConversationChannelThread`/equivalent records. A cross-channel identity match alone must not merge message histories.
- State transitions (open, pending, snoozed, resolved/closed, reopened) must be explicit commands with actor, timestamp and reason as appropriate. Do not use ServiceDesk's Case status as a substitute for conversation state.

### 3.3 Customer identity and CRM matching

Identity matching inputs may include:

- Provider account ID + channel-scoped user ID.
- Verified email address, normalized telephone number, or Portal-authenticated user identity.
- Existing channel identity mapping explicitly confirmed by an authorized CRM user.
- Provider-specific contact fields, only when the API legally exposes them and the values are reliable.

Rules:

1. Store channel identities separately from CRM Contacts and Accounts.
2. Normalize telephone numbers using a maintained phone-number library when available; retain original submitted format only where required.
3. Normalize email for matching without changing the user's canonical email value.
4. Treat platform-scoped IDs as opaque identifiers; do not infer a universal identity from an Instagram/Messenger/Telegram user ID.
5. Auto-link only when the match rule is unique and sufficiently reliable; ambiguous matches enter a review state.
6. Allow authorized staff to link/unlink identities, with reason and audit history.
7. Never automatically merge Contact or Account records because two channels share a display name or avatar.
8. Respect ACL while showing matched Contact/Account information. A successful identity match does not grant permission to view all CRM fields.
9. Keep identity resolution queries bounded and indexed; do not perform unbounded scans across CRM contacts for every inbound message.
10. Support an anonymous website chat identity, with optional promotion/linking after the visitor authenticates or provides verified contact details.

### 3.4 Assignment, teams, queues, and routing

**Decision D2 applies: queues and routing live in `ServiceDesk` (`CaseQueue`, `QueueMember`,
`RoutingRule`) and are extended there.** Omnichannel owns the conversation-facing policy and the
workspace, not a second routing engine. The rules below describe the **target capability of the
extended ServiceDesk model**, and every one of them that the current implementation does not
satisfy must be delivered as an additive ServiceDesk change, not as an Omnichannel copy.

- Queues have a name, enabled channels, owning Team, eligible agents, fallback behavior, working-hours policy reference, and optional skill/language tags.
- Assignments support team/queue ownership and individual ownership according to repository authorization conventions.
- Routing rules have a documented order/priority, conditions, destination, fallback, enabled flag, and audit history.
- Supported first-release rules may include channel, business hours, language, customer tier, conversation topic/category, linked Case, and explicit team ownership. **Today the operator allowlist is only `equals`/`notEquals`/`in` and routing does not consult `BusinessCalendar`, so language/tier/skill/capacity conditions and business-hours routing require an additive ServiceDesk change.**
- Round-robin and least-active/least-busy distribution are optional strategies only if agent availability and workload data can be computed reliably. `CaseQueue.lastAssignedUserId`/`lastAssignedAt` already provide the round-robin cursor under a row lock; `leastBusy` already exists.
- Routing must not leak customer content to teams that lack record access.
- Assignment is transactionally guarded against two agents claiming the same unassigned conversation.
- Transfers require permission and should record from/to queues, old/new assignees, timestamp, actor, and optional reason.
- Agent presence indicators are advisory unless the platform already has a dependable presence model; stale browser presence must not imply that an agent can receive unlimited work.
- If no suitable agent is available, leave the conversation visibly queued and notify the appropriate team according to configured rules.
- Agent capacity, concurrent conversation caps, and overload policies must be configurable and fail safely.

**A conversation may occupy a queue without a Case existing.** Queue membership is a reference from
the conversation to the ServiceDesk queue, not a dependency on the Case lifecycle.

### 3.5 Outbound messaging and response composition

- Agents may reply only to an existing permitted conversation and supported recipient/channel thread.
- Before sending, verify channel connection health, thread identity, channel-specific policy/window, opt-out/suppression, permissions, payload size, attachment rules, and provider capabilities.
- Reuse templates/snippets where an owning module offers a suitable one; distinguish service replies from MarketingAutomation campaign templates.
- The composer may support text and supported media. Rich content, buttons, quick replies, templates, edits, reactions, and location payloads are feature-gated by adapter capabilities.
- Store a normalized local send command with an idempotency key before attempting delivery when supported by the application architecture.
- Distinguish local draft, queued, submitted/accepted, sent, delivered, read, failed, unknown, and cancelled states only where semantics are valid. Preserve provider state separately when necessary.
- If a timeout happens after submission and delivery outcome is unknown, reconcile using provider IDs or status checks before repeating the send.
- Retrying an unknown state must require a safe deduplication or reconciliation path; do not blindly resend messages that may already have reached the customer.
- Before any customer-visible send, an AI suggestion remains a draft until a human sends it or a specifically authorized automated policy permits the send.
- Support configurable send limits, rate limiting, quiet hours, and opt-out suppression according to channel and legal requirements.

### 3.6 Website and Portal chat

If audit confirms there is no existing live-chat component, implement a minimal embeddable widget or Portal widget that uses the current portal/session framework and approved public API surface. Requirements:

- A configurable launcher, greeting, offline form, availability state, language, allowed domains, theme tokens, and basic branding independent of EspoCRM upstream assets.
- Secure visitor session creation, session expiry, origin/domain validation, abuse controls, and a short-lived chat token with narrow scope.
- Anonymous visitors may start a conversation only under an explicit policy; rate limits, CAPTCHA or equivalent abuse protection should be considered for public deployments.
- Never place provider keys, CRM API credentials, internal record IDs, or privileged authentication tokens in browser code.
- If visitor authentication exists through Portal, reuse it. The server derives the permitted Account/Contact scope from authenticated Portal identity, never from caller-supplied IDs alone.
- Clearly distinguish public visitor messages from internal agent notes.
- Persist chat history according to retention policy; communicate any retention/recording notice in the UI where required.
- Provide accessibility support, keyboard navigation, visible focus, screen-reader labels, and reduced-motion behavior.
- The widget should reconnect after transient network loss and use a bounded retry/backoff strategy.
- Provide a non-chat contact form fallback when agents or channel services are unavailable.
- If a widget already exists in Portal or another module, reuse and extend it rather than building a second component.

### 3.7 Handoff and domain actions

- An authorized agent may link a conversation to an existing ServiceDesk Case.
- A Case may be created only by invoking the ServiceDesk domain service/API, with an explicit action and permission check. Omnichannel must not insert directly into Case tables.
- A conversation may link to an Account, Contact, Lead, Opportunity, Sales document, Project, CustomerSuccess profile, MarketingAutomation campaign touchpoint, or other CRM object where the relationship is meaningful and permitted.
- Creating a follow-up Task/Call/Meeting must use existing Activity services and normal validation.
- A channel-to-channel transition should preserve the original message timeline and record a handoff event; it must not pretend that a provider thread ID from one channel is valid on another channel.
- When a transfer to ServiceDesk is performed, show whether a Case was created, linked, or not created; do not report a handoff as successful until the target module confirms it.
- Linked domain records do not become accessible solely because they appear in an Omnichannel side panel.

### 3.8 AI-assisted conversations through AIAgents

Optional capabilities may include:

- Summarize the recent conversation and relevant CRM context.
- Classify topic, language, intent, urgency, sentiment, and potential escalation where configured and validated.
- Suggest a reply grounded in visible conversation content and records the current user may access.
- Suggest the next best action or appropriate queue.
- Draft a ServiceDesk Case summary or follow-up activity through existing domain commands.
- Detect likely duplicates or identify missing fields without making irreversible changes.

Controls:

- Use the existing `AIAgents` provider gateway, tool registry, runtime, and audit/run trace.
- AI input may include only the minimum conversation and CRM content needed for the task; redaction and data retention policies apply.
- Provider message content and customer messages are untrusted data, not system instructions. Treat prompt injection inside messages and attachments as a threat.
- An AI reply is a suggestion by default. Sending it requires user action unless a separately enabled and governed autonomous-response policy explicitly permits the exact class of action.
- Automated replies must have a designated owner, limited channels/intents, rate and spend caps, confidence/uncertainty policy, human escalation path, and audit trace.
- No AI capability may override consent, channel policy, ACL, agent approval, or provider restrictions.
- AI-generated classifications should be marked as generated and kept distinct from customer-authored statements.

---

## 4. Supported Channels and Connector Strategy

### 4.1 General strategy

Implement a provider-neutral channel adapter contract and feature-capability registry, then connect only channels for which the product has valid credentials, account eligibility, official API access, and a test plan. Channel availability is determined by configuration plus a capability/health check, not hard-coded assumptions.

**Recommended initial order:**

1. Internal canonical conversation/message model and adapter contract.
2. Website/Portal chat using the existing Portal architecture, if no suitable component exists.
3. Reuse existing WhatsApp/SMS/MMS integration from `VoiceCommunications` through its documented contract.
4. Add Meta Messenger/Instagram adapters only if current official API permissions, app review, account types, and use cases are eligible.
5. Add email-thread ingestion/reply only through the existing mail integration/service that can safely map messages to threads. Coordinate ownership with ServiceDesk if Email-to-Case already handles shared mailboxes.
6. Add Telegram bot connector if it meets requirements and the official Bot API is suitable; remember that bot capability does not mean a bot can access arbitrary personal conversations.
7. Consider Viber, TikTok, and other regional channels only after a technical feasibility review documents official commercial messaging APIs, approval/partner requirements, supported regions, and applicable policies.

Do not implement every connector in the MVP. The core module must stay useful with one active channel and should degrade gracefully if other providers are absent.

### 4.2 Adapter contract

The adapter contract should express capabilities without leaking any vendor's SDK models. Conceptual methods may include:

```ts
interface OmnichannelAdapter {
  readonly providerKey: string;
  getCapabilities(connectionId: string): Promise<ChannelCapabilities>;
  verifyWebhook(request: IncomingWebhookRequest): Promise<VerifiedWebhookEvent>;
  normalizeInbound(event: VerifiedWebhookEvent): Promise<NormalizedInboundEvent[]>;
  sendMessage(command: OutboundMessageCommand): Promise<ProviderSendResult>;
  getMessageStatus?(providerMessageId: string): Promise<NormalizedDeliveryStatus>;
  downloadMedia?(mediaRef: ProviderMediaRef): Promise<MediaDownloadResult>;
  healthCheck(connectionId: string): Promise<ConnectionHealth>;
}
```

This is illustrative only. Adapt it to existing TypeScript, result/error, validation, dependency-injection, and provider contracts after repository audit. Do not copy this interface verbatim if another shared integration contract already exists.

`ChannelCapabilities` should declare, where relevant:

- Inbound and outbound text support.
- Supported media types and size limits.
- Template-only/active-session restrictions.
- Read receipts, delivery receipts, message edits/deletes, reactions, typing indicators, quick replies, buttons, and supported interactive payloads.
- Webhook signature model, stable event/message IDs, delivery ordering guarantees if documented, replay/reconciliation options, and idempotency support.
- Connection/account eligibility, permissions, region, API version, and known feature constraints.

### 4.3 Channel feasibility gate

Before adding a provider-specific adapter, record in `docs/omnichannel/channel-feasibility.md`:

- Official documentation links and the date checked.
- Exact business account type and permissions/scopes required.
- App review, business verification, partner, billing or regional restrictions.
- Inbound webhook and outbound send capabilities.
- Whether the API supports business-to-customer responses, and under which contact windows or user opt-in requirements.
- Supported message types/media, delivery callbacks, idempotency, rate limits, data retention, deletion, and test environment.
- Which existing module owns credentials, tokens, webhooks, and base transport.
- A go/no-go decision and any provider prerequisites the user must configure.

A connector that has not passed this gate must remain disabled/not implemented. Never make unsupported channels appear production-ready using mocked functionality.

### 4.4 WhatsApp and Meta messaging considerations

- Prefer the existing WhatsApp Business adapter in `VoiceCommunications`; extend that adapter contract where a capability is genuinely missing.
- Persist provider message IDs and status events without creating a competing authoritative delivery state.
- Apply the current provider policy for customer-service windows, approved templates, opt-in, template status, message category, rate limits and regional restrictions. These requirements can change; re-verify them at implementation time.
- For Messenger/Instagram, use official Meta APIs only, request the minimum permissions, handle app review and supported professional/page account rules, and support webhook validation/deduplication.
- Never claim that TikTok, Instagram, Messenger, Viber or Telegram can expose all private messages. Connector scope must match documented and granted capabilities.

### 4.5 Email channel considerations

- Reuse the platform's existing email connection/inbound processing. Do not create an alternative SMTP/mailbox polling service if one already exists.
- Respect email threading headers and provider conversation IDs, sanitize HTML, strip unsafe content, and treat links/attachments as untrusted.
- Coordinate with ServiceDesk to avoid two independent handlers creating duplicate Cases or duplicate conversation threads from one support email.
- Separate customer-service reply semantics from MarketingAutomation campaigns, suppression, and bulk-send workflows.

---

## 5. Domain Model and Data Design

The following entities/tables are logical requirements, not a mandate to create every table. The repository audit must map them onto its existing Entity Engine and persistence conventions.

### 5.1 `OmnichannelConnection` (or equivalent)

**Decision D1 applies: this is the existing `voice_provider_accounts` (+`voice_endpoints`), extended
additively.** It already carries provider key, account key, channel, status, enabled, credential
reference, health status and last-validated time; `voice_endpoints` carries the address-level
identity with its own unique constraints.

Fields may include:

- `id`, `name`, `providerKey`, `channelType`, `status`, `enabled`.
- `credentialReference` or a secure secret-store reference, never raw secrets in ordinary rows or logs.
- `providerAccountId`, `providerBusinessId`, `phoneNumberId`, `pageId`, `mailboxId`, or other provider-specific IDs stored in a capability-specific configuration object with schema validation.
- `capabilitiesJson` / normalized capability data, API version, last health-check time, health status, connected actor, and last successful event time.
- Configuration version, created/updated metadata, and audit references.

Secrets and access/refresh tokens must use the existing secrets facility or a reviewed encrypted-at-rest mechanism. Connection configuration updates must be audited. A credential rotation must not destroy message history.

### 5.2 `OmnichannelConversation`

**Decision D1 applies: this is the existing `voice_conversations` record, extended additively — not a
new table and not a new entity.** The field list below is the *target* state of the existing table;
the audit found it currently carries `account_key`, `channel`, `external_thread_id`, `status`,
`subject`, `assigned_user_id`, `assigned_team_id`, `unread_count`, `last_activity_at`,
`last_inbound_at`, `related_entity_type`, `related_entity_id`, `case_id` and `archived`.

Fields to add (additive migration, existing rows preserved):

- `id`, human-readable conversation number if the platform supports sequence IDs, `status`, `priority`, `category`, `language`, `tags`.
- `primaryContactId` / `primaryLeadId` references or the repository's link table pattern; do not duplicate Contact identity data.
- `accountId` when explicitly linked and authorized.
- `currentQueueId`, `assignedUserId`, `assignedTeamId`, `assignmentVersion`, `lastMessageAt`, `lastInboundAt`, `lastOutboundAt`, `unreadCount`/projection state, `snoozedUntil`, `closedAt`.
- `source`/origin, optional campaign/touchpoint reference, `linkedCaseId`, and other related-entity links through safe generic relationship conventions.
- `version`, `createdAt`, `updatedAt`, and audit fields.

Notes that constrain the design:

- The existing `status` enum (`open | pending_customer | pending_internal | resolved | closed |
  spam`) is deliberately **separate** from Case status, and `voice_conversations.case_id` is a
  reference: conversation status never mutates Case status.
- `channel` is currently CHECK-constrained to `('sms','mms','whatsapp')`. Widening it (for example
  with an email or web-chat value) is an explicit migration task, and it must not widen
  `voice_call_sessions` semantics — **voice calls are not conversations**.
- `version` is required for the optimistic-concurrency guard on assignment and status changes.

Conversation state is separate from Case state. A conversation may be closed while a Case remains open or vice versa; the UI must display and explain this explicitly.

### 5.3 `OmnichannelChannelThread`

**Decision D1 applies: today the thread is `voice_conversations.external_thread_id` — one provider
thread per conversation.** The target state below (N provider threads → 1 canonical conversation)
is the explicit design gap identified by the audit; representing it requires a dedicated thread
record or an additive thread reference on `voice_conversations`, owned by `VoiceCommunications`.
Do not create a second conversation store to hold it.

Represents one provider-side thread or customer session linked to a canonical conversation:

- `id`, `conversationId`, `connectionId`, `channelType`, `providerThreadId`, `providerRecipientId` (opaque/sensitive), `threadStatus`, `lastProviderActivityAt`, supported capabilities snapshot, and metadata needed for safe replies.
- Unique constraints on connection/provider thread ID when available.
- Do not use a phone number, social display name, or public username as a universal provider thread key.

### 5.4 `OmnichannelIdentity`

**Decision D1 applies: this is the existing `voice_conversation_participants`, extended
additively.** It already carries `address`, `role`, `entity_type`, `entity_id`, `display_name` and
`consent_status`, unique per `(conversation_id, address, role)`. The audit found the **provider
identity is currently the address itself** — the fields below are what must be added so that
cross-channel identity matching has an evidence model.

Stores a channel-scoped identity, not a full CRM person record:

- `id`, `channelType`, `connectionId`, `providerIdentityId`, optional display name/avatar reference, normalized contact hints, verification state, linked CRM entity type/ID, link confidence/reason, last seen timestamp, and source provenance.
- Unique index over provider connection + channel + provider identity ID, where semantics support uniqueness.
- Values must be access-controlled and retained only as needed; avoid using contact hints to infer identity beyond established policy.

### 5.5 `OmnichannelMessage`

**Decision D1 applies: this is the existing `voice_messages`, extended additively.** It already
carries the plan's state enum (`draft|queued|submitted|sent|delivered|read|failed|undelivered|
unknown`), direction, `is_internal_note`, provider message ID, idempotency key, and attachment
references. Note that the schema already enforces that an internal note **cannot** carry a
provider message ID — keep that guarantee.

Normalized message index/content record may include:

- `id`, `conversationId`, `channelThreadId`, `providerMessageId`, `idempotencyKey`, direction, actor type, sender identity/user, content type, safe text/body, rich-content structured payload, attachment references, reply/quote reference, timestamps, and normalized provider status.
- `visibility`: `customer` or `internal`; internal notes should preferably use a distinct entity type/table/API path if it reduces risk of accidental disclosure.
- Provider payload pointer or minimal safe metadata; avoid retaining full raw webhook payload indefinitely.
- Unique constraint on connection + provider message ID, where provider IDs are stable.
- Message revision/edit metadata only for channels that support it and only when lawful/useful.
- Content must be escaped/sanitized for frontend rendering; HTML must not be trusted.

### 5.6 `OmnichannelAssignmentHistory` and `OmnichannelConversationEvent`

**Decision D1 applies: this is the existing `voice_conversation_events`, extended additively.** It
is already an append-only conversation-event log (assignment, status change, case link) with actor
type, from/to values and detail.

Keep an append-oriented history of:

- Queue and agent assignment changes.
- Transfers, claims, releases, priority/state transitions, snooze/resume, and explicit merge/split operations where supported.
- Message received/sent/delivery updates, identity link changes, Case handoffs, AI suggestions used/discarded, and relevant customer-visible or internal events.
- Actor, timestamp, reason, correlation/run ID, and safe before/after values.

Do not use the event log as a way to bypass the normal audit service. Integrate with the platform's audit system or document why a domain event table is needed in addition to it.

### 5.7 `OmnichannelQueue` and `OmnichannelRoutingRule`

**Decision D2 applies: these are the existing `ServiceDesk` records — `CaseQueue` (+`QueueMember`)
and `RoutingRule` — extended additively in ServiceDesk. Omnichannel must not create
`OmnichannelQueue` or `OmnichannelRoutingRule` as new entities.**

What already exists and is reused: `CaseQueue` carries `code`, `strategy`
(`manual|roundRobin|leastBusy`), `fallbackBehavior` (`unassigned|fallbackOwner`), `defaultTeamId`,
`defaultAssignedUserId`, `sortOrder` and the server-owned round-robin cursor
`lastAssignedUserId`/`lastAssignedAt`; `QueueMember` carries `queueId`, `userId`, `isActive`,
`priority` with a unique `(queueId, userId)`; `RoutingRule` carries validated `conditions`,
`queueId`/`teamId`/`userId`, `strategy`, `fallbackBehavior`, `sortOrder`, `isActive`; and
`CaseAssignment` is the durable audit row with a unique `idempotencyKey`.

The extension, owned by ServiceDesk:

- `CaseQueue`/`RoutingRule` must accept a **conversation** as the routed object, not only a Case.
  A conversation occupying a queue is a reference — it does not require a Case to exist.
- The rule model must be able to express the conditions §3.4 lists. Today the operator allowlist is
  limited to `equals`/`notEquals`/`in`, so **language, customer tier, skill and capacity conditions
  cannot be expressed**, and routing **does not consult `BusinessCalendar`** — business-hours
  routing needs an additive change, not an Omnichannel copy.
- There is **no skills entity**; teams are the only skill unit today. If §3.4's "explicit skills"
  is in the first release, ServiceDesk must model it.
- Queue configuration entities are ACL-locked (`create:'no', edit:'no'`) — configuration only.

Additional queue fields the target state may need (owner Team, enabled connections/channels, max
concurrency, priority defaults, fallback queue) are added to `CaseQueue` additively.

Routing rule fields may include order, predicate schema, destination type/ID, strategy, fallback, enabled state, validation diagnostics, effective dates, and audit metadata.

Do not execute arbitrary JavaScript or SQL in routing expressions. Use a bounded declarative predicate model with field/operator allowlists and explicit evaluation budgets.

### 5.8 Webhook and send operation records

**Decision D1 applies: these already exist and are reused — `voice_webhook_events` (durable
inbound receipt, with dedup on `(account_key, dedup_key)`, a signature-verdict column, a redacted
payload, and an authorized admin replay path) and `voice_communication_events` (one normalized
event per receipt, unique on `webhook_event_id`).** The outbound send record is `voice_messages`
itself, with a unique idempotency key and a unique `(account_key, provider_message_id)`.

**Do not create a fifth inbound-webhook inbox.** The repository already has four module-scoped
implementations (`integration_webhook_deliveries`, `signature_webhook_inbox`,
`marketing_provider_webhook_inbox`, `voice_webhook_events`) and no shared abstraction. Omnichannel
reuses the Voice receipt table if it shares the voice transport; if a separate receipt table is
needed, it must be module-scoped and copy the **ESignature** column shape — which is the strongest
in the repo (`dedup_key` unique, `payload_hash`, `content_length`, an explicit
`signature_status ∈ (verified|invalid|not_required)` verdict decided before any payload field is
trusted, an attempt count, and a purge deadline).

If the existing platform lacks suitable shared infrastructure, add minimal durable records for:

- Inbound webhook/event receipt: provider, connection, external event ID, signature verification result, received timestamp, processing status, attempts, and minimal redacted diagnostics.
- Outbound send command: local ID, actor, conversation/thread ID, idempotency key, command status, provider message ID, retry/reconciliation state, and failure category.

Prefer the shared webhook/job/outbox service if already present. The normalized event queue must not store secrets or unredacted payloads by default. Apply retention, access controls, and redaction to provider diagnostics.

**One prerequisite is a one-line change in shared code:** the raw-body `preParsing` hook currently
covers only the ESignature and AdvancedIntegrations webhook prefixes. The Omnichannel (and the
existing voice) webhook prefix must be added before any provider that signs exact bytes can be
verified — a canonical-JSON fallback cannot verify a byte-exact signature.

### 5.9 Indexing and migrations

- Add indexes for conversation status/assignment/queue, `lastMessageAt`, connection/provider-thread ID, connection/provider-message ID, channel identity uniqueness, unread inbox queries, and event idempotency.
- Use cursor/keyset pagination for busy conversation lists and message history where supported by existing API conventions.
- Avoid unbounded JSONB filtering over large tables where a normalized indexed field is required for a core inbox query.
- Use additive migrations with explicit rollback considerations. Do not delete existing VoiceCommunications/ServiceDesk data to normalize the new conversation view.
- Define retention and archival strategy before introducing large-volume raw message or event storage.

---

## 6. Application Architecture and Processing Flows

### 6.1 Inbound processing

Required conceptual flow:

1. Receive the provider webhook, adapter event, or Portal/web chat event.
2. Verify channel signature/authenticity and apply request-size/rate limits.
3. Persist a durable receipt and deduplication identity; acknowledge provider promptly according to its protocol.
4. Normalize only supported fields into a provider-neutral event.
5. Resolve connection, channel thread, and identity using bounded rules.
6. Link to an existing canonical conversation or create a new conversation according to explicit routing/continuity policy.
7. Persist the message or projection update transactionally and emit internal domain events/outbox records.
8. Run routing, notification, unread-state, ServiceDesk-handoff, and AI-suggestion workflows asynchronously where possible.
9. Push safe realtime updates to authorized agent clients.
10. Record processing status and a redacted failure reason; retries must resume safely without duplicating a message or assignment.

If a provider retries a webhook, processing must not duplicate messages. If events arrive out of order, use provider timestamps and delivery semantics carefully; do not let an older status overwrite a newer terminal status unless provider documentation explicitly defines that transition.

### 6.2 Outbound processing

1. Authenticate the staff/Portal actor and verify access to the conversation, connection, channel thread, and recipient.
2. Validate visibility: internal notes are not sendable; customer replies use a customer-visible message command.
3. Check current channel capability, consent/opt-out, customer-service window/template requirements, connection health, recipient status, file policy, and rate limits.
4. Persist a send command with a unique idempotency key and the immutable message content/attachment references being sent.
5. Dispatch through the owning adapter/facade in a background job unless existing response semantics require synchronous provider submission.
6. Persist provider acceptance and message ID; update the UI as submitted/unknown rather than falsely claiming delivery.
7. Consume delivery/read/failure callbacks and reconcile uncertain results where supported.
8. If retry is permitted, reuse the command/idempotency identity and avoid a duplicate side effect. If outcome cannot be reconciled, surface an “unknown—verify before retry” state to the agent.

### 6.3 Realtime updates

**Decision D3 applies.** The platform's only realtime gateway is
`GET /api/v1/Notification/stream`, and it is bound to the `notifications` table by a DB trigger
(`pg_notify` on insert) carrying only `(userId, id, type)`. It is a **notification** transport, not a
conversation-event transport, and the SPA re-reads permitted rows rather than trusting the event
body. So the architecture is:

1. **Extend `NotificationEventsService` with a generic per-user publish seam** — an explicit,
   minimal payload contract that any module can publish to a subscribed user. This is a
   **shared-platform** change; it is not an Omnichannel-local copy, and it is the piece that keeps
   §6.3's "do not implement a second realtime gateway" intact.
2. **Omnichannel adds its own module-scoped SSE endpoint** for conversation events, over that
   shared seam. The precedent exists: `CRMChat` already ships a module-scoped SSE stream
   (`crm-chat-streaming.service.ts`). This endpoint is a *consumer* of the shared seam — it must
   not open a second `LISTEN/NOTIFY` channel, a second database connection pool, or a second
   authentication path.

Rules that still bind:

- Apply per-user or per-team authorization before publishing conversation events. A conversation
  event must not reach a user who may not read that conversation.
- Events should carry identifiers and minimal safe payloads; client fetches current permitted data through normal APIs when needed.
- Resume after reconnect with a cursor/sequence where the architecture supports it; otherwise refresh the current inbox and show missed-event state.
- Avoid broadcasting message content to every connected CRM user.
- The module-scoped endpoint follows the same response discipline the notification stream uses
  (hijacked reply, `text/event-stream`, no buffering, reconnect handling) and must fail closed for
  an unauthenticated or under-scoped subscriber.
- Until the shared seam exists, the agent inbox may continue polling the existing conversation
  list, as `VoiceInboxPage` does today — polling is an acceptable interim, not a permanent design.

### 6.4 Event and job reliability

- Use transactional outbox/inbox patterns where supported by the codebase.
- Every webhook job and outbound command needs stable deduplication semantics.
- Apply exponential backoff with jitter for transient errors, bounded attempts, provider-aware `Retry-After` handling, and dead-letter/review state.
- Do not retry permanent validation, consent, authorization, unsupported-channel, or policy-window failures as if they were transient network errors.
- Preserve enough diagnostics to debug failures without storing full PII or tokens.
- Provide an admin replay operation only with authorization, event idempotency, and a dry-run/preview where replay could create external side effects.

---

## 7. API Contract

Follow the project's existing `/api/v1` routing, authentication, response envelope, error format, validation, pagination, and OpenAPI patterns. The endpoint names below are conceptual examples. The repository audit takes precedence if a different naming convention is already established.

### 7.1 Staff conversation APIs

Potential endpoints:

- `GET /api/v1/omnichannel/conversations` — list conversations the current user may access; supports cursor pagination and validated filters.
- `GET /api/v1/omnichannel/conversations/:id` — details, related record references and permitted summary fields.
- `GET /api/v1/omnichannel/conversations/:id/messages` — paginated message history with visibility filtering.
- `POST /api/v1/omnichannel/conversations/:id/replies` — create and submit a customer-visible reply.
- `POST /api/v1/omnichannel/conversations/:id/notes` — add an internal-only note through a separate authorization path.
- `POST /api/v1/omnichannel/conversations/:id/assign` — claim/assign to a permitted user/queue/team.
- `POST /api/v1/omnichannel/conversations/:id/transfer` — transfer with destination and optional reason.
- `POST /api/v1/omnichannel/conversations/:id/status` — apply a validated conversation-state command.
- `POST /api/v1/omnichannel/conversations/:id/snooze` and `POST /api/v1/omnichannel/conversations/:id/resume`.
- `POST /api/v1/omnichannel/conversations/:id/link-record` — link a permitted CRM record through a supported relation contract.
- `POST /api/v1/omnichannel/conversations/:id/create-case` or `link-case` — invoke ServiceDesk if enabled; do not insert directly into Case persistence.
- `POST /api/v1/omnichannel/conversations/:id/ai-suggestion` — request a permitted AIAgents task; returns suggestion/run reference, not an automatic send.
- `POST /api/v1/omnichannel/conversations/:id/mark-read` — update read state if supported.

### 7.2 Admin and queue APIs

Potential endpoints:

- `GET/POST /api/v1/omnichannel/connections` — list/create channel connection metadata through shared configuration/secrets patterns.
- `POST /api/v1/omnichannel/connections/:id/test` — test connection; do not send live messages.
- `POST /api/v1/omnichannel/connections/:id/enable` and `/disable`.
- `GET/POST/PATCH /api/v1/omnichannel/queues` — manage queues with admin ACL.
- `GET/POST/PATCH /api/v1/omnichannel/routing-rules` — manage validated routing rules.
- `GET /api/v1/omnichannel/operations/events` — inspect permitted webhook processing status and redacted errors.
- `POST /api/v1/omnichannel/operations/events/:id/replay` — controlled replay after checking idempotency and permissions.
- `GET /api/v1/omnichannel/reports/*` — bounded, permission-aware reporting endpoints or reuse generic Reports.

Never return provider tokens/secrets, raw authorization headers, full signature values, unfiltered external payloads, internal exception details, or records outside the current user's ACL.

### 7.3 Webhook endpoints

- Use dedicated connection-aware webhook routes consistent with other integrations.
- Validate provider verification challenges and request signatures using the official documented method.
- Enforce body-size limits, request timeouts, allowlisted event/object types, and replay/deduplication controls.
- Acknowledge quickly after durable receipt if required by provider; perform slower processing asynchronously.
- Do not rely on IP allowlists alone as the only authentication control unless the provider contract explicitly supports and documents that as an additional layer.

---

## 8. Permissions and Security

### 8.1 Roles and access controls

Use existing ACL/role/team systems. Suggested permission dimensions include:

- View permitted conversations.
- View full message content.
- View/download attachments.
- Reply from supported channels.
- Add internal notes.
- Claim/assign/transfer conversations.
- Close/reopen/snooze conversations.
- Link/create ServiceDesk Cases and CRM activities.
- View customer context fields.
- Resolve identity conflicts or link/unlink identities.
- Configure connections, credentials references, queues, routing rules, canned replies, retention, and AI policies.
- Replay failed events, inspect operations logs, export conversations, and perform retention/deletion actions.

Every API, realtime subscription, search, count, export, bulk action, side panel, attachment download, AI tool call, and background job must enforce the appropriate scope. Hiding controls in React is not authorization.

### 8.2 Webhook and provider security

- Verify every provider's official request signature or authentication scheme before parsing/processing event content.
- Prevent replay where protocol supports timestamp/nonces, and always implement idempotent event handling.
- Use HTTPS for externally reachable webhook endpoints and chat widget traffic.
- Store secrets in existing secret management. Encrypt tokens at rest if no platform facility exists, restrict decryption to server-side adapters, and support rotation/revocation.
- Redact secrets, phone numbers, email addresses, access tokens, authorization codes, message bodies, and attachment URLs from logs unless a specific tightly controlled troubleshooting mode is enabled.
- Validate callback URLs and outbound attachment URLs to prevent SSRF; do not fetch arbitrary URLs supplied in customer messages without a secure mediated download path.
- Prevent HTML/script injection by using safe rendering, sanitizing supported rich text and never trusting provider text as HTML.
- Protect public web chat from CSRF/session fixation, origin spoofing, spam, rate abuse, oversized payloads, and unauthenticated file uploads.
- Ensure webhook URL paths do not expose connection secrets or bearer tokens.

### 8.3 Message privacy and retention

- Define retention separately for message content, provider event payloads, attachment bytes, identity hints, analytics aggregates, and audit records.
- Respect applicable data subject access/deletion and business retention obligations; deletion workflows must not erase records that must legally be retained without a deliberate policy decision.
- Support role-based access to conversation exports and attachments.
- Do not use customer conversations to train external models by default. Any provider processing or AI assistance must follow configured data-processing policy and be disclosed where needed.
- Keep cross-channel identity evidence and manual merge/link actions auditable.
- Preserve legal holds where the application has a platform-level legal hold capability; do not invent one if absent without a defined requirement.

### 8.4 Channel policy and consent

- Determine which system is authoritative for each consent type: MarketingAutomation for marketing subscriptions/suppression; VoiceCommunications or the configured channel owner for SMS/WhatsApp transport opt-outs; and applicable provider state for channel-specific restrictions.
- Before sending any customer-visible message, check the effective consent/opt-out/policy state through the owning service. Do not copy consent into an Omnichannel table and allow it to drift as a second source of truth.
- Transactional/support responses and marketing messages are distinct purposes; a support conversation must not become a loophole for marketing outreach.
- Respect channel-specific customer-service windows and approved templates. If a message cannot be sent on that channel, explain the reason and suggest a permitted next step without bypassing the rule.
- Make channel-specific policy failures actionable to staff; do not blindly retry them.

### 8.5 AI safety

- Conversation messages, attachments, URLs, tool results, external profiles and CRM notes are untrusted content that may contain prompt injection.
- AI tools must execute under the authenticated user's effective permissions and must not elevate to service-admin access.
- Do not pass provider credentials, secrets, unrelated conversation content, or all of a Contact's CRM fields to an LLM by default.
- AI suggestions must be labeled as generated. Human confirmation is the default for public responses and domain-changing actions.
- Autonomous reply policies, if later allowed, must be explicitly enabled per channel/intent, have a documented allowlist, confidence/uncertainty gate, message caps, operating hours, cost caps, escalation fallback, and audit trail.
- AI cannot perform bulk marketing sends, override channel windows/consent, or call arbitrary tool endpoints.

---

## 9. Frontend UX and Agent Workspace

### 9.1 Main workspace layout

Use the existing React component system, design tokens, routing, forms, and state-management conventions. Avoid introducing a competing UI framework.

Suggested layout:

1. **Inbox/sidebar:** saved views, team queues, my conversations, unassigned, waiting, snoozed, closed, and counts.
2. **Conversation list:** customer label, channel badge, latest excerpt, unread count, last activity, priority, queue/owner, SLA/response indicator if applicable.
3. **Thread panel:** chronological messages/events, safe attachment preview, reply composer, internal-note mode, canned replies and delivery state.
4. **Customer context panel:** permitted Contact/Account/Lead details, recent Activities, Sales or CustomerSuccess context, and linked ServiceDesk Case; omit unavailable modules gracefully.
5. **Action bar:** assign, transfer, state change, snooze, link record, create/link Case, create follow-up activity, AI suggestion, and permitted channel operations.

### 9.2 Composer rules

- Clearly label customer reply versus internal note; use visually and semantically distinct composer states.
- Require deliberate mode switching and reset/confirm composer mode on channel changes to prevent internal notes from being sent publicly.
- Show the selected channel/thread and relevant provider restrictions.
- Show attachment upload progress and reject unsupported file types/sizes before submission where possible; server validation remains authoritative.
- Show sending, accepted, delivered/read if supported, failed, and unknown states with retry/reconciliation controls.
- Disable send when the connection is disconnected, recipient/thread is unavailable, consent/policy blocks sending, or the current user's permissions do not allow it.
- Confirm if switching conversations would discard a draft; preserve drafts per conversation only according to privacy and persistence rules.
- AI suggested text must be inserted into an editable draft, not sent directly by rendering the suggestion.

### 9.3 Accessibility and internationalization

- Keyboard accessible inbox, thread, modal and composer; visible focus and useful screen-reader labels.
- ARIA live announcements for new messages and delivery failures, without interrupting excessively.
- Respect reduced motion and high-contrast/system theme settings.
- Support Vietnamese and English UI labels using the repository's translation system; provider-delivered text must preserve original language/content.
- Use timezone-aware display and consistent handling of provider timestamps.

---

## 10. Reporting and Observability

### 10.1 Agent/team dashboards

Where data is available, support:

- Open/unassigned conversation backlog.
- Incoming/outgoing volume by channel, queue, team, and period.
- First response time, subsequent response time, and conversation waiting time.
- Conversation handling time and handoff/transfer count.
- Agent workload and concurrency snapshots.
- Reopen/return rate and conversation aging.
- Message delivery failure rate, provider health, webhook backlog, retry count, and unknown send outcomes.
- AI suggestion acceptance/use rate only where collected transparently and appropriately.
- Customer satisfaction as a later optional integration, with ownership determined by ServiceDesk or the relevant survey module.

Do not claim SLA compliance based on message timestamps if there is no authoritative policy/calendar definition. If ServiceDesk owns the SLA for a linked Case, use its data rather than calculating a competing ticket SLA.

### 10.2 Operational monitoring

- Expose connection health, last successful webhook/event time, event backlog, outbox age, delivery failure categories, dead-letter counts, and rate-limit responses.
- Correlate a conversation, normalized message, provider event, job run, and outbound send command using safe correlation IDs.
- Provide alerts for disconnected providers, excessive webhook failures, stale queues, repeated authentication failures, and growing retry backlog.
- Use structured logs and metrics with PII-safe labels. Do not use message text, email, phone number, or provider account ID as high-cardinality metric labels.
- Include redacted error details, retryability, next action, and provider documentation links where stable.

---

## 11. Test Strategy and Acceptance Evidence

### 11.1 Unit tests

Cover at minimum:

- Provider adapter normalization and unknown-event rejection.
- Conversation/thread association and identity matching: exact, ambiguous, unverified, missing, conflicting.
- Idempotent webhook processing for duplicate and out-of-order events.
- Assignment conflict/claim concurrency and routing fallback.
- Conversation-state transition validation.
- Internal-note isolation from every outbound send path and customer transcript API.
- ACL for lists, message fetch, attachments, counts, search, exports, real-time events, and related-record context.
- Consent/policy gate precedence and handling of unavailable consent services.
- Message composer validation, media constraints, and rich-content capability checks.
- Outbound send retry/unknown-result reconciliation to prevent duplicates.
- Public web chat session expiry, domain/origin validation, throttling and token scope.
- AIAgents suggestion policy, prompt-injection-resistant tool boundaries, and mandatory approval behavior.
- Retention and redaction behavior.

### 11.2 Integration/API tests

Use fake provider adapters by default. Validate:

- Inbound webhook accepted only when signature verification passes.
- Repeated webhook deliveries create one normalized message and one set of side effects.
- Staff can send through a fake adapter and see queued/accepted/delivery transitions.
- Provider failure and timeout result in explicit actionable states, without false delivery claims or duplicate resends.
- Agents see only conversations permitted by the existing ACL and team rules.
- An internal note is never present in customer-facing widget/Portal APIs or outgoing provider requests.
- Case handoff invokes ServiceDesk contract and handles unavailable/failure states.
- Voice/SMS/WhatsApp messages flow through VoiceCommunications contract without a duplicate direct provider request from Omnichannel.
- Campaign-origin metadata is displayed without invoking MarketingAutomation bulk-send logic.
- AI suggestions can be requested, reviewed, edited, rejected, and then sent by an authorized user; a suggestion alone never sends.
- Connection disablement prevents further outbound calls and clearly reports pending/unknown send commands.
- Basic keyboard/accessibility and reconnect flows are covered by frontend tests.

### 11.3 Security and resilience tests

- Verify webhook signatures, reject forged requests, test replay/deduplication and body-size limits.
- Test HTML/script injection in messages, links, profile names, and attachment filenames.
- Test SSRF protections for media downloads and preview/URL handling.
- Test public widget origin abuse, token expiry, session fixation and spam/rate limiting.
- Simulate duplicate/out-of-order delivery events, provider throttling, 429/5xx responses, timeouts, network partitions, and worker restarts.
- Verify that logs and diagnostics redact secrets and sensitive message content.
- Confirm migration is additive and does not delete current VoiceCommunications, ServiceDesk, Portal, or CRM records.

### 11.4 Database/testing safety

- Follow `AGENTS.MD` exactly; inspect all test scripts and setup/teardown hooks before running them.
- Do not create any separate test database, schema, container, clone, or shadow database.
- Use unit tests and fake adapters first. For database-backed integration tests, use the already-configured primary database only for safe, targeted checks if the target is known to be a development environment.
- Use unique `AGENT_TEST_` entities and exact-ID cleanup. Do not mutate real customer records.
- Disable real provider credentials in automated tests. CI must not send messages through live channels.

### 11.5 Acceptance criteria

The module is not ready for release until all of the following are true:

- A permitted inbound message can be ingested, deduplicated, mapped to a channel thread, and displayed in the correct agent inbox.
- Staff can claim/assign/transfer a conversation according to ACL and configured queue rules.
- A staff reply uses the existing owning channel adapter and records a truthful send/delivery state.
- Duplicate webhook delivery does not create duplicate messages, repeated notifications, duplicate Cases, or repeated AI runs.
- Internal notes and private attachments are inaccessible through every customer-facing API and channel send path.
- Identity linking is auditable and ambiguous matches are not silently merged.
- Channel-specific policy, opt-out/consent, rate-limit and unsupported-content checks are enforced server-side.
- ServiceDesk handoff and VoiceCommunications integration use stable contracts and degrade gracefully if a dependency is disabled.
- The website/Portal widget, if included, uses current Portal authentication/scope and cannot expose server credentials or privileged CRM APIs.
- The UI explains offline/failed/unknown outcomes and has a recovery path for stale events and provider failures.
- The core inbox remains functional when optional connectors are not configured.
- OpenAPI, metadata, translations, admin docs, operations docs and tests are updated.
- The module has no unresolved critical/high security findings, no known unauthorized data paths, and no prohibited database/test setup.
- Each completed sub-phase has recorded evidence: changed files, migrations, checks run, outcomes, and unresolved limitations.

---

## 12. Documentation and Operational Deliverables

Maintain these project documents as relevant:

- `docs/omnichannel/overview.md` — domain boundaries, user journeys, and relationship to adjacent modules.
- `docs/omnichannel/channel-feasibility.md` — official API feasibility assessment and decision per channel.
- `docs/omnichannel/adapter-contract.md` — adapter responsibilities, capabilities, errors, retries, idempotency, and source-of-truth rules.
- `docs/omnichannel/identity-resolution.md` — matching/linking evidence, ambiguous match process, and audit model.
- `docs/omnichannel/privacy-retention.md` — content/metadata retention, deletion workflows, redaction, and AI provider processing.
- `docs/omnichannel/runbook.md` — connection setup, webhook troubleshooting, stuck events, retries, unknown send status, and provider outage handling.
- `docs/compatibility/omnichannel.md` — documented product behavior references and any compatibility differences.
- OpenAPI documentation, metadata descriptions, translations, release notes, and provider configuration guide.

Do not expose secrets, real customer message content, production identifiers, or screenshots containing private data in documentation.

---

## 13. Definition of Done

A sub-phase is complete only when:

1. Its code and configuration conform to repository conventions.
2. Relevant schema migrations are reviewed and version controlled.
3. API, metadata, ACL, frontend labels, and docs are updated when applicable.
4. Unit tests and targeted integration tests run successfully or any limitation is explicitly recorded.
5. No test database/schema/container or destructive reset behavior was introduced.
6. Provider side effects are disabled or faked during automated tests.
7. Security review confirms permission checks, secret redaction, input validation, and safe error handling.
8. Acceptance criteria for that sub-phase are met and evidence is recorded.
9. The final report distinguishes implemented behavior, provider-dependent behavior, and work deferred to a later phase.

---

## 14. Sub-Phase Roadmap

Execute the phases in order. Do not implement the full module in a single coding-agent pass. After each sub-phase, update `docs/omnichannel/overview.md` or an implementation log, list the actual files changed, run focused checks, and record completion status.

### Phase 19-OM.0 — Repository Audit and Capability Inventory

**Status: COMPLETE.** The audit was performed on `master` at commit `7701d8e` and produced the two
deliverables below. It changed **no code, no migration and no metadata** — documentation only.

**Outcome:** the audit found that most of the model this plan describes already exists. The
canonical conversation, message, participant, event and connection records exist as
`voice_conversations`, `voice_messages`, `voice_conversation_participants`,
`voice_conversation_events` and `voice_provider_accounts` (+`voice_endpoints`); the shared inbox,
composer, assignment, hand-off, WhatsApp template registry, per-channel consent/suppression,
provider health and webhook replay exist under `VoiceCommunications` with **two live provider
adapters** (Twilio for voice/SMS/WhatsApp, Asterisk ARI) plus a simulator; queues and routing exist
as `CaseQueue`/`QueueMember`/`RoutingRule` under `ServiceDesk`; the inbound-email seam exists as
`packages/mail`'s `InboundMailProvider` port; and `AIAgents` provides the run/approval contract.

Three architectural decisions were locked as a result (see §0.2): **D1** reuse `voice_conversations`
as the canonical conversation record; **D2** extend `ServiceDesk`'s `CaseQueue` for queues and
routing; **D3** extend `NotificationEventsService` with a generic publish seam and give
Omnichannel its own module-scoped SSE endpoint over it.

The audit also identified the extensions that later sub-phases depend on, all of which must be
delivered **in their owning module**: export `VoiceInboxService`/`VoiceMessagingService`/the
`VoiceProviderAdapter` interface from the Voice barrel; add the Omnichannel webhook prefix to the
raw-body `preParsing` hook; publish the voice transport as cross-module contracts; add the
`unsupported` error category; add `Case.externalId` + a Case create-or-link command; register a
channel-send tool with `effectClass: 'material_write'`; and extend `ConnectorAdapter` only if
channel transport is routed through `AdvancedIntegrations` rather than through Voice's own adapter.

**Note:** `docs/implementation/voice-communications-audit.md` is **stale** — it states that only a
simulator ships. `docs/modules/voice-communications/providers.md` is the current source of truth.

Goal: Establish what the repository already implements before making architectural decisions.

Tasks:

- Read `AGENTS.MD`, `PLAN.md`, and relevant existing module plans and code.
- Inspect `VoiceCommunications`, `ServiceDesk`, `MarketingAutomation`, `Portal`, `AIAgents`, `CRMChat`, `AdvancedIntegrations`, Activities, Email, attachments, consent/suppression, notification, job, realtime, audit, Search, reporting, Entity Engine, and ACL implementations.
- Determine whether shared inbox, conversations, messages, provider adapter interfaces, webhook receipt/deduplication, queue/routing, chat widget, or channel identity entities already exist.
- Inspect repository migrations, indexes, test commands, Docker/CI scripts, package manager, realtime implementation, and any test setup/teardown hooks.
- Build a capability matrix: existing and reusable, partially implemented, missing, externally blocked, and explicitly out of scope.
- Identify source-of-truth ownership for messages, call/SMS/WhatsApp status, consent, Case lifecycle, campaign events, and AI run records.
- Confirm naming and route conventions; keep `Omnichannel` and `omnichannel` without `Ua`.
- Record missing prerequisites and risks.

Deliverables:

- `docs/omnichannel/repository-audit.md` — written.
- `docs/omnichannel/capability-matrix.md` — written.
- No broad refactor and no destructive migration — honoured; this phase produced documentation only.

Acceptance:

- The audit identifies current authoritative records/services for every channel that already exists. — **Met** (audit §6).
- The agent explains what can be reused directly and what small extension is required. — **Met** (audit §4, §8 — 18 extensions, each owned by its current module).
- No duplicate transport, inbox, Case, campaign engine, Portal auth, or AI runtime is proposed without a documented gap. — **Met** (audit §5, §7 — 22 gaps recorded; §0.2 D1–D3).
- Stop at the end of this phase and report findings before starting Phase 19-OM.1. — **Met.** OM.1 has not been started.

### Phase 19-OM.1 — Feature Contract and Channel Feasibility

**Goal:** Define the first release precisely and prevent assumed provider support.

**Inputs already settled by 19-OM.0 (§0.2):** the canonical conversation record is
`voice_conversations` (D1); queues and routing are `ServiceDesk`'s, extended there (D2); realtime
is the extended `NotificationEventsService` seam plus a module-scoped SSE endpoint (D3). OM.1
**refines** these; it does not re-open them.

Tasks:

- Choose the first channel set based on code audit, credentials, official API access, and realistic test facilities.
- Complete the channel feasibility template for every candidate provider.
- Select the first end-to-end path. The audit narrows this to two credible paths: (a) website/Portal chat into the existing conversation model, reusing `WebToCaseService`'s abuse controls — which requires the anonymous-visitor identity decision; or (b) email-thread ingestion through the existing `packages/mail` seam — which requires the double-processing decision against ServiceDesk's Email-to-Case. Both are decided here, not deferred.
- Define canonical conversation boundaries versus channel-side thread boundaries. **Design task:** today the conversation *is* the thread (`voice_conversations.external_thread_id`, one per conversation) and voice calls are not conversations at all; the target must represent multiple provider threads per canonical conversation.
- Define lifecycle state machine, visibility model, assignment rules, identity confidence requirements, and error taxonomy. The existing `voice_messages` state enum and the 13-category `COMMUNICATION_ERROR_CATEGORIES` are the baseline; only `unsupported` is missing.
- Specify how inbound email interacts with any existing ServiceDesk Email-to-Case pipeline to avoid double processing. **Constraint:** `EmailToCaseService` is manually triggered only, and its marker fields (`caseId`, `streamItemId`, `emailToCaseStatus`) are undeclared raw attrs — Omnichannel must read and honour them, never write a competing marker, and never poll a second mailbox.
- Define explicit non-goals for the first release and list connector features that require provider approval.
- Specify the **anonymous visitor identity** and consent basis for website chat, if that path is chosen. Portal has no anonymous principal today; the plan may not weaken `PortalPolicyService.recordVisible()`.
- Specify the **ServiceDesk hand-off contract** OM.17 depends on: `Case.externalId` (or equivalent), a `Case.conversations` relation, and a create-or-link command — all additive in ServiceDesk.

Deliverables:

- `docs/omnichannel/feature-contract.md`.
- `docs/omnichannel/channel-feasibility.md` — one record per candidate channel.
- Updated channel feasibility and risk log.

Acceptance:

- Every first-release feature has a clear owner and acceptance test.
- No unsupported social messaging capability is represented as a committed feature.
- The first connector path can be tested without sending a real customer message.
- The three OM.0 decisions are carried into the contract unchanged, or a replacement is recorded with an explicit rationale.

### Phase 19-OM.2 — Module Registration and Navigation

**Goal:** Establish the module skeleton within existing conventions.

Tasks:

- Register `OmnichannelModule` using the platform's existing module mechanism.
- Add navigation entries/feature flags using current frontend patterns.
- Configure permission keys for viewing inbox, replying, managing queues, managing connections, identity linking, operations logs, and replay.
- Register metadata, validation schemas, OpenAPI tags, translations, and module health/diagnostic hooks as appropriate.
- Do not create empty placeholder controllers for features that are not in the current phase.

Acceptance:

- Module registers cleanly and can be enabled/disabled according to current conventions.
- ACL defaults are least-privilege and no secret/config value is shown to ordinary agents.
- Existing modules continue to load without a dependency cycle.

### Phase 19-OM.3 — Persistence Model and Additive Migrations

**Goal:** Implement the minimum durable domain model needed for conversation and channel-thread linkage.

**Decision D1 applies: there is no new domain model to create.** The logical entities in §5 map onto
existing dedicated tables. This phase is an **additive extension of those tables, owned by
`VoiceCommunications`** (and, for the Case hand-off, by `ServiceDesk`), not a new set of
`omnichannel_*` tables.

Tasks:

- Map the logical entities in Section 5 to existing entity conventions; reuse generic Entity Engine where appropriate and use purpose-built tables only for high-volume/transactional data that warrants them.
- **Extend `voice_conversations` additively** with the §5.2 fields the audit found missing: `priority`, `category`, `language`, `tags`, `currentQueueId`, `assignmentVersion`, `lastMessageAt`/`lastOutboundAt`, `snoozedUntil`, `closedAt`, `version`.
- **Extend `voice_conversation_participants` additively** with a provider identity id distinct from the address, `verificationState`, `linkConfidence`/`linkReason`, `lastSeenAt`, `sourceProvenance`, and a unique index over connection + channel + provider identity.
- **Extend `voice_conversations.channel`** to admit the channels the first release actually ships, and decide the representation of more than one provider thread per canonical conversation.
- Create reviewed additive migrations for required missing structures only. Existing rows must be preserved and backfilled conservatively; no table is dropped, renamed or recreated.
- Add unique/idempotency constraints for provider event/message identity where semantics support them.
- Add indexes for assignment, queue, state, timestamps, external thread/message IDs, and unread counts/projections.
- Define appropriate foreign keys or relationship metadata for CRM entities, while allowing optional modules to be absent.
- Define deletion/retention semantics before storing high-volume message content or media metadata.
- Ensure JSON metadata is validated and not used as a substitute for indexed core fields.
- If a separate `omnichannel_*` receipt table is needed for a channel that does not use the voice transport, copy the **ESignature** inbox column shape (`payload_hash`, `content_length`, `signature_status`, `attempt_count`, `purge_after`) and keep it module-scoped.

Acceptance:

- Migration applies to the configured existing database without resetting or replacing data.
- Existing VoiceCommunications and ServiceDesk data remain untouched.
- Constraints prevent duplicate external message/event records under concurrent delivery.
- All new tables/metadata have documented retention and access-control expectations.
- **No second conversation, message or queue table exists** — the audit's reuse decisions are visibly honoured in the schema.

### Phase 19-OM.4 — Adapter and Capability Registry

**Goal:** Provide a provider-neutral connection/capability model while reusing shared integration infrastructure.

**Decision D1 applies: the provider-neutral adapter contract already exists** — `VoiceProviderAdapter`
is symmetric (inbound `validateWebhook`/`normalizeEvent`, outbound `initiateCall`/`sendMessage`/
`controlCall`/`fetchTranscript`) with `VoiceProviderRegistry`, `FakeVoiceProvider`,
`DisabledVoiceProvider`, and live Twilio and Asterisk adapters. This phase **exports and wraps**
that contract; it does not design a parallel one.

Tasks:

- Reuse AdvancedIntegrations and VoiceCommunications contracts where suitable.
- **Export `VoiceInboxService`, `VoiceMessagingService` and the `VoiceProviderAdapter` interface (plus the input/result types) from the Voice barrel.** Without this, Omnichannel would have to deep-import another module's internals — the coupling §2.4 warns against. This is the smallest change that makes every reuse decision possible.
- **Publish the voice transport as cross-module contracts** in the existing contracts registry (today only `voiceCommunications.consent.suppress` is published) — a send contract and an inbox/read contract.
- Define normalized types for connection, channel, thread, inbound event, outgoing command, provider result, media reference, and delivery status.
- Provide adapter capability lookup so the UI can enable/disable controls based on real support.
- Normalize provider error categories into transient, permanent, policy-blocked, authentication, rate-limited, unsupported, and unknown. **Baseline:** the existing 13-category taxonomy already covers transient/permanent/auth/rate-limit/unknown and splits policy-blocked into `consent_required`, `suppressed`, `template_required` and `window_closed`. Only `unsupported` is missing, and it must be added — a capability the adapter does not implement has to be an explicit refusal.
- Ensure adapter implementations are dependency-injected and can be replaced with fake adapters in tests.
- Define versioning/backward compatibility of adapter contracts.
- **Do not route channel transport through `AdvancedIntegrations`' `ConnectorAdapter` unless its owner agrees to add a `send` operation.** `CONNECTOR_OPERATIONS` has no `send`, and `upsertObject` must not be used to send — the port promises that `validateConnection` "never creates, updates, charges, sends or deletes a provider object". Reuse AdvancedIntegrations' HMAC kit, HTTP client and resilience helpers freely; they are designed for exactly this.

Acceptance:

- Core conversation services do not import provider SDK types.
- Missing provider capability results in a safe unsupported-operation response, not silent success.
- Tests can register a fake adapter without secrets or real outbound calls.
- **Omnichannel reaches the voice transport only through exported symbols and published contracts — no deep import into another module's internals.**

### Phase 19-OM.5 — Inbound Webhook/Event Receipt Pipeline

**Goal:** Receive events durably and safely.

Tasks:

- Add connection-aware webhook routing or reuse an existing shared webhook ingestion service.
- Verify signature/authentication before accepting trusted event semantics.
- Persist a minimal redacted receipt and deduplication key before asynchronous processing when required.
- Return provider-appropriate acknowledgements quickly and process non-trivial normalization in the existing job system.
- Add body-size limits, timeouts, schema validation, allowed-event filtering, and rate controls.
- Support retry/replay only with stable deduplication and explicit operational permissions.

Acceptance:

- Forged or malformed webhook events are rejected.
- A repeated event is acknowledged/handled according to provider protocol without duplicate side effects.
- Processing failure is observable and recoverable without exposing raw credentials or PII in logs.

### Phase 19-OM.6 — Canonical Conversation, Thread, and Message Services

**Goal:** Implement the canonical interaction model and state transitions.

**Decision D1 applies: the service layer already exists** — `VoiceMessagingService`
(`send`, `ingestInbound`, `applyStatus`) and `VoiceInboxService` (`list`, `timeline`, `markRead`,
`setStatus`, `assign`, `history`, `linkCase`, `handoffToCase`). This phase **exports and composes**
them behind a provider-neutral Omnichannel facade, and closes the gaps the audit found.

Tasks:

- Create application/domain services for conversation creation, thread attachment, inbound message upsert, message retrieval, read-state updates, and conversation state transitions — **as a facade over the existing Voice services**, not as a parallel implementation.
- Separate provider thread IDs from canonical conversation IDs. **Design gap:** today one conversation carries exactly one `external_thread_id`, and voice calls are not conversations at all. The target representation must support N provider threads per canonical conversation.
- Separate internal notes from customer-visible message records or enforce a strong visibility boundary in storage and every serializer. **Keep the existing guarantee:** the `voice_messages` schema already refuses a provider message ID on an internal note, and `stream_items.visibility` already separates public from internal on a Case.
- Record conversation events and assignment/state history in the existing audit/event conventions — `voice_conversation_events` is already the append-only log.
- Validate timestamp handling, message ordering, attachment references, content type, and channel-specific fields.
- Do not blindly merge all conversations from one Contact. Use explicit continuity policy.
- **Add a reconcile-unknown path.** The audit found there is currently no status-polling job and no "reconcile an unknown send" command, so §3.5's "query provider status before repeating the send" cannot be satisfied today.

Acceptance:

- Inbound normalized events can create/update one canonical conversation and one message.
- Reprocessing the same event cannot duplicate the message.
- Conversation state and ServiceDesk Case state remain independent.
- Internal note content is absent from customer-facing serializers and send adapter commands.
- **No second send/ingest/status implementation exists** — Omnichannel composes the exported Voice facade.

### Phase 19-OM.7 — CRM Identity Resolution and Record Linking

**Goal:** Match channel participants to CRM entities safely.

**Existing baseline to extend, not replace:** `VoiceContactResolverService` already normalizes with
libphonenumber, derives match keys, searches `Contact`/`Lead`/`Account` in order, applies
entity-level then record-level ACL (an unreadable match is counted but **not named**), and bounds
its candidates. Two gaps the audit found: the match is a `regexp_replace` scan over
`entity_records` because **no normalized phone index exists**, and the identity has **no confidence
or provenance model**.

Tasks:

- Implement exact matchers for stable channel-scoped provider IDs and authorized verified contact hints.
- Add an ambiguous-match state and staff review UI/API.
- Allow permitted staff to link/unlink identity to Contact or Lead, with audit reason.
- Add bounded lookup indexes and caching only where invalidation is understood. **A normalized phone index is required** — today the resolver scans.
- Provide contextual CRM record references without leaking inaccessible fields.
- Support anonymous web chat, authenticated Portal identity, and safe promotion/linking workflows. **Note:** Portal has no anonymous principal today, so the anonymous-visitor identity model is defined in OM.1.
- Record link confidence, link reason, and source provenance on the participant, so an automatic link is always explainable and reversible.

Acceptance:

- Unique exact matches link predictably; ambiguous matches are not guessed.
- Identity link changes are authorized and auditable.
- ACL is applied independently to all fields in the customer context panel.
- **Every automatic identity link carries a confidence value and a provenance reason** — the plan's "visible uncertainty" rule is enforced in the data model, not only in the UI.

### Phase 19-OM.8 — Outbound Command, Send State, and Reconciliation

**Goal:** Make reply sending safe and truthful.

Tasks:

- Implement the outbound command lifecycle and idempotency strategy.
- Route sends through the owning channel adapter/facade, not direct provider SDK calls from conversation controllers.
- Verify current identity/thread, permission, consent, provider policy/window, supported payload types, attachments, and connection health at send time.
- Persist content/attachment references and the actor before execution; never put secrets into send records.
- Handle timeout/unknown result by querying provider status where possible and requiring explicit operator review if duplicate risk cannot be resolved.
- Process delivery callbacks and maintain a separate provider status where status semantics differ from canonical command status.

Acceptance:

- All sends produce an auditable command with explicit state.
- Timeout cannot trigger an automatic blind duplicate message.
- Policy/consent/ACL failures block the send server-side and are actionable in the UI.

### Phase 19-OM.9 — Website/Portal Chat Channel

**Goal:** Add a safe web chat entry point if an appropriate component does not already exist.

**Existing baseline to reuse, not replace:** `WebToCaseService` already provides a `@Public()`
intake with a honeypot, length caps, a per-IP rate limit, idempotency by client key or content
hash, and an allowlist of customer-facing fields only. Those **abuse controls are the reusable
part**. Two constraints the audit found: **Portal has no anonymous principal** (every portal route
requires an authenticated `users.type='portal'` user with a `contact_id`), and Portal's
`recordVisible()` is entity-generic via `linkFieldsFor(entity)` — so a new conversation entity with
`contactId`/`accountId` link fields would be covered automatically *once it exists*.

Tasks:

- Reuse Portal routes, identity, session/token patterns, and front-end components where suitable.
- If a public anonymous widget is needed, implement a narrow scope token, session expiry, allowed-origin checks, abuse protection, and no privileged credentials in the browser. **Define the anonymous-visitor identity and its consent basis in OM.1** — this does not exist today and it must not weaken `PortalPolicyService.recordVisible()`.
- Support visitor initialization, message send/receive, reconnect, offline fallback, attachment restrictions, and consent/notice settings where required.
- Create or resume the matching canonical conversation under explicit continuity rules — **under decision D1, that is a `voice_conversations` row**, so this phase widens the channel CHECK and defines the continuity rule rather than creating a new store.
- Ensure customers cannot enumerate conversation IDs or access another visitor's history.
- Provide internal test mode that uses fake channels and does not send customer messages externally.

Acceptance:

- An anonymous/Portal user can send and receive a message in the correct conversation under configured policy.
- Forged IDs, expired sessions, disallowed origins, and rate abuse are rejected.
- Staff notes and internal CRM fields are never exposed to widget clients.
- **The widget reads customer-visible messages only** — it has no path to `is_internal_note` rows or `visibility='internal'` stream items.

### Phase 19-OM.10 — Agent Inbox Workspace MVP

**Goal:** Deliver the first usable agent interface.

**Existing baseline to extend, not replace:** `apps/web/src/pages/VoiceInboxPage.tsx` (852 lines)
already implements the conversation list, timeline, composer, canned snippets and handoff, polling
on 15–20 s intervals. This phase adds the **multi-channel workspace** around it and hardens it
against the plan's requirements.

Tasks:

- Build inbox navigation, filters, list, thread pane, status/assignment labels, unread markers, and loading/offline/error states — **on top of the existing Voice inbox**, adding the channel/queue/priority/language/tag filters the audit found missing on the conversation record.
- Integrate with existing design system, metadata layouts and router.
- Render messages safely according to content type; display attachment/download permissions and send statuses.
- Implement cursor pagination for inbox and message history.
- Keep UI state consistent after reconnect and server-side assignment changes.
- Add responsive layout and keyboard/accessibility support.
- **Replace the polling fallback with the decision D3 realtime path** once the shared publish seam exists, while keeping the current polling as an acceptable interim.

Acceptance:

- Authorized agents can process a conversation end-to-end through the first enabled channel.
- Inbox filters use server-side ACL-constrained data, not client filtering of a globally fetched record set.
- Message content is safe against script/HTML injection.
- **No internal note is ever rendered to a customer-facing surface** — the customer widget and the staff workspace share the record but not the visibility.

### Phase 19-OM.11 — Queues, Assignment, Transfers, and Routing

**Goal:** Organize ownership and route conversations safely.

**Decision D2 applies: this work is delivered in `ServiceDesk`, extending `CaseQueue`,
`QueueMember` and `RoutingRule`.** Omnichannel contributes the conversation-facing policy and the
workspace view; it does not own the queue model. The audit found ServiceDesk already provides
`manual|roundRobin|leastBusy` strategies, a row-locked round-robin cursor, a workload endpoint,
`unassigned|fallbackOwner` fallbacks, a `CaseAssignment` audit row, and validated routing-rule
conditions — the work below is the **delta**.

Tasks:

- Extend the existing queue model (do **not** create `OmnichannelQueue`) so a queue can hold **conversations** as well as Cases. Queue CRUD/configuration stays admin-ACL-controlled; the queue config entities are already `create:'no', edit:'no'`.
- Add claim, assign, release, transfer, and validated state-change commands. `VoiceInboxService.assign` already exists for the conversation side.
- Implement simple deterministic routing first: fixed queue/team, channel, priority, working hours, and fallback. **Working-hours routing requires an additive ServiceDesk change** — `BusinessCalendar` is currently consumed only by `sla.service.ts`, and routing never consults it.
- **Extend the routing-rule operator allowlist** beyond `equals|notEquals|in` if language, customer tier, skill or capacity conditions are in the first release. The current allowlist cannot express them.
- Add optimistic concurrency/version checks to avoid conflicting claims. **Requires the `version` column on `voice_conversations`** added in OM.3.
- Add round-robin/least-busy only if a reliable agent availability/workload source exists — the `CaseQueue.lastAssignedUserId`/`lastAssignedAt` cursor and the workload endpoint already satisfy this.
- Record all routing decision metadata and assignment changes — `CaseAssignment` is the durable row; it must accept a conversation as the routed object.
- Provide a safe "unassigned queue" fallback if no eligible agent is found — `fallbackBehavior` already models `unassigned|fallbackOwner`.
- **Also extend `ServiceDesk` with the Case hand-off contract OM.17 needs**: a nullable `Case.externalId` (or equivalent) with a partial unique index, a `Case.conversations` relation, and a create-or-link command that sets `source` and writes the audit row. Note that `VoiceInboxService.handoffToCase` currently calls the generic entity API, so it produces no `CaseTransition` row and sets no `source`.

Acceptance:

- Assignment commands cannot be used to view or take ownership of unauthorized conversations.
- Concurrent claim attempts resolve to one authoritative assignment.
- Routing decisions are explainable and have a deterministic fallback.
- **No second queue or routing engine exists**, and the ServiceDesk extension is additive — existing Case routing keeps working unchanged.

### Phase 19-OM.12 — Canned Replies, Drafts, and Message Tools

**Goal:** Speed up service replies without creating a campaign engine.

Tasks:

- Add reusable service snippets/canned replies if no shared equivalent exists.
- Support per-team visibility, localization, approved variables and preview.
- Disallow unsafe HTML and arbitrary template scripting.
- Keep draft and public-send modes distinct.
- Integrate channel-specific templates from the owning provider module where needed; do not duplicate Meta/WhatsApp template approval management if VoiceCommunications owns it.
- Track use where operationally useful without collecting unnecessary message content in analytics.

Acceptance:

- Snippets are permission-aware, safe, and editable only by authorized roles.
- MarketingAutomation campaign templates cannot be triggered from ordinary agent replies by mistake.

### Phase 19-OM.13 — VoiceCommunications Integration

**Goal:** Project supported communications activity into Omnichannel without duplicating transport.

Tasks:

- Define a stable subscription/event contract with VoiceCommunications for supported inbound/outbound SMS/MMS, WhatsApp messages, call events, and delivery updates. **The audit found only `voiceCommunications.consent.suppress` is published today — publishing a send contract and an inbox/read contract is a prerequisite, not an optional part of this phase.**
- Reuse existing provider connections and credentials; do not ask the administrator to configure the same provider twice unless the provider contract explicitly requires separate accounts.
- Reference authoritative call/message IDs and maintain a canonical conversation/thread link.
- When a call arrives, show the caller context and provide an explicit action to open or link a conversation; do not convert all calls into text messages. **Note:** a call is a `voice_call_session`, not a conversation — there is no call↔conversation grouping today, and `voice_conversations.channel` excludes `voice`.
- Preserve channel-specific restrictions, opt-out state and transport ownership in VoiceCommunications.
- Add reconciliation tests that ensure a single provider event does not create duplicate authoritative messages.

Acceptance:

- Omnichannel can show supported VoiceCommunications conversations/events without direct duplicate provider API calls.
- A failed or disabled VoiceCommunications connector is displayed honestly and does not break other channels.
- **Omnichannel reaches VoiceCommunications only through exported symbols and published contracts** — no deep import, and no duplicate provider credential, webhook handler, or send-status source of truth.

### Phase 19-OM.14 — WhatsApp Business and SMS/MMS Conversation Integration

**Goal:** Make existing VoiceCommunications messaging available in the shared inbox where the adapter supports it.

**Channel reality to respect:** **WhatsApp ships through Twilio's WhatsApp API** — Meta Cloud API is
not present and would be a separate connector with separate credentials and app review. **MMS has
no adapter** — it is named in the vocabulary, tables and DTOs, but no adapter declares
`messaging.mms.send`/`.receive`. WhatsApp template approval is owned by `voice_whatsapp_templates`.

Tasks:

- Consume incoming message events and delivery statuses through VoiceCommunications contracts.
- Support message templates, session/customer-service windows, opt-in, opt-out and relevant channel policies through the owning module.
- Support text and permitted media first; expose advanced payloads only based on advertised adapter capabilities.
- Preserve provider-scoped identifiers and reply routing information securely.
- Add operator-friendly blocked-send reasons for policy windows, missing approved templates, opt-out, rate limits, expired credentials, and unsupported content — the existing ordered refusal codes and the 13-category error taxonomy are the baseline.
- Verify current official documentation and provider account eligibility at implementation time.

Acceptance:

- Agents can reply through an enabled, policy-compliant connection using the owning adapter.
- Omnichannel does not duplicate WhatsApp or SMS credentials, webhook handlers, or send-status source of truth.
- Automated tests use fake adapters or sandbox numbers only.
- **MMS is not presented as supported** until an adapter implements it; a missing capability produces an explicit `unsupported` refusal, never a silent success.

### Phase 19-OM.15 — Meta Messenger/Instagram Adapters (Conditional)

**Goal:** Add official Meta messaging channels only if current account eligibility and app permissions allow the intended use case.

Tasks:

- Perform a fresh official-doc feasibility review for the exact Instagram Professional account/Page configuration, app scopes, review and verification requirements.
- Implement through the selected existing shared adapter framework; do not build a second generic Meta integration if AdvancedIntegrations or VoiceCommunications owns the needed transport.
- Handle webhook verification/signature validation and deduplication as required by the official API.
- Map platform-scoped user IDs and page/account/thread IDs; do not attempt cross-platform identity inference from a username.
- Restrict reply features to current conversation policy, supported message types, permitted recipient context, and provider account capabilities.
- Add explicit disabled/unavailable status when permissions expire or the provider API removes a capability.

Acceptance:

- Only documented and approved operations are enabled.
- Missing permissions or policy-window errors are surfaced and do not trigger infinite retry.
- Unsupported operations remain disabled rather than simulated.

### Phase 19-OM.16 — Optional Email and Telegram Connectors

**Goal:** Extend channel coverage only where current shared services make the integration safe and feasible.

Tasks:

- For email, integrate through existing email transport and inbound threading. Coordinate with ServiceDesk Email-to-Case to prevent duplicate case creation and conflicting mailbox ownership.
- For Telegram, evaluate the official Bot API and its bot-based interaction model; do not promise access to general personal chats or message history outside bot permissions.
- Verify signed/secret-token webhook protection where supported, event IDs, attachment/media behavior, rate limits, and retention.
- Keep connectors feature-flagged until credentials and external configuration have been verified.

Acceptance:

- Email/Telegram is accepted into release only after its own channel feasibility and security tests pass.
- One inbound event creates one normalized message and triggers one set of authorized side effects.

### Phase 19-OM.17 — ServiceDesk Handoff and Case Context

**Goal:** Make a conversation a reliable entry point for service operations.

**The contract this phase needs does not exist yet, and the audit found the gap precisely.** `Case`
has **no** `externalId`/`sourceRef`, **no** `conversations` relation, and **no** create-or-link
command. `VoiceInboxService.handoffToCase` currently calls the **generic entity API**
(`this.entities.create('Case', …)`), which produces no `CaseTransition` history row, sets no
`source`, and links back only through `voice_conversations.case_id` — the Case has no pointer to
the conversation. The extension below belongs to `ServiceDesk`, additively.

Tasks:

- Link to an existing Case with clear relationship and permission checks.
- Create a Case only through a ServiceDesk domain command and only when the staff/automation actor has permission. **Extend `ServiceDesk` with a `createCaseForConversation`/`linkConversation` command** that creates or links the Case, sets `source` (adding a channel value to `CASE_SOURCES`), and writes the `CaseTransition`/`CaseAssignment` audit row so the trail is complete.
- **Add a nullable `Case.externalId` (or `sourceRef` + `sourceType`) with a partial unique index, and a `Case.conversations` relation**, so the conversation is linkable without a second table and without Omnichannel writing `entity_links` directly.
- Pass a safe summary, channel origin and authorized conversation references; do not copy private internal notes or unrelated messages to customer-visible Case content.
- Reflect Case status as contextual information while keeping conversation state independent.
- Display the handoff result and provide retry/recovery for temporary target-module errors.
- Reuse ServiceDesk's SLA and case response policies for the linked Case; do not compute a duplicate Case SLA inside Omnichannel.
- **Also record the ServiceDesk ownership bypass the audit found:** `assignedUserId` is not in `SERVER_OWNED_CASE_FIELDS`, so a regular user with Case edit rights can set the owner via the generic API, bypassing `CaseAssignment` and leaving no history row. Add it to the server-owned list.

Acceptance:

- Handoff is idempotent or protected by a unique command key, preventing repeated Case creation on retries.
- Case ACL remains authoritative after linking.
- Internal and external message visibility stays correct across both modules.
- **A hand-off produces a complete ServiceDesk audit trail** — a `CaseTransition`/`CaseAssignment` row, not a silent generic-API insert.

### Phase 19-OM.18 — Consent, Preferences, Retention, and Data Rights

**Goal:** Centralize enforcement without creating a conflicting source of consent truth.

**Ownership is already split, and the split must not move:** MarketingAutomation owns **email**
consent and suppression (`MarketingConsent`/`MarketingSuppression`, identity = an `emailHash`
digest, channel `["Email"]`); VoiceCommunications owns **voice/SMS/MMS/WhatsApp**
(`voice_consent_events`/`voice_suppressions`, identity = the normalized address). ServiceDesk and
Portal contain **no** consent code at all. **The unit of ownership is the channel, not the module** —
so Omnichannel resolves consent **per channel** through the owning module and adds **no** third
store.

Tasks:

- Document the source-of-truth for each channel and message purpose.
- Query the owning service at send time and fail closed if the consent decision cannot be obtained for a channel that requires it. The governing invariants are: *missing evidence is never consent* (no record ⇒ unknown, and unknown blocks) and *an address change does not carry consent over*.
- Ensure marketing campaign eligibility is still governed by MarketingAutomation, and operational replies obey the relevant channel restrictions/opt-outs.
- Add admin retention settings for normalized messages, provider metadata, media, identity hints, and redacted event payloads where those settings are not already provided centrally.
- Support authorized data export/deletion workflows through platform policy while preserving legally required audit information as applicable.
- Make media and attachment expiration/deletion safe; remove provider-hosted links when no longer valid and avoid permanent public URLs.
- **Note:** there is no inbound STOP/UNSUBSCRIBE keyword scanner today — `stop_keyword` is only a suppression *reason*. If keyword-driven opt-out is in the first release, it belongs to the Voice ingress, which owns the suppression list.

Acceptance:

- No Omnichannel send route bypasses the owning consent/policy service.
- Retention is explicit, testable, and does not silently conflict with existing platform policies.
- **Consent is never copied into an Omnichannel-owned table** — a channel's consent is read from its owner, and the two vocabularies are never merged into one flag.

### Phase 19-OM.19 — AI-Assisted Agent Workflow through AIAgents

**Goal:** Add optional assistance while preserving human control and an auditable tool boundary.

**Existing contract to build on:** `AIAgentRunService.create(agentId, RunCreateInput)` and
`triggerRun({trigger: 'integration', …})` — `trigger: 'integration'` already exists and is the
intended door for an external module. The approval matrix defaults to
`requireFor: ['material_write','high_impact']`, and `approvalRequired()` pauses the run until a
human approves. **There is no typed-task API** (the only facade is chat-shaped and must not be
promoted), and **there is no messaging tool** in the registry — so today the approval matrix
cannot gate a channel send.

Tasks:

- Add controlled actions to summarize a conversation, classify it, translate/normalize text where permitted, suggest a reply, suggest a queue, and draft a ServiceDesk Case summary.
- Use AIAgents provider and runtime contracts; avoid duplicate LLM clients, tool registries, agent memory, prompt management, or approval systems.
- **Define Omnichannel's own typed request/response DTOs over `AIAgentRunService.create`/`triggerRun`** — do not reuse `CRMChatAIAgentsClientService`, whose types are chat-shaped and would drag chat turn identity into Omnichannel.
- **Register a channel-send tool with `effectClass: 'material_write'`** so the existing approval matrix enforces explicit send approval. Without a registered tool, `approvalRequired()` never fires for a send.
- Pass only the minimal conversation content and CRM context needed for the task under current ACL.
- Present evidence and uncertainty where possible; label content as AI-generated.
- Keep suggested replies as editable drafts. Sending a suggestion requires an authorized human action by default. **Mirror the existing draft-only pattern** — `voice_transcripts.ai_review_status` starts at `pending` and nothing external happens until an authorized user approves it.
- If later supporting autonomous replies, require a separate feature flag and explicit policy, limited intents/channels, confidence thresholds, allowlisted tools, per-hour limits, cost caps, escalation fallback, and audit logs.
- Prevent AI-supplied text, URLs, or inferred identity from bypassing normal send validation.
- **Do not expose internal CRMChat as the customer chat widget.** CRMChat's internal-only boundary is data-driven, not code-enforced — there is no `userType !== 'portal'` check in that module — so it must stay out of every portal and widget surface.

Acceptance:

- AI suggestions do not send, create Cases, or change ownership merely by being generated.
- Prompt injection in a customer message cannot grant tools or permissions.
- AI failure does not block ordinary human replies.
- **A send through an AI suggestion passes the same approval matrix as any other material write**, and an interrupted tool call is recorded as `outcome_unknown` rather than auto-retried.

### Phase 19-OM.20 — Conversation Analytics and Operational Reports

**Goal:** Provide useful metrics with defensible definitions.

Tasks:

- Implement or extend reports for message volume by channel, backlog, assignment distribution, first response time, reply delay, handoff volume, reopen rate, delivery failures, and provider health.
- Define exactly which timestamps and statuses contribute to each metric.
- Exclude internal notes from customer-message counts unless a metric specifically calls for internal activity.
- Apply ACL and report-level data permissions consistently.
- Reuse generic Reports/Dashboard infrastructure if already available. **Constraint the audit found:** the report engine resolves field paths against **metadata entities**, and the generic search path is likewise metadata-driven (`SEARCH_INDEXED_ATTRS` + trigram indexes must stay in sync). Because the conversation records are **dedicated tables** (decision D1), they are **neither reportable nor searchable through the generic path today**. This phase must add a projection — a metadata-entity-backed read model or a dedicated analytics path — rather than assume the generic engine covers it.
- Keep ServiceDesk Case SLA metrics sourced from ServiceDesk; Omnichannel metrics should describe conversation handling unless the owner provides a canonical metric.
- Handle missing provider events and timestamps explicitly; do not infer a successful delivery from a local submission timestamp.

Acceptance:

- A documented metric can be recomputed from authoritative data.
- Reports cannot leak message content or counts from inaccessible teams/conversations.
- Empty, missing, and provider-unsupported metrics show honest unavailable/partial states.
- **Conversation search and analytics work over the reused records** — either through a projection that is itself ACL-constrained, or through a documented dedicated path that applies the same record and field permissions.

### Phase 19-OM.21 — Administration, Diagnostics, and Recovery

**Goal:** Operate channels reliably without requiring database-level intervention.

**Existing baseline to extend:** `VoiceCommunications` already ships connection health, provider
accounts and endpoints, the WhatsApp template registry, the webhook-event list with its
**authorized admin replay path**, and a module health service. Omnichannel adds the
cross-channel view over it.

Tasks:

- Provide connection health, enabled channel capabilities, last event time, authentication state, webhook backlog and failure categories.
- Add safe tools for testing credentials, replaying a failed normalized event, reconciling an unknown send outcome, and disabling a compromised connection. **The reconcile-unknown command must be added in VoiceCommunications** — it does not exist today, and without it a timed-out send cannot be resolved before it is retried.
- Redact diagnostic payloads and require elevated ACL for event inspection and replay.
- Provide a runbook for provider outages, expired tokens, certificate/signature failures, rate limits, stuck jobs, duplicate events, and channel-policy changes.
- Never expose secrets or allow arbitrary endpoint overrides that could enable SSRF.
- Support a connection kill switch and document the impact on queued/unknown sends and inbound event receipt.

Acceptance:

- A typical transient error can be investigated and recovered from through documented administrative steps.
- Replay uses idempotency controls and reports which side effects will or will not reoccur.
- Disabling a provider stops new outbound traffic without deleting conversation history.
- **Diagnostics read the reused records** — the same webhook receipt, message state and provider health — rather than a parallel operational store.

### Phase 19-OM.22 — Security, Privacy, and Resilience Hardening

**Goal:** Resolve high-risk paths before broader rollout.

Tasks:

- Perform threat modeling for cross-channel identity resolution, public chat, webhook spoofing, internal-note leakage, attachment download, provider credential theft, CSRF/session abuse, replay, message injection, AI prompt injection, and unauthorized exports.
- Verify all API, search, count, export, real-time, attachment and background paths apply ACL.
- Test concurrency and idempotency under duplicate and out-of-order webhook delivery.
- Test unknown send outcomes, provider throttling, network timeouts, worker restarts, and retry exhaustion.
- Validate redaction and retention for messages, identifiers, attachment URLs, raw payloads, and AI prompts/results.
- Check dependency/license compliance and provider terms; document any unresolved legal or policy question.
- Run static checks, security tests, and dependency vulnerability checks using existing repository scripts.

Acceptance:

- No unresolved critical/high security issue in the module's core data paths.
- No demonstrated internal-note leakage or ACL bypass.
- No duplicate side effects on tested webhook replay/retry scenarios.
- No destructive database operations or secondary test database have been introduced.

### Phase 19-OM.23 — End-to-End QA, Documentation, and Release Readiness

**Goal:** Ship a reliable first release with explicit scope and operational expectations.

Tasks:

- Run end-to-end acceptance tests for the first supported channel with fake/provider sandbox infrastructure.
- Test full inbound → identity matching → queue routing → agent reply → delivery callback → CRM context → optional ServiceDesk handoff.
- Test unsupported/disabled channel behavior and graceful degradation.
- Verify OpenAPI, module metadata, navigation, translations, admin setup, runbooks, release notes, and feature flags.
- Validate installation/upgrade on the existing configured database using reviewed additive migrations and no reset.
- Record performance for inbox list/message history with representative bounded data; document limits and indexes.
- Record known provider prerequisites, approved scope, configuration steps and costs/quotas for any live connector.
- Produce a phase report listing implemented features, test outcomes, open risks, disabled connectors and required customer configuration.

Acceptance:

- Core inbox works with at least the first fully supported channel.
- Optional connectors can be disabled independently.
- All module checks run successfully or skipped checks are explicitly explained.
- No feature is claimed as production-ready if the required external API permissions/account setup have not been verified.

---

## 15. Recommended First-Release Scope

To keep the work tractable and avoid rebuilding capabilities already completed elsewhere, the recommended first release is:

1. Repository audit and a signed-off capability/ownership matrix. — **Done in 19-OM.0**; see `docs/omnichannel/repository-audit.md` and `docs/omnichannel/capability-matrix.md`.
2. **Reused** canonical conversation, channel-thread and message records — the existing `voice_conversations` / `voice_messages` family, extended additively (decision D1), **not** a new store.
3. Inbound event ingestion with signature verification/deduplication for one actual supported channel, over the existing `voice_webhook_events` receipt pipeline.
4. Agent inbox with message history, customer context, assignment, internal notes and safe reply composer — building on the existing `VoiceInboxPage` and `VoiceInboxService` rather than replacing them.
5. Reuse the existing Portal for the web chat entry point if no equivalent component exists — noting that Portal has **no anonymous principal**, so the visitor-identity model must be defined first.
6. Reuse VoiceCommunications to expose its existing WhatsApp/SMS/MMS capabilities in the inbox — through an exported facade, not a deep import. MMS has **no adapter** today and Meta Cloud API is not present; WhatsApp ships through Twilio.
7. Queue routing with deterministic rules and a safe unassigned fallback — **extending `ServiceDesk`'s `CaseQueue`/`RoutingRule`** (decision D2), including the operator-allowlist and business-hours gaps the audit found.
8. ServiceDesk handoff with idempotent Case creation/linking — requiring the additive `Case.externalId` + create-or-link command in ServiceDesk.
9. Consent/policy checks, audit, provider health, retry/reconciliation, and tests.
10. Optional AIAgents-based reply suggestions as drafts only — requiring a registered `material_write` channel-send tool so the existing approval matrix can enforce explicit send approval.
11. Realtime conversation events over the extended `NotificationEventsService` seam, via an Omnichannel module-scoped SSE endpoint (decision D3).

Defer additional social connectors, elaborate workforce optimization, auto-merge identity logic, autonomous AI replies, extensive social listening, and sophisticated sentiment analytics until the first release has proven correct and reliable.

Also defer, explicitly: **MMS** (no adapter implements it), **Meta Messenger/Instagram** (no adapter, no app review), **Telegram** (no adapter), and **real inbound email** (the port exists but no provider is installed — an operator must configure one).

---

## 16. Current External Reference Baseline

These public resources are behavioral and technical references only. They do not mean every listed channel feature is available to every business account. The coding agent must re-check the official versioned docs when implementing a connector and record the review date and account prerequisites.

- EspoCRM extension catalog and integration overview: https://www.espocrm.com/extensions/
- EspoCRM public feature/extension overview: https://www.espocrm.com/features/extensions/
- WhatsApp Business Platform developer hub: https://whatsappbusiness.com/developers/developer-hub/
- Meta WhatsApp Business Platform API collection — messages: https://www.postman.com/meta/whatsapp-business-platform/folder/o48mro7/messages
- Meta WhatsApp Business Platform API collection — webhooks: https://www.postman.com/meta/whatsapp-business-platform/folder/lboq68h/webhooks
- Meta Messenger Platform API — Send API: https://www.postman.com/meta/messenger-platform-api/folder/vilwbh4/send-api
- Telegram Bot API: https://core.telegram.org/bots/api
- Telegram webhook guide: https://core.telegram.org/bots/webhooks
- TikTok for Developers: https://developers.tiktok.com/doc/tiktok-api-v2-introduction/

The current EspoCRM official extension catalog lists provider-oriented integrations such as VoIP, Google, Outlook, Zoom, Stripe and MailChimp, but does not describe a first-party general-purpose Omnichannel module. Treat the plan as a custom domain module designed for this project rather than claiming exact feature parity with an upstream Omnichannel product. A public EspoCRM community feature request for a centralized multi-platform messaging extension can inform use cases, but it is not an official specification.

---

## 17. Final Coding-Agent Handoff

Begin with **Phase 19-OM.0 only**. Do not generate the entire module in one pass.

The first response after the audit must include:

1. Existing reusable components and their actual source paths.
2. A table of capabilities marked `Reuse`, `Extend`, `Build`, `External prerequisite`, or `Defer`.
3. Canonical source-of-truth decisions for voice/SMS/WhatsApp, email, Case, campaign consent, Portal identity, AI execution, and message delivery status.
4. A proposed first channel that can be tested using the available credentials/provider sandbox or fake adapter.
5. Proposed schema changes and the reason each new structure is necessary.
6. Test commands inspected for hidden database creation, resets, destructive setup/teardown, or live-provider side effects.
7. A list of assumptions and external approvals still needed.
8. A recommendation for the smallest next sub-phase, without implementing it until the audit is reviewed.

**Do not start Phase 19-OM.1 or perform broad schema changes until the Phase 19-OM.0 audit is complete and its findings have been documented.**
