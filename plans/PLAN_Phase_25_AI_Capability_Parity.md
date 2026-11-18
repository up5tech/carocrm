# PLAN — Phase 25: AI Capability Parity (Single-Tenant)

> **Status:** 25.0 delivered 2026-11-18 (`docs/quality/phase-25-ai-parity-baseline.md`, `docs/quality/phase-25-priority-decisions.md`; D1–D7 defaults applied, owner override window open until 25.1). No code, migration, database, provider account or release action is authorised by this document. Work continues at Phase 25.1.
> **Workstream type:** AI product parity and productisation of the existing AIAgents / CRM Chat engine. Not a new business module, not a security workstream, not a rewrite of the Entity Engine, and not a platform-DX race with Twenty.
> **Predecessor:** Phase 24 (`plans/PLAN_Phase_24_Product_Completion.md`) — product completion, 24.0–24.11 delivered, **24.12 release review in progress**; the release decision remains **NO-GO for production** (`docs/quality/phase-24-12-release-review.md`, `docs/releases/2026-11-15-phase-24.md`). Phase 25 does not reopen the 24.12 gate.
> **Comparison target:** Twenty CRM, SDK **v2.59.0** published 2026-11-16 (`sdk/v2.59.0`), plus the AI user-guide and developer documentation retrieved 2026-11-18. Twenty documents skills/agents as **alpha** and externally declared MCP servers as **beta, "not live yet"**; parity means matching *shipped* value, not copying a beta.
> **Target platform:** the existing NestJS / Fastify modular monolith, React SPA, PostgreSQL + Kysely, Redis/BullMQ worker, pnpm workspace, the `@carocrm/ai-agents` module, `@carocrm/crm-chat`, `@carocrm/workflow`, the extension SDK and the `api-spec/` registry.
> **Canonical workstream key:** `ai-parity`
> **Product decision (owner, 2026-11-13, reaffirmed here): CaroCRM is single-tenant by design — one deployment serves one organisation.** There is no workspace, tenant id, per-tenant AI context, cross-customer search, or hosted multi-tenant AI in this phase. Isolation between customers stays a deployment property (`docs/security/tenancy-decision.md` §2).
> **Scope baseline:** the repository as it exists on 2026-11-18. A plan, a capability list, a class name, a preset entry or a green build is **not** proof that a feature works. Cite a path and an executed test.
> **Naming rule:** no `Ua` prefix; no second ORM, query layer, validation framework, test runner, package manager, CI provider, API paradigm or AI SDK. No GraphQL. No duplicate contract or decision document.
> **Primary output:** an honest AI parity matrix, a workflow AI action, reusable skills, trigger parity, bounded multimodal input, web-search grounding, explicit agent principals, installation-level cost visibility, a golden evaluation gate, and a truthful go/no-go review.
> **Database policy:** follow `AGENTS.MD` §3 exactly. Use the configured primary database only. Never create a test database, shadow database, schema copy or per-agent/per-run database; never reset, truncate or broadly delete data. New migrations are additive and start at **098**.

---

## 0. Instructions for the Coding Agent

Read these before changing anything:

1. `AGENTS.MD` (§3 database policy, §4 workflow, §5 architecture, §6 clean-room compliance, §9 testing, §10 workspace safety, §11 definition of done).
2. `plans/PLAN.md` §43 (architecture), §48 (security), §57 (Development Phases), §58 (API inventory), §60 (compatibility matrix), §72 (priority matrix), and the Phase 19-AI, 23 and 24 sections of §57.
3. `plans/PLAN_Phase_19_AI_Agents.md` (especially §7 tool registry, §8 runtime, §9 approvals, §10 memory/retrieval, §12 quotas, §13 triggers, §24 hardening), `plans/PLAN_Phase_19_CRM_Chat.md`, `plans/PLAN_Phase_23_Security_Hardening.md` §0/§19/§21, and `plans/PLAN_Phase_24_Product_Completion.md` §0/§1.3/§19.
4. The current evidence pack: `docs/architecture/crm-chat-contract.md`, `docs/architecture/crm-chat-audit.md`, `docs/quality/known-gaps.md` (G1–G99; 25.0 filed G99 — new findings continue from **G100**), `docs/quality/phase-23-security-release-review.md`, `docs/quality/phase-24-12-release-review.md`, `docs/quality/ci-gates.md`, `docs/quality/test-strategy.md`, `docs/reference/compatibility-matrix.md`, `docs/reference/alpha-status.md`, `docs/reference/product-charter.md`, `docs/security/exception-register.md`, `README.md`.
5. Use the repository context tools (`trail ask ... --source`, `graphify query ...`) before broad greps, as required by `AGENTS.MD`. Include the same rule in any sub-agent prompt that explores code.

**Start with Phase 25.0 only.** Do not add an AI feature until the baseline matrix, the owner decisions and the parity boundary have been presented for review.

### 0.1 Non-negotiable rules

