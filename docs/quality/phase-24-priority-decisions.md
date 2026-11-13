# Phase 24.0 — Baseline Audit and Priority Reconciliation

> **Date:** 2026-11-14  
> **Plan:** `plans/PLAN_Phase_24_Product_Completion.md` §§0.3, 2, 6  
> **Scope:** audit only. No application code, configuration, CI, database, or provider was changed or contacted.  
> **Baseline:** repository at `master`; working tree was clean before this audit.

## 1. Method and evidence boundary

The audit used the Phase 24 plan, Phase 23 release/evidence records, the exception and gap registers, the API registry, source paths and the commands recorded below. Historical Phase 23 test evidence is cited where it verifies behavior; the Phase 24 commands below establish the current checkout's DB-free baseline. `pnpm ci:gate` is DB-free by `vitest.ci.config.ts`, the worker fake-DB suite, and `docs/quality/ci-gates.md`; it does not exercise database-backed integration tests.

No primary database connection, restore target, backup destination, provider sandbox, live mailbox, or production deployment was used. `pnpm verify` was not run: this is an audit-only phase, and its API suite is database-backed. No business data was modified.

### Current-checkout commands

| Command | Result |
|---|---|
| `git status --short --branch` (before and after) | `master...origin/master`; clean; no tracked changes |
| `pnpm ci:gate` | **Exit 0.** lint/UI conventions (5,178 keys), architecture check, API + web typecheck, workspace build, static migrations, API registry check, DB-free Vitest **88 files / 1,421 tests**, worker **24 files / 248 tests**, web **15 files / 86 tests**, secret scan clean (**2,497 tracked files**) |
| `pnpm ci:api-spec` | **Exit 0** for current documented entries: 4 YAML groups, 63 documented and matched, 0 registry errors; source route inventory has **915** routes, **852 undocumented** |
| `pnpm ci:api-spec --strict` | **Exit 1, expected:** strict mode reports 852 undocumented routes. It did not change files or contact services. |
| `pnpm ci:migrations` | **Exit 0:** 94 migration files; highest `094_phase23_retention_schedules.sql` |
| `pnpm --version`; `node --version` | pnpm **10.0.0**, Node **v24.19.0** |
| `git ls-files` lockfile inventory | one project lockfile, `pnpm-lock.yaml`; no root npm/yarn lockfile |
| `git grep` tenant API surface | `getTenantId` has no caller; `tenantId` fields exist only in the two noted core/ACL declarations. `tenantRef` is used in provider-account adapters and connection lifecycle. |
| Source/docs inventory | locales: `en`, `vi`; root `LICENSE` absent; `CHANGELOG.md` absent; API client entry is an empty placeholder; no production deployment artifact found in the inspected deployment baseline. |

The web build emitted existing Vite/Rollup warnings about dependency annotations, a route imported both statically and dynamically, and large chunks; build still passed. Generated `apps/web/dist` is ignored and did not dirty the tree.

## 2. Priority reconciliation

Assessments use the Phase 24 vocabulary. Owners below are responsible modules/roles, not claims that the owner accepted an exception. The current test references in the Phase 23 evidence document were run in that review; the Phase 24 gate result is not represented as verification of database, restore, provider, or production behavior.

