# AI Agents — compatibility and clean-room status

> **Plan:** `plans/PLAN_Phase_19_AI_Agents.md` §2.1, §6 (clean-room), §21.
> **Module:** `AIAgents` — registry key and route slug `ai-agents`, no `Ua` prefix.
> **Status:** baseline was written in 19-AI.0; this document now covers the delivered phases
> **19-AI.0–19-AI.13, 19-AI.18 (protocol half), 19-AI.19 and 19-AI.20** (19-AI.18's model-backed
> retrieval stays deferred by design), **19-AI.14 is built, tested, and still switched off by default**
> (see §5), and **19-AI.15–19-AI.17 are partially delivered since P1 (2026-11-05)** — their read-only
> tools landed (`crm_commercial_summary`, `crm_project_status`, `crm_campaign_performance`,
> `crm_list_emails`); their trigger half remains unimplemented. See the rows for details; this was corrected
> on 2026-11-03, and the P1 delivery was recorded on 2026-11-05. Every row that says *implemented* names
> the acceptance rule that was actually tested in this project. Tests live in
> `apps/api/test/ai-agents.test.ts`, `apps/api/test/ai-agent-runs.test.ts`,
> `apps/api/test/ai-providers.test.ts` and `apps/api/test/ai-agent-evaluations.test.ts`.

---

## 1. Reference boundary

The behaviour was designed from the public EspoCRM documentation concepts named in the plan
(metadata, ACL, API, modules, Intelligence/MCP descriptions) and from this repository's own kernel
conventions. No PHP source, frontend asset, translation, icon or branding from the upstream project
was copied or mechanically translated.

The implementation is independent TypeScript. Provider adapters use Node `fetch` and the
OpenAI-compatible chat-completions contract; no vendor SDK is vendored.

---

## 2. Delivered

