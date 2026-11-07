# PLAN — CRM Chat Assistant (`CRMChat`)

> **Status:** Implemented — 19-CHAT.0 → 19-CHAT.19 shipped 2026-10-21 (v1.1.0); 19-CHAT.20 → 19-CHAT.22 shipped 2026-11-02; 19-CHAT.23 → 19-CHAT.24 shipped 2026-11-03; P1 domain tools (`crm_project_status`, `crm_commercial_summary`, `crm_campaign_performance`, `crm_list_emails`) shipped 2026-11-05 (module v1.3.0, contract unchanged)
> **Post-release hardening 19-CHAT.25 → 19-CHAT.31 (audit 2026-11-07, §17 end; findings corrected the
> same day after a source-level review) shipped 2026-11-08 (contract v1.3.0).**
> **Plan version:** 1.9.1 (2026-11-07)  
> **As-built companion:** `plans/SPEC.md` — §7 is the shipped AI layer, §8 the gap analysis, §9 the tool-catalogue design that phases 20–24 implement  
> **Parent roadmap:** `plans/PLAN.md` — Advanced CRM Capabilities  
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

Read `AGENTS.MD`, `plans/PLAN.md`, and the actual source code for `AIAgents`, the Entity Engine, ACL, Search, Activities, Notifications, Jobs, Attachments, Dashboard, and the existing frontend shell before implementing this plan.

This plan describes intended behavior. Where it and the code disagree, the code is the fact and this file is the bug — that has already happened once, in the direction of the plan being wrong. Read §0.1 before anything else: it tells you which phases are shipped and which are open. For open work, inspect the repository, migration history, public API conventions, module manifests, tool contracts, provider adapters, UI conventions, tests, and database test scripts before selecting an implementation.

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

### Delivery status (2026-11-07)

The module is **built and running**, not planned. Phases 19-CHAT.0 → 19-CHAT.19 are the historical
specification that produced the shipped module; they stay in this file because they define its
contract. The v2 work added after the review is specified as **19-CHAT.20 → 19-CHAT.24** in §17, and all
five of those phases have shipped. The post-release hardening **19-CHAT.25 → 19-CHAT.31** (§17, audit
2026-11-07) shipped 2026-11-08 together with its owner-module dependency 19-AI.28.

| Phase range | Status | Evidence |
|---|---|---|
| 19-CHAT.0 → 19-CHAT.19 | **Shipped** 2026-10-21 (module v1.1.0, contract v1.2.0) | `docs/modules/crm-chat/RELEASE_NOTES.md`; 9 Chat suites under `apps/api/test/crm-chat*.test.ts`; `docs/architecture/crm-chat-contract.md` |
| 19-CHAT.20 — acting-user context | **Shipped** 2026-11-02 | `apps/api/src/ai-agents/ai-agent-actor.ts`, `apps/api/test/ai-agent-actor.test.ts` |
| 19-CHAT.21 — read tool family | **Shipped** 2026-11-02 | 4 tools, registry 8 → 12 keys; `ai-agent-periods.test.ts` (16 pure cases) + 8 new cases in `ai-agent-runs.test.ts`; design in `plans/SPEC.md` §9.2 |
| 19-CHAT.22 — write loop closure | **Shipped** 2026-11-02 | `crm_post_note`, `crm_log_activity`, `crm_draft_email`, `crm_create_task` v2, `crm_update_record_fields` v2; registry 12 → 15 keys; 6 new cases in `ai-agent-runs.test.ts` |
| 19-CHAT.23 — module intelligence tools | **Shipped** 2026-11-03 | 5 tools, registry 15 → 20 keys; `apps/api/test/crm-chat-intelligence-tools.test.ts` (7 cases); design in `plans/SPEC.md` §9.4 |
| 19-CHAT.24 — tool-aware suggestions, evaluation, release | **Shipped** 2026-11-03 | 8 declarative chips filtered by `capabilities.assistant.tools` (`apps/web/src/pages/crm-chat/CRMChatSuggestions.tsx`); 40 new cases (20 tools × vi + en) in `crm-chat-evaluation.test.ts`; full 21-entry catalogue table in `ai-agent-runs.test.ts`; module v1.2.0; design in `plans/SPEC.md` §9.7 |
| 19-CHAT.25 → 19-CHAT.31 — post-release hardening | **Shipped** 2026-11-08 (contract v1.3.0) | §17 phases 25–31; §18.2 DoD addendum; change log 1.9.0/1.9.1. Evidence: limits enforced in `crm-chat.controller.ts`/`crm-chat-ai-agents-client.service.ts`/`crm-chat-streaming.service.ts` + `crm-chat.test.ts` "settings limits honesty"; all `contextRefs` forwarded via `records` (19-AI.28) + `ai-agent-runs.test.ts`; enforcement map in `crm-chat-contract.test.ts` (27 routes); batched citations `crm-chat-citations-batch.test.ts` + bounded KB scan (`MAX_KB_CORPUS_SCAN`); stream id hygiene `crm-chat-streaming.test.ts`; component coverage `crm-chat-components.test.tsx`; `CRMChatDiagnosticsDrawer`/`CRMChatSettingsModal` extracted, `assistant.delta` decision in contract §8.1 |

**Current-state anchors (2026-11-07, HEAD `2bce1e8`).** As-built rows in §17 describe the state
*at the time each phase shipped* and are deliberately left unchanged. Against the current checkout:
`MAX_TOOLS = 32` (`apps/api/src/ai-agents/ai-agent-config.ts:50`, raised from 20/24 since those rows
were written), the registry has **25** keys asserted in `ai-agent-runs.test.ts:345-369`, and
`crm-chat.controller.ts` serves **27** routes (`CRM_CHAT_ROUTES` has 27 entries). Any new phase
that quotes a ceiling, a catalogue size or a route count must verify it against the code first.

Two rules follow from this split, and both have already cost time when ignored:

1. **Do not re-implement a shipped phase.** Before writing a phase 0–19 task, read the module. The
   release notes record nine areas where the declaration did not survive contact with the code: the
   build itself, stream event names, citations, query-filter safety, cross-module reachability,
   action-proposal façade, feedback/prompts/search routes, test role wiring, and the contract's own
   field names. The text lost every one of those arguments.
2. **Do not extend a shipped phase in place.** A new capability is a new phase with its own
   acceptance evidence, because the shipped contract (`docs/architecture/crm-chat-contract.md`)
   is versioned and consumed by the SPA.

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

**Where these outcomes stand today.** 1, 2, 3, 4, 6, 7, 8, 9 and 10 are served. Outcome 3 includes
aggregation and activities — `crm_aggregate` and `crm_list_activities` — so "how many", "total
value" and "by stage" are numbers from SQL rather than a model's arithmetic. Outcome 4 is reachable
because `crm_cross_module` exposes the curated scenarios as a tool. Outcome 6 now records work where
it belongs: notes on the timeline, calls and meetings as history, drafts that are never sent, tasks
with a parent. Still open: outcome 5 covers records and help articles but not saved reports, and the
one suggestion chip that needs a negative activity query cannot be honoured (both phase 23).

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
- Resolve the acting user **server-side** and put it in the system prompt, so "my", "mine" and "our" become a filter the model can actually apply. A model that is not told who it acts for either drops the filter — returning other people's records inside ACL — or invents one.
- Resolve relative periods ("this quarter", "last 30 days", "next week") **server-side** from the user's timezone and the fiscal calendar, and state the resolved range in the answer. Letting the model compute dates from "today" produces silent off-by-one-quarter errors that look like data problems.
- Answer counting, totals and group-by questions only through a dedicated aggregate tool with a bounded group count, so the number comes from SQL and not from a model summing a truncated list of 25 rows.
- Never accept a user id, team id or role from the model as a query parameter. Anything actor-scoped is derived from the run's initiating user, never passed in.
- Expose every analysis path the product claims **as a tool**. A capability reachable only through a REST route is, to the model, a capability that does not exist.

