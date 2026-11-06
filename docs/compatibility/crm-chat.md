# CRM Chat — compatibility and clean-room status

> **Plan:** `plans/PLAN_Phase_19_CRM_Chat.md` §2 (reference boundary), §17 (delivery roadmap), §20 (release);
> the product contract is `docs/architecture/crm-chat-contract.md`, the audit is
> `docs/modules/crm-chat/repository-audit.md`.
> **Module:** `CRMChat` — registry key and route slug `crm-chat`, SPA route `/crm-chat`, no `Ua` prefix.
> **Status:** 19-CHAT.0 → 19-CHAT.24 delivered (module v1.2.0, contract v1.2.0); P1 domain tools
> delivered (module v1.3.0, contract unchanged) — as audited 2026-11-05.

---

## 1. Reference boundary

The behaviour was designed from the public EspoCRM documentation concepts named in the plan
(metadata, ACL, API, modules) and from this repository's own kernel conventions — not from upstream
source. No PHP source, frontend asset, translation, icon or branding from the upstream project was
copied or mechanically translated. The implementation is independent TypeScript.

CRM Chat deliberately contains **no orchestration of its own**: every model call, tool invocation,
approval and run-ledger row lives in `AIAgents`. Chat is the conversation experience layer —
workspace, quick-chat panel, citations, feedback, saved prompts and settings — over the durable
`AIAgents` run engine.

---

## 2. Delivered

| Phase | Delivered |
| --- | --- |
| 19-CHAT.0–3 | Repository audit; contract and threat model; module registration with feature flags and navigation; migration `062` creating `crm_chat_citations`, `crm_chat_feedback`, `crm_chat_prompts` (additive only). |
| 19-CHAT.4 | Conversation list/get/rename/archive/delete over the **reused** AI Agents stores, owner-scoped, with paginated history. Chat never created a second conversation table. |
| 19-CHAT.5–6 | `AIAgentsClient` adapter (narrow contract; no duplicated engine); turn submit/status/cancel; SSE stream of run events with heartbeat and 1 s server-side polling; reconnect contract with polling fallback. |
| 19-CHAT.7 | React workspace: sidebar, thread, plain-text safe rendering, composer (Enter/Shift+Enter/Escape), streaming status, responsive layout. |
| 19-CHAT.8–10 | Context selection with validated entity/id formats; citations persisted and **re-authorized at render time**; help retrieval (`docs_search` / `docs_read_page` over the in-app handbook, plus the Service Desk knowledge corpus — rights-aware, G34 fixed); read-only query execution with ACL and safe query plans. |
| 19-CHAT.11–14 | Cross-module analysis (curated paths, `crm_cross_module`); action proposals confirmed through AI Agents approvals (never a parallel approval store); admin settings with guardrails; conversation search (`conversationSearch` flag); saved prompts (data only); feedback (audited, inert). |
| 19-CHAT.15–19 | Security hardening (injection boundaries, cross-user isolation); usage tracking and safe observability; evaluation suite; release readiness and operational handover (v1.1.0). |
| 19-CHAT.20–24 | AI CRM tool catalogue v2: acting user in the system prompt; `crm_actor_context`, `crm_aggregate`, `crm_list_activities` (+ `crm_cross_module` in the registry); the write loop (`crm_post_note`, `crm_log_activity`, `crm_draft_email`, `crm_create_task` v2, `crm_update_record_fields` v2); module intelligence tools (`crm_lead_score`, `crm_customer_health`, `crm_case_context`, `crm_stale_records`, `crm_run_report`); tool-aware suggestions and the 20-tool catalogue assertion (v1.2.0). |
| P1 — domain tools (2026-11-05, module v1.3.0) | `crm_project_status` (Projects, over `ProjectViewService.statusSummary()`), `crm_commercial_summary` (Sales, over the 19-S.19 `customerSummary` contract), `crm_campaign_performance` (MarketingAutomation, over `stats()` behind the campaign readability gate), `crm_list_emails` (AIAgents kernel; metadata only — bodies never cross the tool boundary). `MAX_TOOLS` 20 → 24; catalogue asserted as 25 entries. Event triggers implemented in AI Agents (owner-principal, record-context allowlists, recursion/idempotency guards). |
| P2 — inline AI + briefing (2026-11-06) | Quick-chat panel accepts a context prefix + suggestion chips, and is mounted inline on the record header (per-record context and summarize/next-step/follow-up suggestions), on the list bulk bar (selection count/entity context) and via `EmailTemplateDesignerPage`'s "Draft with AI" deep link; the chat workspace accepts `?ask=` as a one-time composer prefill. Home gains a deterministic briefing card (`briefingSignals` over the same ACL-checked tasks/agenda/approvals queries — no model call) whose only AI surface is a "prioritize my day" deep link. |

