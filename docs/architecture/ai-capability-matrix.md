# AI capability matrix — CaroCRM vs Twenty (Phase 25)

> **Status:** 25.1 (AI charter and documentation truthfulness) delivered 2026-11-18. Phase 25 as a whole
> is **in progress**, not complete. This is the **single canonical AI parity document**; the 25.0 baseline
> (`docs/quality/phase-25-ai-parity-baseline.md`) and the decision record
> (`docs/quality/phase-25-priority-decisions.md`) are evidence inputs, not parallel matrices.
> **Evidence rule:** CaroCRM claims carry a repository path and, where it matters, a line; Twenty claims
> carry a primary-source URL and a verification state. `Implemented and verified` in this file means
> source-level verification plus the existing cited test suite — **not** a fresh test run by 25.1.
> Anything that cannot be traced is labelled `Hypothesis`, never `Implemented`.
> **Release boundary:** the Phase 24.12 production gate is still open (`docs/quality/phase-24-12-release-review.md`,
> `docs/releases/2026-11-15-phase-24.md`). All Phase 25 evidence is **alpha/pilot only** (decision D7).
> **Decision boundary:** CaroCRM is single-tenant by design — one deployment serves one organisation.
> See `docs/reference/product-charter.md` §6 and `docs/security/tenancy-decision.md` §2. Nothing here
> proposes a tenant dimension, workspace, credits or a marketplace.

---

## 1. What "equivalent" means here

Functional parity for a **single installation** (D1, `docs/quality/phase-25-priority-decisions.md` §1),
not Twenty-shaped packaging. Twenty's skills/agents are documented **alpha** and its external MCP
declarations **beta, "not live yet"**; CaroCRM compares against shipped value, not a beta promise
(`https://docs.twenty.com/developers/extend/apps/logic/skills-and-agents.md`, re-fetched 25.0).

No owner override was recorded before 25.1, so all D1–D7 defaults stand. D2 is a deliberate, stricter
deviation: Twenty lets an autonomous run keep the agent's role (`runAsWorkspaceMemberId`); CaroCRM pins
the publisher/initiator so every run is attributable to a real user (25.2 makes this a pinned field).

**Keep these stronger-than-Twenty properties while adding parity:** fail-closed tool grants and
`MAX_TOOLS` validation at publish (`apps/api/src/ai-agents/ai-agent-config.ts:50,205`), bounded JSON
output revalidation (`validateBoundedJsonSchema`, `:454`), raw-SQL ACL predicates and deny-all on `*`,
VI/EN injection and ACL evals (`apps/api/test/crm-chat-evaluation.test.ts:761,934,958`), encrypted
provider keys (`encryptSecret`), SSRF refusal including redirects (`ai-provider-url.ts:44`),
version-pinned approvals, a deterministic fake provider, and trigger recursion/idempotency guards
(`runs/triggers.ts:58,179,200,296,375`).

## 2. Capability matrix

