# CRM Chat — first-run runbook (fresh install to a working assistant)

> Phase 19-CHAT.0–24 companion; audited against module v1.2.0 on 2026-11-05.
> Companion documents: `docs/compatibility/crm-chat.md` ·
> `docs/modules/crm-chat/RELEASE_NOTES.md` · `docs/modules/ai-agents/operations-runbook.md` ·
> the in-app admin handbook (`content/docs/en/admin/crm-chat.md`, `content/docs/en/admin/ai-agents.md`).
> UI: **CRM Chat** at `/crm-chat` and the administration workspace at `/ai-agents`
> (`CRMChatAdmin:edit` for Chat settings, `AIAgentPolicy:edit` for AI Agents settings).

This runbook answers the question an operator has on day one: **in what order do I switch things on,
and how do I know each step worked?** A fresh install shows the Chat workspace but cannot answer
anything until the steps below are done — that is deliberate, not a defect.

## 0. Commands you will need

| Command | Capability | What it answers |
| --- | --- | --- |
| `GET /api/v1/CRMChat/action/health` | `CRMChatAdmin:edit` | Module state: flags, readiness, warnings, tables, i18n keys. |
| `GET /api/v1/CRMChat/action/capabilities` | `CRMChatConversation:read` | What *you* may use right now: effective features, assistant readiness, granted tools. |
| `GET /api/v1/CRMChat/action/settings` · `POST /api/v1/CRMChat/action/settings` | `CRMChatAdmin:edit` | The `crmChat` document. `POST` takes a partial document; unknown keys are refused. |
| `GET /api/v1/AIAgents/action/health` · `GET /api/v1/AIAgents/action/capabilities` | `AIAgentPolicy:edit` / `AIAgent:read` | AI Agents state: execution flag, kill switch, memory flag, providers configured. |
| `GET /api/v1/AIAgents/action/agents` · `POST /api/v1/AIAgents/action/agents/:id/publish` | `AIAgentVersion:edit` | Which profiles exist and are published. |
| `POST /api/v1/CRMChat/action/turns` | `CRMChatConversation:read` | The real end-to-end check, once readiness is `ready`. |

## 1. Turning it on, in this order

Each step depends on the previous one; skipping one produces a workspace that renders but cannot
answer, and the readiness tag names the missing step.

1. **Choose and configure a provider.** AI Agents → *Providers* → add a connection (OpenAI-compatible
   or Anthropic), store the API key (write-only, AES-GCM; requires `ENCRYPTION_KEY`). Run the
   connectivity check. No connection, no answer — and never fall back to a plaintext key.
2. **Publish an answering agent.** AI Agents → *Agents* → create a profile (or start from the
   **Product help assistant** / **Account briefing** starter). The published version **must** set
   `memory.mode: 'conversation'`, or Chat reports `agent-memory-off`. Grant it the tools the answers
   need (see §4). Publish.
3. **Enable AI Agents execution.** AI Agents → *Settings* → `features.execution: true`. Off by
   default; this is the master switch for every model call.
4. **Enable conversation memory.** AI Agents → *Settings* → `features.memory: true`. Chat's thread
   store lives in AI Agents (`ai_agent_conversations` / `ai_agent_messages`); without it readiness is
   `memory-disabled`.
5. **Confirm the kill switch is off.** AI Agents → *Settings* → `safety.globalExecutionPaused: false`.
6. **Point Chat at the agent.** `/crm-chat` → **Settings** → select the published profile, or post
   `{"assistant":{"agentKey":"<key>"}}`. Readiness must read `ready`.
7. **Enable the feature switches, in dependency order.** Each requires the ones before it:
   `workspace` (already on) → `readTools` → `helpRetrieval` → `feedback` → `conversationSearch`;
   `actionProposals` last, and only with `safety.allowWrites` deliberately on. A flag that is on but
   missing a prerequisite reports *Inactive* with a `featurePrerequisiteOff` warning.
8. **(Optional) Publication gate.** AI Agents → *Settings* → `features.evaluations: true` makes
   `publish` require a passing required-suite run, including its human-review case. Off by default;
   it changes what publishing means for every agent, so enable it deliberately.