`CRM_CHAT_MODULE.implementedPhases` declares `19-CHAT.0` → `19-CHAT.24` and is pinned by
`apps/api/test/phase19-module-declarations.test.ts` (added 2026-11-05).

---

## 3. Persistence and reuse

- **Chat owns three tables** (migration `062`, additive only): `crm_chat_citations`,
  `crm_chat_feedback`, `crm_chat_prompts`. Nothing else.
- **Conversations and messages are AI Agents' data** (`ai_agent_conversations`,
  `ai_agent_messages`). Retention, ordering and owner scoping are executed there; the Chat
  `retention.conversationsDays` setting is stored but does not execute (documented in the admin
  handbook).
- **Approvals, runs, usage and cost are AI Agents' data.** Chat renders proposals and calls the
  existing approve/reject routes; it creates no parallel records.
- **Reads and writes go through the Entity Engine** (or the owning module's service for intelligence
  tools) under the initiating user's ACL — record predicates are folded into the SQL for
  aggregates and `crm_stale_records`, so restricted records never leak through a count.
- **Citations are re-authorized before rendering**; a record the reader can no longer open shows as
  locked. A turn's `sources` list is re-filtered the same way (G39 fixed); `features.readTools` is
  enforced on turn and query routes (G38 fixed).

---

## 4. Deliberate deviations, documented

1. **Route shape.** `@Controller('api/v1/CRMChat')` with `action/…` sub-routes, registered before
   the generic `:entity` wildcard — matching repository convention, not the plan's kebab-case
   sketch. `ENTITY_CONTROLLERS` never sees these paths.
2. **Error vocabulary.** Chat reuses the platform `AppError` subclasses and uppercase codes
   (`FEATURE_DISABLED`, `NOT_FOUND`, `VALIDATION_FAILED`, …); no `CHAT_*` codes exist.
3. **Plain-text rendering.** Assistant text renders as plain text in the first release — no
   markdown, no sanitizer, no `dangerouslySetInnerHTML`. Revisiting this needs a reviewed pair.
4. **SSE polls.** The stream reads the run timeline once per second instead of being pushed to by
   the worker; events and ordering are correct, latency is ≤ 1 s. No token-level deltas (the
   provider contract is request/response); "no token deltas" is a documented limitation.
5. **Feature flags ship off.** Only `features.workspace` starts on; `readTools`, `helpRetrieval`,
   `actionProposals`, `feedback` and `conversationSearch` start off, and a proposal also needs
   `safety.allowWrites`. A fresh install renders the shell but cannot answer; the ordered enablement
   is `docs/runbooks/crm-chat-first-run.md`.
6. **Conversations are private.** No sharing, no team scope, no cross-user read — an owner
   predicate is part of every query. Chat's `DELETE` soft-deletes (`status='deleted'`); the AI
   Agents administration surface hard-deletes — deliberately different, both documented.
7. **Flags are not permissions.** A flag exposes a surface; the caller's capability still decides.
   The two are checked together everywhere (e.g. feedback needs the flag *and* the capability).
