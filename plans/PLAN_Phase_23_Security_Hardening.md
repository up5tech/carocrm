# PLAN — Phase 23: Security Hardening

> **Status:** Planned
> **Date:** 2026-11-09
> **Workstream type:** Cross-cutting security hardening and release-gate initiative — not a new business module and not a rewrite of the Entity Engine
> **Predecessor:** Phase 22 (`plans/PLAN_Phase_22_Integration_E2E_Hardening.md`), whose review records **"NO-GO for a production release"** (`docs/quality/phase-22-release-readiness.md`)
> **Target platform:** the existing NestJS 11 / Fastify 5 modular monolith, React 18 SPA, PostgreSQL 17 + Kysely, Redis 7 + BullMQ worker, and pnpm workspace
> **Canonical workstream key:** `security-hardening`
> **Scope baseline:** the real repository at 2026-11-09. A plan, an audit note, a class name, or a green build is not proof that a control exists.
> **Naming rule:** no `Ua` prefix, no second authentication system, no second crypto library, no second validation framework, no second test runner, no second package manager, no second CI provider, and no duplicate security documents
> **Primary output:** verified security controls, closed P0 findings, a continuously executed security regression suite, recovery/incident evidence, and an honest go/no-go recommendation
> **Database policy:** follow `AGENTS.MD` §3 exactly. Use the configured primary database only. Never create a test database, shadow database, schema copy, or per-agent/per-run database; never reset, truncate, or broadly delete data.

---

## 0. Instructions for the Coding Agent

Read these before changing anything:

1. `AGENTS.MD` (especially §3 database policy, §4 workflow, §5.3 security and access control, §9 testing, §11 definition of done) and `plans/PLAN.md` §17 (identity), §48 (Security Architecture), §57 (Development Phases).
2. This plan in full, plus `plans/PLAN_Phase_22_Integration_E2E_Hardening.md` §0, §16 (22.17 security suite), §21 (CI gates), §22 (backup/restore), §23 (release readiness), and §35 (final acceptance checklist).
3. The evidence pack: `docs/quality/known-gaps.md` (G1–G82), `docs/quality/authorization-matrix.md` (F1/F2/F3), `docs/quality/phase-22-security-privacy-regression-suite.md` (§7 matrix, §9 exceptions), `docs/quality/phase-22-release-readiness.md`, `docs/quality/ci-gates.md`, `docs/reference/compatibility-matrix.md`, `docs/reference/alpha-status.md`, `README.md` §"Not built yet", and the two threat models in `docs/security/`.
4. The actual implementation: `apps/api/src/bootstrap.ts`, `apps/api/src/config.ts`, `apps/api/src/auth/*`, `apps/api/src/acl/*`, `packages/acl/*`, `apps/api/src/entity/entity-record.store.ts`, `apps/api/src/common/global-exception.filter.ts`, `apps/api/src/portal/*`, `apps/api/src/attachment/*`, `apps/web/src/AppRoutes.tsx`, the `@Public()` route inventory, migrations, and existing security tests.
5. Use the repository context tools (`trail ask ... --source`, `graphify query ...`) before broad greps, as required by `AGENTS.MD`. Include the same rule in any sub-agent prompt that explores code.

**Start with Phase 23.0 only.** Do not begin fixes until the baseline audit, the contradiction list, and the owner decisions have been presented for review.

### 0.1 Non-negotiable rules

- Evidence over assumption. Every claimed control must cite a source path and a test or an executed command. Every claimed gap must be reproduced or labelled a **hypothesis**.
- Do not weaken an assertion, disable authorization, skip a test, swallow an error, or loosen a security default to obtain green CI.
- Server-side enforcement only. Hiding a control in the SPA is not authorization.
- Reuse existing primitives: `AclApiService`, `RequestScope`, `GlobalExceptionFilter`, `HookRegistry`, `@Public()`, the formula sandbox, `assertSafeMediaUrl`, `SignatureScanner`, the existing provider/fake adapters, Vitest, Playwright, pnpm, and Zod. Do not introduce competing tools.
- Do not invent cryptographic primitives. Use Node `crypto` and the libraries already in the lockfile. No new dependency without a reviewed, concrete need.
- Preserve the API error envelope `{error:{code,message,details}}`, status codes, metadata-driven entity behavior, and existing module boundaries. Any public contract change requires DTO, OpenAPI/catalog, i18n, and API-test updates.
- All external effects (email, SMS, calls, signatures, payments, campaigns, webhooks, provider API calls) use fakes, fixtures, sandboxes, or memory transports. Automated tests must never contact a live vendor or a real customer.
- No extra database, no Testcontainers, no CI database service, no reset/seed/clean hooks. Integration tests use unique `AGENT_TEST_` markers, exact-ID cleanup, and the configured primary database under `AGENTS.MD` §3.
- Migrations are additive, reviewed, version-controlled files under `database/migrations/`, tracked in `schema_migrations`. No destructive migration, no editing migration history.
- Test artifacts, logs, traces, screenshots, and HAR/network dumps must not contain secrets, full database URLs, or unredacted CRM data.
- No broad refactors. Each change ties to a gap ID, an acceptance criterion, and a regression test.
- Report passed/failed/skipped/blocked checks honestly. A sub-phase is not complete until its evidence report names the commands actually run.

### 0.2 Required assessment labels

Reuse the Phase 22 §0.2 vocabulary for every control and finding: `Implemented and verified` · `Implemented, insufficiently verified` · `Partial` · `Missing` · `Blocked` · `Not applicable`. Add a severity (`Critical` / `High` / `Medium` / `Low` / `Info`) and a disposition (`Open` / `Fixed` / `Accepted` / `Deferred` / `Hypothesis`).

### 0.3 Owner decisions required at 23.0

The agent must not decide these unilaterally; record the answer and the owner in the baseline report.

**Status: answered 2026-11-09.** The owner's answers are recorded below and in
`docs/security/phase-23-security-baseline.md` §6. Where the owner did not answer, the documented default applies.

