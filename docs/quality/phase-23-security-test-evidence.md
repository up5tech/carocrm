# Phase 23 Security Test Evidence

> **Date:** 2026-11-12
> **Latest sub-phase:** 23.9 — Operational security, backup and recovery (partially delivered; **Blocked** on G80/G81)
> **Plan:** `plans/PLAN_Phase_23_Security_Hardening.md` §15
> **Baseline:** `docs/security/phase-23-security-baseline.md`

## Phase 23.9 — Operational security, backup and recovery (partially delivered; **Blocked** on G80/G81)

> **Date:** 2026-11-12
> **Plan:** `plans/PLAN_Phase_23_Security_Hardening.md` §15
> **Status:** tasks 3–7 delivered as documentation/configuration review; tasks 1–2 are **Blocked** with
> the missing approvals and deployment-owned items named. No database was created, no restore drill was
> run, and no backup job was installed from this repository.

### Scope delivered

1. **Incident response (task 3).** New `docs/runbooks/security-incident-response.md`: severity/authority,
   first 15 minutes, evidence preservation, suspected credential/token leak, session mass-revocation
   (self password change, admin reset, soft delete, one-session revoke, and the reviewed-SQL bulk path),
   JWT/API-key/encryption-key rotation, webhook replay/provider compromise, data exposure, safe
   communication, safe diagnostics and the gaps the runbook cannot close. It uses the Phase 23.8
   `AdminInternal/action/operations` `security` block and the request/correlation ids from
   `docs/runbooks/platform-operations.md`.
2. **Deployment baseline (task 4).** New `docs/security/deployment-baseline.md`: TLS termination,
   trusted-proxy rules, CORS, secret injection, a production configuration table, least-privilege
   database roles, filesystem/backup/retention requirements, logging/alerting, a pre-production
   checklist and the deployment-owned items that are not in this repository. It records that
   `docker-compose.yml` is development-only (published Postgres/Redis, `postgres:postgres`, source
   mount, `db:seed`, dev server, placeholder JWT secret).
3. **Tenancy decision (task 5).** New `docs/security/tenancy-decision.md`: one installation serves one
   customer; deployment separation is acceptable only under five stated conditions and is not enforced
   by this code; §48 tenant isolation is **Not applicable by decision**, not “verified”; the triggers and
   minimum scope for a separate tenant-isolation phase are listed. No migration was started.
4. **Distribution compliance (task 6).** New `docs/security/distribution-compliance.md`: no root
   `LICENSE`; the clean-room/AGPL review has no named owner or outcome; release remains **Blocked** on an
   owner/legal decision. No licence was created and no legal conclusion was made.
5. **Production configuration verification (task 7).** `apps/api/src/config.ts` now also refuses, when
   `NODE_ENV=production`, the compose placeholder `change-me-in-production` and the development database
   fallback (`postgres:postgres@127.0.0.1/carocrm_dev`), in addition to the existing dev JWT secret,
   empty `ENCRYPTION_KEY` and non-`enforce` extension trust. The review also confirmed the safe optional
   defaults: `MAIL_TRANSPORT=none`, blank marketing webhook secret fails closed, empty OIDC profiles, and
   `MALWARE_SCAN_MODE=signature`.
6. **Blocked items recorded, not simulated.** G80 (no approved isolated recovery environment, no
   approved RPO/RTO) and G81 (no installed scheduler, off-host destination, provisioned gpg recipient or
   alert recipient) are marked **Blocked (2026-11-12)** in `docs/quality/known-gaps.md`; the controls
   matrix and `docs/operations/backup-restore.md` carry the same status. Task 1's “install” and task 2's
   “run the drill” are deployment/owner actions, so this sub-phase does not claim either.

### Commands actually run

| Command | Result |
|---|---|
| `pnpm exec vitest run --config vitest.ci.config.ts apps/api/test/config-jwt-secret.test.ts` | **7 tests passed** (5 existing + 2 new: compose placeholder, dev DB fallback) |
| `pnpm exec vitest run --config vitest.ci.config.ts apps/api/test/config-jwt-secret.test.ts apps/api/test/phase23-1-security.test.ts` (after the fixture fix) | **2 files / 19 tests passed** |
| Targeted `eslint` over `config.ts` and both touched test files | exit 0 |
| `pnpm typecheck` | exit 0 |
| `pnpm ci:secrets` | clean (2,481 tracked files) |
| `pnpm lint:arch` | OK — no new shared-core → business-domain imports (known exceptions = 2) |
| `node scripts/verify-backup.mjs .data/demo/backup-2026-10-22T03-12-12-673Z --max-age-hours=100000` | **exit 1 — 7 problems**: no encryption marker and seven missing core tables (`users`, `roles`, `teams`, `app_settings`, `audit_log`, `outbox_events`, `jobs`); **no world-readable permission problem**. The age check was widened only to isolate the other findings, so this is not a fresh backup. |
| `git diff --check` | exit 0 |
| `pnpm verify` (first run) | **exit 1** — 1 failed / 3,667 passed. The failure was a stale Phase 23.1 fixture that accepted a production config with no `DATABASE_URL`; the new production DB guard correctly refused the dev fallback. The fixture was given an explicit URL; no assertion was weakened. |
| `pnpm verify` (second run) | **exit 0** — lint, typecheck, **281 files / 3,668 tests**, web **15 files / 86 tests** |

### Not run / limitations

- **No backup installation and no restore drill.** The primary database was not touched, no database was
  created, and `restore:drill --allow-restore` was not run (G80, decision D4). A backup that has not been
  restored is not a recovery claim.
- **No incident tabletop.** The runbook is a procedure; nobody exercised it. The absence of an on-call
  rotation/paging route and of a bulk session-revocation endpoint is stated in the runbook §5.2/§8.
- **No production deployment review.** TLS, secret manager, DB roles, Redis/object-storage policy, backup
  timer and alerting are deployment-owned; the baseline lists them as unevidenced (§9), not as passed.
- **No licence decision.** The missing `LICENSE` and the clean-room/AGPL outcome remain an owner/legal
  blocker; the repository does not distribute under a declared licence.
- **Compose remains development-only.** The new guard makes a copied compose placeholder fail at boot,
  but the compose file itself still publishes dev ports and uses dev credentials; it was not converted
  into a production artifact.