| Phase | Delivered |
| --- | --- |
| 19-AI.0 | Repository audit, dependency map, gap list, migration proposal, safe command list (`repository-audit.md`). |
| 19-AI.1 | Domain contracts, run state machine, risk matrix, principal model, threat model (`architecture.md`, `security-and-threat-model.md`), re-reviewed in 19-AI.19. |
| 19-AI.2 | `AIAgents` module descriptor, capability matrix enforced through the platform ACL, permission-aware navigation entry, validated `aiAgents` settings row with execution default **off** and a global kill switch, module health diagnostics. |
| 19-AI.3 | Additive migrations `045`–`050`: definitions, immutable versions, tool grants, runs, run events, tool calls, approvals, provider requests, budgets, provider connections, conversation/memory, pricing snapshots, evaluation suites. No destructive statement; `features.execution` is off by default. |
| 19-AI.4 | Provider gateway, OpenAI-compatible and fake adapters, encrypted write-only credentials, SSRF-safe URL validation, model/data-class allowlists, request ledger, connectivity check. |
| 19-AI.5 | Draft agent CRUD, configuration validation, immutable published versions with checksum, publish/pause/resume/archive/restore-to-draft, owner/team visibility. Tested: a published version cannot be edited in place and unbounded/invalid configuration is rejected. The tool ceiling is `MAX_TOOLS` = **20** grants per agent version (raised from 8 on 2026-11-03, because 8 was below the size of the Chat-facing catalogue and made it impossible to grant an assistant the tools the Chat suggestions advertise); the other bounds — system prompt 12 000 characters, config 32 KiB, output-schema depth 4 / 100 nodes — are unchanged. |
| 19-AI.6–19-AI.7 | Server-side tool registry (typed schemas, effect classes, timeouts, result caps) with four read tools and two governed write tools; durable run engine with leases, budgets, cancellation, retry waits and step-limit/expiry recovery; worker executes only through the worker-authorised API door, so a duplicate dispatch is a no-op. Tested: end-to-end read run, ACL denial inside a tool, provider failure recorded as `failed`, cancel, retry idempotency. |
| 19-AI.8 | The reviewed `account-briefing` read-only template; a validated user executes a traceable read-only run and an unauthorized starter's tool calls are denied server-side. |
| 19-AI.9 | Tool-call validation pipeline: grant → enabled → strict schema → repeated-call → approval/replay gates; model-proposed unknown tools, ungranted tools and unknown argument fields are denied, and denied arguments are never persisted as text. Tested as adversarial prompt-injection cases, including indirect injection placed *inside retrieved CRM records*: the injected `crm_create_task` call is recorded `not_granted`, no Task is created, and the run reports the denial. |
| 19-AI.10 | Approval entity, inbox, approve/reject/expiry, re-validation at execution time (stale targets invalidate), decision audit; the low-risk write tools (`crm_create_task`, `crm_update_record_fields`) are always policy-gated (`material_write` pauses for approval). Tested: approve executes exactly once, reject ends without changing the record, a removed target invalidates the approval. |
| 19-AI.11 | Run console UI: definitions/list, run timeline, tool summaries, conversation thread, cancellation, retry for known-outcome runs; conversations are owner-scoped and cross-user access is refused (tested). |
| 19-AI.12 | Memory modes (`none` default, conversation), retention sweep cron `aiAgents.retentionSweep` plus dry-run endpoint; expired conversations vanish from listing and are deleted by the sweep without touching other rows (tested). |
| 19-AI.13 | Usage ledger (runs, provider requests), config-driven pricing snapshots labelled as estimates, budget policies (global/user/team/agent scopes, soft warnings, hard stops), per-run cost limit, atomic quota reservation with concurrency race coverage. Tested: estimate vs actual labelling, cost-budget stop, hard-quota stop, concurrent reservation race. |
| 19-AI.14 | Evaluation suites/cases with deterministic graders (config schema, tool permissions, approval policy, budget bounds, provider policy, memory policy, ownership, exact invariants) and review-labelled results that can never override a failed deterministic case; publication gate enforced on `publish` when required suites are configured. **Covered by `apps/api/test/ai-agent-evaluations.test.ts` (19 cases) since 2026-11-03** — every deterministic grader is exercised in both directions, the gate is shown blocking a publish and releasing it, and an edit after a pass is shown invalidating it because the gate matches the draft checksum. Because the built-in required suite carries a `human-review` case, a run of it ends `pending_review`: the test walks the operator's real path — blocked, approve the review, publish, edit the draft, re-run, reject the review, blocked again — and the Evaluations admin tab gained the Approve/Reject control that path needs. `features.evaluations` still defaults to `false`: switching it on changes what `publish` requires for every agent, and it asks a person to staff the review, so it stays an operator's decision — now a tested one. `model_review` remains advisory by design — it never gates and makes no provider call (§17.3). |
| 19-AI.15–19-AI.17 | **Read side and event triggers delivered (P1, 2026-11-05/06); schedule and integration triggers still not built; no Sales/Marketing write path.** The phases named module-owned tools (`Sales`, `CustomerSuccess`/`ServiceDesk`/`Projects`, `MarketingAutomation`) plus event/schedule/integration triggers. **Event triggers (2026-11-06):** the worker subscribes on the domain-event bus and posts to `POST action/worker/trigger-event` (worker-authorised). An agent fires only when `triggers.event` is true, the event type is in the published version's `triggers.eventTypes` allowlist, the entity is in `triggers.eventEntities`, and it is record-context for exactly that entity — both allowlists default to empty, meaning never. Each triggered run executes as the **publishing user** (`principalFromUser`), never wider; if the owner is missing or inactive the agent is skipped. Events produced inside a run carry `correlation_id = 'aiAgentRun:<id>'` and are never re-submitted, so an agent's output can never start another run. Re-delivering the same event is a no-op (`evt:<eventId>:<agentId>`). Fan-out is capped at five agents per event, and the whole path is a quiet no-op while `features.eventTriggers` is off. **Still missing:** schedule triggers and integration triggers (`triggers.integration` warns `trigger-not-implemented`). Domain tools delivered: `crm_customer_health`, `crm_case_context` (19-CHAT.23), `crm_lead_score` (LeadScore), and P1 2026-11-05: `crm_commercial_summary` (Sales), `crm_project_status` (Projects), `crm_campaign_performance` (MarketingAutomation), `crm_list_emails`. AIAgents v1.2.0. There is no marketing send path in the module at all — consent/dispatch remain wholly MarketingAutomation's, and ServiceDesk internal-note visibility is enforced by the Stream module's own visibility rules. No circular import exists: `AIAgents` imports only kernel entity/metadata services. |
| 19-AI.18 (protocol half) | MCP-compatible protocol adapter: `GET action/mcp/tools`, `POST action/mcp/call` — session-authenticated, `use` capability enforced, allowlisted registry lookup, strict schema validation, disabled tools refused, and (since Phase 22.13) a tool whose effect class demands a human decision is refused here because this door carries no run for an approval to attach to; model-backed retrieval stays deferred. |
| 19-AI.19 | Threat-model re-review, kill switch (blocks new runs and high-impact tools), elapsed/token/cost/step budgets, worker-lease recovery that cannot duplicate tool effects, retention sweep, redaction of denied arguments and secrets from every ledger/trace (secret encryption verified write-only in `ai-providers.test.ts`). |
| 19-AI.20 | Lint/type-check/build/test suites run green against the configured primary database (§6); `plans/PLAN.md` status updated; this document rewritten. |
| 19-AI.21 | **The self-approval policy (2026-11-07).** A `material_write` / `high_impact` proposal may not be approved by the person it was requested from. `approval.selfApprovalPolicy` is `forbidden` (default) or `permitted_with_audit`; the decision path refuses with the stable codes `AI_APPROVAL_SELF_APPROVAL_FORBIDDEN` (403) and `AI_APPROVAL_SECOND_APPROVER_REQUIRED` (403). Permissive mode records the requester's signature and still needs a second approver. Rejecting one's own proposal stays allowed, and a stale proposal is still invalidated first. Service code and one additive settings field — no migration, no schema change. Covered by `apps/api/test/ai-agent-self-approval.test.ts`; the existing approval cases now decide with a second approver. |
| 19-AI.22 | **Per-user run admission fairness (2026-11-08).** `limits.maxRunsPerUserPerMinute` (default 120, range 1–600) caps run creation per principal per minute. It is enforced inside `createInternal` — unlocked pre-check before conversation resolution, serialized re-check under a per-user advisory lock inside the insert transaction — so the manual door and every trigger door (event/schedule/integration) share the same budget, charged to the acting principal. A refusal answers the standard `429 RATE_LIMITED` envelope, and trigger doors report it as `rate_limited` rather than an internal error. No migration; rollback is a settings change. Covered by `ai-agent-runs.test.ts` (burst throttled, other principal unaffected) and `ai-agent-triggers.test.ts` (a trigger storm respects the cap). |
| 19-AI.23 | **MCP direct-call idempotency (2026-11-08).** `POST action/mcp/call` accepts an optional `idempotencyKey`; a write-capable tool (`low_write` — `material_write`/`high_impact` were already refused for lack of a run to attach a decision to) **requires** one. Receipts live in the additive `ai_agent_mcp_direct_calls` table keyed by `(principal_id, idempotency_key)`, claimed before execution so a concurrent duplicate sees "in flight" (409 `AI_CALL_IN_FLIGHT`) instead of double-executing. A replay returns the stored `toolCallId` and result without re-running; the same key with different arguments is refused (`AI_IDEMPOTENCY_CONFLICT`); a failed execution releases its claim so a retry may proceed. Read tools keep a generated key and are never receipted. Covered by `ai-agent-mcp-idempotency.test.ts`. |

