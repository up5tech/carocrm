# AI capability matrix — CaroCRM vs Twenty (Phase 25)

> **Status:** 25.1 (AI charter and documentation truthfulness), 25.2 (agent principal and least
> privilege), 25.3 (provider capability parity) and 25.4 (reusable versioned skills) delivered
> 2026-11-18; 25.5 (bounded workflow AI action), 25.6 (watched-field/condition trigger filters),
> 25.7 (bounded attachment input) and 25.8 (grounded web search) delivered 2026-11-19/20; 25.9
> (CRM Chat page context and UX parity) delivered 2026-11-21; 25.10 (installation-level cost and
> usage visibility) delivered 2026-11-21. Phase 25 as
> a whole is **in progress**, not complete. This is the **single canonical AI parity document**; the 25.0 baseline
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
the publisher/initiator so every run is attributable to a real user. Since 25.2 that rule is pinned in
the published version as `config.principal.mode` and stamped on every run event.

**Keep these stronger-than-Twenty properties while adding parity:** fail-closed tool grants and
`MAX_TOOLS` validation at publish (`apps/api/src/ai-agents/ai-agent-config.ts:50,205`), bounded JSON
output revalidation (`validateBoundedJsonSchema`, `:454`), raw-SQL ACL predicates and deny-all on `*`,
VI/EN injection and ACL evals (`apps/api/test/crm-chat-evaluation.test.ts:761,934,958`), encrypted
provider keys (`encryptSecret`), SSRF refusal including redirects (`ai-provider-url.ts:44`),
version-pinned approvals, a deterministic fake provider, and trigger recursion/idempotency guards
(`apps/api/src/ai-agents/runs/triggers.ts`, `runs/trigger-filters.ts`).

## 2. Capability matrix

