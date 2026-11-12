# Security Exception Register

> **Owner:** platform / security
> **Created:** 2026-11-09 (Phase 23.0)
> **Rule:** this is the **single** list of accepted security exceptions. Other documents link here; they do not keep a second table.
> **Predecessor:** `docs/quality/phase-22-security-privacy-regression-suite.md` §9 (Phase 22.17) — reconciled into this file on 2026-11-09.

## 1. What makes an exception valid

Per `plans/PLAN_Phase_23_Security_Hardening.md` §21, an exception is valid only with **all** of:

1. a finding ID (the `G`-register in `docs/quality/known-gaps.md`, or `F`-ID for the Phase 22 authorization findings);
2. a severity;
3. the exact scope of what is left unfixed;
4. a mitigation;
5. a **named** owner;
6. a review date;
7. the evidence that the residual risk was reproduced.

An exception without a review date is **not** an exception — it is an open finding.
A review date that has passed **reopens** the finding automatically.
`High` and `Critical` exceptions require explicit owner acceptance; the coding agent may not accept them.

## 2. Live exceptions

Each row was re-verified against source on 2026-11-09 unless the row says otherwise.

| ID | Severity | Owner | Scope | Mitigation | Review date | Evidence (2026-11-09) |
|---|---|---|---|---|---|---|
| G48 | Medium | advanced-integrations | The resilience layer (rate limiter, retry policy, `assertCallable`) is not engaged on the sync path — `options.rateLimit` is honoured but never produced | Provider HTTP retry exists at the transport layer | 2026-12-09 | `apps/api/src/advanced-integrations/connector-executor.service.ts:38,99-100`; no `rateLimit:` producer in `apps/api/src` |
| G49 | Low | advanced-integrations | `deletionPolicy: 'archive'` behaves exactly like `'unlink'` — only `'ignore'` is branched | Replay flips a status + writes an audit row; no data loss | 2026-12-09 | `apps/api/src/advanced-integrations/sync-orchestrator.service.ts:490-520` |
| G33 | Medium | marketing-automation | **Closed 2026-11-12** — the marketing door verifies HMAC-SHA256 over `timestamp + "." + rawBody`, the timestamp is mandatory and inside the signed material, and a missing/stale delivery is rejected | — (closed) | — (closed) | `apps/api/src/marketing-automation/marketing-event-ingestion.service.ts`; `apps/api/test/marketing-automation-events.test.ts` |
| G64 | Medium | platform / SPA | ~142 SPA call sites render raw `error.message` instead of the code-aware helper | The code-aware helper exists and new code uses it; the API envelope is unchanged | 2026-12-09 | `grep -rn "error instanceof Error ? error.message" apps/web/src` → 142 sites |
| G65 | Low | platform / SPA | **Closed 2026-11-12** — the dead client-side role rule is removed; `pickDefaultDashboard` no longer takes roles and the server's dashboard list is the only filter | Was a presentation rule; every data access was already server-enforced | — (closed) | `apps/web/src/state/dashboard-default.ts`, `pages/DashboardsPage.tsx`, `pages/home/PulseStrip.tsx`; `docs/quality/known-gaps.md` G65 |
| G30 | Medium | platform | Hard-deleting an entity leaves `stream_items` and attachment rows behind as orphans | The orphans are inert rows; no cross-tenant or cross-role exposure was found | 2026-12-09 | Accepted in 22.19, deferred to 22.21 retention |
| G77 | Medium | platform / operations | No continuous metrics/tracing exporter; metrics are derived module documents | Module metric endpoints and the operations snapshot are the interim answer | 2026-12-09 | Accepted in 22.21 |
| G78 | Medium | platform | CI is a **nightly** integrity check, not a PR gate | The owner decision for Phase 23.0 is to keep nightly-only (see `docs/security/phase-23-security-baseline.md` §6, decision D3); the local `pnpm verify` habit remains required | 2026-12-09 | `.github/workflows/quality-gate.yml` — `schedule` + `workflow_dispatch` only, no `pull_request` trigger |
| G80 | Medium | platform / operations | The restore drill is blocked: no approved isolated recovery environment and no approved RPO/RTO | Tooling is shipped (`scripts/restore-drill.mjs`) and refuses to create a database; the configured primary is never a target | 2026-12-09 | Phase 23.0 decision D4 — **23.9 stays Blocked**; `scripts/restore-drill.mjs` refuses the primary and any known application database name |
| G81 | High | platform / operations | No automated, encrypted, off-host backup is **installed**; the demo artifact is partial | `scripts/backup.mjs` requires encryption by default and writes 700/600; the systemd timer template is shipped, not installed | 2026-12-09 | `scripts/backup.mjs`, `scripts/deploy/backup.service.example`; deployment steps remain owner-owned |
| — | High (release) | owner / legal | No repository `LICENSE`; the clean-room / AGPL distribution compliance review has no recorded owner outcome | No distribution claim is made; this stays an explicit release blocker | 2026-12-09 | `README.md` "Licensing"; `AGENTS.MD` §6; no `LICENSE` file in the repository root |
| — | High (design) | owner / architecture | Multi-tenancy is **not** a Phase 23 deliverable. §48 "Tenant isolation" is unmet by design: the deployment is single-tenant | Phase 23.0 decision D2 — document the single-tenant boundary and the isolation requirement; implementation is a separate phase | 2026-12-09 | `README.md:221`; `docs/security/phase-23-security-baseline.md` §6 decision D2 |