## Phase 23.8 — Security observability and PR-gated CI (delivered 2026-11-12)

### Scope delivered

1. **Nightly trigger stays (task 1).** No `pull_request` trigger was added; G78 remains an accepted exception
   (owner decision D3). The workflow still has `contents: read`, no services, no secrets and no artifacts.
2. **DB-free security suites join the gate (task 2).** `ai-agent-adversarial.test.ts` (provider-URL/SSRF),
   `phase23-5-ssrf.test.ts` (the shared address classifier and every outbound URL guard) and the new
   `phase23-8-security-events.test.ts` are in `vitest.ci.config.ts`. `pnpm test:ci` is now **88 files /
   1 419 tests** (47 API suites + packages); the list remains a reviewed, explicit include.
3. **Security event telemetry (task 4).** New `apps/api/src/common/security-events.ts` with a fixed vocabulary,
   structured `security event` log lines (the logger attaches the request correlation id), and bounded in-process
   counts. Wiring covers denial audit, CSRF/same-origin refusals, failed logins and lockouts, refresh-token reuse,
   webhook signature rejections and replays in all four provider ingresses, and the key-rotation script
   (`secret.rotated`, counts only). The administrator operations snapshot now exposes `security.events` plus
   `loginFailures24h`, `signatureRejections24h`, `voiceRejections24h` and `marketingSignatureRejections24h` — labels
   and counts, never actors, addresses, tokens or payloads.
4. **Secret scan (task 3).** No new secret shape was introduced, so `scripts/check-secrets.mjs` is unchanged.
5. **Regression proof (task 5, partial).** A temporary DB-free test with one false security assertion made
   `pnpm test:ci` exit **1** (`1 failed | 88 passed`, `1 419` other tests passed); the file was removed and the
   regression was never committed. The GitHub scheduled run itself was not performed (no throwaway branch push),
   so workflow-trigger evidence remains a deployment check.
6. **CI contract updated (task 6).** `docs/quality/ci-gates.md` now records the new counts, the added suites, the
   security-event telemetry contract and what is still missing. G92 is narrowed to Partial (SSRF/event contract
   nightly; authorization still sandbox-only); G77 keeps the no-exporter limitation.

### Commands actually run

| Command | Result |
|---|---|
| `pnpm test:ci` | **88 files / 1 419 tests passed** |
| Temporary failing gate proof (`packages/core/src/__phase238_gate_proof.test.ts`, removed immediately) | `pnpm test:ci` **exit 1** — 1 failed / 1 419 passed |
| `pnpm exec vitest run apps/api/test/observability-operator.test.ts apps/api/test/phase23-8-security-events.test.ts` | **2 files / 9 tests passed** (failed-login/denial counts present; no actor/address/payload) |
| `pnpm --filter @carocrm/api typecheck` | exit 0 |
| targeted `eslint` over every touched API file | exit 0 |
| `pnpm --filter @carocrm/worker test` | 24 files / 248 tests passed (unchanged by 23.8; run before the commit) |
| `pnpm verify` | **exit 0** — lint 0, typecheck 0, **281 files / 3 666 tests**, web **15 files / 86 tests** |

### Not run / limitations

- **No exporter.** The `security.events` map is process-local and resets on restart; the 24-hour figures are
  database point-in-time counts. There is no cross-instance aggregation, time series or alerting — **G77** stays
  open/accepted. The logger's correlation id is the trace; there are no spans.
- **No GitHub scheduled run.** The local `ci:gate` command's test lane detects a regression, but a real nightly
  workflow run needs a throwaway branch and push, which this task did not perform. G78 (nightly-only) is unchanged.
- **Authorization is still not in CI.** Only DB-free SSRF/event suites were added; the ACL/BOLA suites boot the
  configured database and stay sandbox-only under G92.
- **Secret-rotation telemetry** is a structured line from the operator script, not an API endpoint; no secret or
  key material is printed.
- **One intermittent local failure was observed, not caused by this change:** the first full run failed
  `phase22-journey-ai-controlled-actions.test.ts` step 11 (`expected 'succeeded' to be 'canceled'`). The same file
  passed alone (12/12) and in the second full run (281 files / 3 666 tests). This is a timing race in a fake-delay
  cancellation journey; no assertion was weakened and the suite was not edited.
- No browser run; the operations snapshot is API-only.
- No database was created, reset or truncated; the only DB-backed suite writes an `AGENT_TEST_` failed-login row and
  removes it by its hashed subject in `afterAll`.

## Phase 23.7 — Data protection, privacy and retention (delivered 2026-11-12)

### Scope delivered

1. **Retention for G12/G13/G14 (task 4).** Migration `094_phase23_retention_schedules.sql` seeds five
   schedules — the two kernel sweeps that existed but were never scheduled, plus `cleanupJobs`,
   `cleanupProviderReceipts` and `cleanupStreamOrphans`. Every statement is terminal-state, age- and
   batch-bounded; none is a global delete. The signature inbox now acts on `purge_after`; voice
   receipts are minimized/deleted only when they have no normalized event; marketing receipts are
   deleted while `marketing_events` survives the nulled `inbox_id`; terminal `jobs` disappear after 30
   days in 500-row batches and `job_logs` cascades. Policy and ownership:
   `docs/security/data-retention.md`.
2. **Failed jobs (G21).** `POST /Job/:id/action/retry` re-submits a **failed** row as a new job (the
   failure stays as history) and `POST /Job/:id/action/discard` removes an exact **terminal** row.
   Pending/running work must be cancelled first. Regression: `apps/api/test/jobs.test.ts`.
3. **Job metadata redaction (task 2).** `job.views.ts` deep-redacts password/secret/token/api-key/
   authorization/cookie/credential-shaped keys in `data`, `result` and schedule `data`, with a depth
   bound. The worker still receives the original payload; only the admin view changes. Regression:
   the same jobs suite asserts the read does not contain the submitted values.
4. **Key rotation (task 1).** `scripts/rotate-encryption-key.mjs` re-encrypts the five vault stores
   inside one transaction, dry-run by default, aborts on a payload that decrypts with neither key,
   and never prints a secret. Procedure: `docs/security/encryption-key-rotation.md`.
