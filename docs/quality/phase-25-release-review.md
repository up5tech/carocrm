# Phase 25.12 — AI Capability Review and Go/No-Go

> **Status:** The AI review is complete and its decision is recorded here (2026-11-21).
> **Decision:** **GO for alpha/pilot — AI capability only.** **NO-GO for production**, unchanged: the
> Phase 24.12 production gate is still open (`docs/quality/phase-24-12-release-review.md`,
> `docs/releases/2026-11-15-phase-24.md`).
> **Plan:** `plans/PLAN_Phase_25_AI_Capability_Parity.md` §18 (Phase 25.12 — AI Capability Review and Go/No-Go, P0)
> **Predecessor:** Phase 25.11 — golden evaluations and the tool-routing gate
> (`docs/quality/phase-25-eval-evidence.md`).
> **Canonical claim source:** `docs/architecture/ai-capability-matrix.md` — this review verifies it; it does not
> replace it.
> **Executed checks:** none of the gate commands were run in the authoring session (`AGENTS.MD` §4 keeps lint,
> typecheck, tests and the CI gate with the developer). §2 names what *was* checked and §9 what is still owed.

## 1. Objective and scope

Report what is now at parity, what is better, what is deliberately skipped and what remains blocked — for **AI
capability only**.

This review does **not** re-open the product release gate, and it does not claim production readiness, full
Twenty parity or full EspoCRM parity. The Phase 24.12 gate is open and stays open; what this document decides
is narrower and explicit: *may this installation expose the AI capability to an alpha/pilot audience under the
conditions of the Phase 23 review §8?*

## 2. Method — what was checked, and what was not

| Check | How | Result |
|---|---|---|
| Every evidence citation in the canonical matrix resolves | A source-level sweep of every path/line citation in `docs/architecture/ai-capability-matrix.md` (file exists, cited line inside the file, a single-line citation lands on a non-blank line) | **111 citations, all resolve**; **1 was stale** when the review ran — the MCP-door reference in `docs/reference/compatibility-matrix.md` pointed at a blank line and now points at the row itself (`:369`) |
| The phase introduced no tenant dimension | `git diff ad84a8a..2566609` over all 116 changed code files, searched for `tenant` / `workspace_id` / multi-tenant | **Clean** — no tenant line was added. The only hits are pre-existing and unrelated: the provider-account label `tenant_ref` (advanced-integrations) and a pre-existing column in `database.service.ts` |
| The phase introduced no billing surface | Same delta, searched for `credit` / `billing` / `payment` / `invoice` | **Clean** — only comments saying there is no billing table, a CRM field named `creditLimit`, and contract action names |
| The phase introduced no arbitrary code path | Same delta, searched for `eval(`, `new Function`, `child_process`, `execSync`, `spawn(`, dynamic `require` | **Clean** — the only hit is a *test fixture* asserting the workflow validator **rejects** `eval(process.env)` (`packages/workflow/src/validation/index.test.ts:218`) |
| No live vendor call | Phase 25 test files inspected for outbound URLs | **Clean** — every endpoint is a fake or an `example.*` host; the web-search suite stubs `fetch`; the model path uses the deterministic fake provider |
| No Phase 23 control was weakened | `ai-provider-url.ts` and `packages/core/src/net/address.ts` (the SSRF guard) and every file under `docs/security/` | **Untouched** by the phase — the delta contains no change to either, and no exception was added to the register |
| No extra database | The phase's migrations | **Three additive migrations only** — `098_phase25_agent_skills.sql`, `099_phase25_workflow_trigger.sql`, `100_phase25_web_search_citations.sql`. 099 and 100 replace a `CHECK` constraint with the same list plus one value and add one nullable column; no row, table or column is removed or rewritten. No `CREATE DATABASE`, no `DROP`, no `TRUNCATE` |
| The gate commands were executed | `pnpm ci:gate`, `pnpm ci:api-spec --strict`, `pnpm eval:ai`, the focused integration batch, the browser specs | **Not executed** — `AGENTS.MD` §4 assigns them to the developer. §9 lists them, and §5 marks every row whose evidence still awaits a run |

The citation sweep is now a **test**, not a promise: `apps/api/test/ai-capability-matrix-evidence.test.ts` runs
in the nightly DB-free lane and fails when a citation stops resolving.

## 3. Task status (plan §18)

1. **Re-run the gates and record the results — Not executed** (`AGENTS.MD` §4). The commands and the empty result
   columns are in §9; no result is claimed anywhere in this document.