- **Single-tenant is a product boundary, not a backlog item.** No `tenant_id`, no per-tenant AI memory or vector namespace, no workspace/chat scope, no per-tenant API key, no cross-customer retrieval test. AI context is scoped to the installation, the requesting user, the agent and the CRM record ACL — nothing else. `tenant_ref` / `tenantRef` are provider-account labels (`database/migrations/056_phase19_advanced_integrations.sql`), not isolation fields; do not "clean them up".
- **No billing, credits or personal AI allowance.** Twenty's credit system is a cloud commerce feature and is deliberately out of scope. CaroCRM already has scoped budgets, token/cost ceilings and a usage ledger; Phase 25 makes those visible, it does not invent a currency.
- **No arbitrary code from a prompt, skill, agent config, workflow definition or tool output.** Continue the existing rule in `packages/workflow/src/actions/index.ts`: an action is a named, schema-validated capability with a host-side implementation. No `eval`, no dynamic import of model-chosen code, no shell, no raw SQL from a model.
- **Do not weaken Phase 23 controls.** Prompt injection defences (`promptSafe`, `boundRecord`), provider URL SSRF guards (`assertSafeProviderBaseUrl`), encrypted provider secrets, redaction, retention, audit and approval integrity stay as they are. Every new input — search results, attachment text, skill content, workflow payload — is **untrusted data**, never instruction.
- **ACL is revalidated at execution time.** A tool, citation, memory item, attachment or workflow AI step never inherits a broader grant than the requesting principal. No `sysAdmin` shortcut for an agent; an agent's effective principal is decided in 25.2 and pinned in the published version.
- **Keep the vendor-neutral provider contract.** `apps/api/src/ai-agents/ai-provider.ts` is the boundary. Do not add LangChain, the Vercel AI SDK, a second HTTP client or a vendor SDK as a dependency. Adapters use the repository's `fetch` convention and remain swappable. The deterministic fake provider is mandatory for tests.
- **Preserve work in flight.** `apps/api/src/ai-agents/` (43 files), `apps/api/src/crm-chat/` (23 files), `api-spec/`, the extension SDK and `webhook-integration` are existing surfaces. Extend them; do not fork or regenerate them. `runs/executor.ts` is ~1,491 lines against the documented 1,500-line ceiling in `plans/PLAN_Phase_19_AI_Agents.md` — split before growing it, or put new behaviour behind an existing port.
- **Do not chase Twenty's beta surface.** Twenty's `defineMcpServer()` is documented as beta and not live; CaroCRM already ships an MCP-compatible tool adapter (19-AI.18) and idempotent direct MCP calls (19-AI.23). Record the comparison honestly and do not overbuild to imitate an unavailable feature.
- **Nightly CI stays nightly (G78, owner decision accepted at 22.22).** Add DB-free coverage to the existing lane; do not create a second CI provider or a PR gate. Automated tests never contact a live model vendor, search provider, mailbox or customer.
- **Migrations are additive, reviewed and version-controlled** under `database/migrations/`, starting at 098, tracked in `schema_migrations`. No destructive migration, no editing migration history, no vector extension or second datastore without a new owner decision.
- **Report passed / failed / skipped / blocked honestly.** No claim of full Twenty parity or EspoCRM parity. If a capability cannot be verified without a live vendor or a production GO, mark it `Blocked`.

### 0.2 Assessment labels

Reuse the Phase 22–24 vocabulary: `Implemented and verified` · `Implemented, insufficiently verified` · `Partial` · `Missing` · `Blocked` · `Not applicable`. Add priority (`P0` / `P1` / `P2`) and disposition (`Open` / `Fixed` / `Accepted` / `Deferred` / `Hypothesis`).

### 0.3 Owner decisions required at 25.0

| ID | Decision | Default if the owner does not answer |
|---|---|---|
| D1 | What does "tương đương Twenty" mean: feature parity on the AI surface, or parity plus Twenty-shaped packaging (credits, workspace, app store)? | Functional parity for a single installation; **no** credits, workspace, marketplace or multi-org packaging. Record explicit skips in the matrix. |
| D2 | Which principal executes a workflow AI action or an agent trigger? | The workflow initiator or trigger publisher, never a wider service identity. Mutating tool grants still require approval; the published agent version is pinned. |
| D3 | Are skills defined in-product (versioned metadata) or only as TypeScript packages through the extension SDK? | In-product versioned skill records with API/UI administration; no new SDK surface and no code execution. Extensions may reference existing skills only. |
| D4 | How far to chase provider parity: native Google/Mistral/xAI adapters, or documented OpenAI-compatible preset coverage plus an Anthropic structured-output fallback? | Presets + capability declarations + Anthropic fallback first. New native adapters are P2 and need an explicit owner decision and test vendor. |
| D5 | Is bounded multimodal input (image/PDF in chat and `runAgent`) in scope, with the existing file storage? | Yes, bounded: at most 10 attachments per message, size/type allowlist, ACL-checked `fileId`, no live vision call in CI, fake provider returns deterministic text. |
| D6 | Is web search provider-native, operator-configured, or out of scope? | Provider-native where the adapter supports it; otherwise one operator-configured endpoint behind the existing SSRF guard. Twitter/X search stays out of scope. |
| D7 | May Phase 25 claim production readiness if 24.12 is still open? | **No.** Phase 25 produces alpha/pilot evidence only until 24.12 closes and its NO-GO blockers are resolved or owner-accepted. |

---

## 1. Purpose and Expected Outcome

Phase 23 made security controls verifiable. Phase 24 made the single-tenant product installable, integrable and honest about its release state. Phase 25 closes the gap between **"an AI engine exists"** and **"a CRM user can use AI in the same places they can in Twenty"**, without turning CaroCRM into a multi-tenant platform or a billing product.

### 1.1 Parity charter — what "equivalent or better" means here