5. **Audit retention/tamper evidence (task 5).** `audit_log` is deliberately excluded from automated
   retention; 24-month retention, export-before-purge, read-only API and least-privilege DB role
   expectations are written in `docs/security/data-retention.md` §3. Existing `denied`-event
   redaction regression (`audit.test.ts`, `phase23-4-denial-audit.test.ts`) still passes.
6. **G30 (partial).** `cleanupStreamOrphans` removes only old rows whose `entity_type` is a known
   Entity Engine type **and** whose exact record is gone. Attachment rows/files remain a named
   exception (owner platform, review 2026-12-12) because attachment reads already answer to the
   parent ACL.
7. **Consent/operator binding and CSV (tasks 3/6) verified, not changed.** The existing
   marketing-automation consent/send/provider suites and the CSV formula-neutralization tests were
   re-run against this change.

### Commands actually run

| Command | Result |
|---|---|
| `pnpm --filter @carocrm/worker test` | **24 files / 248 tests passed** (new retention cases included) |
| `pnpm exec vitest run apps/api/test/jobs.test.ts apps/api/test/marketing-automation-consent.test.ts apps/api/test/marketing-automation-send.test.ts apps/api/test/marketing-automation-provider.test.ts apps/api/test/audit.test.ts apps/api/test/phase23-4-denial-audit.test.ts apps/api/test/error-payload-hygiene.test.ts apps/api/test/phase12-search-import-dashboards.test.ts` | **8 files / 94 tests passed** |
| `node --check scripts/rotate-encryption-key.mjs` | exit 0 |
| `pnpm ci:migrations` | **clean** — 94 files, highest `094_phase23_retention_schedules.sql` |
| `pnpm --filter @carocrm/api typecheck && pnpm --filter @carocrm/worker typecheck` | exit 0 |
| Transactional SQL probe (all seven retention statements, `LIMIT 0`, `ROLLBACK`) | all statements parsed/planned, 0 rows changed, no data left behind |
| Marker probe: four `AGENT_TEST_p237_*` jobs (old completed, old pending, old running, recent completed) inside `BEGIN`/`ROLLBACK` | only the old **completed** marker was returned by `CLEANUP_JOBS_SQL`; pending, running and recent rows survived; transaction rolled back |
| `pnpm verify` (after the lint fix; final run includes the Phase 23.8 code) | **exit 0** — lint 0, typecheck 0, 281 files / 3 666 tests, web 15 files / 86 tests |

### Not run / limitations

- `scripts/rotate-encryption-key.mjs` was syntax-checked and reviewed, **not** executed with two real
  keys: doing so would rewrite production credentials and requires a stopped-writes window and a
  restore rehearsal. The crypto primitive's wrong-key/tamper behaviour is covered by
  `packages/core/src/utils/crypto.test.ts`.
- Attachment rows/files for a hard-deleted parent remain unswept (G30 residual, exception register).
- The SPA still keeps the short-lived access token in `localStorage` (`apps/web/src/api/client.ts`)
  so a page reload can reuse it; moving to memory-only would require updating the Playwright helpers
  that read that key. This is a **browser-state residual**, not a server-log/error/audit exposure, and
  the refresh cookie remains HttpOnly. Tracked in the Phase 23.10 browser-spec work.
- No Playwright/browser run in this environment; provider receipt jobs were verified with unit
  predicates and transactional SQL probes, not live provider deliveries.
- No database was created, reset or truncated. The SQL probes used `BEGIN`/`ROLLBACK`; the jobs API
  suite removes only the rows it created by exact id.

## Phase 23.6 — Files, attachments and extension supply chain (delivered 2026-11-12)

### Scope delivered

1. **Attachment direct-object access (task 1).** `ATTACHMENT_PROVIDERS` no longer registers
   `PERMISSIVE_PARENT_ACL_CHECKER`; a standalone module without `PARENT_ACL_CHECK_TOKEN` now fails at
   boot. `AppModule` supplies the record-ACL checker. Every read (`GET /Attachment/:id`,
   `/:id/file`, `/:id/url`) resolves admin, then visibility, then parent ACL; the uploader shortcut is
   kept for human sessions only. **API-user policy:** a key needs `read` for reads and `write` for
   writes; it may only upload to a record it can read (no orphan uploads), and it always reads through
   the parent ACL — never the uploader shortcut, so an orphan is unreadable to a key.
2. **File validation (task 2).** `SignatureScanner` now requires the declared container's magic number
   (`%PDF-` for PDF, `PK` for ZIP/OpenXML, the OLE header for legacy Office), in addition to EICAR,
   PE/ELF/Java/Mach-O/shebang, image magic and NUL-in-text checks. The existing suites already cover
   the sha256 checksum on upload/download, direct and chunked size ceilings, contiguous-part completion,
   local disk and the S3/MinIO drivers, and pre-signed URL expiry. `sanitizeSegment`/`buildStorageKey`
   strip path punctuation and leading dots, and the API test now uploads `../../escape.txt`.
3. **Extension package trust (task 3).** New `packages/extension-sdk/src/trust/` implements Ed25519
   signatures over a canonical digest of every package file. `EXTENSION_TRUSTED_KEYS` is a JSON map of
   `keyId -> PEM/base64 SPKI`; `EXTENSION_TRUST_MODE` is `enforce` (production default; `warn`/`off` are
   rejected there), `warn` (development default) or `off` (local tooling only). The API, worker and admin
   installer share `apps/api/src/extensions/extension-trust.ts`; verification happens before manifest
   parsing or backend import. A package containing a symlink is refused (the digest and importer would
   otherwise escape the directory).
4. **Dependency integrity (task 4).** The single `pnpm-lock.yaml` and `pnpm install --frozen-lockfile`
   are unchanged. No mandatory audit step was added because `pnpm audit` needs the network and task 4
   permits adding it only when it does not; **G97** records the manual release check.
5. **Named exception (task 5).** The three sample packages in `modules/` stay unsigned development
   fixtures; production `enforce` refuses them. **G98** records the exception and the signing path in
   `docs/extension-sdk.md` §8.

### Commands actually run

