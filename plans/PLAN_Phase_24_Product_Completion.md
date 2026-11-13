# PLAN — Phase 24: Single-Tenant Product Completion (P0 / P1 / P2)

> **Status:** Planned
> **Date:** 2026-11-13
> **Workstream type:** Product completion, release closure, platform DX and UX — the P0/P1/P2 recommendations from the system review, sequenced after the security workstream. Not a new business module and not a rewrite of the Entity Engine.
> **Predecessor:** Phase 23 (`plans/PLAN_Phase_23_Security_Hardening.md`), implemented 2026-11-09 → 2026-11-13; its review records **NO-GO for a production release** (`docs/quality/phase-23-security-release-review.md`)
> **Target platform:** the existing NestJS / Fastify modular monolith, React SPA, PostgreSQL + Kysely, Redis/BullMQ worker, pnpm workspace, and the `api-spec/` endpoint registry started under `plans/PLAN.md` §58
> **Canonical workstream key:** `product-completion`
> **Product decision (owner, 2026-11-13): CaroCRM is single-tenant by design. One deployment serves one customer organisation. There is no tenant-isolation work in this phase.**
> **Scope baseline:** the real repository at 2026-11-13. A plan, an audit note, a class name, or a green build is not proof that a capability exists.
> **Naming rule:** no `Ua` prefix, no second ORM/query layer, no second validation framework, no second test runner, no second package manager, no second CI provider, no second API paradigm, and no duplicate contract or decision document
> **Primary output:** a ratified single-tenant product charter, closed release blockers, a machine-checked public API contract, real inbound mail, a bounded developer surface, provider sandbox evidence, UX completion, and an honest go/no-go review
> **Database policy:** follow `AGENTS.MD` §3 exactly. Use the configured primary database only. Never create a test database, shadow database, schema copy, or per-agent/per-run database; never reset, truncate, or broadly delete data.

---

## 0. Instructions for the Coding Agent

Read these before changing anything:

1. `AGENTS.MD` (§3 database policy, §4 workflow, §5 architecture, §6 clean-room compliance, §9 testing, §10 workspace safety, §11 definition of done).
2. `plans/PLAN.md` §43, §48, §57 (Development Phases), §58 (API Endpoint Inventory Plan), §60 (Compatibility Matrix), and the Phase 22/23 sections of §57.
3. `plans/PLAN_Phase_23_Security_Hardening.md` (especially §19 verification constraints and §21 exception rules), `plans/PLAN_Phase_22_Integration_E2E_Hardening.md` §0 and §35.
4. The current evidence pack: `docs/quality/phase-23-security-release-review.md`, `docs/quality/phase-23-security-test-evidence.md`, `docs/quality/known-gaps.md` (G1–G98), `docs/security/exception-register.md`, `docs/security/tenancy-decision.md`, `docs/security/distribution-compliance.md`, `docs/security/deployment-baseline.md`, `docs/security/phase-23-security-baseline.md`, `docs/quality/ci-gates.md`, `docs/reference/compatibility-matrix.md`, `docs/reference/alpha-status.md`, `README.md`, `api-spec/README.md`, `docs/architecture/contract-catalog.md`, `docs/ux/ui-review.md`, `docs/ux/list-view.md`.
5. Use the repository context tools (`trail ask ... --source`, `graphify query ...`) before broad greps, as required by `AGENTS.MD`. Include the same rule in any sub-agent prompt that explores code.

**Start with Phase 24.0 only.** Do not begin fixes until the baseline audit, the priority reconciliation, and the owner decisions have been presented for review.

### 0.1 Non-negotiable rules

- **Single-tenant is a product boundary, not a backlog item.** Do not add a tenant id, tenant predicate, tenant-scoped session/API key, per-tenant schema, workspace model, cross-tenant test, or "tenant-ready" API. Do not describe shared-tenancy features as deferred work inside this phase; any future change requires a new explicit owner decision and its own plan.
- Evidence over assumption. Claim a capability only with a source path and an executed test or command. Label anything else `Hypothesis`.
- Preserve the modular monolith, the metadata-driven Entity Engine, the existing ACL, and the `/api/v1` REST contract. **No GraphQL**: the REST + `api-spec/` registry is the one public API paradigm. Do not add a second one to imitate another CRM.
- Do not introduce a competing contract layer. `GET /api/v1/OpenApi` (route inventory), `docs/architecture/contract-catalog.md` (prose conventions) and `api-spec/*.yaml` (reviewed per-route contract) already coexist; Phase 24 must decide which is canonical and converge, not add a fourth.
- Preserve work in flight. `api-spec/` is being filled one group at a time under `plans/PLAN.md` §58 and `scripts/check-api-spec.mjs` is already part of `pnpm ci:gate`. Extend that registry; do not fork, regenerate, or replace it.
- Respect standing owner decisions. **CI stays nightly-only** (Phase 23.0 decision D3, reaffirmed 2026-11-09 in `docs/quality/ci-gates.md`; G78 remains an accepted exception). SAML/SCIM and enterprise directory sync stay deferred. Do not reopen these to make a phase look complete.
- Security controls belong to Phase 23. Phase 24 consumes its evidence and exception register; it does not re-implement, weaken, or silently re-score security controls. A new security finding is filed in `docs/quality/known-gaps.md` (continue from **G99**) and dispositioned in `docs/security/exception-register.md`.
- No second package manager, lockfile, ORM, test runner, crypto library, or design system. Use pnpm, Kysely, Vitest, Playwright, Zod, antd and the `carocrm-*` CSS kit.
- All external effects (email, SMS, calls, signatures, payments, campaigns, provider APIs, webhooks) use fakes, fixtures, sandboxes or memory transports. Automated tests and CI must never contact a live vendor or a real customer.
- No extra database, no Testcontainers, no CI database service, no reset/seed/clean hooks. Integration tests use unique `AGENT_TEST_` markers, exact-ID cleanup, and the configured primary database under `AGENTS.MD` §3.
- Migrations are additive, reviewed, version-controlled files under `database/migrations/`, tracked in `schema_migrations`. No destructive migration and no editing migration history.
- No legal assumptions. The coding agent must not choose a `LICENSE`, declare the clean-room review complete, or publish a distribution artifact.
- Report passed/failed/skipped/blocked checks honestly. No claim of complete EspoCRM parity.

### 0.2 Assessment labels

Reuse the Phase 22/23 vocabulary: `Implemented and verified` · `Implemented, insufficiently verified` · `Partial` · `Missing` · `Blocked` · `Not applicable`. Add priority (`P0` / `P1` / `P2`) and disposition (`Open` / `Fixed` / `Accepted` / `Deferred` / `Hypothesis`).

