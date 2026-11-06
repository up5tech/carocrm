# CRM Chat Module — Release Notes v1.3

**Release Date:** 2026-11-05
**Module:** CRMChat (`crm-chat`)
**Version:** 1.3.0
**Contract Version:** 1.2.0 (unchanged)

---

## v1.3.0 — Domain tools for the assistant (P1) (2026-11-05)

Four read-only tools, contributed by the module that owns the service (the 19-CHAT.23 pattern),
plus one kernel tool. No migration, no contract change, no route change.

| Tool | Owner | Answers |
| --- | --- | --- |
| `crm_project_status` | `Projects` | One project's status: record, task counts by status, overdue and unassigned, milestones. Counts cover only what the caller may read. |
| `crm_commercial_summary` | `Sales` | One account's commercial position: open issued receivables by currency, oldest unsettled due date, unapplied credit, confirmed payments, active subscriptions. Money stays in its own currency; nothing is re-rated. |
| `crm_campaign_performance` | `MarketingAutomation` | One campaign's delivery/engagement counts and distinct recipients, through the campaign readability gate. It cannot send, schedule or change anything. |
| `crm_list_emails` | `AIAgents` (kernel) | Email **metadata** only (subject, status, direction, addresses, date, parent link) — bodies and headers never cross the tool boundary. |

**`MAX_TOOLS` 20 → 24** (`ai-agent-config.ts`) — one assistant can again hold the entire Chat-facing
catalogue. The registry holds **25** entries including `omnichannel.send_message`.

**Verification**
- `apps/api/test/ai-domain-tools.test.ts` — new, 5 cases: catalogue/ownership, happy paths for all
  four tools, metadata-only assertion for emails, and a denial case per tool for a caller with no
  rights.
- `apps/api/test/crm-chat-evaluation.test.ts` — 62 → **70** cases (4 tools × vi/en).
- `apps/api/test/ai-agent-runs.test.ts` — catalogue table now asserts all 25 entries.

**Not in this release:** event/schedule triggers (the other half of 19-AI.17) remain unimplemented;
no Sales or Marketing write path was added; forecast/pipeline prediction still does not exist.

---

## v1.2.0 — AI CRM tool catalogue v2 (2026-11-02 → 2026-11-03)

Five sub-phases, 19-CHAT.20 → 19-CHAT.24, delivered the second AI CRM slice: the assistant can now
answer the questions the workspace advertises, and the workspace only advertises what it can answer.

**The catalogue went from 8 tools to 20.** Twelve new entries, in three batches:

| Phase | Added | Count |
| --- | --- | --- |
| 19-CHAT.21 | `crm_actor_context`, `crm_aggregate`, `crm_list_activities` (+ `crm_cross_module` moved into the registry) | 8 → 12 |
| 19-CHAT.22 | `crm_post_note`, `crm_log_activity`, `crm_draft_email`, `crm_create_task` **v2**, `crm_update_record_fields` **v2** | 12 → 15 |
| 19-CHAT.23 | `crm_lead_score`, `crm_customer_health`, `crm_case_context`, `crm_stale_records`, `crm_run_report` | 15 → 20 |

The 20 keys, their effect class, approval requirement and entity scopes are asserted as one table in
`apps/api/test/ai-agent-runs.test.ts`. `omnichannel.send_message` also lives in the registry and is in
that table — 21 entries in total, 20 of them Chat-facing.

### Two version bumps

* **CRMChat module `1.1.0` → `1.2.0`**, and `implementedPhases` now lists `19-CHAT.20` … `19-CHAT.24`.
* **Two tools went `v1` → `v2`**: `crm_create_task` (now attaches to the record it is about and defaults
  its assignee to the acting user) and `crm_update_record_fields` (wider field allowlist, same
  `material_write` class, same approval gate, same version check).

The **contract version stays `1.2.0`**: no path, request shape, response shape, stream event or error
code changed. Every new tool sits behind the existing turn surface, and Chat still neither grants nor
executes a tool.

### What a user sees