| Command | Result |
|---|---|
| `pnpm exec vitest run packages/extension-sdk/src/trust/index.test.ts packages/extension-sdk/src/loader/index.test.ts packages/files/src/scanner/index.test.ts` | **27 passed** (signed/unsigned/altered/unknown-key, enforce/warn/off, denied registration, PEM+base64 keys; container magic) |
| `pnpm exec vitest run apps/api/test/attachments.test.ts apps/api/test/attachments-storage.test.ts` | **31 passed** (foreign-parent 403, API-key scope/orphan policy, traversal, checksum, chunking, scanner) |
| `pnpm exec vitest run apps/api/test/config-jwt-secret.test.ts apps/api/test/extensions.test.ts` | **22 passed** (production requires `enforce`; sample packages load under dev `warn`) |
| `pnpm --filter @carocrm/extension-sdk build && pnpm --filter @carocrm/files build` | exit 0 |
| `pnpm --filter @carocrm/api typecheck && pnpm --filter @carocrm/worker typecheck` | exit 0 |
| `pnpm verify` | **exit 0** — lint 0, typecheck 0, `test` **280 files / 3 660 tests**, `test:web` 15 files / 86 tests |

### Not run / limitations

- The S3/MinIO checks are the existing driver/unit contract tests; no live bucket was contacted, so
  server-side pre-signed URL behaviour is verified against the adapter contract, not a real endpoint.
- No Playwright run; the attachment surface is API-only (the SPA has no file panel), and the extension
  admin screen's browser spec is unchanged.
- Sample extension packages are unsigned by design (G98); `enforce` is exercised with generated
  keypairs in the SDK suite, not with the sample packages.
- No new database or destructive operation was used; API tests boot against the configured primary
  database and clean only the rows they create.

## Phase 23.5 — Injection, SSRF, XSS and webhook authenticity (delivered 2026-11-12)

### Scope delivered

1. **Query engine allowlists (task 2).** `phase22-security-injection.test.ts` now demands the refusal it used to only
   hope for: a SQL-looking field, operator, sort key or selected field is a **400 `INVALID_QUERY`**, a SQL-looking
   *value* is parameterised (200, empty list), an injection-shaped entity name is 400/404 (never 500), and a malformed
   provider body is rejected before an adapter sees it. No query text is assembled from any of those inputs.
2. **SSRF inventory (task 3, G86).** `packages/core/src/net/address.ts` is the one classifier; the AI provider, voice
   media, connector and outbound-webhook validators delegate to it. The inventory covers the AI providers (redirect
   `error`), voice recording fetch (now `redirect: 'error'`; it was the only follower), advanced-integrations / OIDC
   (redirect `error`/`manual`), and the webhook-integration delivery (revalidated per attempt, redirect `manual`).
   `media.allowedHosts = []` now refuses every fetch, and media URLs must be https. `phase23-5-ssrf.test.ts` is DB-free
   and covers `[::1]`, `::ffff:127.0.0.1`, `::ffff:7f00:1`, ULA, link-local, metadata, 6to4/Teredo/NAT64 private
   embeddings, bracketed hostnames, allowlist misses and injected resolver answers.
3. **XSS (task 4).** The stored-payload test now also asserts the response is `application/json`; a CSP test pins
   `script-src 'self'`, `object-src 'none'`, `frame-src 'self'` and the absence of inline script. The SPA has no
   `dangerouslySetInnerHTML`; the docs renderer builds a typed React tree, and every HTML preview (email, document
   template) is a `sandbox=""` iframe. The existing `e2e/email-template.spec.ts` guarantee is unchanged.
4. **Formula sandbox (task 5).** The hostile list now includes `fetch`, `setTimeout`, `Math`, `Date`, `Reflect` and
   property access, on top of `eval`/`require`/`import`/`process`/`globalThis`, prototype keys, host-object leakage and
   the step/string/array budgets.
5. **G33 (task 6).** Marketing webhooks verify `sha256=<hex>` = HMAC-SHA256 over `timestamp + "." + rawBody`; the
   timestamp is mandatory, part of the signed material, and must be within five minutes. Missing/invalid timestamps
   are recorded rejections; an out-of-window delivery is a 400 with no inbox row; a tampered body cannot reuse the
   genuine dedupe key. The exact bytes are preserved for both marketing prefixes in `bootstrap.ts`.
6. **Provider fixtures (task 7).** Marketing joins the already-covered Advanced Integrations, Voice, Omnichannel and
   ESignature doors: valid, forged, tampered, missing timestamp, stale and duplicate deliveries are all exercised,
   comparisons are `timingSafeEqual`, and per-connection secrets stay in the vault (no secret is echoed by a read).
7. **OpenAPI (task 1).** The served document now declares `cookieAuth` (`CRM-SESSION`) and `bearerAuth`, and a contract
   test asserts representative paths/verbs. The DTO-schema half is **not** delivered and is recorded as a proposed
   accepted deviation in `known-gaps.md` G1; G90 (anonymous OpenAPI) still needs the owner's decision.
8. **ASVS / §48 links (task 8).** Each suite names its category: injection → ASVS 5.3.4 / API Top 10 API8:2023;
   SSRF → ASVS 5.2.6 / API7:2023; XSS → ASVS 5.3.3 / API8:2023; webhook authenticity/replay → ASVS 2.10.4 / API2:2023
   and PLAN §48 “Webhook signature verification” / “Replay protection”. Gap IDs are in the test file headers and in
   `known-gaps.md`.

### Commands actually run

| Command | Result |
|---|---|
| `pnpm --filter @carocrm/core build` | exit 0 (new shared classifier compiled) |
| `pnpm typecheck` | exit 0 (API and SPA) |
| `pnpm vitest run apps/api/test/phase23-5-ssrf.test.ts apps/api/test/phase22-security-injection.test.ts` | 2 files / 23 tests passed |
| `pnpm vitest run apps/api/test/marketing-automation-events.test.ts` | 23 tests passed |
| `pnpm vitest run apps/api/test/phase22-journey-marketing-consent-attribution.test.ts` | 11 tests passed |
| `pnpm vitest run apps/api/test/phase22-replay-contract.test.ts packages/formula/src/engine/index.test.ts` | 2 files / 43 tests passed |
| `pnpm lint:changed` | exit 0 after import sorting (37 changed files) |
| `pnpm verify` | **exit 0** — `lint` 0, `typecheck` 0, `test` 279 files / **3 648 tests**, `test:web` 15 files / 86 tests |

### Not run / limitations

- **G1 remains open in substance.** The route-level document and authentication schemes are machine-checkable, but
  request/response bodies are still not DTO-derived; the deviation proposal needs owner sign-off.
