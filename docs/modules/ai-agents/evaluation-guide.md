# AI Agents — Evaluation Guide

## Suites and cases

- `GET /api/v1/AIAgents/action/evaluations` lists suites.
- `POST /api/v1/AIAgents/action/evaluations` ensures the built-in `publication-gate` suite.
- `POST /api/v1/AIAgents/action/evaluations/:suiteKey` adds a case.
- `POST /api/v1/AIAgents/action/agents/:agentId/evaluations/run` runs a suite against a draft checksum.
- `GET /api/v1/AIAgents/action/agents/:agentId/evaluations` lists runs.
- `POST /api/v1/AIAgents/action/agents/:agentId/evaluations/:runId/decide` records a human review decision.
- `GET /api/v1/AIAgents/action/agents/:agentId/evaluations/compare` compares draft vs published.
- `DELETE /api/v1/AIAgents/action/evaluations/:suiteKey` retires a suite; one that already has runs is
  refused, because deleting it would delete the evidence the gate rests on. Disable it instead.

## Grader kinds

- `deterministic`: gates publication. Covers config schema, tool permissions, approval policy,
  budget bounds, provider policy, memory policy, ownership.
- `review` (human): pending until a person decides; labelled, never overrides a failed deterministic case.
- `model_review`: advisory only; cannot turn a failed deterministic case into a pass.

## Publication gate

- When `features.evaluations` is on and an enabled required suite exists, publishing demands a
  passing run of the exact draft checksum. A stale pass on an older draft does not count.
- `assertPublicationGate` is called inside `publish()`.
- The built-in `publication-gate` suite contains seven deterministic cases **and one `human-review`
  case**, so a fresh run of it ends as `pending_review`, not `passed`. Switching the gate on therefore
  requires a person, not a grader, to clear each draft — that is deliberate (the review slot is where an
  operator records the judgement a config scan cannot make), but it is also the reason the gate is off by
  default and should be switched on only when someone will actually staff it.

## In the admin UI

The **AI Agents → Evaluations** tab (`apps/web/src/pages/ai-agents/AIAgentsEvaluationsTab.tsx`) lists
suites, creates the standard suite, runs a suite against an agent's current draft, and shows each run's
per-case results. A run whose `human-review` case is still pending shows the reason and, for a caller with
the `evaluation` capability, an **Approve** / **Reject** pair with an optional note; that is the only exit
the gate has. A reader without the capability sees the pending state and why, but cannot decide it.

## Retention

Evaluation runs age out with `retention.evaluationsDays`, like the other agent artefacts: `action/retention/run`
deletes them and the dry-run count reports them.

## Permissions

- Reading suites and runs, running a suite and comparing need the `use` capability — a run reads the
  agent's *draft*, so the agent's own visibility also applies and a hidden agent answers 404.
- Creating the standard suite, adding a case, retiring a suite and recording a review decision need the
  `evaluation` capability. Every read and decision is scoped by agent visibility and attributed to the
  caller.