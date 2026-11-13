# Phase 23.11 — Security Release Review and Go/No-Go

> **Date:** 2026-11-13
> **Plan:** `plans/PLAN_Phase_23_Security_Hardening.md` §17
> **Baseline:** `docs/security/phase-23-security-baseline.md` · **Evidence:** `docs/quality/phase-23-security-test-evidence.md`
> **Decision: NO-GO for a production release.** Phase 23 closed the authorization, injection, SSRF, webhook,
> secret-handling and retention findings it promised to close, and the required DB-free gate is green. The release
> gate in §17 is still not satisfied: the encrypted off-host backup and the restore drill are **Blocked** (G80/G81,
> no approved recovery environment, RPO or RTO), the distribution/licence question has no owner decision, and
> several accepted exceptions are **not owner-signed** — this document cannot sign them.
>
> A conditional **alpha/pilot GO** is possible only under §8. Nothing here is a claim of complete EspoCRM parity.

---

## 1. Method

1. Re-ran the required DB-free gate `pnpm ci:gate` from the committed tree (no database service, no secrets).
2. Re-ran the Phase 23 security suites plus the adjacent authorization/auth/audit/attachment/rate-limit suites
   against the configured primary database, under `AGENTS.MD` §3. No database, schema or container was created;
   no table was reset, truncated or broadly deleted.
3. Re-read the exception register, the gap register, the compatibility matrix and the safe-default configuration
   against the code, rather than trusting the previous sub-phase reports.
4. Did **not** run the restore drill, a backup install, a live provider check or a production deployment review —
   each of those is either blocked (§4) or deployment-owned.
5. Recorded the result as a decision, not a summary: §5 is the gate, §6 the closed findings, §7 the live
   exceptions, §8 the residual risks and the recommendation.

## 2. Verification actually run (2026-11-13)

| Command | Result |
|---|---|
| `pnpm ci:gate` | **Exit 0** — `lint` (UI conventions 5 178 keys + eslint), `lint:arch`, `typecheck` (API + web), `build`, `ci:migrations` (94 files, highest `094_phase23_retention_schedules.sql`), `test:ci` **88 files / 1 421 tests**, `test:worker` **24 files / 248 tests**, `test:web` **15 files / 86 tests**, `ci:secrets` clean (**2 487 tracked files**) |
| Focused integration batch (18 files) | **18 files / 185 tests passed, exit 0** — `phase23-1`, `phase23-2` (×3), `phase23-3` (×3), `phase23-4` (×2), `phase23-5`, `phase23-8`, `phase23-10`, `acl-matrix`, `auth`, `audit`, `error-payload-hygiene`, `attachments`, `rate-limit` |
| `npx playwright test e2e/security-session-storage.spec.ts` (23.10) | **3 / 3 passed** — token-storage residual, reload restore, sign-out clears |
| `git status --short` / `git ls-files` artifact audit | clean work tree; the only tracked dotenv-shaped file is `.env.example`; no `test-results/`, `playwright-report/`, `.data/` tree or database dump is tracked |
| Safe-default review (source read) | `MAIL_TRANSPORT=none`, `MALWARE_SCAN_MODE=signature`, `OIDC_PROFILES=[]`, `CORS_ORIGINS=''` (fails closed), `EXTENSION_TRUST_MODE` = `enforce` in production / `warn` otherwise, empty `ENCRYPTION_KEY` refused in production, marketing send needs an explicitly bound provider, dev JWT secret / compose placeholder / dev database URL refused in production |
| Restore drill, backup install, live providers, production deployment review | **Not run** — G80/G81 Blocked; provider checks need credentials; deployment is owner-owned |

**Environment limitations:** the nightly GitHub workflow itself was not triggered (no throwaway branch was pushed);
`pnpm verify` was not used as the gate because G69/G75/G79 are known shared-database flakes, so the stable DB-free
gate plus the focused suites above are what this review rests on.

## 3. What Phase 23 actually changed

