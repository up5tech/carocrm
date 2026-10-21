# `CRMChat` — product contract (v1)

> **Plan:** `PLAN_Phase_19_CRM_Chat.md` §17 (`Phase 19-CHAT.1`); decisions rest on
> `docs/modules/crm-chat/repository-audit.md` (19-CHAT.0).
> **Status:** delivered in 19-CHAT.1 and implemented in full through 19-CHAT.18
> (`apps/api/src/crm-chat/`). Every route in §6 is served by the controller; the route table in
> `crm-chat-contract.ts` is pinned against the controller by `apps/api/test/crm-chat-contract.test.ts`.
> **Contract version:** `1.2.0`. Any breaking change to a path, a request shape, a response shape, a
> stream event or an error code bumps the minor version and is recorded in §15.
> **Naming:** module `CRMChat`, route slug `crm-chat`, API prefix `/api/v1/CRMChat`, SPA route
> `/crm-chat`. No `Ua` prefix anywhere.

This document is the authority for what Chat exposes. `PLAN.md` describes intent; the audit describes
what the repository can do; this contract is what code must match. A route that is not here does not
exist, and a field that is not here must not be invented by the SPA.

---

## 1. Boundary in one paragraph

`CRMChat` is the conversational experience: it owns the conversation identity and history a user sees,
the turn lifecycle as that user experiences it, citations, feedback and saved prompt templates. Every
model call, tool invocation, approval decision, retry, cancellation and usage record is `AIAgents`.
Chat never selects a provider, never holds a credential, never registers a tool, never executes SQL and
never decides on its own that a write may proceed. When a turn needs the runtime, Chat submits a run
through the `AIAgents` contract and renders what comes back; when the runtime is unavailable, Chat says
so.

What a turn may actually be asked to do — the supported intents and, as importantly, the unsupported
ones — is Appendix A (§16).

---

## 2. Decisions register

Each decision is final for v1. The alternatives are recorded because they keep coming back.

| # | Decision | Why | Alternative rejected |
| --- | --- | --- | --- |
| D1 | Conversation and message history live in `ai_agent_conversations` / `ai_agent_messages`. Chat adds **no** conversation table. | Owner scoping, `UNIQUE (conversation_id, seq)` + per-conversation advisory lock ordering, per-conversation expiry, deterministic rolling summary and reference re-checking already exist and are tested. | A `crm_chat_*` copy: two retention policies, two orderings, no clear authority. |
| D2 | A conversation is created **on the first turn** (§4.3), not by an explicit "new conversation" call. | Matches `AIAgentMemoryService.conversationForRun`, keeps empty threads out of the sidebar, the retention sweep and the limit counters. The SPA's "New" control is a client-side draft state until the first send. | `POST /conversations` creating an empty row that any abandoned visit leaves behind. |
| D3 | The run row **is** the turn record. Chat stores no turn table; the plan's turn states are a projection of `RunStatus`. | `ai_agent_runs` already carries status, counters, idempotency key, conversation link, cancellation and terminal-state guarantees. | A `crm_chat_turn` duplicate whose status would inevitably disagree with the run's. |
| D4 | Idempotency is `ai_agent_runs.idempotency_key` (unique partial index), supplied by the client per submission. | Already enforced under concurrency in the database, not in application code. | A Chat-side dedupe cache that loses state on restart. |
| D5 | Approvals are `ai_agent_approvals`; Chat renders them and calls the `AIAgents` approve/reject routes. | The approval already revalidates the target record, record state, expiry and decision authority at decision time. | A Chat proposal hash/expiry system with ambiguous authority. |
| D6 | A write is gated **twice**: `features.actionProposals` plus `safety.allowWrites` (Chat), and human approval (AIAgents). | The audit found `crm_create_task` is `low_write` and would execute without approval; the Chat agent version grants it with `requires_approval: true`, which `approvalRequired()` honours. | Flipping the tool definition, which would change `AIAgents` behaviour for every existing agent. |
| D7 | Routes are `/api/v1/CRMChat/action/...` (PascalCase resource + `action` commands). | Every module controller in this repository does this; kebab-case paths in the plan are illustrative. | `/api/v1/crm-chat/...`. |
| D8 | Success payloads are **not** wrapped; list reads return `{ list, total, offset, count }`. | Repository convention (`AIAgentRunService.list`, `EntityCrudService.list`). | A Chat-specific envelope. |
| D9 | A malformed **body** is `400 INVALID_QUERY`; an invalid **value** that reaches a service is `422 VALIDATION_FAILED`. | Matches `AIAgents`, whose controller parses shape and whose service validates meaning. | Uniform 422, which would break parity with the module Chat depends on. |
| D10 | Streaming is SSE, added once, with polling as the guaranteed fallback. | No streaming transport exists today (audit §8); `@Sse()` with the Fastify adapter must be proven by a spike before the SPA depends on it. | A WebSocket stack for one unidirectional feed. |
| D11 | Markdown is **not** rendered in v1: assistant text renders as plain text with safe structured blocks. | The SPA has no markdown parser and no HTML sanitizer; adding two dependencies to render model output is a larger decision than the first slice deserves. | `dangerouslySetInnerHTML` — never. |
| D12 | Conversations are private to their owner. Sharing is not implemented. | The plan makes sharing an explicit, audited feature; inferring access from team membership is exactly the escalation the audit warns about. | Team-visible threads by default. |

---

## 3. Actors, ownership, visibility

| Actor | May | Must not |
| --- | --- | --- |
| Authenticated internal user with `CRMChatConversation:read` | Open the workspace, read and search their own conversations, submit turns, rate answers | Read another user's conversation, act with an identity other than their own |
| The same user with `CRMChatConversation:edit` | Create (by first turn), rename and archive their own conversations | Rename or archive someone else's |
| The same user with `CRMChatConversation:delete` | Delete their own conversation, subject to retention | Delete another user's, or a record the conversation cites |
| Administrator (`CRMChatAdmin:edit`) | Read and change Chat flags, limits, retention and the assistant reference | Read another user's conversation content through the admin surface (v1 has no such route) |
| `AIAgents` | Provide runs, tools, approvals, usage | Be re-implemented by Chat |