| Decision | Answer (2026-11-09) | Consequence for this plan |
|---|---|---|
| Is generic OIDC in scope for Phase 23, or formally deferred? | **In scope for 23.3.** SAML, SCIM and enterprise directory sync are explicitly deferred with a written rationale | §8 (23.3) gains a generic authorization-code + PKCE adapter behind a provider interface, with a fake provider in tests |
| Is multi-tenancy a Phase 23 deliverable? | **No — document only** | §14 (23.9) task 5 is documentation: the single-tenant boundary, why §48 "Tenant isolation" is unmet by design, and the trigger for a separate phase. No tenant migration inside Phase 23 |
| Is PR-gated CI approved, replacing the nightly-only decision of 22.22? | **No — keep nightly-only.** G78 stays open | §13 (23.8) changes shape: the workflow is **not** converted to a PR gate. 23.8 instead adds the DB-free security suites to `vitest.ci.config.ts`, keeps the nightly gate green, proves the nightly gate **detects** a deliberately failing security assertion, and adds security telemetry. The release gate in §16 must read "the required (nightly) DB-free gate passes", not "required PR gates pass" |
| Approved recovery environment, RPO, and RTO? | **Not approved — 23.9 is Blocked** | §14 (23.9) task 2 records G80 as Blocked from the start, with the missing approval named. No database is created as a workaround (`AGENTS.MD` §3.6) |
| Who owns the clean-room/AGPL distribution compliance review and the repository `LICENSE`? | **Unanswered → default applies:** recorded as a release blocker; **no distribution claim is made** | §14 (23.9) task 6 and §16 keep it an explicit release blocker. The coding agent does not create a licence file or make a legal claim |
| Which open findings are accepted, with mitigation and review date? | **Unanswered → default applies:** **none accepted by default**; all P0 findings remain **Open** | Every P0 finding stays open until an owner signs it. `docs/security/exception-register.md` carries mitigations and review dates but records no agent-made acceptance; `High`/`Critical` rows await explicit owner acceptance |

**Deliverables of 23.0 (complete, 2026-11-09):** `docs/security/phase-23-security-baseline.md`,
`docs/security/security-controls-matrix.md`, `docs/security/exception-register.md`, plus reconciliation edits in
`docs/quality/known-gaps.md` (new findings **G83–G94**), `docs/quality/phase-22-security-privacy-regression-suite.md`
§9, `docs/quality/authorization-matrix.md`, `docs/quality/ci-gates.md` and `docs/reference/compatibility-matrix.md`.

---

## 1. Purpose and Expected Outcome

Phase 22 proved that the modules work together, but its release review is NO-GO on G80/G81 and leaves a long tail of security-relevant findings. Phase 23 turns the security model described in `plans/PLAN.md` §17 and §48 into **verified, enforced, and continuously tested controls**, then re-runs the release gate.

### 1.1 Primary outcomes

1. A single, evidence-based security baseline: every §48 required control mapped to code, a test, a gap ID, and an owner.
2. Fail-closed configuration and correct cryptographic primitives for sessions, CSRF, API keys, secrets, and CORS.
3. Authentication hardening: login throttling/lockout, self-service password reset, enforceable MFA, session revocation, and API-key rotation.
4. Authorization that holds on every surface: list, detail, bulk, export, import, search, report, attachment/media, audit history, portal, async jobs, AI tools, and `@Public()` callbacks.
5. A hardened untrusted-input boundary: injection, SSRF, XSS, file uploads, webhook replay, template content, formula sandbox, and extension packages.
6. Data protection: secrets at rest, redaction, retention, consent, encrypted off-host backup, and a proven restore.
7. Security observability and a regression suite that actually detects a known regression class in the nightly DB-free gate (the gate stays nightly-only by owner decision D3).
8. An incident-response runbook and a final go/no-go report with owners, residual risks, and review dates.

### 1.2 Security invariants

- Every request, job, agent action, and callback carries a verified principal; a missing principal fails closed.
- Authorization is evaluated server-side at execution time, not only at enqueue time.
- No record, field, file, export, or audit row is reachable without the same ACL decision as its parent entity.
- Untrusted URLs are never fetched without allowlist/host validation; untrusted content is never executed.
- Secrets never appear in logs, errors, traces, artifacts, or browser state.
- Replayed, unsigned, stale, or malformed provider events have no business effect.
- A denied action is auditable; a failed provider call is never reported as success.
- Unconfigured or unsafe settings fail closed rather than selecting a permissive default.

### 1.3 Scope boundaries

**In scope:** the controls above, the open findings listed in §2, the §48 control matrix, CI/backup/incident operations, and the evidence pack.

**Explicitly out of scope:** rebuilding the Entity Engine or ACL package; new business modules; database portability; a second ORM/query layer; a full SAML/SCIM/enterprise-SSO implementation; a full multi-tenant architecture; live-vendor certification (recorded separately as sandbox evidence); and any claim of complete EspoCRM parity.

---

## 2. Verified Baseline (2026-11-09)

This is the starting position, not a promise. Phase 23.0 must confirm or correct every row.

### 2.1 Controls already implemented

| Control | Evidence | State |
|---|---|---|
| Argon2id password hashing, min length | `apps/api/src/auth/auth.service.ts` | Implemented and verified |
| HS256 JWT via `jose`, access `typ` check | `auth.service.ts` | Implemented and verified |
| Server-side `user_sessions`, refresh rotation, logout/password-change revocation | `auth.service.ts` | Implemented and verified |
| HttpOnly/SameSite cookies, `Secure` behind `x-forwarded-proto` | `apps/api/src/auth/auth.controller.ts` | Implemented and verified |
| CSRF double-submit on unsafe methods | `apps/api/src/auth/auth.guard.ts` | Implemented, insufficiently verified (token entropy — see §2.3) |
| TOTP 2FA, single-use 5-minute challenge, 5-attempt bound, hashed recovery codes | `apps/api/src/auth/totp.ts`, `apps/api/test/two-factor.test.ts` | Implemented and verified |
| Hashed API-key secrets, `scope:'api'` | `auth.service.ts` | Implemented, insufficiently verified (comparison — see §2.3) |
| Global `AuthGuard` as `APP_GUARD`, `@Public()` opt-in | `auth.guard.ts`, `docs/quality/authorization-matrix.md` | Implemented and verified |
| Entity/field/record ACL compiled into SQL predicates | `packages/acl`, `apps/api/src/acl/acl-api.service.ts`, `apps/api/src/entity/entity-record.store.ts` | Implemented and verified |
| Separate portal role space, no existence leak (404) | `apps/api/src/portal/portal-policy.service.ts`, `apps/api/test/portal.test.ts` | Implemented and verified |
| Audit hooks with field diff and secret redaction | `apps/api/src/audit/audit-hooks.ts` | Implemented and verified (denials not audited — F3) |
| Safe error envelope, redacted query strings | `apps/api/src/common/global-exception.filter.ts`, `error-payload-hygiene.test.ts` | Implemented and verified (G54 fixed) |
| helmet, global rate limit, body/multipart limits, statement/request timeouts | `apps/api/src/bootstrap.ts`, `apps/api/src/config.ts` | Implemented and verified |
| SSRF guard for AI provider and voice media URLs (https-only, DNS re-check, private/link-local/metadata refusal) | `apps/api/src/ai-agents/ai-provider-url.ts`, `apps/api/src/voice-communications/media-url.ts` | Implemented and verified for those two paths only |
| Webhook signature verified before record, constant-time, raw body, per-connection secret | `apps/api/src/advanced-integrations/webhook-ingress.service.ts`, `docs/compatibility/advanced-integrations/webhook-security.md` | Implemented and verified for Advanced Integrations |
| Malware/MIME scanner, formula sandbox, CSV formula neutralisation, GrapesJS XSS-safe source | `apps/api/src/attachment/index.ts`, `packages/formula`, `e2e/email-template.spec.ts` | Implemented and verified |
| Secret scan, static migration guard, architecture-boundary guard | `scripts/check-secrets.mjs`, `scripts/check-migrations.mjs`, `scripts/check-architecture-boundaries.mjs`, `pnpm ci:gate` | Implemented and verified (nightly only — G78) |

