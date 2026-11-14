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
| G30 | Medium | platform | **Narrowed 2026-11-12** — `system.cleanupStreamOrphans` now removes old stream rows whose known record no longer exists; **attachment rows/files for a hard-deleted parent are still not swept** | Attachment reads answer to the parent ACL (23.6), so an orphan is unreadable; the residual is inert storage growth | 2026-12-12 | `apps/worker/src/handlers/job-handlers.ts` (`CLEANUP_STREAM_ORPHANS_SQL`); `job-handlers.test.ts`; `docs/security/data-retention.md` §2 |
| G97 | Low | platform / release | Dependency-vulnerability audit is manual; no network-dependent `pnpm audit` step is in the nightly gate | Single lockfile + `--frozen-lockfile`; release checklist runs `pnpm audit --prod` and records the result | 2027-03-31 | `.github/workflows/quality-gate.yml`; `package.json`; `docs/quality/known-gaps.md` G97 |
| G98 | Low | extensions / release | The three sample packages in `modules/` are unsigned, so production `EXTENSION_TRUST_MODE=enforce` refuses them | Fails closed (no code loads); `warn` is the development default; signing procedure in `docs/extension-sdk.md` §8 | 2027-03-31 | `modules/*/extension.sig` absent; `packages/extension-sdk/src/trust/index.test.ts`; `docs/extension-sdk.md` §8 |
| G89 | Medium | worker / platform | The worker's BPM/workflow handlers write CRM records through the worker's own database access, bypassing the API's ACL layer | The handlers are system-scoped automation and documented as such; user-scoped async work goes through `runAsUser` and re-derives the principal at execution | 2026-12-13 | `apps/api/src/common/async-principal.ts`; `docs/quality/authorization-matrix.md` §14.1; Phase 23.4 status block |
| G90 | Low | platform | `GET /api/v1/OpenApi` is served without authentication and exposes the whole route surface (a route inventory with no DTO schemas, see G1) | The document contains route names only — no data, credentials or example payloads; the route inventory is also in the repository | 2026-12-13 | `apps/api/src/bootstrap.ts` OpenAPI registration; `docs/reference/compatibility-matrix.md` row 22; G1 |
| G91 | Low | platform | `/health/ready` answers database reachability to an anonymous caller | It returns no credentials, schema or row data, and is intended for a deployment-internal probe; external exposure is a deployment decision recorded in `docs/security/deployment-baseline.md` | 2026-12-13 | `apps/api/src/bootstrap.ts` readiness route; `docs/security/deployment-baseline.md` |
| G92 | Medium | platform (CI) | The DB-free nightly lane carries no API authorization assertion; the ACL/BOLA suites boot the configured database and stay sandbox-only | The nightly lane covers SSRF and the security-event contract; authorization is exercised by the sandbox layer and by the local `pnpm verify` habit that `AGENTS.MD` §4 requires | 2026-12-13 | `vitest.ci.config.ts`; `docs/quality/ci-gates.md`; Phase 23.10 evidence §"Not run / limitations" |
| G95 | Medium | ai-agents | The AI-agent trigger door reads only the first 20 published agents, ordered by a random UUID, so a matching agent can be invisible | A trigger that finds no agent does nothing; an agent that does run is still gated by its own policy and approvals | 2026-12-13 | `apps/api/src/ai-agents` trigger lookup; `docs/quality/known-gaps.md` G95 |
| G77 | Medium | platform / operations | No continuous metrics/tracing exporter; metrics are derived module documents | Module metric endpoints and the operations snapshot are the interim answer | 2026-12-09 | Accepted in 22.21 |
| G78 | Medium | platform | CI is a **nightly** integrity check, not a PR gate | The owner decision for Phase 23.0 is to keep nightly-only (see `docs/security/phase-23-security-baseline.md` §6, decision D3); the local `pnpm verify` habit remains required | 2026-12-09 | `.github/workflows/quality-gate.yml` — `schedule` + `workflow_dispatch` only, no `pull_request` trigger |
| G80 | Medium | platform / operations | The restore drill is blocked: no approved isolated recovery environment and no approved RPO/RTO | Tooling is shipped (`scripts/restore-drill.mjs`) and refuses to create a database; the configured primary is never a target | 2026-12-09 | Phase 23.0 decision D4 — **23.9 stays Blocked**; `scripts/restore-drill.mjs` refuses the primary and any known application database name |
| G81 | High | platform / operations | No automated, encrypted, off-host backup is **installed**; the demo artifact is partial | `scripts/backup.mjs` requires encryption by default and writes 700/600; the systemd timer template is shipped, not installed | 2026-12-09 | `scripts/backup.mjs`, `scripts/deploy/backup.service.example`; deployment steps remain owner-owned |
| — | High (release) | owner / legal | No repository `LICENSE`; the clean-room / AGPL distribution compliance review has no recorded owner outcome | No distribution claim is made; this stays an explicit release blocker | 2026-12-09 | `README.md` "Licensing"; `AGENTS.MD` §6; no `LICENSE` file in the repository root |
| — | High (design) | owner / architecture | Multi-tenancy is **not** a Phase 23 deliverable. §48 "Tenant isolation" is unmet by design: the deployment is single-tenant | Phase 23.0 decision D2, ratified as the permanent product boundary in Phase 24.1 — no implementation is scheduled; reversing it requires a new owner decision and a separate plan (`docs/security/tenancy-decision.md` §4) | 2026-12-09 | `README.md:221`; `docs/security/phase-23-security-baseline.md` §6 decision D2 |

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
- **Phase 23.10 reconciliation (2026-11-13).** The five findings that Phase 23.4, 23.8 and 23.9 left only in
  `docs/quality/known-gaps.md` are now registered here as live exceptions with a named owner and a review date:
  **G89** (worker BPM writes), **G90** (unauthenticated OpenAPI route inventory), **G91** (anonymous readiness
  probe), **G92** (no authorization assertion in the DB-free lane) and **G95** (first-20 agent trigger lookup).
  Their review date is 2026-12-13, one month after registration, matching the existing cadence. The Phase 22.17
  register (`docs/quality/phase-22-security-privacy-regression-suite.md` §9) points here and records each of its
  own rows as closed or carried.