### 0.3 Owner decisions required at 24.0

| ID | Decision | Default if the owner does not answer |
|---|---|---|
| D1 | Ratify **single-tenant as the permanent product boundary** for this release line, superseding the "deferred to a separate phase" wording in `docs/security/tenancy-decision.md` | Ratified as stated by the owner on 2026-11-13; record it, do not re-ask |
| D2 | Are the still-open P0 release blockers (G80/G81 backup + restore, `LICENSE`/distribution, unsigned High exceptions) accepted for an alpha/pilot, or must they close before any release? | Must close before a production GO; alpha/pilot follows `docs/quality/phase-23-security-release-review.md` §8 |
| D3 | G1 disposition: accept the route-inventory deviation and make `api-spec/` canonical, or fund Zod→OpenAPI schema generation for ~772 routes? | Accept the deviation; complete `api-spec/` to `--strict`; keep the generated document as a route inventory |
| D4 | Approved recovery environment, RPO and RTO for the restore drill | 24.2 is **Blocked**; never create a routine test database as a workaround |
| D5 | Scope of email/calendar sync for a single-tenant installation (24.7), and which provider sandbox accounts exist | Inbound IMAP + Microsoft Graph only; Google Calendar push and SES/SendGrid stay out of scope |
| D6 | Should a metadata `plan/apply` CLI be built in 24.8, or is the extension SDK + registry enough? | **No new CLI this phase**; extend the existing extension SDK and `api-spec` tooling instead |
| D7 | Does the nightly-only CI decision (G78) change? | **No** — stands as recorded; only add DB-free coverage to the existing nightly lane |

---

## 1. Purpose and Expected Outcome

Phase 23 made the security controls verifiable. Phase 24 turns the remaining product recommendations into a prioritised, executable plan and closes the gap between "the code works" and "an operator can install, run, integrate and support one installation for one organisation".

### 1.1 Product charter — single-tenant by design

**Decision (owner, 2026-11-13):** one deployment = one customer organisation. Every authenticated principal belongs to that organisation; `sysAdmin` is installation-wide; the database, Redis, worker, queue, file storage, encryption key, JWT secret, extensions and backups belong to that one installation.

**What this means in code and docs**

- ACL, roles and teams separate **users and records inside one organisation**. They are not a tenant boundary.
- Isolation between customers is a **deployment property**, not an application control. It holds only under the five conditions in `docs/security/tenancy-decision.md` §2; the repository does not enforce them.
- There is no `tenant_id` column in any migration. `tenant_ref` in `database/migrations/056_phase19_advanced_integrations.sql` and `tenantRef` in `apps/api/src/advanced-integrations/*` are **provider-account labels**, not isolation fields — do not "clean them up" as tenant residue.
- Dead tenant surface to reconcile: `packages/core/src/context/index.ts:11,36-38` (`tenantId?`, `getTenantId()`), `packages/acl/src/types/index.ts:20`, `packages/core/src/logger/index.ts:67`. Decide whether to remove them or document them as intentionally unused.
- Documents still promising tenant readiness must be corrected: `plans/PLAN.md` §43 and `:1914,1919-1924,1933,2079,2103,2340,3695,1697`; `docs/reference/alpha-status.md:72`; `docs/reference/compatibility-matrix.md:11`; `docs/security/tenancy-decision.md` status line; `README.md` §"Not built yet".

**Explicitly out of scope, permanently for this release line:** tenant ids, tenant-aware queries, per-tenant schemas, workspace/tenant administration, per-tenant rate limits or billing, SCIM for multiple organisations, cross-tenant negative tests, hosted multi-tenant SaaS, and a "tenant isolation phase". The trigger list in `docs/security/tenancy-decision.md` §4 becomes a change-control guard, not a roadmap item.

**Consequences for Phase 24 features:** inbound mail and calendar sync are **installation-wide** configuration, not per-workspace; API keys, OIDC profiles and outbound webhooks belong to the installation; exports, reports, dashboards, search and AI context never span customers; upgrade, backup and restore are per-installation procedures.

### 1.2 Primary outcomes by priority

- **P0 — release and positioning:** a ratified single-tenant charter, closed NO-GO blockers, a production installation/upgrade path, a machine-checked API contract, truthful release documentation, and a final go/no-go review.
- **P1 — capability gaps:** real inbound mail, a bounded installation-wide email/calendar sync decision, an outbound event/webhook catalogue with a generated typed client, and provider sandbox evidence.
- **P2 — experience and debt:** optimistic writes, one data-fetching paradigm, charts and rich text, locale expansion, JSONB/EAV scale baselines, remaining gap closure and dead tenant cleanup.

### 1.3 Boundary with Phase 23

Phase 23 owns the §48 security controls, `docs/security/*`, the exception register, and the security regression suite. Phase 24 does not re-litigate them. Open exceptions (G48/G49/G64/G77/G78/G80/G81/G89/G90/G91/G92/G95/G97/G98) keep their owners and review dates; Phase 24 may **fix** one with a regression test, but may not silently accept or re-score it. G78 (nightly-only CI) and the SAML/SCIM deferral are standing owner decisions and stay out of scope.

---

## 2. Where the P0/P1/P2 Recommendations Stand (2026-11-13)

This table reconciles the original review recommendations with the repository as it exists now. Phase 24 owns only the rows in the last column.

