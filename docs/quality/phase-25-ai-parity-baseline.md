# Phase 25.0 — AI Parity Baseline and Reconciliation

> **Status:** Delivered (2026-11-18). Read-only audit per `plans/PLAN_Phase_25_AI_Capability_Parity.md` §6.
> **No source file, migration, database row or provider account was changed.** Documents written by this
> pass: this file, `docs/quality/phase-25-priority-decisions.md`, gap **G99** in
> `docs/quality/known-gaps.md`, and factual corrections to the plan itself (§1.1/§2/§6 source attribution
> and G-ID numbering).
> **Labels:** the §0.2 vocabulary of the plan — `Implemented and verified` · `Implemented, insufficiently verified` ·
> `Partial` · `Missing` · `Blocked` · `Not applicable`, with priority (P0/P1/P2) and disposition
> (Open/Fixed/Accepted/Deferred/Hypothesis).
> **Evidence rule:** every CaroCRM claim below carries a path (and line where it matters). "Verified" for
> CaroCRM means source-level verification in this pass; **no test, lint or typecheck was executed** —
> `AGENTS.MD` §4 reserves those for the developer. Executed-test evidence is cited from existing suites by
> path, not re-run. Twenty claims carry a URL and a verification state (§8).
> **25.3 reconciliation:** this remains the historical 25.0 audit. The finding "Anthropic structured
> output refused" is now closed by the adapter-side extraction-tool fallback; the current provider
> capability table is `docs/architecture/ai-capability-matrix.md` §6, not this baseline.

---

## 1. Inventory (re-run 2026-11-18; commands in §9)