| # | Axis | CaroCRM — state and evidence | Twenty v2.59 — state and evidence | Target / owner | Status (25.1) / priority |
|---|---|---|---|---|---|
| 1 | Chat assistant | **Implemented and verified** at source level: contract v1.3.0, 27 implemented routes, 11 stream events and SSE resume (`apps/api/src/crm-chat/crm-chat-contract.ts:19,311-323`); 25 registered tool keys, 24 Chat-facing (`apps/api/test/ai-agent-runs.test.ts:351-387`); ACL revalidation and VI/EN evals. **No page context** (actor context only). | Chatbot with page context ("this company"/"this opportunity"), full data access and natural-language queries — **Live-verified 25.0/25.1** (`https://docs.twenty.com/user-guide/ai/capabilities/ai-chatbot.md`, `https://docs.twenty.com/user-guide/ai/overview.md`). Web search per model configuration — Live-verified 25.0. | Record/page context + grounded web results; keep the stronger eval/ACL story — 25.9 / 25.8 | **Partial** — P1 / P2 |
| 2 | Agent definition | **Implemented and verified**: 43 `.ts` files in `apps/api/src/ai-agents`; drafts, immutable versions, publish/pause/resume, approvals, memory, bounded JSON output (`MAX_SYSTEM_PROMPT_CHARS = 12_000`, `ai-agent-config.ts:21`) and 11 capability keys (`ai-agents-module.ts:30-41`). **No reusable skill records.** | `defineAgent()` / `defineSkill()` as code, custom prompt, `modelId`, structured JSON and native model tools — **alpha**, Live-verified 25.0 (`https://docs.twenty.com/developers/extend/apps/logic/skills-and-agents.md`). | In-product versioned skills; no code-defined agents — 25.4 | **Partial** — P1 |
| 3 | Agent triggers | **Partial**: `event` / `schedule` / `integration` / `record` kinds and idempotency/recursion/five-start guards exist (`apps/api/src/ai-agents/runs/triggers.ts:2,41,58,85-87,179,200,296,375`); event and schedule doors are feature-gated, both **default false** (`ai-agents-settings.service.ts:30-42`). **No watched-field or condition filters.** | `EVENT` with watched fields and `condition` including `previous.*`, plus `CRON` — Live-verified 25.0 (skills-and-agents.md). | Watched fields and conditions via the existing `@carocrm/formula` engine; document cron equivalence — 25.6 | **Partial** — P1 |
| 4 | Workflow AI | **Missing**: `WORKFLOW_ACTIONS` has exactly five actions — `updateRecord`, `createRecord`, `createNotification`, `sendEmail`, `runJob` — and no AI step (`packages/workflow/src/actions/index.ts:62-98`). The DB-free port seam exists (`packages/workflow/src/execute/index.ts:25-30`). | AI actions and autonomous agents inside workflows, with system agents created for AI steps — Live-verified (skills-and-agents.md, `https://docs.twenty.com/user-guide/ai/overview.md`). | One bounded `runAgent` action, pinned version, approval and idempotent retry — 25.5 | **Missing** — P1 |
| 5 | Multimodal input | **Missing** in chat and run input: zero attachment references in `apps/api/src/crm-chat` (25.0 absence scan). Voice transcription is a separate module (`apps/api/src/voice-communications/`) and is not a substitute. | `runAgent()` user messages accept ≤ 10 attachments from the `agent-chat` folder, fail-not-drop — Live-verified 25.0 (skills-and-agents.md). | Bounded image/PDF attachments, ACL-checked `fileId`, fake-provider tests — 25.7 (D5) | **Missing** — P2 |
| 6 | Web grounding | **Missing**: `docs_search` searches the local handbook only; zero `web_search` hits in source (25.0 absence scan). | Model-native `webSearch` / `twitterSearch` via `modelConfiguration` — Live-verified 25.0; AI web search is metered (`https://docs.twenty.com/user-guide/billing/capabilities/credits.md`, re-fetched 25.1). | One bounded, untrusted, cited search tool behind the existing SSRF guard; Twitter/X skipped — 25.8 (D6) | **Missing** — P2 |
| 7 | Providers | **Partial**: 24 presets in `ai-provider-presets.ts` (configuration, not adapters); 2 real adapters plus a test-only fake registered in `apps/api/src/ai-agents/index.ts:98-105`; Anthropic structured output is explicitly refused (`ai-provider-anthropic.ts:30,242-245`). No second AI SDK. | Built-in OpenAI, Anthropic, Google, Mistral and xAI on every self-hosted plan, plus custom OpenAI-compatible/private endpoints — **Live-verified 25.1** (`https://docs.twenty.com/user-guide/ai/how-tos/ai-faq.md`). 24 presets confirmed in our source; `key: '` count re-run 25.1. | Capability table per adapter/preset, Anthropic fallback, preset verification; no native adapters unless D4 is overridden — 25.3 | **Partial** — P1 |
| 8 | Permissions | **Partial**: synthetic AI capability entities through ACL (`ai-agents-module.ts:30-41`); event-trigger principal is the publisher by convention (`plans/SPEC.md:8`); no pinned principal in the published version and no agent-role binding (25.0 absence scan). | Assignable agent roles (`roleUniversalIdentifier`, `SystemPermissionFlag.AI`) and per-object read/write — Live-verified (`https://docs.twenty.com/user-guide/ai/capabilities/permissions-access-control.md`, re-fetched 25.1; skills-and-agents.md). Autonomous runs may keep the agent's role (`runAsWorkspaceMemberId`), a deliberate deviation from D2. | Explicit pinned execution principal, least-privilege profile and negative tests — 25.2 | **Partial** — P0 |
| 9 | Cost control | **Partial**: scoped atomic budgets (`forUpdate()`, `ai-agent-quota.service.ts:203,228`), soft `warnPercent` warnings (`:25,43`), model rates (`ai-agent-pricing.service.ts`) and per-run ceilings; migrations 045/048/049. **No installation-wide cost view.** | Workspace credits (1 credit = $1), personal weekly AI allowance, token-priced model calls and a per-action breakdown including model in Settings → Billing — **Live-verified 25.1** (`https://docs.twenty.com/user-guide/billing/capabilities/credits.md`, `https://docs.twenty.com/user-guide/billing/how-tos/billing-faq.md`). Corrected URL: the 25 plan's old `/billing/capabilities/credits.md` path 404s. | Installation-level usage/cost view and soft-limit warnings; **credits/billing are an explicit skip** — 25.10 | **Partial** — P1 |
| 10 | Evaluation | **Implemented and verified** at source level: deterministic graders, 24 tool cases × 2 languages × 3 assistants (`TOOLS_PER_ASSISTANT = 8`), injection, ACL-masking and hallucinated-citation negatives (`crm-chat-evaluation.test.ts:761,934,958`); `human_review` pending by design, `model_review` advisory (`ai-agent-evaluations.service.ts:25-26,139,145`). | SDK testing guidance exists; **no comparable published golden suite was found** in the primary sources reviewed (overview, AI FAQ, skills-and-agents, credits, billing FAQ) — `Hypothesis` (an absence claim, not a verified negative). | Versioned dataset and tool-routing accuracy threshold in the nightly DB-free gate — 25.11 | **Implemented, insufficiently verified** (model routing unproven) — P0 |
| 11 | MCP / extensions | **Implemented and verified**: shipped MCP-compatible tool door (`GET/POST /api/v1/AIAgents/action/mcp/tools|call`, `docs/reference/compatibility-matrix.md:364`), idempotent direct calls (19-AI.23), extension SDK with signed packages, and `modules/webhook-integration`. Model-backed retrieval stays deferred. | `defineMcpServer()` is **beta, "not live yet"** — Live-verified 25.0 (skills-and-agents.md). | Document the shipped adapter as an advantage; no new MCP surface without a live use case — 25.3 / 25.12 | **Implemented and verified** (protocol half) — P1 |
| 12 | Truthfulness | **Partial → corrected here.** G99's three drifts are fixed in 25.1: `plans/SPEC.md` tool ceiling and trigger status, the CRM Chat contract status line, and `docs/reference/compatibility-matrix.md` / `docs/reference/alpha-status.md` / README. Accepted posture: "Optional protected assistive use only" at `docs/compatibility/advanced-integrations.md:123`; model-backed retrieval deferred; `human_review` pending; Anthropic structured output is an open 25.3 gap. | Documentation is part of the product; no direct parity row — Documented. | One canonical matrix and honest skip list — 25.1 / 25.12 | **Fixed for G99; overall parity review remains Open** — P0 |

