---
title: "19-AI.21 self-approval policy: the decision and what it broke"
author: Jacky
date: 2026-11-07
branch: master
cost: { minutes: 90 }
id: l-a8854527
scope: repo
status: active
src: agent
touches:
  - apps/api/src/ai-agents/ai-agent-approvals.service.ts
  - apps/api/src/ai-agents/ai-agents-settings.service.ts
  - apps/api/test/ai-agent-runs.test.ts
---

## Decided
- Phase 19-AI.21 (§24 of plans/PLAN_Phase_19_AI_Agents.md) shipped the **self-approval policy**: a
  `material_write` / `high_impact` proposal may not be approved by the person it was requested from.
  Setting `approval.selfApprovalPolicy` = `forbidden` (default) or `permitted_with_audit`.
  The permissive mode is NOT a blank cheque: the requester's signature is recorded
  (`revalidation.secondApprovalRequired`, timeline event `approval.self_signed`) and a **second**
  approver is still required. Codes: `AI_APPROVAL_SELF_APPROVAL_FORBIDDEN` (403) and
  `AI_APPROVAL_SECOND_APPROVER_REQUIRED` (403). Service code + one additive settings field, **no
  migration**; rollback is a settings write.
- Why "forbidden" and not "allowed with a warning": the threat is the shape of the audit trail, not
  the privilege level — one person wearing two hats. The check is deliberately not an admin bypass.
- Rejecting one's own proposal stays allowed (refusing an action is the safe direction, and a
  requester must be able to cancel their own run). `read` / `low_write` proposals are not gated.
- The policy check runs **after** `revalidationFailure()`: a proposal whose target already moved is
  invalidated and the run blocked, whoever asks.
- Precedent in this repo: eSignature's `approval.preventSelfApproval` +
  `SIGNATURE_APPROVAL_SEPARATION_REQUIRED` (apps/api/src/esignature/). The AI Agents codes follow the
  same shape rather than inventing a second one.

## What it broke (and the fix)
- Any suite where the same principal started the run **and** approved it. The approval path asserts
  the `approval` capability, so the requester in the new suite needs `AIAgentApproval: edit` too,
  and the existing suites now decide with a **second** approver user: `apps/api/test/ai-agent-runs.test.ts`
  (8 call sites) and `apps/api/test/omnichannel-ai.test.ts` (1). `phase22-journey-ai-controlled-actions`
  was already safe (the starter and the reviewer are different users).
- `apps/api/test/phase19-module-declarations.test.ts` **pins the exact `implementedPhases` list** —
  adding a phase to `AI_AGENTS_MODULE.implementedPhases` fails it until the list and the evidence
  map are updated. Every module phase lands in two places.

## Pre-existing failures at HEAD (not caused by this phase)
Verified by stashing the change and re-running: `ai-agent-triggers.test.ts` (trigger door, flaky by
suite order), `crm-chat-security.test.ts` (context-reference limit), `service-desk.test.ts` (default
settings row) and `phase22-journey-ai-controlled-actions.test.ts` step 4 (CRMChat help retrieval
ranks module docs above the seeded article). Do not chase these as regressions of a new phase.

## Audit result (configured primary database, read-only)
3 approvals in the existing history were decided by their own requester (1 `material_write`
executed, 1 rejected, 1 invalidated, all 2026-10-24). The rule applies to new decisions; nothing was
rewritten. Repeatable with `pnpm tsx scripts/audit-ai-self-approvals.ts` (one SELECT, no writes).