| Sub-phase | Delivered | Evidence |
|---|---|---|
| 23.0 | Baseline, §48 control matrix, single exception register, owner decisions D1–D4, G83–G94 | `docs/security/phase-23-security-baseline.md` |
| 23.1 | CORS fail-closed, CSRF entropy + constant-time compare, API-key `timingSafeEqual`, production config guards | `phase23-1-security.test.ts`, `config-jwt-secret.test.ts` |
| 23.2 | Login throttle + lockout, self-service password reset, enforceable MFA, session list/revoke, API-key rotation/scope/IP | `phase23-2-*.test.ts` |
| 23.3 | Generic OIDC provider profile (state/nonce/PKCE/exact redirect), G47/G50/G51/G84 | `phase23-3-*.test.ts` |
| 23.4 | Async re-derivation (`runAsUser`), denial audit, IDoA, G83/G96, replay requires a real replay | `phase23-4-*.test.ts`, `acl-matrix.test.ts` |
| 23.5 | Shared SSRF classifier, pinned redirects, marketing HMAC + mandatory timestamp, OpenAPI auth schemes | `phase23-5-ssrf.test.ts` |
| 23.6 | Attachment parent-ACL mandatory, API-key attachment policy, Ed25519 extension signatures | `attachments*`, `packages/extension-sdk` |
| 23.7 | Retention schedules (migration 094), job redaction, key rotation, G12/G13/G14/G21, stream-orphan sweep | `job-handlers.test.ts`, `jobs.test.ts` |
| 23.8 | Security event telemetry, DB-free suites in the nightly lane, gate-detection proof | `phase23-8-security-events.test.ts` |
| 23.9 | Incident runbook, deployment baseline, tenancy decision, compliance record, production config guards; backup/restore Blocked | `docs/runbooks/security-incident-response.md`, `docs/security/deployment-baseline.md` |
| 23.10 | Cross-surface regression suite, OWASP/§48/G-ID map, exception-register reconciliation, localStorage-token browser spec | `phase23-10-security-regression.test.ts`, `e2e/security-session-storage.spec.ts` |

## 4. Release gate (plan §17) — result

| Gate criterion | Evidence | Result |
|---|---|---|
| No known Critical/High authorization, injection, SSRF, secret-exposure or authentication-bypass finding remains open | Every finding in these classes is fixed or carries a named exception: G31/G40/G41/G43/G54 were fixed pre-23; the live rows in these classes are G89/G92/G95 (Medium) and G90/G91 (Low). G81 is High but it is an **operational backup** gap, outside the classes this criterion names — it fails the backup/restore row below, not this one | **PASS** — no open Critical/High authorization, injection, SSRF, secret-exposure or authentication-bypass finding |
| Every §48 control has a passing test, an executed verification, or a signed accepted exception | `docs/security/security-controls-matrix.md`; 23.10 map; exception register | **PASS with unsigned exceptions** — no agent-signed row; High/Critical acceptances must come from the owner |
| The required (nightly) DB-free gate passes and no security test was weakened | `pnpm ci:gate` exit 0; regression-detection proof in 23.8; the temporary failing test was removed, not merged | **PASS** (not PR-gated — G78 stays an exception) |
| Encrypted off-host backup and a restore drill have evidence, or the owner explicitly accepts the blocker | `scripts/backup.mjs` + `verify-backup.mjs` and the systemd template exist; nothing is installed; no drill has run | **FAIL — G80/G81 Blocked** |
| No extra database was created and no destructive setup was introduced | Every suite boots the configured primary DB; migrations 089–094 are additive; no reset/truncate/seed-clearing script exists | **PASS** |
| The distribution-compliance question has a recorded owner decision | `docs/security/distribution-compliance.md` — no `LICENSE`, no named owner/outcome | **FAIL — open release blocker** |
| No secrets, real customer records, database dumps, browser storage or unsafe artifacts are committed | Secret scan clean over 2 487 tracked files; artifact audit clean; test data is `AGENT_TEST_`-marked and removed by exact id | **PASS** |
| Optional providers and security settings default to safe modes; an unconfigured provider fails clearly | Safe-default review in §2; marketing send refuses `PROVIDER_NOT_BOUND`; OIDC list empty; mail `none`; production boot refuses placeholders | **PASS** |

**Overall: NO-GO.** Two gate rows fail — the backup/restore evidence and the distribution decision — and the §48 row passes only with exceptions no agent may sign.

## 5. Closed by Phase 23

G11, G12, G13, G14, G21, G23, G30 (stream half), G33, G47, G50, G51, G52, G65, G83, G84, G86, G87, G94, G96, F1, F2,
F3 — plus the new controls in §3. G30's attachment-orphan half and G97/G98 are recorded as accepted exceptions, not
claimed as fixed.

## 6. Live exceptions (all in `docs/security/exception-register.md`)