| # | Axis | CaroCRM — state and evidence | Twenty v2.59 — state and evidence | Target / owner | Status / priority |
|---|---|---|---|---|---|
| 1 | Chat assistant | **Implemented and verified** at source level: contract v1.4.0, 28 implemented routes, 11 stream events and SSE resume (`apps/api/src/crm-chat/crm-chat-contract.ts:19,311-323`); 25 registered tool keys, 24 Chat-facing (`apps/api/test/ai-agent-runs.test.ts:351-387`); ACL revalidation and VI/EN evals. **Page context shipped in 25.9**: the client sends identifiers, the server resolves the record under the caller's own ACL and drops it when it may not be read (`apps/api/src/crm-chat/crm-chat-page-context.service.ts`, `apps/api/test/crm-chat-page-context.test.ts`). | Chatbot with page context ("this company"/"this opportunity"), full data access and natural-language queries — **Live-verified 25.0/25.1** (`https://docs.twenty.com/user-guide/ai/capabilities/ai-chatbot.md`, `https://docs.twenty.com/user-guide/ai/overview.md`). Web search per model configuration — Live-verified 25.0. | Grounded web results; keep the stronger eval/ACL story — 25.8 | **Implemented and verified** — P1 / P2 |
| 2 | Agent definition | **Implemented and verified in 25.4**: drafts, immutable versions, publish/pause/resume, approvals, memory, bounded JSON output (`MAX_SYSTEM_PROMPT_CHARS = 12_000`, `ai-agent-config.ts`) and 12 capability keys (`ai-agents-module.ts` — `skillAdmin` added in 25.4). Reusable **versioned, non-executable** skills now live in `ai_agent_skills` (migration 098); a published agent pins exact `(key, version)` pairs, composes them under the operating rules, and records `skill.applied` in the run timeline. No Twenty-style code-defined agent (`defineAgent()`) was added, and no skill can execute code. | `defineAgent()` / `defineSkill()` as code, custom prompt, `modelId`, structured JSON and native model tools — **alpha**, Live-verified 25.0 (`https://docs.twenty.com/developers/extend/apps/logic/skills-and-agents.md`). | In-product versioned skills without code execution — **25.4 delivered**; code-defined agents remain an accepted skip. | **Partial-to-parity for skills; code-defined agents skipped** — P1 |
| 3 | Agent triggers | **Implemented in 25.6; tests added, agent-run automated checks skipped per `AGENTS.MD` §4**: `event` / `schedule` / `integration` / `record` kinds and idempotency/recursion/five-start guards exist (`apps/api/src/ai-agents/runs/triggers.ts`); event and schedule doors are feature-gated, both **default false** (`ai-agents-settings.service.ts:30-42`). Published configs now carry bounded `triggers.watchedFields` and a sandboxed `triggers.condition` evaluated by `@carocrm/formula` (`ai-agent-config.ts`, `runs/trigger-filters.ts`); current values read as `field('status')`, previous values as `field('__previous_status')`. The committed event carries only bounded changed-field values (`packages/core/src/domain-events/index.ts`, `apps/api/src/events/entity-event.hook.ts`); non-update events and unchanged watched fields are quiet skips. Cron uses validated 5-field expressions and scheduler dedup (`apps/worker/src/schedule/cron.ts`); **timezone gap**: expressions are interpreted by `cron-parser` in the worker process timezone, not the agent owner's IANA zone. | `EVENT` with watched fields and `condition` including `previous.*`, plus `CRON` — Live-verified 25.0 (skills-and-agents.md). | Watched fields and conditions via the existing `@carocrm/formula` engine; document cron equivalence — 25.6 delivered | **Implemented; verification to be run by developer** — P1 |
| 4 | Workflow AI | **Implemented and verified in 25.5**: one bounded `runAgent` action in `WORKFLOW_ACTIONS` (`packages/workflow/src/actions/index.ts:64-98`); strict UUID/task/skill/output-map params and `mutatesRecords: true`. The DB-free executor parks a workflow on `WorkflowActionPendingError` and leaves the step `running` (`packages/workflow/src/execute/index.ts:131-139`); the worker posts to the shared-secret door (`apps/worker/src/workflows/workflow-actions.ts:189-258`), and the API re-checks the published version, `triggers.workflow`, pinned skill bindings, approval expectation, 25.2 principal and bounded JSON output before starting one idempotent run with `trigger = 'workflow'` and `causation_id = workflowRunId` (`apps/api/src/ai-agents/runs/triggers.ts:112-232`, `runs/workflow-output.ts`, migration 099). A deterministic `workflow.resume` job is enqueued when the run settles (`apps/api/src/ai-agents/runs/workflow-resume.ts`). Evidence: 18 workflow validation + 15 executor + 18 worker action + 3 API integration tests pass, including `apps/api/test/ai-agent-workflow.test.ts`. No system agent, code execution, shell/SQL interpolation or new MCP surface. | AI actions and autonomous agents inside workflows, with system agents created for AI steps — Live-verified (skills-and-agents.md, `https://docs.twenty.com/user-guide/ai/overview.md`). | Parity on the shipped bounded step shape; Twenty's code-defined/system agents remain an accepted skip — 25.5 delivered | **Implemented and verified for the bounded action** — P1 |
| 5 | Multimodal input | **Implemented in 25.7; tests added, agent-run automated checks skipped per `AGENTS.MD` §4**: chat turns and AIAgents runs accept ≤10 already-uploaded `fileId`s (`crm-chat-shapes.ts`, `ai-agents-shapes.ts`); PNG/JPEG/PDF and a 10MB per-file cap are enforced by `runs/attachments.ts` and the vendor-neutral gateway (`ai-provider.ts`). `AttachmentService.getById` checks read ACL at creation and again in `runs/transcript.ts` before any model call; a revoked file blocks the run as `attachment_not_accessible`. Only bounded metadata crosses `AIProviderRequest.attachments`; unsupported adapters fail closed, while the deterministic fake records ids and returns a stable text description. No bytes, OCR, PDF text-layer extraction, third-party vision call or new storage backend. Metadata (and a bounded future extraction seam) is passed through `boundRecord` as untrusted data. | `runAgent()` user messages accept ≤ 10 attachments from the `agent-chat` folder, fail-not-drop — Live-verified 25.0 (skills-and-agents.md). | Bounded image/PDF references with ACL checks and fake-provider tests — 25.7 delivered | **Implemented; verification to be run by developer** — P2 |
| 6 | Web grounding | **Implemented in 25.8; tests added, automated checks skipped per `AGENTS.MD` §4**: one `web_search` tool (`apps/api/src/ai-agents/ai-agent-tools.ts`, handler in `tools/read.ts`) over one operator-configured endpoint (`settings.search`, `ai-agents-settings.service.ts`). Off by default and **fail-closed**: with `search.enabled` false or no endpoint the tool answers "not configured" and nothing leaves the installation. The endpoint is operator data — the model supplies only a query string — and it passes `assertSafeProviderBaseUrl` (`ai-provider-url.ts`) on **every** call, so metadata endpoints, private ranges and loopback without opt-in are refused; the transport refuses redirects (a refactor of the shared classifier in 23.5, not a new one). Bounds: query 200 chars, ≤5 results (installation cap wins), 400-char snippet, 200-char title, 256 KiB body, ≤12 s timeout, and the run's own `maxToolCalls`/`maxSteps` cap how many searches one run can make. Every hit is `promptSafe`d and marked `untrusted`; a non-http(s) URL is dropped. Each hit carries its URL and retrieval instant, and the tool returns a self-contained `web_source:` reference Chat materialises as `approved_external_source` citations (migration 100 adds the source type + `retrieved_at`; no re-read is possible for an external page, so the reference *is* the record). One `ai_agent_provider_requests` row per call under the configured label, with the run id, so the spend lands in the same ledger, quota aggregates and run cost counter. Twitter/X search is a recorded skip; no adapter declares `nativeWebSearch`, so the operator-endpoint path is what ships (D6's "otherwise" branch). | Model-native `webSearch` / `twitterSearch` via `modelConfiguration` — Live-verified 25.0; AI web search is metered (`https://docs.twenty.com/user-guide/billing/capabilities/credits.md`, re-fetched 25.1). | One bounded, untrusted, cited search tool behind the existing SSRF guard; Twitter/X skipped — 25.8 delivered | **Implemented; verification to be run by developer** — P2 |
| 7 | Providers | **Implemented and verified for the declared contract in 25.3**: 24 presets in `ai-provider-presets.ts` (configuration, not adapters); 2 real adapters plus a test-only fake (`apps/api/src/ai-agents/index.ts:98-105`). Capability rows are derived from registered adapter objects (`ai-provider-capabilities.ts`) and published in the existing health view's `providers.capabilityTable`. All three registered adapters now serve `json_schema`: OpenAI-compatible natively, Anthropic through a bounded extraction tool, fake deterministically. Gemini is verified through a local-compatible OpenAI seam; the remaining presets are explicitly expected-but-untested. No second AI SDK and no new native adapter (D4 default). | Built-in OpenAI, Anthropic, Google, Mistral and xAI on every self-hosted plan, plus custom OpenAI-compatible/private endpoints — **Live-verified 25.1** (`https://docs.twenty.com/user-guide/ai/how-tos/ai-faq.md`). 24 presets confirmed in our source; `key: '` count re-run 25.1. | Capability table per adapter/preset, Anthropic fallback, preset verification; no native adapters unless D4 is overridden — 25.3 | **Partial** — P1 |
| 8 | Permissions | **Partial → principal pinned in 25.2**: 12 synthetic AI capability entities through ACL (`ai-agents-module.ts`; 11 at 25.3, `skillAdmin` added in 25.4); published versions carry `principal.mode` (`ai-agent-config.ts:145-153,220`, strict schema, no service identity) and `apps/api/src/ai-agents/runs/lifecycle.ts` enforces `requesting_user` for manual/Chat and publisher-attribution for automated doors. Every event carries effective principal + pinned version (`ai-agent-run-events.ts:16-31`). **Assignable agent roles are still missing** — the user identity is pinned, not a Twenty-style role assignment. | Assignable agent roles (`roleUniversalIdentifier`, `SystemPermissionFlag.AI`) and per-object read/write — Live-verified (`https://docs.twenty.com/user-guide/ai/capabilities/permissions-access-control.md`, re-fetched 25.1; skills-and-agents.md). Autonomous runs may keep the agent's role (`runAsWorkspaceMemberId`), a deliberate deviation from D2. | Least-privilege mapping below; assignable roles remain a later owner decision — 25.2 delivered the principal half | **Partial** — P0 |
| 9 | Cost control | **Implemented in 25.10; tests added, automated checks skipped per `AGENTS.MD` §4**: scoped atomic budgets (`forUpdate()`, `ai-agent-quota.service.ts`), model rates (`ai-agent-pricing.service.ts`) and per-run ceilings stay unchanged; the installation-level **cost and usage view** now reads the same two ledgers (`ai_agent_runs`, `ai_agent_provider_requests`) and answers "which agent/model/trigger spent what, over which window" from the UI and from a CSV export (`apps/api/src/ai-agents/ai-agent-cost-report.ts`, `ai-agent-cost-report.service.ts`; `GET /api/v1/AIAgents/action/usage` and `.../usage/export`). The window is the module's own period grammar (`this_month`, `rolling:30d`, `all`) resolved in the caller's zone; cost stays labelled `estimate`/`none`/`unknown`, and only provider keys and model ids are exposed. The soft limit now **warns before the hard limit stops work**: the unlocked quota pre-check writes an in-app notification to the administrators (`ai-agent-quota-notification.service.ts`), deduped per policy, dimension and period. No credit balance, no per-seat allowance, no payment flow, no new billing table. | Workspace credits (1 credit = $1), personal weekly AI allowance, token-priced model calls and a per-action breakdown including model in Settings → Billing — **Live-verified 25.1** (`https://docs.twenty.com/user-guide/billing/capabilities/credits.md`, `https://docs.twenty.com/user-guide/billing/how-tos/billing-faq.md`). Corrected URL: the 25 plan's old `/billing/capabilities/credits.md` path 404s. | Installation-level usage/cost view and soft-limit warnings; **credits/billing are an explicit skip** — 25.10 delivered | **Implemented; verification to be run by developer** — P1 |
| 10 | Evaluation | **Implemented and verified** at source level: deterministic graders, 24 tool cases × 2 languages × 3 assistants (`TOOLS_PER_ASSISTANT = 8`), injection, ACL-masking and hallucinated-citation negatives (`crm-chat-evaluation.test.ts:761,934,958`); `human_review` pending by design, `model_review` advisory (`ai-agent-evaluations.service.ts:25-26,139,145`). | SDK testing guidance exists; **no comparable published golden suite was found** in the primary sources reviewed (overview, AI FAQ, skills-and-agents, credits, billing FAQ) — `Hypothesis` (an absence claim, not a verified negative). | Versioned dataset and tool-routing accuracy threshold in the nightly DB-free gate — 25.11 | **Implemented, insufficiently verified** (model routing unproven) — P0 |
| 11 | MCP / extensions | **Implemented and verified**: shipped MCP-compatible tool door (`GET/POST /api/v1/AIAgents/action/mcp/tools|call`, `docs/reference/compatibility-matrix.md:364`), idempotent direct calls (19-AI.23), extension SDK with signed packages, and `modules/webhook-integration`. Model-backed retrieval stays deferred. | `defineMcpServer()` is **beta, "not live yet"** — Live-verified 25.0 (skills-and-agents.md). | Document the shipped adapter as an advantage; no new MCP surface without a live use case — 25.3 / 25.12 | **Implemented and verified** (protocol half) — P1 |
| 12 | Truthfulness | **Partial → corrected here.** G99's three drifts are fixed in 25.1: `plans/SPEC.md` tool ceiling and trigger status, the CRM Chat contract status line, and `docs/reference/compatibility-matrix.md` / `docs/reference/alpha-status.md` / README. Accepted posture: "Optional protected assistive use only" at `docs/compatibility/advanced-integrations.md:123`; model-backed retrieval deferred; `human_review` pending. The former Anthropic structured-output gap was closed in 25.3 without relaxing `validateBoundedJsonSchema()`. | Documentation is part of the product; no direct parity row — Documented. | One canonical matrix and honest skip list — 25.1 / 25.12 | **Fixed for G99; overall parity review remains Open** — P0 |

