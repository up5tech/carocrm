# Phase 19-CHAT.0 — `CRMChat` repository audit

> **Plan:** `PLAN_Phase_19_CRM_Chat.md` §17 (`Phase 19-CHAT.0`), §20 final instruction.
> **Status:** delivered in 19-CHAT.0. Everything below was read from this checkout; `PLAN.md` claims
> were not treated as evidence. **No code, schema or configuration was changed by this audit.**
> **Naming:** module `CRMChat`, registry key / route slug `crm-chat`, NestJS module `CRMChatModule`,
> SPA route `/crm-chat`. No `Ua` prefix anywhere.
> **Plan-path note:** the plan names `docs/architecture/crm-chat-audit.md`. This repository keeps
> module audits beside the module (`docs/modules/ai-agents/repository-audit.md`,
> `docs/implementation/sales-repository-audit.md`), so the audit lives here and
> `docs/architecture/crm-chat-audit.md` is a pointer to this file.
> **Downstream:** the contract that fixes this audit's decisions is
> `docs/architecture/crm-chat-contract.md` (19-CHAT.1); the trust-boundary analysis is
> `docs/security/crm-chat-threat-model.md`. Where this audit and the contract disagree, the contract
> is authoritative and the audit's §13 records the open question.

---

## 1. Headline

`AIAgents` is **not planned — it is delivered**, and it already owns almost every non-UI capability
the Chat plan assumes:

| Chat assumption | Reality in this checkout |
| --- | --- |
| Agent runtime exists | Durable, lease-claimed run engine (`ai_agent_runs`, `ai_agent_run_events`) |
| Tool registry exists | 6 typed tools over the Entity Engine (`crm_*`), no SQL/code tool |
| Approvals exist | `ai_agent_approvals` with revalidation, expiry and invalidation |
| Conversation storage exists | `ai_agent_conversations` / `ai_agent_messages`, owner-scoped, retention sweep |
| Usage/cost exists | Run counters + `ai_agent_provider_requests` ledger + pricing snapshots + quotas |
| Streaming exists | **No.** There is no SSE, no WebSocket and no `EventSource` anywhere in the repo |

So Chat is a **conversation experience layer**, not a new orchestration layer. The genuinely new
platform seam is the **streaming/turn transport**; everything else is composition, plus a small,
mostly additive data layer for citations, feedback and saved prompts.

What does **not** exist and blocks parts of the plan:

1. **No streaming transport of any kind.** The AI Agents UI polls TanStack Query every 4 s while a
   run is active.
2. **No aggregate/query-plan tool.** `EntityCrudService.aggregate()` exists but is not exposed as a
   tool; the model cannot total, group or count.
3. **No domain-service tools.** Sales, CustomerSuccess, ServiceDesk, Projects, MarketingAutomation
   and VoiceCommunications services are never reached by a tool; the tool catalogue is generic
   Entity Engine CRUD on 10 allowlisted entities.4. **Help retrieval is narrow.** A `KnowledgeArticle` entity and `KnowledgeBaseService` exist inside
   Service Desk (title, slug, summary, **body**, category, language, tags, published/expiry lifecycle,
   `isInternal`), but the only retrieval surfaces are a portal-only article list and a keyword-overlap
   suggestion for one case. There is no staff-facing article search, no ranking, no chunk/vector index
   and no RAG. `docs/**` is repository documentation, not application data.
5. **No chat UI, no citation record, no feedback, no saved-prompt table, no conversation rename or
   search** (conversation list/get/archive/delete only).
6. **No markdown renderer and no HTML sanitizer** in the SPA dependency set.

---

## 2. Capability matrix

Legend: **available** = implemented and reusable as-is; **partial** = exists but does not cover the
Chat requirement; **missing** = nothing to reuse; **n/a** = out of scope for this release.