Rules that hold everywhere:

1. **Ownership is server-derived.** No request body accepts an owner id, a conversation owner or a
   tenant. A conversation id is not an authorization token: a caller who does not own it receives
   `404 NOT_FOUND`, identical to a conversation that does not exist (audit §4, plan §12.1).
2. **A turn runs as its author.** The run engine re-enters the author's request scope
   (`AIAgentRunService.execute` → `scope.runAs`), so every tool call is authorized as that user at that
   moment. Chat adds no elevation and no service identity.
3. **Retention is inherited.** A conversation carries its own `expires_at` (tighter of the agent policy
   and the instance ceiling); the `AIAgents` sweeper is the only executor. Chat exposes the effective
   window, never its own sweeper.
4. **Deleting a conversation does not delete CRM data, runs or audit rows.** `ai_agent_runs` keeps its
   history with `conversation_id` nulled, which is what preserves "the action happened" while removing
   "what was said".
5. **Visibility is the server's answer, in every surface.** The workspace *and* the header quick access
   are offered exactly to the callers the resolved navigation tree carries the Chat page for — the
   same `CRMChatConversation:read` permission and the same `crmChat.features.workspace` flag. The SPA
   never re-decides either, and a quick-access turn runs with the caller's own rights like any other.

### 3.1 SPA surfaces

| Surface | What it is | What it may not do |
| --- | --- | --- |
| `/crm-chat` | The workspace: conversation list, history, composer, citations, feedback, proposed actions | Nothing beyond §3 — it is an ordinary Chat client |
| Header quick access | A compact panel in the app header that submits a turn, streams the same lifecycle events and shows the answer without leaving the current page | Decide a proposed action (it points the caller at the workspace), read another user's conversation, or bypass the assistant readiness gate |

Both surfaces speak the same turn API and the same stream (§8); the quick access is a smaller
presentation of one thread, and the thread it opens is the same conversation the workspace lists.

---

## 4. Conversation and turn lifecycle

### 4.1 States

| Concept | Values | Owner |
| --- | --- | --- |
| Conversation status | `active`, `archived`, `deleted` | Chat, in the reused table |
| Turn (run) status | `queued`, `running`, `waiting_for_approval`, `waiting_for_input`, `retry_wait`, `cancel_requested`, `succeeded`, `partially_succeeded`, `failed`, `canceled`, `expired`, `blocked_by_policy`, `outcome_unknown` | `AIAgents` |
| Message role | `user`, `assistant`, `tool`, `system` | `AIAgents` store |
| Message redaction | `none`, `summary`, `hashed` | `AIAgents` store |
| Citation source type | `crm_record`, `query_result`, `report`, `help_document` | Chat (19-CHAT.8) |
| Feedback rating | `up`, `down` | Chat (19-CHAT.14) |

### 4.2 Turn state projection

The SPA never sees a raw run status for a *turn*: the API projects it, so the vocabulary can change
without breaking the client.

| Chat turn state | Run status |
| --- | --- |
| `accepted` | `queued` |
| `running` | `running`, `retry_wait` |
| `waiting_approval` | `waiting_for_approval` |
| `waiting_input` | `waiting_for_input` |
| `cancel_requested` | `cancel_requested` |
| `completed` | `succeeded` |
| `partial` | `partially_succeeded` |
| `cancelled` | `canceled` |
| `failed` | `failed`, `expired`, `blocked_by_policy`, `outcome_unknown` |

Allowed transitions are the run engine's (`RUN_STATUSES` + `TERMINAL_RUN_STATUSES`); a terminal state
never returns to `running`. Chat adds no transition of its own — it only relabels.

### 4.3 First turn creates the thread

1. The client submits `{ conversationId?: string, prompt, idempotencyKey?, contextRefs? }`.
2. Chat resolves the assistant (§10) and refuses with `FEATURE_DISABLED` / `503 CHAT_AGENT_UNAVAILABLE`
   when it is not `ready`.
3. Chat calls `AIAgentRunService.create(agentId, { input, idempotencyKey, conversationId })`.
   With no `conversationId`, the runtime creates a thread whose title is the first 120 characters of the
   message; with one, ownership, agent match, `active` status and expiry are enforced there.
4. Chat returns the thread id, the turn id (run id) and the projected state, so a client that lost the
   response can resume by polling or reconnect.
5. A replayed `idempotencyKey` returns the **same** turn: `create()` returns the existing run instead of
   queueing a second one, and the unique index is what makes that true under a double-click.

### 4.4 Rename, archive, delete

| Action | Effect | Rule |
| --- | --- | --- |
| Rename | `title` update | Owner only; 1–200 characters after trim; empty title is refused |
| Archive | `status = 'archived'` | Owner only; archived threads are read-only and excluded from the default list |
| Delete | `status = 'deleted'`, then the AI Agents retention sweep removes the row (and cascades messages, citations and feedback) | Owner only; a deleted thread is `404` immediately, and the row survives inside the retention window so support and audit can still see what was cited |
| Restore | `status = 'active'` | **Offered** (19-CHAT.4 decision). The plan's default was "not offered"; a one-way archive turns a misclick into a lost thread, and reopening is the same owner-only update |

Deletion is a marker, not a destructive statement: Chat never runs `DELETE` against a conversation, so no
Chat request can remove a row before its retention window and no broad delete exists to misuse.

---

## 5. Capability and permission model

Synthetic ACL resources, evaluated by `AclApiService` (the `AIAgents` precedent). No parallel permission
table exists.

| Capability key | Resource / action | Grants |
| --- | --- | --- |
| `use` | `CRMChatConversation:read` | Open the workspace, read own conversations |
| `manage` | `CRMChatConversation:edit` | Create by first turn, rename, archive |
| `delete` | `CRMChatConversation:delete` | Delete own conversations |
| `feedback` | `CRMChatFeedback:edit` | Rate an answer |
| `prompts` | `CRMChatPrompt:edit` | Manage own prompt templates |
| `admin` | `CRMChatAdmin:edit` | Chat flags, limits, retention, assistant reference |

Consequences, stated rather than implied: `sysAdmin` and `users.is_admin` hold every capability; a role
with a `*` entry inherits these resources as it inherits every future entity; a caller with no
`CRMChatConversation` entry has no Chat access at all; **record and field ACL is not covered here** and
still applies to every record a tool touches.