Summary: rows 1, 7, 8 and 12 are **Partial** (real capability, named gap); rows 3, 5, 6 and 9 are
**Implemented in 25.6/25.7/25.8/25.10 with tests added** (watched fields/conditions; bounded attachment
metadata with ACL re-check and a fake provider; a bounded, cited, fail-closed web search whose results
are untrusted; an installation-level cost and usage view with soft-limit warnings). The developer still needs to run the automated checks per `AGENTS.MD` §4; row 4 is
**Implemented and verified for
the bounded workflow AI action** (25.5; system agents/code-defined steps are an accepted skip); row
10 is **Implemented, insufficiently verified**; row 11 is **Implemented and verified** for the
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
| Conversation sharing (chat D12) | `Accepted — not implemented` in `docs/architecture/crm-chat-contract.md:57`. 25.9 shipped the page context and left sharing alone: a shared thread needs its own ACL design (who may read a conversation that belongs to somebody else), which is not part of a page-context change. |

Skipping a P2 row (25.7/25.8) still requires an explicit override note in the decision record and a
matrix row here — never a silent omission. No such override exists as of 25.1.

## 5. Least-privilege profile (25.2)

Source: `apps/api/src/ai-agents/ai-agents-module.ts:30-121`. These are the 11 existing capability keys
and their synthetic ACL pairs. The module grants **no `*` by default**; a role that already has a
wildcard entry inherits these pairs through the platform's normal ACL merge, which is an existing
administrator choice, not an AI module default.

