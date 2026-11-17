---
title: "Phase 24.10/24.11: optimistic writes, G64/G95 fixes, tenant gate, JSONB baseline"
author: Jacky
date: 2026-11-17
branch: master
id: l-8d7e0bdd
scope: repo
status: active
src: agent
touches:
  - apps/api/src/ai-agents/runs/triggers.ts
---

Session outcomes worth keeping:

1. Playwright API cleanup: page.request.delete with the login headers object fails 400 'Body cannot be empty when content-type is application/json' — Fastify rejects an empty JSON body. Pass only { authorization } for DELETEs (see e2e/optimistic-writes.spec.ts deleteProjectTree).

2. G95 fix pattern: ai-agents trigger doors scanned LIMIT 20 published agents ordered by random UUID. Fixed by publishedTriggerAgents() — one innerJoin ai_agents→ai_agent_versions ON version = current_version (onRef), all published agents, fan-out cap unchanged. Regression seeds 25 filler agents with ids 00000000-…-NN sorting below every real UUID.

3. Single-tenant gate: scripts/check-single-tenant.mjs (wired into pnpm lint) forbids getTenantId/tenantId/tenant_id outside 3 allowlisted files — the surviving hits are Microsoft Graph/Entra tenant ids on inbound mail, a different domain concept.

4. Perf harness scripts/perf-jsonb-scale.ts measures JSONB/EAV on entity_records.attrs with marker-scoped synthetic rows (attrs->>'agentPerfRun') and deletes exactly those rows. At 16k Contacts: list 0.5ms, attrs equality ~7ms, attrs sort ~8ms, offset 5000 ~9ms — G71 offset pagination re-confirmed, no cursor needed.

5. SPA has NO cell-inline-edit surface and zero dangerouslySetInnerHTML — 'inline edit' optimistic-write requirement maps to guarded record forms; documented interpretation in docs/quality/phase-24-10-ux-completion.md.