| Priority | Original recommendation | State on 2026-11-13 | Phase 24 owner |
|---|---|---|---|
| P0 | Decide licence + clean-room/AGPL review | **Still blocked.** No root `LICENSE`, no named reviewer/outcome (`docs/security/distribution-compliance.md`); 23.11 NO-GO | 24.2 |
| P0 | Fix single-tenant positioning | Partly documented (`docs/security/tenancy-decision.md`, `README.md`, compatibility matrix) but framed as *deferred*, and `plans/PLAN.md` still promises tenant-ready APIs | 24.1 |
| P0 | Backup/restore drill + RPO/RTO | **Blocked** G80/G81; tooling exists, nothing installed, no approved environment | 24.2 |
| P0 | PR-gated CI | **Rejected by owner** (D3, 2026-11-09): nightly-only stands; G78 is an accepted exception | No work; 24.0 records the decision |
| P0 | Generated OpenAPI contract | **Partial.** Served document is a route inventory: 772 paths, `components.schemas = 0`, no `requestBody`; G1 proposes an accepted deviation awaiting owner sign-off. `api-spec/` registry started: 4 files / 63 documented endpoints of 915 `/api` routes, `--strict` not enabled | 24.4 |
| P0 | Auth gaps: SSO/OIDC, MFA, password reset | **Delivered** by 23.2/23.3: throttling+lockout, self-service reset, enforceable MFA, session revocation, API-key lifecycle, generic OIDC. SAML/SCIM deferred | No work; 24.5 updates docs |
| P0 | Observability / metrics / tracing | Bounded process-local security counters (23.8); G77 (no exporter) is a live accepted exception | 24.11 (P2, optional) |
| P0 | Production deployment topology | `docs/security/deployment-baseline.md` is a review checklist; `docker-compose.yml` is dev-only (placeholder JWT secret, `postgres` password, source mount, no web/worker service) | 24.3 |
| P1 | Real inbound IMAP/Graph mail | **Missing.** `NullInboundProvider` bound unconditionally at `apps/api/src/email/index.ts:67`; `POST /api/v1/Email/action/pollInbound` returns nothing | 24.6 |
| P1 | Email/calendar sync | Microsoft 365 Graph change notifications exist; **Google Calendar push absent**; SES/SendGrid/Graph send and the email UI absent (`docs/reference/compatibility-matrix.md:284-286,299`) | 24.7 |
| P1 | API/DX: GraphQL or generated client + webhooks + CLI | No GraphQL (deliberate). `packages/api-client/src/index.ts` is a placeholder; `apps/web/src/api/client.ts` is a 2,401-line hand-written client; generic outbound event/webhook connector "not started"; no `plan/apply` CLI | 24.8 |
| P1 | Live-vendor smoke tests | Adapters delivered but flagged experimental; no live verification recorded | 24.9 |
| P2 | UX: optimistic writes, rich text, charts, locales | 2 `onMutate` call sites; no chart or rich-text dependency in `apps/web/package.json`; `i18n/` has `en` + `vi`; `docs/ux/ui-review.md` F10/F13 text is stale | 24.10 |
| P2 | Close remaining gaps and stale docs | G83–G98 with status quirks (G85–G87 missing from summary); `README.md:264` says migrations up to `070` (now `094`); in-app release notes stop at Phase 22; no `CHANGELOG.md` or tags | 24.5 + 24.11 |
| Strategy | Do not chase Twenty's platform DX | Still the right call for a single-tenant self-hosted suite; breadth of built-in modules is the differentiator | 24.1 charter, 24.8 decision |

---

## 3. Reference Documents and Standards

Use current primary documentation when implementing a matching sub-phase; pin any new library version in `pnpm-lock.yaml` and record compatibility constraints. Do not add a tool because a document mentions it.

- `plans/PLAN.md` §43 (architecture decisions), §48 (Security Architecture), §57 (Development Phases), §58 (API Endpoint Inventory Plan), §60 (Compatibility Matrix), §72 (priority matrix).
- `AGENTS.MD`, `docs/quality/test-strategy.md`, `docs/quality/ci-gates.md`, `docs/quality/known-gaps.md`, `docs/security/exception-register.md`.
- `api-spec/README.md` — the registry file format, required fields, validator behaviour and coverage table.
- `docs/architecture/contract-catalog.md`, `docs/architecture/module-contracts.md`.
- `docs/compatibility/advanced-integrations/providers.md`, `provider-matrix.md`, `webhook-security.md`; `docs/compatibility/voice-communications.md`; `docs/compatibility/marketing-automation.md`; `docs/compatibility/esignature.md`.
- `docs/ux/ui-review.md`, `docs/ux/list-view.md`, `docs/ux/design-principles.md`, `docs/ux/accessibility.md`.
- EspoCRM public documentation for behavioural parity only, per `AGENTS.MD` §6. No upstream source, assets or translations.
- Provider docs for IMAP, Microsoft Graph and Google Calendar, verified against the version actually integrated.

---

## 4. Governance and Artifacts

### 4.1 New deliverables

1. `docs/reference/product-charter.md` — single-tenant positioning, target operator, non-goals, and the feature-decision rules in §1.1. This is a product document; the security decision stays in `docs/security/tenancy-decision.md`.
2. `docs/quality/phase-24-priority-decisions.md` — the 24.0 audit, the §2 reconciliation, owner decisions D1–D7, and the P0/P1/P2 work order.
3. `docs/quality/phase-24-test-evidence.md` — commands actually run, counts, results, skipped/blocked checks, artifact paths.
4. `docs/quality/phase-24-release-review.md` — the final go/no-go, residual risks, owners and deadlines.
5. `docs/runbooks/installation-and-upgrade.md` — production install, upgrade, rollback, backup/restore link and post-upgrade verification for one installation. Runbooks live in `docs/runbooks/`; do not create a parallel location.
6. `CHANGELOG.md` and a release-note entry for Phase 23/24 in `content/docs/`.
7. `api-spec/*.yaml` — continuation of the §58 registry, one group at a time, ending with `pnpm ci:api-spec --strict` green.
8. `packages/api-client` — a generated typed client from the canonical contract, replacing the placeholder.
9. `apps/api/src/email/inbound/*` — the real inbound adapter(s) selected in 24.6.
10. Automated tests following existing conventions (`apps/api/test/phase24-*.test.ts`, `apps/web` suites, and `e2e/*.spec.ts` only where a browser check is genuinely needed).

### 4.2 Documents to update, not duplicate

`plans/PLAN.md` §43/§57/§58/§60 · `docs/security/tenancy-decision.md` · `docs/security/distribution-compliance.md` · `docs/security/deployment-baseline.md` · `docs/reference/compatibility-matrix.md` · `docs/reference/alpha-status.md` · `README.md` §"Not built yet" and Quick start · `docs/quality/known-gaps.md` · `docs/security/exception-register.md` · `docs/quality/ci-gates.md` · `docs/architecture/contract-catalog.md` · `docs/ux/ui-review.md` / `list-view.md` · `content/docs/en/reference/release-notes.md` and its `vi` counterpart · `plans/PLAN_Phase_23_Security_Hardening.md` header/status drift (its header still says `Planned` while §17 records a NO-GO review).

### 4.3 Defect tracking

Continue the G-ID register from **G99**. Do not renumber history; fix known-gaps summary inconsistencies (G85–G87 are absent from the summary table but present in the body). Each entry needs evidence, priority, owner module, reproduction, expected vs observed, fix reference, regression test path, verification result and residual risk. Accepted exceptions continue to live only in `docs/security/exception-register.md`.

---

## 5. Priority Definitions and Roadmap Overview