- **G90** (anonymous access to the OpenAPI document) is unchanged; it is an owner decision, not a code fix made here.
- **DNS rebinding** between validation and connect is still documented, not eliminated.
- **Playwright** was not executed; the XSS claims rest on source inspection, CSP assertions and the existing e2e spec.
- No live provider, DNS or outbound HTTP call is made by `phase23-5-ssrf.test.ts`; the marketing tests use the
  configured primary database and in-process providers.

## Phase 23.4 — Authorization consistency across every surface (delivered 2026-11-12)

### Scope delivered

1. **F1 — the async principal.** `apps/api/src/common/async-principal.ts` (`runAsUser`) reloads the initiating user,
   refuses an inactive/deleted account, and runs the work under the user's **current** roles. `ReportService`'s
   scheduled delivery now uses it instead of duplicating the reload. The jobs that remain system-scoped are
   enumerated with their justification in `docs/quality/authorization-matrix.md` §14.1. The worker's BPM/workflow
   writers (G89) are still outside the API ACL and are recorded as a residual risk, not as fixed.
2. **F2 — webhook verification.** The `@Public()` provider inventory is in the matrix §14.2. Every provider path
   (advanced-integrations, esignature, voice, omnichannel) verifies a signature before recording or applying state.
   Marketing's shared-secret-as-signature scheme is **not** claimed closed; it stays **G33** for 23.5.
3. **F3 — denial audit.** `GlobalExceptionFilter` emits a denial event for every `AUTHORIZATION_DENIED` answer via
   `apps/api/src/common/denial-audit.ts`; `AuditSinkService.recordDenial` writes `audit_log.action='denied'` with the
   actor from the request scope, the target the error named, the attempted action, the redacted path and the request
   id. The write is off the response path and a failure is logged, never returned. `bootstrap.ts` attaches the sink
   after the container initialises.
4. **IDoA.** `AuditReadService.assertHistoryVisible` resolves a record through `EntityCrudService.get` before a
   non-admin may read its history, closing **G96**; the isolated audit harness (no entity module) is fail-closed. The
   attachment metadata/file/signed-URL denials are pinned by a new independent-object test.
5. **Field ACL.** `acl-matrix.test.ts` now asserts that a bulk update touching an `edit:'no'` field is refused and the
   stored value is unchanged, and that a mass delete of a foreign record reports `count: 0` and leaves the record.
6. **G65.** The dashboard-default choice no longer reads `principal.roles`; the server's already-filtered list and the
   user preference are the only inputs. The dead `roleScoped` comparison is removed from the SPA.
7. **G11/G23 — dead-letter replay.** A run failure now records `{mappingId, runId}`. `replayTarget` refuses a letter
   without a mapping, the route re-runs the mapping's inbound sync with the `manual` trigger, and only then stamps
   `replayed`; `markReplayed` requires the id of that run. A failed re-run leaves the letter `open`.
8. **G83 — worker doors.** `@Public()` added to the worker-only Sales billing door. The two marketing doors were
   dual (admin token or worker capability on one route); because `@Public()` skips session resolution, they were
   split into an authenticated admin route plus a dedicated `@Public()` worker route, and the worker's path
   constants point at the new routes. The existing constant-time capability check is the authorisation.
9. **Decision table.** `docs/quality/authorization-matrix.md` §14 states the result for owner / team / unrelated /
   admin / API / portal / anonymous across every listed surface, with the system-scoped rows justified.

### Commands actually run

| Command | Result |
|---|---|
| `pnpm typecheck` | exit 0 (API and SPA) |
| `pnpm lint:changed` | exit 0 (20 changed files) |
| `pnpm vitest run apps/api/test/phase23-4-denial-audit.test.ts apps/api/test/phase23-4-idor.test.ts` | 2 files / 3 tests passed |
| `pnpm vitest run apps/api/test/acl-matrix.test.ts apps/api/test/advanced-integrations-engine.test.ts apps/api/test/advanced-integrations-admin.test.ts apps/api/test/reports.test.ts apps/api/test/error-payload-hygiene.test.ts` | 5 files / 62 tests passed |
| `pnpm vitest run apps/api/test/audit.test.ts` | 14 tests passed (after the fail-closed harness branch) |
| `pnpm verify` | **exit 0** — `lint` 0, `typecheck` 0, `test` 278 files / **3 621 tests**, `test:web` 15 files / 86 tests |

### Not run / limitations

- **Playwright** was not executed; no browser check is claimed for the removed dashboard rule.
- **G89** (worker BPM/workflow writes) is not fixed. It is documented as intentional system-scoped automation and
  routed to 23.10.
- The field-ACL matrix additions cover bulk update/delete and the audit surface; CSV import/export, global search and
  autocomplete still rely on their module suites rather than a new cell-by-cell matrix test.
- No live provider, mail, SMS or payment call was made; the tests use the configured primary database and fake/
  in-process providers only.

## Phase 23.3 — External identity and OAuth correctness (delivered 2026-11-11)

### Scope delivered

1. **Generic OIDC sign-in (new).** A provider is a **profile**, not code (`apps/api/src/auth/oidc/oidc-profile.ts`,
   configured through `OIDC_PROFILES`): issuer, endpoints, client id, client secret, scopes, and the
   `linkByEmail` / `autoProvision` / `defaultRoleIds` switches. The protocol is the platform's: the state
   is single-use and stored **hashed**, the nonce is checked, PKCE S256 is always used, the redirect URI
   is compared **exactly** with the value the platform sent *before* the code is exchanged, and the
   `id_token` is verified with `jose` (`createLocalJWKSet` + `jwtVerify`) — **RS/PS/ES only**, so `none`
   and HMAC are refused. The account-linking rule is explicit: an existing link wins → link by a
   **verified** email when exactly one account matches → provision when the profile allows → otherwise
   refuse. The sign-in ends in `AuthService.sessionForExternalSignIn`, the **same** session issuance as
   the password sign-in, so every 23.2 rule (single-session policy, MFA policy, revocation, rotation)
   applies unchanged. The session cookie strings moved to `apps/api/src/auth/session-cookies.ts` so the
   two paths cannot drift.