| Axis | CaroCRM on 2026-11-18 (evidence) | Twenty v2.59 (documented) | Phase 25 target | Owner |
|---|---|---|---|---|
| Chat assistant | CRM Chat contract v1.3.0, 27 implemented routes, SSE resume, 25 tools, ACL revalidation, VI/EN injection evals | Chatbot with page context ("this company"), follow-ups, full data access, web search | Add page context and grounded web results; keep the stronger eval and ACL story | 25.9 / 25.8 |
| Agent definition | 43 files; drafts, versions, publish, pause/resume, approvals, memory, bounded JSON output, quotas, 11 capabilities | `defineAgent()`/`defineSkill()` as code (alpha), custom prompt, model id, structured JSON, native model tools | In-product versioned skills; keep existing version lifecycle; no code-defined agents | 25.4 |
| Agent triggers | `event` / `schedule` / `integration` / `record`, allowlists, cron, idempotency, recursion cap | `EVENT` with watched fields + condition expression, `CRON` | Add watched-field and condition filters using the existing formula engine | 25.6 |
| Workflow AI | **None.** `packages/workflow/src/actions/index.ts` lists 5 actions; no AI action | AI steps inside visual workflows: enrich, classify, summarise, custom prompt | One bounded `runAgent` workflow action with pinned version and approval | 25.5 |
| Multimodal input | **None** in chat/run; voice transcription is a separate module | `runAgent()` accepts up to 10 uploaded attachments in `agent-chat` | Bounded image/PDF attachments with ACL and fake-provider tests | 25.7 |
| Web grounding | `docs_search` searches local docs only; no web tool | Model-native web search / Twitter search; AI web search metered | One bounded, untrusted, cited web-search tool behind SSRF guard | 25.8 |
| Providers | 24 presets, 2 real adapters (OpenAI-compatible, Anthropic) + fake; no AI SDK | Built-in OpenAI, Anthropic, Google, Mistral, xAI + custom providers, all plans self-hosted | Declare capability coverage, fix Anthropic structured output, verify presets; native adapters only if D4 says so | 25.3 |
| Permissions | Synthetic AI capability entities through ACL; run as owner/publisher | Role assignable to agents, `SystemPermissionFlag.AI`, per-object read/write, row-level enforcement | Explicit agent execution principal, least-privilege role binding, documented matrix | 25.2 |
| Cost control | Scoped quotas, atomic budget policies, token/cost ledger, per-run ceilings | Credits, personal allowance, per-action model breakdown in Billing | Installation-level usage/cost view and warnings; **no** credits or billing | 25.10 |
| Evaluation | Deterministic graders, VI/EN injection & ACL suite, 24 tool cases × 2 languages × 3 assistants | SDK testing docs; no comparable published golden suite found | Golden dataset + tool-routing accuracy regression in the nightly gate | 25.11 |
| MCP / extensions | MCP-compatible tool adapter + idempotent direct calls; extension SDK + signed packages; `webhook-integration` | `defineMcpServer()` declared but **beta, not live**; skills/agents alpha | Document the advantage; no new MCP surface unless a live use case is proven | 25.3 / 25.12 |
| Truthfulness | `docs/compatibility/advanced-integrations.md:123` says "Optional protected assistive use only"; contract doc version matches code (1.3.0) but its status line still says "through 19-CHAT.24"; `plans/SPEC.md` documents `MAX_TOOLS` 24 while code allows 32 (registry: 25 tools); SPEC/compatibility-matrix call schedule/integration triggers "not implemented" though the doors shipped gated (19-AI.25) | Documentation is part of the product | One AI capability matrix, corrected versions/counts, honest parity claims | 25.1 / 25.12 |

**Better than Twenty, and keep it:** fail-closed tool grants, raw-SQL ACL predicates, deny-all on `*`, prompt-injection evals in VI and EN, encrypted provider keys, approval integrity, deterministic fake provider, and a single-tenant installation where every AI action is attributable to a real user.

### 1.2 Boundary with Phase 23 and Phase 24

- Phase 23 owns `docs/security/*`, the exception register, the §48 controls and the security regression suite. Phase 25 consumes them. A new security finding is filed in `docs/quality/known-gaps.md` starting at **G99** and dispositioned by the owner; it is not silently accepted here.
- Phase 24 owns the single-tenant charter, production installation, `api-spec/`, typed client, outbound events and UX completion. Phase 25 consumes those surfaces: new AI endpoints are registered in `api-spec/` and exercised through the typed client where in scope; no second contract, no GraphQL, no `plan/apply` CLI.
- 24.12 remains the release gate. Phase 25's review is an **AI capability** review, not a second production go/no-go.

### 1.3 Out of scope for this release line

Credits, billing, per-seat personal AI allowance, workspace or multi-org agents, SCIM/SAML for AI roles, per-tenant retrieval, a hosted AI marketplace, vector database or embedding pipeline (the 19-AI.18 model-backed retrieval deferral stands unless D4/D1 are reopened), arbitrary code execution from models, live vendor certification, and any claim that a beta Twenty feature is a parity requirement.

---

## 2. Baseline Inventory (2026-11-18)

Facts to verify again at 25.0; do not treat this section as an audit outcome.

