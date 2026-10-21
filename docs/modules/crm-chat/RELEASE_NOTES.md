# CRM Chat Module — Release Notes v1.1

**Release Date:** 2026-10-21
**Module:** CRMChat (`crm-chat`)
**Version:** 1.1.0
**Contract Version:** 1.2.0

---

## v1.1.0 — Phase completion (2026-10-21)

This release closes the gaps found when the module was reviewed against
`PLAN_Phase_19_CRM_Chat.md`. The v1.0.0 notes claimed every phase through 19-CHAT.18 was
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

## Implemented Phases (19-CHAT.0 through 19-CHAT.19)

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

- **Repository total:** 145 test files, 1983 tests, all passing (`pnpm test`).
- **CRMChat suites:** 7 files, 92 tests, all passing.

| Suite | Covers |
| --- | --- |
| `crm-chat.test.ts` | Module registration, capabilities, settings, health, navigation |
| `crm-chat-security.test.ts` | Cross-user isolation, injection, citation safety, rate limiting, template privacy |
| `crm-chat-conversations.test.ts` | Ownership, keyset paging, lifecycle, history search |
| `crm-chat-contract.test.ts` | The prose contract and the served routes agree |
| `crm-chat-ai-agents-integration.test.ts` | Turn submission, idempotency, the AIAgents boundary |
| `crm-chat-evaluation.test.ts` | Language support and input validation |
| `crm-chat-engagement.test.ts` | Templates, feedback, proposals, cross-module paths, usage |

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