### 5.5 Cross-module analysis

- Support only declared, schema-aware query paths and relationships.
- Use module APIs/domain services for business-specific computed data, such as Sales financial totals, CustomerSuccess health scores, ServiceDesk SLA status, and MarketingAutomation attribution.
- Do not independently recalculate domain values in Chat if a canonical domain service exists.
- Do not mix currencies or reporting periods without declaring the calculation rule.
- Apply authorization before computing counts, ranks, and aggregates to prevent inference through hidden records.
- Return traceable evidence such as “based on 12 visible accounts” and a query timestamp.
- If one source module is unavailable, either return a clearly partial answer or ask whether to continue with the available modules.
- Make the supported paths **declarative and enumerable**: a scenario the installation cannot serve is reported as `partial` with a per-step reason, never as a 500 and never as an empty success.
- Register the analysis tool from the module that owns the service, so the agent runtime never imports a domain module (see §14.3 and phase 19-CHAT.21).

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
- Link what a write creates to the record it is about. A task, note or call with no parent is a record the user will not find again — it appears on no timeline and answers no question. The parent entity and id are part of the tool's input, not something the model is trusted to add later.
- Drafting is not sending. An email produced by a tool is a `Draft` record and must never reach the send queue; the user opens it and sends it from the record, under their own authorisation.
- Record work that already happened through the owning service — Stream for notes, Activities for calls and meetings — so audit, followers, notifications and hooks fire exactly as they do for a manual edit.
- Declare the effect class and approval requirement on every write tool. A `material_write` cannot be published without `requiresApproval`; widening the writable-field allowlist (phase 19-CHAT.22) does not change the class.

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
- Make each suggestion declare the tool it needs (`requiresTool`) and render it only when the answering agent's grant includes that tool. The Chat payload already carries `capabilities.assistant.tools`; a suggestion that ignores it is a promise the assistant cannot keep.
- Hide a suggestion whose tool is missing rather than showing it disabled with an explanation. A dead control still reads as "the product is broken", and the honest fix is not to advertise it.
- Prefer four suggestions that always work over eight that sometimes do. When a suggestion is wrong for the agent's tool set, the answer is to change the suggestion, not to give every agent every tool.

### 6.4 Accessibility and responsive behavior

- Keyboard navigation, focus handling, accessible labels, readable contrast, reduced-motion behavior, and screen-reader status updates.
- Handle viewport changes and smaller screens without hiding action previews or citations.
- Ensure the user can stop generation and reach approval buttons using keyboard navigation.

---

## 7. Data Model and Persistence

**As built.** Chat stores nothing that AIAgents already stores. Migration
`database/migrations/062_phase19_crm_chat.sql` adds exactly three tables; everything else is a view
over the runtime's own tables, filtered by owner.

| Need | Storage | Added by |
|---|---|---|
| Conversation | `ai_agent_conversations` | reused (AIAgents) |
| Message | `ai_agent_messages` | reused (AIAgents) |
| Turn | `ai_agent_runs` | reused (AIAgents) |
| Tool trace | `ai_agent_tool_calls` | reused (AIAgents) |
| Provider usage | `ai_agent_provider_requests` | reused (AIAgents) |
| Citation | `crm_chat_citations` | migration 062 |
| Feedback | `crm_chat_feedback` | migration 062 |
| Saved prompt | `crm_chat_prompts` | migration 062 |

That split is the reason the module has no second orchestration engine and no retention policy of its
own: a conversation is deleted where the runtime deletes it, and a run's usage is counted where the
runtime counts it.

### 7.1 Entities and tables — original design sketch

The field lists below are the design intent, kept because they explain the three added tables. Names
are illustrative; the shipped DDL is the authority.

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

Event types — **as built** (`CRM_CHAT_STREAM_EVENTS`, `apps/api/src/crm-chat/crm-chat-contract.ts`):

- `turn.started`
- `tool.started`
- `tool.completed`
- `citation.added`
- `action.proposed`
- `approval.required`
- `assistant.message`
- `usage.summary`
- `turn.completed`
- `turn.failed`
- `turn.cancelled`
- `heartbeat`

Three differences from the original proposal, each deliberate:

| Proposed | Built | Why |
|---|---|---|
| `assistant.delta` | **absent** | The runtime does not stream model deltas; the final answer is read back from the conversation message the run wrote. Emitting a fake delta stream would have been a lie with a progress bar. |
| `tool.progress` | `tool.completed` | The runtime reports a tool's outcome, not its percentage. A progress bar invented from a start event is worse than no bar. |
| `run.checkpoint` | **absent** | Checkpoints are `approval.required`; a second event type for the same fact invites a client that handles one and not the other. |

The original v1.0.0 build mapped `run.started`, `assistant.response`, `citation.added`,
`action.proposed`, `approval.required`, `usage.summary` and `run.succeeded` — names the runtime never
emits. The stream delivered a synthetic start and heartbeats and nothing else: no tool events, no
answer, no approval, no usage. When changing this list, assert against the runtime's emitted events,
not against a second copy of the vocabulary.

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
- Compute aggregates in SQL, never in prose. A number in an answer must have come from a `count`/`sum`/`avg`/`min`/`max` over an ACL-filtered query; a model adding up a truncated page of rows produces a confident, wrong figure.
- Bound the grouping: one dimension, a capped group count, and an explicit `truncated` flag. Grouping by a high-cardinality field yields a list rather than an insight and spends the context budget on rows nobody reads.
- Distinguish "no rows" from "not permitted" from "field is empty". All three are tempting to render as `0`, and `0` is a factual claim about the business that the tool did not make.
- Keep money as the canonical decimal string (`apps/api/src/sales/money/decimal.ts`) through the whole path. A tool that round-trips an amount through a JavaScript number has already lost precision before the model sees it.

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

Settings **as built** — one validated row named `crmChat` in the platform's `app_settings`
(`apps/api/src/crm-chat/crm-chat-settings.service.ts`). Nothing here duplicates provider or model
configuration; that stays in `AIAgents` and Chat stores only the agent key.

| Group | Keys | Default | Note |
|---|---|---|---|
| `features` | `workspace`, `readTools`, `helpRetrieval`, `actionProposals`, `feedback`, `conversationSearch` | only `workspace` on | A flag is *effective* only when its `requires` chain is on, so a deployment cannot claim a capability its prerequisite cannot deliver |
| `assistant` | `agentKey` | `''` | Empty means "not configured": the workspace renders setup, not a composer. The module never guesses which agent to run |
| `execution` | `mode` = `queue` \| `inline` | `queue` | `inline` runs in the API process for a single-process dev install; run row, lease, quota and audit are identical |
| `limits` | `maxMessageChars` 8000, `maxContextRefs` 5, `maxActiveTurnsPerUser` 1, `maxConversationsPerUser` 200, `turnTimeoutSeconds` 180, `heartbeatSeconds` 15, `maxConcurrentQueries` 3, `maxTurnsPerMinute` 10, `maxQueryResults` 100 | — | Quotas cannot be bypassed by opening more conversations |
| `retention` | `conversationsDays` 30 | 30 | Instance ceiling only; the AIAgents sweeper remains the single retention executor |
| `safety` | `allowWrites` | `false` | Independent write switch. `features.actionProposals` alone never authorises a mutation |

Settings the original plan expected but that deliberately live elsewhere:

- **Allowed tools / tool groups** — `AIAgents` policy, including `settings.tools.disabled`. Chat reads grants, it does not define them.
- **Provider/model selection** — the AIAgents provider screens. A second surface would be a second truth.
- **Default suggested prompts** — now data in the SPA with a `requiresTool` field (phase 19-CHAT.24), not an admin setting. A prompt is UI copy; making it configurable invites an installation to advertise a capability it never granted.
- **Cross-module analytics flag** — the scenarios are curated server-side and reported `partial` per step, so there is no half-working state to gate.

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