- **Runtime:** `apps/api/src/ai-agents/runs/executor.ts` (~1,491 lines) owns the step loop, token/cost/step ceilings and prompt assembly; `runs/lifecycle.ts`, `runs/triggers.ts`, `runs/base.ts`, `runs/shared.ts` split the rest. `ai-agent-config.ts` enforces hard ceilings and a bounded JSON output schema (`mode: 'text' | 'json'`); `validateBoundedJsonSchema()` re-checks model output.
- **Providers:** `ai-provider.ts` is the vendor-neutral contract; only `ai-provider-openai-compatible.ts` and `ai-provider-anthropic.ts` are registered in `index.ts`, plus the test-only fake. `ai-provider-gateway.service.ts` routes and meters calls. `ai-provider-presets.ts` defines 24 presets including Gemini, Mistral, xAI, Ollama and vLLM — presets are configuration, not adapters. `ai-provider-anthropic.ts:30,242-245` documents that structured output is **not supported** by that adapter.
- **Tools:** 25 registered keys — 15 built-ins in `ai-agent-tools.ts` / `tools/{read,write,schemas}.ts`, 10 contributions from Sales, Projects, ServiceDesk, CustomerSuccess, Marketing Automation, LeadScore, Omnichannel, CRMChat and AIAgents. Per-agent `MAX_TOOLS` is 32 (`ai-agent-config.ts:50`, raised from 24). `plans/SPEC.md` correctly notes 24 Chat-facing tools / registry 25 but still documents `MAX_TOOLS` 24 (stale); `apps/api/test/ai-agent-runs.test.ts` enumerates 25 (24 Chat-facing + `omnichannel.send_message`).
- **Chat:** `apps/api/src/crm-chat/crm-chat-contract.ts:19` declares v1.3.0 with 27 implemented routes and 11 stream events; `docs/architecture/crm-chat-contract.md` already carries version 1.3.0, but line 5 still says "implemented in full through 19-CHAT.24". Eight UI suggestion chips use `requiresTool` in `apps/web/src/pages/crm-chat/CRMChatSuggestions.tsx`; page context and sharing (D12) are not implemented.
- **Workflow:** `packages/workflow/src/actions/index.ts:62-98` lists `updateRecord`, `createRecord`, `createNotification`, `sendEmail`, `runJob`. No AI action; the executor is pure and DB-free behind `WorkflowExecutorPorts`, which is the right seam for 25.5.
- **Trigger doors:** event/schedule/integration shipped (19-AI.25, `runs/triggers.ts`) behind `features.eventTriggers`/`scheduledTriggers`, both default `false` (`ai-agents-settings.service.ts:30-42`); a `record` kind exists in config. SPEC and the compatibility matrix still say "not implemented" — stale wording, G99.
- **Quotas:** `ai-agent-quota.service.ts` enforces scoped, atomic budget policies (`ai_agent_budget_policies`, migrations 045/049; 048 adds pricing snapshots and quotas) with soft warnings; `ai-agent-pricing.service.ts` holds model rates. There is no installation-wide cost view comparable to Twenty's Billing breakdown.
- **Evals:** `apps/api/test/crm-chat-evaluation.test.ts` covers VI/EN, prompt injection through notes/email/attachments, ACL masking and hallucinated citations; graders are deterministic only, with `human_review` pending and `model_review` advisory in `ai-agent-evaluations.service.ts`.
- **Security:** `encryptSecret/decryptSecret` for provider keys, `assertSafeProviderBaseUrl` with redirect refusal and documented DNS-rebinding residual, `promptSafe`, `boundRecord` (untrusted marker, 2,000-char truncation), version-pinned approvals, `audit_log`. Phase 23 hardened injection/SSRF/rotation; do not re-litigate.
- **Adjacent AI:** deterministic lead scoring with an off-by-default AI explanation (19-LS.17), voice transcription adapters, `crm_draft_email`, `crm_record_summary`. No embedding, pgvector, rerank or AI workflow step.
- **Open gaps:** G34/G38/G39/G61/G62/G72/G95 are Fixed. 25.0 filed **G99** (AI documentation drift: SPEC `MAX_TOOLS` 24 vs code 32, trigger-door "not implemented" wording, chat contract status line); new findings continue from **G100**.

---

## 3. Reference Documents and Standards

- `plans/PLAN.md` §35 (workflows), §43, §48, §57, §58, §60, §72; `plans/PLAN_Phase_19_AI_Agents.md`, `plans/PLAN_Phase_19_CRM_Chat.md`, `plans/PLAN_Phase_23_Security_Hardening.md`, `plans/PLAN_Phase_24_Product_Completion.md`.
- `AGENTS.MD`, `docs/quality/test-strategy.md`, `docs/quality/ci-gates.md`, `docs/quality/known-gaps.md`, `docs/security/exception-register.md`, `docs/security/tenancy-decision.md`.
- `docs/architecture/crm-chat-contract.md`, `docs/architecture/crm-chat-audit.md`, `docs/architecture/contract-catalog.md`, `api-spec/README.md`.
- `docs/reference/compatibility-matrix.md`, `docs/reference/alpha-status.md`, `docs/reference/product-charter.md`, `README.md`, `CHANGELOG.md`.
- Twenty primary sources consulted for the target: `https://docs.twenty.com/getting-started/core-concepts/ai.md`, `https://docs.twenty.com/user-guide/ai/overview.md`, `.../ai/capabilities/ai-chatbot.md`, `.../ai/capabilities/ai-agents.md`, `.../ai/capabilities/permissions-access-control.md`, `.../ai/how-tos/ai-faq.md`, `.../billing/capabilities/credits.md`, `https://docs.twenty.com/developers/extend/apps/logic/skills-and-agents.md`, and GitHub release `sdk/v2.59.0`. Re-check before 25.1; if Twenty changes the target, update the matrix, not the claims. At 25.1 the billing path was corrected to `https://docs.twenty.com/user-guide/billing/capabilities/credits.md` (the old path returned Page Not Found on 2026-11-18).

---

## 4. Governance and Artifacts

### 4.1 New deliverables

1. `docs/architecture/ai-capability-matrix.md` — one canonical parity table: capability, CaroCRM evidence path, Twenty v2.59 evidence URL, target, owner sub-phase, status. This is the only AI parity document.
2. `docs/quality/phase-25-ai-parity-baseline.md` — the 25.0 read-only audit: tool inventory, provider capability table, chat contract drift, workflow gaps, eval coverage, open questions D1–D7.
3. `docs/quality/phase-25-priority-decisions.md` — owner decisions, priority rationale and the explicit skip list (credits, workspace, marketplace, multi-tenant retrieval).
4. `docs/quality/phase-25-eval-evidence.md` — commands run, golden dataset version, tool-routing accuracy, injection/ACL results, skipped checks and blocked vendor checks.
5. `docs/quality/phase-25-release-review.md` — AI capability go/no-go, residual risks and owners. Not a second production release decision.
6. Schema additions from **098** onward for skills, workflow AI step metadata, attachment references and any agent-principal field. Additive only.
7. Automated tests in the existing conventions: `apps/api/test/` files named `phase25-*.test.ts`, `packages/workflow/src/**/*.test.ts`, `apps/web` suites, and `e2e/*.spec.ts` only where a browser check is genuinely needed.

### 4.2 Documents to update, not duplicate