### 2.2 Open findings carried into Phase 23

| ID | Finding | Severity | Target |
|---|---|---|---|
| G81 | No automated, encrypted, off-host backup; demo artifact was partial and world-readable | High | 23.9 |
| G80 | Restore drill blocked: no approved isolated recovery environment, no approved RPO/RTO | Medium | 23.9 |
| G78 | CI is nightly, not a PR gate; a regression can land before detection | Medium | 23.8 |
| G77 | No continuous metrics/tracing exporter; no security-event telemetry | Medium | 23.8 |
| G64 | ~150 call sites render raw `error.message` instead of the code-aware helper | Medium | 23.1 / 23.7 |
| G52 | Provider error text echoes into a 401 | Low | 23.3 |
| G51 | OAuth callback never compares the redirect URI it claims to check | Medium | 23.3 |
| G50 | A mapping gets "the connection for this provider" picked by name order | Medium | 23.3 |
| G47 | Token refresh exists but no production path calls it | Medium | 23.3 |
| G33 | Marketing webhook "signature" is the shared secret itself; a delivery with no timestamp is never age-checked | Medium | 23.5 |
| G23 | A dead letter can be marked "replayed" without re-running the work | Medium | 23.4 / 23.5 |
| G12/G13/G14/G21 | No retention for signature/voice/marketing receipts, `jobs`/`job_logs`, or unretryable failed jobs | Low/Medium | 23.7 |
| G30 | Hard-delete leaves `stream_items`/attachment orphans | Medium (Accepted in 22) | 23.7 |
| G65 | Home content chosen client-side from `principal.roles` | Low | 23.4 |
| G66 | Browser error/denial/empty states need continued coverage | Medium | 23.10 |
| G1 | No generated OpenAPI document — **contradicted** by `bootstrap.ts` and `compatibility-matrix.md:22` | Medium | 23.0 / 23.5 |
| G11 | Dead-letter replay capability check — summary says Fixed (22.14), detail says Open | Medium | 23.0 / 23.4 |
| F1 | Worker preserves `userId` but does not re-check record ACL at execution | Medium | 23.4 |
| F2 | esignature / omnichannel `@Public()` webhooks are a verification gap | Low | 23.4 |
| F3 | Explicit 403 denials are not written to `audit_log` | Low | 23.4 |
| — | No login throttling / lockout / failed-login counter (PLAN §17.1, §48) | High | 23.2 |
| — | No self-service email/token password reset; only admin reset | Medium | 23.2 |
| — | No OAuth/OIDC/SSO; no SAML/SCIM (PLAN §17.3, `compatibility-matrix.md:19`) | Medium | 23.3 |
| — | No multi-tenancy; §48 "Tenant isolation" unmet (`README.md:221`) | High (design) | 23.9 decision |
| — | No repository `LICENSE`; formal clean-room/AGPL compliance review required before distribution (`README.md:568-572`) | High (release) | 23.9 decision |
| — | Extension packages have no signature verification (`compatibility-matrix.md:219-220`) | Medium | 23.6 |
| — | Attachment barrel still ships a permissive default for standalone use (`compatibility-matrix.md:245`) and API-user attachment policies are not built | Medium | 23.6 |

### 2.3 Contradictions that 23.0 must resolve before any fix

1. **G1 / OpenAPI.** `docs/quality/known-gaps.md` says no generated document; `apps/api/src/bootstrap.ts:238` and `docs/reference/compatibility-matrix.md:22` say `GET /api/v1/OpenApi` exists. Determine whether the generated spec derives from DTOs or is a hand-written catalog. Do not "fix" either side before the evidence is recorded.
2. **G11 status.** The summary table says Fixed (22.14, part of G43); the detail entry says Open / deferred to 22.17. Reproduce the dead-letter replay route with a non-admin caller and record the actual result.
3. **MFA / password reset.** `docs/reference/compatibility-matrix.md:19` (baseline 2026-10-12) says "not built / not started", but TOTP 2FA and admin password reset exist. Correct the matrix with evidence rather than deleting the row.
4. **Constant-time API-key compare.** `docs/quality/authorization-matrix.md:26` claims a constant-time compare; `apps/api/src/auth/auth.service.ts:408` uses `!==`. Confirm the call path, then fix the code and the document together.
5. **CSRF token entropy.** `apps/api/src/auth/auth.controller.ts:328-333` generates the CSRF token with `Math.random()`. Confirm how it is consumed in `auth.guard.ts:68-74` before changing the token contract.
6. **CORS default.** `apps/api/src/bootstrap.ts:204-210` uses `origin: true` with `credentials: true` when `corsOrigins` is empty. Confirm the deployment default; treat a reflected-origin default as a finding, not a configuration preference.
7. **Expired exceptions.** `docs/quality/phase-22-security-privacy-regression-suite.md` §9 lists review dates 2026-11-15 and 2026-11-30; several findings (G37/G38/G39/G63/G64/G65/G47/G48/G49) are marked Fixed elsewhere in `known-gaps.md`. Reconcile statuses and re-date or close each exception.

---

## 3. Control Coverage Matrix (PLAN §48)

Every §48 required control must end Phase 23 with one of: a passing automated test, an executed verification command with evidence, or an accepted exception with owner, mitigation, and review date.

| §48 control | Baseline | Target |
|---|---|---|
| Password hashing with Argon2id | Verified | 23.1 regression |
| Secure cookies | Verified | 23.1 regression |
| CSRF protection | Verified, weak entropy | 23.1 |
| Rate limiting | Global only | 23.2 per-auth-route |
| Login throttling | Missing | 23.2 |
| API key hashing | Verified, weak compare | 23.1 / 23.2 |
| Secrets encryption at rest | `config.ts:92` empty key disables it | 23.1 / 23.7 |
| Security headers | helmet registered | 23.1 audit |
| Content Security Policy | Not verified | 23.1 / 23.5 |
| MIME/file validation | Verified | 23.6 |
| SSRF protection | Two paths verified | 23.5 full inventory |
| Webhook signature verification | Advanced Integrations verified; G33 open | 23.5 |
| Replay protection for webhooks | Partial | 23.5 |
| Audit logging | Verified; denials missing | 23.4 / 23.7 |
| Least-privilege service accounts | F1 open | 23.4 |
| Tenant isolation | Single-tenant by design | 23.9 documented decision |
| Permission tests for every CRUD endpoint | Matrix exists, not exhaustive | 23.4 / 23.10 |