* The empty state offers up to eight suggested questions. Each one declares the tool that has to be in
  the answering agent's grants to be answerable, and a question whose tool the agent lacks is not
  rendered. Nothing new is read from the server to make that decision — `capabilities.assistant.tools`
  already carried it and only the diagnostics drawer used it.
* Relative dates ("this quarter") resolve on the server, in the acting user's time zone, and the resolved
  range is returned with the number, so an answer can name the window it counted.
* Numbers come from aggregate queries, not from the model adding up a page of records.
* A note, a logged call, a draft email or a task created by the assistant appears on the timeline of the
  record it is about, attributed to the person who asked.
* Nothing the assistant can now do sends an email. `crm_draft_email` produces a `Draft`; sending stays a
  human action on the record.

### Rollback, per phase

No migration was introduced by any of the five phases, so every rollback is configuration:

| Phase | Rollback |
| --- | --- |
| 19-CHAT.20 — actor in the system prompt | Pass `undefined` for the third `systemPrompt` argument; the prompt is byte-for-byte the previous string. |
| 19-CHAT.21 — read family | `settings.tools.disabled: ["crm_aggregate", "crm_list_activities", "crm_actor_context", "crm_cross_module"]`. |
| 19-CHAT.22 — write family | `settings.tools.disabled` for the five write keys, or `safety.allowWrites: false` in Chat settings to stop every mutation at the product gate. |
| 19-CHAT.23 — module intelligence | Disable the owning module's own switch (`LeadScore`, `CustomerSuccess`, `ServiceDesk`) or the four tool keys; Chat then says the capability is unavailable instead of failing the turn. |
| 19-CHAT.24 — suggestions | The chips are static data; hiding them needs no server change. Restoring the pre-24 behaviour means reverting `apps/web/src/pages/crm-chat/CRMChatSuggestions.tsx`. |

Disabling a tool through `AIAgents` settings removes it from what the agent can execute. The suggestion
filter reads the agent's **grants**, so a deployment that wants a question to stop being advertised should
remove the grant (or republish the assistant without the tool) — the rule is written into
`docs/architecture/crm-chat-contract.md` §7.5.

### Behaviour change — `crmChat.features.readTools` is now enforced (G38)

`POST action/turns` and `POST action/query/execute` refuse with `403 FEATURE_DISABLED` while the flag is
off. The route table always said they required it; the turn path only consulted assistant readiness, so an
administrator who switched "Grounded CRM answers" off still received answers built from live CRM records —
a compliance answer that was not true. `actions.canStartTurn` now reports the same rule, so the composer
cannot offer a send the server would refuse.

**Action required by an operator who wants chat to keep answering:** switch
`crmChat.features.readTools` on (Settings → CRM Chat, or `POST /api/v1/CRMChat/action/settings` with
`{"features":{"readTools":true}}`). Handbook-only installations need it too: a help answer travels the
same turn route.

Rollback is code, not configuration — the enforcement is one `assertFeature` per route in
`apps/api/src/crm-chat/crm-chat.controller.ts`.

### Visibility fix — a turn no longer names records the reader has lost (G39)

`GET action/turns/:turnId` returns the run's `result.sources` — the `Entity:id` references its successful
tool calls recorded at answer time. Those were replayed as stored, so a record the reader could open when
the answer was written but has since lost kept appearing in the turn. The field now goes through the same
ACL re-read the citations already use, so one rule covers both surfaces. The response shape is unchanged;
the array can be shorter, and the answer text is not rewritten.

### Verification

* `apps/api/test/crm-chat-evaluation.test.ts` — 62 cases: the 19-CHAT.17 set plus **one case per tool, in
  Vietnamese and in English**, each submitted through `POST action/turns` and checked against the tool
  call the runtime recorded. The set is grouped across three assistants (a test-local choice — see
  `TOOLS_PER_ASSISTANT`), and points Chat at the group that can answer the question being asked. Removing
  any tool from `AIToolRegistry` makes publishing fail, which turns the whole block red — verified by
  unregistering `crm_stale_records` and watching it.