9. **Verify as a non-admin test user**, not as the administrator: open `/crm-chat`, confirm the menu
   entry exists, ask one question that needs a CRM read, and check the answer cites what it read.

## 2. Choosing the execution mode

`execution.mode` on the `crmChat` document: `queue` (default, needs the worker, Redis and a matching
`REPORT_WORKER_SECRET`/`REPORT_WORKER_API_URL`) or `inline` (turn runs inside the API process; no
worker; single-process installs). If turns stay `queued` forever, fix the worker/secret first — do not
switch modes to hide a broken worker.

## 3. Verifying it works

| Check | Expected |
| --- | --- |
| `GET /api/v1/CRMChat/action/capabilities` | `assistant.state` = `ready`; `assistant.tools` lists the granted tool keys |
| Suggested chips on the empty state | Only chips whose `requiresTool` is granted are rendered |
| One read question ("how many open opportunities do I have?") | Answer with a number from an aggregate, not a summed page |
| One help question ("how do I change my password?") | Answer or an explicit "no article found" — never an invented procedure |
| Approval path (if writes are enabled) | A `crm_update_record_fields` proposal card appears; confirm executes once, reject changes nothing |
| `GET /api/v1/CRMChat/action/health` | No `featurePrerequisiteOff` / `writesDisabled` warnings you did not intend |

## 4. Minimum tool grants for a useful first assistant

`crm_search_records`, `crm_read_record`, `crm_record_summary`, `crm_list_related`, `crm_aggregate`,
`crm_actor_context`, `crm_list_activities`, `docs_search`, `docs_read_page` — read-only, ACL-enforced,
safe to grant. Add `crm_post_note` / `crm_log_activity` / `crm_create_task` for a working loop.
`crm_update_record_fields` is `material_write` and always stops at an approval card; leave it out
until step 7 is done.

## 5. Failure table

| Symptom | Cause | Fix |
| --- | --- | --- |
| Menu entry missing | `features.workspace` off, or role lacks `CRMChatConversation:read` | Post `{"features":{"workspace":true}}`; grant the capability |
| Tag `not-configured` / `not-found` | `assistant.agentKey` empty or unknown | Step 6 |
| Tag `not-published` | Agent not published / no version | Publish in AI Agents |
| Tag `execution-disabled` / `execution-paused` / `memory-disabled` | Step 3 / 5 / 4 not done | Do the step; the tag names it |
| Tag `agent-memory-off` | Published version's `memory.mode` is not `conversation` | Republish with conversation memory |
| Turn stays `queued` | Worker, Redis, secret or URL missing (queue mode) | Fix the worker; or use `inline` for single-process installs |
| `403 FEATURE_DISABLED` on a turn | `features.readTools` (or `helpRetrieval` for help) is off | Step 7 |
| Confirm button refused | `safety.allowWrites` off, or `actionProposals` ineffective | Step 7 — deliberately |
| Answer cites nothing | Agent lacks `docs_*` / read tools, or handbook has no page | Grant tools; the "no article found" answer is designed behaviour |
| Numbers look guessed | Agent lacks `crm_aggregate` | Grant it; without it the model sums a truncated page |

## 6. Rollback

Post flags off, in reverse dependency order: `actionProposals` → `feedback` → `conversationSearch` →
`helpRetrieval` → `readTools`. To hide the surface entirely, `{"features":{"workspace":false}}` — the
menu entry disappears and every Chat endpoint answers `FEATURE_DISABLED`. To stop all model calls
platform-wide, AI Agents → *Settings* → `safety.globalExecutionPaused: true`. Neither touches data;
conversation rows survive inside the AI Agents retention window (`retention.conversationsDays` there,
not the Chat value, is the executor).

## 7. Never

- Never enable `safety.allowWrites` on an instance where proposals must not execute — it is the only
  switch standing between a rendered card and a written record.
- Never widen `crm_update_record_fields`' allowlist or grant write tools to an agent nobody reviews.
- Never store a provider key in an agent definition, a prompt or a wiki page — write-only through the
  provider connection, always.
- Never hand-edit `ai_agent_*` or `crm_chat_*` rows; use the module endpoints so audit and invariants
  hold.
