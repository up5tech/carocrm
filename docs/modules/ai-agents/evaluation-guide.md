# AI Agents — Evaluation Guide

## Suites and cases

- `GET /api/v1/AIAgents/action/evaluations` lists suites.
- `POST /api/v1/AIAgents/action/evaluations` ensures the built-in `publication-gate` suite.
- `POST /api/v1/AIAgents/action/evaluations/:suiteKey` adds a case.
- `POST /api/v1/AIAgents/action/agents/:agentId/evaluations/run` runs a suite against a draft checksum.
- `GET /api/v1/AIAgents/action/agents/:agentId/evaluations` lists runs.
- `POST /api/v1/AIAgents/action/agents/:agentId/evaluations/:runId/decide` records a human review decision.
- `GET /api/v1/AIAgents/action/agents/:agentId/evaluations/compare` compares draft vs published.

## Grader kinds

- `deterministic`: gates publication. Covers config schema, tool permissions, approval policy,
  budget bounds, provider policy, memory policy, ownership.
- `review` (human): pending until a person decides; labelled, never overrides a failed deterministic case.
- `model_review`: advisory only; cannot turn a failed deterministic case into a pass.

## Publication gate

- When `features.evaluations` is on and an enabled required suite exists, publishing demands a
  passing run of the exact draft checksum. A stale pass on an older draft does not count.
- `assertPublicationGate` is called inside `publish()`.

## Permissions

- Running an evaluation requires `evaluation` capability; reading runs requires `use`.