- **P0 — release-blocking.** Without it there is no honest production GO for a single-tenant installation. Do P0 first; a P0 blocker stops the next sub-phase.
- **P1 — capability.** Materially closes a product gap for an installed single-tenant deployment, but an alpha/pilot can run without it.
- **P2 — experience and debt.** Improves adoption and maintainability; never used to justify delaying a P0 blocker.

Implement in order. Each sub-phase ends with a short evidence report and must not auto-continue if it exposes a new P0 architectural issue.

| Sub-phase | Name | Priority | Key output |
|---|---|---|---|
| 24.0 | Baseline audit and priority reconciliation | P0 | Evidence-based inventory, D1–D7, no code changes |
| 24.1 | Single-tenant charter and documentation reconciliation | P0 | Ratified boundary, corrected PLAN/alpha-status/matrix/README, dead tenant surface decision |
| 24.2 | NO-GO blocker closure | P0 | G80/G81 evidence or explicit owner acceptance; distribution decision; signed exceptions |
| 24.3 | Production installation and upgrade | P0 | Production compose/images, secret injection, upgrade/rollback runbook, install smoke |
| 24.4 | Canonical API contract and typed client | P0 | `api-spec/` complete to `--strict`, G1 disposition, generated `packages/api-client` |
| 24.5 | Release truthfulness | P0 | Changelog, release notes, versioning, corrected README/migration counts, status drift fixed |
| 24.6 | Real inbound mail | P1 | IMAP/Graph adapter replacing the null provider, dedupe, thread linking, email-to-case |
| 24.7 | Installation-wide email/calendar sync | P1 | Bounded scope decision, one-org configuration, sync evidence |
| 24.8 | Outbound events and developer surface | P1 | Webhook/event catalogue, signed deliveries, typed client consumption; no GraphQL, no new CLI by default |
| 24.9 | Provider sandbox certification | P1 | Documented live/sandbox verification for voice, e-sign, marketing and sync adapters |
| 24.10 | UX completion | P2 | Optimistic writes, one data-fetching paradigm, charts, rich text, locales, refreshed UX docs |
| 24.11 | Quality debt and single-tenant scale | P2 | Remaining gaps, dead tenant cleanup, JSONB/EAV baselines, pagination snapshot decision |
| 24.12 | Product release review and go/no-go | P0 | Final evidence, updated status docs, honest recommendation |

---

## 6. Phase 24.0 — Baseline Audit and Priority Reconciliation (P0)

### Objective

Re-establish the true state of the product before planning fixes, and record the owner decisions that bound everything after it.

### Tasks

1. Re-read `AGENTS.MD`, `plans/PLAN.md` §43/§57/§58/§60, the Phase 23 plan and review, and the evidence pack listed in §0.
2. Verify every row of §2 against source paths and an executed test or command. Mark each with an assessment label from §0.2.
3. Record the current baseline numbers rather than reusing the review's: migration count, `pnpm ci:gate` result, `api-spec/` coverage (documented/matched/undocumented against the live controller route table), locale count, dependency state, and open G-IDs.
4. Inventory the in-flight §58 registry work and confirm `pnpm ci:api-spec` is part of `pnpm ci:gate`. Note which groups are unfinished in `api-spec/README.md` §4.
5. Inventory every document that still promises multi-tenancy or tenant-ready APIs (§1.1) and every dead tenant field. Classify `tenant_ref`/`tenantRef` separately as a provider-account label.
6. Record D1–D7 from §0.3. D1 is already given by the owner; do not re-ask it. D4 missing means 24.2 starts `Blocked`.
7. Produce `docs/quality/phase-24-priority-decisions.md` and a recommended P0-first work order.

### Acceptance criteria

- Every §2 row has a source path, a test/command reference, a label and an owner.
- D1–D7 are recorded with the decision, the owner and the date; standing decisions (nightly CI, SAML/SCIM deferral) are explicitly restated as unchanged.
- No business data was modified; no code, configuration, or CI file was changed during the audit.
- The next sub-phase starts only after review.

---

## 7. Phase 24.1 — Single-Tenant Charter and Documentation Reconciliation (P0)

### Objective

Turn `docs/security/tenancy-decision.md` from "deferred to a separate phase" into a firm product boundary, and make every document agree.

### Tasks

1. Write `docs/reference/product-charter.md`: one deployment = one organisation; target operator (self-hosting admin); non-goals (SaaS, shared tenancy, workspace isolation, per-tenant billing, cross-customer reporting); the differentiator (breadth of built-in business modules); and a rule that any feature assuming a tenant id is rejected at review.
2. Update `docs/security/tenancy-decision.md` status from "deferred" to **decided product boundary**, keep §2's five deployment-separation conditions and §5's residual risks, and convert §4's trigger list into a change-control guard requiring a new owner decision and a separate plan.
3. Reconcile `plans/PLAN.md` §43 and the tenant-readiness passages (`:1914,1919-1924,1933,2079,2103,2340,3695,1697`) with the decision. Mark §48 "Tenant isolation" as `Not applicable by decision` rather than deleting history.
4. Update `docs/reference/alpha-status.md:72`, `docs/reference/compatibility-matrix.md:11`, `docs/reference/compatibility-matrix.md` §60 in `plans/PLAN.md`, `README.md` §"Not built yet", and `docs/security/security-controls-matrix.md` so no document promises tenant-ready APIs.
5. Decide the dead tenant surface: remove `tenantId?`/`getTenantId()` from `packages/core/src/context/index.ts`, `packages/acl/src/types/index.ts:20` and `packages/core/src/logger/index.ts:67`, **or** document them as intentionally unused with a comment and a test that asserts no caller relies on them. Do not touch `tenant_ref`/`tenantRef`.
6. Add a documentation lint or reviewed checklist item that fails when a new document claims multi-tenancy support. Do not add a second lint framework; extend `scripts/check-ui-conventions.mjs`-style static checks only if a repo-owned script already covers docs.

### Acceptance criteria

- No tracked document claims tenant-ready APIs, shared tenancy, or an upcoming tenant-isolation phase.
- The charter, security decision, compatibility matrix, alpha status and README all state the same boundary.
- No tenant id, tenant predicate, per-tenant schema, or cross-tenant test exists anywhere in the change set.
- `pnpm ci:gate` remains green.

---

## 8. Phase 24.2 — NO-GO Blocker Closure (P0)

### Objective

Close the two failing rows of the Phase 23.11 release gate, or record an explicit owner acceptance for an alpha/pilot.

### Tasks