---

## 4. Governance and Artifacts

### 4.1 New deliverables

1. `docs/security/phase-23-security-baseline.md` — control inventory, contradictions, threat surface, owner decisions.
2. `docs/security/security-controls-matrix.md` — §48 control → code path → test → gap ID → owner → status.
3. `docs/security/exception-register.md` — the single exception list (owner, scope, severity, mitigation, review date). Do not maintain a second exceptions table; update `docs/quality/phase-22-security-privacy-regression-suite.md` §9 to point here.
4. `docs/runbooks/security-incident-response.md` — credential leak, session/secret rotation, webhook replay, provider compromise, data exposure, and communication steps. Runbooks live in `docs/runbooks/`; do not create a parallel location.
5. `docs/quality/phase-23-security-test-evidence.md` — commands actually run, counts, failures, skipped/blocked checks, and artifact paths.
6. `docs/quality/phase-23-security-release-review.md` — go/no-go, residual risks, owners, and deadlines.
7. Automated test code following existing workspace conventions (`apps/api/test/phase23-security-*.test.ts`, and an `e2e/*.spec.ts` addition only where a browser check is genuinely needed).

### 4.2 Documents to update, not duplicate

`docs/quality/known-gaps.md` · `docs/quality/authorization-matrix.md` · `docs/quality/phase-22-security-privacy-regression-suite.md` · `docs/reference/compatibility-matrix.md` · `docs/quality/ci-gates.md` · `docs/quality/phase-22-release-readiness.md` · `README.md` §"Not built yet" · `.github/workflows/quality-gate.yml` · `vitest.ci.config.ts` · `plans/PLAN.md` §57 status and §60 matrix only where a capability's status actually changes.

### 4.3 Defect tracking

Keep using the G-ID register in `docs/quality/known-gaps.md`. New Phase 23 findings continue from **G83**; do not renumber history. Each entry needs: evidence, severity, owner module, reproduction, expected vs observed, root cause, fix reference, regression test path, verification result, and residual risk. Accepted exceptions additionally need a named owner and a review date.

---

## 5. Roadmap Overview

Implement in order. Each sub-phase ends with a short evidence report and must not auto-continue if it exposes a Critical/High architectural issue.

| Sub-phase | Name | Priority | Key output |
|---|---|---|---|
| 23.0 | Security baseline audit and contradiction reconciliation | P0 | Evidence-based inventory, owner decisions, no code changes |
| 23.1 | Fail-closed configuration and cryptographic primitives | P0 | CORS/CSRF/API-key/secrets/CSP fixes + unit tests |
| 23.2 | Authentication hardening | P0 | Throttling, lockout, password reset, MFA policy, session/API-key lifecycle |
| 23.3 | External identity and OAuth correctness | P1 | Generic OIDC (if approved), G47/G50/G51/G52 closure |
| 23.4 | Authorization consistency across every surface | P0 | F1/F2/F3 closed, IDoA and field-ACL matrix tests |
| 23.5 | Injection, SSRF, XSS, and webhook authenticity | P0 | Full untrusted-input inventory and adversarial suite |
| 23.6 | Files, attachments, and extension supply chain | P1 | Attachment policies, extension verification, dependency review |
| 23.7 | Data protection, privacy, and retention | P1 | Encryption at rest, redaction, retention, consent |
| 23.8 | Security observability and CI coverage | P0 | Security telemetry, DB-free security suites in the nightly gate, G77/G78 |
| 23.9 | Operational security, backup, and recovery | P0 | G80/G81 closed or explicitly blocked, incident runbook, compliance decisions |
| 23.10 | Security regression suite and OWASP mapping | P0 | Test matrix, exception register, evidence pack |
| 23.11 | Security release review and go/no-go | P0 | Final evidence, updated status docs, residual-risk register |

---

## 6. Phase 23.0 — Security Baseline Audit and Contradiction Reconciliation

### Objective

Establish the true security posture before writing a single fix.

### Tasks

1. Re-read `AGENTS.MD`, `plans/PLAN.md` §17/§48, the Phase 22 evidence pack, and the two threat models in `docs/security/`.
2. Verify every row of §2.1 against source paths and at least one executed test or command. Mark each with an assessment label from §0.2.
3. Reproduce or refute each contradiction in §2.3. Record commands and results; do not edit the conflicting documents until the evidence is written down.
4. Inventory: all `@Public()` routes; all admin-only routes and their guards; every user-supplied URL fetch; every secret source in `apps/api/src/config.ts`; every external side-effect path; every `runAs` / worker principal; every DTO that accepts an entity name, field name, sort key, filter, or template.
5. Inventory existing security tests and map them to the §18 matrix. Identify false confidence: tests that only assert 200, tests that bypass guards, tests with no persisted-state assertion.
6. Build the §48 control coverage matrix with a status and owner for each control.
7. Record the §0.3 owner decisions. Without an approved recovery environment and RPO/RTO, mark 23.9 `Blocked` from the start.
8. Produce `docs/security/phase-23-security-baseline.md` and a recommended implementation order based on observed risk.

### Acceptance criteria

- Every control and finding has a source path, a test/command reference, a label, a severity, and an owner.
- All seven contradictions in §2.3 have an explicit resolution or a documented hypothesis.
- No business data was modified; no code, configuration, or CI file was changed during the audit.
- Owner decisions are recorded; the next sub-phase starts only after review.

---

## 7. Phase 23.1 — Fail-Closed Configuration and Cryptographic Primitives

### Objective

Remove permissive defaults and weak primitives before adding new features.

### Tasks

1. CORS: replace the reflected-origin default (`apps/api/src/bootstrap.ts:204-210`) with an explicit allowlist that fails closed when unset, while preserving `credentials: true` only for configured origins. Add a config-level test.
2. CSRF: replace `Math.random()` in `apps/api/src/auth/auth.controller.ts` with a `crypto`-backed random value; use a constant-time comparison in `apps/api/src/auth/auth.guard.ts` and keep the double-submit contract intact.
3. API keys: replace the plain `!==` in `apps/api/src/auth/auth.service.ts:408` with a length-checked `timingSafeEqual`; preserve the `key_` id/secret format and hashed storage.
4. Verify the G9 fix (`apps/api/src/config.ts`, `config-jwt-secret.test.ts`) holds for every environment path; document the JWT secret rotation procedure. Do not log or print any secret.
5. `encryptionKey: ''` currently disables secrets encryption at rest (`config.ts:92`). Make unset encryption fail closed for features that store secrets, or record an accepted exception with a named owner and a deadline.
6. Audit helmet configuration and add a Content Security Policy compatible with the Vite SPA and the GrapesJS designer. Justify every `unsafe-inline`/`unsafe-eval` exception; do not weaken the policy silently.
7. Close G52 and the server-side half of G64: no provider error text or raw `error.message` in public responses; use the existing code-aware helper and error envelope.
8. Add regression tests for each change under `apps/api/test/` and keep them DB-free so they can enter `vitest.ci.config.ts`.