| ID | Severity | Owner | Why it is not fixed in Phase 23 | Review |
|---|---|---|---|---|
| G48 | Medium | advanced-integrations | The resilience layer is still not engaged on the sync path | 2026-12-09 |
| G49 | Low | advanced-integrations | `deletionPolicy: 'archive'` behaves like `unlink` | 2026-12-09 |
| G64 | Medium | platform / SPA | 142 SPA call sites render raw `error.message` | 2026-12-09 |
| G77 | Medium | platform / operations | No metrics/tracing exporter; process-local counters only | 2026-12-09 |
| G78 | Medium | platform | CI is nightly, not a PR gate (owner decision D3) | 2026-12-09 |
| G80 | Medium | platform / operations | No approved recovery environment or RPO/RTO — **Blocked** | 2026-12-09 |
| G81 | **High** | platform / operations | No installed encrypted off-host backup — **Blocked** | 2026-12-09 |
| G89 | Medium | worker / platform | Worker BPM/workflow writes bypass the API ACL layer (system-scoped, documented) | 2026-12-13 |
| G90 | Low | platform | `GET /OpenApi` served unauthenticated (route inventory only) | 2026-12-13 |
| G91 | Low | platform | Readiness answers DB reachability anonymously | 2026-12-13 |
| G92 | Medium | platform (CI) | No authorization assertion in the DB-free lane | 2026-12-13 |
| G95 | Medium | ai-agents | Trigger lookup reads only the first 20 published agents | 2026-12-13 |
| G97 | Low | platform / release | Dependency audit is manual, not in the mandatory gate | 2027-03-31 |
| G98 | Low | extensions / release | Sample extension packages are unsigned (production `enforce` refuses them) | 2027-03-31 |
| — | High (release) | owner / legal | No `LICENSE`; clean-room/AGPL review has no owner outcome | 2026-12-09 |
| — | High (design) | owner / architecture | Multi-tenancy absent by decision; tenant isolation is deployment separation | 2026-12-09 |

No High or Critical exception has been accepted. Per plan §21 and `AGENTS.MD`, the coding agent may not accept one:
the register records an open finding with a mitigation.

## 7. Residual risks this review cannot remove

1. **Recovery is unproven.** A backup that has never been restored is a hope, not a control; the tooling refuses to
   create or target a database, so the drill needs the owner's environment and RPO/RTO (G80).
2. **Detection is nightly.** A regression can merge before the scheduled run sees it (G78, owner decision D3).
3. **Authorization is not in the DB-free lane.** The ACL/BOLA suites boot the primary database and stay
   sandbox-only (G92); the nightly lane covers SSRF and the security-event contract.
4. **The SPA keeps the access token in `localStorage`.** Now pinned by a browser spec (one bounded `access` token,
   `HttpOnly` refresh cookie, sign-out clears it), but script execution would still reach it.
5. **Worker-side automation writes outside the API ACL layer** by design (G89); user-scoped async work re-derives
   the principal, system-scoped jobs do not.
6. **Telemetry is process-local.** Counters reset on restart and are not aggregated across instances (G77).
7. **Single-tenant by decision.** §48 tenant isolation is *not applicable* to this deployment, not verified; using
   one installation for two customers is unsupported (`docs/security/tenancy-decision.md`).
8. **Distribution is unresolved.** Without a `LICENSE` and a recorded clean-room/AGPL outcome, distributing the
   repository is an owner/legal decision this review does not make.

## 8. Recommendation

**NO-GO for a production release.**

A **conditional alpha/pilot GO** is defensible only when all of the following hold and the owner records them:

1. The data is synthetic or demo data, or the owner accepts the G80/G81 risk in writing with a recovery date.
2. `DATABASE_URL`, `JWT_SECRET`, `ENCRYPTION_KEY`, `CORS_ORIGINS` and `EXTENSION_TRUST_MODE=enforce` are set from the
   deployment secret store (the boot guards refuse placeholders), per `docs/security/deployment-baseline.md`.
3. No distribution outside the organisation until the licence question is answered.
4. The operator runs the focused integration batch and the browser spec in the target environment before the pilot,
   and repeats the nightly gate each night.

**What would flip the decision to GO:** an installed, encrypted, off-host backup with a completed restore drill and
approved RPO/RTO (G80/G81); a recorded distribution/licence decision; owner signatures on the High/Critical
exceptions; and, for a real production posture, a PR-gated security lane (G78) and an authorization assertion in the
DB-free lane (G92).

## 9. What this review does not claim

- Not complete EspoCRM parity, and not production-grade operations.
- No live-vendor certification; every provider path is tested against fakes/fixtures.
- No restore, failover, load or penetration test.
- No incident tabletop: the runbook is written, not exercised.
- No production deployment review: TLS, secret manager, database roles, Redis/object-storage policy and alerting are
  deployment-owned and recorded as unevidenced in `docs/security/deployment-baseline.md` §9.