| # | Capability | Status | Owner and exact artifact | Consequence for `CRMChat` |
| --- | --- | --- | --- | --- |
| 1 | Modular monolith + Nest DI + route ordering | available | `apps/api/src/app.module.ts` (module barrels spread; static prefixes before `ENTITY_CONTROLLERS`) | Add `CRM_CHAT_CONTROLLERS` before `ENTITY_CONTROLLERS` |
| 2 | PostgreSQL + Kysely, ordered SQL migrations | available | `apps/api/src/database/database.service.ts`, `database/migrate.ts`, `database/migrations/` (highest = `061`) | Chat takes the next free number when CHAT.3 starts (see §14) |
| 3 | Metadata registry / Entity Engine | available | `apps/api/src/metadata/metadata-store.service.ts` (`METADATA_STORE`), `apps/api/src/entity/entity.service.ts` (`list/get/create/update/massUpdate/massDelete/related/aggregate`) | Read/write tools already run through it; Chat adds none of its own SQL |
| 4 | Aggregates | **partial** | `EntityCrudService.aggregate` (`entity.service.ts:112`) exists; **not** a registered tool | Chat cannot answer "how many / total" until a tool is added (CHAT.10) |
| 5 | ACL: entity, record, field | available | `apps/api/src/acl/acl-api.service.ts:70` (`canUser`, `assertRecordAccess:241`, `visibleFields:122`, `stripRestricted:136`, `recordPredicate:175`) | Inherited free of charge by tools that call the Entity Engine |
| 6 | Request principal + `runAs` | available | `apps/api/src/common/request-scope.ts` (`REQUEST_SCOPE_TOKEN`), `AIAgentRunService.execute` re-enters `scope.runAs(principal, …)` | Chat must pass the caller, never an elevated identity |
| 7 | Auth guard | available | `apps/api/src/auth/auth.guard.ts` (global `APP_GUARD`), `@Public()` is the only bypass | All Chat routes authenticated by default |
| 8 | Provider gateway + adapters + fake | available | `ai-provider-gateway.service.ts`, `ai-provider-openai-compatible.ts`, `ai-provider-anthropic.ts`, `ai-provider-fake.ts` | Reuse; Chat never imports a provider SDK |
| 9 | Tool registry | available | `apps/api/src/ai-agents/ai-agent-tools.ts` (`AIToolRegistry`) | Chat grants tools through agent versions; it does not register its own executor |
| 10 | Read tools for CRM data | **partial** | `crm_search_records`, `crm_read_record`, `crm_list_related`, `crm_record_summary`; `READABLE_ENTITIES` = Account, Contact, Lead, Opportunity, Case, Task, Project, Campaign, CustomerSuccessProfile, Quote | Covers detail/list/summary; no aggregate, no timeline, no saved report, no domain metrics |
| 11 | Write tools | **partial** | `crm_create_task` (`low_write`, `requiresApproval:false`), `crm_update_record_fields` (`material_write`, `requiresApproval:true`, field allowlist) | `crm_create_task` would auto-execute; Chat must declare `requiresApproval` **on the grant** (§6.4) |
| 12 | Durable run engine, cancel, retry, resume, input | available | `ai-agent-runs.service.ts` (`create:374`, `cancel:680`, `retry:633`, `resume:733`, `provideInput:715`, `execute:786`) | Chat submits and observes runs; it must not reimplement a loop |
| 13 | Run idempotency | available | `uq_ai_agent_runs_idempotency` (`045:183`) + `create()` replay | Chat's client idempotency key maps to `ai_agent_runs.idempotency_key` |
| 14 | Run event timeline | available | `ai_agent_run_events` (`045:199`), `GET action/runs/:id/events`, `visibility` filter | Poll-based progress today; becomes the source for streamed `tool.*` events |
| 15 | Streaming transport (SSE/WS) | **missing** | none — no `@Sse`, no `text/event-stream`, no `EventSource` | CHAT.6 must introduce it (with polling fallback) |
| 16 | Approvals: propose, approve, reject, expire, revalidate | available | `ai-agent-approvals.service.ts` (`list:79`, `approve:142`, `decide:150`, `expireDue:269`, `revalidationFailure:309`) + routes `ai-agents.controller.ts:655-701` | Chat renders AIAgents approvals; it creates **no** parallel approval records |
| 17 | Approval requirement decision | available | `approvalRequired()` (`ai-agent-runs.service.ts:2124`) ORs grant flag, tool flag and `settings.approval.requireFor` effect classes | Grant-level approval is the clean way to gate Chat writes |
| 18 | Conversation + message storage | available | `ai_agent_conversations`, `ai_agent_messages` (`047`), `AIAgentMemoryService` (`conversationForRun:101`, `appendUserMessage:172`, `appendRunOutcome:177`, `contextFor:266`, `summarize:297`, `listConversations:409`, `deleteConversation:463`) | **Reuse as the source of truth** (§4) |
| 19 | Conversation memory opt-in | **partial** | `AgentConfig.memory.mode` default `'none'` (`ai-agent-config.ts:186`), instance `features.memory` default `false` (`ai-agents-settings.service.ts:37`) | A Chat agent profile must set `memory.mode:'conversation'`; the instance flag must be enabled deliberately |
| 20 | Conversation rename / create / search | **missing** | only list/get/archive/delete (`ai-agents.controller.ts:456-479`); title is derived from the first message | Chat needs `PATCH` title and a search query (CHAT.4/14) |
| 21 | Conversation retention | available | `AIAgentMemoryService.sweep()` — precise predicates, no truncate; `retention.conversationsDays` default 30 | Chat inherits it; no second sweeper |
| 22 | Citations / evidence | **partial** | Run result carries `sources` = up to 20 `resultRef`s (`successfulSources:2136`), persisted to `ai_agent_messages.content_meta.refs`; `contextFor` re-checks readability | No label, no safe route, no `retrievedAt`, no per-citation ACL re-check at render (CHAT.8) |
| 23 | Feedback (thumbs/category) | **missing** | none | New additive table (CHAT.14) |
| 24 | Saved prompts / prompt templates | **partial** | one code-defined template (`ai-agent-definitions.service.ts:946`), no table, no per-user prompts | Needs `crm_chat_saved_prompt` (CHAT.14) |
| 25 | Usage, cost, quotas, budget policies | available | `ai_agent_runs` counters, `ai_agent_provider_requests`, `ai_agent_pricing_snapshots`, `ai_agent_budget_policies`, `AIAgentQuotaService` | Chat adds correlation only; no second ledger |
| 26 | Evaluation suites and gates | available | `ai_agent_eval_suites/_cases/_runs`, `AIAgentEvaluationService` | Reuse for the CHAT.18 evaluation set |
| 27 | Module settings + feature flags + kill switch | available | one strict Zod `app_settings` row `aiAgents` (`ai-agents-settings.service.ts:31`); `features.execution` default **false**, `safety.globalExecutionPaused` | Chat owns its own `crmChat` row, not a second AI settings surface |
| 28 | Module permissions via synthetic ACL resources | available | `ai-agents-module.ts:17-100` + `AIAgentsPermissionService` | Chat declares its own capability keys the same way (§7) |
| 29 | Navigation registration | available | `apps/api/src/admin-panel/navigation-defaults.ts:58`, `docs/admin/navigation.md` (defaults → document → ACL → order) | Add a `/crm-chat` entry gated by a capability |
| 30 | i18n | available | `i18n/en/web.json`, `i18n/vi/web.json` (namespace `web`, e.g. 374 `aiAgents.*` keys) | Add `crmChat.*` keys in both catalogs |
| 31 | Jobs + worker | available | `apps/api/src/jobs/*`, `apps/worker/src/handlers/*`; names `<module>.<action>` | Chat registers at most a retention/cleanup job |
| 32 | Notifications | available | `apps/api/src/stream/index.ts` (`notifications` table + `NotificationController`) | Use for long-run / approval notifications |
| 33 | Audit | available | `apps/api/src/audit/*`, `audit_log` via kernel hook | Chat mutations and action decisions must write audit entries |
| 34 | Help / knowledge corpus | **partial** | `KnowledgeArticle` metadata entity (`database/seed-metadata.ts:3863`: `body`, `summary`, `slug`, `categoryId` → `KnowledgeCategory`, `language`, `tags`, `status` Draft/InReview/Published/Archived/Expired, `isInternal`, `publishedAt`, `expiresAt`; ACL `read: all`) + `KnowledgeBaseService` (`service-desk/knowledge-base.service.ts:24`: `publish:36`, `archive:43`, `portalArticles:50`, `suggestForCase:74`, `expireDueArticles:92`), gated by `serviceDesk.features.knowledgeBase` | Corpus exists; retrieval does not. CHAT.9 needs a staff read tool, not a new index |
| 34a | Help retrieval / search over articles | **missing** | `portalArticles` excludes `isInternal` and returns `summary` only; `suggestForCase` is keyword overlap on one case name; no free-text query, ranking or body excerpting | Add `help_search_articles` over the Entity Engine (CHAT.9) |
| 35 | Chat SPA workspace | **missing** | `apps/web/src/pages/*` has no chat page; `AppRoutes.tsx` declares static routes before `/:entity` | Build in CHAT.7 |
| 36 | Markdown/HTML rendering + sanitizer | **missing** | `apps/web/package.json` has no markdown or sanitizer dependency | Decision required (§13, Q3) |
| 37 | Portal-facing chat | n/a | portal shell is separate (`AppRoutes.tsx` portal branch) | Explicitly out of scope |
| 38 | Test harness (fake provider, markers, no DB creation) | available | `apps/api/test/support/boot-api.ts`, `apps/api/test/ai-agent-runs.test.ts` (`AGENT_TEST_<runId>` markers, fake adapter, scratch queue) | Chat tests follow the same pattern |