**Who registers a domain tool.** `crm-chat` imports `ai-agents`, and `docs/architecture/module-contracts.md`
records the dependency graph as a DAG. The reverse edge is therefore forbidden: `ai-agents` may not
import a domain module to reach its service. When a tool needs a domain service, the **domain** calls
`AIToolRegistry.register()` at bootstrap with its own definition, and `ai-agents` only validates the
grant (`entityScopes` must name entities the metadata registry knows). `pnpm lint:arch` enforces the
rule, and it is the cheapest way to discover a violation — a cycle introduced at 11 p.m. surfaces as a
lint failure rather than as an import-order bug at boot.

Tools that need only shared core (entity engine, metadata, reports, documents) are declared inside
`ai-agents` and need no such hand-off.

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

**As built.** The set is `apps/api/test/crm-chat-evaluation.test.ts` — one suite, not a spreadsheet, so
it runs in the same command as everything else and cannot silently rot. It seeds its own
`AGENT_TEST_chat_eval_*` users, snapshots and restores both the AI and Chat settings rows, and asserts
through the HTTP surface rather than through internal functions. Eight further suites cover the
contract, conversations, security, docs/help, engagement, inline execution, and the AIAgents
integration.

Two gaps this arrangement left, both closed by phase 19-CHAT.24: there was no case per **tool**, and no
case that failed when a tool was *removed* from the registry. `crm-chat-evaluation.test.ts` now holds one
case per tool in Vietnamese and in English, and the registry is asserted as one complete table.

---

## 17. Delivery Roadmap

Implement the phases sequentially. Do not start later phases before the repository audit and required interface decisions are recorded. The specific numbers are planning identifiers and do not change the broader `plans/PLAN.md` numbering.

**Phases 19-CHAT.0 → 19-CHAT.19 shipped on 2026-10-21.** They are kept verbatim as the specification
the module was built against; read them to understand a contract, not to find work. The open phases
are **19-CHAT.20 → 19-CHAT.24**, at the end of this section, and they implement the tool catalogue in
`plans/SPEC.md` §9. Phase 19-CHAT.20 is already shipped; its entry records what was actually built,
because the implementation went further than the original sketch for a testability reason worth
keeping.

### Phase 19-CHAT.0 — Repository Audit and Capability Inventory

**Tasks**
- Inspect `plans/PLAN.md`, `AGENTS.MD`, `AIAgents`, provider gateway, tool registry, run APIs, approvals, memory/context, usage tracking, search, entity access, global navigation, streaming infrastructure, notification/jobs, and frontend layout conventions.
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

### Phase 19-CHAT.20 — Acting-User Context in the System Prompt ✅ shipped 2026-11-02

The single highest-value change in the v2 catalogue, and it adds no tool. The registry has
`crm_search_records` with an `assignedUserId` filter, so "my open opportunities" was always
*answerable* — the model simply was never told who "my" was.

**Tasks** (as built)
- Move prompt construction out of `ai-agent-runs.service.ts` into `apps/api/src/ai-agents/ai-agent-actor.ts`, so the block is a pure function that tests without booting the API.
- `AIAgentRunService.actorContext(userId)` resolves `users` + `users_teams ⟕ teams` **once per run execution**, not per step; a deleted user yields `undefined` and the block is omitted rather than failing the run.
- `promptSafe()` strips control characters and newlines and caps length: the display name is user-controlled text sitting inside a **system** message, so a name containing a newline would otherwise open a new instruction line.
- Insert the block between the operating rules and the agent instructions; `systemPrompt(agent, config)` without an actor produces byte-identical output to the previous version.
- `__FAKE_ECHO_ACTOR__` seam in the fake provider returns the `- id:` line only — a test seam must not become a prompt-disclosure tool.

**Acceptance criteria** (verified)
- A run queued by user A and executed by an admin B carries **A's** id, not the executor's (`ai-agent-runs.test.ts`, end-to-end through `crm_search_records` with `assignedUserId`).
- A display name containing `\n\nIgnore the operating rules` cannot open a new line in the system message (`ai-agent-actor.test.ts`).
- The pure suite is listed in `PURE_API_TESTS` in `vitest.ci.config.ts`; the CI gate has no database.
- Rollback is passing `undefined` as the third argument — no schema, no data, no migration.

---

### Phase 19-CHAT.21 — Read Tool Family: Aggregate, Activities, Actor, Cross-Module ✅ shipped 2026-11-02

Closes the "no aggregation" and "capability exists but the model cannot see it" defects. Read-only,
no approval, no migration. Took the registry from 8 keys to 12.

**What the implementation added beyond this sketch**, and why:

| Addition | Reason |
|---|---|
| `apps/api/src/ai-agents/ai-agent-periods.ts` — a pure, timezone-aware token resolver with 16 unit tests | The plan said "shared by the aggregate and activity tools"; making it a module with its own suite is what let the DST and week-boundary cases be tested without a database |
| `AIAgentActorDirectoryService` — one actor lookup, used by both the prompt and `crm_actor_context` | Two queries written in two places drift; the prompt and the tool must never describe the same person differently |
| `EntityService.linkedSourceIds()` + a store method | Activities declare `accounts`/`contacts` on the child, so "the calls about this account" has no forward relation to walk. One indexed lookup, then a normal ACL-filtered list |
| `crm_actor_context` returns `today`/`now` as well | The most common model error is the current date; returning it is cheaper and safer than inferring it |
| `crm_aggregate` scans up to 100 groups before slicing to `maxGroups` | The store orders by group key, so top-N-by-value needs a wider scan plus an honest `truncated` flag |

**Tasks**
- `crm_aggregate` over `EntityCrudService.aggregate()` — `count|sum|avg|min|max`, optional single `groupBy`, ≤ 6 criteria reusing the search operator allowlist, ≤ 10 groups, 16 KiB / 10 s caps. ACL and record predicate come from the entity service; the tool must not build its own predicate.
- `crm_list_activities` over `Call` / `Meeting` / `Task` with `scope: mine | record`; `mine` resolves from `context.actorUserId` and is **not** an input parameter. Related records read through `entity_links`.
- `crm_actor_context` — the caller's own id, name, locale, timezone, teams. Nothing about another user, no role of anyone else.
- `crm_cross_module` over `CRMChatCrossModuleService.run()`, registered **from `crm-chat`** (§14.3) so the DAG is untouched. The scenario enum is the installation's declared list, not a hardcoded union.
- Server-side relative-period resolution (`this_quarter`, `last_month`, `rolling:30d`, `next_week`) in the actor's timezone, shared by the aggregate and activity tools. The model passes a token; it never computes a date.
- Dual schema per tool: Zod `inputSchema` (strict) **and** hand-written `inputJsonSchema` — the model never sees Zod. `entityScopes` may only name seeded entities, or the grant cannot be published.
- Update `docs/modules/ai-agents/tool-developer-guide.md` with the aggregate and relative-period patterns.

**Acceptance criteria** (verified — `ai-agent-runs.test.ts`, "read tool family")
- "Pipeline by stage this quarter" returns ≤ 10 groups whose `sum(amount)` equals the same aggregate run directly against the database; the answer states the resolved date range.
- A caller without `Opportunity: read` receives an authorisation error or an empty result with an explicit reason — **never** a number. Aggregates are the easiest way to leak restricted records.
- "What do I have today?" returns only the initiating user's activities, even when a teammate's activities fall inside the same ACL window.
- A cross-module scenario the installation does not declare returns `partial: true` with a per-step reason and HTTP 200, not a 500 and not an empty success.
- Each new tool is in the catalogue assertion in `ai-agent-runs.test.ts`; deleting one turns the suite red.
- `pnpm lint:arch` unchanged; `pnpm typecheck` clean.

---

### Phase 19-CHAT.22 — Write Loop Closure ✅ shipped 2026-11-02