1. Obtain D4: an approved isolated recovery environment, RPO and RTO. Without it, mark this sub-phase `Blocked` with the missing approval named; do not create a routine test database.
2. Install the encrypted off-host backup using `scripts/backup.mjs`, `scripts/verify-backup.mjs`, `scripts/restore-drill.mjs` and the systemd/timer templates from 23.9. Verify encryption, least-privilege permissions, key provisioning, retention, freshness alerting and off-host storage.
3. Run `pnpm restore:drill` in the approved environment, record duration and consistency checks (database + attachments + queue state), and confirm the configured primary database is untouched. Update G80/G81 with evidence.
4. Record the distribution decision from `docs/security/distribution-compliance.md` §5: a root `LICENSE` or explicit proprietary notice, a named clean-room/AGPL reviewer and outcome, third-party notices, and a link from README and the release record. The coding agent prepares the records; the owner/legal decision is not made by the agent.
5. Obtain owner signatures on the High/Critical exceptions in `docs/security/exception-register.md` (G81 and the two High release/design rows). An agent may not sign them.
6. Resolve G1's proposed accepted deviation by D3 and record the sign-off in `docs/quality/known-gaps.md` and the exception register.
7. Re-run `pnpm ci:gate` and the focused Phase 23 integration batch to prove no security regression was introduced.

### Acceptance criteria

- G80/G81 are `Fixed` with restore evidence, or explicitly accepted by the owner in writing with a review date.
- The release record states the distribution outcome; if the outcome is "do not distribute", it says so explicitly.
- No High/Critical exception is unsigned, and no exception was accepted by the coding agent.
- The primary database was never reset, recreated or broadly cleaned.

---

## 9. Phase 24.3 — Production Installation and Upgrade (P0)

### Objective

Ship a deployable single-tenant installation, not a developer compose file.

### Tasks

1. Add production deployment artifacts alongside (not inside) the dev `docker-compose.yml`: an API image, worker, web/SPA static host or reverse-proxy config, PostgreSQL and Redis as separate services or external dependencies, and a secrets-injection example with no placeholder values. Follow `docs/security/deployment-baseline.md` §1–§3.
2. Ensure no default credential survives: refuse `JWT_SECRET=change-me-in-production`, `POSTGRES_PASSWORD=postgres`, a dev `DATABASE_URL`, empty `ENCRYPTION_KEY`, wildcard `CORS_ORIGINS`, and `EXTENSION_TRUST_MODE=warn` in production. Reuse the boot guards from 23.1/23.9; do not duplicate the validation.
3. Write `docs/runbooks/installation-and-upgrade.md`: prerequisites, installation, first-boot verification, additive migration upgrade, rollback limits, worker pause during upgrade, backup-before-upgrade, post-upgrade health and provider reconciliation.
4. Add an installation smoke test that boots from the production configuration shape (no live customer data, no live provider) and verifies health, migrations, a representative CRUD path, and a worker job.
5. Verify the SPA is served with the CSP/HSTS posture described in `docs/security/deployment-baseline.md` §2, and that cookies remain `Secure` behind the trusted proxy.
6. Document that scaling is **per installation**: no shared worker/queue/database across customers, per the five conditions in `docs/security/tenancy-decision.md` §2.

### Acceptance criteria

- A fresh installation can be brought up from the documented artifacts without editing source or using a development `.env`.
- Placeholder secrets and dev defaults are refused by an automated check.
- Upgrade and rollback procedures are written and exercised on a recoverable non-production deployment without creating a routine test database.
- No production artifact contains a secret, a full database URL, or a world-readable backup.

---

## 10. Phase 24.4 — Canonical API Contract and Typed Client (P0)

### Objective

Make the public REST contract machine-checkable and usable, without adding a second API paradigm.

### Tasks

1. Record D3. **Recommended default:** accept G1's deviation — `GET /api/v1/OpenApi` stays a generated route inventory (772 paths, auth schemes declared, no DTO schemas), `docs/architecture/contract-catalog.md` stays the prose convention reference, and `api-spec/*.yaml` becomes the **canonical reviewed contract** for permissions, request/response shapes, side effects and idempotency. Generate payload schemas only if the owner explicitly funds it.
2. Continue the §58 registry one group at a time using `api-spec/README.md` §2/§5: relationships, attachments, activities/stream, search, reports, workflows, jobs, admin, i18n and one file per Phase 19 module. Read each controller, guard, Zod schema and service side effect; never infer permissions from the SPA.
3. Enable `pnpm ci:api-spec --strict` as the completion gate once coverage is complete, and keep the unflagged `pnpm ci:api-spec` inside `pnpm ci:gate` (per `api-spec/README.md` §3, `--strict` is registry-wide and must not be a flaky required check while groups are missing).
4. Resolve G90 (`GET /api/v1/OpenApi` is unauthenticated, route inventory only) with an owner decision: keep it public with a documented rationale, or require authentication. Do not silently change the contract.
5. Replace the `packages/api-client/src/index.ts` placeholder with a typed client generated from the canonical contract. Keep the existing `apps/web/src/api/client.ts` as the compatibility surface until a staged migration is proven; do not rewrite 2,401 lines in one change.
6. Add contract tests that fail on a phantom endpoint, a missing ACL declaration, a changed error code, or a changed response envelope `{error:{code,message,details}}`.
7. Update `plans/PLAN.md` §58 status, `api-spec/README.md` §4 coverage, `docs/architecture/contract-catalog.md` and `docs/reference/compatibility-matrix.md` so all four agree.

### Acceptance criteria

- `pnpm ci:api-spec --strict` passes with every `/api` route documented and matched.
- The generated client compiles and is used by at least one new consumer without breaking the SPA's existing calls.
- G1 is closed or carries an owner-signed accepted deviation with a target; G90 has a recorded decision.
- No GraphQL endpoint, second contract registry, or second HTTP client generation pipeline exists.

---

## 11. Phase 24.5 — Release Truthfulness (P0)

### Objective

Make the version, notes, README and status documents describe the product that actually ships.

### Tasks

1. Add `CHANGELOG.md` and a versioning/tagging convention; record the current `1.0.0` state honestly (alpha, NO-GO for production).
2. Add the Phase 23 (2026-11-13) and Phase 24 release notes to `docs/releases/` and `content/docs/` in both `en` and `vi`, and fix `content/docs/en/reference/release-notes.md:39` which still calls Phase 22 the newest note.
3. Fix `README.md:264` (migrations "up to `070_...`" while the tree has `094_phase23_retention_schedules.sql`) and the Quick start so it matches the production path from 24.3.
4. Reconcile `docs/quality/known-gaps.md`: add G85–G87 to the summary table or record why they are absent, align statuses with `docs/security/exception-register.md`, and add the Phase 24 status note.
5. Fix the Phase 23 plan's own drift: header `Status: Planned` vs the executed 23.11 NO-GO review and unchecked §22 checklist. Update the file as a historical record; do not rewrite its decisions.
6. Update `plans/PLAN.md` §57 (phase statuses), §60 compatibility matrix, `docs/reference/alpha-status.md` and `docs/reference/compatibility-matrix.md` with actual states, including "generic OIDC built; SAML/SCIM deferred", "single-tenant by decision", and "DTO-derived OpenAPI not built (G1 disposition)".
7. Verify no document still claims complete EspoCRM parity or a production-ready release.

