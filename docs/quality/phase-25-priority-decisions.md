# Phase 25 — Priority Decisions and Owner Defaults (25.0)

> **Status:** Recorded 2026-11-18 by the 25.0 baseline (`docs/quality/phase-25-ai-parity-baseline.md`).
> **Decision state:** the plan's §0.3 defaults are **applied** so work can proceed; the owner may
> override any row **before 25.1** by editing this file (append an override note with date and reason —
> do not renumber or delete the default record). No decision here authorises code, migrations, provider
> accounts or release action beyond what the plan already scopes.
> **Boundary:** CaroCRM is single-tenant by design (owner decision 2026-11-13,
> `docs/reference/product-charter.md` §6, `docs/security/tenancy-decision.md` §2). Nothing below
> reopens it.

---

## 1. Owner decisions D1–D7

| ID | Decision | Default applied | Rationale / evidence | Override status |
|---|---|---|---|---|
| D1 | Meaning of "tương đương Twenty" | **Functional parity for a single installation.** No credits, workspace, marketplace or multi-org packaging; explicit skips recorded in the 25.1 matrix. | Twenty's credits/workspace are cloud-commerce features (Live-verified `credits-exhausted` semantics, skills-and-agents.md). CaroCRM already has scoped budgets and a usage ledger; inventing a currency adds billing surface without CRM value. Plan §0.1/§1.3. | Default — owner review pending |
| D2 | Execution principal for workflow AI actions and agent triggers | **The workflow initiator or trigger publisher; never a wider service identity.** Mutating tool grants still require approval; the published agent version pins the principal rule (25.2). | Live verification shows Twenty lets autonomous runs keep the *agent's* role (`runAsWorkspaceMemberId` docs). CaroCRM's default is deliberately stricter: every automated run stays attributable to a real user, matching the existing event-trigger convention (`plans/SPEC.md:8`) and the Phase 23 system-principal findings (G88/G89). The deviation from Twenty must be documented in the 25.1 matrix, not hidden. | Default — owner review pending |
| D3 | Skills: in-product metadata vs TypeScript packages | **In-product versioned skill records** with API/UI administration; no new SDK surface, no code execution. Extensions may reference existing skills only. | Twenty's `defineSkill()` is alpha and code-shaped; the useful half is reusable, versioned instructions. In-product records keep the existing version lifecycle, ACL and injection-eval story; a code-defined skill surface would violate the no-arbitrary-code rule (plan §0.1). | Default — owner review pending |
| D4 | Provider parity depth | **Presets + capability declarations + Anthropic structured-output fallback first.** Native Google/Mistral/xAI adapters are P2 and need an explicit owner decision plus a test vendor. | 24 presets already exist but only 2 real adapters are registered (`index.ts:98-105`); the one documented adapter gap is Anthropic structured output (`ai-provider-anthropic.ts:30,242-245`). Preset coverage without capability claims is marketing, not parity — 25.3 tests the table. New native adapters add vendor surface without a funded test path. | Default — owner review pending |
| D5 | Bounded multimodal input | **Yes, bounded:** ≤ 10 attachments per message, PNG/JPEG/PDF allowlist, size cap, ACL-checked `fileId`, existing file storage, fake provider in CI, no live vision call. | Matches Twenty's shipped shape (Live-verified: ≤ 10, `agent-chat` folder, fail-not-drop). Bounds keep the CRM out of the image-pipeline business; untrusted-text rules (`boundRecord`) apply to extracted content. P2 — skippable only by an explicit override recorded here and in the 25.1 matrix. | Default — owner review pending |
| D6 | Web search | **Provider-native where the adapter supports it; otherwise one operator-configured endpoint behind `assertSafeProviderBaseUrl`.** Twitter/X search out of scope. | Twenty's most visible chat differentiator is grounded answers (Live-verified chatbot + `modelConfiguration.webSearch`). One bounded tool with untrusted snippets, cited URLs and cost accounting closes the gap without an SSRF regression. Fail closed when unconfigured. P2 — skippable only by an explicit override (file a G100+ gap, plan §14 task 5). | Default — owner review pending |
| D7 | Production readiness claim while 24.12 is open | **No.** Alpha/pilot evidence only until 24.12 closes and its NO-GO blockers are resolved or owner-accepted. | `docs/quality/phase-24-12-release-review.md:3-4` (no decision made), `docs/releases/2026-11-15-phase-24.md:78` (NO-GO unchanged). 25.12 is an AI-capability review, not a second production gate. | **Standing constraint — not overridable by this file**; only the 24.12 gate itself can change it. |