8. **Chat never picks the agent.** The answering profile is an administrator's choice
   (`assistant.agentKey`); Chat validates readiness and refuses to guess.
9. **Tool list is the agent's grants**, not a deployment menu. Suggestion chips render only when
   the answering agent holds the matching tool; nothing is advertised that cannot be answered.

---

## 5. Compatibility surfaces

| Surface | Status |
| --- | --- |
| `/api/v1/CRMChat/action/*` (conversations, turns, events SSE, query, help, prompts, feedback, actions, cross-module, usage, citations, settings, health, capabilities) | available; **no generated OpenAPI** (G1 deferred to Phase 22.22) — routes are pinned by `crm-chat-contract.test.ts` and the contract catalog |
| Module version | `CRMChat` v1.3.0 (P1, 2026-11-05) / `AIAgents` v1.2.0; contract unchanged at v1.2.0; P2 (2026-11-06) is presentation-only — no contract, migration or module version change |
| Navigation key `crmChat`, route `/crm-chat`, quick-chat panel in the app header, inline instances on record headers + list bulk bar + email designer | available; gated by `CRMChatConversation:read` (`/crm-chat`); inline instances reuse the same turn API, ACL and SSE stream |
| Home "Today's briefing" card | available; deterministic (tasks/agenda/approvals the user already sees), no provider call, no new endpoint |
| `crmChat` settings row in `app_settings` | available; strict Zod validation; unknown keys refused |
| `crm_chat_citations` / `crm_chat_feedback` / `crm_chat_prompts` (migration `062`) | available, additive only |
| `ai_agent_conversations` / `ai_agent_messages` / `ai_agent_runs` / `ai_agent_approvals` | reused read-only-ish: Chat submits runs and renders approvals; it never writes their internals |
| i18n `web.crmChat.*` | `en` and `vi` catalogs complete |
| In-app handbook | `en` pages: `user/chat-and-voice`, `admin/crm-chat`, `admin/ai-agents` (updated 2026-11-03/05); `vi` pages: `user/chat-and-voice`, `user/ai-agents` (2026-11-05, awaiting native review) |
| Browser e2e | `e2e/crm-chat.spec.ts` (2 tests, chromium, verified 2026-11-05) — renders, diagnostics drawer, settings open/cancel, quick-chat panel; writes nothing |

---

## 6. Verification note

Behaviour rows say *implemented* only when a test in this checkout proves the acceptance rule against
the configured primary database (`AGENTS.md` §3). The suites never create a second database, never
truncate anything, use `AGENT_TEST_<runid>` markers cleaned by id, and call no provider — the
deterministic fake covers the model boundary. As of 2026-11-05: **10 suites, 159 tests** pass
(`crm-chat*.test.ts`), plus `ai-domain-tools.test.ts` (5 cases, P1 domain tools, incl. per-tool
denial paths) and `phase19-module-declarations.test.ts` pinning the phase list. The e2e spec writes
nothing and changes no setting.

---

## 7. Known limitations and deferrals

- **No markdown / no token-level streaming** (see §4.3–4.4); **poll-based SSE** with a documented
  reconnect contract.
- **Feature flags off by default**; assistant must be published and configured before the first
  answer (`docs/runbooks/crm-chat-first-run.md`).
- **Single-user conversations**; no sharing by design (would be a separate reviewed migration).
- **Help is the handbook plus the knowledge corpus** — no web search, no vector index/RAG (decided;
  revisit only when the corpus outgrows keyword retrieval).
- **Cross-module paths are curated** — a user cannot define one; adding one is a code change.
- **`retention.conversationsDays` stores but does not execute** — the AI Agents retention settings
  are the executor.
- **No OpenAPI document** yet (G1, deferred to 22.22); consumers rely on the contract catalog.
- **`vi` handbook coverage is partial** — 20 of 54 pages translated; the remainder answer in
  English behind the fallback notice (`docs/compatibility/documentation.md`).
- **Vietnamese prose has not been reviewed by a native speaker.**