2. **G51 / G84 — the redirect URI is compared.** The advanced-integrations callback now accepts the
   echoed `redirect_uri` and the flow compares it with the value the platform sent (constant-time),
   **before** the authorization code is exchanged; a state row whose stored redirect URI is not the
   platform's own constant is refused as a tampered row. The code comment now describes a check that
   exists.
3. **G50 — a mapping names its connection.** `POST action/mappings` accepts an optional `connectionId`.
   A named connection must exist **and** belong to the named provider; a provider with exactly one
   connection still resolves without naming it; a provider with **more than one** is refused. The
   "first connection whose provider key matches, ordered by name" pick is gone.
4. **G47 — the connector refreshes its credential.** The executor refreshes an expired (or nearly
   expired) token **before** the provider call, and a provider that **refuses** the credential gets
   exactly **one** second attempt with a fresh token. The retry is bounded. Because a provider can
   revoke a token whose clock has not run out, the retry uses a **forced** refresh that is bound to the
   token that was refused: a credential another worker already replaced is not rotated twice, and the
   per-connection advisory lock still serialises concurrent refreshes. `needsRefresh` was lifted out of
   `oauth-flow.service.ts` so the executor and the refresh ask the same question.
5. **SPA.** The sign-in screen offers every configured provider (`GET /api/v1/Oidc/providers` is
   `@Public()`), and the browser leaves for the provider and comes back to the same cookies the password
   sign-in issues. The callback's `?oidc_error=` and `?oidc_challenge=` are read once and then removed
   from the address bar — the challenge id is a single-use credential and must not survive a reload or
   leak through the browser's history or a shared link.

### Tests run

- `pnpm vitest run apps/api/test/phase23-3-oidc-token.test.ts` → **22/22 passed** (DB-free: profile parsing,
  endpoint validation, id_token verification — valid / expired / wrong issuer / wrong audience / wrong
  `azp` / wrong nonce / `none` / HMAC / unknown `kid`).
- `pnpm vitest run apps/api/test/phase23-3-oidc-signin.test.ts` → **13/13 passed** (DB-backed, against a
  **fake** provider: valid sign-in issues the session cookies, stale state, replayed state, mismatched
  redirect URI, exact redirect URI, malformed callback, provider error not echoed, wrong nonce, wrong
  audience, linking by a verified email, an unverified email refused).
- `pnpm vitest run apps/api/test/phase23-3-oauth-connector.test.ts` → **12/12 passed** (DB-backed, against a
  deterministic fake connector: refresh before the call, one bounded retry after a refusal, no retry
  when the provider keeps refusing, no refresh for a valid token, a forced refresh skipped when the
  credential was already replaced; a mapping refused for an ambiguous provider, a mapping bound to the
  named connection, a connection from another provider refused, the single-connection case; three
  redirect-URI cases).
- `pnpm vitest run apps/api/test/advanced-integrations.test.ts` → **26/26 passed** (no regression).
- `pnpm vitest run --config vitest.web.config.ts apps/web/src/pages/login-oidc.test.ts` → **7/7 passed**.
- `pnpm typecheck` → pass (API and SPA).
- `pnpm ci:gate` → **exit 0** (lint, architecture rules, typecheck, build, migration check, the DB-free test
  split, the web tests and the secret scan).
- `pnpm verify` (lint + typecheck + `test` + `test:web`, in parallel) → **exit 0** against the configured
  primary database: `lint` exit 0, `typecheck` exit 0, `test` **276 files / 3617 tests passed**
  (302 s), `test:web` **15 files / 86 tests passed**.

No live provider, no network and no billable API is involved: the OIDC token endpoint and the JWKS
endpoint are replaced by a fake, and the connector is the deterministic fake the advanced-integrations
suite already used. Every row the suites create carries a run marker and is deleted by id.

### Known limitations

- **SAML and SCIM are not implemented.** They are deferred on purpose, with the rationale recorded in
  `docs/runbooks/advanced-integrations.md` §15 "Deferred: SAML and SCIM".
- The OIDC endpoint allowlist is a **misconfiguration** check (https, no credentials in the URL, no
  private or loopback literal). SSRF for user-supplied URLs belongs to 23.5, where the four divergent
  validators (G86) become one helper.
- The browser layer was **not** run: no Playwright browser is available in this environment, so the
  sign-in button, the callback redirect and the challenge hand-off are covered by unit tests and by
  reading the markup, not by a browser spec.
- The full DB-backed `pnpm verify` **was** run as a single command against the configured primary
  database and exits 0 (276 test files / 3617 tests, plus the web lane). `pnpm ci:gate` (the DB-free
  gate) was run as well and exits 0.
- **The shared database carried test artifacts from earlier runs.** The first full-gate run failed in
  seven assertions across four suites that 23.3 does not touch (`esignature`, `esignature-entities`,
  `esignature-reporting`, `ai-agent-triggers`). The cause was residue of an **interrupted** test run
  whose `afterAll` never executed: two `AGENT_TEST_es8_*` ESignature connections, fourteen signature
  requests and twenty-two published AI agents with an `AGENT_TEST` marker, all of which the
  esignature and AI-agent suites count. The residue was removed by its exact marker
  (`AGENT_TEST_es8_*` / `agent_key like 'agent-test-%' and name like 'AGENT_TEST%'`), never by a broad
  predicate, and the settings pointers that named a now-deleted test agent were cleared the way the
  owning suite (`phase22-journey-ai-controlled-actions.test.ts`) clears them. No business record was
  touched: every removed row carried a test marker this repository writes.
- **One real defect surfaced through that residue**, and it is recorded as **G95** in
  `docs/quality/known-gaps.md`: the AI-agent trigger door selects its candidates with
  `order by id asc limit 20` over the published agents, and the agent id is a random UUID — so with
  more than 20 published agents an agent that matches an event can be outside the window and never
  run. It fails closed (no run is started) and it is **not** fixed by 23.3, which is external identity
  and OAuth correctness.
- **The shared database keeps test users by design of the existing suites, and 23.3 does not change
  that.** After the final `pnpm verify`, roughly 4 289 `users` rows in the database carry a test
  marker this repository writes (`sd_owner_*`, `ma_owner_*`, `acl_all_*`, `modtest-*`, `tmpadmin-*`,
  …); about 310 of them were added by the runs of this session. The 23.3 suites leave **nothing**
  behind: `oidc_identities`, `oidc_signin_states` and every user, identity and state row the OIDC
  suites create are gone after the run. The accumulated rows are **not** deleted here — they are not
  owned by this sub-phase, their ownership cannot be proven for a shared database that other work also
  touches, and a broad delete is exactly what the database policy forbids. One older artifact is
  visible in the same shape: the integration connection `AGENT_TEST_zz_mvs50z63` (2026-10-28), left
  untouched for the same reason.