The registry had two write tools and neither could attach anything to the record it was about. A task
with no parent appears on no timeline and answers no question, so "create a follow-up task" produced
a record the user would never find again.

**What the implementation settled, beyond this sketch:**

| Decision | Reason |
|---|---|
| Notes go through `StreamService.create()` with the run's idempotency key | The parent's `stream` ACL action, mentions, followers and audit then behave exactly as for a manual note — and a retried step cannot post twice |
| The link is written by `entities.link()`, with the relation **read from metadata** | One helper serves an activity's `accounts`, an email's `leads` and a task's parent; an unsupported target is a validation error that lists what is supported, not a silent no-op |
| `crm_log_activity` only accepts `Account`/`Contact`/`Lead`/`Opportunity`/`Case` as `related` | Activities declare only `accounts`/`contacts`; accepting an entity with no declared relation would promise a link that cannot exist |
| `crm_draft_email` writes both the relation link and `parentType`/`parentId` | The related panel reads the link; the parent columns are what the mail module and the record header read |
| The version bump on the two upgraded tools is audit metadata, not compatibility | `ai_agent_tool_grants` stores `tool_version` but authorises by `key`, so an existing grant keeps working. The plan's original wording ("published grants reference the version") was wrong; the code is the fact |
| Tests assert effects, not return values | A `stream_items` row with the actor as author, an `entity_links` row, and **no** `system.sendEmail` job for the draft. A tool's own claim that it did not send is not evidence |

**Tasks**
- `crm_post_note` via `StreamService.create()` — the most common AI CRM action is recording what a call concluded. Author is the actor; the agent is recorded as the source.
- `crm_log_activity` for `Call` / `Meeting` with `status: Held` and an optional `related {entity, id}`. It records work that already happened and sends nothing to the customer.
- `crm_draft_email` creates an `Email` with `status: 'Draft'`. It must never call `queueSend`, and `queueSend` must keep refusing non-sendable statuses — the safety is in the service, not in the tool's good intentions.
- `crm_create_task` **v2**: add `parent {entity, id}`, default `assignedUserId` to the actor. Publish as `version: '2'`; do not edit v1 in place, because published grants reference the version.
- `crm_update_record_fields` **v2**: widen the writable allowlist — `Opportunity(stage, amount, closeDate)`, `Case(priority, assignedUserId)`, `Task(dateEnd, assignedUserId)`, `Lead(assignedUserId)`. It stays `material_write`, keeps `requiresApproval`, and keeps the version check.
- Gate the whole family behind `features.actionProposals` **and** `safety.allowWrites`, exactly as the shipped proposal flow does.

**Acceptance criteria** (verified — `ai-agent-runs.test.ts`, "write tool family")
- A task created through the tool appears on the parent record's timeline/related panel; a parent the caller cannot read is a validation error.
- A drafted email exists with `status = 'Draft'`, and the test asserts no send job was enqueued — the assertion is on the queue, not on the tool's return value.
- A note created through the tool is attributed to the actor and produces the same stream/audit rows a manual note does.
- `crm_update_record_fields` v2 still fails to publish without `requiresApproval`; a field outside the allowlist is a 422, never a silent no-op.
- Rollback is `settings.tools.disabled` in AIAgents settings. No migration is introduced by this phase.

---

### Phase 19-CHAT.23 — Module Intelligence Tools ✅ shipped 2026-11-03

Five thin wrappers over services that already exist. The rule for this phase is that no business rule
is re-derived: if the domain service computes a health score, the tool returns that number.

**Tasks**
- `crm_lead_score` → `LeadScoreExplanationService.score/history` (registered by `lead-score`).
- `crm_customer_health` → `CustomerSuccessHealthService.explanation` (registered by `customer-success`).
- `crm_case_context` → `Case` + `CaseSLAClock` + `KnowledgeBaseService.suggestForCase` + CSAT (registered by `service-desk`).
- `crm_stale_records` → `entity_records` with a single `NOT EXISTS` over `stream_items`. Do not fetch records and filter in JavaScript; the whole point is that the database does the exclusion.
- `crm_run_report` → `ReportService.list/run`, only reports the caller can see (registered by `ai-agents` — `reports` is shared core).

**Acceptance criteria**
- Each tool's returned score equals the owning service's value for the same record in the same test.
- A disabled or uninstalled module removes its tool from the catalogue, and Chat says the capability is unavailable rather than failing the turn.
- `crm_stale_records` runs one query, not N+1, and respects record ACL — a record the caller cannot read never appears in the "silent" list.
- `crm_run_report` cannot return a report the caller is not permitted to run.

**As-built**

| Tool | Registered by | File | Deviation from the task list |
|---|---|---|---|
| `crm_lead_score` | `lead-score` | `apps/api/src/lead-score/lead-score-tool-contribution.ts` | History is **optional** (`historyLimit`), not always returned: `score()` is the answer, `history()` is a second read that costs a query the caller did not ask for |
| `crm_customer_health` | `customer-success` | `apps/api/src/customer-success/customer-success-tool-contribution.ts` | Accepts an `accountId` **as well as** a `profileId` and resolves the profile first; the agent usually holds an account, not a profile id |
| `crm_case_context` | `service-desk` | `apps/api/src/service-desk/service-desk-tool-contribution.ts` | CSAT is `null` rather than an error when the caller is a portal user (staff-only results); the rest of the case context still answers |
| `crm_stale_records` | `ai-agents` | `apps/api/src/ai-agents/ai-agent-intelligence-tools.contribution.ts` | §9.4's registration table did not name an owner for it. It is `ai-agents`, because it reads the generic `entity_records` / `stream_items` store through the shared record ACL — no domain module owns that store |
| `crm_run_report` | `ai-agents` | `apps/api/src/ai-agents/ai-agent-intelligence-tools.contribution.ts` | A missing `reportId` **lists** the reports the caller may run instead of failing; the model needs the id before it can run anything |

Two facts the task list left open, now settled in code:

- **`stream_items` is keyed by `entity_type` / `entity_id` / `is_deleted`** — not `parent_type` / `parent_id` / `deleted_at`
  as the plan's wording implied. The `NOT EXISTS` reads the real columns.
- **The record ACL has to be folded into the same query.** `AclApiService.recordPredicate()` returns a
  predicate, not SQL, so `crm_stale_records` reproduces the record store's own translation
  (`allowAll` / `denyAll` / `own` / `team` / portal / project-scoped) — a list and this tool decide
  identically, and a record the caller cannot read never reaches the result.

**Evidence**

`apps/api/test/crm-chat-intelligence-tools.test.ts` — 7 cases: the catalogue and each tool's owner;
the lead score equals the projection the score engine stored on the Lead (42 / `Warm`); the customer
health score equals the snapshot the health service reads (37); the case summary carries its SLA
clock; the silent-record scan reports the silent account and excludes the one with timeline activity,
and neither appears for a caller who may not read them; a private report is neither listed nor run
for another user; an unknown argument is refused.

Gates: `pnpm lint:arch` clean, `eslint` (sanctioned scope) clean, `pnpm lint:ui` clean,
`pnpm typecheck` clean, and `ai-agent-runs`, `ai-agents`, `crm-chat*`, `customer-success`,
`lead-score*` suites green.


---

### Phase 19-CHAT.24 — Tool-Aware Suggestions, Evaluation, and Release ✅ shipped 2026-11-03

The four suggestion chips are hardcoded. Two of them still promise what the assistant cannot do
(activity-based and email drafting), and a third — "deals closing this quarter" — only half-works
because the model has to compute the date range itself. This phase makes a suggestion a claim the UI
can verify.