### Acceptance criteria

- A reader can determine the shipped version, the release date, the open blockers and the supported deployment model from README + changelog + release notes alone.
- Migration counts, test counts and status labels match the repository.
- Both locales of the in-app release notes exist and the docs lint passes.

---

## 12. Phase 24.6 — Real Inbound Mail (P1)

### Objective

Replace the null inbound provider with a working, installation-wide adapter.

### Tasks

1. Implement `InboundMailProvider` (`packages/mail/src/inbound/index.ts:37-50`) for the D5-selected sources — default IMAP and Microsoft Graph — behind the existing provider port. Keep `NullInboundProvider` as the explicit unconfigured default that fails clearly.
2. Bind the adapter by configuration in `apps/api/src/email/index.ts:67` instead of unconditionally. `POST /api/v1/Email/action/pollInbound` (`apps/api/src/email/email.controller.ts:47-50`) must remain unchanged in contract.
3. Harden `pollInbound()` (`apps/api/src/email/email.service.ts:207-233`): message-id dedupe, bounded polls, cursor/watermark, MIME parsing, attachment handling through the existing ACL/malware path, bounce/auto-reply suppression, and idempotent ingestion.
4. Preserve the `service-desk/email-to-case.service.ts:132` flow; add thread linking to the matching CRM record and consent/suppression checks before any outbound effect.
5. Store provider credentials in the credential vault encrypted with `ENCRYPTION_KEY`; use `MAIL_TRANSPORT=memory` in tests and never poll a real mailbox in CI.
6. Add fixture-based tests for new/duplicate/malformed/bounce messages, a failing provider, a partially processed batch, and restart safety. Update `README.md` §"Not built yet" and `docs/reference/compatibility-matrix.md` email row.

### Acceptance criteria

- A configured adapter ingests a fixture mailbox into CRM records exactly once; an unconfigured installation fails clearly rather than pretending success.
- No test or CI contacts a real mailbox or sends real customer email.
- Ingestion is idempotent across restarts and respects record/field ACL and consent.

---

## 13. Phase 24.7 — Installation-Wide Email and Calendar Sync (P1)

### Objective

Decide and deliver a bounded sync scope appropriate to one organisation.

### Tasks

1. Record D5 with evidence: what exists today (Microsoft 365 Graph change notifications per `docs/compatibility/advanced-integrations/providers.md:89`), what does not (Google Calendar push `:63,369`, SES/SendGrid/Graph send and the email UI per `docs/reference/compatibility-matrix.md:284-286,299`), and what a single-tenant operator actually needs.
2. Deliver only the approved scope, configured **once per installation** — not per workspace or per user tenant. Reuse the connector framework and OAuth/credential vault rather than adding a second integration layer.
3. If calendar sync is approved, implement incremental sync with a stored cursor, webhook/channel verification where the provider supports it, and a documented no-push fallback for Google Calendar. Do not claim push support that does not exist.
4. Verify thread/activity linking, timezone handling through `formatDateTime`/`formatClock`, and ACL-filtered visibility of synced emails/events.
5. Document the operator setup, the credential scope, rate limits and the failure/recovery path in `docs/runbooks/`. Do not enable any provider by default.
6. Add fake-provider tests for initial sync, incremental sync, duplicate events, revoked credentials and provider outage.

### Acceptance criteria

- The compatibility matrix and provider docs name exactly what is implemented, deferred and why.
- Sync is installation-wide, opt-in, and fails clearly when unconfigured.
- No live provider credential or real customer mailbox is used by automated tests.

---

## 14. Phase 24.8 — Outbound Events and Developer Surface (P1)

### Objective

Give integrators a documented, typed way to extend a single-tenant installation without adopting a second API paradigm.

### Tasks

1. Record D6. Default: **no new CLI and no GraphQL**. Build on `packages/extension-sdk`, `modules/webhook-integration` and `api-spec/`.
2. Complete the generic outbound event/webhook connector (recorded "not started" in `docs/compatibility/advanced-integrations/provider-matrix.md:42`): a documented event catalogue with stable event names, payload version, signature, timestamp, replay window, delivery log, retry/backoff and dead-letter handling. Reuse `ExtensionDomainEventSubscription` (`packages/extension-sdk/src/types/index.ts:40-45`) and the Phase 23 webhook authenticity rules.
3. Publish the typed client from 24.4 to at least one real consumer and document the extension path in `docs/extension-sdk.md` and the in-app handbook.
4. If the owner funds a metadata `plan/apply` flow, implement it as a thin declarative layer over the existing metadata API and extension manifests — not a new package manager, SDK, or schema language. Otherwise record the deferral with a rationale.
5. Document the single-tenant rule for extensions: one installation's extension package must never process another customer's data; production `EXTENSION_TRUST_MODE=enforce` and signed packages (23.6, G98) apply.
6. Add contract tests for event names, payload shape, signature verification, replay rejection, and typed-client round-trips.

### Acceptance criteria

- An integrator can subscribe to a documented event and verify a signed delivery using only the published contract and typed client.
- No GraphQL endpoint, second webhook framework, or parallel CLI exists.
- Every new public endpoint is documented in `api-spec/` before `pnpm ci:api-spec --strict` is enabled.

---

## 15. Phase 24.9 — Provider Sandbox Certification (P1)

### Objective

Replace "experimental until exercised against a real account" with recorded evidence, without turning CI into a live-vendor dependency.

### Tasks

1. Inventory adapters flagged experimental in `README.md`, `docs/compatibility/*` and `docs/security/advanced-integrations-threat-model.md`: Twilio, Asterisk, DocuSign/e-signature, marketing sends, voice media, and the sync adapters from 24.7.
2. For each, define a sandbox test plan with the provider's documented test credentials/fixtures, the exact flows exercised, and the expected side effects. Never use a real customer record or a production webhook.
3. Execute only against provider sandboxes or approved test accounts, recording sanitised request/response evidence, correlation IDs and outcomes in `docs/quality/phase-24-test-evidence.md`.
4. Where a sandbox is unavailable, mark the adapter `Blocked — no sandbox` rather than claiming success; keep the existing "experimental" wording.
5. Update each module's compatibility note and the README flag list with the real result, including failures.
6. Keep all automated suites on fakes/fixtures. Live/sandbox verification is a manual, documented step and is never part of `pnpm ci:gate`.