## 5. Owner decisions and signatures pending (Phase 24.2, 2026-11-14)

Phase 24.2 §8 tasks 5 and 6 require owner signatures on the High/Critical rows and a recorded G1/D3
sign-off. An agent may not accept or sign any of them. This section **does not change** any §2 row's
status, scope, owner, severity or review date; it records that the required signatures are absent, so
the release gate stays NO-GO.

| Item | Severity / class | Required signatory | Signature status | Decision record |
|---|---|---|---|---|
| G81 — no installed, encrypted, off-host backup | **High** | owner / platform-operations | **UNSIGNED** | §2 row; `docs/quality/known-gaps.md` G81 (24.2 read-only verification) |
| — no `LICENSE` / clean-room distribution outcome | **High (release)** | owner / legal | **UNSIGNED** | §2 row; `docs/security/distribution-compliance.md` §6 |
| — multi-tenancy absent by decision | **High (design)** | owner / architecture | **UNSIGNED** | §2 row; `docs/reference/product-charter.md`, `docs/security/tenancy-decision.md` (24.1) |
| G1 — route-inventory deviation (D3) | Medium (contract) | owner | **D3 default applied at 24.0; sign-off pending** | `docs/quality/known-gaps.md` G1 §"Phase 24.2" |
| G90 — `GET /OpenApi` served anonymously | Low | owner | **UNDECIDED** — D3 does not resolve it | §2 row |

Notes:

- **No exception was accepted, closed or signed by the coding agent.** G1 is *not* added to §2 as an
  accepted exception: its D3 disposition is a recorded plan default awaiting signature, and G1 stays
  `Partial` in the gap register until `pnpm ci:api-spec --strict` is green in 24.4.
- The Phase 24.1 boundary decision reworded the High (design) row's mitigation to
  "Not applicable by decision"; that is a product decision, **not** an acceptance of the exception.
- `pnpm ci:gate` being green is not evidence that any exception was accepted. The §48 gate row still
  reads **PASS with unsigned exceptions**.
- No review date was extended and no severity was re-scored by 24.2.