## Phase 23.2 — MFA policy, sessions and API-key lifecycle (delivered 2026-11-10)

### Scope delivered

1. **MFA policy enforcement (task 3).** `security.mfa.required` (`off`/`admins`/`all`) is evaluated at
   login (`mfaRequiredFor`): a covered account without TOTP receives an `mfa_pending` session instead of
   a usable one. `AuthGuard.enforceMfaPending` confines that session to `GET /AppUser/me`,
   `POST /AppUser/me/totp/setup`, `POST /AppUser/me/totp/enable` and `POST /Logout` — the flag is
   enforced, not advisory. `principalFromUser` re-checks the policy on every request, so tightening the
   setting confines sessions issued before the change. `enableTotp` binds the second factor to the
   enrolling session (`two_factor_verified`) and revokes the account's other unverified sessions;
   `disableTotp` refuses to go below the policy floor. `/AppUser/me` now reports `mfaPending` and
   `sessionId`; the SPA routes a pending session to an enrollment-only profile view.
2. **Session management (task 4).** `GET /AppUser/me/sessions` lists the caller's own live sessions
   (marked `current`); `DELETE /AppUser/me/sessions/:sessionId` revokes one, ownership-scoped (another
   user's session answers 404). Refresh rotation keeps the family id, the factor state and the absolute
   expiry; replaying a rotated token revokes the whole family (`reuse-detected`). Idle timeout is
   enforced on use in `principalFromUser`, not only at refresh. `Secure` cookies now follow
   `request.protocol`, which honours the `TRUST_PROXY` setting — a client-supplied
   `x-forwarded-proto` is only believed from a trusted peer. The profile page shows the session list
   with per-row revoke.
3. **API-key lifecycle (task 5, PLAN §17.2).** Migration `092` adds `scopes` and `allowed_ips` JSONB
   columns (NULL/empty = the pre-23.2 unrestricted behaviour). Keys carry `read`/`write` scopes
   (`write` implies `read`) enforced in the guard for every request the key authenticates, and an
   optional IP/CIDR allowlist checked in `authenticateApiKey` before the key is honoured (a mismatch
   answers the same 401 as a wrong secret — the restriction is not enumerable). `POST
   /ApiKey/:keyId/rotate` issues a replacement inheriting the restrictions and revokes the old key;
   the secret is shown once and only `hashString` hashes are stored. `last_used_at` updates on every
   successful authentication. The admin UI gained rotate, scope and IP fields plus a restrictions
   column; the key list never returns secret material.
4. **Tests (task 6).** New `apps/api/test/phase23-2-sessions-apikeys.test.ts` (9 tests) plus a
   lockout-expiry case in `phase23-2-security.test.ts`. No real email, SMS or provider call anywhere —
   the MFA test writes the `security` settings row directly and restores it.

### Tests run

- `pnpm exec vitest run apps/api/test/phase23-2-sessions-apikeys.test.ts apps/api/test/phase23-2-security.test.ts` → 13/13 passed.
- `pnpm exec vitest run apps/api/test/phase23-2-password-reset.test.ts apps/api/test/two-factor.test.ts apps/api/test/auth.test.ts` → 34/34 passed.
- `pnpm verify` → `pnpm lint` clean (UI conventions 5175 keys, eslint 0 problems), `pnpm typecheck` pass,
  `pnpm test:web` 79/79, `pnpm test` 3570/3570 across 273 files.
- `pnpm ci:migrations` → clean (92 files, highest `092_api_key_lifecycle.sql`).

Notes on the full-suite runs:

- `apps/api/test/module-test-app.ts` was repaired in this change: `AuthController` gained a
  `PasswordResetService` dependency in task 2, but the throwaway module harness never provided it, so
  every module-barrel suite aborted the vitest worker during Nest init (`abortOnError: true` masked the
  DI error). The harness now provides `PasswordResetService` + `MAIL_TRANSPORT_TOKEN` and uses
  `abortOnError: false` so a future DI break fails the test instead of killing the worker.
- `apps/api/test/esignature-provider-catalog.test.ts` was made self-sufficient: `prepareEnvelope`
  requires the `send` feature, which the suite previously inherited from leftover shared-database
  settings; `beforeAll` now enables it explicitly.
- `apps/api/test/ai-agent-triggers.test.ts` flaked once inside `pnpm verify` (`started: 0` instead of
  `1` on the event-trigger door — shared-primary-database state, unrelated to this change): it passes
  standalone (15/15) and passed on the `pnpm test` rerun (3570/3570). Worth a follow-up look at the
  per-user run cap / published-agent fan-out ordering under a shared database.

### Known limitations

- API-key scopes are method-level (`read` = safe methods, `write` = unsafe), not per-entity; finer
  scopes are a later refinement if a consumer needs them.
- The `mfa_pending` route allowlist is a fixed set in `auth.guard.ts`; new self-service enrollment
  routes must be added there deliberately.
- Lockout expiry is derived from the bounded failure window (failures age out), not a stored
  `locked_until` column — documented since task 1.

## Phase 23.2 — Self-service password reset (delivered 2026-11-10)

### Scope delivered

1. `POST /api/v1/PasswordReset` and `POST /api/v1/PasswordReset/confirm` (`@Public()`, both under the
   per-source auth rate budget). The request answers `{status:true}` for known and unknown identifiers
   alike — no account enumeration. Identifier may be the user name or the account email.
2. Token: `crypto.randomBytes(32)` (base64url), stored only as a SHA-256 hash in the new
   `auth_password_resets` table (migration `090`), single-use, expiring (`PASSWORD_RESET_TTL_SECONDS`,
   default 1 h), one live token per account, 60 s request cooldown, consumed/expired rows swept on
   request. Delivery reuses `MAIL_TRANSPORT_TOKEN`; with `MAIL_TRANSPORT=none` or no `SMTP_FROM` no
   token is minted (fail closed), and a transport failure never leaves an undelivered token stored.
3. Confirmation applies the instance password policy, re-checks the token under a row lock, revokes
   every session the old password opened, and clears the account's failed-login history. The admin
   reset (`POST /User/:id/password-reset`) contract is unchanged; it now enforces the same policy via
   `setPassword`, as does `changePassword`.
4. The stored-but-unread `security` settings document is now enforced at the point of use
   (`auth/security-policy.ts`): password minLength/uppercase/number/symbol.
5. SPA: "Forgot password?" link on the sign-in page and a public `/password-reset` page (request step,
   token + new-password step, `?token=` deep link), en + vi catalogs.

### Tests run

- `pnpm vitest run apps/api/test/phase23-2-password-reset.test.ts` → 8/8 passed (enumeration, hash-only
  storage, cooldown, expiry, policy, single use, session revocation, rate budget). Memory mail transport;
  no real email sent.
- `pnpm vitest run apps/api/test/auth.test.ts` → 21/21 passed.
- `pnpm vitest run apps/api/test/two-factor.test.ts` → 5/5 passed.
- `pnpm vitest run apps/api/test/phase23-2-security.test.ts` → 3/3 passed.
- `pnpm ci:migrations` → clean (90 files, highest `090_auth_password_resets.sql`).
- `pnpm lint:changed`, `pnpm typecheck` → pass.
- Browser (Vite dev + API, `MAIL_TRANSPORT=memory`): sign-in page shows the forgot-password link;
  request step answers generically and advances to the token step; an invalid token shows the stable
  error. Screenshots: `.data/screenshots/23-2-login-forgot-link.png`,
  `.data/screenshots/23-2-reset-confirm-error.png`. The one pending reset row the browser check created
  was deleted by exact user id + created-at window.

### Known limitations

- The reset email carries the token and instructions, not a deployment-specific absolute URL (no
  public-base-URL setting exists); the SPA page accepts `?token=` deep links.
- The happy path (consume a real token) is verified by the API suite; the browser check covered the
  request/error surfaces because the memory transport holds messages in-process.

## Phase 23.2 — Login throttling and lockout (delivered 2026-11-10)

### Scope delivered

1. Per-source authentication budget: the single global `@fastify/rate-limit` registration now takes
   per-request `max` / `timeWindow`, so the credential routes (`POST /api/v1/Authentication`,
   `POST /api/v1/Authentication/challenge`, `POST /api/v1/Refresh`) take the stricter auth ceiling
   (`authRateLimitMax` / `authRateLimitWindowSeconds`) while every other route keeps the global one.
   Bucket key is route-scoped (`<route>::<ip>`).
2. Per-account lockout: failed sign-ins are counted in the new `auth_login_attempts` table (SHA-256
   keyed subject hash, bounded retention); after `loginLockoutThreshold` failures inside the window the
   account is locked for `loginLockoutSeconds`; a successful sign-in clears the history; a locked account
   answers the same `AUTHENTICATION_FAILED` outcome (no enumeration).

### Tests run

- `pnpm vitest run apps/api/test/phase23-2-security.test.ts apps/api/test/rate-limit.test.ts` → 4/4 passed.
- `pnpm vitest run apps/api/test/auth.test.ts` → 21/21 passed (no regression from the new budget).
- `pnpm ci:migrations` → clean (89 files, highest `089_auth_login_attempts.sql`).

### Known limitations

- The per-source budget is an in-process local store; a Redis-backed store is the follow-up if the API
  ever runs multiple instances.
- Lockout expiry is derived (`lastFailure + loginLockoutSeconds`), not a stored `locked_until` column.

## Phase 23.1 — Fail-Closed Configuration and Cryptographic Primitives

> **Date:** 2026-11-09
> **Sub-phase:** 23.1 — Fail-Closed Configuration and Cryptographic Primitives
> **Plan:** `plans/PLAN_Phase_23_Security_Hardening.md` §7
> **Baseline:** `docs/security/phase-23-security-baseline.md`

### Scope delivered

1. CORS fails closed when unset (`resolveCorsOrigins`, `bootstrap.ts`); entries trimmed.
2. CSRF token minted with `crypto.randomBytes(32)`; comparison via length-checked `timingSafeEqual`;
   `Origin`/`Sec-Fetch-Site` guard; CSRF enforced on cookie-driven `POST /Refresh`.
3. API-key comparison via length-checked `timingSafeEqual`.
4. Production boot rejects the dev JWT secret and an empty `ENCRYPTION_KEY`.
5. Helmet serves a project CSP (no `unsafe-eval`; `unsafe-inline` styles justified for Ant Design/GrapesJS).
6. G52 provider error text removed; credential reference id now points at the stored credential row and is
   cleared on revoke.
7. G87 half-configured S3 credentials now throw.
8. JWT secret rotation procedure documented in `docs/security/jwt-secret-rotation.md`.
9. SPA `refreshAccessToken()` reads `CRM-CSRF` and sends `x-csrf-token`.

### Tests run

- `pnpm vitest run --config vitest.ci.config.ts` → 82 files / 1357 tests passed (includes new
  `phase23-1-security.test.ts`).
- `apps/api/test/phase23-1-security.test.ts` → 8/8 passed.
- `apps/api/test/config-jwt-secret.test.ts` → 5/5 passed (updated for the encryption-key rule).
- `apps/api/test/error-payload-hygiene.test.ts` → 6/6 passed.
- `pnpm lint` → 0 errors/warnings.
- `pnpm lint:arch` → OK.
- `pnpm typecheck` → pass.
- `pnpm --filter @carocrm/api build` and `@carocrm/files build` → pass.

### Known limitations

- Session binding of the CSRF token to `sid` is deferred; the double-submit contract is satisfied and the token is
  CSPRNG-backed, but it is not yet HMAC-bound to the session. Tracked as a follow-up.
- The CSP is attached to API responses only; the SPA is served by Vite/static hosting and its document CSP is out of
  scope for this sub-phase. `ws:/wss:/data:/blob:` are retained for Vite HMR, preview iframes and icon fonts.
- The credential-reference half of G52 is fixed for new stores; legacy rows created before this change may still
  carry the connection id and are left untouched.
- DB-backed `auth.test.ts` (including cookie-refresh with/without header) and Playwright e2e were not run in this
  environment.