---

## 3. The `AIAgents` contract Chat can consume today

### 3.1 HTTP routes (`@Controller('api/v1/AIAgents')`, `ai-agents.controller.ts:77`)

| Purpose | Route | Notes |
| --- | --- | --- |
| Start a run | `POST action/agents/:id/runs` | body `RunCreateSchema`: `input.text`, `input.record`, `idempotencyKey`, `conversationId` |
| Run status | `GET action/runs/:id` | `AIAgentRunView` incl. `counters`, `conversationId`, `failureCategory` |
| Run timeline | `GET action/runs/:id/events` | ordered `seq`, `visibility` filtered (`user` vs audit) |
| Tool ledger | `GET action/runs/:id/toolCalls` | arguments are audit-only |
| Cancel / retry / resume / input | `POST action/runs/:id/{cancel,retry,resume,input}` | cancel is best-effort in-flight, immediate when queued/waiting |
| Approvals | `GET action/approvals`, `GET action/runs/:id/approvals`, `POST action/approvals/:id/{approve,reject}` | revalidation and expiry enforced in the service |
| Conversations | `GET action/conversations`, `GET action/conversations/:id`, `POST action/conversations/:id/archive`, `DELETE action/conversations/:id` | owner-scoped; **no create, no rename, no search** |
| Capabilities / health / settings | `GET action/capabilities`, `action/health`, `action/settings` | capability map drives the SPA tabs |
| Usage | `GET action/usage` | needs `usage` capability |

### 3.2 Status vocabularies

- `RUN_STATUSES` (`ai-agents-module.ts:128`): `queued`, `running`, `waiting_for_approval`,
  `waiting_for_input`, `retry_wait`, `cancel_requested`, `succeeded`, `partially_succeeded`,
  `failed`, `canceled`, `expired`, `blocked_by_policy`, `outcome_unknown`.
- Terminal set (`TERMINAL_RUN_STATUSES:145`) never transitions back.
- `EFFECT_CLASSES` (`:159`): `read`, `low_write`, `material_write`, `high_impact`.
- Default approval matrix requires approval for `material_write` and `high_impact` only.

### 3.3 Jobs

`aiAgents.executeRun` and `aiAgents.retentionSweep` (`ai-agent-jobs.ts:11-12`); the worker calls the
API's worker-authorised endpoint (`x-worker-secret`, constant-time compare) so there is exactly one
run-engine implementation.

### 3.4 Execution mechanics Chat inherits

- Claim by time-boxed lease with `LEASE_MARGIN_MS`, so a second worker cannot drive a step.
- Duplicate-argument tool calls inside one run are refused (`isRepeatedCall`), which also blunts
  tool-call loops.
- A write whose outcome is unknown ends the run as `outcome_unknown` and is never auto-retried.
- Prompt-injection boundary is explicit: tool results are returned as delimited **user data**, and
  retrieved conversation memory is wrapped as untrusted data.

---

## 4. Decision: reuse the `AIAgents` conversation storage

**Decision.** `CRMChat` uses `ai_agent_conversations` and `ai_agent_messages` as the single
conversation store. Chat adds Chat-specific tables only for things that storage genuinely does not
model: citations, feedback, saved prompts, and (only if proven necessary) a Chat turn row.

**Why reuse wins here:**

1. Owner scoping is already enforced on every read (`ownerConversation`), and a thread id is
   explicitly not an authorization token.
2. Deterministic ordering under concurrency is already solved: `UNIQUE (conversation_id, seq)` plus a
   per-conversation `pg_advisory_xact_lock` around sequence allocation (`appendMessage`).
3. Retention is already real: per-conversation `expires_at`, instance ceiling, precise-predicate
   sweep, no truncate.
4. Rolling summary is deterministic and free (no provider call), and keeps the prompt bounded.
5. Prompt-history hygiene already re-checks stored CRM references through the entity layer and
   withholds messages whose records are no longer readable (`contextFor` → `referencesReadable`).