**Tasks**
- Turn the suggestion list into data, each entry carrying `requiresTool`; render only those whose tool appears in `capabilities.assistant.tools`. No API change — the payload already carries it and today only the diagnostics drawer reads it.
- Add one evaluation case per tool to `crm-chat-evaluation.test.ts`, in both Vietnamese and English, that fails if the tool is removed.
- Extend the catalogue assertion to the full set (20 keys) and record each tool's effect class, approval requirement and `entityScopes`.
- Update `docs/architecture/crm-chat-contract.md` (capabilities payload semantics), `plans/SPEC.md` §7/§9 to as-built, and `docs/modules/crm-chat/RELEASE_NOTES.md`.
- Run the full gate: `pnpm lint` (sanctioned scope), `pnpm lint:arch`, `pnpm lint:ui`, `pnpm typecheck`, `pnpm test:ci` one file at a time, `pnpm test:web`, and the Playwright chat spec with `no_proxy='*'`.

**Acceptance criteria**
- No suggestion renders for a tool the answering agent lacks (component test, not a screenshot).
- Removing any tool turns at least one evaluation case red — an untested tool is an unowned tool.
- `pnpm lint:ui` clean: no missing `t()` key, no raw `<Empty>`, no sliced timestamp in the new UI.
- Release notes state the new tool count, the two version bumps, and the rollback path for each phase.

**As-built**

The chip table lives in `apps/web/src/pages/crm-chat/CRMChatSuggestions.tsx` as
`CRM_CHAT_SUGGESTIONS` (declarative, with `requiresTool`) plus `visibleSuggestions(tools)`, and the page
renders `<CRMChatSuggestions tools={data.assistant.tools} … />`. Seven new i18n phrases in `en` and `vi`;
`CRMChatPage.tsx` no longer builds labels itself. Four of the §9.7 chips replaced the old four, four are
new, and the row order is the declaration order.

| Deviation from the task list | Reason |
|---|---|
| §9.7's "no tool required" chip (`opportunities`) declares `crm_search_records` | The dash was true relative to §9.6, but the question still reads records. Declaring the tool makes the chip hide from a docs-only assistant, which is the whole point of the phase. |
| Two chips re-worded away from "this account" / "this lead" | The hero is an empty state: no record is selected, so a demonstrative would point at nothing. |
| The evaluation set runs through **three** assistants, not one | `MAX_TOOLS` in `apps/api/src/ai-agents/ai-agent-config.ts` capped an agent at eight grants *at the time*, so twenty tools could not be held by one Chat assistant and `useAssistant(group)` repoints Chat per group of cases. The ceiling is twenty now (raised 2026-11-03, with G37–G39/G63); the grouping stayed, as a test-local choice that keeps each published version small and proves the suite does not need one agent holding everything. |
| The catalogue assertion covers **21** registry keys, not 20 | `omnichannel.send_message` shares the registry. Excluding it would leave an approval-gated, customer-visible tool unasserted and would make a "full set" claim false. |
| The module version went 1.1.0 → 1.2.0; the **contract** version stayed 1.2.0 | No path, request shape, response shape, stream event or error code changed — `assistant.tools` was already in the payload. Bumping it would tell a client there is something to adapt to. `implementedPhases` now lists 20–24. |

Two things this phase discovered about itself, both written into
`docs/architecture/crm-chat-contract.md` §7.5:

- The chip filter reads the assistant's **grants**, not `settings.tools.disabled`. Disabling a tool in
  AIAgents settings stops execution but leaves the question advertised, so the honest rollback is removing
  the grant and republishing.
- "Both languages" is a narrower claim at tool level than it is at answer level. The fake adapter pins
  which tool answers (it reads the `__FAKE_TOOL__` directive), so a case proves that the Vietnamese and
  the English phrasing survive Chat validation, the agent prompt, the tool schema and the answer path —
  not that a model would *route* to that tool. Model routing needs a live provider and belongs to
  `ai_agent_eval_*`.

**Evidence**

- `apps/api/test/crm-chat-evaluation.test.ts` — 61 cases: the 19-CHAT.17 set plus 40 per-tool cases, each
  a real `POST action/turns` (inline execution) with the tool call read back from `ai_agent_tool_calls`;
  `crm_update_record_fields` asserts `waiting_for_approval`, one unexecuted tool call and an unchanged
  record. Setup snapshots and restores four settings documents (`aiAgents`, `crmChat`, `leadScore`,
  `serviceDesk`) and removes every row it created by id or by the run marker.
- **Removal property verified, not claimed:** unregistering `crm_stale_records` makes publishing the
  assistant fail with `Unknown AI tool "crm_stale_records"`, and the whole block goes red.
- `apps/web/src/pages/crm-chat/CRMChatSuggestions.test.tsx` — 5 cases: a chip whose tool is absent is not
  in the markup; every chip appears for a fully granted agent; no row renders for an unrelated grant; the
  chip table has no duplicate tool; both locales carry every phrase.
- `apps/api/test/ai-agent-runs.test.ts` — the catalogue test now asserts all 21 entries: `owningModule`,
  `version`, `effectClass`, `requiresApproval`, `entityScopes`, the hand-written JSON Schema, the byte and
  time caps, and that the API projection agrees with the registry.

---

### Phase 19-CHAT.25 — Settings and Limits Honesty (P1) — **Shipped 2026-11-08**

**Finding (audit 2026-11-07, corrected):** `CRMChatSettingsService` stores a large `limits.*`
surface, but only part of it is enforced. **`maxContextRefs` is already enforced server-side**
(`crm-chat.controller.ts:250-258`, 422 `CHAT_CONTEXT_TOO_LARGE`), and `maxMessageChars` is enforced
in `CRMChatComposer.tsx:241-242,332` — but the client allows `8_000` characters (+100 overage)
while the DTO hard-caps `prompt` at `4_000` (`dto/crm-chat-shapes.ts:83`), so a 5,000-character
message is accepted by the UI and refused by the API. `maxActiveTurnsPerUser`,
`maxConversationsPerUser`, `maxTurnsPerMinute`, `maxQueryResults`, `maxConcurrentQueries` and
`turnTimeoutSeconds` are stored but not checked (queries use a hardcoded `MAX_LIST_SIZE=50` in
`crm-chat-query.service.ts:48`); `heartbeatSeconds` is unused because
`crm-chat-streaming.service.ts:122-134` hardcodes `15_000`. An operator reading the settings screen
believes every advertised bound is live.

**Tasks**
- For **every** `limits.*` field (including `maxContextRefs`), record one decision in
  `docs/architecture/crm-chat-contract.md`: **enforce server-side** (preferred for
  `maxActiveTurnsPerUser`, `maxTurnsPerMinute`, `maxConversationsPerUser`, `turnTimeoutSeconds`) or
  **remove** from the settings DTO, API docs and admin UI.
- Make `maxMessageChars` a single source of truth: align the DTO cap with the setting (or have the
  DTO read the setting) and fix the composer's `maxLength + 100` overage, so the advertised bound
  equals the enforced bound.
- Decide the fate of `heartbeatSeconds` here; **wire it in 19-CHAT.29**, which owns the streaming
  timer. Same for any other orphaned field found by grep.
- Add tests: a small configured limit is honoured by turn creation, conversation creation and query
  execute; a removed field is rejected as an unknown key by the settings schema (it is already
  `.strict()` — `crm-chat-settings.service.ts:42,56,68` — so assert that behaviour rather than
  adding strictness).

**Acceptance criteria**
- Every `limits.*` field in the public settings DTO is either enforced (test-proven) or removed; no
  dead settings remain. A prompt of `maxMessageChars` length is accepted by both client and server,
  or refused by both.
- **Removing settings fields changes a public response shape**: bump `CRM_CHAT_CONTRACT_VERSION`
  (`crm-chat-contract.ts`) and coordinate the SPA/admin UI in the same phase. Rollback is re-adding
  the fields plus reverting the bump; **no database migration**.
- An operator can verify the enforced bounds from the admin UI and the updated contract docs.

---

### Phase 19-CHAT.26 — Forward All Context References (P1) — **Shipped 2026-11-08**