| Capability | Synthetic ACL pair | Least-privilege profile | Why it is bounded |
|---|---|---|---|
| `use` | `AIAgent:read` | Any internal user who may start a run | Listing/starting only; never draft, publish or approval |
| `manageDraft` | `AIAgent:edit` | Agent owner or owning-team editor | Drafts only; the published version is immutable |
| `publish` | `AIAgentVersion:edit` | Owner/team publisher after validation and evaluation gate | Checksum + published version; no silent policy change |
| `lifecycle` | `AIAgentLifecycle:edit` | Owner/team operator | Pause/resume/archive; no config rewrite |
| `toolAdmin` | `AIAgentTool:edit` | Platform administrator | Named tool keys only; no arbitrary handler |
| `policyAdmin` | `AIAgentPolicy:edit` | Platform administrator | Kill switch, limits, retention; instance-wide by design |
| `providerAdmin` | `AIAgentProvider:edit` | Platform administrator | Credentials write-only and encrypted; no secret read path |
| `approval` | `AIAgentApproval:edit` | Named human approver | Self-approval forbidden by default; second approver in permissive mode |
| `audit` | `AIAgentAudit:read` | Auditor/administrator | Redaction preserved; no seat above the actor |
| `usage` | `AIAgentUsage:read` | Administrator or cost viewer | Estimated-vs-authoritative cost labels retained |
| `evaluation` | `AIAgentEvaluation:edit` | Evaluation owner | Deterministic graders cannot be overridden by review labels |