### Acceptance criteria

- Unset CORS origins, unset encryption key, and an invalid JWT secret all fail closed in a test.
- CSRF and API-key comparisons use `crypto` primitives; no new dependency was added.
- No secret, token, or provider error text appears in logs, responses, or test artifacts.
- The existing login, 2FA, API-key, and CSP-consuming e2e flows still pass.

---

## 8. Phase 23.2 — Authentication Hardening

### Objective

Implement the identity requirements of `plans/PLAN.md` §17.1, §17.2, and §48 that are still missing.

### Tasks

1. Login throttling and lockout: per-account and per-source bounded failed-login counters, with a documented policy, bounded retention, and no account enumeration. Integrate with the existing `@fastify/rate-limit` setup rather than adding a second limiter.
2. Self-service password reset: single-use, expiring, rate-limited token; no account enumeration; revokes existing sessions on success; admin reset (`POST /User/:id/password-reset`) remains unchanged in contract. Deliver through the existing mail transport with `MAIL_TRANSPORT=memory` in tests.
3. MFA policy: make the existing TOTP implementation enforceable per role or per administrator setting, verify recovery-code single use, bound recovery attempts, and confirm 2FA state is bound to the session. Update `docs/reference/compatibility-matrix.md:19` to reflect reality.
4. Session management: list and revoke sessions, verify refresh rotation and reuse detection, and define idle/absolute expiry. Confirm `Secure` cookies behave correctly behind the trusted-proxy logic in `bootstrap.ts`.
5. API-key lifecycle: rotation, `last_used_at`, scope enforcement, and optional IP restriction, following §17.2. Never store or log a raw secret.
6. Add tests for brute force, lockout expiry, reset token reuse/expiry, MFA bypass, session revocation, refresh replay, and API-key rotation. Use `apps/api/test/helper.ts` and fake mail/queue adapters.

### Acceptance criteria

- Repeated failed logins are throttled and auditable without leaking which account exists.
- A reset token cannot be reused or used after expiry; successful reset invalidates prior sessions.
- A user with a 2FA requirement cannot obtain a usable session by skipping the challenge.
- No real email, SMS, or provider call occurs in any test.

---

## 9. Phase 23.3 — External Identity and OAuth Correctness

### Objective

Close the OAuth correctness gaps and, if approved at 23.0, add a bounded generic OIDC sign-in path.

### Tasks

1. Fix **G51**: compare the OAuth callback redirect URI against the exact registered value; reject mismatches before exchanging the code. Add `state`/nonce validation where the connector path uses them.
2. Fix **G52**: stop echoing provider error text into a 401; return the project's stable error code.
3. Fix **G50**: resolve "the connection for this provider" deterministically instead of by name order.
4. Fix **G47** or record an accepted exception: wire the existing token refresh into the connector lifecycle it was written for, with a bounded retry and a test.
5. If OIDC is in scope: implement a generic authorization-code + PKCE adapter behind a provider interface (PLAN §17.3), with exact redirect URI matching, `state`/`nonce`, issuer/audience/expiry validation, an explicit account-linking rule, and session issuance that reuses 23.2. Google/Microsoft are configuration profiles, not provider-specific logic inside the identity service.
6. Use a fake OIDC provider in tests. SAML, SCIM, and enterprise directory sync are explicitly deferred with a written rationale, not silently omitted.
7. Update `docs/reference/compatibility-matrix.md` and `docs/runbooks/advanced-integrations.md` for every behavior change.

### Acceptance criteria

- Valid, invalid, stale, mismatched-redirect, replayed, and malformed callback cases have passing tests.
- No test uses real provider credentials or a live token endpoint.
- The compatibility matrix states exactly what is implemented, what is deferred, and why.

---

## 10. Phase 23.4 — Authorization Consistency Across Every Surface

### Objective

Make one ACL decision govern every path, including asynchronous and public-callback paths.

### Tasks

1. **F1:** generalize the `reports/report.service.ts:290-314` pattern. For user-requested async work, serialize a principal snapshot, re-derive it at execution, and re-evaluate record/field ACL at execution time; fail closed if the user is inactive. Document jobs that are intentionally system-scoped and why.
2. **F2:** inventory every `@Public()` webhook controller (Advanced Integrations, ESignature, Omnichannel, marketing forms, portal endpoints) and prove signature/identity verification happens before any state change. Close the gap or record an accepted exception.
3. **F3:** emit a `denied` audit event for `AuthorizationDeniedError` from `GlobalExceptionFilter`, with actor, target, action, and correlation ID, without logging sensitive payloads.
4. **IDoA:** test attachments, call recordings, transcripts, signed documents, message media, exports, and audit history as independent downloads — not only through the parent record endpoint.
5. Re-verify field-level ACL on bulk update/delete, CSV import/export, reports, global search, autocomplete, related-record selectors, stream, and AI tool calls. Add the missing cases to `apps/api/test/acl-matrix.test.ts` or a `phase23-security-*.test.ts` sibling.
6. **G65:** move home content selection from client-side `principal.roles` to a server-resolved decision; keep the server as the only enforcement point.
7. Reconcile **G11** and **G23**: a dead-letter replay must require the caller's capability and must actually re-run the work before it is stamped "replayed".
8. Re-run the capability-gate regressions for G35/G43 and the portal suite; confirm the `/admin/*` route guard (G63) still matches the server ACL.
9. Produce an authorization decision table in `docs/quality/authorization-matrix.md` for owner / team member / unrelated user / admin / API user / portal user / unauthenticated caller across the surfaces above.

### Acceptance criteria

- No tested surface returns data or accepts a write that the parent entity's ACL would refuse.
- Every explicit 403 produces an audit row; no denial leaks whether a protected record exists.
- Async user-scoped work cannot execute with more authority than the initiating user had at execution time.
- The matrix records the actual result for each cell, including `Not applicable` with justification.

---

## 11. Phase 23.5 — Injection, SSRF, XSS, and Webhook Authenticity

### Objective

Harden the entire untrusted-input boundary and prove it with adversarial tests.

### Tasks

