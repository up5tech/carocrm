# AI Agents — compatibility and clean-room status

> **Plan:** `PLAN_Phase_19_AI_Agents.md` §2.1, §6 (clean-room), §21.
> **Module:** `AIAgents` — registry key and route slug `ai-agents`, no `Ua` prefix.
> **Status:** baseline was written in 19-AI.0; this document now covers the delivered phases
> **19-AI.0–19-AI.19** together (19-AI.18 is delivered as the authenticated MCP-compatible protocol
> adapter below; model-backed retrieval stays deferred by design). Every row that says *implemented*
> names the acceptance rule that was actually tested in this project. Tests live in
> `apps/api/test/ai-agents.test.ts`, `apps/api/test/ai-agent-runs.test.ts` and
> `apps/api/test/ai-providers.test.ts`.

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
| 19-AI.5 | Draft agent CRUD, configuration validation, immutable published versions with checksum, publish/pause/resume/archive/restore-to-draft, owner/team visibility. Tested: a published version cannot be edited in place and unbounded/invalid configuration is rejected. |
| 19-AI.6–19-AI.7 | Server-side tool registry (typed schemas, effect classes, timeouts, result caps) with four read tools and two governed write tools; durable run engine with leases, budgets, cancellation, retry waits and step-limit/expiry recovery; worker executes only through the worker-authorised API door, so a duplicate dispatch is a no-op. Tested: end-to-end read run, ACL denial inside a tool, provider failure recorded as `failed`, cancel, retry idempotency. |
| 19-AI.8 | The reviewed `account-briefing` read-only template; a validated user executes a traceable read-only run and an unauthorized starter's tool calls are denied server-side. |
| 19-AI.9 | Tool-call validation pipeline: grant → enabled → strict schema → repeated-call → approval/replay gates; model-proposed unknown tools, ungranted tools and unknown argument fields are denied, and denied arguments are never persisted as text. Tested as adversarial prompt-injection cases, including indirect injection placed *inside retrieved CRM records*: the injected `crm_create_task` call is recorded `not_granted`, no Task is created, and the run reports the denial. |
| 19-AI.10 | Approval entity, inbox, approve/reject/expiry, re-validation at execution time (stale targets invalidate), decision audit; the low-risk write tools (`crm_create_task`, `crm_update_record_fields`) are always policy-gated (`material_write` pauses for approval). Tested: approve executes exactly once, reject ends without changing the record, a removed target invalidates the approval. |
| 19-AI.11 | Run console UI: definitions/list, run timeline, tool summaries, conversation thread, cancellation, retry for known-outcome runs; conversations are owner-scoped and cross-user access is refused (tested). |
| 19-AI.12 | Memory modes (`none` default, conversation), retention sweep cron `aiAgents.retentionSweep` plus dry-run endpoint; expired conversations vanish from listing and are deleted by the sweep without touching other rows (tested). |
| 19-AI.13 | Usage ledger (runs, provider requests), config-driven pricing snapshots labelled as estimates, budget policies (global/user/team/agent scopes, soft warnings, hard stops), per-run cost limit, atomic quota reservation with concurrency race coverage. Tested: estimate vs actual labelling, cost-budget stop, hard-quota stop, concurrent reservation race. |
| 19-AI.14 | Evaluation suites/cases with deterministic graders (config schema, tool permissions, approval policy, budget bounds, provider policy) and review-labelled results that can never override a failed deterministic case; publication gate enforced on `publish` when required suites are configured. |
| 19-AI.15–19-AI.17 | Domain reach is deliberately narrow: `crm_search_records`/`crm_read_record` only ever run inside the Entity Engine under the *initiating user's* current ACL, so Sales/CustomerSuccess/ServiceDesk/Projects/Marketing data is read through the same permissioned path instead of module-owned copies. Sales financial state is untouched (the only write tools are Task creation and a field update that must pass approval); there is no marketing send path in the module at all — consent/dispatch remain wholly MarketingAutomation's, and ServiceDesk internal-note visibility is enforced by the Stream module's own visibility rules. No circular import exists: `AIAgents` imports only kernel entity/metadata services. |
| 19-AI.18 (protocol half) | MCP-compatible protocol adapter: `GET action/mcp/tools`, `POST action/mcp/call` — session-authenticated, `use` capability enforced, allowlisted registry lookup, strict schema validation, disabled tools refused; model-backed retrieval stays deferred. |
| 19-AI.19 | Threat-model re-review, kill switch (blocks new runs and high-impact tools), elapsed/token/cost/step budgets, worker-lease recovery that cannot duplicate tool effects, retention sweep, redaction of denied arguments and secrets from every ledger/trace (secret encryption verified write-only in `ai-providers.test.ts`). |
| 19-AI.20 | Lint/type-check/build/test suites run green against the configured primary database (§6); `PLAN.md` status updated; this document rewritten. |

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