`plans/PLAN.md` §57 (the Phase 25 entry already exists — keep it current), `plans/SPEC.md` (stale `MAX_TOOLS`), `docs/quality/known-gaps.md` (new gaps from G99), `docs/architecture/crm-chat-contract.md` (status wording and D12 status), `docs/architecture/crm-chat-audit.md`, `docs/reference/compatibility-matrix.md`, `docs/reference/alpha-status.md`, `README.md`, `CHANGELOG.md`, API inventory in `api-spec/`, and the existing AI module docs. Do not create a second AI design document or a parallel runbook directory.

### 4.3 Defect tracking

Files created in Phase 25 may be incomplete; record them in `docs/quality/known-gaps.md` in the same pass. Do not mark a gap Fixed on the strength of a plan or a green unit test alone — name the executed verification.

---

## 5. Priority Definitions and Roadmap Overview

- **P0 — prerequisite / safety:** must be done before AI capability work is credible; blocks claims, not necessarily code.
- **P1 — parity capability:** shipped value that Twenty has and CaroCRM lacks, achievable inside the existing architecture.
- **P2 — depth and polish:** raises quality or coverage; may be deferred without invalidating the parity claim if the matrix documents the skip.

| ID | Sub-phase | Priority | Primary output |
|---|---|---|---|
| 25.0 | Baseline audit and parity reconciliation | P0 | **Delivered 2026-11-18** — `docs/quality/phase-25-ai-parity-baseline.md`, D1–D7 defaults in `docs/quality/phase-25-priority-decisions.md`, G99 filed; no code changes |
| 25.1 | AI charter and documentation truthfulness | P0 | Canonical parity doc, corrected versions/counts, explicit skips |
| 25.2 | Agent principal and least privilege | P0 | Pinned execution principal, role binding, permission matrix, tests |
| 25.3 | Provider capability parity | P1 | Adapter/preset capability table, Anthropic structured-output fallback, no new SDK |
| 25.4 | Reusable versioned skills | P1 | Skill metadata, admin API/UI, agent binding, no code execution |
| 25.5 | Workflow AI action | P1 | Bounded `runAgent` action in `WORKFLOW_ACTIONS`, worker port, approval path |
| 25.6 | Trigger parity: watched fields and conditions | P1 | Event filters and cron parity, loop guard, idempotency evidence |
| 25.7 | Bounded multimodal input | P2 | Image/PDF attachments for chat and runs, ACL and fake-provider tests |
| 25.8 | Grounded web search | P2 | One bounded search tool, untrusted citation handling, cost/SSRF guard |
| 25.9 | CRM Chat page context and UX parity | P1 | Record/page context, skill picker, contract drift fixed, sharing decision |
| 25.10 | Installation-level cost and usage visibility | P1 | Per-agent/run/category cost view, soft-limit warnings, no billing |
| 25.11 | Golden evaluations and regression gate | P0 | Versioned dataset, tool-routing accuracy, nightly DB-free coverage |
| 25.12 | AI capability review and go/no-go | P0 | Evidence, residual risks, honest AI-only decision |

### 5.1 Dependencies and stop rules

- 25.0 gates everything. 25.1 gates all documentation claims. 25.2 gates 25.5 and 25.6 (a run without a defined principal is not safe to automate).
- 25.5 depends on `packages/workflow` executor ports and the 25.2 principal decision; implement the action spec before the worker implementation so validation can be tested DB-free.
- 25.7 and 25.8 are P2 and may be skipped only by an explicit D5/D6 decision recorded in 25.1.
- 25.11 must exist before 25.4, 25.7, 25.8 or 25.9 can claim no injection, ACL or tool-routing regression.
- Stop and file a G99+ gap if a task requires a live vendor, a new tenant dimension, arbitrary code execution, a destructive migration, or weakening a Phase 23 control.

---

## 6. Phase 25.0 — Baseline Audit and Parity Reconciliation (P0)

### Objective

Turn the repository and Twenty's shipped AI surface into one verifiable matrix, resolve D1–D7, and identify contradictions before writing code.

### Tasks

1. Re-run the inventory in §2: count AI source files, registered tool keys (source of truth: registry `list()` plus the test enumeration), routes, presets, adapters, eval cases and migrations. Record commands and output paths.
2. Verify every claim in the §1.1 table with a path or a primary-source URL. Mark unverifiable items `Hypothesis`, not `Implemented`.
3. Resolve the documented drift: chat contract status wording ("through 19-CHAT.24") vs the implemented 27-route set; `plans/SPEC.md` `MAX_TOOLS` 24 vs code 32; registry count 25; SPEC/compatibility-matrix "schedule/integration triggers not implemented" vs the shipped, feature-gated doors (19-AI.25, default off); `plans/PLAN_Phase_19_AI_Agents.md` "model-backed retrieval stays deferred"; `human_review` pending; Anthropic structured output unsupported; "Optional protected assistive use only" in `docs/compatibility/advanced-integrations.md:123`.
4. Confirm that no workflow action, web-search tool, attachment path, skill entity or agent-role binding exists. Absence is a finding, not an assumption.
5. Confirm Phase 24.12 status and that no production go/no-go can be implied by this phase.
6. Present D1–D7 and the skip list; get owner answers or record the defaults.

### Acceptance criteria

- `docs/quality/phase-25-ai-parity-baseline.md` contains a capability row for every axis in §1.1 with evidence, status and owner sub-phase.
- Every contradiction in task 3 has a disposition (correct in 25.1, file a G-ID, or accept with an owner).
- No source file, migration, database row or provider account was changed.

---

## 7. Phase 25.1 — AI Charter and Documentation Truthfulness (P0)

### Objective

Make one canonical statement of what CaroCRM's AI is, is not, and deliberately will not copy from Twenty.

### Tasks