**Principal rule (D2, pinned):** `config.principal.mode = 'requesting_user'` (default) means manual,
CRM Chat and a workflow AI step act as the authenticated initiator. `'publisher'` is accepted
only for automated trigger doors and only when the ambient principal is the agent owner; it cannot be
started from a manual/Chat door. A service identity is not a valid mode:
`ai_agent_runs.service_principal` stays NULL on every path. Revoked or deleted principals fail closed:
`auth.principalFromUser` refuses them at the door and the executor marks an already-queued run
`principal_unavailable`.

## 6. Provider capability profile (25.3)

Source of truth: `apps/api/src/ai-agents/ai-provider.ts` (`AIProviderCapabilities`) and the registered
adapter objects. `apps/api/src/ai-agents/ai-provider-capabilities.ts` derives the table; the existing
`GET /api/v1/AIAgents/action/health` publishes it under `providers.capabilityTable`. A preset has no
capabilities of its own — it inherits its transport adapter's row and carries an explicit
verification label. `contextWindowTokens: null` means model-dependent and not declared by this
contract; it is never a claim of unlimited context.

| Transport | Chat | Tools | Structured output | Streaming | Context size | Image input | Native web search | Verification |
|---|---|---|---|---|---|---|---|---|
| `openai-compatible` | Yes | Yes | Yes — `native` response format | No | Model-dependent (`null`) | No | No | adapter-contract |
| `anthropic` | Yes | Yes | Yes — `extraction_tool` fallback | No | Model-dependent (`null`) | No | No | adapter-contract |
| `fake` (non-production) | Yes | Yes | Yes — deterministic | No | Model-dependent (`null`) | No | No | adapter-contract |

Presets: `openai`, `anthropic` and `fake` are adapter-contract verified; `gemini` is verified through
a local stubbed OpenAI-compatible endpoint (no vendor call); all other presets are marked
`not-verified` and are **expected** to work because they use the same transport, not proven here.
No native Google/Mistral/xAI adapter was added (D4 default), and no new MCP surface was added:
CaroCRM's shipped tool door remains the documented advantage over Twenty's beta declaration.