### Acceptance criteria

- Every adapter has a recorded state: certified, failed, or blocked with an owner and a date.
- No production customer data, real message, real payment, or real signature request was used.
- CI remains free of provider credentials and network-dependent mandatory checks.

---

## 16. Phase 24.10 — UX Completion (P2)

### Objective

Close the experience gaps that make a capable single-tenant product feel slower and less complete than it is.

### Tasks

1. Re-measure `docs/ux/ui-review.md` and `docs/ux/list-view.md` against the current tree before changing anything; mark shipped items (dark mode, tokens, lazy routes, settings search, `document.title`, `EmptyState`) and correct the stale status text.
2. Add optimistic writes for the highest-value interactions first (board drag, inline edit, task toggle) using React Query `onMutate` with rollback and conflict handling. Do not disable server validation or the unsaved-changes guard.
3. Converge the two data-fetching paradigms: migrate `useEffect` fetch pages to React Query incrementally, with loading/error/denied states preserved. Do not rewrite all pages in one change.
4. Add a chart library only if the repo's conventions allow a new dependency, and replace the hand-built CSS bar dashlets in `DashboardsPage.tsx`; otherwise document the decision. Add a rich-text editor only where long-text CRM fields genuinely need it, with sanitised output and a non-executable render path.
5. Expand i18n beyond `en`/`vi` only with reviewed translations and `pnpm lint:ui` parity; never ship untranslated keys as English fallbacks without a visible notice (Phase 21 convention).
6. Close G64 (142 SPA call sites rendering raw `error.message`) with the code-aware helper, keeping the error envelope semantics.
7. Add browser specs for optimistic rollback, denied/empty/error states and rich-text sanitisation; refresh `docs/ux/*` with actual measurements.

### Acceptance criteria

- Key interactions no longer wait for a round trip before showing success, and a failed write rolls back visibly.
- No new XSS surface: rich text is sanitised and `pnpm lint:ui` passes.
- UX docs state measured, current numbers rather than 2026-10-25 numbers.

---

## 17. Phase 24.11 — Quality Debt and Single-Tenant Scale (P2)

### Objective

Close residual gaps and prove the single JSONB store holds up for one organisation at realistic size.

### Tasks

1. Work the open exception list with owners and review dates (G48/G49/G77/G89/G90/G91/G92/G95/G97/G98). Fix what can be fixed with a regression test; re-date or escalate the rest. Do not silently accept an exception.
2. Complete the dead tenant cleanup decided in 24.1 and assert no caller depends on `tenantId`.
3. Establish JSONB/EAV performance baselines for a single large installation: list/detail/related queries, global search, exports, reports, dashboards and bulk actions against the configured primary database with uniquely marked synthetic records.
4. Decide G71 (offset pagination is a live window, not a snapshot) with evidence; implement keyset/cursor pagination only where the measured behaviour is a real defect.
5. Revisit G69/G75/G79 shared-database flakes and make `pnpm verify` a reliable single run, or document precisely why the DB-free `pnpm ci:gate` plus focused suites is the required gate.
6. Reconcile test counts and status drift across `docs/quality/*`, `docs/reference/alpha-status.md` and `plans/PLAN.md` §60. No new test runner, no new database.
7. Refresh the knowledge graph (`graphify update .` and the trail graph) after the code changes, per `AGENTS.MD`.

### Acceptance criteria

- Every open exception has an owner, a review date and either a fix or a written rationale.
- Performance baselines are measured, recorded and linked to the affected surfaces.
- No tenant id or tenant predicate was introduced, and no extra database was created.

---

## 18. Phase 24.12 — Product Release Review and Go/No-Go (P0)

### Objective

Re-run the release gate with the P0 evidence and give an honest decision for a single-tenant installation.

### Tasks

1. Re-run `pnpm ci:gate` (now including `pnpm ci:api-spec`), `pnpm ci:api-spec --strict`, the focused integration batch and the relevant browser specs; record actual results and skipped checks.
2. Verify the P0 exit conditions: single-tenant charter ratified; G80/G81 closed or owner-accepted; distribution decision recorded; production install/upgrade exercised; G1 disposition signed; release docs truthful.
3. Verify no secrets, real customer records, database dumps, browser storage or unsafe artifacts were committed, and that no live provider action occurred in CI.
4. Verify all optional providers, OIDC profiles and extension trust settings default to safe modes; an unconfigured provider must fail clearly.
5. Produce `docs/quality/phase-24-release-review.md`: evidence links, closed gaps, accepted exceptions with owners and review dates, residual P1/P2 risks, and a go/no-go recommendation.
6. Update `plans/PLAN.md` §57 status and the release notes. Do not claim complete EspoCRM parity.

### Release gate

**GO** only when all P0 criteria are met, or an authorised owner explicitly accepts a documented exception with mitigation and deadline:

- The single-tenant boundary is ratified and no tracked document contradicts it.
- G80/G81 have restore evidence or a written owner acceptance; the distribution/licence question has a recorded outcome.
- `pnpm ci:api-spec --strict` passes and the public API contract has one canonical source.
- A production installation can be installed, upgraded and recovered from the documented artifacts without dev defaults.
- No High/Critical exception is unsigned; no security control was weakened for this phase.
- No extra database was created and no destructive setup was introduced.

---

## 19. Single-Tenant Applicability Matrix

Every Phase 24 deliverable is checked against the product boundary before it is accepted.

| Workstream | Single-tenant implication | Rejection condition |
|---|---|---|
| 24.1 charter | One organisation per deployment; isolation is deployment-owned | Any "workspace", tenant id or shared-admin claim |
| 24.2 backup/restore | One backup set, one RPO/RTO, one restore per installation | A shared backup store or a cross-customer restore |
| 24.3 install/upgrade | One set of secrets, one migration chain, one worker/queue | Shared worker/Redis/DB across customers without the five conditions |
| 24.4 API contract | One installation-wide route table; permissions are roles/teams inside the org | A tenant-scoped route, header or credential |
| 24.6/24.7 mail & sync | Installation-wide mailbox/connector config | Per-workspace sync or per-customer OAuth app assumption |
| 24.8 events & extensions | One event bus; extensions trust-signed for this installation | An extension runtime processing another customer's data |
| 24.10/24.11 UX & scale | Scale one organisation's data volume | Cross-customer reporting, search or AI context |

---

## 20. Verification Commands and Environment Constraints