6. Two conversation stores would mean two retention policies, two ordering implementations and an
   inevitable disagreement about which one is authoritative — exactly what the plan forbids.

**What Chat must add around it** (§5), with the smallest sufficient shape:

| Need | Smallest addition | Phase |
| --- | --- | --- |
| Conversation rename | `PATCH` updating `title` (column already exists) | 19-CHAT.4 |
| Conversation create | Explicit `POST` that inserts an empty active thread (today a thread is only created by a run) or accept "thread created on first turn" | 19-CHAT.4 |
| Conversation search | query over `ai_agent_messages.content` joined to owned conversations; `pg_trgm` is already installed (`008:8`) | 19-CHAT.14 |
| Turn idempotency | **no new table**: `client_idempotency_key` → `ai_agent_runs.idempotency_key` (unique partial index) | 19-CHAT.6 |
| Turn lifecycle | **no new table**: map the plan's turn states onto `RUN_STATUSES` (§9) | 19-CHAT.6 |
| Citations | `crm_chat_citation` (message-scoped, opaque ref, label, route key, `retrieved_at`) | 19-CHAT.8 |
| Feedback | `crm_chat_feedback` | 19-CHAT.14 |
| Saved prompts | `crm_chat_saved_prompt` (data only, no tool grants) | 19-CHAT.14 |
| Usage correlation | reuse `ai_agent_runs`/`ai_agent_provider_requests`; do **not** add `crm_chat_usage_event` | 19-CHAT.17 |

**Blocking detail discovered in the code (not in the plan).** `conversationForRun` throws
`ValidationError('This agent does not use conversation memory; omit the conversation id.')` when a
`conversationId` is supplied for an agent whose `memory.mode !== 'conversation'`, and
`assertEnabled()` throws `FeatureDisabledError` when `settings.features.memory` is false. Therefore:

- the Chat default agent profile **must** be published with `memory.mode: 'conversation'` and a
  `retentionDays` inside the instance ceiling; and
- Chat cannot function on a fresh install until an administrator turns `features.memory` on — this
  must be an explicit, documented install step with a clear `FEATURE_DISABLED` surface in the UI,
  **not** a silently flipped default.

---

## 5. Missing capabilities and their smallest acceptable additions

| # | Missing | Smallest addition | Owner |
| --- | --- | --- | --- |
| 1 | Streamed turn events | SSE route on `/api/v1/CRMChat` projecting `ai_agent_run_events` + deltas, heartbeat, `Last-Event-ID` resume; polling fallback already proven by `AIAgentsRunsTab` | Chat controller + a thin adapter over `AIAgentRunService` |
| 2 | Delta-level streaming | Provider contract is request/response only (`AIProviderRequest` → `AIProviderResponse`); no `stream` flag. Initial release should stream **status/tool/citation events** and the final assistant message, and document "no token deltas" as a limitation | AIAgents adapter (later, optional) |
| 3 | Aggregate tool | `crm_aggregate_records` over `EntityCrudService.aggregate` with an allowlisted metric/group/filter schema | AIAgents tool registry |
| 4 | Timeline tool | `crm_get_timeline` over the existing stream/notes surface | AIAgents tool registry |
| 5 | Domain tools | One tool per audited domain service (Sales documents, CustomerSuccess health, ServiceDesk SLA, Projects deadlines, Marketing campaign performance, Voice call history) — each calling the owning service, never its tables | AIAgents tool registry + owning modules |
| 6 | Help retrieval tool | `help_search_articles`: allowlisted read over `KnowledgeArticle` through the Entity Engine (`status = Published`, in-date, `language` honoured, `isInternal` included only for staff), returning title/slug/summary and a bounded body excerpt with `resultRef`. Keyword matching with `pg_trgm`; **no** vector index in the first slice | AIAgents tool registry |
| 6a | Product "how do I" help | `KnowledgeArticle` is support-case oriented; nothing documents CRM navigation. Answer from **metadata** (entity/field labels, `inDetail`, relation definitions) plus a shipped, code-owned topic list, and admit when no article exists | Chat + metadata |
| 7 | Default Chat agent profile | A published `crm-chat-assistant` agent version with conversation memory, read tools, aggregate tool, and grant-level approval on writes | Chat install/first-run |
| 8 | Citation persistence/rendering | `crm_chat_citation` + trusted route builder + ACL re-check at read | Chat |
| 9 | Feedback, saved prompts | Two additive tables + endpoints | Chat |
| 10 | Conversation rename/search | `PATCH` + search query | Chat |
| 11 | Chat SPA | Sidebar, thread, composer, stop/retry, citations, progress, approval card, error/empty states | Chat (web) |
| 12 | Safe message rendering | Decide plain-text + structured blocks vs a vetted markdown+sanitizer pair (§13 Q3) | Chat (web) |

---

## 6. Findings that change the plan's assumptions

### 6.1 API shape and naming

The plan's illustrative paths (`/api/v1/crm-chat/...`, kebab-case) do not match this repository. Every
module controller uses a **PascalCase resource prefix** and `action/…` for non-CRUD commands:
`api/v1/AIAgents`, `api/v1/AdvancedIntegrations`, `api/v1/AdminInternal`, `api/v1/SavedFilter`, and
e.g. `action/agents/:id/runs`. Documentation controllers use `api/v1/Settings/documents`,
`api/v1/integrations/<slug>`.

**Decision:** `@Controller('api/v1/CRMChat')` with `action/...` sub-routes, registered before
`ENTITY_CONTROLLERS` so the generic `:entity` wildcard cannot swallow it.

### 6.2 Error format and codes