**Finding:** `crm-chat-ai-agents-client.service.ts:68-70` forwards only `contextRefs[0]` as
`record`. The turn DTO accepts an array and the controller validates up to `limits.maxContextRefs`
(5) references (`crm-chat.controller.ts:250-258`), so refs 2–5 are validated and then silently
discarded: a user who attaches three records gets an answer grounded in one.

**Cross-module dependency (resolve before code):** `RunCreateInput.input.record` is a **single
object** in AIAgents — `ai-agent-runs.service.ts:2629,2639` writes it into the run input and the
prompt builder. Forwarding a list therefore requires the companion phase **19-AI.28** in
`plans/PLAN_Phase_19_AI_Agents.md`, which extends the run-input schema and prompt construction;
§0 forbids working around the owner module. Land 19-AI.28 first. The Chat module only translates
the DTO and validates refs.

**Tasks**
- Extend the AIAgents run-input contract to carry all refs (companion phase), then change
  `submitTurn` to forward the full list. Until that lands, **reject >1 ref with a clear validation
  error** rather than validating-and-dropping.
- Re-check every ref for readability before creating the run; no ref reaches the prompt without an
  ACL decision.
- Add a multi-ref turn test: two readable records as `contextRefs` → the run input read back from
  `ai_agent_runs` carries both and the prompt references both; an unreadable ref is rejected before
  any run is created.

**Acceptance criteria**
- No validated caller input is silently discarded anywhere in the turn path; if the single-ref
  fallback ships, it fails loudly with a documented error code.
- 19-AI.28 has landed (or the >1 rejection has shipped) before this phase is marked complete; the
  contract doc records which mode is live.
- `crm-chat-security.test.ts` stays green — multi-ref forwarding must not widen record visibility.

---

### Phase 19-CHAT.27 — Contract Accuracy (P1) — **Shipped 2026-11-08**

**Findings:**
1. **Capability/feature drift.** `CRM_CHAT_ROUTES` **already declares** `capability` and `feature`
   per route (`crm-chat-contract.ts:23-32`), and `crm-chat-contract.test.ts:94-103` checks they are
   *known keys* — but nothing compares the declared values with what the controller enforces. Three
   are wrong: `help/search` declares `feature: 'workspace'` while the controller calls
   `assertFeature('helpRetrieval')` (`crm-chat.controller.ts:356`); `cancel` declares
   `capability: 'manage'` while the controller calls `assertWorkspace()` → `use` (`:293-297`);
   prompt **POST** declares `capability: 'use'` while `crm-chat-prompts.service.ts:81` requires
   `prompts`. The prompt **GET list** is correct (`use`, `:66`) — do not "fix" it.
2. **Stale docs.** `crm-chat.controller.ts:47-67` still says "Only the foundation routes exist
   here" — false since v1.1.0. The shipped surface is **27** routes (27 decorators and 27
   `CRM_CHAT_ROUTES` entries), not 28.

**Tasks**
- Extend `crm-chat-contract.test.ts` with an explicit expected-enforcement map derived from the
  controller's `assert*` calls, and assert every `CRM_CHAT_ROUTES` entry against it, so a change in
  code without a table update turns the suite red.
- Resolve the three declared values above (or change the enforcement and document why — one source
  of truth either way).
- Update the controller header and `docs/architecture/crm-chat-contract.md` to describe the shipped
  27-route surface.

**Acceptance criteria**
- The contract test fails if a route's capability or feature enforcement changes without a table
  update; all three known drifts are resolved on the true values.
- The "foundation routes" wording is gone and the contract doc's route count matches the controller.
- No API behaviour change; `pnpm lint:ui` and `pnpm typecheck` clean.

---

### Phase 19-CHAT.28 — Bounded Data Loading (P2) — **Shipped 2026-11-08**

**Findings (one capability — bound the fetch — at two call sites):**
1. `toMessageView` awaits `citations.forMessage` per message
   (`crm-chat-conversations.service.ts:207,343`); each call re-reads 1–2 entities through
   `crm-chat-citations.service.ts:129`. A 30-message page costs up to 60 Entity Engine calls, and
   the frontend posts a separate `citations/reauthorize` per rendered link
   (`CRMChatMessageList.tsx:173-195`).
2. `crm-chat-help.service.ts:125` calls `portalArticles()` (unbounded corpus,
   `knowledge-base.service.ts:50-70`) and scores keywords in memory (`:132-146`). Only the
   *output* is capped (`MAX_HELP_SOURCES=5`); the fetch has no limit, index or pagination.

**Tasks**
- Batch-load citations: one query for all `crm_chat_citations` rows of the page's messages, then
  re-read entities in a single pass (or a batch `get` where the Entity Engine supports it). Preserve
  the "revoked → hidden, not forbidden" semantics.
- Batch the frontend `reauthorize` into one POST per page, or drop per-link reauth now that
  server-side `visibleSources` already re-authorizes.
- Bound the help fetch (server-side limit + ranking, or a TSV index); at minimum cap the corpus scan
  and document the bound.

**Acceptance criteria (numeric, not "fast enough")**
- A 30-message history page issues **≤ 3** DB statements for citation materialization (one citation
  query + one batch entity read + one message query), asserted by a query-count test; a 60-message
  page must not double that count.
- With a seeded **5,000-article** corpus, `help/search` reads **≤ 500** articles and answers within
  **200 ms p95** over 20 measured calls on the CI runner; the test asserts both the fetch bound and
  the budget. If the runner cannot meet 200 ms, agree a documented number before shipping — do not
  leave the criterion open-ended.
- No change to citation visibility semantics; `crm-chat-security.test.ts` stays green.

---

### Phase 19-CHAT.29 — Stream ID Hygiene (P1) — **Shipped 2026-11-08**

**Finding (severity corrected):** `crm-chat-streaming.service.ts:129` emits heartbeats with
`id: String(Date.now())`, while `:99-103` parses `Last-Event-ID` straight into `lastSeq`. A client
that reconnects after a heartbeat sends a 13-digit epoch as its resume cursor and **skips every
subsequent event** — this is a broken resume, not merely an id collision. Also `action.proposed` and
`approval.required` share one `id` (`:186,229-250`), and `citation.added` is declared in the
contract (`:40`) and handled client-side (`useCrmChatStream.ts:121`) but never emitted by the
server. `assistant.delta` is absent by design (the UI renders a timer); that decision belongs to
19-CHAT.31.

**Tasks**
- Heartbeats must not carry a resumable sequence id (omit `id`, or use a non-numeric id the resume
  parser ignores) and must never advance `lastSeq`. Add a reconnect-after-heartbeat test that
  asserts all following events are delivered.
- Give `action.proposed` and `approval.required` distinct ids, or document in the contract why they
  share one and test that behaviour.
- Remove `citation.added` from the contract, or emit it server-side with a test.
- Implement the `heartbeatSeconds` decision from 19-CHAT.25 (the interval is currently a hardcoded
  `15_000` at `:134`).

**Acceptance criteria**
- `Last-Event-ID` resume after ≥1 heartbeat delivers the events emitted during the gap; stream ids
  are unique within a turn and never collide with the resume cursor.
- Every emitted `CRM_CHAT_STREAM_EVENTS` value has a handler and a mapping test; `pnpm test:web`
  and `pnpm lint:ui` clean.

---

### Phase 19-CHAT.30 — Frontend Component Coverage (P2) — **Shipped 2026-11-08**

**Finding:** Only `CRMChatSuggestions.test.tsx` exists under `apps/web`; composer, SSE resume,
citation, action-card and feedback components have no component tests, and streaming translation is
covered only indirectly. (`e2e/crm-chat.spec.ts` is a Playwright journey, not a component suite.)

**Tasks**
- Add vitest.web suites for `CRMChatComposer` (send/cancel/error-recheck state machine,
  `:160-237`), `useCrmChatStream` (resume via `Last-Event-ID`, terminal close, error re-check),
  `CRMChatMessageList` (locked citation state), `CRMChatActionCard` (server-driven `actionable`
  flag) and `CRMChatFeedbackButtons` (down → comment modal). Mock `EventSource`/fetch; no provider
  calls.