---

## 3. Deliberate deviations, documented

1. **Synthetic ACL resources.** The platform has no arbitrary-permission mechanism. Agent rights are
   addressed as entity/action pairs (`AIAgent:read`, `AIAgentProvider:edit`, …) evaluated by the
   existing `AclApiService`. A role with a `*` entry grants them exactly as it grants every future
   entity; this is the documented platform wildcard rule, not an agent-specific bypass. See
   [repository-audit.md](../modules/ai-agents/repository-audit.md) §4.
2. **No generic entity records.** Agent definitions, versions, runs, approvals and ledgers use
   dedicated tables because their invariants (immutability, one event per sequence, one effect per
   idempotency key) cannot be expressed by JSONB attrs alone. CRM records remain in the Entity
   Engine and are reached only through tools.
3. **Provider credentials live in the module's connection table**, encrypted with the platform
   `ENCRYPTION_KEY`, because no shared generic secret store exists. They are write-only and are never
   stored in an agent definition, run, event or tool argument.
4. **`fake` adapter is non-production only.** This keeps a test seam without allowing a live
   deployment to fabricate model answers.
5. **`period` column name.** `window` is a reserved word in PostgreSQL; the budget policy uses
   `period` with the same values (`run`, `day`, `month`).
6. **No provider-reported billed-cost yet.** Cost values on the ledger are labelled estimates from
   configured price snapshots; when an adapter reports authoritative billing it must be recorded as a
   separate field, per the plan's "estimated vs authoritative" rule.