* `apps/web/src/pages/crm-chat/CRMChatSuggestions.test.tsx` — a chip whose tool the agent lacks is not in
  the rendered markup; the catalog carries every chip phrase in both locales.
* `pnpm lint:arch`, `pnpm lint:ui`, `pnpm typecheck`, `pnpm test:web` and the Chat suites: see §17 of
  `plans/PLAN_Phase_19_CRM_Chat.md` for the per-phase evidence.

---

## v1.1.0 — Phase completion (2026-10-21)

This release closes the gaps found when the module was reviewed against
`plans/PLAN_Phase_19_CRM_Chat.md`. The v1.0.0 notes claimed every phase through 19-CHAT.18 was
implemented; the review showed that several were declared but not built, and that the build itself
did not compile. This release makes the claim true.

### What was wrong, and what changed

| Area | Finding | Fix |
| --- | --- | --- |
| Build | `pnpm typecheck` failed: four services had type errors and none was registered as a provider, so they were dead code. | Rewrote or repaired all four; registered them in `CRM_CHAT_PROVIDERS`. |
| Streaming | The SSE translator mapped event names the `AIAgents` runtime never emits (`run.started`, `assistant.response`, `citation.added`, `action.proposed`, `approval.required`, `usage.summary`, `run.succeeded`). The stream therefore delivered only a synthetic start and heartbeats — no tool events, no answer, no approval, no usage. | The translator now maps the **real** run timeline (`run.queued`, `tool.proposed`, `tool.succeeded/failed/denied/outcome_unknown`, `approval.requested`, `model.completed`, `run.completed`, `run.failed`, `run.canceled`) onto the Chat vocabulary, and derives `assistant.message` and `usage.summary` from the run and its provider ledger. |
| Citations | `crm_chat_citations` was never written or read; every message carried `citations: []`. | Added `CRMChatCitationService`: the runtime's `result_ref` list is re-read under the caller's ACL and only then labelled, routed and stored. A record the caller may no longer read yields **no** citation. |
| Query safety | `buildSafeWhere` silently dropped filters it did not recognise — dropping a *restrictive* filter widens the result set. The service also used `any` and swallowed every error into an empty result. | Filters are now translated into the Query Engine's criterion form, an unsupported operator is a `400` rather than a silent drop, `any` is gone, and a malformed plan is a client error rather than an empty answer. |
| Cross-module | The service was registered but unreachable, and it leaked the underlying error message into the response. | Rewritten as **curated, server-owned scenarios** over declared metadata relations, with per-step partial results, bounded fan-out and sanitised failure reasons. |
| Action proposals | The façade was unreachable and typed the approval as `any`. | Rewritten as a thin, typed façade over `AIAgentApprovalService`: it resolves ownership itself (another user's proposal is `404`, not `403`) and delegates the revalidation to the runtime, which is the only place that may decide. |
| Feedback, prompts, search | `POST action/turns/:turnId/feedback`, the four `action/prompts` routes and the `q` search parameter were **specified in the contract but had no implementation**. | All delivered, with owner-scoped SQL, one rating per user per answer, and templates stored as inert data. |
| Tests | Four suites passed `roles:` to a helper that expects `roleIds:`, so the test users were granted **no roles** and every Chat route answered `403`. The suites had been asserting against a gate, not against the feature. | Fixed the calls. The suites now exercise the real permissions and pass. |
| Contract | The prose contract and `crm-chat-contract.ts` disagreed on the turn body (`message`/`context` versus the implemented `prompt`/`contextRefs`). | The contract now documents the implemented names and records the change in its change log; the version is bumped to 1.2.0. |

### Verification

- `pnpm typecheck` — clean.
- `pnpm lint` — clean.
- `pnpm test` — **145 files, 1983 tests, all passing**, including 7 CRMChat suites (92 tests) and a new
  `crm-chat-engagement.test.ts` covering the delivered routes.

### New API endpoints

```text
GET    /api/v1/CRMChat/action/prompts                      # the caller's own templates
POST   /api/v1/CRMChat/action/prompts                      # create a template (data only)
PATCH  /api/v1/CRMChat/action/prompts/:id                  # rename, edit, enable/disable
DELETE /api/v1/CRMChat/action/prompts/:id                  # remove
POST   /api/v1/CRMChat/action/turns/:turnId/feedback       # rate the answer a turn produced
GET    /api/v1/CRMChat/action/actions/:approvalId          # the authorized projection of a proposal
POST   /api/v1/CRMChat/action/actions/:approvalId/confirm  # confirm (needs actionProposals + allowWrites)
POST   /api/v1/CRMChat/action/actions/:approvalId/reject   # reject
GET    /api/v1/CRMChat/action/cross-module/scenarios       # the curated paths
POST   /api/v1/CRMChat/action/cross-module/analyze         # run one path against a record
GET    /api/v1/CRMChat/action/turns/:turnId/usage          # the turn's usage
```

`GET /api/v1/CRMChat/action/conversations` now accepts `q` for a user-scoped history search.

### Behaviour worth knowing before you upgrade

- `features.conversationSearch` and `features.feedback` ship **off**. The search box and the rating
  buttons appear only when the flag is effective, and the server refuses the request with
  `FEATURE_DISABLED` otherwise.
- A saved template is inert text. It is inserted into the composer and submitted like any other
  message, under the submitter's own authorisation. It can never select a tool, an entity, a role
  or a permission.
- A rating is an auditable fact and changes nothing: no model behaviour, no tool selection, no
  permission.

---

## Overview

CRM Chat is a first-class conversational assistant for the CaroCRM platform, enabling authorized users to ask questions, explore data, and get help through natural language interaction. The module delegates all LLM orchestration to the existing `AIAgents` runtime, ensuring no duplicate planning loops or tool executors.

---

## Implemented Phases (19-CHAT.0 through 19-CHAT.24)

### Core Infrastructure (19-CHAT.0 – 19-CHAT.4)
- ✅ Repository audit and capability inventory
- ✅ Product contract and threat model documented
- ✅ Module registration with feature flags and navigation
- ✅ Additive persistence (citations, feedback, prompts tables)
- ✅ Conversation and message APIs with pagination

### AI Integration (19-CHAT.5 – 19-CHAT.6)
- ✅ AIAgents integration adapter (narrow contract, no duplicate engine)
- ✅ Turn submission, status retrieval, and cancellation
- ✅ SSE streaming with heartbeat and reconnection support
- ✅ Event translation from AIAgents run events to user-safe Chat events

### User Experience (19-CHAT.7)
- ✅ React workspace with conversation sidebar
- ✅ Message thread with safe plain-text rendering
- ✅ Composer with character limits and keyboard shortcuts
- ✅ Streaming status display and stop generation control
- ✅ Responsive layout and accessibility support

### Data Access & Safety (19-CHAT.8 – 19-CHAT.10)
- ✅ Context selection with validated entity/ID formats
- ✅ Citation reauthorization before rendering
- ✅ Help retrieval from Knowledge Base articles
- ✅ Read-only query execution with ACL enforcement
- ✅ Safe query plans (no raw SQL, bounded results)

### Advanced Features (19-CHAT.11 – 19-CHAT.14)
- ✅ Cross-module analysis via correlated sub-queries
- ✅ Action proposal foundation (reuses AIAgents approvals)
- ✅ Administration settings with guardrails
- ✅ Conversation search (user-scoped only)
- ✅ Prompt templates (data-only, no executable permissions)
- ✅ Feedback collection (auditable, inert)

### Security & Operations (19-CHAT.15 – 19-CHAT.18)
- ✅ Security hardening and injection prevention
- ✅ Usage tracking and observability with safe logging
- ✅ Comprehensive evaluation suite (77 tests)
- ✅ Release readiness verification

### AI CRM tool catalogue v2 (19-CHAT.20 – 19-CHAT.24)
- ✅ Acting user named in the agent system prompt
- ✅ Read family: actor context, aggregates, activities, cross-module analysis
- ✅ Write loop: note, logged call/meeting, email draft, task with a parent, approved field update
- ✅ Module intelligence: lead score, customer health, case context, silent records, saved reports
- ✅ Tool-aware suggestions, one evaluation case per tool, the full 20-key catalogue assertion

---

## API Endpoints

### Conversations
- `GET /api/v1/CRMChat/action/conversations` — List user's conversations
- `GET /api/v1/CRMChat/action/conversations/:id` — Get conversation detail
- `GET /api/v1/CRMChat/action/conversations/:id/messages` — Paginated message history
- `PATCH /api/v1/CRMChat/action/conversations/:id` — Rename/archive conversation
- `DELETE /api/v1/CRMChat/action/conversations/:id` — Soft-delete conversation

### Turns
- `POST /api/v1/CRMChat/action/turns` — Submit a user message
- `GET /api/v1/CRMChat/action/turns/:turnId` — Get turn status
- `POST /api/v1/CRMChat/action/turns/:turnId/cancel` — Cancel running turn
- `GET /api/v1/CRMChat/action/turns/:turnId/events` — SSE event stream

### Queries
- `POST /api/v1/CRMChat/action/query/execute` — Execute read-only query
- `GET /api/v1/CRMChat/action/help/search?q=query` — Search help articles

### Engagement (v1.1.0)
- `GET /api/v1/CRMChat/action/prompts` — The caller's own saved templates
- `POST /api/v1/CRMChat/action/prompts` — Create a template (data only)
- `PATCH /api/v1/CRMChat/action/prompts/:id` — Rename, edit, enable/disable a template
- `DELETE /api/v1/CRMChat/action/prompts/:id` — Remove a template
- `POST /api/v1/CRMChat/action/turns/:turnId/feedback` — Rate the answer a turn produced
- `GET /api/v1/CRMChat/action/actions/:approvalId` — The authorized projection of a proposal
- `POST /api/v1/CRMChat/action/actions/:approvalId/confirm` — Confirm a proposal
- `POST /api/v1/CRMChat/action/actions/:approvalId/reject` — Reject a proposal
- `GET /api/v1/CRMChat/action/cross-module/scenarios` — The curated cross-module paths
- `POST /api/v1/CRMChat/action/cross-module/analyze` — Run one path against a record
- `GET /api/v1/CRMChat/action/turns/:turnId/usage` — The usage of one turn

### Citations & Admin
- `POST /api/v1/CRMChat/action/citations/reauthorize` — Reauthorize citations
- `GET /api/v1/CRMChat/action/settings` — Read admin settings
- `POST /api/v1/CRMChat/action/settings` — Update admin settings
- `GET /api/v1/CRMChat/action/capabilities` — Get user capabilities
- `GET /api/v1/CRMChat/action/health` — Module diagnostics

---

## Configuration

### Feature Flags (default values)
```json
{
  "features": {
    "workspace": true,
    "readTools": false,
    "helpRetrieval": false,
    "actionProposals": false,
    "feedback": false,
    "conversationSearch": false
  }
}
```

### Limits (configurable)
```json
{
  "limits": {
    "maxMessageChars": 8000,
    "maxContextRefs": 5,
    "maxActiveTurnsPerUser": 1,
    "maxConversationsPerUser": 200,
    "turnTimeoutSeconds": 180,
    "heartbeatSeconds": 15,
    "maxConcurrentQueries": 3,
    "maxTurnsPerMinute": 10,
    "maxQueryResults": 100
  }
}
```

### Retention
```json
{
  "retention": {
    "conversationsDays": 30
  }
}
```

### Safety
```json
{
  "safety": {
    "allowWrites": false
  }
}
```

---

## Security Guarantees

### Authorization
- All endpoints enforce server-side ACL
- Conversations are private to owner by default
- No cross-user data leakage possible
- Workspace policy gate on all operations

### Input Validation
- Entity names validated against regex pattern
- Query plans validated before execution
- Prompt length limits enforced
- SQL-like patterns filtered from filters

### Data Safety
- No raw SQL execution ever
- No shell command execution
- No unrestricted HTTP requests
- Credentials never logged or exposed

### Prompt Injection Mitigation
- Retrieved content treated as untrusted data
- Model cannot follow instructions in retrieved docs
- Tool authorization enforced outside LLM
- No system prompt exposure possible

---

## Operational Runbooks

### Emergency Disable
To disable Chat immediately without database changes:
```bash
# Via API (admin required)
POST /api/v1/CRMChat/action/settings
{
  "features": {
    "workspace": false
  }
}
```

### Disable Specific Feature
```bash
POST /api/v1/CRMChat/action/settings
{
  "features": {
    "readTools": false,
    "actionProposals": false
  }
}
```

### Check Module Health
```bash
GET /api/v1/CRMChat/action/health
```

### View Current Settings
```bash
GET /api/v1/CRMChat/action/settings  # admin required
```

### Monitor Usage
Usage metrics are logged with correlation IDs. Check application logs for:
- `component: crm-chat`
- `eventType: turn|query|usage|security|error`

---

## Troubleshooting

### Chat Workspace Not Loading
1. Check `GET /api/v1/CRMChat/action/capabilities`
2. Verify user has `CRMChatConversation: read` permission
3. Check `workspace.enabled` in capabilities response
4. If disabled, admin must enable via settings

### Assistant Not Ready
1. Check `capabilities.assistant.state`
2. Common states:
   - `not-configured`: Admin must set `assistant.agentKey`
   - `not-published`: Referenced agent must be published
   - `execution-disabled`: Enable `aiAgents.features.execution`
   - `memory-disabled`: Enable `aiAgents.features.memory`

### Turn Submission Fails
1. Verify assistant is ready (see above)
2. Check prompt length ≤ `limits.maxMessageChars`
3. Verify workspace is enabled
4. Check rate limits not exceeded

### Query Returns Empty Results
1. Verify entity name is valid
2. Check user has read permission on entity
3. Verify filters don't contain invalid patterns
4. Check query limits not exceeded

### Citations Show as Inaccessible
1. Permissions may have changed since turn was created
2. Record may have been deleted
3. This is expected behavior - citations are reauthorized at render time

### A Route Answers 403 FEATURE_DISABLED
1. `features.conversationSearch` and `features.feedback` ship **off**; a search or a rating is
   refused until the flag is enabled
2. `features.actionProposals` must also be on, together with `safety.allowWrites`, before a write
   can be confirmed
3. The UI shows the control only once the flag is *effective*, so a visible control always works

### A Template, Proposal, Turn or Conversation Answers 404
1. The record does not exist, **or** it belongs to another user
2. The two are deliberately indistinguishable, so an id cannot be probed for existence
3. Check the owner before assuming the record is missing

### Confirming a Proposal Answers 422
1. The run finished while the proposal was waiting — the runtime refuses a stale proposal
2. `PUT` the decision in a fresh turn instead of retrying the expired one

### The Cross-Module Answer Is Partial
1. A relation is not declared in this installation, or the caller may not read the target
2. The per-step reason names the step; the rest of the answer is still returned
3. A partial answer is never a zero that reads like "there is nothing"

### Safe Failure Behaviour
- A failed sub-query in a cross-module path yields a **partial** answer.
- A record the caller may no longer read yields **no** citation, never a "forbidden" marker that
  would disclose that the record exists.
- A proposal whose target no longer passes revalidation is refused by the runtime; Chat does not
  bypass it.
- A rating the database would reject is refused with a `400` before it is written.

---

## Known Limitations

1. **No Markdown Rendering**: Assistant text renders as plain text (v1 decision)
2. **No Cross-User Sharing**: Conversations are private only (future feature)
3. **No Real-time Collaboration**: Single user per conversation
4. **Help Search Limited to Knowledge Base**: No general web search
5. **Action Proposals Require AIAgents Integration**: Full workflow needs AIAgents approval system setup
6. **The Assistant Must Be Configured**: The workspace shell, the history and the templates work
   without a model, but no answer can be produced until an administrator publishes an answering
   agent, sets `assistant.agentKey`, and enables `AIAgents.features.execution`.
7. **Cross-Module Paths Are Curated**: The server owns the scenarios. A user cannot define a
   cross-entity query; adding one is a code change, not a setting.
8. **The Stream Polls**: The SSE endpoint reads the run timeline once a second rather than being
   pushed to by the worker. The events and their ordering are correct; the latency is up to a
   second.
9. **Feature Flags Ship Off**: `readTools`, `helpRetrieval`, `actionProposals`, `feedback` and
   `conversationSearch` are off by default, so a fresh deployment shows the workspace but cannot
   answer until they are enabled.

---

## Dependencies

### Required Modules
- `AIAgents` — Agent runtime, tool execution, approvals
- Entity Engine — Metadata-driven entity access
- ACL Service — Record and field-level authorization

### Database Tables (owned by CRMChat)
- `crm_chat_citations`
- `crm_chat_feedback`
- `crm_chat_prompts`

### Database Tables (used from AIAgents)
- `ai_agent_conversations`
- `ai_agent_messages`
- `ai_agent_runs`
- `ai_agent_run_events`
- `ai_agent_approvals`

---

## Test Coverage

- **Repository total:** 221 API test files (as of 2026-11-05).
- **CRMChat suites:** 10 files, 159 tests, all passing (`pnpm test`), verified 2026-11-05.
- **`ai-domain-tools.test.ts` (P1, 2026-11-05):** 5 cases — registry/ownership of the four domain tools,
  happy paths, metadata-only emails, and a denial case per tool for a caller with no rights.

| Suite | Covers |
| --- | --- |
| `crm-chat.test.ts` | Module registration, capabilities, settings, health, navigation |
| `crm-chat-security.test.ts` | Cross-user isolation, injection, citation safety, rate limiting, template privacy |
| `crm-chat-conversations.test.ts` | Ownership, keyset paging, lifecycle, history search |
| `crm-chat-contract.test.ts` | The prose contract and the served routes agree |
| `crm-chat-ai-agents-integration.test.ts` | Turn submission, idempotency, the AIAgents boundary |
| `crm-chat-evaluation.test.ts` | Language support and input validation |
| `crm-chat-engagement.test.ts` | Templates, feedback, proposals, cross-module paths, usage |
| `crm-chat-docs-help.test.ts` | Help retrieval over the handbook/knowledge articles |
| `crm-chat-inline-execution.test.ts` | Inline execution path safety |
| `crm-chat-intelligence-tools.test.ts` | Module intelligence tools (19-CHAT.23) |

The suites run against the configured primary database. Each writes only rows carrying an
`AGENT_TEST_` marker and removes exactly those rows by id; nothing is truncated or reset, no test
database is created, and no provider is called.

---

## Upgrade Path

### From v1.0.0
No migration is required: v1.1.0 adds no table and alters no column. The three Chat tables were
created by the additive migration `062_phase19_crm_chat.sql`, which v1.0.0 already required.

### Rollback Procedure
If issues arise, roll back **without touching the database**:

1. Disable the workspace (admin required, no data change):
   ```http
   POST /api/v1/CRMChat/action/settings
   { "features": { "workspace": false } }
   ```
   The navigation entry disappears on the next render and the routes answer `FEATURE_DISABLED`.
2. To narrow the blast radius instead of turning Chat off, disable the specific feature:
   `{ "features": { "readTools": false, "actionProposals": false } }`.
3. To stop writes specifically, set `{ "safety": { "allowWrites": false } }`. Confirming a proposal
   then fails while the rest of Chat keeps working.

**Dropping the Chat-owned tables is not a rollback step.** `crm_chat_citations`,
`crm_chat_feedback` and `crm_chat_prompts` hold ratings and saved templates that cannot be
recreated from anywhere else. If the tables must go, take a backup first, and treat it as a data
decision rather than an operational one.

---

## Support

For issues or questions:
1. Check troubleshooting section above
2. Review module health: `GET /api/v1/CRMChat/action/health`
3. Check application logs for `component: crm-chat` entries
4. Contact platform team with correlation ID from failed requests