The Anthropic fallback injects one host-defined tool whose `input_schema` is the agent's bounded JSON
schema, consumes the resulting `tool_use` block inside the adapter, and returns it as `structured`.
The reserved name cannot be granted as an agent tool, prose instead of an extraction call fails with
`invalid_response`, a domain tool turn is passed through without inventing an answer, and
`validateBoundedJsonSchema()` still performs the only schema verdict in the run engine.

### 6.1 Reusable versioned skills (25.4)

Source of truth: `apps/api/src/ai-agents/ai-agent-skills.ts` (pure bounds/order/prompt composition),
`ai-agent-skills.service.ts` (ACL, versions, publication), `ai-agent-config.ts` (`skills` bindings)
and migration `database/migrations/098_phase25_agent_skills.sql`. A skill is **text only**: no script
field, no dynamic import, no executable tool. `skill_key` is stable; each version is a snapshot.

- **States:** `draft` is editable; `publish` freezes that version; `archive` removes it from the
  picker but leaves it resolvable for an agent that already pinned it. Publishing a newer version
  never rewrites an older one, and a draft edit can never change a running published agent.
- **Binding:** a published agent version pins zero to eight exact `(key, version)` pairs
  (`MAX_SKILLS_PER_AGENT`). Publication refuses draft, invisible or missing versions and rejects a
  composed system prompt over `MAX_SYSTEM_PROMPT_CHARS`. A run re-resolves the pinned rows and emits
  a user-visible `skill.applied` event with the exact versions used.
- **Priority:** the composed block is explicitly subordinate to the operating rules and the agent's
  instructions, sits between them and the schema reminder, and never changes tool grants, approval
  policy or bounded output. Instructions are control-character-stripped and capped at 4,000 chars.
- **ACL:** reads need capability `use` plus row visibility (organization/owner/team); writes need a
  new capability `skillAdmin` (`AIAgentSkill` edit) plus the same ownership rule — no global
  `*` grant is added by the migration or by default. The SPA has one Skills tab in the existing
  AIAgents page and a published-version picker in the agent editor; both are presentation only.
- **Deliberate skip:** Twenty's `defineSkill()` code-defined agents are not copied. CaroCRM's
  equivalent is an in-product, ACL-checked, non-executable text record, which is the parity value
  without an arbitrary code path (definition of done §7).

## 7. Drift register — G99 resolution and accepted exceptions

| Item | 25.1 disposition |
|---|---|
| SPEC `MAX_TOOLS` 24 vs code 32 | Corrected in `plans/SPEC.md` status line and §7.2; code is `apps/api/src/ai-agents/ai-agent-config.ts:50`. Historical changelog rows stay as history, with a note pointing here. |
| "Schedule/integration triggers not implemented" | Corrected in `plans/SPEC.md`, `docs/reference/compatibility-matrix.md` and `docs/reference/alpha-status.md`: implemented in 19-AI.25, feature-gated and default off. |
| CRM Chat contract status "through 19-CHAT.24" | Corrected to hardened through 19-CHAT.29; contract v1.3.0 and 27 routes were already consistent with code. |
| Tool counts 20/21/25 | Registry is 25 (15 built-ins + 10 contributions), 24 Chat-facing; `plans/SPEC.md:8,267` and this matrix agree. "21" and "20" remain only in dated changelog history. |
| "Optional protected assistive use only" | Accepted posture at `docs/compatibility/advanced-integrations.md:123`, cross-linked here; not a contradiction. |
| Model-backed retrieval deferred | Accepted; no vector store or second datastore was added. |
| `human_review` pending, `model_review` advisory | Accepted by design; 25.11 assigns an owner and review deadline. |
| Anthropic structured output refused | Closed in 25.3 with the adapter-side extraction-tool fallback; all registered adapters return a `structured` value for `json_schema`, still validated by `validateBoundedJsonSchema()`. No G100+ exception needed. |
| Twenty billing URL in the 25 plan | Corrected to `https://docs.twenty.com/user-guide/billing/capabilities/credits.md`; the old path returned Page Not Found on 2026-11-18. |

## 8. Verification recorded by 25.1, 25.2, 25.3 and 25.4

Source inventory re-run on 2026-11-18 after 25.4: 47 AIAgents `.ts` files, 23 CRMChat `.ts` files, a
1,496-line executor (skill prompt composition was extracted to
`apps/api/src/ai-agents/runs/skill-prompt.ts` rather than
growing the step loop), 24 presets, 27 chat routes, 24 eval tool cases, 98 migrations and
`MAX_TOOLS = 32`. The 25.1 documentation checks and their results are recorded in
`docs/quality/known-gaps.md` under G99.