Follow `AGENTS.MD` §4: `pnpm lint:changed` during development and a full verification before finishing a sub-phase. Repository-specific constraints the evidence report must account for:

- `pnpm ci:gate` is the stable DB-free required gate: `lint` → `lint:arch` → `typecheck` → `build` → `ci:migrations` → `ci:api-spec` → `test:ci` → `test:worker` → `test:web` → `ci:secrets`. The 23.11 review recorded exit 0 (88 files / 1 421 pure tests, 24 / 248 worker, 15 / 86 web, 94 migrations, 2 487 files scanned).
- `pnpm verify` has known shared-database flakes (G69/G75/G79). If a full run flakes, run the affected file alone and report both results.
- The sanctioned ESLint scope is `npx eslint apps packages e2e database scripts modules`; repo-wide `pnpm lint` is red on vendored `.agents/**`.
- Workspace packages resolve through `dist/`: `pnpm install && pnpm build` before typecheck/tests when package sources changed.
- Run one test file per `pnpm vitest run`; the single-fork full suite aborts at random boundaries.
- Mail/queue suites need `MAIL_TRANSPORT=memory` and `SMTP_FROM` before `bootApi()`, restored in `afterAll` (`singleFork: true` leaks `process.env`). Tests replacing the default AIAgents provider must restore the `aiAgents` `app_settings` row.
- Playwright: the shell exports `HTTP_PROXY`; run e2e with `no_proxy='*' NO_PROXY='*'`. Move `test-results` aside before re-running a spec to avoid bulk-delete guards.
- `pnpm --filter @carocrm/web build` fails at `emptyDir(dist)`; use `vite build --outDir /tmp/...` when a web build is needed.
- `entity_records` uses `created_at` / `modified_at` (never `updated_at`); `ValidationError` → HTTP 422; entity ACL `delete:'no'` blocks DELETE even for admins, so clean up such rows by id.
- `pnpm ci:api-spec --strict` is registry-wide; it will fail until every `/api` route is documented. Keep the unflagged form in the nightly gate.

---

## 21. Database, Test-Data and External-Effect Policy

- Use the configured primary database. Never print credentials or the full connection URL.
- Test records use `AGENT_TEST_` prefixes or a unique run marker; operate only on records the run created; clean up by exact primary key.
- Prefer transactions and rollback for database-only effects; never assume a transaction rolls back an email, webhook, queue job or file upload.
- Fake every external effect. Never send real customer email/SMS/WhatsApp, place calls, create signature requests, charge money, run live campaigns, poll a real mailbox, or publish production webhooks from tests. Sandbox verification (24.9) is manual and documented.
- Migrations are additive, reviewed and forward-only. A destructive migration requires explicit task-specific approval and stops the sub-phase.
- No extra database, schema, container or shadow copy — including for restore rehearsal. The approved isolated recovery environment in 24.2 is an operational exercise, not routine test-database creation.

---

## 22. Owner Decisions, Exceptions and Change Control

Standing decisions (nightly-only CI D3/G78, SAML/SCIM deferral, single-tenant boundary D1, no GraphQL, no new CLI by default) are recorded once at 24.0 and are not reopened by a sub-phase. An exception is valid only with a finding ID, priority, scope, exact behaviour left unfixed, mitigation, named owner and review date; a High/Critical exception requires explicit owner acceptance. All exceptions live in `docs/security/exception-register.md`. Any proposal to introduce tenant isolation, a hosted multi-tenant offering, or a second API paradigm requires a new owner decision and a separate plan; it is not a Phase 24 change request.

---

## 23. Final Acceptance Checklist

### P0 — release and positioning

- [ ] Single-tenant charter ratified; no tracked document promises tenant-ready APIs; no tenant code introduced.
- [ ] G80/G81 closed with restore evidence, or owner-accepted in writing; distribution/licence outcome recorded.
- [ ] Production install and upgrade exercised from documented artifacts with no dev defaults.
- [ ] `pnpm ci:api-spec --strict` green; G1 disposition and G90 decision recorded; typed client usable.
- [ ] `CHANGELOG.md`, release notes (`en`/`vi`), README, migration counts, PLAN §57/§58/§60 and gap register are truthful.
- [ ] `pnpm ci:gate` green; no security control weakened; no unsigned High/Critical exception.
- [ ] Final go/no-go review written with residual P1/P2 risks and owners.

### P1 — capability

- [ ] Real inbound adapter ingests fixture mail idempotently; unconfigured installation fails clearly.
- [ ] Email/calendar sync scope decided and documented; no unsupported capability claimed.
- [ ] Outbound event catalogue, signed deliveries and typed client documented and tested.
- [ ] Every experimental adapter has certified / failed / blocked evidence; no live vendor in CI.

### P2 — experience and debt

- [ ] Optimistic writes with rollback on key interactions; data-fetching convergence started.
- [ ] Chart/rich-text/locale decisions recorded and implemented where approved; G64 closed.
- [ ] Dead tenant surface resolved; remaining exceptions have owners and review dates.
- [ ] JSONB/EAV performance baselines measured; G71 decided with evidence.
- [ ] No extra database, destructive setup, live customer communication, or unrelated refactor.

---

## 24. Final Coding-Agent Instructions

Implement in order and in small increments.

1. **Start with Phase 24.0 only.** Return the baseline inventory, the §2 reconciliation and owner decisions D1–D7 before editing code. D1 is already decided: single-tenant by design.
2. For each sub-phase, list the intended files, tests, migration impact, configuration impact, external effects and risk before editing.
3. Implement only the current sub-phase unless a blocker requires a narrowly scoped prerequisite fix. Do not start P1 work while a P0 blocker is open.
4. Run the smallest relevant checks first (`pnpm lint:changed`, then the focused Vitest file), then `pnpm ci:gate` and the scoped integration suites.
5. Use the configured primary database only under `AGENTS.MD` §3. Never provision an extra database/schema and never reset or truncate it.
6. Use synthetic test records and fake providers; sandbox checks are manual and never part of CI.
7. Review changed files for secrets, weakened assertions, disabled authorization, unrelated diffs, migration risk and accidental artifacts.
8. Update the priority-decision record, gap register, exception register (by reference only) and test-evidence report with actual results.
9. Report passed/failed/skipped/blocked checks honestly and stop at the end of the requested sub-phase.
10. Never describe a shared-tenancy feature, a GraphQL endpoint, or a production-ready release while the P0 blockers remain open.

**First task to execute:** `Phase 24.0 — Baseline Audit and Priority Reconciliation`. Do not begin implementing fixes until the inventory, the §2 reconciliation and the owner decisions have been presented for review.