| Priority / recommendation | Current evidence and assessment | Disposition / owner |
|---|---|---|
| P0 — License, clean-room and distribution | `docs/security/distribution-compliance.md` §1–5: no root `LICENSE`, no named reviewer/outcome or completed third-party notices. Confirmed by filesystem inventory. **Missing.** | **Open / owner + legal.** Do not create a license or make a legal conclusion in this audit. Production distribution remains blocked. |
| P0 — Single-tenant product positioning | `docs/security/tenancy-decision.md` states one organisation per deployment, but its status still says isolation is “deferred”; `plans/PLAN.md` §43/§44 text still says “tenant-ready” and tenant-aware APIs. `README.md`, alpha status and compatibility docs have related drift. **Partial.** | **Open / platform + product documentation.** Reconcile in 24.1; do not add tenant isolation. |
| P0 — Backup/restore evidence and RPO/RTO | `docs/quality/phase-23-security-release-review.md` §§4, 7–8 and G80/G81 in `known-gaps.md`: tools/templates exist but backup is not installed and restore drill was not run. No approved recovery target or RPO/RTO. **Blocked.** | **Blocked / platform-operations + owner.** D4 remains a hard gate; no target may be provisioned or substituted in this phase. |
| P0 — PR-gated CI | `.github/workflows/quality-gate.yml` has schedule + manual dispatch only; `docs/quality/ci-gates.md` and G78 record the same. The current `pnpm ci:gate` passes. **Implemented and verified** for the nightly-only choice, not PR protection. | **Accepted decision / platform.** Keep nightly-only; do not change workflow. |
| P0 — API contract and typed client | `api-spec/README.md`, `scripts/check-api-spec.mjs` and current checker run: 63/915 routes covered; strict fails with 852 remaining. `/api/v1/OpenApi` is a route inventory, not DTO schema contract; G1 remains partial. `packages/api-client/src/index.ts` exports nothing and grep found no source consumer. **Partial / Missing** (registry / client respectively). | **Open / platform API.** D3 accepts route-inventory deviation and makes `api-spec/` canonical; close coverage to strict in 24.4. Bound initial typed-client operations and a real consumer then. |
| P0 — Auth: OIDC/MFA/password reset | Phase 23.11 release review §3 and Phase 23 test evidence §§23.2–23.3 report generic OIDC, enforceable MFA, password reset and session/API-key controls; relevant DB-free auth/OIDC tests passed in the current gate. **Implemented and verified** for those bounded features. | **No new work / identity.** SAML/SCIM remain deferred by standing decision. |
| P0-origin / P2 in Phase 24 — Observability/exporter | `docs/quality/known-gaps.md` G77, exception register and deployment baseline §7: bounded process-local counters exist; no exporter, cross-instance aggregation, history or alerting. **Partial.** | **Open / platform-operations; P2 optional** per Phase 24.11. Do not add a second metrics stack during 24.0. |
| P0 — Production installation / topology | `docs/security/deployment-baseline.md` header, §§1, 4, 9 and `docker-compose.yml`: compose is dev-only (published Postgres/Redis, dev credentials/source mount/seed), and no production topology artifact was identified. **Missing.** | **Open / platform + deployment owner.** 24.3; no deployment exercised. |
| P1 — Real inbound IMAP/Graph mail | `apps/api/src/email/index.ts` binds `NullInboundProvider` unconditionally; `packages/mail/src/inbound/index.ts` returns an empty array; `EmailService.pollInbound()` stores provider IDs without mailbox scope. `README.md` says inbound mail is not built, while the compatibility matrix calls the port “implemented”. **Missing** as real ingestion; **Partial** as a port. | **Open / email + service desk.** D5 selects IMAP and Microsoft Graph, not live polling in this audit. |
| P1 — Installation-wide email/calendar sync | Compatibility/provider documents identify Graph notifications but no Google Calendar push; README and matrix note SMTP/outbound UI gaps. D5 limits approved scope; personal/shared mailbox ACL remains required. **Partial.** | **Open / integrations + email.** D5: inbound IMAP + Graph only; Google Calendar push and SES/SendGrid sending are out of scope. Do not infer an unapproved sync surface. |
| P1 — Webhook/events + developer surface | `modules/webhook-integration/README.md` shows an extension outbound delivery path with HMAC, retryable jobs and SSRF checks, but the Phase 24 generic catalogue/replay-window contract is not evidenced there. The API client is placeholder and unused. **Partial.** | **Open / extension + integrations.** D6: no new CLI; extend existing SDK, webhook module and API registry. No GraphQL. |
| P1 — Provider sandbox certification | Phase 23 release review §9 explicitly says no live-vendor certification; no sandbox evidence was created in this audit. **Blocked / insufficiently verified.** | **Open or Blocked per adapter / provider owners.** D5 limits sync scope. No credentials or live/sandbox calls used. |
| P2 — UX completion | `docs/ux/ui-review.md` §§1/F10 reports zero optimistic `onMutate` at its audit, but current source inventory finds **2** occurrences; the UX document is stale. Web dependency inventory contains no chart or rich-text editor package; locales are `en` + `vi`. **Partial; metrics need remeasurement.** | **Open / web UX.** Re-measure and reconcile in 24.10; no UX changes in this audit. |
| P2 — Quality debt / current gap register | `docs/quality/known-gaps.md` summary lacks G85–G87 although the body includes G86/G87; G85 is not present in the inspected register. Phase 23 exceptions remain open/blocked as cited; Phase 24 strict API coverage is incomplete. **Partial.** | **Open / platform quality.** Reconcile IDs/statuses and owners in the responsible sub-phases; do not renumber history. |
| Strategy — avoid chasing Twenty platform DX | Phase 24 plan §2 and D6 explicitly choose built-in module breadth and REST/extension SDK over GraphQL/new CLI; no conflicting implementation was found in the inspected package/workflow inventory. **Implemented and verified as a plan decision.** | **Accepted decision / product + architecture.** Not a feature task. |