## 2. Explicit skip list (recorded, not silently omitted)

These are deliberate non-goals for the Phase 25 release line. The 25.1 canonical matrix
(`docs/architecture/ai-capability-matrix.md`) must carry each as an explicit skip with this file as
the decision source:

1. **Credits, billing, per-seat personal AI allowance** (D1) — Twenty cloud-commerce surface.
2. **Workspace / multi-org agents, per-tenant AI memory or vector namespace, cross-customer retrieval**
   (single-tenant charter; `tenant_ref` in migration 056 stays a provider-account label).
3. **Hosted AI marketplace / app store** (D1).
4. **Vector database, embedding pipeline, pgvector, rerank** — the 19-AI.18 model-backed retrieval
   deferral stands (`plans/PLAN_Phase_19_AI_Agents.md:58`); reopening needs a new owner decision.
5. **Twitter/X search** (D6).
6. **Code-defined agents/skills, arbitrary code execution from models, `eval`, dynamic import,
   model-chosen shell/SQL** (plan §0.1; `packages/workflow/src/actions/index.ts` named-action rule).
7. **New native provider adapters** unless D4 is explicitly overridden with a test vendor.
8. **New MCP surface** — Twenty's `defineMcpServer()` is beta and not live (Live-verified); CaroCRM's
   shipped adapter + idempotent direct calls are the advantage to document, not extend speculatively.
9. **SCIM/SAML for AI roles, live vendor certification, a second ORM/SDK/CI provider/GraphQL**
   (plan §0.1/§1.3; G78 nightly-only CI stands).
10. **Conversation sharing (chat D12)** — remains `Accepted — not implemented`
    (`docs/architecture/crm-chat-contract.md:57`) unless 25.9 implements it with its own ACL design.

## 3. Priority rationale (plan §5)

- **P0 — prerequisite/safety:** 25.0 (this audit), 25.1 (one truthful claim source), 25.2 (a run without
  a defined principal is not safe to automate), 25.11 (parity claims must be testable), 25.12 (honest
  review). P0 blocks *claims*, not necessarily code.
- **P1 — shipped parity value:** 25.3 (provider capability honesty + the one adapter gap), 25.4
  (reusable skills), 25.5 (the clearest gap: workflow AI), 25.6 (trigger filters), 25.9 (page context),
  25.10 (installation cost visibility).
- **P2 — depth/polish, skippable with a recorded decision:** 25.7 (multimodal, D5), 25.8 (web search,
  D6). Skipping either requires an override note in §1 and a matrix skip row — never a silent omission.

## 4. Execution order constraints (from plan §5.1, confirmed by this audit)

1. 25.0 gates everything; 25.1 gates all documentation claims.
2. 25.2 gates 25.5 and 25.6.
3. 25.5 implements the action spec in `packages/workflow` before the worker host, so validation is
   testable DB-free; the executor stays behind `WorkflowExecutorPorts` (verified seam,
   `packages/workflow/src/execute/index.ts:25-30`).
4. **25.11 must exist before 25.4, 25.7, 25.8 or 25.9 claims no injection/ACL/tool-routing regression.**
5. `runs/executor.ts` is at 1,491/1,500 lines — split before growing, or put new behaviour behind an
   existing port (plan §0.1).
6. Stop and file a **G100+** gap (G99 is taken by the 25.0 doc-drift finding) for any task needing a
   live vendor, a tenant dimension, arbitrary code, a destructive migration, or a weakened Phase 23
   control.

## 5. Baseline findings that shape the work

- **G99 (Open, correct in 25.1):** SPEC `MAX_TOOLS` 24 vs code 32; SPEC/compatibility-matrix
  "schedule/integration triggers not implemented" vs shipped gated doors (19-AI.25, default off);
  chat contract status line "through 19-CHAT.24" vs 1.3.0/27 routes.
- **Feature gates default off** (`execution`, `eventTriggers`, `scheduledTriggers`, `memory`,
  `evaluations` — `ai-agents-settings.service.ts:30-42`). Parity claims must say "implemented, off by
  default" where applicable; enabling them in a deployment is an operator action, not a phase deliverable.
- **Anthropic structured output** is the one documented adapter gap (25.3 fallback or G100+ exception).
- **Twenty deviation to document (D2):** autonomous-run principal semantics differ by design.
- **Hypothesis rows** in the baseline §2 (provider list, billing breakdown shape, golden-suite absence)
  must be re-verified against primary sources at 25.1 before the canonical matrix repeats them.