1. Resolve **G1** with evidence from 23.0. If the OpenAPI document is not derived from DTOs, generate it from the existing decorators/DTOs (or document an accepted deviation with an owner). Contract-test the resulting spec against representative routes.
2. Verify the query engine allowlists entity names, field names, operators, and sort keys; extend `apps/api/test/phase22-security-injection.test.ts` (or add a `phase23` sibling) with malicious filters, sort keys, dynamic field names, templates, formulas, and webhook payloads. No arbitrary SQL may execute.
3. Build the full SSRF inventory: `ai-provider-url.ts`, `media-url.ts`, import URLs, connector/webhook targets, OAuth callbacks, document/image fetchers. Reuse one allowlist/host-validation helper; cover redirects, DNS rebinding, IPv6, link-local, RFC1918, and cloud metadata endpoints. An empty allowed-hosts list must refuse every fetch.
4. XSS: CRM fields, chat transcripts, email/WhatsApp content, GrapesJS templates, and the in-app docs renderer. Combine sanitization/escaping with the CSP from 23.1; keep the existing `e2e/email-template.spec.ts` guarantee.
5. Verify the formula sandbox (`packages/formula`) and extension code boundaries remain untrusted: no file/network/process access, bounded execution, no escape through metadata or template helpers.
6. **G33:** replace the shared-secret-as-signature scheme for marketing webhooks with a real HMAC over the raw body plus a mandatory timestamp and a replay window; reject stale, duplicated, unsigned, and malformed deliveries. Apply the same signature-before-record order as Advanced Integrations.
7. Verify every provider webhook with valid, invalid, stale, duplicate, and malformed fixtures; keep signature comparisons constant-time and per-connection secrets in the vault.
8. Link each test to an OWASP ASVS / API Security Top 10 category, a §48 control, and a gap ID.

### Acceptance criteria

- No test can make the API execute arbitrary SQL, fetch an internal address, or render executable untrusted HTML.
- Every provider webhook path rejects a valid-looking replay and a missing timestamp.
- The OpenAPI question is closed with either a generated, contract-tested spec or a signed accepted deviation.
- All new tests are deterministic and use fake providers/fixtures.

---

## 12. Phase 23.6 — Files, Attachments, and Extension Supply Chain

### Objective

Close direct-object access and untrusted-package risks.

### Tasks

1. Remove the permissive standalone default in the attachment barrel (`docs/reference/compatibility-matrix.md:245`); every attachment read must resolve the parent record's ACL. Add API-user attachment policies (`README.md:221`), which are explicitly not built today.
2. Verify the malware scanner, MIME/extension/size checks, checksums, chunked upload, and path-traversal resistance, including stream attachments and storage backends (local, S3/MinIO).
3. Decide extension package verification: `compatibility-matrix.md:219-220` records no signature verification. Implement manifest/signature verification with a reviewed trust model, or record a named accepted exception with a deadline. Extension providers, hooks, and jobs must be treated as untrusted code.
4. Dependency integrity: keep the single pnpm lockfile and `--frozen-lockfile` in CI; add a reviewed dependency-audit step to the gate only if it does not introduce a second package manager or a network-dependent mandatory check. Do not vendor new tooling without approval.
5. Add tests for unauthenticated/foreign-record download, path traversal, MIME mismatch, oversized/chunked upload, and unsigned/corrupt extension manifests.

### Acceptance criteria

- No attachment, recording, transcript, signed document, or export is downloadable without an ACL-checked parent.
- An untrusted or altered extension package cannot register providers/hooks without the approved trust check.
- The lockfile and CI runner conventions are unchanged apart from the reviewed audit step.

---

## 13. Phase 23.7 — Data Protection, Privacy, and Retention

### Objective

Protect data at rest and in motion, and bound how long sensitive artifacts live.

### Tasks

1. Complete secrets-at-rest encryption and a documented key-rotation procedure (links to 23.1 and 23.9). Verify no secret is stored in plaintext when encryption is enabled.
2. Extend redaction assertions to logs, error payloads, traces, job metadata, audit rows, browser state, and CI artifacts; include representative failure cases from provider adapters.
3. Verify consent/unsubscribe enforcement and marketing-send operator binding (`README.md:226-230`); no campaign must send without an explicitly bound provider and an allowlisted test recipient in tests.
4. Implement or document retention for G12/G13/G14/G21 (signature/voice/marketing receipts, `jobs`/`job_logs`, unretryable failed jobs) and G30 orphans; make every cleanup narrowly predicated and never a global delete.
5. Define audit-log retention and tamper-evidence expectations; verify field-level redaction still applies to `denied` events added in 23.4.
6. Verify CSV export/import formula neutralisation and PII handling for the new security surfaces.

### Acceptance criteria

- A representative secret never appears unredacted in any log, error, trace, or artifact.
- Every retention rule has a documented owner, a bounded window, and a test that proves it does not remove unrelated records.
- No cleanup or migration performs a broad `DELETE`/`TRUNCATE`.

---

## 14. Phase 23.8 — Security Observability and PR-Gated CI

### Objective

Make security regressions detectable in the nightly gate (**G78**) and detectable in operation (**G77**). The gate is not PR-gated (owner decision D3), so a regression can still land before the next scheduled run — that residual risk stays an open exception.

### Tasks

1. **The trigger stays nightly-only (owner decision D3, 2026-11-09).** Do **not** add a `pull_request` trigger to
   `.github/workflows/quality-gate.yml`; G78 remains open. Keep `permissions: contents: read`,
   `pnpm --frozen-lockfile`, no database service, no repository secrets, no deploy, and sanitized failure-only
   artifacts.
2. Add the DB-free security suites to `vitest.ci.config.ts` deliberately (that include list is a reviewed act) —
   starting with `apps/api/test/ai-agent-adversarial.test.ts`, the repository's only SSRF suite, which is already
   DB-free. Ensure `pnpm ci:gate` still runs: `lint` → `lint:arch` → `typecheck` → `build` → `ci:migrations` →
   `test:ci` → `test:worker` → `test:web` → `ci:secrets`. Layer 3 integration remains sandbox-only under `AGENTS.MD` §3.
3. Extend `scripts/check-secrets.mjs` only if a new secret shape was actually introduced; never print matched values.
4. Add security event telemetry for denied access, lockouts, failed logins, CSRF failures, webhook signature rejections, replay attempts, and secret-rotation events. Emit correlation IDs and counts, never payloads or secrets. If no exporter exists, record exactly what is derived from module documents and what remains missing.
5. Prove the nightly gate **detects** a regression: in a throwaway branch, introduce one deliberately failing security assertion, show the scheduled gate fails, then remove it. Do not merge the regression. Because the gate is nightly and not PR-gated, also state plainly in the evidence report that a regression can merge before detection.
6. Update `docs/quality/ci-gates.md` with required / optional / sandbox-only / manually approved checks.

### Acceptance criteria