### 2.1 In-flight API registry

Registry source of truth for this baseline is `api-spec/README.md` plus its four files (`authentication.yaml`, `entities.yaml`, `metadata.yaml`, `users.yaml`). Current run verifies all documented routes exist and records the live controller inventory. `pnpm ci:api-spec` is in `pnpm ci:gate` and `.github/workflows/quality-gate.yml` invokes that gate nightly. Unfinished groups per `api-spec/README.md` §4 include relationships, attachments, activities/stream, search/import/export/dashboards, reports, workflows/BPM, jobs/schedules, administration, i18n and Phase 19 modules. Strict coverage is not green and is not yet part of the CI gate.

### 2.2 Single-tenant document and code inventory

Direct stale promises found by repository search:

- `plans/PLAN.md` §43 says “tenant-ready” and §43/§44 says repository APIs should be tenant-aware; §48/§57 and other roadmap references also need the scoped reconciliation described in Phase 24.1.
- `docs/security/tenancy-decision.md` header still frames implementation as deferred to a separate phase and §4 calls for a future tenant phase. The Phase 24 plan says convert that trigger list to change control, not a backlog.
- `docs/reference/alpha-status.md` line 72 says tenant-aware APIs are deferred; `docs/reference/compatibility-matrix.md` and `README.md` mention single tenancy but need consistency review.
- Phase 19 planning text contains hypothetical future conditions (“when the platform supports multi-tenancy” / security threat-model lists). Treat as historical or conditional context and review, not as implemented product promises.

Dead field candidates: `tenantId` in `packages/core/src/context/index.ts` and `packages/acl/src/types/index.ts`, plus logger emission in `packages/core/src/logger/index.ts`. `getTenantId()` has no caller in the tracked TypeScript source. The remaining `tenantRef` / `tenant_ref` in `apps/api/src/advanced-integrations/*` and migration 056 are provider-account labels used by connectors, not customer isolation; do not remove them.

### 2.3 Release blockers and open G-IDs carried forward

- **Release NO-GO remains:** G80/G81 backup and restore are blocked; distribution/licensing has no owner outcome; Phase 23 review states unsigned High/Critical exceptions remain unsigned (`docs/quality/phase-23-security-release-review.md` §§4, 6–8).
- **Contract:** G1 remains partial; G90 remains an owner decision for anonymous route inventory exposure. D3 resolves the G1 contract direction only; it does not silently resolve G90.
- **Other live exceptions relevant to planning:** G48/G49/G64/G77/G78/G89/G90/G91/G92/G95/G97/G98 and G80/G81 as listed in `docs/security/exception-register.md`. G78 and the SAML/SCIM deferral are standing decisions; do not reopen them. G85–G87 summary/detail consistency needs review: G85 is not found in the current G register body, G86/G87 are in the body but absent from the summary.
- No exception is accepted or signed by this audit. Owners and review dates stay as recorded in the single exception register.

