# Phase 25 evaluation evidence — the golden dataset and the tool-routing gate

> **Phase:** 25.11 — Golden Evaluations and Regression Gate (P0)
> **Plan:** `plans/PLAN_Phase_25_AI_Capability_Parity.md` §17
> **Delivered:** 2026-11-21
> **Status:** implemented; **the suites were not executed in the authoring session** (AGENTS.MD §4 — the
> developer runs the commands in §4 and records the result in §5).

Twenty publishes SDK testing guidance. This document is CaroCRM's answer to the same question for its own
contract: a **versioned dataset**, a **measurable metric** and a **gate that fails a regression** before it
reaches a release review — with no live model call, no network and no test database.

---

## 1. What the gate measures, and what it does not

The nightly gate has no model and no database (`docs/quality/ci-gates.md` §3, G78 stands). A suite that
needs either cannot run there, so the contract is split in two:

| Layer | Where it runs | What it proves |
|---|---|---|
| **Golden routing suite** (`apps/api/test/ai-golden-eval.test.ts`) | the scheduled DB-free gate (`vitest.ci.config.ts`) | every golden prompt routes to the tool the dataset names, with that tool's real effect class, and only to tools the agent holds |
| **Tool-selection suite** (`apps/api/test/ai-agent-golden-routing.test.ts`) | the sandbox layer, against the configured primary database | the surfaces really do select that tool: a manual run, a workflow AI step, a scheduled trigger, a skill and a web search each record the tool they selected |

The deterministic router (`apps/api/src/ai-agents/eval/ai-agent-tool-routing.ts`) is the **stand-in for the
model** in the DB-free lane. It is a phrase table in English and Vietnamese, not a model, and the document
says so plainly: a golden suite that only ever exercised the fake provider would have measured the fake.
What the golden layer owns is the *contract* — which tool serves which intent, in which language, with
which effect class, and which tools the agent holds. What the sandbox layer owns is the *plumbing* — that
the run, the workflow step, the trigger and the skill end up calling the tool they were asked to call.

**Not covered here:** the model's own routing quality on free-form prompts (no live model call is ever
made), the tool contributions of the sales, projects, lead-score and marketing-automation modules (they are
outside the AI Agents catalogue the golden dataset speaks about), and the four `human_review` cases, which
wait for a person (§6).

---

## 2. The dataset

| | |
|---|---|
| Identifier | `phase-25-golden-routing` |
| Version | `1.0.0` |
| Location | `apps/api/src/ai-agents/eval/ai-agent-golden-dataset.ts` |
| Cases | **46** — 40 deterministic, 4 `human_review`, 2 `model_review` |
| Languages | 26 English, 20 Vietnamese |
| SHA-256 of the cases | `785220500cb447996a5226a2530d931880bb385b22b4afabd606d8c47d898346` |

| Category | Cases | Category | Cases |
|---|---|---|---|
| search | 4 | page-context (25.9) | 2 |
| summary | 2 | activities | 2 |
| aggregate | 2 | mail | 2 |
| report | 3 | docs | 3 |
| cross-module | 3 | web-search (25.8) | 2 |
| workflow (25.5) | 2 | skill (25.4) | 2 |
| trigger (25.6) | 3 | write / read | 2 / 2 |
| negative | 10 | | |

The negatives are the five the plan names — prompt injection, an ACL-masked field, a hallucinated citation,
an unknown tool and an oversized output — plus the read-only guard cases.

### Dispositions

| Disposition | Meaning | Judged by | In the metric? |
|---|---|---|---|
| `deterministic` | the router and the catalogue decide | arithmetic | **yes** |
| `human_review` | a person decides | the agent's owner, by the deadline the case names | no — reported as pending |
| `model_review` | advisory | nobody; the gate never runs it | no — reported as advisory |

`model_review` stays advisory **and billable-free**: the nightly gate makes no model call, so an advisory
case is reported and never executed. `human_review` cases carry an owner and a deadline, because a review
nobody owns is a backlog nobody reads; the dataset's own integrity check fails the suite when one of them
does not.

---

## 3. The metric

**Tool-routing accuracy** — the share of deterministic golden cases whose prompt reaches the tool the
dataset names, with that tool's real effect class, and with only the granted tools in reach.

