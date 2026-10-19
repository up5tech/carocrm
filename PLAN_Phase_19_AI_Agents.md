# PLAN_Phase_19_AI_Agents.md — AI Agents Module

> **Status:** Implementation plan  
> **Parent roadmap:** `PLAN.md` — NestJS reimplementation of EspoCRM  
> **Phase identifier:** Phase 19 — `AIAgents`  
> **Module name:** `AIAgents` (**do not add a `Ua` prefix**)  
> **Module registry key / route slug:** `ai-agents`  
> **Suggested NestJS module class:** `AIAgentsModule`  
> **Frontend label:** `AI Agents`  
> **Backend:** NestJS + TypeScript, using the repository's established PostgreSQL and SQL access layer (Kysely or its explicitly adopted equivalent)  
> **Frontend:** Existing React SPA and its established component/state/form/router conventions  
> **Architecture:** Modular monolith; agent execution is a domain module, not a new microservice by default  
> **Prerequisites:** Existing CRM kernel, authentication, ACL, metadata/entity engine, API, background jobs, audit/logging, and provider configuration where available  
> **Already-completed domains to integrate with:** `Projects`, `Sales`, `CustomerSuccess`, `ServiceDesk`, `MarketingAutomation`, and `Portal`  
> **Implementation rule:** Audit and reuse completed foundations. Do not rebuild generic CRM infrastructure inside `AIAgents`.

---

## 1. Purpose and Product Definition

Implement a first-class AI-agent capability inside the NestJS CRM. Authorized administrators and business users must be able to configure agents that can interpret a goal, use explicitly granted CRM tools, perform bounded multi-step work, request human approval for sensitive actions, and produce traceable results.

This is a **governed agent-orchestration module**, not merely a chat screen. It must manage the complete lifecycle of an agent: configuration, publication, permissions, execution, tool calls, state transitions, memory, approvals, observability, evaluations, cost limits, and retirement.

### 1.1 Naming rules

- The module is named `AIAgents`.
- Do not use `UaAIAgents`, `UaAiAgents`, or any other `Ua`-prefixed name.
- Use the repository's existing naming convention for directories, files, API routes, metadata, translations, migrations, and exports.
- Suggested backend domain directory: `ai-agents/`.
- Suggested module registry key and URL slug: `ai-agents`.
- Suggested service/provider names: `AIAgentsModule`, `AgentDefinitionService`, `AgentRunService`, `AgentToolRegistry`, and `AgentPolicyService`, adapted to the current codebase's casing and conventions.
- Never rename existing modules or change their public contracts solely to match this plan.

### 1.2 Product outcomes

At completion, the system should allow authorized users to:

1. Create, configure, version, test, publish, pause, archive, and retire AI agent definitions.
2. Choose an AI provider/model from a centrally configured and approved provider catalog without exposing provider secrets to the browser.
3. Define each agent's purpose, instructions, allowed tools, input schema, output schema, limits, memory behavior, trigger policy, and approval requirements.
4. Execute an agent interactively or from approved server-side events, schedules, or supported automation triggers.
5. Permit the agent to search and read CRM information only through registered tools that enforce the initiating user's or service identity's authorization.
6. Permit writes only through explicitly allowlisted tools and validated arguments, with policy gates for sensitive or irreversible actions.
7. Track every run and each model request, step, tool call, approval, retry, failure, token/cost estimate, and final result.
8. Pause a run for approval or user input and resume it safely without repeating completed side effects.
9. Offer bounded conversation context and optional memory with tenant/account scope, ACL revalidation, retention controls, and deletion policies.
10. Reuse the completed CRM domains where appropriate, including Sales, CustomerSuccess, ServiceDesk, MarketingAutomation, Projects, Portal, Activities, Notifications, and existing jobs.
11. Give administrators effective controls over access, allowed models, tool scopes, quotas, retention, and execution policy.
12. Evaluate agents against reproducible test cases before publication and detect regressions when prompts, tools, or models change.

### 1.3 Core design principles

- **Governed autonomy:** an agent may plan and act only within its configured tool and policy boundaries.
- **Least privilege:** no implicit access to all CRM entities or operations.
- **Acting-user authorization:** CRM operations must enforce the current principal's effective permissions; agent identity must never bypass normal ACL.
- **Human accountability:** sensitive actions can require explicit, current, auditable human approval.
- **Traceability:** every decision-relevant model call and tool action has a durable, queryable run record, with sensitive payloads redacted where needed.
- **Bounded execution:** each run has limits for steps, elapsed time, model calls, tokens, cost, tool calls, recursion, and retry count.
- **Provider independence:** business logic must not depend on a single model vendor's SDK or response format.
- **Tool-mediated access:** an LLM never receives direct database credentials, arbitrary SQL execution, filesystem access, shell access, or unrestricted internal APIs.
- **Data minimization:** send only the context required for the current task to the configured model provider.
- **Human-readable outcomes:** report what was done, what was not done, what needs approval, and which records were changed.
- **Safe failure:** timeouts, provider errors, malformed output, policy denial, and interrupted jobs must not create silent or duplicate business actions.
- **Composable domain integration:** optional modules are connected through stable interfaces/events and remain independently usable.

---

## 2. Reference Boundary and Feature Positioning

### 2.1 Relationship to EspoCRM AI features

Use the public EspoCRM documentation as a behavioral and architecture reference, not as a source-code dependency. EspoCRM's Intelligence extension documents AI assistance such as summaries, intelligent paste, AI email composition, formula functions, usage logging, and quotas. Its MCP extension allows administrators to expose selected CRM operations as tools while respecting the user's permissions. These are useful reference points for provider configuration, usage controls, and governed CRM tool exposure.

This `AIAgents` module extends that concept into multi-step, stateful, policy-governed execution. It must not copy upstream PHP source, frontend assets, translations, icons, or branding.

Reference URLs:

- EspoCRM Developer Documentation: https://docs.espocrm.com/development/
- EspoCRM Modules: https://docs.espocrm.com/development/modules/
- EspoCRM Metadata: https://docs.espocrm.com/development/metadata/
- EspoCRM ACL: https://docs.espocrm.com/development/acl/
- EspoCRM API: https://docs.espocrm.com/development/api/
- EspoCRM Intelligence overview: https://docs.espocrm.com/extensions/intelligence/
- EspoCRM MCP extension: https://github.com/espocrm/ext-mcp

### 2.2 Distinction from adjacent modules

| Capability | Owning component | Boundary for `AIAgents` |
|---|---|---|
| Provider credentials, connectivity, model catalogue | Existing AI/provider integration or a shared AI Gateway, if present | Reuse it; otherwise implement a thin provider abstraction only as needed and document ownership |
| Single-step summaries, rewriting, extraction, classification, or email drafting | Existing `Intelligence`/AI-assistance capability, if present | Expose these as tools or shared services; do not duplicate their UI and logic |
| Multi-step goal-oriented agent runs | `AIAgents` | Primary responsibility |
| Entity CRUD, record ACL, metadata, relationships | CRM kernel / Entity Engine | Call existing APIs/services; never reimplement these in the agent module |
| Business workflows and BPM | Existing Workflow/BPM platform, if present | Integrate through registered triggers/actions; do not build a competing general workflow engine |
| Bulk email journeys and marketing campaign execution | `MarketingAutomation` | Agents may recommend, draft, or initiate approved actions through a governed integration; MarketingAutomation remains responsible for consent and actual sending |
| Customer health, onboarding, renewal, and success plans | `CustomerSuccess` | Consume insights or propose actions through approved tools; CustomerSuccess owns its business rules |
| Tickets, service queues, case state, and SLA | `ServiceDesk` | Allow governed ticket lookup or updates through dedicated tools; ServiceDesk owns the case lifecycle and SLA logic |
| Products, quotes, invoices, orders, payments | `Sales` | Use specific sales tools and strict financial approval rules; Sales remains authoritative |
| Project plans and project tasks | `Projects` | Delegate project operations to the Projects domain |
| External agent access over MCP or another protocol | Existing integration layer or `AIAgents` protocol adapter, depending on audit | Do not expose a broad endpoint without authentication, tool allowlists, and policy enforcement |

### 2.3 Out of scope for the first release

- A fully autonomous agent with unrestricted access to all CRM data.
- Arbitrary SQL, shell, filesystem, browser, or code execution initiated by a model.
- Self-modifying production prompts or automatic publishing without review.
- Automatic sending of customer-facing email/SMS, changing invoices/payments, deleting records, changing permissions, or issuing refunds without explicit policies and any required approval.
- Training foundation models on CRM data.
- Building a new general workflow/BPM engine, general email infrastructure, or a second notification system.
- Replacing the existing CRM ACL with agent-specific access rules.
- Unbounded multi-agent swarms or recursive delegation without limits.
- Promising deterministic outputs from probabilistic models.
- Making vendor-specific features mandatory for core agent execution.

---

## 3. Repository Audit and Implementation Constraints

Before writing code, inspect the actual repository. The plan is not a substitute for verifying what exists.

### 3.1 Required audit items