## 3. Exceptions closed at Phase 23.0

These were listed as live exceptions in the Phase 22.17 register but are **Fixed** in the current code. They were closed here, not carried forward.

| ID | Phase 22.17 said | Phase 23.0 finding | Evidence |
|---|---|---|---|
| G37 | Medium exception, review 2026-11-15 | **Fixed 2026-11-03** — a user whose Case scope is `own` can create a Case | `apps/api/src/service-desk/service-desk-write-guard.service.ts:94,144` (`isSelfOwnershipOnCreate`); commit `fe27adb` |
| G38 | Medium exception, review 2026-11-15 | **Fixed 2026-11-03** — `features.readTools` is now enforced on the turn and query/execute routes | `apps/api/src/crm-chat/crm-chat.controller.ts:247,385` (`policy.assertFeature('readTools')`) |
| G39 | Low exception, review 2026-11-15 | **Fixed 2026-11-03** — a turn's `sources` are re-authorized before being returned | `apps/api/src/crm-chat/crm-chat-citations.service.ts:410` (`reauthorizedResult`), applied at `crm-chat-ai-agents-client.service.ts:128` |
| G63 | Medium exception, review 2026-11-15 | **Fixed 2026-11-03** — every standalone `/admin/*` SPA route is wrapped in `RequireAdministration` | `apps/web/src/admin/RequireAdministration.tsx`; `apps/web/src/AppRoutes.tsx:212-221` |
| G47 | Medium exception, review 2026-12-09 | **Fixed 2026-11-11** — the connector executor refreshes an expired (or nearly expired) token **before** the provider call, and a provider that refuses the credential gets exactly **one** bounded retry with a fresh token | `apps/api/src/advanced-integrations/connector-executor.service.ts` (`refreshIfExpiring`, `refreshAfterRefusal`); `oauth-flow.service.ts` (`OAuthRefreshOptions`, `needsRefresh`); test `apps/api/test/phase23-3-oauth-connector.test.ts` |
| G50 | Medium exception, review 2026-12-09 | **Fixed 2026-11-11** — a mapping may name the connection it belongs to; a provider with more than one connection is **refused** instead of resolved by name order | `apps/api/src/advanced-integrations/advanced-integrations.controller.ts` (`resolveConnectionId`); `dto/advanced-integrations-shapes.ts` (`MappingCreateSchema.connectionId`); test `apps/api/test/phase23-3-oauth-connector.test.ts` |
| G51 | Medium exception, review 2026-12-09 | **Fixed 2026-11-11** — the callback now carries the echoed `redirect_uri` and the flow compares it with the value the platform sent, **before** the code is exchanged; a tampered state row is refused | `apps/api/src/advanced-integrations/oauth-flow.service.ts` (`complete`); `oauth-callback.controller.ts`; `dto/advanced-integrations-shapes.ts` (`OAuthCallbackSchema.redirect_uri`); test `apps/api/test/phase23-3-oauth-connector.test.ts` |
| G84 | Medium finding, target 23.3 | **Fixed 2026-11-11** — the callback comment now describes a check that exists (same change as G51) | `apps/api/src/advanced-integrations/oauth-callback.controller.ts` (header comment) |
| G86 | Medium finding, target 23.5 | **Fixed 2026-11-12** — one shared address classifier; the voice media fetch pins `redirect:'error'`; an empty media allowlist refuses every fetch | `packages/core/src/net/address.ts`; `apps/api/test/phase23-5-ssrf.test.ts`; `docs/quality/known-gaps.md` G86 |

## 4. Register hygiene

- The Phase 22.17 register listed only **9** findings while `docs/quality/known-gaps.md` still carried open
  Medium/Low items that were **not** dispositioned anywhere (G33, G50, G51, G52, G53, G66, G67, G68, G29, G27).
  Those are added above or tracked in the gap register with a named owner.
- Review dates are aligned to a single **+30 day** window from the Phase 23.0 baseline date, so the register has
  one cadence instead of two unrelated ones (2026-11-15 / 2026-11-30).
- No exception in this register has been accepted by the coding agent. `High` and `Critical` rows are recorded
  as **open findings with a mitigation**, awaiting owner acceptance.