Two gates always apply in this order — permission, then deployment flag. Neither implies the other.

---

## 6. API surface

All routes are under `/api/v1/CRMChat`, authenticated by the global `AuthGuard`, validated by strict
Zod shapes at the controller boundary, and registered **before** `ENTITY_CONTROLLERS`.

### 6.1 Foundation — implemented in 19-CHAT.2

| Method | Path | Gate | Response |
| --- | --- | --- | --- |
| `GET` | `action/capabilities` | `use` (permission only, flag **not** required) | `CRMChatCapabilitiesView` (§7.1) |
| `GET` | `action/health` | `use` + `features.workspace` | `CRMChatModuleHealthView` (§7.2) |
| `GET` | `action/settings` | `admin` (flag **not** required) | `CRMChatSettingsView` (§7.3) |
| `POST` | `action/settings` | `admin` | `CRMChatSettingsView`; body `CRMChatSettingsPatch` |

Why the flag is not required on three of them:

- **capabilities** must answer while Chat is disabled, otherwise the shell cannot explain the state and
  the user sees a bare 403.
- **settings** must answer while Chat is disabled, otherwise disabling Chat would be irreversible
  through the API.

Everything functional — health, conversations, turns, stream, citations, feedback — is refused with
`403 FEATURE_DISABLED` when `features.workspace` is off, and every one of them also requires its own
capability. Hiding a menu entry is never the enforcement.

### 6.2 Conversations — implemented in 19-CHAT.4

| Method | Path | Gate | Request | Response |
| --- | --- | --- | --- | --- |
| `GET` | `action/conversations` | `use` | `offset`, `maxSize` ≤ 50, `status` (`active`\|`archived`), `q` (19-CHAT.14) | `{ list, total, offset, count }` |
| `GET` | `action/conversations/:id` | `use` + owner | — | `CRMChatConversationView` + paginated messages |
| `GET` | `action/conversations/:id/messages` | `use` + owner | `before` (sequence cursor), `maxSize` ≤ 100 | `{ list, nextBefore, hasMore }` |
| `PATCH` | `action/conversations/:id` | `manage` + owner | `{ title? , status? }` strictly | `CRMChatConversationView` |
| `DELETE` | `action/conversations/:id` | `delete` + owner | — | `{ status: true }` |

Pagination decisions that the implementation fixes, so the client cannot get them wrong:

- The list is keyset-stable by `(last_activity_at DESC, id DESC)`, so two threads touched in the same
  millisecond cannot swap places between pages.
- History is **keyset by `seq`**, not offset: `before` is the oldest sequence already shown. A message
  appended while the user scrolls appears on refresh instead of shifting a page, and no row is repeated.
- `maxSize` is bounded by the route and rejected (`400 INVALID_QUERY`) when out of range rather than
  silently clamped; `q` (text search) is a 19-CHAT.14 field and is refused until then.
- `status` accepts `active`, `archived` or `all`; `deleted` is never a filter, because a deleted thread
  is gone for its owner.

### 6.3 Turns — specified, delivered in 19-CHAT.5/19-CHAT.6

| Method | Path | Gate | Request | Response |
| --- | --- | --- | --- | --- |
| `POST` | `action/turns` | `use` + `readTools` effective + assistant `ready` | `{ conversationId?, prompt, idempotencyKey?, contextRefs? }` | `CRMChatTurnView` (202) |
| `GET` | `action/turns/:turnId` | `use` + owner | — | `CRMChatTurnView` |
| `GET` | `action/turns/:turnId/events` | `use` + owner | `Last-Event-ID` | `text/event-stream` (§8) |
| `POST` | `action/turns/:turnId/cancel` | `use` + owner | `{}` | `CRMChatTurnView` |
| `GET` | `action/help/search` | `use` | `?q=query` | `HelpSearchResult` (§11) |
| `POST` | `action/query/execute` | `use` | `QueryPlan` | `QueryResult` (§12) |
| `POST` | `action/citations/reauthorize` | `use` | `{ citations }` | `{ citations: ReauthorizedCitation[] }` (§10) |
| `POST` | `action/turns/:turnId/feedback` | `feedback` + owner | `{ rating, category?, comment? }` | `{ status: true }` |

Submission is `POST action/turns`, not a route nested under a conversation, because per D2 the thread
does not exist until the first turn: `conversationId` is optional in the body and the runtime creates
the thread when it is absent (§4.3).

`contextRefs` is the only client-supplied influence on what the agent may look at, and it is a
**reference**, not data: `{ entity: string, id: string }` (at most `limits.maxContextRefs`). The server
re-reads the record under the caller's ACL, and an unreadable reference is dropped with a
`partialContext` flag rather than failing the turn.

`prompt` is the field name the implementation uses; an earlier draft of this contract called it
`message`. The implemented name is the one clients send, and it is the name the SPA and the tests
use. Changing it would be a breaking change and is recorded in §15 rather than made silently.

### 6.4 Actions — specified, delivered in 19-CHAT.12 (thin façade over `AIAgents`)

| Method | Path | Gate | Notes |
| --- | --- | --- | --- |
| `GET` | `action/actions/:approvalId` | `use` + owner | Authorized projection of an existing `ai_agent_approvals` row |
| `POST` | `action/actions/:approvalId/confirm` | `use` + owner + `actionProposals` + `safety.allowWrites` | Calls `AIAgents` approve; revalidation happens there |
| `POST` | `action/actions/:approvalId/reject` | `use` + owner | Calls `AIAgents` reject; needs no write switch, because a rejection removes an intent to write |

Chat creates **no** proposal record. If the approval id is unknown or belongs to another user, the
answer is `404 NOT_FOUND` — the same answer as a nonexistent one.

### 6.5 Saved prompts — specified, delivered in 19-CHAT.14

| Method | Path | Gate | Notes |
| --- | --- | --- | --- |
| `GET` | `action/prompts` | `use` | Owner-visible templates only |
| `POST` | `action/prompts` | `prompts` | `{ name, promptTemplate, description? }`; template is data, never executed |
| `PATCH` | `action/prompts/:id` | `prompts` + owner | Rename, edit text, enable/disable |
| `DELETE` | `action/prompts/:id` | `prompts` + owner | — |