## 3. Owner decisions D1–D7 recorded for Phase 24

The Phase 24 plan's explicit defaults are recorded below. Where the plan says “default if the owner does not answer,” this records the governing default, **not a new owner signature or acceptance**.

| ID | Decision used | Owner/date/source |
|---|---|---|
| D1 | Ratify single-tenant as the product boundary; do not add tenant isolation. | Owner decision already stated in `plans/PLAN_Phase_24_Product_Completion.md` header and §0.3 (2026-11-13); do not re-ask. |
| D2 | Production remains NO-GO until the release blockers close or the owner explicitly accepts the alpha/pilot risk under the Phase 23 review. | Phase 24 §0.3 default, applied; no new owner acceptance recorded. |
| D3 | Accept G1's route-inventory deviation; `api-spec/` is the canonical reviewed API contract. Complete registry to `--strict`; DTO-derived schemas are required for the bounded generated-client surface, not all endpoints. | Phase 24 §0.3 default, applied. Current G1 disposition/signature still needs documentation; D3 does not decide G90. |
| D4 | Restore drill is **Blocked** pending explicit approval for an already-existing isolated target, permitted writes, RPO and RTO. | Phase 24 §0.3 default, applied; no restore target was inspected or contacted. |
| D5 | Inbound IMAP + Microsoft Graph only; Google Calendar push and SES/SendGrid sending stay out of scope. | Phase 24 §0.3 default, applied; no provider accounts were used. |
| D6 | No new metadata plan/apply CLI this phase; extend existing extension SDK and API-spec tooling. | Phase 24 §0.3 default, applied. |
| D7 | Nightly-only CI remains; add only DB-free coverage to the existing nightly lane. | Owner decision from Phase 23 D3 / G78, reaffirmed 2026-11-09; unchanged. |

SAML/SCIM and enterprise directory sync remain deferred. No GraphQL, PR gate, new test database, CI database service, migration, or new API/contract framework is approved by these decisions.

## 4. Recommended P0-first work order

1. **24.1 — Charter and documentation reconciliation.** Required before implementation sub-phases; resolve the stale single-tenant/tenant-ready text and decide how to treat the unused `tenantId` surfaces. Keep provider `tenantRef` intact.
2. **24.2 — NO-GO closure, independent tasks only.** Owner/legal distribution decision, exception signatures and G1/G90 records may proceed as owner decisions. G80 restore remains blocked until D4 is supplied; do not substitute the primary database.
3. **24.3 — Production install/upgrade artifacts** and **24.4 — API registry/client** can proceed independently after 24.1. 24.4 should continue one API group at a time and not enable strict mode until all routes are covered.
4. **24.5 — Release truthfulness** can correct currently provable facts after 24.1; production installation and complete API-contract claims must wait for verified 24.3/24.4 evidence.
5. Start P1/P2 only after actionable P0 work has an evidenced work order or its remaining blockers are owner/deployment controlled. Then follow 24.6 → 24.7 → 24.9 for inbound/sync certification and 24.4 → 24.8 for typed-client use. 24.10/24.11 may proceed only within their local dependencies; 24.12 is the terminal release review.

## 5. Phase 24.0 result

The current DB-free gate is green, but the product baseline remains **NO-GO for production**. The clearest actionable product blockers are production deployment artifacts, incomplete machine-checked API coverage/typed client, stale product-boundary documentation, and unresolved owner/deployment decisions for recovery and distribution. P1 inbound mail is genuinely absent despite a provider port; UX measurements need a fresh audit. No implementation sub-phase is started by this report. **Phase 24.1 may start after the owner reviews this audit and work order.**