7. **Trigger surface.** Manual runs are live; record/event/schedule/integration triggers are
   declared in agent configuration but require operator setup before they fire, and the integration
   trigger reports `trigger-not-implemented` at validation time instead of silently accepting it.
8. **19-AI.18 retrieval stays deferred.** No vector index or RAG layer exists in this module; the
   plan itself declares retrieval optional and ACL-preserving sources mandatory, so absent retrieval
   is simply not claimed.

---

## 4. Compatibility surfaces

| Surface | Status |
| --- | --- |
| `/api/v1/AIAgents/action/*` (health, capabilities, settings, providers, tools, templates, agents, versions, validate, publish, pause/resume/archive/restore, runs, conversations, memory, retention, usage, evaluations, pricing, budgets, approvals, MCP, worker doors) | available; OpenAPI generated from the same decorators at `/api/v1/OpenApi` |
| Navigation key `aiAgents`, route `/ai-agents` | available only with `AIAgent:read` |
| `aiAgents` settings row in `app_settings` | available; execution off by default |
| `ai_provider_connections`, `ai_agent*` schema (migrations 045–050) | available, additive only |
| Generic `/api/v1/:entity` API | unchanged; no AI entity metadata is registered |
| Existing modules | unchanged; `AIAgents` imports only kernel services, never an optional domain module |

---

## 5. Verification note

Behaviour rows say *implemented* only when a test in this checkout proves the stated acceptance rule
against the configured primary database (`AGENTS.md` §3, plan §18). The suites never create a second
database, never truncate anything, use `AGENT_TEST_<runid>` markers cleaned by id, and run the
deterministic fake provider — no billable model call, no customer-visible message, no marketing
dispatch. Documentation of a behaviour is never evidence that it works.

**19-AI.14 (evaluations) was the exception until 2026-11-03.** Its graders, its gate and its three tables
were real code with no test behind them. `apps/api/test/ai-agent-evaluations.test.ts` (19 cases) now runs
every deterministic grader in both directions, shows the publication gate blocking a publish and releasing
it, and shows a draft edit after a pass invalidating the result. The gate's exit is tested too: the built-in
required suite has a `human-review` case, so a run stops at `pending_review` until a person decides it, and
the Evaluations admin tab is where that decision is recorded. The feature stays off by default
(`features.evaluations = false`) because turning it on changes what `publish` requires for every agent —
that remains an operator's decision, but it is now a tested one. `model_review` stays advisory: it neither
gates nor makes a provider call.