### 6.6 Error codes

The repository renders `{ error: { code, message, details? } }` with a matching HTTP status. Chat reuses
the shared `AppError` subclasses and adds a module-specific code only where the client must branch
differently.

| Situation | Status | Code | Source |
| --- | --- | --- | --- |
| No session | 401 | `AUTHENTICATION_REQUIRED` | kernel |
| Missing capability | 403 | `AUTHORIZATION_DENIED` (`details.capability`) | `CRMChatPermissionService` |
| Workspace/feature off | 403 | `FEATURE_DISABLED` (`details.feature`) | `CRMChatPolicyService` |
| Malformed body | 400 | `INVALID_QUERY` | controller `parse()` |
| Invalid value | 422 | `VALIDATION_FAILED` | settings/domain services |
| Conversation or turn not owned / absent | 404 | `NOT_FOUND` | Chat |
| Title changed concurrently | 409 | `CONCURRENCY_CONFLICT` | 19-CHAT.4 |
| Rate limit | 429 | `RATE_LIMITED` | kernel + Chat limits |
| Turn limit reached | 429 | `CHAT_TURN_LIMITED` | 19-CHAT.17 |
| Message over the limit | 422 | `VALIDATION_FAILED` (`details.maxChars`) | 19-CHAT.4 |
| Assistant not ready | 503 | `CHAT_AGENT_UNAVAILABLE` (`details.state`) | 19-CHAT.5 |
| Provider outage | 503 | `CHAT_PROVIDER_UNAVAILABLE` | 19-CHAT.6 |
| Approval required for a write | 409 | `CHAT_APPROVAL_REQUIRED` | 19-CHAT.12 |
| Context references exceed the limit | 422 | `CHAT_CONTEXT_TOO_LARGE` | 19-CHAT.8 |

A `404` never distinguishes "does not exist" from "you may not see it", and no error body carries a
record value, a prompt, a tool argument or a provider payload.

---

### 6.7 Cross-module analysis — delivered in 19-CHAT.11

| Method | Path | Gate | Notes |
| --- | --- | --- | --- |
| `GET` | `action/cross-module/scenarios` | `use` | The curated paths this installation can answer |
| `POST` | `action/cross-module/analyze` | `use` | `{ scenario, rootId }`; returns per-step evidence |

A scenario is **server-owned**: the caller names one of the curated paths and the record it starts
from, and cannot inject an entity, a relation, a join or a limit. Each step follows a relation
declared in the entity metadata, is bounded, and is read through the Entity Engine, so the caller's
own record scope applies to every hop.

A step that cannot be answered — a relation the installation does not declare, a module that is not
installed, a target entity the caller may not read — yields a **partial** result with a per-step
reason. It never yields a `0` that reads like "there is nothing", and it never exposes the failure
detail of the underlying query.

### 6.8 Usage and observability — delivered in 19-CHAT.17

| Method | Path | Gate | Notes |
| --- | --- | --- | --- |
| `GET` | `action/turns/:turnId/usage` | `use` + owner | The turn's counters and its provider-ledger cost |

Chat never maintains a usage counter of its own: the numbers are read from the AIAgents run and its
provider ledger, and `costLabel` keeps AIAgents' meaning — `estimate` when the cost came from an
administrator-maintained pricing snapshot, `none` when the deployment has no price data and the
total is an exact `0` rather than a guess.

## 7. Data contracts

Types are declared in `apps/api/src/crm-chat/` (server) and `apps/web/src/api/types.ts` (client). The
two must stay structurally identical; a field added on one side is a contract change (§15).

### 7.1 `CRMChatCapabilitiesView` — implemented

```ts
interface CRMChatCapabilitiesView {
  module: { id: 'CRMChat'; name: string; version: string; contractVersion: string;
            apiPrefix: '/api/v1/CRMChat'; frontendRoute: '/crm-chat';
            implementedPhases: string[] };
  workspace: { enabled: boolean; permitted: boolean };
  capabilities: { key: string; label: string; description: string; granted: boolean }[];
  features: { key: string; label: string; description: string; enabled: boolean;
              effective: boolean; defaultEnabled: boolean; settingsPath: string }[];
  assistant: AssistantReadiness;              // §7.5
  limits: CRMChatLimits;                      // §7.4
  actions: { canStartTurn: boolean; canConfirmWrite: boolean; reason: string | null };
}
```

`module.contractVersion` is the version of this document the server implements, exported from
`crm-chat-contract.ts`; a client can refuse to render a surface it does not understand.

`enabled` is `features.workspace && permitted`, so a caller whose role lost the right sees `false` even
while the deployment flag is on. `effective` is the flag **after** its `requires` chain — the only value
the UI may treat as "this works". `actions.canStartTurn` is the single field the composer keys on; it is
`false` whenever the assistant cannot answer, and `reason` always explains why.

### 7.2 `CRMChatModuleHealthView` — implemented

```ts
interface CRMChatModuleHealthView {
  module: { id: string; name: string; version: string; minPlatformVersion: string;
            loadOrder: number; apiPrefix: string; frontendRoute: string;
            implementedPhases: string[]; dependsOn: string[] };
  ok: boolean;
  workspace: { enabled: boolean };
  assistant: AssistantReadiness;
  dependencies: { id: string; label: string; present: boolean;
                  evidence: { kind: string; value: string; present: boolean }[]; missing: string[] }[];
  optionalIntegrations: { id: string; label: string; provides: string; present: boolean; status: string }[];
  features: { key: string; label: string; description: string; enabled: boolean;
              effective: boolean; defaultEnabled: boolean; settingsPath: string }[];
  structures: { name: string; present: boolean }[];    // [] until 19-CHAT.3
  settings: { version: number; updatedAt: string | null; warnings: string[] };
  checks: { name: string; ok: boolean; detail: string }[];
}
```