| Metric | Value | Evidence |
|---|---|---|
| AIAgents source files | **43** `.ts` | `find apps/api/src/ai-agents -name '*.ts'` |
| CRMChat source files | **23** `.ts` | `find apps/api/src/crm-chat -name '*.ts'` |
| Run executor size | **1,491 lines** vs ~1,500 ceiling | `apps/api/src/ai-agents/runs/executor.ts`; ceiling at `plans/PLAN_Phase_19_AI_Agents.md:1706` |
| Runs split | `base.ts`, `executor.ts`, `lifecycle.ts`, `shared.ts`, `triggers.ts` | `apps/api/src/ai-agents/runs/` |
| Registered tool keys | **25** = 15 built-ins + 10 contributions | `ai-agent-tools.ts` (15 keys, §1.1); contributions listed below; test enumeration `apps/api/test/ai-agent-runs.test.ts:351-387` (`EXPECTED_CATALOGUE`, 25 entries) |
| Per-agent tool ceiling | **`MAX_TOOLS = 32`** (raised from 24) | `apps/api/src/ai-agents/ai-agent-config.ts:50` |
| System prompt ceiling | `MAX_SYSTEM_PROMPT_CHARS = 12_000` | `ai-agent-config.ts:21` |
| Bounded output validation | `validateBoundedJsonSchema()` | `ai-agent-config.ts:454`; used by `runs/executor.ts:525,555` |
| Chat contract | **v1.3.0**, **27 routes** (all `implemented: true`), **11 stream events** | `apps/api/src/crm-chat/crm-chat-contract.ts:19` (version), route table (27 `method:` entries), `CRM_CHAT_STREAM_EVENTS` :311-323 |
| Provider presets | **24** (23 vendor/local + `fake`) | `ai-provider-presets.ts` — openai, anthropic, gemini, azure-openai, groq, deepseek, mistral, xai, openrouter, together, fireworks, perplexity, nvidia, siliconflow, nebius, chutes, litellm, ollama, lmstudio, vllm, llamacpp, localai, custom, fake |
| Registered adapters | **2 real + fake**: OpenAI-compatible, Anthropic; fake only when `NODE_ENV !== 'production'` | `apps/api/src/ai-agents/index.ts:98-105` |
| Anthropic structured output | **Refused** — Messages API has no `response_format` | `ai-provider-anthropic.ts:30` (doc comment), :242-245 (throw) |
| AI capabilities | **11 keys**: use, manageDraft, publish, lifecycle, toolAdmin, policyAdmin, providerAdmin, approval, audit, usage, evaluation | `ai-agents-module.ts:30-41` |
| Trigger kinds | `event` / `schedule` / `integration` / `record` | `runs/triggers.ts:41`; doors shipped in **19-AI.25** (:2); config checks :85-87 |
| Trigger feature gates | `execution`, `eventTriggers`, `scheduledTriggers`, `memory`, `evaluations` all **default `false`**; `definitions` default `true` | `ai-agents-settings.service.ts:30-42` (`AIAgentsSettingsSchema`) |
| Trigger guards | 5 starts per event (`candidates.slice(0, 5)` :179, :375); recursion `depth > 3` throw (:58-59); idempotency `evt:<eventId>:<agentId>` (:200), `sched:<agentId>:<scheduledForMs>` (:296) | `runs/triggers.ts`; G95 (first-20-agents scan) **Fixed 24.11** — full published-agent scan |
| Workflow actions | **5**: updateRecord, createRecord, createNotification, sendEmail, runJob — **no AI action** | `packages/workflow/src/actions/index.ts:62-98` |
| Workflow executor seam | DB-free behind `WorkflowExecutorPorts.runAction` / `recordStep` / completed-steps ledger | `packages/workflow/src/execute/index.ts:25-30`; condition node uses `@carocrm/formula` `FormulaEngine` (:1, :59, :99) |
| Migrations | **97** files; highest `097_phase24_7_incremental_cursor.sql`; **next free 098** | `ls database/migrations` |
| Budget policies | `ai_agent_budget_policies` in **045/049**; **048** adds pricing snapshots + quotas | `database/migrations/045_phase19_ai_agents.sql`, `049_phase19_ai_agents_budget_warn_percent.sql`, `048_phase19_ai_agents_pricing_quotas.sql` |
| `tenant_ref` | Provider-account label only (not isolation) | `database/migrations/056_phase19_advanced_integrations.sql` |
| Quota enforcement | Atomic (`forUpdate()` :203, :228); soft `warnPercent` never refuses work (:25, :43) | `ai-agent-quota.service.ts`; rates in `ai-agent-pricing.service.ts` |
| Eval suite | **24 tool cases × 2 languages (vi/en) × 3 assistants** (`TOOLS_PER_ASSISTANT = 8`); injection/ACL/citation negatives | `apps/api/test/crm-chat-evaluation.test.ts:761` (`TOOL_EVAL_CASES`, 24 `tool:` entries), :934, :958 |
| Eval graders | Deterministic; `human_review` pending until a person decides; `model_review` advisory only | `ai-agent-evaluations.service.ts:25-26,139,145` |
| Suggestion chips | **8**, each `requiresTool`, filtered by the answering agent's grants | `apps/web/src/pages/crm-chat/CRMChatSuggestions.tsx:24-31`, filter :36 |
| SSE resume | `Last-Event-ID` supported | `apps/api/src/crm-chat/crm-chat-streaming.service.ts`, controller, contract |
| Security helpers | `assertSafeProviderBaseUrl` (`ai-provider-url.ts:44`), `promptSafe` (`ai-agent-actor.ts:58`), `boundRecord` (`tools/helpers.ts:8`), `encryptSecret` (`@carocrm/core/utils/crypto`) | as listed |
| Adjacent AI | Lead-score AI explanation behind a feature gate (`apps/api/src/lead-score/lead-score-feature-gate.service.ts`); voice transcription (`apps/api/src/voice-communications/`); `crm_draft_email`, `crm_record_summary` tools | as listed |

**Tool catalogue (25 keys).** Built-ins (15, `ai-agent-tools.ts`): `crm_actor_context`, `crm_aggregate`,
`crm_create_task`, `crm_draft_email`, `crm_list_activities`, `crm_list_emails`, `crm_list_related`,
`crm_log_activity`, `crm_post_note`, `crm_read_record`, `crm_record_summary`, `crm_search_records`,
`crm_update_record_fields`, `docs_read_page`, `docs_search`. Contributions (10): `crm_cross_module`
(CRMChat), `crm_commercial_summary` (Sales), `crm_project_status` (Projects), `crm_run_report` +
`crm_stale_records` (AIAgents intelligence contribution), `crm_lead_score` (LeadScore),
`crm_campaign_performance` (MarketingAutomation), `crm_customer_health` (CustomerSuccess),
`crm_case_context` (ServiceDesk), `omnichannel.send_message` (Omnichannel,
`omnichannel-ai-tools.ts:26,45`).

## 2. Capability matrix (one row per §1.1 axis of the plan)

Twenty verification states: **Live-verified** = primary source re-fetched 2026-11-18 (§8);
**Documented** = cited in plan §3 (retrieved 2026-11-18) but not re-fetched in this pass — load-bearing
details carry `Hypothesis` until 25.1 re-checks them.