2. **Verify each matrix row against a test or an owner-accepted skip — Done.** §5 gives the per-row verdict; one
   stale citation was repaired and no claim had to be deleted, because every row traces to a test file that
   exists in the repository.
3. **Verify no tenant dimension, billing surface, arbitrary code path, live vendor call, weakened Phase 23
   control or extra database — Done.** §2, with the delta inspected file by file.
4. **Confirm the 24.12 status — Done.** The production gate is open; this review grants **alpha/pilot only**
   (§7).
5. **Update `plans/PLAN.md` §57, `known-gaps.md`, `CHANGELOG.md` and the release notes truthfully — Done**
   (`docs/releases/2026-11-21-phase-25.md`).

## 4. What is at parity, what is better, what is skipped

- **At parity** (shipped value, not packaging): the conversational assistant with page context (row 1), the
  agent definition with reusable versioned skills (row 2), the four trigger kinds with watched fields and
  conditions (row 3), the bounded workflow AI action (row 4), bounded multimodal input (row 5), a bounded cited
  web search (row 6), the provider capability table (row 7), a pinned least-privilege principal (row 8),
  installation-level cost visibility (row 9), a deterministic evaluation gate (row 10) and the shipped
  MCP-compatible tool door (row 11).
- **Better than the reference, deliberately**: fail-closed tool grants at publish, raw-SQL ACL predicates with
  deny-all, bounded JSON output revalidation, encrypted provider keys, SSRF refusal including redirects,
  version-pinned approvals, a deterministic fake provider, trigger recursion/idempotency guards — and the pinned
  execution principal, which the reference does not have (its autonomous runs may keep an agent's role).
- **Deliberately skipped** (owner decisions, `docs/quality/phase-25-priority-decisions.md` §2): credits, billing
  and per-seat allowances; workspace/multi-org agents and per-tenant AI memory; a hosted AI marketplace; vector
  retrieval, embeddings and rerank; Twitter/X search; code-defined agents and model-chosen shell/SQL; new native
  provider adapters; a new MCP surface; SCIM/SAML for AI roles; live vendor certification; a second ORM, SDK or
  CI provider.
- **Named gaps that are not skips**: assignable agent roles (row 8), the model-facing provider presets that are
  declared but untested (row 7), the cron timezone interpretation (row 3), and the model's own routing on
  free-form prompts (row 10).

## 5. Matrix row verification

Verification states: **Verified** — the cited suite exists and was executed by the developer in an earlier
phase; **Source-verified** — the claim traces to code and to a test that exists, but that test has not been run
in the authoring session (`AGENTS.MD` §4); **Partial** — a real capability with a named gap; **Accepted skip** —
an owner decision, not a defect.

| # | Axis | Verification state | Evidence (repository path) | Row verdict |
|---|---|---|---|---|
| 1 | Chat assistant | Source-verified | `apps/api/test/crm-chat-contract.test.ts` (11), `crm-chat-page-context.test.ts` (9), `crm-chat-tool-promises.test.ts` (2), `crm-chat-evaluation.test.ts` (23); contract v1.4.0 in `apps/api/src/crm-chat/crm-chat-contract.ts` | Implemented; page context (25.9) awaits a run |
| 2 | Agent definition | Source-verified | `apps/api/test/ai-agent-skills.test.ts` (6), `ai-agent-skills.integration.test.ts` (5), `ai-agent-config.test.ts` (12); `ai_agent_skills` (migration 098) | Implemented for versioned skills; **code-defined agents — accepted skip** |
| 3 | Agent triggers | Source-verified | `apps/api/test/ai-agent-triggers.test.ts` (20), `ai-agent-trigger-filters.test.ts` (6); `apps/api/src/ai-agents/runs/triggers.ts`, `runs/trigger-filters.ts` | Implemented; feature-gated (default off); cron timezone gap named |
| 4 | Workflow AI | Verified | `packages/workflow/src/validation/index.test.ts` (18), `packages/workflow/src/execute/index.test.ts` (15), `apps/worker/src/workflows/workflow-actions.test.ts` (18), `apps/api/test/ai-agent-workflow.test.ts` (3) | Implemented for the bounded action; system agents — accepted skip |
| 5 | Multimodal input | Source-verified | `apps/api/test/ai-agent-attachments.test.ts` (4); `runs/attachments.ts`, `runs/transcript.ts` | Implemented; ≤10 ids, metadata only, ACL re-checked |
| 6 | Web grounding | Source-verified | `apps/api/test/ai-web-search.test.ts` (12); `apps/api/src/ai-agents/ai-web-search.ts`, `tools/read.ts` | Implemented; fail-closed, untrusted, cited; Twitter/X — accepted skip |
| 7 | Providers | Source-verified | `apps/api/test/ai-providers.test.ts` (27); `ai-provider-presets.ts`, `ai-provider-capabilities.ts` | **Partial** — 24 presets declared, most untested against a live vendor |
| 8 | Permissions | Source-verified | `apps/api/test/ai-agent-principal.test.ts` (4), `ai-agent-actor.test.ts` (10), `ai-agent-self-approval.test.ts` (5); `ai-agents-module.ts` capability entities | **Partial** — the principal is pinned; assignable agent roles remain missing |
| 9 | Cost control | Source-verified | `apps/api/test/ai-agent-cost-report.test.ts` (16), `ai-agent-quota-warning.test.ts` (6), `ai-agent-ledger-observability.test.ts` (4) | Implemented; credits/billing — accepted skip |
| 10 | Evaluation | Source-verified | `apps/api/test/crm-chat-evaluation.test.ts` (23), `ai-agent-evaluations.test.ts` (19), `ai-golden-eval.test.ts` (10), `ai-agent-golden-routing.test.ts` (5), `ai-agent-adversarial.test.ts` (3); `apps/api/src/ai-agents/eval/` | Implemented but **insufficiently verified** — the gate measures a deterministic intent contract, not model routing (G102) |
| 11 | MCP / extensions | Source-verified | `apps/api/test/ai-agent-mcp-idempotency.test.ts` (5), `webhook-outbound-contract.test.ts`; `docs/reference/compatibility-matrix.md:369` | Implemented for the protocol half; model-backed retrieval deferred |
| 12 | Truthfulness | Verified | this review, `docs/architecture/ai-capability-matrix.md`, `docs/quality/known-gaps.md` (G99), `docs/releases/2026-11-21-phase-25.md` | G99 fixed; the **AI capability review is delivered** (§7); the product parity review stays **Open** (24.12) |

**Suite inventory (source counts).** 38 AI and CRM Chat API suites hold **404** test cases — 25 `ai-*` suites
(272, including this review's own evidence check) and 13 `crm-chat-*` suites (132) — plus the workflow package
suites (45) and the worker action suite (18). These counts are `it()` blocks read from the sources; the
executed counts are the developer's to record (§9).

**No row was deleted.** No claim in the matrix lacked an evidence path, so the review downgraded nothing; it
repaired one stale line reference. Where a row cannot be fully verified, the row says so in its own status
column rather than being quietly softened.

## 6. Residual risks

| Risk | Severity | Owner | Review by |
|---|---|---|---|
| The nightly gate has never been executed against the Phase 25 suites — every "source-verified" row in §5 is unproven at runtime | **P1** | developer / release owner | at the next nightly run |
| The model's own routing on free-form prompts is unmeasured; the golden gate scores a deterministic router (G102) | P1 | ai-platform | 25.13 candidate |
| 24 of the 24 provider presets are configuration, not verified adapters; a live vendor call has never been made | P1 | ai-platform + operator | vendor certification pass |
| The cron expression is interpreted in the worker process timezone, not the agent owner's IANA zone (matrix row 3) | P2 | ai-platform | next trigger release |
| Assignable agent roles are missing; the principal is pinned to a user identity instead (matrix row 8) | P2 | product owner | later owner decision |
| Four golden cases need a human review (`docs/quality/phase-25-eval-evidence.md` §6) | P2 | ai-platform | 2026-12-05 |
| The production gate (backup/restore drill, licence outcome, unsigned High/Critical exceptions) is open | **P0 — inherited** | release owner | Phase 24.12 |
| A shared conversation needs its own ACL design; chat sharing is `Accepted — not implemented` | P2 | product owner | not scheduled |

None of the P1/P2 rows above was introduced by this review, and none of them is a security regression: the Phase
23 controls are unchanged and no exception was added.

## 7. Go/No-Go — AI capability only

**GO for alpha/pilot, for the AI capability only.** CaroCRM's AI surface — the conversational assistant, the
agent definition with versioned skills, the four trigger kinds, the bounded workflow AI action, bounded
multimodal input, the bounded cited web search, the provider capability table, the pinned least-privilege
principal, installation-level cost visibility and the deterministic evaluation gate — is coherent, documented and
traceable to tests that exist in the repository.

**NO-GO for production**, unchanged from Phase 23 and Phase 24. The blockers are owner and deployment decisions,
not AI-capability ones: G80/G81 (no installed encrypted off-host backup, no completed restore drill), the
unanswered distribution/licence question, and the unsigned High/Critical exceptions in
`docs/security/exception-register.md` §5.

**Conditions for the alpha/pilot** (carried from `docs/quality/phase-23-security-release-review.md` §8 — the AI
review adds nothing to them and waives none of them):

1. The data is synthetic or demo data, or the owner accepts the G80/G81 risk in writing with a recovery date.
2. `DATABASE_URL`, `JWT_SECRET`, `ENCRYPTION_KEY`, `CORS_ORIGINS` and `EXTENSION_TRUST_MODE=enforce` come from
   the deployment secret store; the boot guards refuse placeholders.
3. No distribution outside the organisation until the licence question is answered.
4. The operator runs the focused integration batch and the browser spec in the target environment before the
   pilot, and repeats the nightly gate each night.

**AI-specific conditions for the pilot:**

5. The AI features stay **feature-gated off** by default. `features.eventTriggers`, `features.scheduledTriggers`,
   `features.portalAssistant` and `features.evaluations` ship off; `settings.search.enabled` ships off; the
   outbound web search answers "not configured" until an operator configures an endpoint.
6. The pilot uses the **fake provider** or a provider the operator has configured and accepts the cost of.
7. Nobody claims a model-backed routing quality: the golden gate measures the deterministic intent contract.

**What would flip the decision to a production GO:** the Phase 24.12 blockers (backup and restore drill, the
licence outcome, signed High/Critical exceptions) **plus** an executed nightly gate over the Phase 25 suites
(§9), so that every "source-verified" row in §5 becomes "Verified".

## 8. What this review does not claim

- It does not claim full Twenty parity. Twenty's skills/agents are documented **alpha** and its external MCP
  declarations **beta, "not live yet"**; CaroCRM compares against shipped value.
- It does not claim full EspoCRM parity, and it does not speak for the non-AI product: 24.10, 24.11 and 24.12
  keep their own open items.
- It does not claim the gates were green. **No gate command was executed** in this pass.
- It does not claim the model's own routing quality, live-vendor behaviour, or a restore drill.
- It does not open a tenant dimension, a billing surface or a second CI provider.

## 9. Outstanding work — the commands the developer runs

| Command | What it proves | Result |
|---|---|---|
| `pnpm ci:gate` | lint, typecheck, build, the pure unit lane, the worker lane, the migration check and the secret scan | _to be filled_ |
| `pnpm ci:api-spec --strict` | every documented route matches a live controller route and every `/api` route is documented (the phase added no route, only a response field) | _to be filled_ |
| `pnpm eval:ai` | the golden tool-routing gate: 40/40 deterministic cases, accuracy 1.00, floor 1.00 | _to be filled_ |
| `pnpm vitest run apps/api/test/ai-agent-golden-routing.test.ts` | the selected tool on the manual run, workflow step, scheduled trigger, skill and web-search surfaces | _to be filled_ |
| `pnpm vitest run apps/api/test/ai-*.test.ts apps/api/test/crm-chat-*.test.ts` | the 37 AI and CRM Chat suites against the configured primary database | _to be filled_ |
| `pnpm vitest run packages/workflow/src apps/worker/src/workflows/workflow-actions.test.ts` | the bounded workflow AI action, validation and the worker door | _to be filled_ |
| `pnpm vitest run apps/api/test/ai-capability-matrix-evidence.test.ts` | every matrix citation still resolves | _to be filled_ |
| the browser spec for the chat surface | the chat UI in the pilot environment | _to be filled_ |

When those run, §5's "Source-verified" states become "Verified", and the only remaining AI-capability item is
the model-routing gap (G102), which no gate in this phase can close.

## 10. Verification of this review

- The citation sweep (§2) and the delta checks (§2) are source-level inspections performed in the authoring
  session; the citation sweep is now the nightly test `apps/api/test/ai-capability-matrix-evidence.test.ts`.
- **No lint, typecheck, test, `pnpm verify` or CI-gate command was run** (`AGENTS.MD` §4). No result in this
  document is a test result.
- No code, migration, database, provider, deployment or release action was taken in this pass; the decision
  recorded here is an **alpha/pilot GO for AI capability only**, and it grants no production readiness.