- A security regression in the DB-free layer fails the **nightly** gate. The gate is not PR-gated (owner decision D3), so the residual risk "a regression can land before detection" is recorded as the live **G78** exception, not closed.
- CI never provisions a database, resets data, or runs a live provider action.
- Security events are observable with correlation IDs and contain no sensitive content.
- Flaky checks are tracked with a time-bounded justification, never silently ignored.

---

## 15. Phase 23.9 — Operational Security, Backup, and Recovery

### Objective

Close the two release blockers (G80/G81) and make the deployment/security boundary explicit.

### Tasks

1. **G81:** install the automated encrypted off-host backup using the existing `scripts/backup.mjs`, `scripts/verify-backup.mjs`, and the 22.25 work; verify least-privilege file permissions, key provisioning, retention, freshness alerting, and that no artifact is world-readable.
2. **G80:** obtain owner-approved RPO/RTO and an approved isolated recovery environment, then run `scripts/restore-drill.mjs` and record evidence (duration, consistency checks, restored attachments). The configured primary database must remain untouched. If approval is missing, mark this sub-phase **Blocked** with an explicit gap — never create a routine test database as a workaround.
3. Write `docs/runbooks/security-incident-response.md`: suspected credential/token leak, session mass-revocation, JWT/API-key/encryption-key rotation, webhook replay or provider compromise, data exposure, evidence preservation, and safe communication. Include the correlation IDs and safe diagnostics added in 23.8.
4. Document a secure deployment baseline: TLS termination, trusted-proxy configuration, secret injection, least-privilege database roles, disabled dev defaults, and separation from the dev-oriented `docker-compose.yml` (`docs/reference/alpha-status.md`). This is documentation and configuration review, not a new hosting platform.
5. **Multi-tenancy decision:** record the single-tenant boundary, why §48 "Tenant isolation" is satisfied or not satisfied by deployment separation, and the trigger for a separate tenant-isolation phase. Do not start a tenant migration inside Phase 23.
6. **Distribution compliance:** record the owner and outcome of the clean-room/AGPL review and the missing repository `LICENSE` (`README.md:568-572`, `AGENTS.MD` §6). This is an owner/legal action, not an agent code change; if unresolved, it remains an explicit release blocker.
7. Verify no default credentials, demo secrets, or unsafe optional-provider settings are enabled by a production configuration.

### Acceptance criteria

- A restore exercise has recorded evidence and the primary database is unchanged; or the sub-phase is explicitly `Blocked` with the missing approval named.
- Backup artifacts are encrypted, off-host, access-controlled, and their permissions are asserted by a check.
- The incident runbook, deployment baseline, tenancy decision, and compliance status are written down with owners and dates.

---

## 16. Phase 23.10 — Security Regression Suite and OWASP Mapping

### Objective

Turn every fixed control into a durable, mapped regression test.

### Tasks

1. Extend the existing `apps/api/test/phase22-security-regression.test.ts` / `phase22-security-injection.test.ts` pattern with `phase23-security-*.test.ts` suites; do not create a second runner or a parallel suite hierarchy.
2. Cover the §18 matrix: each role × each surface × each threat class, prioritizing P0 rows. Include success, denial, and failure/recovery paths.
3. Add a browser security spec under `e2e/` only for a control that genuinely needs a browser (for example CSP/blocked inline script, session revocation, or a denial state); reuse `e2e/critical-paths.spec.ts` conventions.
4. Map each test to an OWASP ASVS / API Security Top 10 category, a PLAN §48 control, and a G-ID. Record the mapping in `docs/quality/phase-23-security-test-evidence.md`.
5. Reconcile `docs/quality/phase-22-security-privacy-regression-suite.md` §9 with the single `docs/security/exception-register.md`: close fixed findings, re-date live ones, and name an owner for each.
6. Run the DB-free gate, the focused integration suites, and (where a browser is available) the e2e spec; record counts and skipped/blocked checks honestly.

### Acceptance criteria

- No Critical/High finding from Phase 23 remains open without a documented, owner-signed exception and mitigation.
- Security tests cover entity/API/provider/file/async paths, not only login.
- Every test's command, environment, result, and limitation appears in the evidence report.

---

## 17. Phase 23.11 — Security Release Review and Go/No-Go

### Objective

Re-run the Phase 22 release gate with the Phase 23 evidence and produce an honest decision.

### Tasks

1. Re-run `pnpm ci:gate` from a clean checkout/environment and the required scoped integration suites; record actual results.
2. Update `docs/quality/known-gaps.md`, `docs/quality/authorization-matrix.md`, `docs/reference/compatibility-matrix.md`, `docs/quality/ci-gates.md`, `README.md` §"Not built yet", and `docs/quality/phase-22-release-readiness.md` (or supersede it with a clearly linked Phase 23 review).
3. Verify no secrets, real customer records, database dumps, browser storage, or unsafe artifacts were committed.
4. Verify all optional providers and security settings default to safe modes; an unconfigured provider must fail clearly, not fake success.
5. Produce `docs/quality/phase-23-security-release-review.md`: evidence links, closed gaps, accepted exceptions with owners and review dates, residual risks, and the go/no-go recommendation.
6. Update `plans/PLAN.md` §57 status and the release notes. Do not claim complete EspoCRM parity.

### Release gate

**Go** only when every blocking criterion is met, or an authorized owner explicitly accepts a documented exception with mitigation and deadline:

- No known Critical/High authorization, injection, SSRF, secret-exposure, or authentication bypass remains open.
- Every §48 control has a passing test, executed verification, or a signed accepted exception.
- The required (nightly) DB-free gate passes; no security test was weakened or skipped to obtain green CI. **Note (owner decision D3):** the gate is not PR-gated, so "blocks a demonstrated regression before merge" is not achievable and G78 remains an open exception.
- Encrypted off-host backup and a restore drill have evidence (G80/G81), or the blocker is explicitly accepted by the owner. **G80 is Blocked** (decision D4).
- No extra database was created and no destructive setup was introduced.
- The distribution compliance question has a recorded owner decision.

---

## 18. Security Test Matrix

| Surface | Roles to test | Threat classes | Owner sub-phase |
|---|---|---|---|
| Generic entity list/detail/create/edit/delete, mass actions | owner, team, unrelated, admin, API user, portal, anonymous | BOLA/IDOR, field ACL, injection, non-disclosure | 23.4 / 23.10 |
| Attachments, media, recordings, transcripts, signed docs, exports, audit history | same | IDoA, path traversal, MIME mismatch | 23.4 / 23.6 |
| Search, reports, dashboards, CSV import/export, related selectors | same | field ACL, formula injection, PII leakage | 23.4 / 23.7 |
| Login, 2FA, password reset, sessions, API keys | anonymous, regular, admin, API user | brute force, token replay, enumeration, CSRF | 23.1 / 23.2 |
| OAuth/OIDC and connector callbacks | anonymous, admin, system | redirect/state/nonce, replay, provider error echo | 23.3 |
| Provider webhooks (`@Public()`) | provider identity, replay | signature, freshness, duplicate, malformed | 23.4 / 23.5 |
| Worker jobs, outbox, AI agents, CRM Chat tools | initiating user, system, approver | privilege escalation, stale principal, approval bypass, prompt injection | 23.4 / 23.10 |
| Portal and omnichannel | portal user, contact, internal user | cross-portal leakage, scope escalation | 23.4 |
| Templates, formula fields, extension packages | admin, regular | XSS, sandbox escape, unsigned code | 23.5 / 23.6 |
| Logs, errors, traces, artifacts, backups | operator, admin | secret/PII exposure, retention | 23.7 / 23.9 |