Summary: rows 1–3, 7–9 and 12 are **Partial** (real capability, named gap); rows 4–6 are **Missing**;
row 10 is **Implemented, insufficiently verified**; row 11 is **Implemented and verified** for the
protocol half. No row claims full Twenty parity. Feature-gated code is not claimed as enabled behaviour.

## 3. Twenty source log (all fetched 2026-11-18 unless noted)

| Source | State | Load-bearing facts used above |
|---|---|---|
| `https://docs.twenty.com/developers/extend/apps/logic/skills-and-agents.md` | Re-fetched in 25.0; carried forward | Alpha skills/agents; beta MCP not live; `defineSkill()`/`defineAgent()`; EVENT watched fields + `condition`; CRON; `runAgent()` attachments ≤ 10; `runAsWorkspaceMemberId`; native `webSearch`/`twitterSearch`; workflow AI steps. |
| `https://docs.twenty.com/user-guide/ai/capabilities/ai-chatbot.md` | Re-fetched in 25.0; carried forward | Page context, follow-ups, full data access, "Summarize my interactions with this person". |
| `https://docs.twenty.com/user-guide/ai/overview.md` | Re-fetched in 25.1 | Full data access, page context, AI actions and autonomous agents in workflows, role-based data access. |
| `https://docs.twenty.com/user-guide/ai/capabilities/permissions-access-control.md` | Re-fetched in 25.1 | Agent role assignment, auditability, workflow agents cannot exceed the assigned role. |
| `https://docs.twenty.com/user-guide/ai/how-tos/ai-faq.md` | Re-fetched in 25.1 | Built-in providers on self-hosted plans; custom providers; personal AI usage; agents operate under assigned roles. |
| `https://docs.twenty.com/getting-started/core-concepts/ai.md` | Re-fetched in 25.1 | Chatbot, autonomous multi-step agents, AI respects existing permissions. |
| `https://docs.twenty.com/user-guide/billing/capabilities/credits.md` | Re-fetched in 25.1 (corrected URL) | 1 credit = $1; token-priced calls at provider rates; per-action model breakdown in Settings → Billing; weekly personal allowance. |
| `https://docs.twenty.com/user-guide/billing/how-tos/billing-faq.md` | Re-fetched in 25.1 | Self-hosted free tier uses your own provider keys; cloud credits/allowance are plan features. |
| `https://github.com/twentyhq/twenty/releases/tag/sdk/v2.59.0` | Re-fetched in 25.1 | SDK v2.59.0 released 2026-11-16. |