- Add dense mapping tests for every `CRM_CHAT_STREAM_EVENTS` value (12 today), including dropped or
  untranslatable events.

**Acceptance criteria**
- `pnpm test:web` covers all five components/hook; deleting any handler turns a test red.
- Every stream event value has a mapping test; `pnpm lint:ui` clean (no missing `t()` keys, no raw
  `<Empty>`).

---

### Phase 19-CHAT.31 — UI Decomposition and the `assistant.delta` Decision (P3) — **Shipped 2026-11-08**

**Finding:** `CRMChatPage.tsx` is 666 lines and bundles the page, diagnostics drawer (`:502-598`),
admin settings modal (`:600-663`) and health checks. `assistant.delta` is not emitted — the UI
renders a timer instead of token deltas. The latter is an unrecorded product decision, not
necessarily a defect.

**Tasks**
- Extract the diagnostics drawer and admin settings modal into their own components with the same
  props and no behaviour change; keep the capability gate and `canStartTurn` logic intact.
- Decide `assistant.delta`: either open a **separately scoped** token-streaming UX phase, or record
  the timer-instead-of-tokens choice as intentional in `docs/architecture/crm-chat-contract.md`.

**Acceptance criteria**
- `CRMChatPage.tsx` is under ~400 lines (or the remaining split is documented with a reason);
  `pnpm lint:ui` clean.
- The `assistant.delta` decision is written into the contract doc, so the gap is a decision rather
  than an oversight. Pure refactor, no migration.

---

## 18. Definition of Done

The list below is the gate the shipped module was accepted against, and it stays the standing gate
for every new phase. A v2 phase that touches a row must re-verify it rather than assume the earlier
pass still holds — the v1.0.0 release notes are the cautionary example: nineteen phases were marked
complete while four services did not compile.

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

### 18.1 Addendum for the v2 tool catalogue (19-CHAT.21 → 19-CHAT.24)

These are the failure modes the shipped module actually exhibits, so each one gets a criterion:

- [ ] Every suggestion is backed by a tool the answering agent holds; none promises a capability the run cannot reach.
- [ ] Every number in an answer came from an aggregate query. A model summing a truncated page is a fabricated statistic, not an approximation.
- [ ] Relative periods are resolved server-side in the actor's timezone and the resolved range is stated in the answer.
- [ ] Every write links to its parent record and appears on that record's timeline.
- [ ] No tool can send external communication. Drafting produces a `Draft`; sending remains a human action on the record.
- [ ] No aggregate leaks a restricted record's existence through a count, a total or a group.
- [ ] Every tool has a dual schema, byte/time caps, registered `entityScopes`, one evaluation case, and a catalogue entry.
- [ ] Every tool's owning module respects the DAG; `pnpm lint:arch` proves it.
- [ ] Every tool is disableable through AIAgents settings without a deploy or a migration.

### 18.2 Addendum for the post-release hardening (19-CHAT.25 → 19-CHAT.31, audit 2026-11-07)

These criteria cover the **corrected** audit findings recorded in §17 after phase 19-CHAT.24. A
hardening phase that touches one of them must re-verify it:

- [ ] Every advertised limit is enforced server-side, or it is removed from the settings surface and the DTO; the advertised `maxMessageChars` equals the enforced DTO cap (see 19-CHAT.25).
- [ ] A turn never silently drops caller-supplied context references; multiple refs are forwarded through the AIAgents run input or rejected with a validation error (see 19-CHAT.26).
- [ ] `CRM_CHAT_ROUTES` capability/feature declarations match the controller's enforcement for every route, proven by a contract test (see 19-CHAT.27).
- [ ] A page of conversation history materializes citations in a bounded number of DB statements (≤ 3 for a 30-message page), with no per-message N+1 (see 19-CHAT.28).
- [ ] Help/KB retrieval reads a bounded number of articles and stays within the documented time budget regardless of corpus growth (see 19-CHAT.28).
- [ ] A reconnect after a heartbeat still resumes from the correct cursor; stream ids are unique per turn and never collide with the resume cursor; every emitted event type has a handler and a test (see 19-CHAT.29).
- [ ] Composer, SSE resume, citation, action-card and feedback components have component tests (see 19-CHAT.30).
- [ ] The `assistant.delta` decision is recorded in the contract doc and `CRMChatPage.tsx` is decomposed (see 19-CHAT.31).

---

## 19. Release Boundaries

### 19.1 Initial release — delivered 2026-10-21

The first pass was deliberately narrow. This is what it contained, and it shipped:

1. Private conversation history and a usable Chat workspace.
2. Integration with the existing AIAgents runtime/provider/tool registry.
3. Read-only help retrieval and authorized CRM record search/summaries.
4. Grounded answers with trusted citations and timestamps.
5. One low-risk write workflow implemented through preview + explicit confirmation, such as creating a follow-up task.
6. Audit, rate limiting, cancellation, safe error handling, and evaluation tests.

### 19.2 v2 boundary — 19-CHAT.21 → 19-CHAT.24

The next boundary is defined by *questions the product already advertises and cannot answer*, not by
features that would be nice to have. In scope:

1. Aggregation with one bounded group-by, so counts, totals and pipeline-by-stage become facts.
2. Activity listing and the actor context, so "my day" and "my pipeline" work.
3. Reachability of the cross-module scenarios the module already implements.
4. Write loop closure: note, activity, draft email, task with a parent.
5. Module intelligence wrappers for score, health, case context, stale records and saved reports.
6. Suggestions filtered by the agent's actual grants.