---

## 19. Verification Commands and Known Environment Constraints

Follow `AGENTS.MD` §4: `pnpm lint:changed` during development and a full verification before finishing a sub-phase. Repository-specific constraints that the evidence report must account for:

- `pnpm ci:gate` is the stable DB-free required gate; `pnpm verify` includes database-backed suites and has known shared-database flakes (G69/G75/G79). If a full run flakes, run the affected file alone and report both results.
- The sanctioned ESLint scope is `npx eslint apps packages e2e database scripts modules`; repo-wide `pnpm lint` is red on vendored `.agents/**`.
- Workspace packages resolve through `dist/`: run `pnpm install && pnpm build` before typecheck/tests when package sources changed.
- Run one test file per `pnpm vitest run`; the single-fork full suite aborts at random boundaries.
- Mail/queue suites need `MAIL_TRANSPORT=memory` and `SMTP_FROM` set before `bootApi()` and restored in `afterAll` (`singleFork: true` leaks `process.env`).
- Tests that replace the default AIAgents provider must restore the `aiAgents` `app_settings` row in `afterAll`.
- Playwright: the shell exports `HTTP_PROXY`; run e2e with `no_proxy='*' NO_PROXY='*'` or localhost availability checks fail. Move `test-results` aside before re-running a spec to avoid bulk-delete guards.
- `pnpm --filter @carocrm/web build` fails at `emptyDir(dist)`; use `vite build --outDir /tmp/...` when a web build is needed.
- `entity_records` uses `created_at` / `modified_at` (never `updated_at`); `ON CONFLICT` needs the partial-index predicate repeated; `ValidationError` maps to HTTP 422; entity ACL `delete:'no'` blocks DELETE even for admins, so clean up such rows by id.
- After code changes, refresh the repository context graph (`graphify update .`, and the trail graph per `AGENTS.MD`).

---

## 20. Database, Test-Data, and External-Effect Policy

- Use the configured primary database connection. Never print credentials or the full connection URL.
- Test records use `AGENT_TEST_` prefixes or a unique run marker; operate only on records the run created; clean up by exact primary key.
- Prefer transactions and rollback for database-only effects; never assume a transaction rolls back an email, webhook, queue job, or file upload.
- Fake every external effect. Never send real customer email/SMS/WhatsApp, place calls, create signature requests, charge money, run live campaigns, or publish production webhooks from tests.
- Migrations are additive, reviewed, and forward-only. A destructive migration requires explicit task-specific approval and stops the sub-phase.
- No extra database, schema, container, or shadow copy — including for restore rehearsal. The approved isolated recovery environment in 23.9 is an operational exercise, not routine test-database creation.

---

## 21. Exception Register Rules

An exception is valid only with: finding ID, severity, scope, exact behavior left unfixed, mitigation, named owner, review date, and the evidence that the residual risk was reproduced. An exception without a review date is not an exception — it is an open finding. A review date that has passed reopens the finding automatically. `High` and `Critical` exceptions require explicit owner acceptance; the coding agent may not accept them. All exceptions live in `docs/security/exception-register.md`; other documents link to it rather than keeping a second list.

---

## 22. Final Acceptance Checklist

Phase 23 may be declared complete only when each item has evidence, an accepted exception, or a clearly documented blocker.

### Controls

- [ ] Every PLAN §48 control is implemented and verified, or has a signed exception.
- [ ] CORS, CSRF, API-key comparison, JWT secret, and encryption-key defaults fail closed.
- [ ] Login throttling, lockout, password reset, MFA policy, session revocation, and API-key rotation are tested.
- [ ] F1/F2/F3 are closed; async work re-checks ACL; denials are audited.
- [ ] IDoA, field ACL, injection, SSRF, XSS, webhook replay, and untrusted-package risks have regression tests.
- [ ] Secrets never appear in logs, errors, traces, artifacts, or browser state.

### Operations

- [ ] Encrypted off-host backup and restore drill have evidence, or G80/G81 are explicitly accepted/blocked.
- [ ] Security incident runbook, deployment baseline, tenancy decision, and compliance status are recorded.
- [ ] The nightly DB-free gate runs the DB-free security suites and detects a demonstrated regression. (Owner decision D3: the gate is **not** PR-gated; G78 stays an open exception.)
- [ ] No extra database, destructive setup, live provider action, or real customer communication occurred.

### Evidence

- [ ] `docs/quality/known-gaps.md`, the authorization matrix, the compatibility matrix, and CI gate docs reflect reality.
- [ ] The §2.3 contradictions are resolved in writing.
- [ ] The evidence report distinguishes tests run, skipped, blocked, and unverified capabilities.
- [ ] The final review records go/no-go, residual risks, owners, and deadlines without claiming full EspoCRM parity.

---

## 23. Final Coding-Agent Instructions

Implement in order and in small increments.

1. **Start with Phase 23.0 only.** Return the baseline inventory, the resolved contradictions, and the owner decisions before editing code.
2. For each sub-phase, list the intended files, tests, migration impact, configuration impact, external effects, and risk before editing.
3. Implement only the current sub-phase unless a blocker requires a narrowly scoped prerequisite fix.
4. Run the smallest relevant checks first (`pnpm lint:changed`, then the focused Vitest file), then the DB-free gate and the scoped integration suites.
5. Use the configured primary database only under `AGENTS.MD` §3. Never provision an extra database/schema and never reset or truncate it.
6. Use synthetic test records and fake providers; do not contact live vendors.
7. Review changed files for secrets, weakened assertions, disabled authorization, unrelated diffs, migration risk, and accidental artifacts.
8. Update the baseline, exception register, and test-evidence report with actual results.
9. Report passed/failed/skipped/blocked checks honestly and stop at the end of the requested sub-phase.
10. Do not claim a production release is ready while G80/G81, PR gating, or distribution compliance remain unresolved.

**First task to execute:** `Phase 23.0 — Security Baseline Audit and Contradiction Reconciliation`. Do not begin implementing fixes until the inventory, the seven contradictions, and the owner decisions have been presented for review.