No Twenty source was copied; this repository remains a clean-room implementation (AGENTS.MD §6).

## 4. Explicit skips — decision source: `docs/quality/phase-25-priority-decisions.md` §2

| Skip | Why it is not a parity gap in this release line |
|---|---|
| Credits, billing, per-seat personal AI allowance (D1) | Cloud-commerce surface; CaroCRM has scoped budgets, a token/cost ledger and hard quotas. 25.10 adds visibility, not a currency. |
| Workspace / multi-org agents, per-tenant AI memory or vector namespace, cross-customer retrieval | Permanent single-tenant boundary; `tenant_ref` in migration 056 is a provider-account label, not isolation. See charter/tenancy links above. |
| Hosted AI marketplace / app store (D1) | Packaging, not AI capability. |
| Vector database, embeddings, pgvector, rerank | 19-AI.18 model-backed retrieval deferral stands; reopening needs a new owner decision. |
| Twitter/X search (D6) | Twenty declares it; D6 excludes it from the single bounded search tool. |
| Code-defined agents/skills, model-chosen shell/SQL, `eval`, dynamic import | Named, schema-validated host actions only (`packages/workflow/src/actions/index.ts`); Phase 23 controls stay intact. |
| New native provider adapters | D4 default: presets + capability declarations + Anthropic fallback first; native adapters need an owner decision and a test vendor. |
| New MCP surface | Twenty's declaration is beta and not live; CaroCRM's shipped tool door is the documented advantage. |
| SCIM/SAML for AI roles, live vendor certification, a second ORM/SDK/CI provider or GraphQL | Standing scope and single-tenant decisions; nightly CI remains the only lane (G78). |
| Conversation sharing (chat D12) | `Accepted — not implemented` in `docs/architecture/crm-chat-contract.md:57`, owned by 25.9 if it ever gets an ACL design. |

Skipping a P2 row (25.7/25.8) still requires an explicit override note in the decision record and a
matrix row here — never a silent omission. No such override exists as of 25.1.

## 5. Drift register — G99 resolution and accepted exceptions

| Item | 25.1 disposition |
|---|---|
| SPEC `MAX_TOOLS` 24 vs code 32 | Corrected in `plans/SPEC.md` status line and §7.2; code is `apps/api/src/ai-agents/ai-agent-config.ts:50`. Historical changelog rows stay as history, with a note pointing here. |
| "Schedule/integration triggers not implemented" | Corrected in `plans/SPEC.md`, `docs/reference/compatibility-matrix.md` and `docs/reference/alpha-status.md`: implemented in 19-AI.25, feature-gated and default off. |
| CRM Chat contract status "through 19-CHAT.24" | Corrected to hardened through 19-CHAT.29; contract v1.3.0 and 27 routes were already consistent with code. |
| Tool counts 20/21/25 | Registry is 25 (15 built-ins + 10 contributions), 24 Chat-facing; `plans/SPEC.md:8,267` and this matrix agree. "21" and "20" remain only in dated changelog history. |
| "Optional protected assistive use only" | Accepted posture at `docs/compatibility/advanced-integrations.md:123`, cross-linked here; not a contradiction. |
| Model-backed retrieval deferred | Accepted; no vector store or second datastore was added. |
| `human_review` pending, `model_review` advisory | Accepted by design; 25.11 assigns an owner and review deadline. |
| Anthropic structured output refused | Open capability gap, owner 25.3; fallback or a G100+ exception with deadline. Do not relax `validateBoundedJsonSchema()`. |
| Twenty billing URL in the 25 plan | Corrected to `https://docs.twenty.com/user-guide/billing/capabilities/credits.md`; the old path returned Page Not Found on 2026-11-18. |

## 6. Verification recorded by 25.1

Source inventory re-run on 2026-11-18: 43 AIAgents `.ts` files, 23 CRMChat `.ts` files, a 1,491-line
executor, 24 presets, 27 chat routes, 24 eval tool cases, 97 migrations and `MAX_TOOLS = 32`. No
source file, migration, database row, provider account or release was changed by this sub-phase.
Documentation checks run and their results are recorded in `docs/quality/known-gaps.md` under G99.
Runtime behaviour of feature-gated surfaces remains verified as code, not as enabled behaviour;
executed parity evidence belongs to 25.11 and 25.12.
