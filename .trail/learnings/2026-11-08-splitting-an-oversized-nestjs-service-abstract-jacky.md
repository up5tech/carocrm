---
title: "Splitting an oversized NestJS service: abstract base-class chain, not separate providers"
author: Jacky
date: 2026-11-08
branch: master
id: l-2c1b4fd5
scope: repo
status: active
src: agent
touches:
  - apps/api/src/ai-agents/ai-agent-runs.service.ts
  - apps/api/src/ai-agents/ai-agent-tools.ts
  - apps/api/test/phase19-module-declarations.test.ts
  - plans/PLAN_Phase_19_AI_Agents.md
---

## Decided
- Phase 19-AI.25 decomposed the 2,989-line `AIAgentRunService` and 1,912-line `AIToolRegistry`
  without changing behaviour. The pattern that worked: keep **one** `@Injectable()` leaf class and
  split the implementation across an abstract base-class chain in sibling files —
  `AIAgentRunService extends Triggers extends Lifecycle extends Executor extends Core`, and
  `AIToolRegistry extends WriteHandlers extends ReadHandlers extends HandlerBase`.
- Only the leaf redeclares the constructor with the original `@Inject` params and calls `super(...)`;
  intermediate classes are plain abstract classes, so the `*_PROVIDERS` barrel and every importer of
  `./ai-agent-runs.service.js` / `./ai-agent-tools.js` needed zero changes.
- Cross-file methods must be `private` → `protected`; intra-file helpers stay `private`.
- Shared types + pure helpers went to `runs/shared.ts` / `tools/schemas.ts` + `tools/helpers.ts`;
  handler files import schemas/helpers directly, never the `ai-agent-tools.js` barrel at runtime
  (type-only imports back to the facade are fine — they erase).

## Tried and ruled out
- Separate `@Injectable()` services per concern: rejected — the method call graph is too tangled
  (executor↔lifecycle share ~15 private helpers), it would have forced a context/bag-of-deps refactor
  and changed the DI surface for no behavioural gain.

## Watch out
- `pnpm typecheck` is the real safety net for these moves: any lost or misfiled method shows up as a
  `this.x does not exist` error because private methods can't leak across the chain.
- The last method block of a class also swallows the class's closing `}` when slicing by line range —
  check each generated file tail for a doubled brace.
- File-size bound: executor landed at ~1,491 lines, just under the ~1,500 cap; the approval-execution
  trio (pauseForApproval/pendingApprovedAction/executeApprovedAction) can't move to the base because
  they call executor-private methods — direction of inheritance decides placement, not semantics.

In the code: `apps/api/src/ai-agents/runs/{base,executor,lifecycle,triggers,shared}.ts`,
`apps/api/src/ai-agents/tools/{base,read,write,schemas,helpers}.ts`.