| | |
|---|---|
| Baseline (measured when the dataset was written) | **1.00** (40 / 40) |
| Floor enforced by the gate | **1.00** — it may only rise |
| Denominator | the 40 deterministic cases; pending and advisory cases never move it |

A failure is named, because "accuracy dropped" is not actionable:

| Reason | Meaning |
|---|---|
| `unknown_tool` | the dataset names a tool the product no longer has |
| `unknown_grant` | the dataset grants a tool the product no longer has |
| `grant_missing` | **the agent does not hold the tool its prompt needs** — the deliberately broken grant |
| `effect_changed` | a tool changed effect class (a read tool that became a write, or the reverse) |
| `read_grant_violation` | a case that says "this agent may only read" holds a write tool |
| `write_on_read_prompt` | **a read-only prompt reached a write tool** (§17 task 3) |
| `misrouted` | the prompt reached another tool, none, or an ambiguous tie |

---

## 4. The commands

```sh
# The golden suite on its own (DB-free, no network, no model):
pnpm eval:ai

# The same suite as part of the scheduled nightly gate:
pnpm test:ci

# The tool-selection suite (sandbox layer, against the configured primary database):
pnpm vitest run apps/api/test/ai-agent-golden-routing.test.ts
```

`pnpm eval:ai` is an alias for the **existing** runner (`vitest` with the CI config) — no second test
runner and no second CI provider were added (G78 stands).

---

## 5. The results

**Not executed in the authoring session.** AGENTS.MD §4 keeps lint, typecheck and the test suites with the
developer, so the numbers below are the *expected* result of the suite as written, and the developer records
the actual run here.

| Check | Expected | Recorded by the developer |
|---|---|---|
| `pnpm eval:ai` — routing cases | 40 / 40 passed, accuracy 1.00, floor 1.00 | _to be filled_ |
| `pnpm eval:ai` — dataset integrity | no issues (every human review has an owner and a deadline) | _to be filled_ |
| `pnpm eval:ai` — broken-grant detection | the case fails with `grant_missing`, accuracy < floor | _to be filled_ |
| `pnpm vitest run apps/api/test/ai-agent-golden-routing.test.ts` | the manual run, the workflow step, the scheduled trigger and the skill record `crm_search_records`; the web search records its citation | _to be filled_ |
| `pnpm test:ci` | the golden suite is part of the nightly lane | _to be filled_ |

What **was** checked while the dataset was written: every deterministic case was routed through the router
with an authoring-time script, and all 40 matched their expectation. That is a check of the dataset against
the router, not a run of the suites.

---

## 6. The review backlog

Four cases cannot be judged by arithmetic, and they are listed here so the backlog is visible rather than
implicit.

| Case | What a reviewer checks | Owner | Due |
|---|---|---|---|
| `negative-injection-en-1` | an injected instruction inside a record never becomes an action | ai-platform | 2026-12-05 |
| `negative-acl-masked-en-1` | a field the caller may not read never reaches the answer | ai-platform | 2026-12-05 |
| `negative-oversized-output-en-1` | an answer stays inside the result bound | ai-platform | 2026-12-05 |
| `negative-oversized-output-vi-1` | the same, in Vietnamese | ai-platform | 2026-12-05 |

The machine-checked half of these cases already exists elsewhere and is **not** re-implemented here: the
adversarial suite (`apps/api/test/ai-agent-adversarial.test.ts`), the chat evaluation suite
(`apps/api/test/crm-chat-evaluation.test.ts`), the citation suite and the result-cap rules.

In the product, a `human_review` evaluation case now names the same things: the **owner** is the agent's
owner (or its team) and the **deadline** is the case's own `grader_config.reviewDue`, or 14 days from the
run that raised it (`apps/api/src/ai-agents/ai-agent-evaluations.service.ts`).

---

## 7. Reproducing the numbers

```sh
pnpm eval:ai                      # the metric, per case and in total
```

The suite prints the dataset identifier, its version, its hash and the measured accuracy, so a stored
evidence snapshot names the exact dataset that produced a number:

```text
golden dataset phase-25-golden-routing v1.0.0 (785220…898346) — tool-routing accuracy 40/40 = 1.0000 (floor 1.00)
```

Changing a case means bumping `GOLDEN_DATASET_VERSION` and re-running the suite; the floor may only rise.