1. Create `docs/architecture/ai-capability-matrix.md` from the 25.0 baseline. Include Twenty's alpha/beta caveats and the explicit skips: credits/billing, workspace/multi-org, marketplace, personal AI allowance, per-tenant retrieval.
2. Correct `docs/architecture/crm-chat-contract.md` status wording (the version already agrees with code at 1.3.0); correct the stale `MAX_TOOLS` in `plans/SPEC.md` and any tool counts in the docs that carry them; update `docs/reference/compatibility-matrix.md`, `docs/reference/alpha-status.md` and `README.md`.
3. Record the single-tenant AI boundary in the matrix and cross-link `docs/reference/product-charter.md` and `docs/security/tenancy-decision.md`. No new decision document.
4. Add a `CHANGELOG.md` entry that describes AI parity as in progress, not complete.

### Acceptance criteria

- A reader can find every AI claim in the matrix and trace it to a path or URL; no other document contradicts it.
- `node scripts/check-ui-conventions.mjs` and the docs lint pass.
- No capability is described as shipped without an executed verification or an explicit `Hypothesis` label.

---

## 8. Phase 25.2 — Agent Principal and Least Privilege (P0)

### Objective

Make "who is this agent acting as?" an explicit, pinned, testable part of a published agent — the CaroCRM answer to Twenty's assignable agent roles and `SystemPermissionFlag.AI`.

### Tasks

1. Decide and implement the execution principal for: manual run, event trigger, schedule trigger, integration trigger, CRM Chat, and workflow AI action (25.5). Default: the requesting user or trigger publisher; no broader service identity.
2. Store the principal rule in the published agent version so a change requires a new version, not a silent policy shift. Add an additive migration only if the existing version config cannot carry it.
3. Map existing AI capabilities (`use`, `manageDraft`, `publish`, `lifecycle`, `toolAdmin`, `policyAdmin`, `providerAdmin`, `approval`, `audit`, `usage`, `evaluation` — 11 keys in `ai-agents-module.ts:30-41`) to a documented least-privilege profile, including the synthetic ACL resource/action pairs. Do not grant `*` by default.
4. Add negative tests: an agent run with a revoked user, a tool call outside the grant, a field-masked record, an approval by the agent itself, and a citation to a record the principal cannot read.

### Acceptance criteria

- Every run event records the effective principal and the pinned version; audit entries are attributable to a real user.
- No path lets an agent escalate beyond its publisher or the workflow initiator. No `sysAdmin` bypass test passes.
- The permission matrix is in `docs/architecture/ai-capability-matrix.md`; new gaps start at G99.

---

## 9. Phase 25.3 — Provider Capability Parity (P1)

### Objective

Match Twenty's *usable* provider breadth without adding a second AI framework, and close the one documented adapter gap.

### Tasks

1. Publish a capability table per adapter/preset: chat, tools, structured output, streaming, context size, image input, native web search. Derive it from `ai-provider.ts` capabilities and test it, not from marketing names.
2. Implement an Anthropic structured-output fallback that keeps the same validated bounded schema (e.g. tool-call-based extraction inside the adapter), or record a G99+ gap with an owner and deadline if it cannot be made reliable. Do not relax `validateBoundedJsonSchema()`.
3. Verify the OpenAI-compatible adapter against at least one non-OpenAI preset using the fake/local-compatible seam; no live vendor calls. Document which presets are expected to work and which are untested.
4. Document the MCP position: CaroCRM's adapter is shipped, Twenty's external MCP declaration is beta and not live. No new MCP surface in this phase.
5. If D4 funds a native Google/Mistral/xAI adapter, add one adapter behind the existing contract with fake-provider tests and a documented capability row; otherwise mark the skip in the matrix.

### Acceptance criteria

- A model call asking for structured output behaves identically across registered adapters, or fails with a clear capability error and a documented exception.
- No new runtime dependency in any `package.json`; `pnpm-lock.yaml` changes only if D4 is approved.
- Provider secrets remain encrypted and write-only in the UI; no secret appears in logs or test output.

---

## 10. Phase 25.4 — Reusable Versioned Skills (P1)

### Objective

Give CaroCRM the useful half of Twenty's `defineSkill()`: reusable, versioned instructions that several agents can share — without executing code.

### Tasks

1. Add an additive skill definition table (from 098) with stable key, label, description, bounded instruction text, version, status (draft/published/archived), owner and ACL resource. No arbitrary script field.
2. Add CRUD/publish endpoints in the existing AIAgents controller, register them in `api-spec/`, and provide a minimal React administration surface using the existing CSS kit and i18n keys.
3. Let a published agent version bind zero or more published skills; compose them into the system prompt within `MAX_SYSTEM_PROMPT_CHARS`, with deterministic ordering and a visible transcript of which skills were applied.
4. Validate skill content as untrusted text: no instruction priority above the system rules, length bound, prompt-injection eval coverage, ACL check on read/write. Reject a skill that would push the prompt past the hard ceiling.
5. Add migration, unit tests, ACL tests and one browser spec for publish/bind if genuinely needed.

### Acceptance criteria

- Two agents can reference the same published skill; editing a draft cannot change a running published agent.
- Skill text cannot override tool grants, approval policy or output schema; injection eval suite from 25.11 passes.
- No code execution surface, no new SDK package, no second admin UI pattern.

---

## 11. Phase 25.5 — Workflow AI Action (P1)

### Objective

Close the clearest parity gap: Twenty has AI steps inside workflows; CaroCRM's `WORKFLOW_ACTIONS` has none.

### Tasks

1. Add one action spec to `packages/workflow/src/actions/index.ts`: strict params for published agent id, input template, optional skill ids, output mapping and approval expectation. `mutatesRecords` is `true` because the agent may use write tools; document that in the catalog.
2. Keep the executor DB-free. Implement the action in the existing worker-side `WorkflowExecutorPorts.runAction` host, calling the AIAgents run service through its public API with the principal from 25.2, the pinned published version and an idempotency key derived from `runId:nodeId`.
3. Respect the existing workflow run-step ledger: a retried workflow must reuse the completed AI step, not start a second model run. A long run parks the workflow; an agent approval resumes it through the existing approval flow.
4. Bound output: validate `json` mode against the bounded schema before mapping into record fields; reject oversized or malformed output; never interpolate model text into a formula or shell context.
5. Add DB-free validation tests (unknown action, bad params, cycle, oversized output) and one integration test using the fake provider and an `AGENT_TEST_` record.