- Read `PLAN.md`, `AGENTS.MD`, existing module conventions, and relevant recent implementation plans.
- Inspect the module registry, navigation/metadata registration, DI conventions, permissions/scopes, API response/error shape, and migration system.
- Inspect `package.json`, workspace files, lockfiles, provider SDKs, validation libraries, logging/tracing, job framework, cache, encryption utilities, and test scripts before adding dependencies.
- Confirm whether an AI provider abstraction or gateway already exists; list supported providers/models and their credential storage mechanism without printing secrets.
- Confirm whether a model usage/quota ledger already exists and whether `Intelligence`/AI-assistance functions are present.
- Verify whether Redis/BullMQ or another background execution system is available and how jobs are secured, retried, and observed.
- Confirm the actual existing versions and tool contracts for `Sales`, `CustomerSuccess`, `ServiceDesk`, `MarketingAutomation`, `Projects`, Portal, Activities, Notifications, and Workflow/BPM, where present.
- Confirm how current-user identity and effective ACL are propagated into service calls and background jobs.
- Inspect existing audit/history events and determine how they represent a before/after change without leaking sensitive values.
- Inspect existing environment configuration and feature flags without logging secrets.
- Inspect tests and scripts for automatic database creation, resets, schema drops, seed cleanup, real email, real webhooks, or billable external API calls.

### 3.2 Audit deliverables

Create or update a concise audit document, for example `docs/modules/ai-agents/repository-audit.md`, containing:

- Existing reusable components and their actual import/API paths.
- Missing capabilities and the smallest acceptable additions.
- A module dependency diagram.
- Proposed entity/table migration list.
- Existing provider capabilities and gaps.
- Existing agent-related code that must be extended rather than duplicated.
- Security findings and any implementation blockers.
- Approved first-release boundary and items explicitly deferred.

Do not mark a feature as existing merely because it appears in `PLAN.md`. Verify the implementation.

### 3.3 Mandatory stop conditions

Stop before making production-impacting changes and report the issue if:

- A required provider credential or encryption key is missing and there is no supported secure configuration path.
- The intended database target is uncertain or clearly production and the proposed action may modify real business data or trigger external effects.
- A migration requires destructive changes or a broad rewrite of existing agent/provider tables.
- Effective ACL cannot be reliably applied to a proposed tool.
- A tool would expose confidential data beyond the invoking identity's permissions.
- Safe replay/idempotency cannot be established for an action that might send messages, create financial transactions, or cause irreversible effects.

---

## 4. Architecture and Module Boundaries

### 4.1 Target architecture

Implement `AIAgents` as a domain module in the existing modular monolith. A typical conceptual flow is:

1. The UI/API receives a request to start an agent run.
2. Authentication establishes the initiating user, tenant/organization context (if applicable), and correlation ID.
3. Agent policy checks publication state, actor access, input schema, allowed trigger, quotas, and concurrency limits.
4. A durable run record and initial event are committed before long-running work begins.
5. A worker loads the immutable published agent version and creates a bounded execution context.
6. A provider adapter performs model calls using minimized, policy-approved context.
7. The model may request a tool only from the registered allowlist for that agent and actor.
8. The tool registry validates arguments, checks permissions and approval policy, executes the domain operation, and records the result.
9. The run state machine continues, pauses for approval/input, or ends with a success/failure/partial result.
10. Usage, traces, audit events, and final outputs are persisted and surfaced in the UI.

The LLM proposes actions; trusted application code decides whether those actions may execute.

### 4.2 Conceptual components

- **Agent Definition Registry:** agent identities, descriptions, lifecycle state, and configuration versions.
- **Agent Version Service:** immutable snapshots of system instructions, model policy, tool grants, input/output schemas, and run limits.
- **Provider Gateway:** vendor-neutral model request/response contract, timeouts, normalized errors, usage extraction, and redaction.
- **Tool Registry:** typed tool definitions, argument schemas, execution handlers, effect classification, and required permissions.
- **Agent Policy Engine:** tool allowlists, data scopes, limits, approvals, trigger policy, quotas, and provider restrictions.
- **Run Orchestrator:** durable state machine, bounded step loop, checkpointing, cancellation, pause/resume, retries, and finalization.
- **Memory Service:** optional thread/run memory, retention, summarization, retrieval, and ACL-aware filtering.
- **Approval Service:** pending action proposals, authorized approvers, expiry, approve/reject, and execution-time revalidation.
- **Usage and Budget Ledger:** requests, tokens, estimated cost, provider-reported cost where available, quotas, and alerts.
- **Evaluation Service:** test suites, runs, graders, comparison reports, regression thresholds, and publication gates.
- **Observability Service:** structured run events, correlation IDs, latency, error categories, redacted tool traces, and safe diagnostics.
- **Admin UI:** providers/models (or link to existing settings), tool catalogue, policies, quotas, retention, agent administration, run history, and evaluations.
- **User UI:** chat/task entry point, agent selection, status/progress, approval cards, run timeline, cancellation, and result review.

These are conceptual boundaries, not a demand to create a class/service for every bullet. Follow the codebase's existing module structure and avoid speculative abstractions.

### 4.3 Synchronous and asynchronous requests

- Short, bounded requests may use a synchronous path only if it conforms to the established API timeout budget and cannot perform unsafe side effects.
- Multi-step, scheduled, trigger-based, or tool-heavy runs must use the durable job system that already exists.
- The request path should return a run ID and a stable status contract when work is asynchronous.
- Do not keep an HTTP request open during long-running agent reasoning.
- If the job runner is unavailable, fail clearly or use a documented safe fallback; do not silently start untracked background promises in a web process.

### 4.4 Persistence model

Use the repository's existing PostgreSQL database and migration framework. The tables below are logical concepts; align names and column conventions with existing migrations, metadata/entity patterns, and audit facilities.

Core data concepts:

- `ai_agent`: stable identity, display name, description, owner/team, status, visibility, current published version pointer, created/modified metadata.
- `ai_agent_version`: immutable published configuration; version number, prompt/config snapshot, model policy, tool grants, JSON schemas, limits, memory policy, trigger policy, checksum, publication actor/time.
- `ai_agent_tool_grant`: tool grant and constraints for an agent version, including read/write classification and allowed field/entity scopes.
- `ai_agent_run`: durable execution record; agent/version, initiating user or service principal, trigger, status, requested input reference, start/end times, counters, final result reference, failure category, cancellation state, idempotency key.
- `ai_agent_run_event`: ordered append-only event timeline with step, event type, timestamps, safe payload summary, trace correlation, and visibility classification.
- `ai_agent_tool_call`: proposed/validated/executed tool call, tool/version, argument hash and protected argument snapshot where justified, policy result, approval link, outcome reference, duration, retry count, idempotency marker.
- `ai_agent_approval`: proposed operation, requesting run/step, human-readable rationale, affected entity/record references, risk level, required approver policy, expires-at, decision, decision actor/time, revalidation state, and execution result.
- `ai_agent_conversation`: conversation/thread identity, owner, agent, optional related CRM record, lifecycle state, retention metadata, last activity.
- `ai_agent_message`: user/agent/tool message or structured event; role/type, protected content or reference, token usage, redaction state, sequence.
- `ai_agent_memory_item`: optional scoped fact/summary/reference, source references, ACL/tenant scope, confidence/provenance, sensitivity classification, expiration, and deletion state.
- `ai_agent_provider_request`: provider/model, run/step correlation, request and response metadata, latency, usage counts, estimated cost, normalized outcome, redaction metadata; avoid storing unredacted full prompts by default.
- `ai_agent_budget_policy`: applicable scope and limits by user/team/agent/provider/time window.
- `ai_agent_evaluation_suite`: suite identity, dataset references, grader definitions, score thresholds, and permissions.
- `ai_agent_evaluation_case`: input fixture or protected reference, expected properties, forbidden behaviors, and metadata.
- `ai_agent_evaluation_run`: tested agent version, result metrics, failure classifications, model/provider, and timestamps.
- `ai_agent_tool_registry` may be code/metadata-backed rather than a writable table; only store admin configuration if the repository's extension model requires it.

Do not store API keys in these agent tables. Reuse the existing encrypted secret/configuration system or introduce a secure secrets interface only if none exists.

### 4.5 Database rules

- Use stable IDs consistent with the project, timestamps in UTC, explicit foreign keys/indexes where appropriate, and tenant/organization keys when the platform supports multi-tenancy.
- Store counters and monetary usage values in appropriate exact numeric/integer types; do not use floating-point arithmetic for cost accounting when precise decimal arithmetic is available.
- Run and append audit/run events within consistent transaction boundaries; never persist a “success” state before the corresponding operation has actually succeeded.
- Use optimistic concurrency or row locking to prevent two workers from executing the same run step concurrently.
- Keep published agent versions immutable; editing a draft produces a new version.
- Use additive, backward-compatible migrations where feasible.
- Never store whole CRM records redundantly as agent memory when a source-record reference plus ACL-aware retrieval is sufficient.
- Establish retention and deletion semantics for prompts, outputs, tool arguments, messages, evaluations, and usage records.

---

## 5. Agent Definition and Version Lifecycle

### 5.1 Agent fields

An agent definition should support:

- Unique stable key, display name, short description, purpose/category, icon reference from the project's own approved icon set, owner, team, and visibility.
- Lifecycle state: `draft`, `published`, `paused`, `archived` (or the repository's equivalent state vocabulary).
- Draft configuration and current published version pointer.
- Selected provider/model policy, fallback policy if supported, and structured-output capability requirements.
- System instructions and user-facing behavior description.
- Input schema and output schema.
- Tool grants and per-tool constraints.
- Trigger permissions: manual, record action, domain event, schedule, inbound integration; disabled by default until explicitly configured.
- Execution limits: maximum steps, tool calls, model calls, token budgets, estimated cost, elapsed time, retry count, context window, and concurrency.
- Memory mode, scope, retention, and allowed sources.
- Approval policy by action class and risk level.
- Data sensitivity class, logging/redaction policy, and optional regional/provider restrictions.
- Allowed user roles/teams and usage quota policy.
- Publication metadata and version checksum.

Do not provide unbounded free-form configuration for critical policy values. Validate policy fields using a typed schema.

### 5.2 Lifecycle transitions

- `draft -> published`: requires valid configuration, tool permissions, output/input schema checks, provider configuration, security review appropriate to the risk tier, and passing required evaluations.
- `published -> paused`: stops new runs; the admin decides whether active runs are allowed to finish, pause, or be canceled according to documented policy.
- `paused -> published`: revalidates provider/tool configuration and quotas before reactivation.
- `published|paused -> archived`: prevents new runs and retains history per retention policy.
- `archived -> draft`: only through an explicit restore-to-draft action that creates a new draft/version rather than mutating old published snapshots.
- Changing a published prompt, tool grant, output schema, model restrictions, or approval policy creates a new immutable version.
- Existing runs continue against their captured version unless an explicit emergency kill-switch policy cancels them.

### 5.3 Publication validation

Before publish, validate:

- Provider/model is configured, enabled, and permitted for the agent's data class.
- Prompt and configuration size stay within limits.
- Input/output schema is valid and bounded.
- Each named tool exists, is enabled, and has a typed input/output contract.
- Agent tool grants are subsets of globally enabled tools and the publisher's authority.
- Each write-capable tool has an effect classification, authorization checks, and idempotency strategy.
- Approval policy is present for sensitive tool classes.
- Memory scope/retention is explicit.
- Runtime limits are configured with safe finite values.
- Required evaluation cases pass their publication thresholds.
- There are no references to disabled providers, deleted tools, or unpublished agent versions.

---

## 6. AI Provider Abstraction

### 6.1 Provider gateway contract

Use the existing provider/gateway service if one exists. If it does not, implement the minimum shared adapter abstraction needed for this module without committing the entire CRM to a single vendor SDK.

The normalized provider contract should cover:

- Text and structured-output requests.
- Tool/function-call request and result serialization, where supported.
- System/user/assistant/tool messages with safe normalization.
- Model identifier and capability metadata.
- Token/usage reporting when available.
- Timeouts, cancellation, retry hints, and normalized error types.
- Provider request IDs and safety/finish metadata when returned.
- Explicit handling for unsupported features rather than silent degradation.
- Per-model max context/output limits and optional capability flags.

Potential provider adapters may include OpenAI-compatible APIs, OpenAI, Google Gemini, Anthropic Claude, and approved self-hosted/local providers such as Ollama, **only where those providers are actually configured and supported by the repository**. Do not make all providers mandatory in the first implementation.

### 6.2 Credential and secret handling

- Never send provider API credentials to the frontend or store them in agent prompts, tool arguments, run events, or logs.
- Reuse the project's encrypted integration-secret mechanism. If no secure mechanism exists, implement a dedicated encrypted secret storage interface with key rotation and access controls; do not store raw API keys in ordinary configuration JSON.
- Read credentials only server-side and scope them to the provider account/connection.
- Redact authentication headers, API keys, signed URLs, and sensitive provider metadata from diagnostics.
- Support credential rotation without changing agent definitions.
- Never fall back to an unapproved external provider if a configured provider fails.

### 6.3 Provider routing and fallback

- A published agent may specify a primary model and an explicit list of allowed fallback models.
- Do not silently change provider/model for data that has stricter residency, retention, or confidentiality requirements.
- Before a fallback, verify that the model is allowed for the same data classification and supports the required tool/output contract.
- Record the actual provider/model on each request for audit and cost analysis.
- Fallback must preserve run budgets; provider outages must not cause infinite retries or duplicate tool actions.
- Fallback between providers is disabled by default for high-risk agents unless configured and approved.

### 6.4 Prompt and context construction

- Use versioned prompt templates and structured prompt composition in trusted application code.
- Separate system policy, agent-specific instructions, user task, retrieved CRM context, and tool outputs.
- Mark retrieved content and tool output as untrusted data; never interpret CRM note/email/ticket content as privileged system instructions.
- Minimize data included in provider requests; fetch only fields needed for the current step.
- Enforce context-window limits using explicit truncation, ranking, or summarization rules. Do not silently discard approval/policy state.
- Keep prompt injection guidance and tool policy outside user-controlled content.
- Persist prompt hashes/version IDs and safe metadata; full prompt capture must be opt-in with documented access and retention.

---

## 7. Tool Registry and CRM Operations

### 7.1 Tool definition contract

Every tool exposed to an agent must be registered by trusted application code or an explicitly approved extension. A tool definition should include:

- Stable key, display name, description, version, owning module, and enabled state.
- JSON Schema or the project's chosen strict validation schema for input and output.
- Read/write/external-side-effect classification.
- Required scopes, entities, fields, record constraints, and minimum role/permission requirements.
- Whether it can create, modify, delete, send, publish, charge, or trigger external effects.
- Whether approval is mandatory and who can approve it.
- Idempotency/replay behavior, timeout, retry policy, and result-size limits.
- Redaction rules and audit event classification.
- Handler implementation and tests.

The LLM must only select tool IDs and arguments; it must not supply arbitrary URLs, handler names, SQL, code, or permission rules.

### 7.2 First-party CRM tool families

Begin with a narrow, safe catalogue and expand based on actual need:

**Discovery and read tools**
- Search records through the Entity Engine with allowlisted entity/field/filter/sort options.
- Read a record through the normal service/API and ACL path.
- Retrieve allowed related records with page/size caps.
- Retrieve an authorized record's activity/stream summary.
- Read sales pipeline or aggregate metrics through approved reporting/query services rather than raw SQL.
- Read a CustomerSuccess health profile or renewal status through its public service contract.
- Read ServiceDesk ticket/SLA information through ServiceDesk's public contract.
- Read Project status/milestones through Projects' public contract.
- Read MarketingAutomation campaign metadata or aggregated outcomes without bypassing consent or messaging rules.

**Low-risk write tools (still permission-checked)**
- Create a Task, Note, or Activity assigned within the actor's scope.
- Draft, but not send, an email or marketing message.
- Prepare a proposed field update for human review.
- Create a proposed success-plan action or case summary.

**Higher-risk write tools (approval or stricter policy)**
- Update account/contact/lead/opportunity fields.
- Create or modify quotes, orders, invoices, subscriptions, or financial records.
- Change ServiceDesk ownership, priority, status, or customer-facing messages.
- Start or modify MarketingAutomation execution, campaign membership, or message delivery.
- Send emails, create portal-visible content, or initiate external webhooks.
- Delete or merge CRM records.

No tool should directly bypass the owner module's validation, business rules, ACL, audit, or event handling. Do not permit direct writes to generic tables as an alternative to calling domain services.

### 7.3 Tool-call validation pipeline

For every proposed tool call, follow this order:

1. Resolve the requested tool only through the server-side registry.
2. Confirm the tool is globally enabled and included in the immutable agent version.
3. Validate arguments against the current schema; reject unknown fields by default.
4. Validate limits, identifier formats, result size, and input normalization.
5. Resolve the initiating principal or configured service principal and its current permissions.
6. Apply field-level, record-level, team, tenant, and portal boundaries.
7. Check risk classification, consent requirements, and any required human approval.
8. Confirm idempotency key/replay state before effects.
9. Execute through a domain-owned service inside the required transaction boundary.
10. Redact and persist the outcome, emit audit/run events, and return only the information permitted to the agent.

If any check fails, deny the call with a safe, actionable policy error. Do not ask the model to choose a workaround that weakens policy.

### 7.4 No arbitrary-code execution

- Do not implement general Python/JavaScript eval, shell, SQL, file-system, or arbitrary HTTP tools as a default capability.
- If a future use case requires custom code, it must be a separate reviewed sandbox project with strict CPU, memory, wall-clock, network, and filesystem limits, signed/versioned packages, and an explicit threat model.
- An LLM-generated filter/query must be parsed to a safe query plan and validated against allowlists; never interpolate it into SQL.
- External URLs must be preconfigured or restricted by domain allowlists and SSRF protections. Never allow model-supplied URLs to reach internal services or cloud metadata endpoints by default.

### 7.5 Idempotency and side effects

- Write tools must accept an idempotency key derived from run ID + step ID + tool-call identity, or use the repository's equivalent.
- Before a retry, resolve whether the first execution committed and return its recorded outcome where possible.
- A worker crash after an external side effect must not cause an automatic duplicate email, payment, subscription change, or webhook delivery.
- Distinguish safe retry, retry-after-reconciliation, and non-retryable failures.
- Never claim a tool action succeeded if its result is unknown; mark it `outcome_unknown` and require reconciliation or human review.

---

## 8. Agent Runtime and Run State Machine

### 8.1 Supported execution styles

- **Interactive run:** user gives a task to a selected agent and sees progress/results.
- **Record-context run:** user invokes an agent from an authorized record view; context is assembled only from accessible fields/relations.
- **Event-triggered run:** an approved platform/domain event starts the agent with a typed, minimal payload.
- **Scheduled run:** an approved schedule triggers a bounded agent run through the existing scheduler/worker.
- **Integration-triggered run:** an authenticated webhook or supported integration requests an execution under a configured service identity.

All non-interactive triggers are disabled until an administrator explicitly enables the trigger and its service identity, scope, rate limits, and allowed agent version.

### 8.2 Run states

Define a durable state machine with at least:

- `queued`
- `running`
- `waiting_for_approval`
- `waiting_for_input`
- `retry_wait`
- `cancel_requested`
- `succeeded`
- `partially_succeeded`
- `failed`
- `canceled`
- `expired`
- `blocked_by_policy`
- `outcome_unknown` (if an effect may have happened but cannot be reconciled)

The implementation may combine or rename states to fit existing conventions, but equivalent semantics must remain explicit and externally documented.

### 8.3 Execution loop constraints

- Execute one persisted step at a time; persist the step proposal and result at safe checkpoints.
- Enforce finite limits for steps, tool calls, model calls, elapsed time, tokens, estimated cost, recursion/delegation depth, result size, and retries.
- Before each provider call and each tool action, check cancellation, agent status, quota, time budget, and current policy.
- Do not let the model control its own quota, budget, allowed tool list, timeout, or ACL context.
- Do not rely on in-memory process state for durable progress.
- A worker may claim a run through a lease/lock; lease expiry and recovery must prevent concurrent duplicate execution.
- Treat provider responses as untrusted. Validate output format and tool-call arguments before doing anything.
- Detect repeated identical tool-call loops and repeated no-progress steps; stop with a clear reason.
- Keep a finite maximum for follow-up clarification turns in interactive mode.

### 8.4 Tool loop and structured output

- Support structured output with schemas where the chosen provider supports it.
- Validate the response with the repository's server-side validator.
- When a response is invalid, allow a small, bounded correction attempt, then fail safely.
- Do not automatically coerce dangerous or ambiguous values into valid ones.
- Tool results should be concise, typed, size-capped, and stripped of irrelevant personal data.
- The agent's final answer must distinguish completed changes, proposed actions, denied actions, skipped steps, and unknown outcomes.

### 8.5 Cancellation and recovery

- A cancellation request prevents any new tool calls once observed.
- For already-running calls, attempt supported provider/job cancellation, then wait or reconcile according to the tool contract.
- Cancellation cannot undo already-committed effects unless a domain-specific compensation workflow is explicitly implemented.
- On worker restart, resume from the last durable safe checkpoint, not by replaying the entire conversation blindly.
- Expire stalled runs using a documented policy; record who/what expired them.
- Provide an administrator kill switch to block all new agent runs or disable high-risk tool families without deleting configuration or history.

---

## 9. Human Approval and Risk Policy

### 9.1 Action risk classes

Define configurable and centrally governed risk classes, such as:

- **Read-only:** search and retrieve information within ACL.
- **Low-risk write:** create internal notes/tasks/drafts that do not contact customers or change financial/legal state.
- **Material write:** update customer records, change assignments/status, create customer-visible content, or alter shared business records.
- **High-impact:** send external communication, trigger campaigns, publish content, modify contracts/quotes/invoices/subscriptions/payments, change access controls, bulk-update records, or delete/merge records.

Exact mappings must be reviewed against the real tool catalogue; do not trust a tool's self-declared low-risk label without code review.

### 9.2 Approval policy

- Each agent version declares which action classes can run automatically and which require approval.
- Defaults: read-only can run automatically within ACL; external communications, financial operations, bulk changes, deletion/merge, permission changes, and irreversible actions require approval or remain disabled.
- Approval requests show the initiating user, agent and version, purpose, exact proposed action, target records, changed fields, customer impact, risks, and expiration.
- Approvers must have a dedicated permission and authority over the affected records/action type.
- An agent cannot approve its own action; approval links must not be bearer tokens that bypass authentication.
- Approval decisions are authenticated, timestamped, auditable, and immutable after finalization.
- Before executing an approved operation, re-check that the agent version, target state, actor/approver authority, consent, tool grant, record permissions, and policy are still valid.
- If arguments or target records change after approval, invalidate the approval and require a new one.
- Approval expiry or rejection must not automatically trigger an alternative write action.
- Bulk actions should show a bounded preview/count and require approval for the exact affected set or an explicitly approved query that is re-evaluated safely.

### 9.3 Approval UX

The review screen should include:

- Summary in plain language, generated by trusted UI formatting from typed action data.
- Exact before/after values for field changes, subject to viewer ACL.
- Exact recipients/content preview for external messages.
- Financial amount and currency for sales/payment operations.
- Affected record list or a clearly described validated filter.
- Agent reasoning summary only as explanatory, untrusted text, not as proof of safety.
- Approve, reject, request changes, and view related records actions according to permission.

Never put secrets or full restricted record snapshots into approval payloads visible to unauthorized approvers.

---

## 10. Memory, Conversations, and Retrieval

### 10.1 Memory modes

Support these modes only where there is a clear need:

- **No memory:** each run is isolated except for input/context explicitly provided.
- **Conversation memory:** retain a bounded conversation thread for an authenticated user and specific agent.
- **Run checkpoint memory:** persist state required to resume the same run safely.
- **Curated long-term memory:** store approved, scoped facts or summaries with provenance, sensitivity classification, retention, and access checks.
- **CRM retrieval:** fetch current records through ACL-protected tools rather than copying all fields into permanent memory.

Default to no long-term memory until configured. Memory must be transparent and governable, not a hidden store of unrestricted CRM facts.

### 10.2 Memory boundaries

- Scope memories by user, agent, tenant/organization, and/or record according to explicit configuration.
- Never share personal conversation memory across users unless it is deliberately converted into a shared, approved artifact.
- Re-check ACL whenever a remembered reference is used; permissions may have changed since the memory was stored.
- Keep provenance/source references so users can inspect where a remembered fact came from.
- Store creation time, last confirmation, confidence/status if relevant, expiry, and deletion metadata.
- Treat memory as untrusted context. It cannot override system policy, tool grants, or current user instructions.
- A summary is not a substitute for authoritative CRM data when correctness depends on the current record state.
- Provide retention controls, export/deletion support, and a way to disable memory per agent or user where feasible.
- Avoid storing credentials, secrets, payment details, special-category personal data, or unnecessary raw email/ticket content in long-term memory.

### 10.3 Retrieval-augmented context (optional)

- Reuse an existing search/RAG/vector layer if available. Do not introduce another vector database just for the initial agent release without a documented need.
- If adding retrieval, use a provider-neutral interface and explicit source connectors.
- Index only approved fields/documents and preserve source ACL, tenant boundaries, retention, and deletion propagation.
- Filter retrieved chunks by access permissions before passing them to the model; do not retrieve broadly and rely on the model to hide unauthorized content.
- Return source references/citations with generated answers where practical.
- Treat documents, notes, emails, Cases, and other retrieved text as untrusted input that may contain prompt injection.
- Retrieval must not grant action authority; only tool policy does that.

---

## 11. Security, Privacy, and Threat Model

### 11.1 Mandatory security requirements

- Enforce normal authentication, RBAC/ACL, record-level and field-level permissions on every API, trigger, tool call, approval, export, and background job.
- Validate all API input, persisted configuration, provider output, and tool arguments at runtime.
- Protect against prompt injection in user prompts, emails, CRM descriptions, stream posts, case messages, marketing content, documents, and tool outputs.
- Treat the model as an untrusted planner and never as a security boundary.
- Deny by default for unknown tool names, fields, arguments, agent keys, providers, triggers, and state transitions.
- Prevent cross-tenant and cross-user data leakage through conversation IDs, memory keys, run IDs, caches, vector retrieval, and logs.
- Apply SSRF defenses, outbound-domain allowlists, timeouts, and response size caps for any approved network tool.
- Limit concurrency and prevent cost-amplification attacks through public endpoints, repeated triggers, or tool loops.
- Do not log secrets, authorization headers, full database URLs, provider keys, or unnecessary raw personal data.
- Protect stored sensitive artifacts and approval details using existing file/secret protection mechanisms.
- Rate-limit agent run creation, conversation messages, tool calls, approval polling, and public/integration endpoints.
- Use CSRF/origin protections and existing secure session practices for browser APIs.
- Keep provider data-processing and retention settings visible to authorized administrators.

### 11.2 Prompt-injection defenses

- Separate trusted control instructions from untrusted data using structured message/context construction.
- The model must not be allowed to edit tool definitions, ACL policy, system prompt, approval policy, or runtime budgets.
- Do not follow instructions found inside CRM data that request disclosure, secret retrieval, tool grant changes, or policy bypass.
- A request to “ignore previous rules” within a customer email, ticket, document, website, or CRM note is data, not authority.
- Tools should return only the minimum result needed by the current step.
- For high-risk tools, provide deterministic server-side validation and approval, even if the model claims the action is safe.
- Add adversarial tests for indirect prompt injection and exfiltration attempts before enabling write tools.

### 11.3 Authorization context

- Store the initiating principal and authorization context reference on the run.
- For user-triggered work, execute CRM reads/writes as that user or with an explicit delegated capability that cannot exceed that user's current rights.
- For scheduled/system triggers, use a dedicated service principal with narrowly scoped permissions and a visible provenance marker; never reuse an administrator's personal identity silently.
- A queued job must not elevate privileges just because the original user's session expired.
- Re-evaluate relevant permissions immediately before each tool execution.
- Record which principal authorized each operation and whose action triggered it.
- Do not allow agent configuration visibility to imply permission to access all records handled by that agent.

### 11.4 Privacy and provider data governance

- Identify data classes eligible for each provider/model, including any restricted or local-only data categories chosen by the organization.
- Allow administrators to disable external-provider use for specified agents, fields, teams, and data categories.
- Minimize/redact inputs and outputs before provider transmission and logging.
- Document what data is sent, why, to which provider/model, and configured retention/region metadata when supplied by the provider.
- Respect CRM deletion/retention requirements for conversations, memory, prompts, outputs, and evaluations.
- Never use CRM data to train a provider's model unless the organization explicitly configures and approves that data-processing arrangement.
- Do not promise a provider's retention or training behavior unless verified for the selected plan/contract and configured endpoint.

---

## 12. Usage, Quotas, and Cost Controls

### 12.1 Usage ledger

Track, as available:

- Agent, immutable version, run, initiating user, team, trigger, provider, model, and feature/tool category.
- Request count, input/output token counts, cached token counts if reported, latency, retries, and normalized result.
- Estimated cost based on versioned configured price data or provider-supplied cost where available.
- Budget decisions, limit warnings, quota rejections, and provider failures.
- Tool invocation counts and external side effects separately from model tokens.

Clearly label estimated costs versus authoritative provider billing values. Do not hard-code rates in business logic; use versioned, admin-maintained or provider-returned pricing data.

### 12.2 Quota scopes

Support applicable limits such as:

- Global daily/monthly spend or token budget.
- Per-provider/model budget.
- Per-agent budget.
- Per-user/team budget.
- Per-run token/cost/step/tool-call/time limits.
- Maximum parallel runs and queued runs.
- Maximum pending approvals and interactive message frequency.

### 12.3 Budget enforcement

- Reserve or estimate budget before expensive calls when feasible.
- Reconcile provider-reported usage after each call.
- Stop safely if a hard limit is reached; preserve run state and explain what was completed.
- Soft limits should emit warnings and follow explicit policy, not silently become hard limits.
- Enforce limits atomically to avoid concurrent runs exceeding the same budget.
- Use provider-specific rate limits and bounded exponential backoff with jitter where appropriate.
- Do not automatically retry billing/quota/authentication errors that cannot recover through retry.

### 12.4 Administration views

Provide filters and aggregate reports by time, provider, model, agent, user/team, status, run type, error category, tokens, estimated cost, and tool effects. Restrict access to message bodies and sensitive traces more tightly than access to aggregate metrics.

---

## 13. Triggers and Domain Integrations

### 13.1 Trigger types

Initially support manual user runs. Add other trigger types only after manual runs, policies, logs, and safe execution are stable:

- Record action or detail-view button.
- Authorized domain event from existing modules.
- Schedule/cron through the existing job scheduler.
- Workflow/BPM action, if present.
- Authenticated webhook or integration event.
- MarketingAutomation event, such as an internal campaign or journey event, only through an explicit integration contract.

Triggers must specify agent version, schema-validated input, actor/service principal, de-duplication key, rate limits, and cancellation policy. Never trigger an agent from arbitrary user-controlled text without validation and throttling.

### 13.2 `Sales` integration

Possible approved capabilities:

- Read authorized account, opportunity, quote/order/invoice summaries through Sales contracts.
- Draft opportunity summaries, meeting preparation notes, or follow-up task suggestions.
- Prepare a proposed update to sales fields for user review.

Strict constraints:

- Do not autonomously create or alter a financial document, subscription, payment, price, tax, or invoice status unless an explicit tool policy and approval flow allows it.
- Do not bypass Sales calculation, tax, currency, locking, or validation services.
- Never assert that a payment occurred based only on model inference; rely on authoritative Sales data.

### 13.3 `CustomerSuccess` integration

Possible capabilities:

- Read health scores, risk reasons, onboarding tasks, success-plan goals, and renewal readiness when permitted.
- Draft a customer review brief, suggest risk mitigation, or propose an internal task.
- Suggest next best actions with evidence references.

Constraints:

- CustomerSuccess owns health calculation, lifecycle, risk and success-plan rules.
- An agent suggestion must not silently overwrite a manual health/lifecycle override.
- Preserve data provenance and link recommendations to the source signals.

### 13.4 `ServiceDesk` integration

Possible capabilities:

- Search/read authorized cases, SLA state, case history, and linked Knowledge Base content through ServiceDesk's contract.
- Draft reply suggestions or internal case summaries.
- Propose assignment/priority/status changes.

Constraints:

- Do not disclose internal notes to portal contacts or other unauthorized users.
- Customer-facing replies must remain drafts or require approval unless an explicitly reviewed policy permits automation.
- ServiceDesk remains the authority for SLA calculations, queue assignment, and case workflow transitions.

### 13.5 `MarketingAutomation` integration

Possible capabilities:

- Analyze authorized campaign performance aggregates.
- Propose audience criteria or draft campaign content.
- Suggest journey optimization or prepare a change proposal.

Constraints:

- MarketingAutomation remains the authority for consent, suppression, unsubscribe, frequency caps, deliverability, and message dispatch.
- An agent must not bypass consent or directly send marketing messages.
- Changing a live journey or sending a campaign requires the relevant MarketingAutomation policy and approval.

### 13.6 `Projects` integration

Possible capabilities:

- Read project status, milestones, tasks, and permitted project details.
- Summarize blockers, propose tasks, or prepare status reports.

Constraints:

- Projects owns task dependencies, stage transitions, project roles, and project-specific ACL.
- Do not invent project status from conversation history when the current record is available.

### 13.7 Portal integration

- Do not expose the internal agent administration console to portal users by default.
- A customer-facing assistant is a separate agent classification with a separate tool allowlist, memory scope, content filtering, quotas, and approval constraints.
- Portal-context runs must operate only on records accessible to that specific portal user/account/contact.
- Do not let a portal assistant search internal agent runs, other customers' records, internal notes, CRM-only activity, or administrative configuration.
- Public forms and chat entry points require abuse prevention, rate limits, captcha/bot controls where appropriate, and strict per-session data limits.

### 13.8 Integration contract rules

- Use public domain services or documented module interfaces; avoid circular imports and direct table access into another module.
- Integration code must tolerate optional modules being disabled/uninstalled where the architecture supports this.
- Use typed internal events and versioned payload schemas for event-triggered runs.
- Prevent event loops: an agent-created change must not recursively trigger the same agent forever. Use causation IDs, origin markers, loop depth limits, and de-duplication keys.
- Avoid storing redundant copies of connected domain data inside `AIAgents`.

---

## 14. API Design

Use the existing `/api/v1` conventions, authentication guards, DTO validation, response envelopes, and error format. Route names below are illustrative; reconcile them with current routing conventions before implementation.

### 14.1 Agent definitions

- `GET /api/v1/ai-agents` — list agents the user is permitted to see.
- `POST /api/v1/ai-agents` — create a draft definition.
- `GET /api/v1/ai-agents/:id` — read definition and allowed metadata.
- `PATCH /api/v1/ai-agents/:id` — update the draft only.
- `POST /api/v1/ai-agents/:id/validate` — run configuration validation without executing business tools.
- `POST /api/v1/ai-agents/:id/publish` — publish a new immutable version after policy/evaluation checks.
- `POST /api/v1/ai-agents/:id/pause` — block new runs according to policy.
- `POST /api/v1/ai-agents/:id/resume` — reactivate after revalidation.
- `POST /api/v1/ai-agents/:id/archive` — archive without silently deleting history.
- `GET /api/v1/ai-agents/:id/versions` — list versions accessible to the caller.
- `GET /api/v1/ai-agents/:id/versions/:version` — inspect permitted config snapshot.

### 14.2 Runs and conversations

- `POST /api/v1/ai-agent-runs` — request a run against an authorized published agent.
- `GET /api/v1/ai-agent-runs` — list runs allowed by ACL.
- `GET /api/v1/ai-agent-runs/:runId` — status and safe summary.
- `GET /api/v1/ai-agent-runs/:runId/events` — paginated run timeline with visibility/redaction enforcement.
- `POST /api/v1/ai-agent-runs/:runId/cancel` — request cancellation.
- `POST /api/v1/ai-agent-runs/:runId/resume` — resume only when the state allows it and actor has permission.
- `POST /api/v1/ai-agent-runs/:runId/input` — provide validated additional input when waiting for input.
- `GET /api/v1/ai-agent-conversations` — list the caller's accessible conversations.
- `POST /api/v1/ai-agent-conversations` — start or create a conversation where supported.
- `GET /api/v1/ai-agent-conversations/:id/messages` — retrieve messages with ACL and retention checks.
- `POST /api/v1/ai-agent-conversations/:id/messages` — submit a message, enforcing published agent policy and run budgets.

### 14.3 Tool catalogue and approvals

- `GET /api/v1/ai-agent-tools` — list tools visible to the user/admin, including descriptions and schemas appropriate to their permission.
- `POST /api/v1/ai-agent-tools/:toolId/test` — safe isolated validation/test path; side effects disabled unless an explicit sandbox-like mode is supported without creating test databases or external effects.
- `GET /api/v1/ai-agent-approvals` — list approvals the caller can review.
- `GET /api/v1/ai-agent-approvals/:id` — retrieve the exact proposed action and relevant redacted preview.
- `POST /api/v1/ai-agent-approvals/:id/approve` — approve after authorization, expiry, and version validation.
- `POST /api/v1/ai-agent-approvals/:id/reject` — reject with optional reason.
- `POST /api/v1/ai-agent-approvals/:id/request-changes` — request new proposed arguments where supported.

### 14.4 Provider, policy, usage, and evaluation administration

Expose admin-only endpoints consistent with the existing settings approach for:

- Model/provider availability and health metadata (never return secrets).
- Agent policy and quota settings.
- Global kill switch and tool-family enablement.
- Usage summary, usage ledger, and redacted diagnostics.
- Evaluation suite CRUD, case management, evaluation execution, and reports.
- Memory retention/deletion requests and provider data policy where configuration is supported.

Avoid exposing secrets in `GET` responses. For secret fields, return configured/not-configured status and rotate/reset actions only.

### 14.5 API security and consistency

- Enforce entity-level, record-level, field-level, and module-level ACL on every endpoint.
- Validate pagination, filters, sorts, limits, IDs, states, and schemas.
- Use idempotency for create-run and approval execution endpoints where retries could create duplicates.
- Do not trust a client-supplied `userId`, `teamId`, `tenantId`, tool result, run status, permission, or provider credential.
- Do not allow clients to directly mutate run state or tool-call results.
- Return structured policy-denial codes without revealing restricted tool details or records.
- Document endpoints with OpenAPI and add authorization matrix tests.

---

## 15. Frontend and User Experience

Follow the existing React SPA and its Ant Design or established component library if present. Do not introduce a parallel design system.

### 15.1 Navigation and access

- Add the `AI Agents` navigation entry only when module permission and feature availability allow it.
- Separate agent usage permissions from agent administration, version publication, tool configuration, approval, audit access, and provider settings.
- Respect user role/team visibility in lists, detail views, run history, and reports.

### 15.2 Agent list and detail

Agent list should provide:

- Name, purpose, status, owner/team, published version, supported triggers, last run, success/failure summary, and usage/cost where authorized.
- Search, pagination, filter, saved views if already supported, and clear empty/error states.
- Clear indication of agents unavailable to the current user and of disabled/paused agents.

Agent detail should provide:

- Overview, behavior description, current version, tools/permissions, model policy, memory policy, run budgets, trigger policy, and publication/evaluation status.
- Version history with immutable published snapshots.
- Tabs or panels for runs, evaluations, usage, audit, and configuration, using current UI conventions.

### 15.3 Configuration experience

Use guided sections or a wizard for:

1. Identity and purpose.
2. Model/provider policy.
3. Instructions and optional prompt templates.
4. Input/output schemas.
5. Tools and permission scopes.
6. Memory and retrieval.
7. Triggers.
8. Limits, quotas, and concurrency.
9. Approval and safety policy.
10. Evaluation and publication.

- Show validation errors by field and policy category.
- Distinguish unavailable/misconfigured providers from agent configuration errors.
- Clearly label tools that read, create, update, delete, send, publish, or otherwise cause external effects.
- Warn about broad permissions and high-risk configuration.
- Do not expose secrets in forms or browser logs.

### 15.4 Run console

The run view should display:

- User request and authorized context reference.
- Current run state, start time, elapsed time, and progress stage.
- Timeline entries for model step, tool proposal, policy validation, tool execution, approval wait, retry, and completion.
- Tool input/output summaries with redaction and per-record permission checks.
- User-friendly failures and a safe retry/cancel action where valid.
- Final result with source references and explicit completed/proposed/blocked/unknown action sections.
- Token/cost estimates if visible to the caller.

Do not present hidden chain-of-thought or private internal reasoning traces as a product feature. Expose concise decision summaries, evidence, actions, and policy explanations instead.

### 15.5 Approval inbox

- Show pending actions ordered by risk/expiry/age.
- Permit filtering by agent, action type, target record, requester, team, and expiry based on ACL.
- Show an exact action preview before approval.
- Warn when the target record changed since the proposal; invalidate stale previews.
- Ensure approve/reject actions have loading, error, and success states and cannot be submitted twice.

### 15.6 Responsive and accessible UI

- Support the repository's normal desktop/tablet/mobile breakpoints.
- Use semantic labels, keyboard navigation, visible focus, accessible statuses, and clear contrast.
- Avoid making color the only risk/status indicator.
- Paginate large run-event histories; do not load unbounded conversation/output payloads.

---

## 16. Observability, Audit, and Operational Controls

### 16.1 Event timeline

For each run, persist structured events such as:

- Run accepted or rejected by policy.
- Version resolved and provider/model selected.
- Model request started/completed/failed.
- Tool proposal created, validation result, permission result, approval requested/decided.
- Tool execution started/completed/failed/outcome unknown.
- Budget warning/limit reached.
- Run paused/resumed/canceled/expired/finalized.

Every event should have a stable ID, run ID, sequence number, timestamp, correlation/causation IDs where available, event category, actor, safe summary, and redaction/visibility label.

### 16.2 Logging principles

- Use the project's structured logger and correlation ID conventions.
- Logs and traces should support incident investigation without exposing raw secrets or unrestricted customer content.
- Separate aggregate operational logs from restricted content traces.
- Never log full prompts, completions, tool arguments, or CRM records by default; use redacted summaries and hashes unless an explicitly authorized diagnostic mode is enabled.
- A diagnostic mode must have short retention, narrow permissions, visible activation, and audit history.

### 16.3 Metrics

Capture at least:

- Run count by status, agent/version, trigger, provider/model, and time window.
- End-to-end latency, model latency, tool latency, queue wait, and approval wait.
- Model calls, tool calls, retry rate, cancellation rate, and policy-denial rate.
- Success, partial success, failure, unknown outcome, and evaluation regression rates.
- Token usage and estimated cost.
- Queue depth, stale leases, long-running runs, and pending approvals.
- External action counts, such as message drafts or approved sends, by owning module contract.

### 16.4 Runbooks

Provide operational guidance for:

- Provider outage/rate-limit events.
- Run stuck in `running` or `waiting_for_approval`.
- Repeated tool failure or suspicious call loops.
- Cost/quota spike and kill-switch operation.
- Credential rotation.
- Agent version rollback by publishing a previous configuration as a new version.
- Data-retention or deletion request.
- Suspected prompt injection or unauthorized tool attempt.
- Unknown outcome after an external side effect.

---

## 17. Evaluation and Quality Gates

### 17.1 Evaluation goals

Build evaluation as a repeatable engineering process, not a claim that one score proves an agent is safe. Test both usefulness and policy compliance.

### 17.2 Test case types

- Normal task completion with expected output properties.
- Tool selection and arguments.
- Structured output validation.
- Correct use of current CRM source-of-truth values.
- ACL denials and restricted records.
- Prompt injection embedded in emails, cases, notes, documents, and retrieved content.
- Attempts to obtain secrets, reveal another customer's data, escalate permissions, disable approvals, or execute arbitrary code/SQL.
- Missing/contradictory data and requests for unsupported claims.
- Provider timeout, malformed response, rate limit, quota exhaustion, cancellation, and worker restart.
- Duplicate event, duplicate webhook, retry-after-timeout, and post-effect crash.
- Approval expiry, changed target record, revoked permissions, and agent version changes.
- Cross-user memory isolation and deleted-source retrieval.
- Marketing consent/unsubscribe and external messaging safety when connected to MarketingAutomation.
- Financial and service-ticket restrictions when connected to Sales or ServiceDesk.

### 17.3 Evaluation methods

- Deterministic unit tests for state machine, permissions, budget, schemas, idempotency, redaction, and approval rules.
- Fake provider adapters for predictable orchestration tests.
- Recorded synthetic fixtures with no customer data for integration-style tests.
- Adversarial prompt-injection fixtures and policy regression tests.
- Provider-backed offline or controlled evaluations only when credentials/usage are explicitly configured; keep billable calls out of ordinary test runs.
- Human review for high-impact agent versions and customer-facing agents.

### 17.4 Publication gates

Do not allow publish when:

- Any required deterministic security/policy test fails.
- A tool grant is unknown, overly broad, or lacks authorization/idempotency handling.
- Required evaluation thresholds are not met.
- Provider/model policy is invalid.
- Safety or approval policy is missing for high-risk tools.
- The execution budget is absent or unbounded.
- An agent has no owner, purpose, or audit policy.

### 17.5 Quality metrics

Possible metrics include task completion rate, schema-valid result rate, tool success rate, unnecessary tool-call rate, unsupported-claim rate, policy-violation rate, cost per successful task, human-edit/approval rejection rate, and regression from the prior published version. Define measurement and sampling before setting numeric targets; do not invent universal targets that don't fit the workload.

---

## 18. Testing Strategy and Database Safety

**All tests must follow `AGENTS.MD`. The user has expressly permitted use of the already-configured primary project database for targeted tests; this is not permission to destroy or reset data. Do not create any additional database/schema/cluster/container for this module.**

### 18.1 Unit tests

Cover:

- Agent configuration parsing and publication validation.
- Immutable version snapshots and checksum behavior.
- Tool schema validation and unknown-field rejection.
- Policy decisions, risk classes, ACL delegation, approval requirements, and stale approvals.
- Run state transitions, budgets, retries, cancellation, expiry, leases, and concurrency.
- Idempotency-key generation and replay detection.
- Provider request normalization, error mapping, and secret redaction.
- Memory scope and source ACL checks.
- Quota reservation/reconciliation.
- Prompt-injection defense boundaries for untrusted tool outputs.
- Evaluation scoring and publication gates.

### 18.2 Integration tests

Use fake providers and the existing application services first. Where database-backed tests are needed:

- Use the current configured project database and inspect the target before writing.
- Create uniquely marked `AGENT_TEST_` records only where needed.
- Disable outbound email, webhooks, marketing dispatch, payment operations, and other external side effects.
- Use fake model responses and fake tool providers for routine tests; do not make ordinary test commands call billable external AI APIs.
- Never run a full database reset, truncate application tables, or delete records not created by the current test run.
- Do not introduce Jest/Vitest/Playwright/Testcontainers configuration that silently provisions a new database.
- Review migrations and run only additive, non-destructive changes appropriate to the current environment.

### 18.3 End-to-end scenarios

At minimum verify:

1. An authorized user creates, validates, publishes, executes, and reviews a read-only agent.
2. A user lacking permission cannot see or invoke a restricted tool.
3. The agent requests a write action and the policy correctly pauses for approval.
4. An approver approves; the exact validated action executes once and is audited.
5. A changed target record or revoked permission invalidates the approval.
6. Provider timeout and retry do not execute the same CRM side effect twice.
7. Run cancellation prevents later tool execution.
8. Budget limits stop execution with a partial result and clear explanation.
9. An indirect prompt injection in a retrieved case/email cannot expand tool privileges or expose unauthorized data.
10. Memory from one user does not leak to another user or portal account.
11. A MarketingAutomation integration cannot bypass consent/unsubscribe or send messages directly outside that module's controls.
12. A Sales integration cannot alter financial records without the prescribed approval.
13. A ServiceDesk integration cannot expose internal notes to a portal contact.
14. An event-triggered run de-duplicates retries and prevents recursive loops.
15. Audit history remains readable after an agent is paused or archived.

### 18.4 Verification commands

Determine the actual commands from current `package.json` and workspace configuration. Run relevant lint, type-check, unit, API/integration, and build checks. Inspect all scripts/hooks before running any command named `test`, `seed`, `reset`, `clean`, `e2e`, or `migrate`.

Report checks that could not be run and why. Never claim successful tests that were not executed.

---

## 19. Deployment, Configuration, and Feature Flags

### 19.1 Configuration categories

Use existing config conventions for:

- Global enable/disable flag for agent execution.
- Allowed provider adapters and models.
- Global and per-agent maximum run duration, steps, model calls, tokens, tool calls, and output size.
- Queue concurrency, worker leases, retry limits, and stale-run sweeper schedule.
- Global/tool-family kill switches.
- Default retention for run events, conversations, memory, provider requests, and evaluation artifacts.
- Redaction policy and provider data policy.
- Default approval-required risk classes.
- Global/user/team/agent budget rules.
- Optional feature flags for memory, retrieval, scheduled triggers, event triggers, external tool protocol adapters, and customer-facing agents.

Do not duplicate settings already owned by the shared provider/job/security infrastructure. Link to the canonical settings source.

### 19.2 Rollout approach

- Install database migrations and code with global execution disabled by default.
- Enable read-only tools for a small administrator-controlled agent first.
- Validate logs, costs, permissions, error handling, queue recovery, and cancellation.
- Enable low-risk internal write tools with scoped users after review.
- Enable approval-gated high-risk tools only after end-to-end approval and idempotency tests pass.
- Enable event/scheduled triggers only after loop guards, quotas, and service identities are verified.
- Treat customer-facing/Portal agents as a separate, later rollout tier requiring adversarial tests, content policy, rate limits, and explicit data scopes.

### 19.3 Rollback

- Pausing/feature-flagging must stop new runs without deleting history.
- Deployment rollback must not require dropping new tables or deleting agent data.
- Schema changes should remain backward-compatible while old and new application versions may run during deployment.
- Provide scripts or documented operations to disable trigger types and write tool families safely.
- Do not roll back a migration destructively just to revert application code.

---

## 20. Delivery Roadmap — Sub-Phases

Execute one sub-phase at a time. Every phase must pass its exit criteria before the next phase begins. Do not generate the entire module in a single oversized coding-agent task.

### Phase 19-AI.0 — Repository Audit and Feature Contract

**Tasks**
- Read `PLAN.md`, `AGENTS.MD`, this file, and existing module/AI/provider/job patterns.
- Verify which provider abstraction, AI assistance, tool registry, audit, ACL, quota, and queue components are already present.
- Inspect optional integrations and their public service contracts.
- Produce `docs/modules/ai-agents/repository-audit.md` and a compact dependency map.
- Record the actual code paths, DTO/metadata patterns, migration conventions, and safe commands.

**Exit criteria**
- No duplicate platform infrastructure is planned.
- Naming is confirmed as `AIAgents` with no `Ua` prefix.
- Missing capabilities are listed with small, reviewable additions.
- Database and external-effect risks are documented.

### Phase 19-AI.1 — Domain Contract and Threat Model

**Tasks**
- Define first-release scope and explicit non-goals.
- Define agent, version, run, step/tool event, approval, memory, usage, and evaluation contracts.
- Create an abuse/threat model covering prompt injection, data leakage, privilege escalation, replay, runaway cost, SSRF, and external side effects.
- Define risk classifications and default approval matrix.
- Document the user/service principal model.

**Exit criteria**
- Contracts and state transitions are reviewed before schema implementation.
- No tool may operate outside an explicitly described policy boundary.

### Phase 19-AI.2 — Module Registration and Permissions

**Tasks**
- Register `AIAgents` in the existing module system.
- Add menu and metadata registration using existing conventions.
- Define separate permissions for use, create/edit draft, publish, pause/archive, tool administration, policy administration, approval, audit viewing, usage reporting, and evaluation management.
- Ensure module disablement blocks new run creation and high-risk actions safely.

**Exit criteria**
- Navigation and endpoints are permission-aware.
- No broad admin-only assumption is baked into ordinary agent usage.

### Phase 19-AI.3 — Additive Persistence and Migration

**Tasks**
- Map logical entities in Section 4.4 to actual migration conventions.
- Add tables/indexes/constraints for agent definitions, immutable versions, runs, run events, tool calls, approvals, provider request ledger, and budgets as needed for the MVP.
- Add conversation/memory/evaluation tables only when their first implementation phase needs them.
- Define retention/deletion jobs and foreign-key behavior.
- Review migration SQL before applying it.

**Exit criteria**
- Migrations are additive and non-destructive.
- Schema and indexes match expected access patterns.
- No new test database/schema is created.

### Phase 19-AI.4 — Provider Gateway and Secret Reuse

**Tasks**
- Reuse or minimally implement the provider interface.
- Normalize text/structured response, usage metadata, cancellation, timeouts, and errors.
- Use existing secure credential management.
- Add a provider health/configuration check that does not reveal keys.
- Add fake provider adapters for deterministic tests.

**Exit criteria**
- Provider SDK types do not leak into domain services or public DTOs.
- Secrets are absent from responses/logs/tests.
- At least one configured provider can pass a controlled connectivity check if credentials are available.

### Phase 19-AI.5 — Agent Definition CRUD and Versioning

**Tasks**
- Implement draft agent create/read/update/list and metadata/layout/UI.
- Implement config validation and immutable version snapshots.
- Add publish/pause/resume/archive transitions.
- Add version checksum, author, timestamp, and change summary.
- Enforce owner/team visibility and publication permissions.

**Exit criteria**
- Published versions cannot be edited in place.
- Invalid/unbounded configuration is rejected.
- State transitions and ACL tests pass.

### Phase 19-AI.6 — Tool Registry and Safe Read Tools

**Tasks**
- Implement the typed server-side tool registry and registration mechanism.
- Define tool schemas, version, owning module, effect class, constraints, timeouts, and idempotency metadata.
- Implement a minimal set of read-only CRM tools using normal Entity Engine/domain services.
- Include search/read and selected record summary tools only where they can honor ACL.
- Add policy-denial reasons and safe tool result serialization.

**Exit criteria**
- Unknown tools and arguments are rejected.
- Read tools cannot bypass record/field/tenant permissions.
- No arbitrary SQL or code-execution tools exist.

### Phase 19-AI.7 — Durable Run Engine and State Machine

**Tasks**
- Implement durable run creation and queue dispatch using the existing worker system.
- Implement run-state transitions, leases/locking, checkpoints, step counters, cancellation, expiry, and recovery.
- Implement bounded model/tool loop with budget checks between steps.
- Persist timeline events and normalized failure states.
- Add causation/idempotency keys for event-driven start and step execution.

**Exit criteria**
- Worker restart and duplicate dispatch do not duplicate tool effects.
- Every run ends in a valid terminal state or a documented waiting state.
- No long-running run depends solely on in-memory process state.

### Phase 19-AI.8 — First End-to-End Read-Only Agent

**Tasks**
- Build one low-risk agent definition using only read tools, for example account/opportunity or customer-support context summarization.
- Validate user prompt and context schema.
- Provide concise answer with authorized source references.
- Add result review UI and run timeline.
- Add baseline evaluation cases.

**Exit criteria**
- An authorized user can execute and review a successful read-only run.
- An unauthorized user cannot read protected records through the same agent.
- The run is fully traceable and bounded.

### Phase 19-AI.9 — Tool Calling Validation and Structured Outputs

**Tasks**
- Add validated provider tool-call normalization.
- Enforce schema validation and bounded repair attempts.
- Handle malformed arguments, repeated calls, overlarge outputs, and unsupported provider features.
- Add structured final-result schemas for agent types where useful.

**Exit criteria**
- Invalid model output cannot execute any tool.
- Invalid-output retry count is finite and recorded.

### Phase 19-AI.10 — Approval Service and Low-Risk Write Tools

**Tasks**
- Implement approval entity, inbox, approval lifecycle, expiry, rejection, and decision audit.
- Add proposal preview generated from typed tool arguments and current record values.
- Implement one or more low-risk write tools such as internal task creation or draft creation.
- Add idempotency and reconciliation for each write tool.
- Revalidate actor permissions and target state at execution time.

**Exit criteria**
- Sensitive actions cannot bypass approval policy.
- Stale/revoked approval is invalidated.
- Replayed approval/run requests do not create duplicate records.

### Phase 19-AI.11 — Run Console, Conversations, and Cancellation UX

**Tasks**
- Build list/detail views for runs, timeline, final result, tool summaries, and failures.
- Add conversation UI if applicable; enforce thread ownership/ACL.
- Add cancellation and waiting-for-input/approval states.
- Add safe retry affordances where retry semantics are known.
- Implement polling or the existing realtime mechanism without unbounded updates.

**Exit criteria**
- User can distinguish successful, partial, failed, blocked, canceled, and unknown-outcome runs.
- Sensitive tool inputs/outputs are appropriately redacted.

### Phase 19-AI.12 — Memory, Context Summarization, and Retention

**Tasks**
- Implement no-memory default and explicit per-agent conversation/checkpoint memory.
- Add scope boundaries, provenance, expiry, and deletion handling.
- Ensure ACL is re-evaluated for referenced records.
- Add retention jobs using the existing scheduler.
- Implement context-window and summary management.

**Exit criteria**
- Cross-user/tenant memory leakage tests pass.
- Long-term memory is opt-in and has a documented retention policy.
- Current authoritative record state takes precedence over stale summaries.

### Phase 19-AI.13 — Usage Ledger, Quotas, and Admin Reporting

**Tasks**
- Record provider/model usage and run/tool counters.
- Add configured pricing snapshots or estimates where available.
- Implement global/provider/agent/user/team/run limits and concurrency caps.
- Add usage dashboards and quota alerts.
- Ensure limits are enforced atomically under concurrent runs.

**Exit criteria**
- Hard limits stop execution safely.
- Usage reports distinguish estimates from provider-confirmed values.
- Quota bypass through concurrent requests is tested.

### Phase 19-AI.14 — Evaluation Framework and Publication Gates

**Tasks**
- Implement evaluation suites/cases and run results.
- Add deterministic graders for schema validity, tool permissions, denied actions, source references, and exact behavior invariants.
- Add optional model-based/human review graders with clear labels.
- Enforce required evaluations during publication.
- Add comparison between current and prior published versions.

**Exit criteria**
- Security-policy regression tests are deterministic and mandatory.
- Evaluation reports are auditable and scoped by permission.
- Model-generated grading cannot override a failed deterministic safety test.

### Phase 19-AI.15 — `Sales` Integration

**Tasks**
- Add only the Sales read/draft tools justified by use cases.
- Reuse Sales service contracts and existing validation.
- Add approval for material or financial changes.
- Test permission, currency, invoice, payment, and duplicate side-effect boundaries.

**Exit criteria**
- Sales remains authoritative for financial state.
- Agent cannot perform unapproved financial writes or claim unverified financial outcomes.

### Phase 19-AI.16 — `CustomerSuccess`, `ServiceDesk`, and `Projects` Integrations

**Tasks**
- Add optional adapters for customer health/risk summaries, service case summaries, and project blockers/status.
- Add suggestions/draft tasks only through owning module contracts.
- Add role/record visibility and internal/public content separation tests.
- Ensure domain events cannot trigger run loops.

**Exit criteria**
- Integrations are optional and avoid circular module dependencies.
- CustomerSuccess, ServiceDesk, and Projects maintain ownership of their business rules.

### Phase 19-AI.17 — `MarketingAutomation` and Trigger Integrations

**Tasks**
- Add read-only campaign/journey reporting tools first.
- Add proposal generation for campaign content or audience/flow changes where useful.
- Integrate approved events and schedules through the existing jobs/event platform.
- Add de-duplication, trigger allowlist, causation IDs, and recursion-depth limits.
- Prevent agent actions from bypassing consent, unsubscribe, suppression, or send-frequency rules.

**Exit criteria**
- No direct marketing send path bypasses MarketingAutomation.
- Replayed or cyclic events do not create unbounded runs.

### Phase 19-AI.18 — Advanced Retrieval and Protocol Interoperability (Optional)

**Tasks**
- Determine whether existing RAG/search infrastructure can be reused.
- Add ACL-aware retrieval and source attribution only when a defined use case requires it.
- Evaluate an MCP-compatible client/server adapter or another tool protocol only after authentication, tenant isolation, tool allowlists, and network protections are in place.
- Treat external tools as untrusted and apply the same schema, approval, timeout, and logging pipeline.

**Exit criteria**
- Retrieval preserves source ACL and deletion semantics.
- External tool servers cannot expand privileges or access arbitrary internal network targets.
- This phase may be deferred without blocking core AIAgents.

### Phase 19-AI.19 — Security Hardening, Recovery, and Operations

**Tasks**
- Complete threat-model review and penetration-oriented tests.
- Add provider-outage handling, queue recovery, stalled-run sweeper, kill switch, and unknown-outcome reconciliation.
- Verify retention/deletion/export controls for conversation and memory data.
- Add runbooks, dashboards, alerts, and admin diagnostics.
- Review logs/telemetry for secret or sensitive data leakage.

**Exit criteria**
- Critical security regressions are fixed.
- Operators can stop new execution and safely diagnose stuck or costly runs.
- Run recovery does not duplicate external side effects.

### Phase 19-AI.20 — End-to-End QA, Documentation, and Release Readiness

**Tasks**
- Run all relevant lint, type, unit, integration, API, migration, accessibility, and build checks available in the repository.
- Verify database migrations are additive and applied only under approved environment conditions.
- Verify each permission and state transition in a matrix.
- Test run visibility, approval inbox, quotas, cancellation, archival, deletion/retention, and integrations.
- Write user and administrator documentation, API docs, tool developer guide, security guide, provider troubleshooting, evaluation guide, and operation runbooks.
- Update `PLAN.md` implementation status only for verified completed work.

**Exit criteria**
- Required tests pass or skipped tests are explicitly documented with the reason.
- No unsupported feature is represented as completed.
- No secret, generated database, customer export, or test artifact is committed accidentally.
- A controlled rollout and rollback/disable strategy is documented.

---

## 21. Required Documentation Deliverables

Create or update documents under the repository's existing documentation convention, preferably:

- `docs/modules/ai-agents/repository-audit.md`
- `docs/modules/ai-agents/architecture.md`
- `docs/modules/ai-agents/security-and-threat-model.md`
- `docs/modules/ai-agents/agent-definition-schema.md`
- `docs/modules/ai-agents/tool-developer-guide.md`
- `docs/modules/ai-agents/run-state-machine.md`
- `docs/modules/ai-agents/provider-configuration.md`
- `docs/modules/ai-agents/memory-and-retention.md`
- `docs/modules/ai-agents/evaluation-guide.md`
- `docs/modules/ai-agents/operations-runbook.md`
- `docs/compatibility/ai-agents.md`

Do not create duplicate documentation in a second location if the repository already has an authoritative equivalent; update the existing canonical document instead.

---

## 22. Definition of Done

The module is complete only when all applicable criteria below are met.

### Product and architecture

- `AIAgents` is registered with no `Ua` prefix and follows the project's naming conventions.
- Existing CRM kernel and completed modules are reused rather than duplicated.
- Agent definitions have draft and immutable published version lifecycles.
- Runs are durable, bounded, cancelable, traceable, and recoverable.
- The first agent works end-to-end with read-only tools.
- Write tools have schema validation, authorization, idempotency, audit, and appropriate approval.
- Provider abstraction and secret storage follow current repository conventions.
- User, team, record, field, and tenant scopes are enforced throughout execution.

### Safety and reliability

- Model output cannot directly change ACL, tool grants, quotas, state machine, provider secrets, or system policy.
- No arbitrary SQL/code/shell/file-system execution is available to agents.
- Prompt-injection and cross-user/tenant leakage tests pass.
- External effects cannot be duplicated silently on timeout/retry/recovery.
- Quotas, run limits, kill switch, and operational alerts are implemented or explicitly deferred with a documented non-production release boundary.
- Memory is explicit, permission-aware, provenance-aware, and governed by retention controls.
- Provider data handling and logging behavior are documented and configurable where supported.

### Integrations

- Sales, CustomerSuccess, ServiceDesk, Projects, MarketingAutomation, and Portal use approved public contracts where implemented.
- Existing modules remain usable if optional agent integrations are disabled.
- Marketing consent/unsubscribe and ServiceDesk internal-note boundaries cannot be bypassed.
- Financial or irreversible actions require the configured policy and approval.

### Quality and operations

- OpenAPI and user/admin/tool developer docs are updated.
- Unit, integration, API, security, and end-to-end tests cover key positive and negative flows.
- No tests create additional databases/schemas/containers or reset the configured primary database.
- Migrations are reviewed and non-destructive unless separately approved.
- Lint/type/build/test results are reported honestly.
- Monitoring, stuck-run recovery, provider outage handling, and rollback/disable instructions exist.

---

## 23. Final Instructions to the Coding Agent

1. Start with **Phase 19-AI.0 only**. Do not begin implementing the entire module immediately.
2. Read `PLAN.md` and `AGENTS.MD`; their repository conventions and database-safety rules are mandatory.
3. Inspect the actual codebase and provide the repository audit, dependency map, feature gaps, migration proposal, and safe verification commands.
4. Use the exact module name `AIAgents`; do not introduce a `Ua` prefix.
5. Build on the existing PostgreSQL database and persistence layer; do not create a new test database, test schema, database container, or shadow database.
6. Do not run tests or scripts that reset, truncate, recreate, or destructively seed the existing database.
7. Use fake providers for normal tests; never trigger real customer messages, marketing sends, payment actions, or externally visible effects during tests.
8. Never log or expose secrets, full database URLs, unrestricted prompts, private model traces, or unauthorized CRM data.
9. Do not weaken ACL, approval, quota, validation, or assertions merely to make a test pass.
10. At the end of each sub-phase, report changed files, migrations, actual checks run, results, limitations, and the next sub-phase. Do not claim completion without evidence.

