# AI Agents — compatibility and clean-room status

> **Plan:** `PLAN_Phase_19_AI_Agents.md` §2.1, §6 (clean-room), §21.
> **Module:** `AIAgents` — registry key and route slug `ai-agents`, no `Ua` prefix.
> **This document covers phases 19-AI.0 through 19-AI.4 only.**

---

## 1. Reference boundary

The behaviour was designed from the public EspoCRM documentation concepts named in the plan
(metadata, ACL, API, modules, Intelligence/MCP descriptions) and from this repository's own kernel
conventions. No PHP source, frontend asset, translation, icon or branding from the upstream project
was copied or mechanically translated.

The implementation is independent TypeScript. Provider adapters use Node `fetch` and the
OpenAI-compatible chat-completions contract; no vendor SDK is vendored.

---

## 2. Delivered in this foundation

| Phase | Delivered |
| --- | --- |
| 19-AI.0 | Repository audit, dependency map, gap list, migration proposal, safe command list. |
| 19-AI.1 | Domain contracts, run state machine, risk matrix, principal model, threat model. |
| 19-AI.2 | `AIAgents` module descriptor, capability matrix enforced through the platform ACL, permission-aware navigation entry, validated `aiAgents` settings row with execution default **off** and a global kill switch, module health diagnostics. |
| 19-AI.3 | Additive migration `045_phase19_ai_agents.sql` and Kysely table types for definitions, immutable versions, tool grants, runs, run events, tool calls, approvals, provider requests, budgets and provider connections. |
| 19-AI.4 | Provider gateway, OpenAI-compatible and fake adapters, encrypted write-only credentials, SSRF-safe URL validation, model/data-class allowlists, request ledger, connectivity check. |

## 3. Not delivered yet

These are deliberately absent and must not be presented as working:

- Agent definition CRUD/version publication API and UI (AI.5).
- Tool registry and CRM tools (AI.6).
- Run engine, queue dispatch, cancellation and recovery (AI.7–AI.11).
- Approval service and write tools (AI.10).
- Memory, conversations and retention jobs (AI.12).
- Quota reservation and admin usage reports (AI.13).
- Evaluation suites and publication gates (AI.14).
- Sales/CustomerSuccess/ServiceDesk/Projects/Marketing/Portal tool adapters (AI.15–AI.17).
- MCP or any external tool protocol (AI.18, optional).
- Hardening/runbooks/release QA (AI.19–AI.20).

The tables added in AI.3 exist because their first consumer is defined next; no endpoint claims a
run can be created. `features.execution` is false by default, and the policy gate that future run
creation must call is already enforced and tested.

---

## 4. Deliberate deviations, documented

1. **Synthetic ACL resources.** The platform has no arbitrary-permission mechanism. Agent rights are
   addressed as entity/action pairs (`AIAgent:read`, `AIAgentProvider:edit`, …) evaluated by the
   existing `AclApiService`. A role with a `*` entry grants them exactly as it grants every future
   entity; this is the documented platform wildcard rule, not an agent-specific bypass. See
   [repository-audit.md](../modules/ai-agents/repository-audit.md) §4.
2. **No generic entity records.** Agent definitions, versions, runs, approvals and ledgers use
   dedicated tables because their invariants (immutability, one event per sequence, one effect per
   idempotency key) cannot be expressed by JSONB attrs alone. CRM records remain in the Entity
   Engine and are reached only through tools in later phases.
3. **Provider credentials live in the module's connection table**, encrypted with the platform
   `ENCRYPTION_KEY`, because no shared generic secret store exists. They are write-only and are never
   stored in an agent definition, run, event or tool argument.
4. **`fake` adapter is non-production only.** This keeps a test seam without allowing a live
   deployment to fabricate model answers.
5. **`period` column name.** `window` is a reserved word in PostgreSQL; the budget policy uses
   `period` with the same values (`run`, `day`, `month`).
6. **Foundation UI is diagnostic.** The AI Agents page shows health, providers, features and the
   caller's rights. Agent lists, run console and approvals arrive with their phases.

---

## 5. Compatibility surfaces

| Surface | Status |
| --- | --- |
| `/api/v1/AIAgents/action/{health,capabilities,settings,providers}` | available |
| Navigation key `aiAgents`, route `/ai-agents` | available only with `AIAgent:read` |
| `aiAgents` settings row in `app_settings` | available; execution off by default |
| `ai_provider_connections` schema | available |
| Generic `/api/v1/:entity` API | unchanged; no AI entity metadata is registered |
| Existing modules | unchanged; no import of an optional domain from `AIAgents` |