### Acceptance criteria

- A workflow definition can call a published agent, and the run appears in the agent's run history with trigger provenance and a workflow causation id.
- A redelivered queue item does not create a duplicate run or duplicate record write.
- No arbitrary code, no new action without a host implementation, no bypass of approval or ACL.

---

## 12. Phase 25.6 — Trigger Parity: Watched Fields and Conditions (P1)

### Objective

Match Twenty's `EVENT` trigger supervision (object, action, watched fields, condition) using CaroCRM's existing event/schedule doors.

### Tasks

1. Extend the agent trigger config with a bounded watched-field list and a condition expression evaluated by the existing `@carocrm/formula` engine. Reuse the sandboxed formula semantics already used by workflow condition nodes; do not add an expression language.
2. Apply filters in `apps/api/src/ai-agents/runs/triggers.ts` before a run starts: entity type, event type, watched fields and condition on both current and previous values. Keep the existing five-starts-per-event cap and recursion depth limit.
3. Keep the principal rule from 25.2 and the `evt:<eventId>:<agentId>` idempotency key. Add tests for no-op re-delivery, loop suppression (agent updates its own trigger field), and condition false on unchanged fields.
4. Document cron parity: CaroCRM already validates cron expressions and deduplicates scheduler firings; record equivalence with Twenty's `CRON` trigger and any gap in timezone handling.

### Acceptance criteria

- A trigger fires only on the watched field transition and condition match; an agent-caused update cannot re-trigger itself.
- Trigger runs remain attributable, idempotent and capped; no new background worker topology.

---

## 13. Phase 25.7 — Bounded Multimodal Input (P2)

### Objective

Support the useful shape of Twenty's `runAgent()` attachments without turning the CRM into an image pipeline.

### Tasks

1. Add optional attachments to CRM Chat composer input and to the AIAgents run input DTO: a list of already-uploaded `fileId`s under the installation's existing file storage. Enforce D5 bounds: at most 10 per message, type allowlist (PNG/JPEG/PDF), size cap, and ACL check that the requesting user may read the file.
2. Pass attachment metadata through the vendor-neutral provider contract as a capability-gated field. Adapters that do not support image input must fail clearly, not silently drop the file.
3. Use the deterministic fake provider for all tests: it returns a stable text description and records the attachment ids. No live vision call in CI, no third-party OCR dependency.
4. Treat extracted/attached text as untrusted data through `boundRecord`; add injection cases where an image carries prompt-like text in its metadata or PDF text layer.
5. Add an additive migration only if run input is not already persisted in a JSON column; prefer reusing the existing message/run payload storage.

### Acceptance criteria

- A user can attach a file in chat and see it associated with the run; a revoked file ACL blocks the run before any model call.
- No file is sent to a vendor in automated tests; no new storage backend; no unbounded file type or size.

---

## 14. Phase 25.8 — Grounded Web Search (P2)

### Objective

Match Twenty's most visible chat differentiator: answers grounded in current external information, with honest citations.

### Tasks

1. Add one `web_search` tool to the registry (or enable provider-native web search behind the existing capability flag). Operator-configured endpoints must pass `assertSafeProviderBaseUrl`; no arbitrary URL from a model or a CRM field.
2. Bound the tool: query length, result count, snippet length, timeout, per-run and per-installation cost accounting through the existing quota/budget service. Fail closed when unconfigured.
3. Label every result untrusted; pass snippets through `promptSafe`/`boundRecord` semantics. A citation must include the source URL and retrieval time; a model that cites without a tool result is a hallucination case in the eval suite.
4. Add fake search fixtures for CI. No live search API call in tests. Document provider options and the Twitter/X skip in `docs/architecture/ai-capability-matrix.md`.
5. Add a G99+ gap if D6 chooses "out of scope" rather than silently omitting the capability.

### Acceptance criteria

- With no search configured, chat still works and `web_search` is absent or fails clearly; with fake fixtures, answers carry verifiable citations.
- No SSRF regression: metadata endpoints, private ranges and redirects are refused.
- Search cost appears in the usage ledger under the same run.

---

## 15. Phase 25.9 — CRM Chat Page Context and UX Parity (P1)

### Objective

Close the chat experience gap: Twenty understands "this company" / "this opportunity" from the current page; CaroCRM has actor context but no page context.

### Tasks

1. Add an optional page context payload to the chat composer: current route, entity type and record id, resolved server-side into a bounded record summary via `crm_actor_context` / `crm_read_record` semantics. The client sends identifiers, not model text.
2. Revalidate ACL for the page record on every turn; if the user cannot read it, drop the context and say so. No cross-record context leak through SSE resume or shared links.
3. Fix the contract drift: correct the status wording and route count in `docs/architecture/crm-chat-contract.md` (its version already agrees with `crm-chat-contract.ts` at 1.3.0); record D12 (conversation sharing) as `Accepted — not implemented` or implement it with its own ACL design — no silent claim.
4. Refresh suggestion chips and skill picker from the developer-facing tool list; keep the `requiresTool` filtering honest so a chip never advertises a grant the assistant lacks.
5. Add browser coverage for page context, context drop on ACL denial, and SSE resume with `Last-Event-ID`.

### Acceptance criteria

- "Summarize my interactions with this person" works from a contact page and is refused from an unrelated page.
- Contract version, documented version and implemented route set agree; no chip promises a missing tool.
- Injection and ACL evals from 25.11 still pass with page context enabled.

---

## 16. Phase 25.10 — Installation-Level Cost and Usage Visibility (P1)

### Objective