Errors are `AppError` subclasses (`packages/core/src/errors/index.ts`) rendered by
`GlobalExceptionFilter` as `{ error: { code, message, details } }` with generic uppercase codes
(`NOT_FOUND`, `AUTHORIZATION_DENIED`, `FEATURE_DISABLED`, `RATE_LIMITED`, `VALIDATION_FAILED`,
`CONCURRENCY_CONFLICT`). The plan's `CHAT_CONVERSATION_NOT_FOUND`-style codes do not match the
convention.

**Decision:** reuse the existing subclasses; introduce a module-specific `AppError` code only where
the client must branch differently (candidate: `CHAT_APPROVAL_REQUIRED`, `CHAT_CONTEXT_TOO_LARGE`),
and document each in the CHAT.1 contract. Never reveal whether another user's conversation exists —
return `NOT_FOUND`, as `ownerConversation` already does.

### 6.3 Response envelopes

Success responses are **not** wrapped: list endpoints return `{ list, total, offset, count }`
(see `AIAgentRunService.list`), detail endpoints return the view object, commands return the updated
view. Pagination is `offset`/`maxSize` with the server clamping (`maxSize` ≤ 100). Chat must match
this, not invent an envelope.

### 6.4 Write gating is already expressible without engine changes

`approvalRequired()` ORs **three** sources: the tool grant's `requires_approval`, the tool
definition's flag, and the instance's `approval.requireFor` effect classes. `crm_create_task` is
`low_write` with `requiresApproval: false`, so by default it executes immediately — incompatible
with the Chat plan's "preview and explicit confirmation by default".

**Decision:** the Chat agent version grants `crm_create_task` with `requires_approval: true`, and the
Chat UI renders the resulting AIAgents approval as its confirmation card. No engine change, no
second approval store, and `validateGrant` already refuses a grant that drops a mandatory approval.

### 6.5 Approval revalidation is real, and protects Chat

`revalidationFailure()` re-reads the target through the entity layer at decision time and blocks a
stale/forbidden/expired approval. Chat therefore must **not** add its own proposal hash/expiry logic;
it presents the AIAgents approval and calls the existing approve/reject routes.

### 6.6 Field-level access in tool output

Tools call `EntityCrudService`, which applies field-level stripping, and `assertField` rejects
bookkeeping columns (`createdById`, `modifiedById`, `deletedAt`, `deleted`, `teams`). Tool results are
also byte-bounded (`maxResultBytes`) and per-record text is truncated at 2 000 chars. Chat can rely on
this and must not re-serialize raw records into citations.

### 6.7 Prompt/completion storage is off by default

`dataPolicy.logPrompts` defaults to `false` and `ai_agent_provider_requests` stores hashes, counters,
latency and outcome — not bodies. Chat must not add a prompt log; transcript content lives only in
`ai_agent_messages`, under the conversation retention window.

---

## 7. Permissions model proposal

The platform has no arbitrary-permission mechanism: `roles.permissions` is an entity→action map and
`AclApiService.canUser(entity, action)` is the only evaluator. Module rights are therefore synthetic
resources (the `AIAgents`, Marketing, Service Desk and Advanced Integrations precedent).

| Capability | Resource | Action | Notes |
| --- | --- | --- | --- |
| Use Chat (open workspace, own conversations) | `CRMChatConversation` | `read` | Also requires `AIAgent.read` to run an agent |
| Create/rename/archive own conversation | `CRMChatConversation` | `edit` | Ownership is checked separately and always |
| Delete own conversation | `CRMChatConversation` | `delete` | Soft/hard behaviour per retention policy |
| Submit feedback | `CRMChatFeedback` | `edit` | |
| Manage saved prompts | `CRMChatPrompt` | `edit` | Data only, never tool grants |
| Chat administration (flags, limits, retention) | `CRMChatAdmin` | `edit` | Separate from `AIAgentPolicy` |

Consequences to state in the contract: `sysAdmin`/`users.is_admin` hold everything; a role with a `*`
entry inherits these resources exactly as it inherits future entities; a role with no
`CRMChatConversation` entry has no Chat access; record/field ACL is unaffected by these resources and
still applies to every tool call.

---

## 8. Transport decision for CHAT.6

**Today:** no streaming infrastructure. The AI Agents UI uses TanStack Query with
`refetchInterval: 4_000` while the run is in an active state, and `15_000` for the approval inbox
(`AIAgentsRunsTab.tsx:88-95`, `AIAgentsApprovalsTab.tsx:61`).

**Decision:** implement SSE (`text/event-stream`) on a dedicated Chat route, projecting a
safe subset of `ai_agent_run_events` plus turn boundaries, with the durable run as the source of
truth and a `GET action/turns/:id` status endpoint for reconnect. Keep polling as the documented
fallback and behind the same UI state hook.

**Must be verified by a spike in CHAT.6, not assumed:** `@Sse()` in NestJS 11 (`@nestjs/common
^11`) with the installed `@nestjs/platform-fastify ^11` + `fastify ^5`. If the adapter cannot expose a
raw event stream, the fallback is a Fastify route writing `reply.raw` directly. Both paths are
acceptable; the plan's requirement is "a standard transport the repository already uses or adds
once", and the reconnect contract matters more than the mechanism.

Event naming per plan §9.1 maps onto existing data:

| Plan event | Source today |
| --- | --- |
| `turn.started` | run `queued`/`running` + `run.queued` event |
| `tool.started` / `tool.progress` | `ai_agent_tool_calls` status + `tool.denied`/executed events (`summary` only) |
| `citation.added` | run `result.sources` → `crm_chat_citation` rows |
| `action.proposed` / `approval.required` | `ai_agent_approvals` pending row for the run |
| `turn.completed` / `turn.failed` / `turn.cancelled` | terminal `RunStatus` + `run.canceled`/`finish` events |
| `usage.summary` | run `counters` |

No chain-of-thought, provider request body, tool arguments or hidden prompt is exposed: `visibility =
'user'` already hides audit-only rows.

---

## 9. Turn state mapping (no second state machine)

