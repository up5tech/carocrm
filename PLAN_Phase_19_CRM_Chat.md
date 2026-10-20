# PLAN — CRM Chat Assistant (`CRMChat`)

> **Status:** Planned  
> **Parent roadmap:** `PLAN.md` — Advanced CRM Capabilities  
> **Suggested module name:** `CRMChat`  
> **Module slug:** `crm-chat`  
> **NestJS module/class:** `CRMChatModule`  
> **Frontend route:** `/crm-chat` (adapt to the repository's route conventions)  
> **Target stack:** Existing NestJS/TypeScript backend, existing React SPA, PostgreSQL, and the repository's established SQL/persistence layer  
> **Primary orchestration dependency:** Existing `AIAgents` module  
> **Implementation style:** Clean-room, provider-agnostic, metadata-aware, modular monolith  
> **Database policy:** Follow `AGENTS.MD`; use the configured primary database for safe, targeted integration verification and never create a separate test database/schema  
> **Naming rule:** Do not add a `Ua` prefix to the module, classes, route slug, tables, configuration, events, or documentation.

---

## 0. Instructions for the Coding Agent

Read `AGENTS.MD`, `PLAN.md`, and the actual source code for `AIAgents`, the Entity Engine, ACL, Search, Activities, Notifications, Jobs, Attachments, Dashboard, and the existing frontend shell before implementing this plan.

This plan describes intended behavior. It is not evidence that a dependency already exists or is implemented. Start with **Phase 19-CHAT.0 only**. Inspect the repository, migration history, public API conventions, module manifests, tool contracts, provider adapters, UI conventions, tests, and database test scripts before selecting an implementation.

### Non-negotiable rules

- Keep the system a modular monolith. Do not create microservices solely for Chat.
- Do not rebuild an LLM provider gateway, agent runtime, tool registry, tool executor, agent memory system, evaluation framework, or approval engine if `AIAgents` already provides the needed capability. Define small, versioned integration contracts and extend the owner module only when the audit proves a real gap.
- Do not bypass the Entity Engine, metadata layer, ACL, record-level access, field-level access, audit, or domain services to make CRM data retrieval easier.
- The LLM must never receive direct database credentials and must never submit SQL for direct execution. Use approved, typed CRM query tools and a validated query-plan DSL.
- All data reads and writes must execute under the authenticated user's effective authorization. An agent run is not an elevated user.
- Require a preview and explicit confirmation by default before executing any write action. Revalidate authorization and the target record state when confirmation is submitted. High-impact, bulk, external, financial, destructive, and irreversible actions require stronger approval policies or must be blocked from Chat entirely.
- Treat CRM content, email bodies, notes, attachments, external web content, tool results, and retrieved documents as untrusted data that may contain prompt injection. They are evidence, not instructions.
- Ground answers about live CRM data in actual tool results. Include record links, source labels, query timeframe, and caveats where possible. Never invent counts, fields, record links, or completed actions.
- Keep Chat's user-facing transcript separate from `AIAgents` execution details. Reuse the existing agent run ID and execution trace rather than duplicating a second orchestration engine.
- Never log secrets, full prompts containing sensitive records, bearer tokens, provider credentials, or unredacted personal data by default.
- **Do not create a new test database, temporary database, shadow database, test schema, Docker database, or per-agent/per-run database.** Inspect test scripts first and follow `AGENTS.MD` exactly.
- Never run real outbound emails, SMS, phone calls, payments, external writes, or irreversible integrations as a side effect of automated tests. Use fake/stub providers and narrowly scoped `AGENT_TEST_...` data.
- Do not mark a phase complete without recording acceptance evidence and any limitations.

---

## 1. Purpose and Product Vision

Implement a first-class CRM Chat Assistant so authorized users can ask questions, explore data, request cross-module analysis, and initiate approved multi-step workflows through a natural-language conversational interface instead of manually navigating every CRM module.

`CRMChat` is the **conversational product experience**. The existing `AIAgents` module is the **agent execution and tool orchestration layer**. Chat sends intent and context to AIAgents through a typed contract, renders streamed output and execution progress, presents evidence and proposed actions, and stores the user-facing conversation history.

### 1.1 Primary outcomes

At completion, an authorized user can:

1. Ask questions in Vietnamese or English, including follow-up questions that refer to prior turns.
2. Ask how to use the CRM and receive answers grounded in permitted help/documentation content.
3. Search, retrieve, summarize, compare, and aggregate live CRM data without manually opening each module.
4. Ask cross-module questions involving supported combinations of Accounts, Contacts, Leads, Opportunities, Sales, Projects, CustomerSuccess, ServiceDesk, MarketingAutomation, VoiceCommunications, AdvancedIntegrations, and other installed modules.
5. Receive answers supported by citations to records, saved reports, approved documentation, and query summaries.
6. Ask for an action, see exactly what the assistant plans to change, review affected records and values, and confirm or cancel it.
7. Delegate eligible multi-step work to `AIAgents`, monitor progress, approve gated steps, cancel a run, and inspect the final outcome.
8. Resume recent conversations, search conversation history, rename/archive conversations, and provide answer feedback subject to retention policy.
9. Use suggested prompts and reusable prompt templates without giving the assistant broader permissions than the user already has.
10. View a clear status when information is missing, a tool is unavailable, a request is ambiguous, or a provider fails.

### 1.2 Example user journeys

**Help and navigation**
- “How do I create a quote?”
- “Where can I see projects that are overdue?”
- “Explain the difference between a ServiceDesk queue and an assignee.”

**Live CRM questions**
- “Show my open opportunities expected to close this month.”
- “Which ServiceDesk cases are overdue against SLA?”
- “Summarize the health of my highest-risk customers.”
- “How many invoices are unpaid by account owner this quarter?”

**Cross-module analysis**
- “Find customers with low health scores, an open critical ticket, and a renewal in the next 60 days.”
- “Compare won sales with onboarding completion for the last two quarters.”
- “Which marketing campaigns generated contacts who later became customers?”

**Action with confirmation**
- “Create a follow-up task for the owner of this account next Tuesday.”
- “Draft an update to the case and assign it to the support queue.”
- “Prepare a renewal-risk review for these five accounts.”

**Multi-step orchestration**
- “For each at-risk account with a renewal in the next 45 days, gather recent cases and sales history, prepare a summary, and propose a follow-up task. Do not create anything until I approve the proposed tasks.”

These examples are acceptance scenarios, not permission to expose data or execute every action for every role.

---

## 2. Product Principles

1. **Authorization before intelligence.** ACL is applied before records, fields, aggregates, and search results are made available to the model.
2. **Evidence over confident guesses.** Live-data answers should identify the sources used and state when results are incomplete.
3. **Plan before mutation.** Write requests become typed action proposals, not direct model-generated side effects.
4. **Least privilege.** Only the tools needed for the current request are exposed to the agent; all tool calls are independently authorized.
5. **One orchestration layer.** AIAgents remains the authority for plans, tool execution, run lifecycle, retries, and agent policies.
6. **Human control.** Users can inspect proposed changes, approve or reject them, stop a run, and understand what has already happened.
7. **No hidden privilege escalation.** A chat conversation, saved prompt, agent profile, or administrator-created template cannot grant a user access they do not otherwise have.
8. **Language-flexible, data-consistent.** The response may be in the user's language, but fields, statuses, currency, date ranges, and calculations must reflect canonical CRM values.
9. **Reusable CRM-native UI.** Link users back to the real CRM record or view; Chat supplements normal navigation rather than replacing every detailed UI.
10. **Observable and cost-bounded.** Track latency, token usage, tool results, errors, cancellations, and approximate costs using existing observability conventions.

---

## 3. Scope and Non-Goals

### 3.1 In scope

- Full-page Chat workspace and an optional compact global launcher, if consistent with the existing UI shell.
- Conversation and message lifecycle.
- Streaming assistant responses and structured status events.
- Natural-language request routing into the `AIAgents` runtime.
- CRM read/search/summarization/aggregation through typed tools and platform services.
- Cross-module evidence collection and citations.
- Help/document retrieval, if a suitable document or knowledge source exists.
- Action proposals, previews, confirmation/rejection, and result summaries.
- Approval checkpoints for multi-step runs.
- Conversation history, search, rename, archive, feedback, and configurable retention.
- Saved prompts and role/team-aware prompt suggestions.
- Admin settings for enablement, model policy references, limits, feature flags, retention, and allowed action classes.
- ACL enforcement, audit trails, privacy controls, evaluation, and operational monitoring.

### 3.2 Out of scope for the initial release

- Creating a new general-purpose agent runtime inside `CRMChat`.
- Replacing the `AIAgents` tool registry, provider gateway, tool executor, memory service, or agent evaluation system.
- Giving the model arbitrary SQL, shell, JavaScript, Python, browser automation, or unrestricted HTTP access.
- Automatically executing destructive operations, permission changes, credential management, refunds, payments, invoices issuance, mass messaging, or other high-impact actions without the domain's normal approval and authorization process.
- Replacing module-specific detail pages, reports, saved views, or workflow builders.
- Exposing all CRM records to a vector index or model context without ACL-aware filtering.
- Making the CRM Chat a public customer portal chatbot in the first release. Public Portal chat would need a separate threat model, identities, rate limits, allowed corpus, and tenant boundaries.
- Training/fine-tuning a model on CRM conversations by default.
- Guaranteeing a specific model vendor or provider.

### 3.3 Future optional scope

- Voice interaction using `VoiceCommunications` infrastructure.
- Contextual chat panel inside entity detail pages.
- Portal-facing customer self-service assistant with an isolated, explicitly allowed tool set.
- Proactive briefings and scheduled digests.
- Rich charts, exportable analysis artifacts, and generated reports.
- Multimodal inputs, subject to secure attachment scanning and per-user access checks.

---

## 4. Architecture and Module Boundaries

### 4.1 `CRMChat` responsibilities

- Authenticated conversational API and UI.
- Conversation ownership and visibility.
- Message persistence and ordering.
- Chat turn lifecycle and streaming transport.
- Conversation context selection and safe context references.
- Citation/evidence presentation and feedback.
- Action proposal rendering and confirmation UX.
- Integration with the AIAgents runtime and approved CRM query tools.

### 4.2 `AIAgents` responsibilities

Audit the implemented module and use its real contracts. The expected responsibility boundary is:

- Agent configuration/versioning and model/provider policies.
- Agent execution plans and multi-step runtime.
- Tool registry, tool schemas, tool invocation, and tool result handling.
- Run status, retries, checkpoints, cancellation, and execution traces.
- Approval policies and durable approval requests, if already implemented.
- Agent-level evaluations and safety policies.
- Provider credential and usage management, if already implemented there.

If one of these capabilities is missing, add it to the module that owns the capability or expose a well-defined shared service. Do not implement competing copies in Chat.

### 4.3 CRM data access boundary

Chat must call typed CRM tools backed by existing application services. Examples include:

- `crm.searchRecords`
- `crm.getRecordSummary`
- `crm.listRecords`
- `crm.aggregateRecords`
- `crm.getRelatedRecords`
- `crm.getTimeline`
- `crm.getSavedReport` (only if reports API/ACL supports it)
- `crm.createTaskProposal`
- `crm.proposeRecordUpdate`
- `crm.proposeCaseAssignment`
- `crm.proposeFollowUpPlan`

Names are conceptual. The repository audit must map them to existing tool conventions or register equivalents through AIAgents. No tool may expose arbitrary raw SQL.

### 4.4 Context and execution flow

1. Authenticate the user and verify access to the conversation.
2. Build a minimal request context: user ID, roles/teams, locale, timezone, current page/entity context if available, selected allowed references, and policy version.
3. Ask AIAgents to classify the request as help retrieval, CRM read, analysis, action proposal, or multi-step workflow.
4. Resolve the required tools; apply server-side allowlists and user authorization before tools run.
5. Execute read tools or start a governed AIAgents run.
6. Collect tool outputs with provenance, timestamps, record URLs, permission-filtering status, and query assumptions.
7. Have the model compose the answer from verified outputs; never allow the model to replace factual tool output with invented values.
8. Stream answer segments, tool progress, citation references, and approval-required events to the UI.
9. Persist final messages and safe references to execution traces.
10. For proposed writes, display a preview and obtain confirmation; revalidate permissions, record versions, and action policy at commit time.

### 4.5 Architectural requirements

- Use interfaces and DTOs to avoid a hard dependency from CRMChat on provider SDKs.
- Keep domain logic out of React components and controllers.
- Keep API response/error formats consistent with `/api/v1`.
- Use existing Jobs/Redis/BullMQ where asynchronous long-running operations require it.
- Use existing notification services for approval/completion notifications when available.
- Use existing audit, logging, localization, metadata, and ACL services.
- Use the existing database and migrations framework, expected to be PostgreSQL with Kysely unless repository audit confirms another established implementation.

---

## 5. Functional Requirements

### 5.1 Conversational interaction

- Create, list, open, rename, archive, and delete/soft-delete conversations according to retention policy.
- Append user and assistant messages in deterministic order.
- Support multi-turn follow-up, e.g. “Only show the ones assigned to me.”
- Stream partial responses where supported; show a clear running state when not streaming.
- Show tool progress in user-safe language without exposing private system prompts, secrets, internal reasoning traces, or sensitive implementation details.
- Allow stop/cancel on the current turn and propagate cancellation to AIAgents/jobs.
- Handle provider timeout, context overflow, rate limit, invalid output, tool failure, and partial completion gracefully.
- Preserve conversation when a client disconnects; allow the user to reconnect to a still-running turn if the backend supports it.
- Prevent duplicate turns when the client retries the same submission by using an idempotency key.

### 5.2 Language and localization

- Support at minimum Vietnamese and English user messages.
- Respect user locale and timezone settings when rendering dates, times, decimals, and currencies.
- Store canonical timestamps and numeric values; localize only for presentation.
- Clarify ambiguous date phrases such as “this month” using the user's configured timezone and make the interpreted period visible for analytical queries.
- Allow admins to configure default language behavior but do not change underlying record values based on output language.

### 5.3 CRM help and how-to answers

- Answer “how do I” questions from curated internal help, field descriptions, approved module documentation, and admin-approved reference content.
- Cite the help article/document or configuration source used.
- If a feature/module is disabled or unavailable, state that fact rather than fabricate UI steps.
- Prefer actual in-product metadata and routes over stale static documentation where possible.
- Treat retrieved documents as untrusted content and never follow instructions embedded inside a document that conflict with system security rules.
- Do not index secrets, environment files, raw credentials, or restricted administrative settings into the help corpus.

### 5.4 Live CRM querying

Users can ask for individual records, lists, statistics, trends, and summaries. The implementation must support the approved capabilities present in the repository, not assume every planned module is complete.

- Search and retrieve permitted entities and fields.
- Apply filters, sorting, pagination, and explicit date ranges.
- Provide aggregate answers only when the query tool returns a verified aggregate.
- Respect field-level masking and record-level ACL on list, search, related-record, aggregate, and citation paths.
- Limit result counts and summarize large results instead of putting unbounded records in the prompt.
- Make query assumptions explicit, including date window, status definition, currency conversion rule, and whether results are partial.
- Link citations to existing CRM record detail/list routes only after confirming the current user has access.
- If the relevant field, relation, definition, or data is missing, ask a targeted clarification or state the limitation.
- When data changes during a conversation, do not assume the previous result remains fresh; re-query when freshness matters.

### 5.5 Cross-module analysis

- Support only declared, schema-aware query paths and relationships.
- Use module APIs/domain services for business-specific computed data, such as Sales financial totals, CustomerSuccess health scores, ServiceDesk SLA status, and MarketingAutomation attribution.
- Do not independently recalculate domain values in Chat if a canonical domain service exists.
- Do not mix currencies or reporting periods without declaring the calculation rule.
- Apply authorization before computing counts, ranks, and aggregates to prevent inference through hidden records.
- Return traceable evidence such as “based on 12 visible accounts” and a query timestamp.
- If one source module is unavailable, either return a clearly partial answer or ask whether to continue with the available modules.

### 5.6 Actions and workflows

- Convert requested mutations into typed, allowlisted action proposals.
- Show action type, target records, before/after values, scope, side effects, and any skipped items before confirmation.
- Require explicit user confirmation by default for all writes. Admins may permit bounded, low-risk actions to run automatically only through a narrowly scoped policy; never use model confidence alone as permission.
- Recheck user ACL, field permissions, record version, business validation, approval policies, and action expiry immediately before execution.
- Bind a confirmation to the exact proposal hash, user, conversation, target IDs, record versions, and expiry; changes to the proposal require new confirmation.
- Use domain services so normal validation, hooks, automation, audit, and notifications run.
- Use idempotency keys for action execution and safe retry.
- Summarize completed, failed, skipped, and pending steps separately.
- For bulk operations, show a count and a representative preview; require stronger confirmation at configured thresholds.
- If partial execution is possible, explain which actions are committed and which are still pending. Do not promise atomicity across modules/external systems when it is not available.
- Never create a fake success response when a tool failed or returned an unknown result.

### 5.7 Feedback and continuous improvement

- Allow thumbs-up/down and optional categorical feedback.
- Feedback must not automatically train a production model or change tool permissions.
- Store feedback with an appropriate privacy policy, retention period, and access control.
- Use sanitized examples for offline evaluation; restrict raw conversation review to authorized administrators under audit.

---

## 6. User Experience Requirements

### 6.1 Chat workspace

Required layout:

- Conversation sidebar with recent history, search, rename, archive, and new conversation.
- Main message thread with user/assistant distinction, timestamps, streaming state, and retry controls.
- Composer supporting multiline prompts, send/cancel, and suggested prompts.
- Sources/citations panel or expandable evidence section.
- Tool/action progress timeline suitable for non-technical users.
- Approval card for proposed actions, with explicit Confirm and Cancel/Reject controls.
- Error states with actionable messages and request/reference IDs, but no secrets or stack traces.

### 6.2 Message rendering

- Safely render Markdown, tables, lists, code snippets, charts, and structured results where supported by the UI component system.
- Sanitize HTML and disallow script execution, unsafe URLs, inline event handlers, and unsafe embedded frames.
- Render CRM citations as clickable links only when the URL is generated by trusted application code and current ACL is checked.
- Display source labels, data as-of time, and partial-result warnings.
- Keep raw tool traces behind an authorized diagnostics view; never display chain-of-thought or hidden model reasoning.

### 6.3 Empty states and suggested prompts

- Suggestions should depend on the user's role, available modules, permissions, and currently selected record if one exists.
- Example prompt categories: “My work”, “Sales pipeline”, “Customer health”, “Open support cases”, “Marketing performance”, “Create a follow-up plan”.
- Do not expose sensitive names or metrics in suggestion text if the user cannot view the underlying data.
- Keep templates as prompt aids, not executable scripts or sources of authorization.

### 6.4 Accessibility and responsive behavior

- Keyboard navigation, focus handling, accessible labels, readable contrast, reduced-motion behavior, and screen-reader status updates.
- Handle viewport changes and smaller screens without hiding action previews or citations.
- Ensure the user can stop generation and reach approval buttons using keyboard navigation.

---

## 7. Data Model and Persistence

The precise schema must follow existing conventions discovered in Phase 19-CHAT.0. Prefer the Entity Engine for normal CRM entities and dedicated tables only where high-write-volume conversation storage or event ordering justifies them.

### 7.1 Proposed entities/tables

Names are illustrative; do not duplicate existing AIAgents conversation, memory, or run tables without a documented reason.

#### `crm_chat_conversation`

- `id`
- `name` / `title`
- `owner_user_id`
- `team_id` or access scope, only if shared conversations are explicitly supported
- `status` (`active`, `archived`, `deleted` or repository-equivalent)
- `last_message_at`
- `created_at`, `updated_at`
- `retention_expires_at` if retention policy requires it
- `metadata` as validated JSON for non-sensitive UI state only

Rules:
- Default visibility is private to the owner.
- Sharing must be an explicit, audited feature; never infer access from team membership.
- Index owner/status/updated timestamp for list queries.

#### `crm_chat_message`

- `id`
- `conversation_id`
- `sequence_number` or another deterministic ordering key
- `role` (`user`, `assistant`, `system_event` where appropriate)
- `content` or structured parts
- `status` (`pending`, `streaming`, `complete`, `failed`, `cancelled`, `partial`)
- `turn_id`
- `agent_run_id` nullable, referencing AIAgents execution when present
- `created_at`, `completed_at`
- `content_format_version`
- `redaction_status`/metadata where needed

Rules:
- Avoid storing hidden reasoning traces or secrets in message content.
- Persist user-visible text and approved source/action references, not every internal provider token by default.
- Define whether partial output survives failed turns and how it is marked.

#### `crm_chat_turn`

- `id`
- `conversation_id`
- `user_message_id`
- `assistant_message_id` nullable
- `client_idempotency_key`
- `status`
- `agent_run_id` nullable
- `started_at`, `finished_at`, `cancelled_at`
- `error_code` and safe error summary
- `usage_event_id` nullable if usage events are managed elsewhere

Rules:
- Enforce uniqueness for `(conversation_id, client_idempotency_key)` where key is provided.
- Do not duplicate AIAgents run details; store the reference and the minimum UI lifecycle state.

#### `crm_chat_citation`

- `id`
- `message_id`
- `source_type` (`crm_record`, `query_result`, `report`, `help_document`, `approved_external_source`)
- `source_ref` / opaque source identifier
- `display_label`
- `safe_route` or route-generation key, not a caller-provided arbitrary URL
- `retrieved_at`
- minimal evidence metadata needed to reconstruct citation rendering

Rules:
- Reauthorize each citation before revealing labels or opening target routes.
- Do not persist unrestricted snapshots of sensitive records in citations.

#### `crm_chat_feedback`

- `id`, `message_id`, `user_id`
- `rating`, `category`, `comment` (optional)
- `created_at`
- privacy/retention metadata where required

#### `crm_chat_saved_prompt`

- `id`, `name`, `prompt_template`, `description`
- `owner_user_id` or published scope
- `allowed_roles`/visibility metadata only if supported by ACL conventions
- `enabled`, `created_at`, `updated_at`

Rules:
- Templates are data, not executable code.
- Do not put credentials, hidden system prompts, or unchecked tool permissions in templates.

#### Optional `crm_chat_usage_event`

Only add this table if usage accounting in AIAgents does not already support the required user-facing reporting. Otherwise reference the established usage event.

- `id`, `conversation_id`, `turn_id`, `agent_run_id`
- provider/model identifiers safe for administrators
- input/output token counts where available
- estimated cost in canonical decimal form, currency, pricing-version reference
- latency, outcome, created_at

Never use client-submitted values as authoritative cost/usage values.

### 7.2 Data lifecycle and deletion

- Define soft-delete/archive behavior separately from permanent retention deletion.
- Keep action audit records according to audit policy even when the visible conversation is deleted, while removing or redacting conversation content as required.
- Do not delete associated CRM records when a chat conversation is deleted.
- Expiration jobs must be idempotent, scoped, and use narrow predicates.
- Provide admin-configurable retention defaults and document legal holds if supported by the system.

---

## 8. API Contract

All endpoints must follow existing `/api/v1` authentication, request validation, pagination, and response conventions. The following paths are illustrative and must be adapted to established route patterns.

### 8.1 Conversation endpoints

- `GET /api/v1/crm-chat/conversations` — list conversations visible to the current user.
- `POST /api/v1/crm-chat/conversations` — create a conversation.
- `GET /api/v1/crm-chat/conversations/:id` — get conversation metadata.
- `PATCH /api/v1/crm-chat/conversations/:id` — rename/archive or update allowed metadata.
- `DELETE /api/v1/crm-chat/conversations/:id` — soft-delete according to policy.
- `GET /api/v1/crm-chat/conversations/:id/messages` — paginated message history and citations.

### 8.2 Turn endpoints

- `POST /api/v1/crm-chat/conversations/:id/turns` — submit a user message with idempotency key and optional approved context references.
- `GET /api/v1/crm-chat/turns/:turnId` — read turn status and current safe output.
- `GET /api/v1/crm-chat/turns/:turnId/events` — authenticated streaming endpoint (SSE or the repository's existing streaming mechanism).
- `POST /api/v1/crm-chat/turns/:turnId/cancel` — cancel the current turn and propagate cancellation to the agent run if supported.
- `POST /api/v1/crm-chat/messages/:messageId/feedback` — submit feedback.
- `GET /api/v1/crm-chat/conversations/search` — search current user's visible conversation history.

### 8.3 Action/approval endpoints

Prefer using AIAgents approval APIs when they exist. The Chat endpoints should reference and present the approval rather than create a parallel approval engine.

- `GET /api/v1/crm-chat/actions/:proposalId` — get an authorized proposal summary.
- `POST /api/v1/crm-chat/actions/:proposalId/confirm` — confirm the exact proposal, after authentication and revalidation.
- `POST /api/v1/crm-chat/actions/:proposalId/reject` — reject/cancel the proposal.

If approval objects are owned by AIAgents, use its route or a thin Chat façade; do not create competing records with ambiguous authority.

### 8.4 Administration endpoints

Only where the repository's module configuration conventions require module-owned routes:

- Read/update Chat feature flags, retention, limits, default suggested prompts, tool policy references, and availability by role.
- View aggregate usage/health metrics subject to admin ACL.
- Never reveal provider API keys or secret values after saving; expose connection health and masked metadata only.

### 8.5 API behavior

- DTO-validate all user and client-controlled input.
- Validate IDs, conversation ownership, message length, context reference count, and attachment size/type.
- Use stable error codes such as `CHAT_CONVERSATION_NOT_FOUND`, `CHAT_PERMISSION_DENIED`, `CHAT_TURN_CANCELLED`, `CHAT_AGENT_UNAVAILABLE`, `CHAT_APPROVAL_REQUIRED`, `CHAT_RATE_LIMITED`, and `CHAT_CONTEXT_TOO_LARGE`.
- Do not reveal whether a record exists when the user is not authorized to access it; return the repository's appropriate not-found/forbidden behavior.
- Document every endpoint in OpenAPI and cover it with auth/ACL tests.

---

## 9. Streaming and Turn Lifecycle

### 9.1 Streaming event contract

Use Server-Sent Events if compatible with the existing NestJS HTTP adapter and infrastructure. NestJS supports SSE routes using an observable event stream; follow the version installed in the repository and its proxy/runtime constraints. If the app already uses WebSockets or another standardized transport, use that existing mechanism instead of adding a second one.

Proposed event types:

- `turn.started`
- `assistant.delta`
- `assistant.message`
- `tool.started` (user-safe summary only)
- `tool.progress`
- `citation.added`
- `action.proposed`
- `approval.required`
- `run.checkpoint`
- `turn.completed`
- `turn.failed`
- `turn.cancelled`
- `usage.summary`
- `heartbeat`

### 9.2 Streaming requirements

- Authenticate and authorize event subscriptions.
- Avoid publishing internal tool arguments, sensitive tool output, provider request bodies, secrets, hidden prompts, or chain-of-thought.
- Reconnect using supported event IDs or a turn-state endpoint so the client can recover after a network drop.
- Send heartbeat events and terminate abandoned streams according to infrastructure limits.
- Do not depend on a browser connection to keep a durable multi-step agent run alive.
- Separate the turn's durable status from a single HTTP stream connection.

### 9.3 Turn state machine

Expected states: `accepted`, `running`, `waiting_approval`, `completed`, `partial`, `failed`, `cancel_requested`, `cancelled`.

Rules:
- State transitions must be validated on the server.
- A terminal state must not transition back to `running`.
- Cancellation may be best-effort for an in-flight external operation; the UI must reflect whether a step already completed.
- Retry creates a new turn or explicit retry attempt linked to the original; it must not silently duplicate write actions.

---

## 10. Query Planning, Grounding, and Citations

### 10.1 Safe query-plan DSL

The model may propose a query plan but cannot define arbitrary SQL. The server validates the plan against an allowlisted schema and supported query operators before a tool executes it.

A validated plan may contain:

- entity and declared relation identifiers
- allowlisted field projections
- allowlisted filter operators and typed values
- sort fields and bounded limits
- allowed aggregate functions
- explicit reporting period and timezone
- canonical domain-service operations for computed values

It must not contain arbitrary joins, raw SQL snippets, dynamic table names, executable expressions, unbounded recursive traversals, or functions selected from untrusted input.

### 10.2 Answer grounding

For factual answers based on CRM data:

1. Collect actual tool results.
2. Attach provenance metadata and timestamp to each result.
3. Calculate aggregate values in trusted query/domain services, not in free-form model prose.
4. Ask the model to explain the result and cite source references.
5. Validate that every citation maps to a source that was actually retrieved.
6. Render trusted links in the client after ACL checks.
7. Label assumptions, missing data, stale data, or partial results.

### 10.3 Aggregates and financial facts

- Use canonical values from Sales and other domain services.
- Preserve decimal precision and currency semantics.
- Never total mixed currencies without an explicit exchange-rate source/date and supported conversion policy.
- Follow fiscal-calendar configuration if the CRM supports it; otherwise state the calendar assumptions.
- Do not infer a value as zero merely because it is absent or inaccessible.
- Do not leak counts from restricted records through summaries or group-by operations.

### 10.4 Context size controls

- Retrieve only records needed for the current request.
- Prefer server-side aggregation and small summaries over raw lists.
- Truncate and summarize long text at safe boundaries while preserving source IDs and provenance.
- Use existing token/context estimation and limits if AIAgents provides them.
- If the request exceeds the supported scope, ask the user to narrow it or run a bounded asynchronous job.

---

## 11. Action Safety and Human Approval

### 11.1 Risk classes

Define action risk centrally, preferably in AIAgents' existing policy/approval system.

| Risk class | Example | Default policy |
|---|---|---|
| Read-only | Search a contact, summarize a project | Allowed only through user-authorized read tools |
| Low-impact write | Create one draft task, add a draft note | Preview and explicit confirmation by default; optional auto-execution only through admin policy |
| Medium-impact write | Reassign a case, update several records | Preview, explicit confirmation, target count and before/after diff |
| High-impact or external | Send a marketing campaign, send external communications, issue/void an invoice, change subscription/payment state | Block from direct execution or require the domain's strong approval workflow; never use chat confirmation alone if policy requires additional approval |
| Destructive/security-sensitive | Delete many records, change ACL/roles, expose credentials, erase audit data | Not available as a general chat action; route to the normal protected admin workflow or deny |

### 11.2 Proposal format

Every write proposal should provide:

- action name and human-readable purpose
- requesting user and originating conversation/turn
- affected entity types and record IDs
- exact proposed changes, before/after values where available
- number of records affected
- expected side effects (notifications, emails, workflow triggers, integrations)
- domain validation result
- required approval level and expiration
- immutable proposal hash or equivalent binding mechanism

### 11.3 Confirmation flow

1. Agent proposes the typed action.
2. Server validates schema, target IDs, user permissions, domain constraints, and risk class.
3. UI displays a readable preview and side effects.
4. User confirms or rejects.
5. Server verifies the current user matches the approver and the proposal is unexpired and unchanged.
6. Server re-fetches records and rechecks ACL, field permissions, optimistic version/updated timestamp, and business rules.
7. Domain service executes using an idempotency key.
8. Audit record and AIAgents trace are linked to the chat turn.
9. Chat reports actual outcome and any partial failure.

### 11.4 Bulk and multi-step actions

- Show an explicit target count and criteria for the selection.
- Provide a reviewable affected-record list or a safe sample plus downloadable/inspectable selection if supported.
- Require reconfirmation if the selected set or proposal hash changes.
- Use checkpoints so approved steps can proceed while unapproved steps remain paused.
- Report partial results accurately; do not claim cross-module transactional atomicity where none exists.
- Every external side effect must be separately permissioned and use existing domain/provider adapters.

---

## 12. Security, Privacy, and Trust Model

Security requirements must be threat-modeled before exposing live CRM tools. Use the current OWASP GenAI/LLM guidance as a checklist for prompt injection, sensitive information disclosure, excessive agency, unbounded consumption, misinformation, and output handling. The checklist complements—not replaces—the application's normal authorization and secure coding requirements.

### 12.1 Identity and access control

- Every turn executes in the authenticated user's security context.
- Do not trust user IDs, role names, team names, allowed entity lists, or permissions supplied by the browser or model.
- Apply ACL to each individual tool call and every data retrieval path.
- Enforce field-level access in prompts, tool outputs, citations, aggregates, exports, and cached summaries.
- Recheck ACL after role/team changes and before an action is committed.
- Default conversations to private to the owner. Shared conversations must be explicit, read-only by default, and audited.
- Avoid storing accessible-to-all caches of personalized CRM responses.

### 12.2 Prompt injection and untrusted data

- Treat user instructions, retrieved emails, notes, descriptions, web pages, uploaded documents, and tool result strings as distinct trust classes.
- Retrieved CRM content cannot instruct the system to call additional tools, reveal secrets, or ignore system policies.
- Tool authorization and input validation are enforced outside the LLM.
- Keep tool schemas narrow and do not expose unused tools to the current run.
- Do not allow model-generated HTML/URLs to execute or redirect to untrusted hosts.
- Test direct prompt injection, indirect prompt injection in CRM notes/attachments, tool-output poisoning, and attempts to exfiltrate system prompts or credentials.

### 12.3 Sensitive data and provider controls

- Minimize the personal/customer data passed to third-party model providers.
- Support admin policy for approved providers/models and whether sensitive fields may be sent externally.
- Prefer redaction/tokenization for identifiers not needed to answer the question.
- Document data retention and provider processing assumptions; do not claim a provider has zero retention unless verified contractually and technically.
- Encrypt provider credentials with the existing secret-management mechanism; never put secrets in conversation records.
- Apply retention and deletion policy to conversation messages, citations, summaries, and feedback.

### 12.4 Abuse and resource limits

- Per-user and per-team rate limits.
- Max message length, conversation context size, tool calls per turn, records returned, runtime duration, and concurrent runs.
- Daily/monthly usage budgets where the platform supports them.
- Circuit breaker and timeout for unavailable providers.
- Cancellation and bounded retries.
- Detect tool-call loops and repeated equivalent queries.
- Do not create a bypass where deleting and recreating conversations removes usage restrictions.

### 12.5 Output safety

- Schema-validate any structured model output before use.
- Sanitize rendered Markdown/HTML and restrict link protocols and target hosts.
- Do not deserialize or execute model-produced code.
- Validate generated chart/table specs against a safe schema.
- Handle unsupported claims by asking for clarification or reporting a limitation rather than inventing source evidence.

### 12.6 Auditability

Audit at least:

- conversation creation/deletion/sharing and access changes
- requested action proposals and their hashes
- approver identity, decision and timestamp
- each mutation tool's actual target IDs and outcome
- denied tool calls and policy violations
- agent run IDs, trace correlation IDs, and safe error codes
- administrator configuration changes

Audit logs must not store unrestricted prompt contents by default. Use redaction, controlled diagnostic access, and retention rules.

---

## 13. Configuration and Administration

Provide an admin configuration surface only for settings that are not already owned by AIAgents or the platform.

Potential settings:

- Feature enabled/disabled globally and by role/team.
- Which agent profile is the default CRM assistant.
- Allowed tools/tool groups, referenced from AIAgents policy rather than duplicated.
- Read/write action classes available in Chat.
- Maximum input length, result count, context size, turn duration, concurrent runs, and request rate.
- Conversation retention and whether feedback is enabled.
- Default suggested prompts and approved help sources.
- Streaming transport settings and safe reconnect behavior.
- Provider/model selection only if owned by AIAgents; otherwise link administrators to the existing owner screen.
- Feature flag for cross-module analytics and separately gated write actions.

Requirements:
- Configuration is validated and audited.
- Secret values are write-only and masked after saving.
- Changes affecting permissions or retention apply consistently to future operations and, where appropriate, existing sessions.
- Disabled modules/tools are not advertised as available capabilities.

---

## 14. Integration Contracts

### 14.1 `AIAgents`

Mandatory core integration. CRMChat should:

- Submit the message, safe context references, and authenticated user context to an approved agent profile.
- Receive turn/run IDs, progress events, tool status summaries, safe citations, proposals, approval requirements, and final result.
- Cancel runs and resume status subscriptions using the AIAgents contract.
- Use existing provider, tool registry, cost tracking, runtime, safety, and evaluation features.
- Avoid requesting or rendering private chain-of-thought or hidden agent analysis.

If the existing implementation lacks a stable public contract, Phase 19-CHAT.1 must document one before UI work proceeds.

### 14.2 Core CRM services

- **Entity Engine / Metadata:** entity/field definitions, safe filters, serialization and relations.
- **ACL:** per-user, record, and field authorization.
- **Search:** global search or approved semantic search.
- **Reports:** execute existing saved/authorized reports when supported; do not duplicate report formulas.
- **Activities/Calendar:** propose and create tasks/meetings through existing services.
- **Notifications:** alert on long-running runs or approval outcomes where appropriate.
- **Jobs:** durable work, retention, indexing, and bounded asynchronous operations.
- **Attachments/Documents:** resolve only authorized references; enforce file type, size, and scanning policy.
- **Audit/History:** record actual mutations and approval decisions.

### 14.3 Business modules

Integrate only with capabilities that are implemented and enabled:

- `Sales`: opportunities, quotes, orders, invoices, payments, subscriptions, and domain-calculated commercial metrics.
- `Projects`: projects, milestones, tasks, deadlines, and workload summaries.
- `CustomerSuccess`: health, risks, onboarding, success plans, and renewal readiness.
- `ServiceDesk`: cases, queues, SLA and ticket history.
- `MarketingAutomation`: campaign/segment/performance data, with consent and campaign-sending actions strongly gated.
- `VoiceCommunications`: call logs, transcripts, and approved communication history.
- `AdvancedIntegrations`: external sync status only through its authorized APIs.
- `Portal`: not used as an identity bypass; portal-specific Chat is separate future scope.

The absence of one module must not break Chat for other modules. Tool discovery should report available capabilities based on registry and permissions at runtime.

---

## 15. Performance, Reliability, and Operations

### 15.1 Performance goals

Set final SLAs after measuring the repository and selected providers. Initial targets for design/evaluation, not guarantees:

- Conversation list and history should respond quickly using indexed local data and pagination.
- A first streaming status event should be delivered promptly after request acceptance.
- Retrieval should use bounded queries and not fetch entire entity tables.
- Long-running analysis should continue in durable job/runtime infrastructure and allow the client to reconnect.
- Do not hold a database transaction open while waiting for an LLM or external provider.

### 15.2 Reliability

- Use idempotency keys for submitted turns and write actions.
- Use explicit timeouts for provider and tool calls.
- Retry transient failures only where operations are safe to retry.
- Store enough status to resume progress after process restart if AIAgents supports durable runs.
- Ensure event ordering and terminal state persistence are consistent.
- Handle race conditions such as double-click submit, double confirmation, role revocation during a run, or conversation deletion during execution.

### 15.3 Observability

Record metrics such as:

- requests/turns by status and safe error code
- time to first event and total duration
- provider latency and tool latency
- tool count and failed tool count
- tokens and estimated spend when supported
- cancellation rate and approval wait time
- citation coverage and user feedback
- denied access attempts and safety-policy triggers

Use request/turn/agent-run correlation IDs. Logs must be structured and avoid sensitive content by default.

### 15.4 Operational runbooks

Document how to:

- disable Chat globally or disable a specific agent/tool
- respond to provider outage/rate limits
- inspect a failed run without exposing sensitive prompt content
- cancel a stuck execution
- rotate/revoke provider credentials via the owning module
- handle unexpected cost spikes
- respond to a potential data disclosure or prompt-injection incident
- change retention settings and safely process expiration jobs

---

## 16. Testing and Evaluation Strategy

Follow `AGENTS.MD` exactly. Never add setup code that creates a new database or resets the configured primary database.

### 16.1 Unit tests

Cover:

- conversation and turn state transitions
- DTO validation, message limits, idempotency keys
- ownership and sharing policies
- query-plan validation and field allowlists
- citation reference validation and URL generation
- action proposal hash, expiry, confirm/reject, and stale-record detection
- redaction, safe error mapping, and retention calculation
- sanitization of rendered content
- usage limit and tool-call budget logic

### 16.2 Integration tests

Using the existing configured database only for safe targeted tests:

- migrations are additive and preserve current data
- conversation isolation between users
- message ordering under concurrent requests
- record and field ACL enforced in search, aggregate, citation, and follow-up paths
- AIAgents contract integration with a fake provider/tool runtime
- SSE or chosen streaming transport handles reconnect and cancellation
- approved action calls existing domain services and audit hooks
- expired or altered approvals cannot execute
- background cleanup touches only eligible expired Chat records

Use uniquely marked `AGENT_TEST_...` records. Do not run real emails, calls, SMS, campaign sends, payments, or external API writes. Cleanup only exact records created by the current test run.

### 16.3 End-to-end scenarios

1. User asks a help question and sees a citation to an approved article.
2. User asks for their open opportunities and receives authorized results with record links.
3. User asks for aggregate statistics and receives an explicit reporting period and validated totals.
4. User asks about an entity they cannot access; Chat does not disclose the existence or fields of that entity.
5. A user requests a task creation; Chat previews it, waits for confirmation, creates exactly one task, and reports the actual result.
6. User changes a record's permissions before confirming an action; confirmation is denied after revalidation.
7. A malicious CRM note asks the model to reveal secrets or call tools; the instruction is ignored and no unauthorized tool runs.
8. The client disconnects during a long-running run and reconnects to the correct status without creating a duplicate action.
9. The provider times out or rate-limits; Chat returns a safe error and does not fabricate a response.
10. A request spans unavailable modules; Chat explains which data was analyzed and what could not be queried.
11. Conversation deletion/retention follows the documented policy while preserving necessary immutable audit records.
12. A user cannot read another user's conversation or its cached summary/citations.

### 16.4 Evaluation set

Build a versioned, sanitized evaluation set including:

- Vietnamese and English prompts
- ambiguous dates, statuses, currencies and names
- follow-up questions and pronoun resolution
- ACL denial and field masking
- record lookup and aggregate correctness
- cross-module join correctness
- prompt injection via notes, emails, and attachments
- write-preview correctness and approval-gate behavior
- hallucinated citation detection
- cancellation, retries, and partial failures

Evaluate factual correctness, evidence/citation validity, permission compliance, action safety, helpfulness, latency, and cost. Do not use production customer conversations as evaluation data without explicit governance and redaction.

---

## 17. Delivery Roadmap

Implement the phases sequentially. Do not start later phases before the repository audit and required interface decisions are recorded. The specific numbers are planning identifiers and do not change the broader `PLAN.md` numbering.

### Phase 19-CHAT.0 — Repository Audit and Capability Inventory

**Tasks**
- Inspect `PLAN.md`, `AGENTS.MD`, `AIAgents`, provider gateway, tool registry, run APIs, approvals, memory/context, usage tracking, search, entity access, global navigation, streaming infrastructure, notification/jobs, and frontend layout conventions.
- Inspect real database migrations and identify existing conversation/message/run tables.
- Inspect current API response envelopes, DTO validation, auth/ACL middleware, route names, feature flags, and test scripts.
- Identify modules that are implemented versus only planned.
- Inspect tests for accidental test database creation, reset, seed, or external calls.

**Deliverables**
- `docs/architecture/crm-chat-audit.md`
- A capability matrix marking each dependency `available`, `partial`, `missing`, or `not applicable`.
- Explicit decision on reuse of existing conversation storage and AIAgents run/approval contracts.
- A list of blockers and assumptions.

**Acceptance criteria**
- No code or schema changes are made before the audit decision is recorded.
- The audit identifies authoritative owners for agent runtime, tools, usage, approvals, and conversation history.

### Phase 19-CHAT.1 — Product Contract and Threat Model

**Tasks**
- Specify supported intents: help retrieval, CRM search, record summaries, aggregates, cross-module analysis, action proposals, and multi-step workflows.
- Specify conversation ownership, visibility, retention, and sharing behavior.
- Define request/response DTOs, stream event schema, citation contract, error codes, action proposal contract, and cancellation behavior.
- Threat-model direct/indirect prompt injection, unauthorized retrieval, stale permissions, context leakage, hallucinated citations, excessive agency, XSS, unbounded consumption, and provider data handling.
- Define MVP feature flags and a set of blocked action classes.

**Deliverables**
- `docs/architecture/crm-chat-contract.md`
- `docs/security/crm-chat-threat-model.md`
- Versioned TypeScript/OpenAPI contract proposal.

**Acceptance criteria**
- API, event stream, AIAgents integration, permission model, and action confirmation are agreed before implementation proceeds.

### Phase 19-CHAT.2 — Module Registration and Navigation Shell

**Tasks**
- Register `CRMChat` according to the existing module/extension convention.
- Add feature flag, module metadata, route/navigation entry, permissions, translations, and health/diagnostic wiring as supported.
- Add a module shell with loading, empty, disabled, and error states.
- Do not add a second global AI settings surface if AIAgents already owns model/provider setup.

**Acceptance criteria**
- Authorized users can open the Chat workspace shell.
- Unauthorized users cannot access the route or API directly.
- Disabled Chat is absent from navigation and enforced server-side.

### Phase 19-CHAT.3 — Additive Persistence and Migration

**Tasks**
- Map the logical schema in Section 7 to existing storage patterns.
- Reuse AIAgents conversation/message storage if it already serves the same source-of-truth purpose; add only Chat-specific fields/tables that are genuinely necessary.
- Create additive migrations for conversations, messages/turns, citations, and feedback only as needed.
- Add indexes, uniqueness constraints, foreign keys, and retention indexes.
- Review every migration before applying it to the configured database.

**Acceptance criteria**
- Migration is versioned, additive, and does not wipe, rename, or change meaning of existing data.
- Concurrent duplicate turn submissions are prevented by a reliable idempotency mechanism.
- No test database/schema is created.

### Phase 19-CHAT.4 — Conversation and Message APIs

**Tasks**
- Implement conversation create/list/get/rename/archive/delete according to repository conventions.
- Implement paginated message history with deterministic ordering.
- Enforce owner visibility, limits, validation, soft-delete/retention policy, and safe serialization.
- Add optimistic concurrency or transaction behavior for message sequence assignment.

**Acceptance criteria**
- Two users cannot read or mutate one another's private conversations.
- Repeated client submissions using the same idempotency key do not create duplicate turns.
- Message history is paginated and stable under concurrent requests.

### Phase 19-CHAT.5 — AIAgents Integration Adapter

**Tasks**
- Implement a narrow `AIAgentsClient`/application service adapter based on the audited contract.
- Pass authenticated principal context, allowed context references, locale/timezone, conversation references, and request correlation ID.
- Receive run ID, status, user-safe progress, citations, action proposals, approval state, safe errors, and final results.
- Propagate cancellation and subscription/reconnect requests.
- Add contract tests using a fake AIAgents runtime or existing test seam.

**Acceptance criteria**
- Chat does not implement a second planning loop, tool executor, provider gateway, or approval engine.
- Missing/incompatible AIAgents capabilities produce explicit errors and documented integration tasks, not silent stubs.

### Phase 19-CHAT.6 — Streaming and Durable Turn Lifecycle

**Tasks**
- Implement the repository-standard SSE/WebSocket/streaming approach.
- Create and persist turn state before expensive model calls begin.
- Emit status, safe progress, content deltas, citations, action proposal, completion, failure, and cancellation events.
- Add heartbeat, client reconnection/status fetch, timeout, and cancellation.
- Keep durable runs alive independently of a browser connection where the AIAgents runtime supports it.

**Acceptance criteria**
- Stream event ordering is deterministic and does not reveal private tool arguments or hidden reasoning.
- A dropped connection does not duplicate an existing turn or action.
- Terminal turn state is persisted and can be retrieved after reconnect.

### Phase 19-CHAT.7 — Chat Workspace UI

**Tasks**
- Build sidebar/history, message thread, composer, stop/retry controls, streaming states, source citations, progress timeline, and error states.
- Follow existing React, component, state, routing, accessibility, and styling conventions.
- Safely render Markdown and structured messages.
- Support keyboard interactions and responsive layouts.

**Acceptance criteria**
- Core chat flow is usable on supported desktop/mobile viewport sizes.
- Accessibility checks cover focus, labels, status changes, and approval controls.
- No unsafe HTML or untrusted link can execute in the conversation renderer.

### Phase 19-CHAT.8 — Context Selection and Citation Model

**Tasks**
- Define the safe context envelope sent to AIAgents.
- Support optional current-page/entity context only when the user is authorized to view that record.
- Implement citation persistence/rendering and source reauthorization.
- Link evidence to record, list, report, or help routes using trusted route builders.
- Display retrieval time and partial/incomplete context status.

**Acceptance criteria**
- Citations point only to sources returned by authorized tools.
- The model cannot inject arbitrary hyperlinks as trusted CRM citations.
- A citation whose access is revoked is hidden or denied when rendered/opened.

### Phase 19-CHAT.9 — CRM Help Retrieval

**Tasks**
- Audit whether searchable documentation, metadata descriptions, Knowledge Base, or another approved help repository already exists.
- Integrate with that source through existing search/RAG infrastructure where possible.
- If no retrieval engine exists, propose a narrowly scoped index/adapter and its lifecycle; do not index all CRM records as a shortcut.
- Attach source metadata and permission scope to retrieved help content.

**Acceptance criteria**
- Help answers cite approved material and admit when no reliable source is found.
- Disabled/unavailable features are not described as if they exist.
- Retrieved content cannot override system/tool policy.

### Phase 19-CHAT.10 — Read-Only CRM Tools and Safe Query Plans

**Tasks**
- Register or reuse read tools for entity search, record summary, related records, list queries, timelines, and safe aggregates.
- Validate query plans against entity/field/relation metadata and operator allowlists.
- Enforce ACL before retrieving records and before producing aggregate values.
- Bound list sizes and use domain services for calculated fields.
- Generate evidence metadata needed for citations and query explanation.

**Acceptance criteria**
- Read queries never execute model-generated SQL.
- Tests prove record ACL and field ACL apply to detail, list, search, aggregation, and citation output.
- The model cannot reveal records by asking for aggregate counts over forbidden data.

### Phase 19-CHAT.11 — Cross-Module Analysis

**Tasks**
- Define supported cross-module query paths based on existing relations and official module service contracts.
- Integrate canonical calculations from Sales, CustomerSuccess, ServiceDesk, Projects, MarketingAutomation, and VoiceCommunications only where implemented.
- Add query plan limits, execution timeouts, data freshness stamps, and partial-result handling.
- Avoid implicit joins between unrelated entities or unbounded fan-out.

**Acceptance criteria**
- At least three representative cross-module scenarios pass with correct evidence and ACL enforcement.
- Missing modules/data produce a clear partial result or clarification request.
- Financial/currency/date calculations use declared canonical rules.

### Phase 19-CHAT.12 — Action Proposal and Confirmation UX

**Tasks**
- Reuse AIAgents' existing action/approval system.
- Render proposal cards with target count, exact values, before/after diffs, side effects, and approval requirement.
- Implement confirm/reject/cancel controls and proposal-expiry states.
- Revalidate ACL, permissions, field rules, record versions, target sets, and proposal hash server-side.

**Acceptance criteria**
- No write action executes before valid confirmation unless an explicit admin policy permits that exact low-risk action.
- Confirmation by a different user, expired proposal, or modified proposal is rejected.
- The UI reports real outcomes only.

### Phase 19-CHAT.13 — Multi-Step Runs and Approval Checkpoints

**Tasks**
- Submit multi-step requests to AIAgents rather than creating a second orchestrator.
- Render safe plan summaries and progress events.
- Pause/resume on approval checkpoints, propagate cancellation, and display completed/pending/failed steps.
- Support partial completion and safe retries, according to the AIAgents runtime contract.

**Acceptance criteria**
- A multi-step run can pause for user approval and resume only after valid approval.
- Cancellation prevents subsequent unstarted steps from executing where supported.
- Completed external side effects are reported accurately and are not silently repeated on retry.

### Phase 19-CHAT.14 — Conversation Search, Prompt Templates, and Feedback

**Tasks**
- Implement search over the current user's history, with permission/retention-aware matching.
- Implement saved prompts and curated prompt suggestions.
- Implement answer feedback with limits and privacy controls.
- Ensure shared/admin templates do not carry hidden tool permissions or executable payloads.

**Acceptance criteria**
- History search cannot disclose another user's messages.
- Prompt templates are data-only and execute under the current user's authorization.
- Feedback is auditable and cannot automatically change production model behavior or permissions.

### Phase 19-CHAT.15 — Administration, Feature Flags, and Guardrails

**Tasks**
- Add Chat-specific admin settings while linking to existing AIAgents settings for provider/model/tool policy.
- Configure allowed roles, rate limits, length limits, result limits, concurrency, retention, and feature flags.
- Separate read-only analytics and write-action features behind independent switches.
- Document safe emergency disablement.

**Acceptance criteria**
- Disabling a tool or Chat feature is enforced server-side immediately according to documented cache semantics.
- The UI does not advertise unsupported tools or modules.
- Config changes are validated and audited.

### Phase 19-CHAT.16 — Privacy, Security, and Audit Hardening

**Tasks**
- Implement threat-model mitigations from Section 12.
- Add prompt-injection and output-safety tests.
- Verify PII minimization, redaction, safe logging, conversation isolation, and retention.
- Verify action confirmation binding and permission rechecks.
- Verify no direct SQL, shell, arbitrary code, or unrestricted HTTP tools are exposed.

**Acceptance criteria**
- Security test cases in the threat model are passing or have formally documented mitigations/known limitations.
- Sensitive data is not included in logs by default.
- Unauthorized access is denied server-side even if the frontend is bypassed.

### Phase 19-CHAT.17 — Usage, Limits, and Observability

**Tasks**
- Reuse AIAgents usage accounting and add only Chat-specific correlation/reporting fields where necessary.
- Display administrator-only usage summaries if the underlying metrics exist.
- Implement per-user/team limits, bounded retries, timeout, concurrency controls, and safe error mapping.
- Add metrics, logs, correlation IDs, and operational runbooks.

**Acceptance criteria**
- Usage and errors can be correlated to a turn and AIAgents run without logging secrets or unrestricted user content.
- Quotas cannot be bypassed by creating more conversations.
- Provider outage and cost-spike runbooks are documented.

### Phase 19-CHAT.18 — Evaluation and End-to-End Verification

**Tasks**
- Implement unit, integration, contract, UI, and end-to-end scenarios from Section 16.
- Create a sanitized, versioned evaluation set for both Vietnamese and English prompts.
- Test retrieval, aggregates, citations, permissions, prompt injection, write proposals, approvals, cancellation, and partial errors.
- Use fake providers for tests that could send external messages or cause external side effects.

**Acceptance criteria**
- Critical E2E scenarios pass against the actual API and UI.
- No new database/schema is created.
- Test report documents executed checks and any skipped checks.

### Phase 19-CHAT.19 — Release Readiness and Operational Handover

**Tasks**
- Review migrations, module permissions, API docs, translations, UI loading/errors, and rollback/forward-fix plan.
- Verify no debug traces, provider secrets, or generated artifacts were committed.
- Document runtime settings, limits, retention, supported question/action patterns, and safe failure behavior.
- Add release notes and troubleshooting guidance.

**Acceptance criteria**
- All required Definition of Done items in Section 18 are met.
- No unresolved critical security finding remains.
- Operators can disable Chat or a risky tool without destructive database operations.

---

## 18. Definition of Done

The module is not complete until all applicable criteria are satisfied:

- [ ] `CRMChat` is registered following repository naming conventions, with no `Ua` prefix.
- [ ] Repository audit and `AIAgents` integration contract are documented.
- [ ] Existing provider, tool, run, memory, approval, usage, and conversation infrastructure is reused wherever appropriate.
- [ ] Authenticated users can create and resume private conversations.
- [ ] User-facing responses stream or update progressively through the established transport.
- [ ] Vietnamese and English prompts work for the supported evaluation set.
- [ ] Help answers cite approved help sources.
- [ ] Live CRM answers use typed authorized tools and valid citations.
- [ ] Cross-module analysis uses canonical domain calculations and declares assumptions.
- [ ] Write requests are previewed and confirmed by default; sensitive operations use the proper domain approval flow or are blocked.
- [ ] ACL and field-level permission checks run server-side on every retrieval and mutation.
- [ ] Prompt-injection, cross-user leakage, fabricated citation, XSS, duplicate action, stale approval, cancellation, and rate-limit tests are covered.
- [ ] Retention, deletion, feedback, and audit behavior are documented and verified.
- [ ] OpenAPI, translations, UI behavior, operations metrics, and runbooks are updated.
- [ ] Tests did not create extra databases, schemas, containers, or database copies.
- [ ] No real outbound communication, campaign, payment, or external write was triggered by tests.
- [ ] Actual executed checks and known limitations are recorded.

---

## 19. Recommended Initial Release Boundary

Do not attempt every advanced capability in the first coding-agent pass. After Phase 19-CHAT.0 and 19-CHAT.1 establish the real repository capabilities, target this initial vertical slice:

1. Private conversation history and a usable Chat workspace.
2. Integration with the existing AIAgents runtime/provider/tool registry.
3. Read-only help retrieval and authorized CRM record search/summaries.
4. Grounded answers with trusted citations and timestamps.
5. One low-risk write workflow implemented through preview + explicit confirmation, such as creating a follow-up task.
6. Audit, rate limiting, cancellation, safe error handling, and evaluation tests.

Only after that vertical slice passes end-to-end tests should the agent broaden cross-module aggregation, complex multi-step actions, richer charts, or additional tool families.

---

## 20. Reference Material

Use these references for architectural/security guidance, checking current official documentation during implementation. The implementation must still follow the installed library versions and the repository's established contracts.

- Project roadmap: `PLAN.md`
- Coding and database safety rules: `AGENTS.MD`
- Existing agent runtime plan: `PLAN_Phase_19_AI_Agents.md` if present in the repository
- Existing domain plans: `PLAN_Phase_19_Sales.md`, `PLAN_Phase_19_Projects.md`, `PLAN_Phase_19_Customer_Success.md`, `PLAN_Phase_19_ServiceDesk.md`, `PLAN_Phase_19_Marketing_Automation.md`, `PLAN_Phase_19_Voice_Communications.md`, and `PLAN_Phase_19_Advanced_Integrations.md` where present
- NestJS Server-Sent Events documentation: https://docs.nestjs.com/techniques/server-sent-events
- OWASP GenAI / LLM Top 10 (current project): https://genai.owasp.org/initiatives/top-10-for-llm-and-genai/
- OWASP GenAI LLM Top 10 2026 source: https://github.com/GenAI-Security-Project/GenAI-LLM-Top10/tree/main/2026
- EspoCRM developer documentation as architectural reference only: https://docs.espocrm.com/development/

Do not copy upstream source code, translations, icons, frontend assets, or branding. This is an independently authored NestJS implementation.

---

## Final Instruction to the Coding Agent

Implement only **Phase 19-CHAT.0 — Repository Audit and Capability Inventory** first. Report the actual findings, paths, APIs, schemas, available tool/approval/streaming contracts, missing capabilities, migration risks, and the smallest implementation plan. Do not start later phases until this audit is complete. Follow `AGENTS.MD` for every database operation and never create a separate test database or reset the configured database.