Provide the useful part of Twenty's Billing breakdown — per-action model and cost attribution — without credits or billing in a single-tenant installation.

### Tasks

1. Build an admin usage view over the existing provider ledger and run counters: cost and tokens by agent, trigger type, model, time window and installation total. Reuse `ai-agent-pricing.service.ts` and `ai-agent-quota.service.ts`; do not create a second ledger.
2. Surface soft-limit warnings (`warnPercent`) before a hard quota stops work, in the existing notification/UI patterns. Keep hard limits fail-closed.
3. Show provider and model identifiers, not secrets. Add i18n keys for `en` and `vi` only, following `carocrm.css` conventions.
4. Register any new endpoints in `api-spec/`. Add tests for aggregation correctness, soft-warning timing and redaction of credential data.

### Acceptance criteria

- An operator can answer "which agent/model spent what this month" from the UI and from an exported view.
- No credit balance, no per-seat allowance, no payment flow, no new billing table.
- Hard quota enforcement remains atomic and unchanged.

---

## 17. Phase 25.11 — Golden Evaluations and Regression Gate (P0)

### Objective

Make AI parity claims testable. Twenty publishes SDK testing guidance; CaroCRM should have a stronger, deterministic golden suite for its own contract.

### Tasks

1. Version a golden dataset in the repository: VI and EN prompts for search, summary, aggregate, report, cross-module and chat page-context cases, plus negative cases (prompt injection, ACL masked field, hallucinated citation, unknown tool, oversized output).
2. Extend `apps/api/test/crm-chat-evaluation.test.ts` style coverage to workflow AI actions, skills, triggers and web-search citations, all through the fake provider. Assert tool selection, not just final text.
3. Define tool-routing accuracy as a measurable metric with a baseline and a non-decreasing threshold. A regression that routes to a write tool on a read-only prompt fails the existing nightly DB-free gate.
4. Add `human_review` disposition for cases a deterministic grader cannot judge, with an owner and a review deadline; keep `model_review` advisory and billable-free.
5. Record commands, counts and results in `docs/quality/phase-25-eval-evidence.md`. Do not add a second test runner or CI provider; G78 stands.

### Acceptance criteria

- The dataset version, threshold and results are reproducible from a documented command with no network.
- A deliberately broken tool grant is detected by the gate before it reaches a release review.
- No live model call, no real customer record, no test database.

---

## 18. Phase 25.12 — AI Capability Review and Go/No-Go (P0)

### Objective

Report what is now at parity, what is better, what is deliberately skipped and what remains blocked.

### Tasks

1. Re-run `pnpm ci:gate` and `pnpm ci:api-spec --strict` (if new endpoints were added), the eval command from 25.11 and the focused integration/browser specs; record results and skipped/blocked checks.
2. Verify each row of `docs/architecture/ai-capability-matrix.md` against an executed test or an owner-accepted skip. Delete or downgrade any claim that cannot be verified.
3. Verify no AI feature introduced a tenant dimension, billing surface, arbitrary code path, live vendor call, weakened Phase 23 control or extra database.
4. Confirm 24.12 status. If the production gate is still open, the AI review says so explicitly and grants **alpha/pilot only**.
5. Update `plans/PLAN.md` §57, `docs/quality/known-gaps.md`, `CHANGELOG.md` and the release notes truthfully.

### Acceptance criteria

- `docs/quality/phase-25-release-review.md` contains an evidence-linked status for every matrix row, residual P1/P2 risks with owners, and an honest go/no-go for **AI capability only**.
- No claim of full Twenty parity or production readiness without the corresponding gate.

---

## 19. Verification Constraints and Environment

Follow the repository rules; these are reminders, not new policy.

- Run `pnpm install && pnpm build` before typecheck or tests where workspace packages resolve via `dist/`.
- Run one test file per `pnpm vitest run` invocation; use the configured primary database under `AGENTS.MD` §3 for integration tests, with `AGENT_TEST_` markers, unique values and exact-ID cleanup.
- Mail/queue suites need `MAIL_TRANSPORT=memory` and `SMTP_FROM` before boot, restored in `afterAll`; stub BullMQ.
- Playwright runs with `no_proxy='*' NO_PROXY='*'`; move an existing `test-results` aside before re-running (the repo has a >50-file delete guard).
- Model, search and vendor integrations must use the fake provider or fixtures. No billable call in CI. Never print provider keys, database URLs or tokens.
- `pnpm ci:gate` and `pnpm ci:api-spec --strict` are the existing gates; CI remains nightly-only (G78). Do not add a second lane.
- Docs/UI conventions: `node scripts/check-ui-conventions.mjs`; `pnpm lint:ui`; i18n keys for `en`/`vi`; no raw `<Empty>`, no `.slice(0,19)` timestamps, no internal `<a href="/…">`.
- Web build to a temporary outDir if `emptyDir(dist)` fails. Report every skipped or blocked check, with the reason.

---

## 20. Definition of Done

Phase 25 is done when:

1. `docs/architecture/ai-capability-matrix.md` is the single source of truth and every row is verified or explicitly skipped.
2. A published agent can be invoked from chat, a scheduled/event trigger and a workflow AI step under one explicit, least-privilege principal.
3. Skills are versioned, non-executable and safe under the injection suite; structured output behaves consistently across registered adapters or has a signed exception.
4. Page context, bounded attachments and grounded web search are delivered or owner-skipped in the matrix, with evals proving no ACL or injection regression.
5. An operator can see per-agent/model cost and quota warnings without a billing system.
6. `docs/quality/phase-25-eval-evidence.md` and `docs/quality/phase-25-release-review.md` record executed commands, metrics, residual risks and an honest alpha/pilot-only decision while 24.12 remains open.
7. No second API paradigm, tenant dimension, arbitrary code path, live vendor dependency, test database or destructive migration was introduced.

Anything less is `Partial` or `Blocked`, not complete.