| Plan turn state | `RunStatus` |
| --- | --- |
| `accepted` | `queued` |
| `running` | `running` |
| `waiting_approval` | `waiting_for_approval` (also `waiting_for_input`) |
| `completed` | `succeeded` |
| `partial` | `partially_succeeded` |
| `failed` | `failed`, `expired`, `blocked_by_policy`, `outcome_unknown` |
| `cancel_requested` | `cancel_requested` |
| `cancelled` | `canceled` |

Chat exposes Chat-flavoured names to the SPA through a projection; it does not create a second
`crm_chat_turn` table unless a concrete requirement appears (the plan itself says "store the reference
and the minimum UI lifecycle state").

---

## 10. Implemented vs planned modules

| Module | State in this checkout | Evidence |
| --- | --- | --- |
| Entity Engine, Metadata, ACL, Search, Reports, Dashboards, Jobs, Workflows/BPM, Email, Attachments, Documents, Calendar, Portal, Audit, Extensions, Settings/Admin, i18n | implemented | `apps/api/src/<module>`, `database/migrations/*`, tests in `apps/api/test` |
| Projects | implemented | `apps/api/src/projects`, `packages/bpm`, `migrations/018` |
| Sales | implemented | `apps/api/src/sales`, `migrations/021-031` |
| Customer Success | implemented | `apps/api/src/customer-success`, `migrations/032` |
| Service Desk | implemented | `apps/api/src/service-desk`, `migrations/033-036` |
| Marketing Automation | implemented | `apps/api/src/marketing-automation`, `migrations/037-043` |
| Voice Communications | implemented | `apps/api/src/voice-communications`, `migrations/051-054` |
| Advanced Integrations | implemented | `apps/api/src/advanced-integrations`, `migrations/056-060` |
| AI Agents | implemented | `apps/api/src/ai-agents`, `migrations/045-050` |
| **CRM Chat** | **planned only — absent** | no `CRMChat`, `crm-chat` or `crmChat` identifier exists in `apps`, `packages`, `database` or `i18n` |
| Knowledge Base | implemented, narrow | `KnowledgeArticle` + `KnowledgeCategory` metadata entities (`database/seed-metadata.ts:3863`), `KnowledgeBaseService` (publish/archive/portal/suggest/expire), portal + CSAT entry points (`apps/web/src/api/client.ts:1335`) |
| Help retrieval / documentation index / vector store | not implemented | no search endpoint over articles, no chunk index, no RAG |

Consequence: the Chat plan's cross-module examples are *possible*, but only through tools that do not
exist yet (matrix #12/#5) — CHAT.11 is a real implementation phase, not wiring.

---

## 11. Test and verification safety (audited, not assumed)

| Question | Finding |
| --- | --- |
| Does any test create a test database? | **No.** `vitest.config.ts` has no global setup and no DB provisioning. `apps/api/test/helper.ts:20` and `test/support/boot-api.ts:39` comment and implement "configured project database (AGENTS.md §3.1); no database is created". |
| Does any test reset/truncate/drop? | **No.** `grep -n "CREATE DATABASE\|TRUNCATE\|DROP\|dropdb\|createdb"` over `database/*.ts`, `apps/api/test/*`, `scripts/*.sh` returns no matches for those operations. |
| Is `db:seed` destructive? | **No.** `database/seed.ts` is idempotent (`fixed ids` + `ON CONFLICT DO NOTHING`); it is designed to run on every boot and every test run. |
| Does the Playwright harness reach the real database? | Yes, the configured one, via `pnpm db:seed`. It also sets `MAIL_TRANSPORT=memory`, `NODE_ENV=production`, `RATE_LIMIT_MAX=2000` and dedicated ports 3140/8140. |
| Do AI tests call a billable provider? | **No.** `ai-provider-fake.ts` is registered only when `NODE_ENV !== 'production'`; tests boot with `NODE_ENV=test` and drive `.../execute` explicitly. |
| Do tests leave work on the real queue? | **No.** `JOB_QUEUE_NAME` defaults to `crm-jobs-test` in the boot helper. |
| Are test rows identifiable and cleaned up? | Yes — `AGENT_TEST_<runId>` markers, unique role/user/provider keys, cleanup by exact id in `afterAll`, no broad deletes. |
| Failed-run leakage | `outcome_unknown` runs are intentionally left for reconciliation; tests assert this rather than forcing a retry. |

**Constraint for CHAT.18:** the e2e suite must keep `MAIL_TRANSPORT=memory` and the fake provider, and
must not exercise campaign sends, calls, SMS, payments or external webhooks. No new database, schema,
container or queue may be introduced by Chat tests.

---

## 12. Security findings that constrain Chat

1. **Indirect prompt injection is already modelled, not solved.** Tool results are delimited as
   untrusted data and conversation memory is wrapped as untrusted; the model still decides. Chat must
   keep retrieved text out of system prompts and must add its own injection cases (note fields,
   attachment text, "ignore previous instructions") in CHAT.16/18.
2. **Read tools are ACL-correct but coarse.** `crm_search_records` validates that the field exists and
   is not a bookkeeping column, then relies on `EntityCrudService.list` for record/field ACL. This is
   sound; Chat must not add a hand-written query path around it.
3. **Aggregates do not exist, so there is no inference-by-count risk yet** — but the moment
   `crm_aggregate_records` is added, aggregates must be computed after ACL filtering, never over
   unfiltered data. Treat as a hard acceptance rule in CHAT.10.
4. **`low_write` auto-execution** (§6.4) is the single biggest deviation between the plan's "confirm by
   default" and current engine defaults. Fix at grant level.
5. **Citation ACL drift.** `content_meta.refs` is re-checked when building a prompt, but nothing
   re-checks it when rendering history to the user. Chat must revalidate before displaying a label or
   a link, and hide (not error) a revoked citation.
6. **No output sanitizer today.** Because there is no chat renderer yet, this is a clean slate: do not
   ship `dangerouslySetInnerHTML` and do not let the model emit trusted links. Citation URLs must come
   from a route builder over allowlisted entity/record ids.
7. **Conversation text is stored plainly.** PII minimisation therefore depends on (a) not logging
   prompts (`logPrompts: false`), (b) tool-level field stripping, and (c) retention. Do not add an
   access log that echoes message bodies.
8. **Wildcard ACL grants synthetic resources** — documented behaviour, not a Chat-specific bypass; say
   so in the threat model instead of hiding it.
9. **Worker door.** `@Public()` + shared secret protects `action/worker/*`. Chat must not add a second
   worker secret or a second public route.

---

## 13. Blockers, assumptions and open questions

### Blockers (must be resolved before CHAT.2 writes code)

- **B1 — No default Chat agent exists.** Chat needs a published agent profile with
  `memory.mode:'conversation'`. Creating it at install time requires a provider connection the
  administrator chose (the module deliberately refuses to infer one). Until then Chat must render a
  clear "assistant not configured" state, not a broken composer.
- **B2 — `features.memory` is `false` by default** and `features.execution` is `false` by default. On a
  fresh install, Chat is inert by design. The contract must define the install/enable path and the
  exact error surfaces.
- **B3 — No streaming primitive.** CHAT.6 needs the spike described in §8 before the SPA can rely on
  it; polling must be the guaranteed path.
- **B4 — No help *retrieval*, and a support-oriented corpus.** Articles exist and are editable with a
  publish/expire lifecycle, but there is no staff search endpoint and no product documentation in the
  corpus. CHAT.1 must decide whether CHAT.9 ships `help_search_articles` over existing articles (and
  reports "no article found") or also seeds product topics. No new index should be built for this.
- **B5 — Rendering dependency question (§13 Q3).** Either ship a deliberately plain renderer (safe,
  less pretty) or add one vetted markdown + sanitizer pair (a new dependency decision).

### Assumptions this audit relied on

- A1. `pnpm` + Node ≥ 22 is the toolchain (root `package.json` `engines`); no second package manager.
- A2. `DATABASE_URL` points at a safe development database; no destructive operation was needed or run.
- A3. `ENCRYPTION_KEY` is present wherever provider credentials are configured (required for writes).
- A4. The 10 allowlisted `READABLE_ENTITIES` are sufficient for the first Chat slice; expanding them is
  a reviewed change to `ai-agent-tools.ts`, not a config value.

### Questions for CHAT.1 (recommendations in parentheses)

- Q1. Conversation creation: explicit empty thread vs created on first turn. *(Create on first turn —
  matches `conversationForRun`, avoids empty threads in the sidebar and in retention counts.)*
- Q2. Turn records: project run status vs add `crm_chat_turn`. *(Project — no duplicate lifecycle.)*
- Q3. Message rendering: plain text + structured blocks vs markdown dependency. *(Plain text with safe
  structured blocks in the first slice; revisit markdown with a sanitizer in a later pass.)*
- Q4. Write scope for the MVP. *(Exactly one: `crm_create_task` with grant-level approval; everything
  else read-only.)*
- Q5. Conversation search: `ILIKE` over message content with `pg_trgm` vs `tsvector`. *(ILIKE/trgm —
  the extension is already installed and Vietnamese tokenisation is unreliable without a dictionary.)*

---

## 14. Database and migration proposal (for CHAT.3)

Next free number: **`062_phase19_crm_chat.sql`** at the time of writing. `061` was claimed *during*
this audit by an unrelated in-flight change (`061_phase19_ai_agents_provider_kind.sql`, the Anthropic
provider adapter), which is exactly why CHAT.3 must re-check the directory before naming the file
rather than trusting a number written in a document. Additive only (`CREATE TABLE
IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, nullable `ALTER`s), one transaction, no renames, no
drops, no data rewrites.

**Delivered as `062_phase19_crm_chat.sql`** in 19-CHAT.3, with the names the contract fixed
(`crm_chat_citations`, `crm_chat_feedback`, `crm_chat_prompts`). Plural table names follow the plan's
logical schema and the contract; the singular names in the first draft of this section were a
proposal, not a convention.

| Table | Purpose | Key constraints (as created) |
| --- | --- | --- |
| `crm_chat_citations` | Evidence attached to an assistant message | `message_id` FK → `ai_agent_messages ON DELETE CASCADE`; `conversation_id` FK cascade; `source_type` CHECK (4 values); target CHECK (a `crm_record` citation must carry `entity` + `record_id`, other kinds must not); `UNIQUE (message_id, ordinal)`; indexes `(conversation_id, ordinal)` and `(entity, record_id)` |
| `crm_chat_feedback` | Rating + optional category/comment | `message_id`/`conversation_id` FK cascade; `owner_user_id` FK → `users` cascade; `UNIQUE (message_id, owner_user_id)`; `rating` CHECK (`up`, `down`); bounded `category`/`comment` |
| `crm_chat_prompts` | Owner-scoped prompt templates (data only) | `owner_user_id` FK cascade; `UNIQUE (owner_user_id, name)`; non-blank bounded `name`/`prompt_template`; index `(owner_user_id, modified_at DESC) WHERE enabled` |

Two column-level deviations from this section's first draft, both to keep the data verifiable:
`source_ref` became `entity` + `record_id` (so a CHECK can enforce that a record citation points at a
record), and `route_key`/`display_label` became `route`/`label` (both are server-built, never
model-supplied, and are stored already resolved).

**Delete semantics differ from `AIAgentMemoryService.deleteConversation`, deliberately.** That method
(used by the AI Agents administration surface) hard-deletes a thread. Chat's `DELETE` only sets
`status = 'deleted'`, so the row, its citations and its feedback survive inside the retention window
and the sweep — not a request — is what finally removes them. A reviewer should not "fix" one to match
the other: the admin path is an explicit operator action on an existing owner's data, while the Chat
path is a user hiding their own thread.

Deliberately **not** added: `crm_chat_conversation`, `crm_chat_message`, `crm_chat_turn`,
`crm_chat_usage_event` — §4 and §9 explain why the existing stores are authoritative.

If a `visibility`/`team_id` sharing feature is ever approved, it is a separate reviewed migration with
its own audit entries; conversation sharing is **not** inferred from team membership.

---

## 15. Dependency map

```text
                       +--------------------------------------+
                       |            CRMChatModule            |
                       |  conversations / turns / citations   |
                       |  feedback / saved prompts / stream   |
                       +---+-----------+-----------+------+---+
                           |           |           |      |
             +-------------+           |           |      +-----------------+
             |                         |           |                        |
   +---------v----------+   +----------v--------+  |          +-------------v---------+
   | AIAgentRunService  |   | AIAgentApproval   |  |          | AclApiService /       |
   | create/get/events/ |   | Service           |  |          | RequestScope          |
   | cancel/retry       |   | approve/reject    |  |          +-----------------------+
   +---------+----------+   +----------+--------+  |
             |                         |           |          +-----------------------+
   +---------v----------+   +----------v--------+  |          | JobsService / worker  |
   | AIToolRegistry     |   | ai_agent_         |  |          +-----------------------+
   | (6 tools today)    |   | approvals         |  |
   +---------+----------+   +-------------------+  |          +-----------------------+
             |                                     |          | Audit / Notifications |
   +---------v------------------------------+      |          +-----------------------+
   | EntityCrudService + METADATA_STORE     |      |
   | (ACL, field stripping, validation)     |      |
   +---------+------------------------------+      |
             |                                     |
   +---------v------------------------------+      |
   | Postgres: entity_records, ai_agent_*   <------+ (read-only projections)
   +---------+------------------------------+
             ^
             |  one-way tool adapters (CHAT.10/11)
   +---------+-------------------------------------------------------------+
   | Sales | CustomerSuccess | ServiceDesk | Projects | Marketing | Voice  |
   +-----------------------------------------------------------------------+

   No arrow points from a domain module back into CRMChat.
```

---

## 16. Safe verification commands (for later phases)

| Check | Command | Notes |
| --- | --- | --- |
| Typecheck | `pnpm typecheck` | API + web |
| Lint | `pnpm lint` | `eslint . --max-warnings=0` |
| Tests | `pnpm test` | Vitest, configured DB, fake provider, no reset |
| Build | `pnpm build` | Workspace build |
| Migration | `pnpm db:migrate` | Review the new Chat migration first; additive only |
| E2E | `pnpm test:e2e` | Seeded configured DB, `MAIL_TRANSPORT=memory` |

Never run a reset/truncate/drop/recreate path. This audit ran **no** database command and made **no**
schema change, so nothing was migrated, seeded or deleted as part of 19-CHAT.0.

---

## 17. Smallest implementation plan (after CHAT.1)

| Phase | Smallest useful outcome | Blocked by |
| --- | --- | --- |
| 19-CHAT.1 | Contract + threat model: routes, DTOs, event schema, citation contract, turn mapping, Q1–Q5 decisions — **delivered** | this audit |
| 19-CHAT.2 | `CRMChatModule` registration, `crmChat` settings row, `CRMChatConversation`/`CRMChatAdmin` capabilities, `/crm-chat` route + navigation entry, shell states, i18n — **delivered** | B1, B2 (for a usable shell) |
| 19-CHAT.3 | One additive migration (citation, feedback, saved prompt) — **delivered** (`062_phase19_crm_chat.sql`) | next free migration number (§14) |
| 19-CHAT.4 | Conversation list/get/rename/archive/delete + paginated messages over the reused store — **delivered** | none |
| 19-CHAT.5 | `AIAgentsClient` adapter: submit turn, read status/events/toolCalls, cancel, approvals | B1 |
| 19-CHAT.6 | SSE turn stream + heartbeat + reconnect + cancel, polling fallback | B3 |
| 19-CHAT.7 | Chat workspace UI (sidebar, thread, composer, approvals card, citations, errors) | B5 |
| 19-CHAT.8 | Citations: persist `result.sources`, trusted route builder, ACL re-check at render | none |
| 19-CHAT.10 | `crm_aggregate_records` (+ `crm_get_timeline`) with ACL-before-aggregate tests | none |
| 19-CHAT.12 | One write: `crm_create_task` with grant-level approval, preview + confirm through AIAgents approvals | Q4 |

Deferred with reasons: cross-module domain tools (implemented module by module), token-level
streaming (provider contract), portal chat (separate threat model), and any vector/chunk index for
help (the `KnowledgeArticle` corpus is small and metadata-driven; start with an Entity-Engine read
tool and measure before adding infrastructure).

---

## 18. Limitations of this audit

- Verified by reading source, migrations, tests and configuration. Nothing was executed against the
  database, and no application was booted, because 19-CHAT.0 forbids code/schema changes and requires
  no runtime evidence.
- The SSE-adapter question (§8) is explicitly **unverified**; it is scheduled as a spike in CHAT.6.
- The Service Desk knowledge base was found late in the pass and is described from
  `knowledge-base.service.ts` + the entity definition only; its admin/portal UI behaviour was not
  exercised, so CHAT.9 must confirm how articles are authored and whether internal articles are
  reachable by staff at all.
- Cross-module tool feasibility is assessed at the level of "does an owning service exist", not
  "is every metric callable" — CHAT.11 must audit each domain service it exposes.
- The count of implemented modules is based on directory presence plus migrations plus tests, not on a
  full functional review of each one; the per-module audits under `docs/implementation/` remain the
  deeper source for those modules.