Every fact is read from the running system (schema introspection, metadata registry, the settings row,
the owner module's readiness). `ok` is `dependencies.every(present) && checks.every(ok)`, so an
installation with no assistant configured reports `ok: false` instead of a green light it cannot back up.
No field here ever contains a credential, a prompt or a record value.

### 7.3 `CRMChatSettingsView` — implemented

```ts
interface CRMChatSettingsView {
  settings: CRMChatSettings;
  version: number; updatedAt: string | null; updatedBy: string | null;
  defaults: CRMChatSettings;
  warnings: { code: string; message: string }[];
  features: Record<CRMChatFeatureKey, boolean>;            // as stored
  effectiveFeatures: Record<CRMChatFeatureKey, boolean>;   // after `requires`
}
```

Warning codes: `workspaceDisabled`, `featurePrerequisiteOff`, `writesDisabled`, `assistantNotConfigured`.

### 7.4 Settings schema, flags and limits — implemented

One strict Zod row in `app_settings` named `crmChat`. Unknown keys are refused; every accepted write
bumps `version` and records `updatedBy`.

| Path | Type | Default | Meaning |
| --- | --- | --- | --- |
| `features.workspace` | boolean | **true** | The only flag on by default: the shell spends nothing |
| `features.readTools` | boolean | false | Grounded answers from live CRM data (needs 19-CHAT.10) |
| `features.helpRetrieval` | boolean | false | Help-article answers (19-CHAT.9) |
| `features.actionProposals` | boolean | false | Write proposals (needs `safety.allowWrites`, 19-CHAT.12) |
| `features.feedback` | boolean | false | Answer ratings (19-CHAT.14) |
| `features.conversationSearch` | boolean | false | History search (19-CHAT.14) |
| `assistant.agentKey` | string ≤ 120 | `''` | Stable key of the published answering agent; empty = not configured |
| `execution.mode` | `queue` \| `inline` | `queue` | `queue` dispatches the run to the durable worker; `inline` starts the same run in the API process (no worker required) |
| `limits.maxMessageChars` | int 1–20 000 | 8 000 | One user message |
| `limits.maxContextRefs` | int 0–20 | 5 | Client-supplied record references per turn |
| `limits.maxActiveTurnsPerUser` | int 1–5 | 1 | Concurrent turns (19-CHAT.17) |
| `limits.maxConversationsPerUser` | int 1–2 000 | 200 | Stored threads (19-CHAT.4) |
| `limits.turnTimeoutSeconds` | int 10–600 | 180 | Turn budget surfaced to the client |
| `limits.heartbeatSeconds` | int 5–60 | 15 | SSE heartbeat (§8) |
| `retention.conversationsDays` | int 1–3 650 | 30 | Ceiling passed to the runtime; it stays the only executor |
| `safety.allowWrites` | boolean | false | Independent operator switch for every mutation |

`requires`: `readTools → workspace`, `helpRetrieval → workspace`, `actionProposals → workspace +
readTools`, `feedback → workspace`, `conversationSearch → workspace`.

### 7.5 `AssistantReadiness` — implemented

```ts
type AssistantState = 'not-configured' | 'unresolvable' | 'not-found' | 'not-published'
  | 'execution-disabled' | 'execution-paused' | 'memory-disabled' | 'agent-memory-off' | 'ready';

interface AssistantReadiness {
  state: AssistantState; reason: string;   // human-safe, never a credential or provider detail
  configuredKey: string; agentId: string | null; name: string | null;
  version: number | null; tools: string[]; memoryMessages: number;
}
```

Resolution order — first unmet requirement wins, so an administrator fixes them top-down:
`agentKey set` → `resolvable under the caller's AI Agents rights` → `exists` → `published with a current
version` → `aiAgents.features.execution` → `not globally paused` → `aiAgents.features.memory` →
published version `memory.mode === 'conversation'` → `ready`.
The last two exist because the audit found `AIAgentMemoryService.conversationForRun` refuses a
conversation id for an agent without conversation memory. Chat reports that; it does not flip it.

### 7.6 Specified for later phases

```ts
interface CRMChatConversationView {          // implemented in 19-CHAT.4
  id: string; title: string | null; agentId: string; agentName: string;
  status: 'active' | 'archived'; messageCount: number;
  lastMessageAt: string; expiresAt: string | null; createdAt: string;
}

interface CRMChatMessageView {               // implemented in 19-CHAT.4; citations filled by 19-CHAT.8
  id: string; sequence: number; role: 'user' | 'assistant' | 'system';
  content: string; contentFormat: 'plain'; redaction: 'none' | 'summary' | 'hashed';
  turnId: string | null; citations: CRMChatCitationView[];   // `[]` until CHAT.8 writes them
  createdAt: string; completedAt: string | null;
}

interface CRMChatMessagePage {               // implemented in 19-CHAT.4
  list: CRMChatMessageView[];
  nextBefore: number | null;                 // pass as `before`; null on the oldest page
  hasMore: boolean;
}

interface CRMChatTurnView {                  // 19-CHAT.5/6
  id: string; conversationId: string; status: CRMChatTurnState;
  userMessageId: string | null; assistantMessageId: string | null;
  agentRunId: string | null; startedAt: string; finishedAt: string | null;
  usage: { steps: number; toolCalls: number; inputTokens: number; outputTokens: number } | null;
  error: { code: string; message: string } | null;
}

interface CRMChatCitationView {              // 19-CHAT.8
  id: string; sourceType: 'crm_record' | 'query_result' | 'report' | 'help_document';
  sourceRef: string;                         // `Entity:id` — opaque to the client
  label: string;                             // resolved server-side, after an ACL re-check
  route: string | null;                      // trusted builder output, or null when access was revoked
  retrievedAt: string;
}
```

`route` is produced by a server-side builder from an allowlisted entity/record pair. The model cannot
supply a URL, and the client never concatenates one.

---

## 8. Stream contract (19-CHAT.6)

`GET action/turns/:turnId/events` returns `text/event-stream`. The durable run is the source of truth;
the stream is a delivery channel that may drop and be re-established.

### 8.1 Events

| Event | Payload | Notes |
| --- | --- | --- |
| `turn.started` | `{ turnId, conversationId, state, at }` | Sent on acceptance (`queued`), then again when a worker/inline dispatch claims the run (`running`) |
| `tool.started` | `{ step, toolKey, label }` | `label` is the tool's declared label — never its arguments |
| `tool.completed` | `{ step, toolKey, status, summary, durationMs }` | `summary` is the tool's own user-safe summary |
| `citation.added` | `CRMChatCitationView` | After the ACL re-check that produced `label`/`route` |
| `action.proposed` | `{ approvalId, riskClass, targetCount, summary }` | No before/after values in the event; they are fetched from the action route |
| `approval.required` | `{ approvalId, expiresAt }` | The turn pauses |
| `assistant.delta` | `{ text }` | **Not in v1** — the provider contract is request/response (audit §5); the UI shows a running state |
| `assistant.message` | `{ messageId, content, redaction }` | The final answer, once |
| `turn.completed` | `{ state, usage }` | Terminal |
| `turn.failed` | `{ state, errorCode, message }` | Terminal; `message` is user-safe |
| `turn.cancelled` | `{ state }` | Terminal |
| `usage.summary` | `{ steps, toolCalls, inputTokens, outputTokens, costLabel }` | Admin-only fields omitted otherwise |
| `heartbeat` | `{ at }` | Every `limits.heartbeatSeconds` |

Ordering: every event carries a monotonic `id` (the run's event `seq`, or a synthetic sequence for
derived events). A client that reconnects sends `Last-Event-ID` and receives only later events, so a
reconnect cannot duplicate an action or lose a terminal state.

### 8.2 What the stream must never contain

Tool arguments, provider request/response bodies, system prompts, retrieved record bodies beyond a
tool's own summary, hidden reasoning, chain-of-thought, secrets, or another user's identifiers. The
runtime already hides audit-only rows (`visibility = 'user'`); Chat passes that filter through.

### 8.3 Failure and fallback

- No heartbeat for three intervals ⇒ the client reconnects with `Last-Event-ID`.
- A transport that cannot stream (proxy, adapter) falls back to polling `GET action/turns/:turnId` at
the cadence the SPA already uses for agent runs (4 s while active).
- A dropped connection never cancels a turn: the run outlives the browser connection, and `cancel` is an
explicit call.
- Cancellation is best-effort in flight and immediate when the turn is still queued or waiting; the
server reports which steps had already executed.

---

## 9. `AIAgents` integration contract

Chat consumes these and nothing else:

| Need | Call | Chat's obligation |
| --- | --- | --- |
| Start a turn | `AIAgentRunService.create(agentId, { input, idempotencyKey, conversationId })` | Send the author's identity (server-derived), a monotone idempotency key, bounded text |
| Read a turn | `AIAgentRunService.get(runId)` | Treat `outcome_unknown` as "unknown", never as success |
| Timeline | `AIAgentRunService.events(runId)` | Filter to `visibility: 'user'` for anything user-facing |
| Tool ledger | `AIAgentRunService.toolCalls(runId)` | Summaries only; arguments stay audit-only |
| Cancel | `AIAgentRunService.cancel(runId)` | Report the state the server returns |
| Approvals | `AIAgentApprovalService.{list,forRun,get,approve,reject}` | Never create a parallel proposal |
| Assistant resolution | `AIAgentDefinitionService.{list,version}` + `AIAgentsSettingsService.settings()` | Report readiness; never flip AI Agents flags |
| Usage | run `counters` | Never invent a cost; carry `costLabel` |

Explicit non-goals: Chat does not create an `AIAgents` provider connection, does not grant a tool, does
not publish an agent version and does not execute a tool itself. A capability Chat needs but AI Agents
lacks is an AI Agents phase, documented as a blocker — not a private implementation.

### 9.1 Context envelope

What Chat may send to the runtime: the user's message text (bounded by `limits.maxMessageChars`), at
most `limits.maxContextRefs` record references re-read under the caller's ACL, the conversation id, and
the idempotency key. Everything else — roles, permissions, allowed entities, locale-derived facts — is
derived server-side and never accepted from the browser.

What Chat must never add: raw record dumps, attachment bodies, email content, SQL, tool lists, system
prompts, provider settings. Those belong to the agent version and the tool registry, which an
administrator reviews before publishing.

---

## 10. Action proposals and confirmation (19-CHAT.12)

1. The agent requests a state-changing tool. Because the Chat agent version grants it with
   `requires_approval: true`, `approvalRequired()` pauses the run and writes an `ai_agent_approvals` row
   with the tool's typed preview.
2. Chat's `action.proposed` / `approval.required` events tell the SPA that a decision is needed.
3. The SPA fetches `GET action/actions/:approvalId` and renders: action label, target count, exact
   before/after values, expected side effects, approval level and expiry.
4. The user confirms or rejects. `confirm` calls `AIAgents` approve; the approval service re-reads the
   target, rechecks ACL/field rights, record state and expiry, and refuses with a stable reason if any
   has changed.
5. The tool executes through the domain service under the user's scope with the tool-call idempotency
   key; the run resumes and reports the real outcome.
6. Chat reports completed / failed / skipped / pending separately. It never claims atomicity across
   modules or external systems.

Blocked from Chat in v1 regardless of flags: destructive bulk operations, role/ACL changes, credential
management, payments, invoice issue/void, campaign sends and external messaging. Those stay in their
own protected workflows (plan §11.1).

---

## 11. Observability and audit

Chat logs ids and states, never content. The following is the minimum every delivered phase adds:

| Signal | Shape | Never |
| --- | --- | --- |
| Turn lifecycle | `turnId`, `conversationId`, `state`, `durationMs`, `steps`, `toolCalls` | Message text, answer text, prompt |
| Denial | `route`, capability key, `requestId` | The caller's role list, the resource's existence |
| Flag change | `actorId`, settings `version`, changed keys, previous values of flags only | Credentials, full settings dumps |
| Approval | `approvalId`, `runId`, `toolKey`, decision, `riskClass`, `targetCount` | Before/after values |
| Stream | connect / disconnect / resume with `Last-Event-ID`, heartbeat gaps | Event payloads |

Diagnostics live behind `GET action/health` and `GET action/capabilities` rather than a separate
admin page: the same view explains the module to a support engineer and to the SPA.

---

## 12. Phase map

What each sub-phase may add, and the boundary it must not cross. A phase that finds it needs
something outside its row is a blocker to report, not an exception to take.

| Phase | Adds | Must not add |
| --- | --- | --- |
| 19-CHAT.0 | Audit (delivered) | Code |
| 19-CHAT.1 | This contract + `docs/security/crm-chat-threat-model.md` (delivered) | Code changes |
| 19-CHAT.2 | Module descriptor, capabilities, flags, settings, assistant readiness, health, menu entry, SPA shell (delivered) | Tables, model calls, conversation routes |
| 19-CHAT.3 | `crm_chat_citations`, `crm_chat_feedback`, `crm_chat_prompts` (additive migration `062_phase19_crm_chat.sql`) — delivered | A conversation/turn table |
| 19-CHAT.4 | Conversation list/read/rename/archive/unarchive/delete with keyset message paging — delivered | A second owner-scoping mechanism; hard-deleting a conversation |
| 19-CHAT.5 | Turn submission and read, cancellation | A turn state machine beside `RunStatus` |
| 19-CHAT.6 | SSE stream + polling fallback | A WebSocket stack |
| 19-CHAT.7 | Chat workspace UI | A markdown parser or raw HTML |
| 19-CHAT.8 | Context selection, citation materialisation, re-read, label and route builder | Model-supplied URLs |
| 19-CHAT.9 | Help-article retrieval tool wiring | A Chat-owned knowledge store |
| 19-CHAT.10 | Read-tool policy, safe query plans, filter operator allowlist | A tool registry copy; raw SQL |
| 19-CHAT.11 | Curated cross-module paths over declared metadata relations | An implicit join; unbounded fan-out; a caller-supplied plan |
| 19-CHAT.12 | Approval facade and confirmation UI | A parallel proposal store; a second decision path |
| 19-CHAT.13 | Multi-step runs and approval checkpoints | A second run scheduler |
| 19-CHAT.14 | Conversation search, saved prompts, answer feedback | Shared/global templates without an admin right; a feedback loop into model behaviour |
| 19-CHAT.15 | Administration, feature flags and guardrails | A second settings store |
| 19-CHAT.16 | Privacy, security and audit hardening | Logging content |
| 19-CHAT.17 | Usage, limits and observability | A locally computed price; a Chat-owned usage counter |
| 19-CHAT.18 | Evaluation and end-to-end verification | A production model call in a test |
| 19-CHAT.19 | Release readiness and operational handover | — |

---

## 13. Acceptance and test plan

CHAT.2 — the implemented slice — is accepted when all of the following hold. They are asserted in
`apps/api/test/crm-chat.test.ts` against the configured primary database:

1. A caller without `CRMChatConversation:read` receives `403 AUTHORIZATION_DENIED` from
   `GET action/capabilities` and never sees `/crm-chat` in `GET /api/v1/Navigation`.
2. A caller with the right receives the capability matrix, the feature list with `enabled` *and*
   `effective`, the limits, the assistant readiness state and an `actions` block that agrees with the
   server-side gates.
3. `GET action/settings` and `POST action/settings` require `admin`; the workspace right alone is not
   enough, and a refused patch changes nothing.
4. A malformed patch (unknown key, wrong type, out-of-range value) is `400 INVALID_QUERY` and leaves the
   stored settings untouched.
5. Disabling `features.workspace` removes the menu entry on the next render **and** makes
   `GET action/health` return `403 FEATURE_DISABLED`; `action/capabilities` keeps answering so the shell
   can explain the state; `action/settings` keeps answering so an administrator can re-enable it.
6. `GET action/health` reports dependency evidence read from the running system (not hard-coded), the
   module's `dependsOn`, its `implementedPhases`, an empty `structures` list, and honest assistant
   readiness.
7. The catalogs in `i18n/{en,vi}/web.json` satisfy the loader's key convention, so the module's strings
   actually resolve.

19-CHAT.3 — accepted when the migration is versioned, additive and reviewed before it was applied, and
when the idempotency guarantee is the existing `uq_ai_agent_runs_idempotency` index rather than a
Chat-side dedupe cache. Verified: `062_phase19_crm_chat.sql` creates three tables with their checks,
unique keys and cascading foreign keys, changes no existing table, and no new database was created.

19-CHAT.4 — accepted when two users cannot read or mutate each other's private conversations, message
history is paginated and stable under concurrent inserts, and repeated submissions with one idempotency
key cannot produce two turns. Asserted in `apps/api/test/crm-chat-conversations.test.ts`:

1. A caller sees only their own threads; `status=all` does not widen that.
2. Another user's conversation id is `404` on read, rename, archived-read and delete — never `403`.
3. `PATCH` trims and bounds the title, round-trips `archived`/`active`, and refuses an empty title.
4. `DELETE` marks the row deleted, hides it from its owner immediately, and does **not** remove it from
the database (the sweep owns that).
5. `before`-cursor paging returns every message exactly once, newest page first, with `hasMore` correct.
6. Out-of-range `maxSize`, unknown query keys and a malformed body are `400 INVALID_QUERY`.
7. A caller without `manage`/`delete` is refused on the mutating routes.

19-CHAT.8 — accepted when a citation is never taken from the model. The runtime records a
`result_ref` for every tool call that resolved a record; Chat re-reads that record under the
caller's ACL and only then builds the label and the route. Asserted in
`apps/api/test/crm-chat.test.ts` and `apps/api/test/crm-chat-conversations.test.ts`:

1. A message whose records the caller may read returns citations with a server-built label and route.
2. A record the caller may no longer read produces **no** citation — not a stale label, and not a
   "forbidden" marker that would disclose that the record exists.
3. The stored citation row carries the `rechecked_at` stamp that says when the check happened.

19-CHAT.6 — accepted when the stream carries the run's real timeline. The translator maps the
`AIAgents` event types (`run.queued`, `run.started`, `tool.proposed`, `tool.succeeded`/`failed`/`denied`/
`outcome_unknown`, `approval.requested`, `model.completed`, `run.completed`, `run.failed`,
`run.canceled`) onto the Chat vocabulary, and derives `assistant.message` and `usage.summary` from
the run and its provider ledger. An event with no user-safe translation is dropped rather than
passed through, because the raw timeline carries audit-level detail.

19-CHAT.11 — accepted when a cross-module path is server-owned. The caller names a curated scenario
and a root record; the entity, the relations and the bounds are fixed by the server. Asserted in
`apps/api/test/crm-chat-engagement.test.ts`:

1. The scenario list is served and every entry names a root entity.
2. An unknown scenario is `404`.
3. A root record that does not exist is `404`, not an empty analysis that would read like "this
   account has nothing".
4. A hop that cannot be answered produces a **partial** result with a per-step reason and never
   exposes the underlying query's failure detail.

19-CHAT.12 — accepted when the proposal façade decides nothing itself. Asserted in
`apps/api/test/crm-chat-engagement.test.ts`:

1. The caller sees their own proposal with its action class, risk level and expiry.
2. Another user's proposal and an id that never existed both answer `404` — an id cannot be probed.
3. A decision is recorded with its note, and a decided proposal is no longer actionable.
4. The runtime still refuses a decision whose run has already ended; Chat does not bypass that.

19-CHAT.14 — accepted when the engagement surfaces are owner-scoped and inert. Asserted in
`apps/api/test/crm-chat-engagement.test.ts` and `apps/api/test/crm-chat-security.test.ts`:

1. A template is created, listed, changed and removed by its owner; another user's copy is `404`.
2. An empty name is refused, and a second template with the same name is refused by the owner.
3. The stored template is returned verbatim — the server never interprets, expands or compiles it.
4. A rating is recorded once per user per answer; a second submission updates it rather than adding
   a second vote, and a rating the database would reject is a `400`.
5. A rating of a turn that has no answer, or of a turn in another user's thread, is `404`.
6. A history search returns only the caller's own threads, by title or by message body, and a term
   that matches nothing is an empty list rather than the whole history.

19-CHAT.17 — accepted when usage is read, never recomputed. The counters come from the AIAgents run
and the cost from its provider ledger, and `costLabel` keeps AIAgents' meaning: `estimate` when the
cost came from a pricing snapshot, `none` when the deployment has no price data and the total is an
exact `0` rather than a guess.

Later phases add their own scenario to this list; the threat model's §4 is the traceability map from
the plan's security scenarios to the phase that tests them.

---

## 14. Security cross-reference

`docs/security/crm-chat-threat-model.md` owns the trust-boundary analysis: who may call what, what the
model may influence, why prompt injection cannot become an unconfirmed write, and which controls are
still missing because their phase has not landed. This contract states the shapes; the threat model
states the reasons they are safe.

---

## 15. Change log

| Version | Phase | Change |
| --- | --- | --- |
| `1.0.0` | 19-CHAT.1 | First contract: decisions D1–D12, actors, lifecycle, capability model, route surface, data shapes, stream and `AIAgents` contracts. |
| `1.0.0` | 19-CHAT.2 | Foundation routes marked implemented; turn submission fixed at `POST action/turns` to match D2. Contract constants exported from `apps/api/src/crm-chat/crm-chat-contract.ts` and pinned by `apps/api/test/crm-chat-contract.test.ts`. |
| `1.1.0` | 19-CHAT.3 | Three module tables added (citations, feedback, saved prompts). Additive migration only; no existing table altered and no conversation table created. |
| `1.1.0` | 19-CHAT.4 | Conversation and message routes marked implemented; keyset pagination and the "delete is a marker" rule fixed; unarchive offered (reversing the plan's default). |
| `1.2.0` | 19-CHAT.8 | Citations materialized from an ACL re-read of the runtime's `result_ref` list, and returned with each message. |
| `1.2.0` | 19-CHAT.11 | Curated cross-module scenarios added (`action/cross-module/scenarios`, `action/cross-module/analyze`); partial results and a freshness stamp are part of the answer. |
| `1.2.0` | 19-CHAT.12 | Action proposal routes marked implemented: a thin façade over `AIAgents` approvals that adds the `actionProposals` / `safety.allowWrites` product gate. |
| `1.2.0` | 19-CHAT.14 | Saved prompt templates, answer feedback and conversation search marked implemented; the turn body field is documented as `prompt` / `contextRefs`, which is what the implementation and the SPA already send. |
| `1.2.0` | 19-CHAT.17 | Per-turn usage read-out added (`action/turns/:turnId/usage`). |

---

## 16. Appendix A — supported intents

A turn is a **question about CRM data or help content**, optionally ending in a confirmed proposal. This
is the closed list for v1; anything outside it is refused by the agent's instructions and, where it
would need a capability, by the absence of a tool.

| Intent | Example | Enabled by | Grounding |
| --- | --- | --- | --- |
| Help retrieval | "How do I create a workflow?" | `features.helpRetrieval` | Published knowledge articles (19-CHAT.9) |
| CRM search | "Accounts in Hanoi with no activity this month" | `features.readTools` | Entity Engine list permission + plan |
| Record summary | "Summarise this account and its open cases" | `features.readTools` | One record read under the caller's field rights |
| Aggregates | "How many leads per source this quarter?" | `features.readTools` | Bounded aggregate over an allowlisted entity |
| Cross-module analysis | "Which accounts have overdue invoices and open tickets?" | `features.readTools` | Several allowlisted reads, each within scope |
| Conversation search | "What did we decide about the Q3 pricing?" | `features.conversationSearch` | The caller's own threads (19-CHAT.14) |
| Action proposal | "Create a follow-up task for tomorrow" | `features.actionProposals` + `safety.allowWrites` | A typed proposal the user confirms (19-CHAT.12) |
| Multi-step workflow | "Draft a reply and a task, then show me both" | `features.actionProposals` | Bounded steps, one approval per write (19-CHAT.13) |

**Not intents, in any configuration:** writing without confirmation, bulk/destructive operations,
permission or role changes, credential handling, payments, invoice issue/void, campaign sends, external
messaging, code execution, arbitrary HTTP calls, SQL, filesystem access, and "just tell me what the
other user said" (cross-owner reads). An intent that would need one of those is answered with a refusal
that names the protected workflow to use instead — it is not answered by improvising.

Every intent inherits the caller's own scope. There is no "chat scope": if the caller cannot open the
record in the UI, Chat cannot read it either.