25.2 added executed evidence (no migration, no new provider, no release action):

- `apps/api/test/ai-agent-config.test.ts` — 10/10: default rule, publisher rule, refusal of service
  identities and unknown modes.
- `apps/api/test/ai-agent-principal.test.ts` — 4/4: manual door refuses a publisher-pinned version;
  an automated event runs as the pinned publisher with `service_principal = NULL` and every event
  carries the effective user + pinned version; a revoked publisher is skipped before a run exists.
- `apps/api/test/ai-agent-ledger-observability.test.ts` — 4/4: shared event ledger stamps principal
  and version from the run row, not the caller.
- Regression suites: `ai-agent-runs.test.ts` 48/48 (including ungranted/invented tool denial),
  `ai-agent-self-approval.test.ts` 5/5, `ai-agent-triggers.test.ts` 16/16,
  `phase22-journey-ai-controlled-actions.test.ts` 12/12 (field masking, no SQL/shell escalation),
  `crm-chat-security.test.ts` 22/22 (citation re-authorization). `pnpm typecheck` passed.
Runtime behaviour of feature-gated surfaces remains verified as code, not as enabled behaviour;
executed parity evidence belongs to 25.11 and 25.12.

25.3 added executed evidence (no migration, no dependency, no live vendor call):

- `apps/api/test/ai-providers.test.ts` — 25/25 after adding the 25.3 cases: capability rows come from
  registered adapter objects, presets inherit only their transport's capabilities, Gemini is verified
  through a stubbed local-compatible endpoint, Anthropic returns a schema-valid structured value via
  the extraction tool, prose/tool-name collisions fail closed, and all three registered adapters
  return the same validated `{ ok: true }` answer.
- Regressions: `apps/api/test/ai-agent-runs.test.ts` 48/48, `apps/api/test/ai-agents.test.ts` 10/10,
  `apps/api/test/docs-content.test.ts` 5/5 and `packages/docs/src/lint.test.ts` 28/28.
- `pnpm typecheck` passed; `pnpm lint` passed (UI conventions 5,179 keys + single-tenant + ESLint);
  `pnpm ci:api-spec --strict` passed (927/927 documented endpoints); `git diff --check` clean.   All 36 file-path references in this matrix resolve from the repository root.
- The capability table is exposed through `AIAgentsModuleHealthView.providers.capabilityTable` and
  documented in `api-spec/ai-agents.yaml`; no provider secret appears in the table.

25.4 added executed evidence (one additive migration, no new SDK, no code execution, no live call):

- `apps/api/test/ai-agent-skills.test.ts` — 6/6: control-character stripping, text bounds,
  deterministic key ordering, explicit subordinate/untrusted prompt block, placement below the
  operating rules and above agent instructions/schema, and the caller's prompt ceiling.
- `apps/api/test/ai-agent-config.test.ts` — 12/12 after adding 25.4 cases: exact version bindings
  are ordered deterministically; duplicate keys, invalid keys and a ninth binding are refused.
- `apps/api/test/ai-agent-skills.integration.test.ts` — 5/5: a published version is immutable, two
  agents bind different versions of one key, a later draft edit does not change the pinned version
  used by a run (`skill.applied` event carries the applied key/version), a draft binding blocks agent
  publication, and skill writes need `skillAdmin` while a private draft stays invisible.
- Regressions: `ai-agent-actor.test.ts` 10/10, `ai-agents.test.ts` 10/10,
  `ai-agent-principal.test.ts` 4/4 and `ai-providers.test.ts` 25/25.
- `pnpm typecheck` passed; `pnpm lint` passed (UI conventions 5,213 keys + single-tenant + ESLint);
  `pnpm ci:api-spec --strict` passed (935/935 documented endpoints); `git diff --check` clean.
- No Playwright spec was added: publish/bind is covered through the real HTTP routes in the
  integration suite, and the two UI pieces use the page's existing tab/table/form patterns with no
  new router, guard or authorization path. A browser spec would re-test presentation only. The SPA
  was additionally built to a temporary outDir (`vite build`, success) to cover the new tab and
  picker beyond typecheck.