| # | Axis | CaroCRM status (evidence) | Twenty v2.59 (state) | Phase 25 target / owner | Priority |
|---|---|---|---|---|---|
| 1 | Chat assistant | **Implemented and verified** at source level — contract 1.3.0, 27 routes, SSE resume, 25 tools, ACL revalidation, VI/EN injection evals (§1). **No page context** (actor context only). | Page context ("this company"/"this opportunity"), follow-ups, full data access — **Live-verified** (ai-chatbot.md). Web search per plan §3 — Documented. | Page context + grounded results; keep stronger eval/ACL story — **25.9 / 25.8** | P1 / P2 |
| 2 | Agent definition | **Implemented and verified** — 43 files; drafts, immutable versions, publish, pause/resume, approvals, memory, bounded JSON output, quotas, 11 capabilities (§1). No reusable skill entity. | `defineAgent()`/`defineSkill()` as code, custom prompt, modelId, structured JSON, native model tools; **alpha** — **Live-verified** (skills-and-agents.md). | In-product versioned skills; keep version lifecycle; no code-defined agents — **25.4** | P1 |
| 3 | Agent triggers | **Partial** — event/schedule/integration doors shipped (19-AI.25) with allowlists, 5-start cap, recursion ceiling, idempotency (§1); **off by default**; **no watched-field or condition filters**. Docs wrongly say "not implemented" (G99). | `EVENT` with watched fields + condition incl. `previous.*`, `CRON` — **Live-verified** (skills-and-agents.md). | Watched-field + condition filters via `@carocrm/formula`; cron parity doc — **25.6** | P1 |
| 4 | Workflow AI | **Missing** — `WORKFLOW_ACTIONS` has 5 actions, none AI (§1). Absence verified by grep (§4). | AI steps inside workflows; `runAgent()` from logic functions; system agents created for workflow AI steps — **Live-verified** (skills-and-agents.md). | One bounded `runAgent` action, pinned version, approval, idempotent retry — **25.5** | P1 |
| 5 | Multimodal input | **Missing** — zero `attachment` references in `apps/api/src/crm-chat` (§4). Voice transcription is a separate module. | `runAgent()` user messages carry ≤ **10** attachments, `fileId` in `agent-chat` folder, fail-not-drop — **Live-verified** (skills-and-agents.md). | Bounded image/PDF attachments, ACL-checked, fake-provider tests — **25.7** (D5) | P2 |
| 6 | Web grounding | **Missing** — `docs_search` is local-docs only; zero `web_search` hits in source (§4). | Model-native `webSearch` / `twitterSearch` via `modelConfiguration` — **Live-verified**; metered search per plan §3 — Documented. | One bounded, untrusted, cited search tool behind SSRF guard; Twitter/X skipped — **25.8** (D6) | P2 |
| 7 | Providers | **Partial** — 24 presets but only 2 real adapters + fake; Anthropic structured output refused (:242-245); presets are configuration, not adapters (§1). | Built-in OpenAI, Anthropic, Google, Mistral, xAI + custom, self-hosted on all plans — **Documented/Hypothesis** (provider list not re-fetched; native tool support Live-verified). | Capability table, Anthropic fallback, preset verification; native adapters only if D4 — **25.3** | P1 |
| 8 | Permissions | **Partial** — synthetic AI capability entities through ACL; event-trigger principal = publisher (`plans/SPEC.md:8`); **no pinned principal field in the published version, no agent-role binding** (§4). | `roleUniversalIdentifier` binding, `SystemPermissionFlag.AI`, `runAsWorkspaceMemberId` (member's own role; autonomous runs keep the agent role) — **Live-verified**. | Explicit pinned execution principal, least-privilege profile, negative tests — **25.2**. Note: Twenty autonomous runs use the *agent's* role; CaroCRM D2 default (publisher/initiator) is a deliberate, stricter attribution choice — record the deviation in the 25.1 matrix. | P0 |
| 9 | Cost control | **Partial** — scoped atomic budgets, `warnPercent` soft warnings, token/cost ledger, per-run ceilings (§1); **no installation-wide cost view**. | Credits, personal allowance, per-action billing breakdown — credits **Live-verified** (`credits-exhausted` failure mode); breakdown shape **Documented/Hypothesis**. | Installation-level usage/cost view + warnings; **no credits/billing** (D1 skip) — **25.10** | P1 |
| 10 | Evaluation | **Implemented and verified** at source level — deterministic graders, 24×2×3 tool cases, VI/EN injection, ACL masking, hallucinated-citation negatives (§1); `human_review` pending by design. | SDK testing guidance; no comparable published golden suite — **Documented/Hypothesis** (absence claim; re-check at 25.1). | Versioned golden dataset, tool-routing accuracy threshold in the nightly DB-free gate — **25.11** | P0 |
| 11 | MCP / extensions | **Implemented and verified** — MCP-compatible tool door (`docs/reference/compatibility-matrix.md:364`, protocol half; model-backed retrieval deferred), idempotent direct calls (19-AI.23 per plan), extension SDK + signed packages, `webhook-integration`. | `defineMcpServer()` **beta, "not live yet"** — **Live-verified** (skills-and-agents.md). | Document the advantage; no new MCP surface without a live use case — **25.3 / 25.12** | P1 |
| 12 | Truthfulness | **Partial** — G99 doc drift (§3); "Optional protected assistive use only" lives at `docs/compatibility/advanced-integrations.md:123` (the plan previously mis-attributed it to the reference compatibility matrix; corrected). | Documentation is part of the product — Documented. | One canonical matrix, corrected counts/status lines, explicit skips — **25.1 / 25.12** | P0 |

**Better than Twenty, keep it (source-verified this pass):** fail-closed tool grants and `MAX_TOOLS`
validation at publish (`ai-agent-config.ts:205`), bounded JSON output re-validation
(`validateBoundedJsonSchema`), prompt-injection evals in VI and EN (`crm-chat-evaluation.test.ts`),
encrypted provider keys (`encryptSecret`), SSRF guard with redirect refusal
(`assertSafeProviderBaseUrl`), version-pinned approvals, deterministic fake provider, trigger
recursion/idempotency guards, and single-tenant attribution of every AI action to a real user.

## 3. Drift register and dispositions (plan §6 task 3)

| # | Contradiction | Evidence | Disposition |
|---|---|---|---|
| 1 | `MAX_TOOLS`: SPEC says 24, code allows 32 | `plans/SPEC.md:268` vs `ai-agent-config.ts:50` | **G99 — correct in 25.1** |
| 2 | "Schedule/integration triggers not implemented" vs shipped, feature-gated doors (19-AI.25, default off) | `plans/SPEC.md:8`, `docs/reference/compatibility-matrix.md:362` vs `runs/triggers.ts:2,50,85-87,296`, `ai-agents-settings.service.ts:30-42` | **G99 — correct in 25.1** (wording: "implemented, off by default") |
| 3 | Chat contract doc status line "through 19-CHAT.24" vs 1.3.0 hardening (19-CHAT.25→29) and 27 routes | `docs/architecture/crm-chat-contract.md:5` vs :8-12 and `crm-chat-contract.ts:19` | **G99 — correct in 25.1**. Version itself does **not** drift (both 1.3.0) — the plan's earlier "1.2.0 vs 1.3.0" claim was wrong and was corrected before 25.0. |
| 4 | Tool counts 20/21/25 disagreement claimed by the plan | Actual: registry 25; SPEC v1.8.0 correctly says 24 Chat-facing / registry 25 (`plans/SPEC.md:8,682`); "21" exists only in the historical v1.6.0 changelog row (:687); test catalogue 25 | **Resolved at 25.0** — no live count drift beyond item 1; plan §2 corrected. |
| 5 | "Optional protected assistive use only" attributed to the compatibility matrix | Actually `docs/compatibility/advanced-integrations.md:123` (table row), echoed in `docs/compatibility/advanced-integrations/acceptance-evidence.md:40` | **Resolved at 25.0** — plan §1.1/§6 attribution corrected. The wording itself is an accepted posture, not a defect; 25.1 cross-links it from the canonical matrix. |
| 6 | "Model-backed retrieval stays deferred" | `plans/PLAN_Phase_19_AI_Agents.md:58`; `docs/reference/compatibility-matrix.md:364` | **Accepted — stands.** Out of scope per plan §1.3 unless D1/D4 reopened. No vector extension, no second datastore. |
| 7 | `human_review` pending, `model_review` advisory | `ai-agent-evaluations.service.ts:25-26,139,145` | **Accepted by design**; 25.11 adds owner + review deadline for pending cases. |
| 8 | Anthropic structured output unsupported | `ai-provider-anthropic.ts:30,242-245` | **Open capability gap → 25.3**: adapter-side fallback keeping `validateBoundedJsonSchema()`, or a G100+ gap with owner and deadline. |

## 4. Absence findings (verified, not assumed — plan §6 task 4)

Commands and zero-hit outputs in §9.

- **No workflow AI action:** `packages/workflow/src/actions/index.ts:62-98` lists exactly 5 actions; no
  `runAgent`/AI entry anywhere in the package's action catalogue.
- **No web-search tool:** `grep -rn "web_search" apps/api/src apps/web/src packages` → **0 hits**.
- **No skill entity:** no migration mentions a skill table (`grep -rln "skill" database/migrations` → 0).
- **No attachment path in chat/run input:** `grep -rin "attachment" apps/api/src/crm-chat` → **0 hits**.
- **No agent-role binding / pinned principal field:** no role-binding identifier in the AI migrations or
  definitions service; the event-trigger principal is the publisher by convention (`plans/SPEC.md:8`),
  not a pinned, versioned field. 25.2 makes it explicit.
- **No page context in chat:** actor context exists (`crm_actor_context` tool); no route/record page
  payload in the composer contract. 25.9 owns this.
- **Conversation sharing (D12) not implemented:** `docs/architecture/crm-chat-contract.md:57` —
  "Conversations are private to their owner. Sharing is not implemented." 25.9 records the disposition.

## 5. Security baseline (consumed, not re-litigated — plan §0.1)

Phase 23 controls are present at source level: `assertSafeProviderBaseUrl`
(`ai-provider-url.ts:44`, redirect refusal + documented DNS-rebinding residual), `promptSafe`
(`ai-agent-actor.ts:58`), `boundRecord` (`tools/helpers.ts:8`, untrusted marker + truncation),
`encryptSecret`/`decryptSecret` (`@carocrm/core/utils/crypto`, used by the credential vault),
version-pinned approvals, `audit_log`. Every Phase 25 input (search results, attachment text, skill
content, workflow payload) stays **untrusted data**. No control was weakened or re-opened by this pass.

## 6. Release gate (plan §6 task 5)

- `docs/quality/phase-24-12-release-review.md:3-4`: **In progress** — the gate has not been re-run and
  **no go/no-go decision has been made**; no release action taken.
- `docs/releases/2026-11-15-phase-24.md:7,78`: **NO-GO for production — unchanged** from Phase 23;
  blockers include G80/G81 (owner decisions) and the unsigned exception register.
- **Conclusion:** Phase 25 produces **alpha/pilot evidence only** (D7). Nothing in this phase may imply
  a production GO; 25.12 is an AI-capability review, not a second production gate.

## 7. Owner decisions D1–D7

Defaults applied and recorded in `docs/quality/phase-25-priority-decisions.md` (the plan §0.3 fallback
column). The owner may override any default before 25.1; overrides are recorded in that file, not here.
One design note surfaced by live verification: Twenty's `runAsWorkspaceMemberId` lets autonomous runs
keep the *agent's* role, while CaroCRM's D2 default pins the publisher/initiator — a deliberate
deviation toward stricter attribution, to be documented in the 25.1 matrix.

## 8. Twenty primary-source verification log

| Source | State | What it confirms |
|---|---|---|
| `https://docs.twenty.com/developers/extend/apps/logic/skills-and-agents.md` | **Re-fetched 2026-11-18** | Skills/agents **alpha**; `defineMcpServer()` **beta, "not live yet"**; `defineSkill()`/`defineAgent()` (prompt, modelId, responseFormat flat-object JSON schema); `roleUniversalIdentifier` + `SystemPermissionFlag.AI`; EVENT trigger with `watchedFieldUniversalIdentifiers` + `condition` (incl. `previous.*`); CRON pattern; `runAgent()` attachments ≤ 10, `agent-chat` folder, user-messages-only, fail-not-drop; `runAsWorkspaceMemberId` semantics; native `webSearch`/`twitterSearch` via `modelConfiguration`; credits-exhausted failure mode; workflow AI steps (system agents); loop-avoidance warning for self-triggering agents. |
| `https://docs.twenty.com/user-guide/ai/capabilities/ai-chatbot.md` | **Re-fetched 2026-11-18** | Page context ("this company"/"this opportunity"), follow-up context, full data access, natural-language queries; example "Summarize my interactions with this person" on a contact page. |
| Remaining plan §3 URLs (ai overview, agents, permissions-access-control, ai-faq, billing/credits, core-concepts/ai, GitHub `sdk/v2.59.0`) | **Documented, not re-fetched this pass** | Cited as retrieved 2026-11-18 by the plan. Load-bearing details that rest only on these (exact built-in provider list, billing breakdown shape, "no published golden suite" absence claim) are labelled **Hypothesis** in §2 and must be re-checked at 25.1 before the canonical matrix repeats them. |

No Twenty code was copied; all CaroCRM behaviour is independently implemented (AGENTS.MD §6).

## 9. Commands executed (read-only) and key outputs

All commands ran from the repository root on 2026-11-18. No test, lint, typecheck, build, database
query or network call to a model/search vendor was executed. Two HTTPS fetches to Twenty documentation
only (§8).

```sh
find apps/api/src/ai-agents -name '*.ts' | wc -l        # 43
find apps/api/src/crm-chat -name '*.ts' | wc -l         # 23
wc -l apps/api/src/ai-agents/runs/executor.ts           # 1491
ls database/migrations | sort | tail -6                 # …097_phase24_7_incremental_cursor.sql
ls database/migrations | wc -l                          # 97
grep -c "key: '" apps/api/src/ai-agents/ai-provider-presets.ts   # 24
grep -n "CRM_CHAT_CONTRACT_VERSION" apps/api/src/crm-chat/crm-chat-contract.ts  # :19 '1.3.0'
grep -c "method: '" apps/api/src/crm-chat/crm-chat-contract.ts   # 27
grep -c "implemented: true" apps/api/src/crm-chat/crm-chat-contract.ts          # 27
grep -n "MAX_TOOLS\|MAX_SYSTEM_PROMPT_CHARS" apps/api/src/ai-agents/ai-agent-config.ts  # :21 12_000, :50 32
grep -c "tool: '" apps/api/test/crm-chat-evaluation.test.ts      # 24
grep -n "TOOLS_PER_ASSISTANT =" apps/api/test/crm-chat-evaluation.test.ts       # :934 = 8
sed -n '30,41p' apps/api/src/ai-agents/ai-agents-module.ts       # 11 capability keys
grep -rn "web_search" apps/api/src apps/web/src packages --include='*.ts' --include='*.tsx' | wc -l  # 0
grep -rln "skill" database/migrations | wc -l                    # 0
grep -rin "attachment" apps/api/src/crm-chat | wc -l             # 0
grep -ln "ai_agent_budget_policies" database/migrations/*.sql    # 045, 049
grep -n "evt:\|sched:\|slice(0, 5)\|depth > 3" apps/api/src/ai-agents/runs/triggers.ts  # :200,:296,:179,:375,:58
grep -c "requiresTool" apps/web/src/pages/crm-chat/CRMChatSuggestions.tsx       # 10 lines = 8 chips + interface + filter
grep -rn "assistive" docs README.md plans/SPEC.md                # advanced-integrations.md:123 (+ acceptance-evidence.md:40)
grep -n "Phase 25 — AI Capability Parity" plans/PLAN.md          # :2944 (entry already exists)
```

Plus targeted `sed`/`grep` reads at the exact lines cited in §1–§6 (contract stream events, adapter
registration factory, Anthropic throw, workflow ports, settings schema, gap register, release notes).

## 10. Checks not run / limitations

- **No automated checks executed** (`pnpm verify`, lint, typecheck, tests, `ci:gate`) — AGENTS.MD §4
  reserves them for the developer. "Implemented and verified" in §2 means source-level verification
  plus cited existing suites, not a fresh test run. 25.11/25.12 own executed evidence.
- **Registry count is static** (source keys + test enumeration), not a runtime `list()` call — no
  process was bootstrapped and no database was touched.
- **Twenty rows not re-fetched** carry `Hypothesis` where load-bearing (§8); 25.1 must re-check before
  the canonical matrix repeats them.
- Feature-gated surfaces (execution, triggers, memory, evaluations) were verified **as code**, not as
  enabled behaviour; runtime verification with flags on belongs to the sub-phases that own them.

## 11. Acceptance checklist (plan §6)

- [x] Capability row for every §1.1 axis with evidence, status and owner sub-phase (§2).
- [x] Every task-3 contradiction dispositioned (§3): G99 filed for the doc-drift cluster; remaining
      items corrected in the plan, accepted with reason, or assigned to an owning sub-phase.
- [x] D1–D7 presented; defaults recorded (`phase-25-priority-decisions.md`), owner override window open.
- [x] 24.12 status confirmed; alpha/pilot-only boundary stated (§6).
- [x] No source file, migration, database row or provider account changed.