Out of scope, and each for a reason rather than for lack of time: record deletion and merge
(irreversible, needs its own threat model); real email/SMS/call sending (external side effect, needs
the domain's approval flow, not chat confirmation); financial writes such as quotes, invoices and
payments (canonical money path, approval semantics differ); arbitrary SQL, HTTP or code execution;
a public portal assistant (separate identity and tenancy model); vector search over unrestricted CRM
content (an ACL bypass dressed as a feature).

---

## 20. Reference Material

Use these references for architectural/security guidance, checking current official documentation during implementation. The implementation must still follow the installed library versions and the repository's established contracts.

- Project roadmap: `plans/PLAN.md`
- As-built specification: `plans/SPEC.md` (§7 shipped AI layer, §8 gap analysis, §9 tool catalogue)
- Module release notes: `docs/modules/crm-chat/RELEASE_NOTES.md`
- API/stream contract: `docs/architecture/crm-chat-contract.md`
- Tool authoring guide: `docs/modules/ai-agents/tool-developer-guide.md`
- Coding and database safety rules: `AGENTS.MD`
- Existing agent runtime plan: `plans/PLAN_Phase_19_AI_Agents.md` if present in the repository
- Existing domain plans: `plans/PLAN_Phase_19_Sales.md`, `plans/PLAN_Phase_19_Projects.md`, `plans/PLAN_Phase_19_Customer_Success.md`, `plans/PLAN_Phase_19_ServiceDesk.md`, `plans/PLAN_Phase_19_Marketing_Automation.md`, `plans/PLAN_Phase_19_Voice_Communications.md`, and `plans/PLAN_Phase_19_Advanced_Integrations.md` where present
- NestJS Server-Sent Events documentation: https://docs.nestjs.com/techniques/server-sent-events
- OWASP GenAI / LLM Top 10 (current project): https://genai.owasp.org/initiatives/top-10-for-llm-and-genai/
- OWASP GenAI LLM Top 10 2026 source: https://github.com/GenAI-Security-Project/GenAI-LLM-Top10/tree/main/2026
- EspoCRM developer documentation as architectural reference only: https://docs.espocrm.com/development/

Do not copy upstream source code, translations, icons, frontend assets, or branding. This is an independently authored NestJS implementation.

---

## 21. Change Log

| Version | Date | Change |
|---|---|---|
| 1.9.1 | 2026-11-07 | Corrected the same-day §17 additions after a source-level review: disproved "no limit is enforced", "28 routes", "prompt POST/**list** drift" and the "stream ids collide" framing; recorded the real `maxMessageChars` 8,000 vs DTO 4,000 mismatch, the heartbeat → `Last-Event-ID` resume break, the already-enforced `maxContextRefs`, the already-existing `capability`/`feature` contract fields, and the AIAgents run-input dependency. Split the four bundled phases into seven single-capability phases (**19-CHAT.25 → 19-CHAT.31**), promoted stream hygiene to P1, replaced "fast enough" with numeric budgets, moved §18.2 after §18.1, updated §0.1 with current-state anchors (`MAX_TOOLS` 32, 25 tools, 27 routes) and rewrote the final instruction. No shipped phase was changed in place. |
| 1.9.0 | 2026-11-07 | Initial post-release hardening plan: added phases 19-CHAT.25 → 19-CHAT.28 (settings honesty, context/contract accuracy, bounded loading, frontend/stream hygiene) and a §18.2 Definition-of-Done addendum from the 2026-11-07 audit. **Superseded by 1.9.1 the same day** — several findings did not survive a source check; read 1.9.1 for the corrected scope. |
| 1.8.0 | 2026-11-05 | P1 release: four domain tools shipped — `crm_project_status` (Projects), `crm_commercial_summary` (Sales, over the 19-S.19 `customerSummary` contract), `crm_campaign_performance` (MarketingAutomation, behind the campaign readability gate), `crm_list_emails` (kernel, metadata only). `MAX_TOOLS` 20 → 24; catalogue asserted as 25 entries; new suite `ai-domain-tools.test.ts` (5 cases, happy + denial paths); `crm-chat-evaluation.test.ts` 62 → 70 cases; module v1.3.0, contract unchanged. §8 items for Projects/Sales/Marketing and Email now closed on the read side only — triggers remain unimplemented. |
| 1.0.0 | 2026-10-20 | Initial plan: product contract, threat model, data model, roadmap 19-CHAT.0 → 19-CHAT.19. |
| 1.1.0 | 2026-10-21 | Module shipped (contract v1.2.0). This file was **not** updated, which is why it still described the module as planned. |
| 1.7.0 | 2026-11-03 | Gap closure following 19-CHAT.24: **G38** `features.readTools` is now enforced on `POST action/turns` and `action/query/execute` and reported through `actions.canStartTurn` (deployment-visible — a flag-off installation stops answering until an operator switches it on); **G39** a turn's `result.sources` is re-authorized with the citation rule; **G37** the Case guard accepts the record API's own `own`/`team` create stamp instead of refusing it, and the IDOR test that had been passing on a failed create now asserts the create; **G63** `/admin/*` routes are guarded by the server's own `GET /AdminPanel` answer rather than a hand-written capability map. `MAX_TOOLS` raised 8 → 20 so one assistant can hold the Chat-facing catalogue; §17 phase 24's as-built row reworded accordingly. |
| 1.6.0 | 2026-11-03 | Phase 19-CHAT.24 shipped: suggestions are declared data with `requiresTool`, filtered by `capabilities.assistant.tools` (`CRMChatSuggestions.tsx`, 8 chips, en+vi); 40 per-tool evaluation cases in `crm-chat-evaluation.test.ts` across three assistants (`MAX_TOOLS` = 8 grants per agent); catalogue asserted as 21 entries in `ai-agent-runs.test.ts`; module v1.2.0, `implementedPhases` 0–24, contract version unchanged. Updated §0.1, §16, §17 phase 24 and the final instruction. |
| 1.5.0 | 2026-11-03 | Phase 19-CHAT.23 shipped: `crm_lead_score` (lead-score), `crm_customer_health` (customer-success), `crm_case_context` (service-desk), `crm_stale_records` and `crm_run_report` (ai-agents). Registry 15 → 20 keys. Four of the five are contributed by the module that owns the service (§9.1 rule 6). `crm_stale_records` is one ACL-aware SQL query with a single `NOT EXISTS` over `stream_items`. New suite `crm-chat-intelligence-tools.test.ts` (7 cases). Updated §0.1 and §17 phase 23. |
| 1.4.0 | 2026-11-02 | Phase 19-CHAT.22 shipped: `crm_post_note` (Stream), `crm_log_activity`, `crm_draft_email` (never sends), `crm_create_task` v2 (parent + actor default), `crm_update_record_fields` v2 (wider allowlist, same class). Registry 12 → 15 keys. Corrected the plan's claim that grants reference a tool version. |
| 1.3.0 | 2026-11-02 | Phase 19-CHAT.21 shipped: `crm_aggregate`, `crm_list_activities`, `crm_actor_context` (in `ai-agents`) and `crm_cross_module` (contributed by `crm-chat`); `ai-agent-periods.ts` resolver; `AIAgentActorDirectoryService` shared with the prompt; `EntityService.linkedSourceIds`. Registry 8 → 12 keys. Updated §0.1, §1.1, §17 phase 21. |
| 1.2.0 | 2026-11-02 | Status corrected to implemented; added §0.1 delivery status and the two rules that follow from it. Added §1.1 capability-status paragraph, §5.4/§5.5/§5.6/§6.3/§10.3/§14.3 requirements learned from the shipped module, §18.1 v2 addendum, §19.2 v2 boundary. Added phases 19-CHAT.20 (shipped) → 19-CHAT.24 (planned) implementing the catalogue in `plans/SPEC.md` §9. Rewrote the final instruction to start at 19-CHAT.21. |

---

## Final Instruction to the Coding Agent

Phases 19-CHAT.0 → 19-CHAT.24 are shipped. Do not re-implement them and do not extend them in place;
a new capability is a new phase with its own acceptance evidence.

**The open work is now 19-CHAT.25 → 19-CHAT.31 (§17, audit 2026-11-07, corrected)** — settings and
limits honesty, context forwarding, contract accuracy, bounded data loading, stream id hygiene,
frontend component coverage, and UI decomposition. Each phase has its own acceptance evidence;
implement one at a time.

Suggested start order (P1 first): **19-CHAT.26** (validated context refs are silently dropped) →
**19-CHAT.25** (the UI accepts 5,000 characters that the API refuses) → **19-CHAT.29** (resume is
broken after a heartbeat) → **19-CHAT.27** (contract drift), then the P2/P3 phases. 19-CHAT.26 has a
hard dependency: land **19-AI.28** (multi-reference run input) in
`plans/PLAN_Phase_19_AI_Agents.md` first; §0 forbids working around the owner module. The items
§8 and §9.8 of `plans/SPEC.md` left outside the catalogue (live-provider evaluation, Vietnamese docs
review) still each need their own phase before code.

When a new tool phase is opened:

1. Read `plans/SPEC.md` §7 for the shipped registry and §9 for the tool design rules — especially §9.1 rule 6, which decides whether your tool belongs in `ai-agents` or in the domain module that owns the service.
2. Read `apps/api/src/ai-agents/ai-agent-tools.ts` end to end. The registry is deliberately small; adding to it is a design decision, not a configuration change.
3. Read the owning service before wrapping it. If the service already applies ACL, use it — do not build a second predicate.
4. Add the Zod schema **and** the hand-written JSON Schema. The model never sees Zod.
5. Add the catalogue assertion and one evaluation case in the same commit. A tool without a test is a tool nobody will notice breaking.
6. If the tool unlocks a question worth advertising, add a chip to `CRM_CHAT_SUGGESTIONS` with its `requiresTool`, and both locales. A chip with a tool that does not exist is a chip that never renders.

Follow `AGENTS.MD` for every database operation. Never create a separate test database, shadow schema or container, and never reset the configured database. Never let a test send a real message.
