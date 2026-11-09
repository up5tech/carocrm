# Phase 23.0 — Security Baseline and Contradiction Reconciliation

> **Date:** 2026-11-09
> **Plan:** `plans/PLAN_Phase_23_Security_Hardening.md` §6 (Phase 23.0)
> **Status:** Complete — evidence-based inventory, seven contradictions resolved, six owner decisions recorded.
> **Sub-phase boundary:** this sub-phase changed **no product code, no configuration and no CI file**. The only
> writes are documentation: this file, `docs/security/security-controls-matrix.md`,
> `docs/security/exception-register.md`, and reconciliation edits inside `docs/quality/known-gaps.md`,
> `docs/quality/phase-22-security-privacy-regression-suite.md`, `docs/quality/authorization-matrix.md`,
> `docs/quality/ci-gates.md` and `docs/reference/compatibility-matrix.md`.
> **Database:** the configured primary database was used read-only for verification. No database, schema or
> container was created; no data was modified outside test records the suites create and own
> (`AGENTS.MD` §3).

---

## 1. Method and evidence

Every claim below is either a `file:line` citation into the current source, or the result of a command that was
actually executed in this session. Where a claim could only be established statically it is labelled as such.

### 1.1 Commands executed on 2026-11-09

| Command | Result |
|---|---|
| `pnpm ci:gate` (DB-free required gate) | **Exit 0** — lint, UI conventions, architecture boundaries, typecheck, build, static migration check, `test:ci`, `test:worker`, `test:web`, secret scan |
| `pnpm test:ci` | **81 files / 1 349 tests passed** |
| `pnpm test:web` | **14 files / 79 tests passed** |
| `pnpm ci:secrets` | **clean (2 434 tracked files)** |
| `pnpm ci:migrations` | **clean (88 files, highest `088_phase19_ai_agents_mcp_idempotency.sql`)** |
| `pnpm lint:arch` | **OK — no new shared-core → business-domain imports (known exceptions = 2)** |
| `pnpm vitest run apps/api/test/two-factor.test.ts` | **5 passed** (against the configured primary database) |
| `pnpm vitest run apps/api/test/phase22-security-regression.test.ts apps/api/test/phase22-security-injection.test.ts` | **11 passed** (7 + 4, against the configured primary database) |
| `pnpm vitest run --config vitest.ci.config.ts apps/api/test/config-jwt-secret.test.ts apps/api/test/error-payload-hygiene.test.ts` | **10 passed** (DB-free) |
| Runtime probe — generated OpenAPI document (`GET /api/v1/OpenApi`, anonymous) | **200**; **772 paths**, `components.schemas` = **0**, `requestBody` present on **0** paths, response `content` on **0** paths, `securitySchemes` = **null** |
| Runtime probe — worker routes without a session (`POST` with only `x-worker-secret`) | `Sales/action/generate-subscription-invoices` → **401 AUTHENTICATION_REQUIRED**; `MarketingAutomation/action/delivery/run-scheduled-batch` → **401**; `MarketingAutomation/action/journey/run-batch` → **401**; `Sales/action/expire-quotes` → **401 AUTHENTICATION_FAILED / "Invalid worker capability"** (i.e. it *did* reach the capability check) |
| Runtime probe — CORS with a foreign origin (`Origin: https://evil.example`) | `Access-Control-Allow-Origin: https://evil.example`, `Access-Control-Allow-Credentials: true`; preflight → **204** with the same headers |
| Runtime probe — security headers | `content-security-policy` (helmet defaults), `strict-transport-security: max-age=31536000; includeSubDomains`, `x-content-type-options: nosniff` |
| Runtime probe — public routes | `GET /health/ready` → **200** `{"status":"ok","database":"up"}`; `GET /api/v1/OpenApi` → **200**; `GET /docs` and `GET /docs/static/index.html` → **404** |

**Not run in this sub-phase:** the browser/e2e layer (no Playwright browser in this environment), the restore
drill (G80 — no approved environment), any provider sandbox, and the full DB-backed `pnpm verify` (the DB-free
gate is the stable required gate; the DB-backed suite shares one database and carries the known G69/G75/G79
flake history).

---

## 2. Control inventory — corrections to the Phase 23 plan's §2.1 baseline

The plan's §2.1 table was written from documentation. Row by row against source and executed commands:

| §2.1 row | Verdict | Correction |
|---|---|---|
| Argon2id hashing | **Confirmed** | `argon2.hash(..., { type: argon2.argon2id })` at `auth.service.ts:535,549`; `argon2.verify` at `:89` |
| HS256 JWT via `jose`, access `typ` check | **Confirmed** | `auth.service.ts:382` rejects a payload whose `typ` is not `access` |
| `user_sessions`, refresh rotation, logout/password-change revocation | **Confirmed as implemented**, but **not verified end-to-end** | `apps/api/test/auth.test.ts` asserts the logout **status** only; no test proves a revoked token stops working. Listed as **insufficiently verified** |
| HttpOnly/SameSite cookies, `Secure` behind `x-forwarded-proto` | **Confirmed** | `auth.controller.ts:300-304` |
| CSRF double-submit | **Confirmed present**, but the plan's "token entropy" wording understates it | Three separate weaknesses, not one: (a) `Math.random()` entropy; (b) plain `!==` comparison; (c) the token is **not bound to the session** and `POST /api/v1/Refresh` is `@Public()` and cookie-driven with **no CSRF check at all**. The shipped SPA never uses the cookie path (it keeps a bearer token in `localStorage`), so the contract is dormant in practice — but dormant is not closed |
| TOTP 2FA, single-use 5-minute challenge, 5-attempt bound, hashed recovery codes | **Confirmed as implemented** | `auth.service.ts:118` (5-minute expiry), `:133` (5 attempts), `:152-175` (recovery code single use, hashed) |
| Hashed API-key secrets | **Confirmed**, but the comparison is plain | `auth.service.ts:408` uses `!==` on the hash |
| Global `AuthGuard` as `APP_GUARD`, `@Public()` opt-in | **Confirmed** | `app.module.ts:336-340`; `auth.guard.ts:28-30`. **There is no admin guard**: admin is a per-route/service check, not a guard (§4.2) |
| Entity/field/record ACL compiled into SQL | **Confirmed** | `entity-record.store.ts:282,315` (`aclSql(...)` → a `where` clause); `packages/acl/` |
| Separate portal role space, no existence leak (404) | **Confirmed** | `portal-policy.service.ts:217` returns `allowed: false` for a missing record |
| Audit hooks with field diff and secret redaction | **Confirmed for writes** | `audit-hooks.ts:130` (sensitive values redacted). **Denials are not audited** (F3) |
| Safe error envelope, redacted query strings | **Confirmed** | `global-exception.filter.ts:169`; `error-payload-hygiene.test.ts` 6 passed |
| helmet, global rate limit, body/multipart limits, statement/request timeouts | **Confirmed** | `bootstrap.ts:209,211,231`; `config.ts:15-22` |
| SSRF guard for AI provider and voice media URLs | **Confirmed for those two paths only** | The guard exists in **four** separate implementations, not one; `voice-media.service.ts:167` is the only outbound fetch that follows redirects |
| Webhook signature verified before record | **Confirmed for Advanced Integrations** | `webhook-ingress.service.ts:117-128`. The marketing path does **not** verify a signature over the body (G33) |
| Malware/MIME scanner, formula sandbox, CSV formula neutralisation, GrapesJS XSS-safe source | **Confirmed** | `packages/files/src/scanner/`, `packages/formula/`, `apps/api/src/attachment/index.ts:71-72` |
| Secret scan, static migration guard, architecture-boundary guard | **Confirmed** | `pnpm ci:secrets` clean (2 434 files); `pnpm ci:migrations` clean (88 files); `pnpm lint:arch` OK |

### 2.1 Controls the plan called "Missing" that are in fact absent (confirmed)

- **Login throttling / lockout** — `grep -rn "lockout\|failed_login\|failedLogin\|throttle" apps/api/src/auth` → **0 hits**.
- **Self-service password reset** — the only reset is `POST /api/v1/User/:id/password-reset` (`identity.controller.ts:58`), admin-only. No token, no email, no expiry.
- **Enforceable MFA** — `users.totp_enabled` is a per-user opt-in (`database/migrations/072_two_factor_authentication.sql:8`). There is no role-level, team-level or administrator-set policy anywhere.

---

## 3. Contradiction reconciliation (plan §2.3)

All seven have an explicit resolution.

### C1 — G1 / the OpenAPI document

**The plan's premise was half right.** A document **does** exist and is served at `GET /api/v1/OpenApi`
(`apps/api/src/bootstrap.ts:238`, `instance.swagger()`), and it is generated by `@fastify/swagger` from the
registered Fastify routes — not hand-written. `docs/reference/compatibility-matrix.md:22` is therefore **correct**.

But the executed probe shows what the document actually contains:

- **772 paths**, each with a verb and a bare `"Default Response"`;
- `components.schemas` = **0**;
- `requestBody` on **0** paths;
- response `content` on **0** paths;
- `securitySchemes` = **null**.

So the document is a **route inventory**, not a **contract**: no request schema, no response schema, no declared
security scheme. The 57 `@nestjs/swagger` imports in `apps/api/src` are `ApiTags` only — no `ApiProperty`,
no `ApiOperation`, no `DocumentBuilder`/`SwaggerModule` anywhere in the repository.

**Resolution:** G1 is **partially true and badly worded**. `docs/quality/known-gaps.md` G1 says "No generated
OpenAPI document — the API contract is not machine-verifiable". The accurate statement is: *a route-level OpenAPI
document is generated and served, but it carries no DTO-derived schemas, no request/response bodies and no
security schemes, so the API contract is still not machine-verifiable.* The gap survives in substance; the wording
was corrected rather than the row deleted.

**Additional finding (new):** `GET /api/v1/OpenApi` is served **without authentication** and exposes the full
route surface of the platform, including admin, worker and webhook paths. That is information disclosure, not a
bypass, but it should be an owner decision in 23.5.

### C2 — G11 / the dead-letter replay capability check

**Resolved: the route does have a capability check.** `apps/api/src/advanced-integrations/advanced-integrations.controller.ts:411-415`:

```ts
@Post('action/dead-letters/:id/replay')
async replayDeadLetter(@Param('id') id: string) {
  await this.permissions.assert('connectionAdmin');
  return this.deadLetters.markReplayed(id);
}
```

`permissions.assert` resolves the capability through `AclApiService.canUser(INTEGRATION_CONNECTION_PERMISSION_ENTITY, 'edit')`
and throws `AuthorizationDeniedError` when the level is `no`
(`advanced-integrations-permission.service.ts:48-57`). Every other route in that controller carries the same gate.

**Resolution:** the `known-gaps.md` **summary row is right** ("Fixed 22.14, as part of G43") and the **detail entry
is stale** ("Open — deferred to 22.17"). The detail entry was corrected.

**G23 remains open and was confirmed:** `markReplayed` (`dead-letter.service.ts:127-145`) flips `status` to
`replayed` and writes an audit row. It does **not** re-run the failed work. The route's contract therefore lies to
the operator.

### C3 — MFA and password reset

`docs/reference/compatibility-matrix.md:19` says "OAuth/OIDC, MFA, password reset — not built — not started".
That is wrong for MFA and admin reset:

- **TOTP 2FA exists** — `apps/api/src/auth/totp.ts` (RFC 6238 over RFC 4648 base32, built on `node:crypto`'s
  HMAC-SHA1), `auth.service.ts:105-200`, migration `072_two_factor_authentication.sql`, and
  `apps/api/test/two-factor.test.ts` (5 tests, green 2026-11-09).
- **Admin password reset exists** — `POST /api/v1/User/:id/password-reset` (`identity.controller.ts:58`).

What is genuinely not built: **OAuth/OIDC**, **self-service password reset**, and **enforceable MFA**
(2FA is a per-user opt-in with no policy).

**Resolution:** the matrix row was corrected to state exactly this split rather than deleting it.

### C4 — Constant-time API-key comparison

**Resolved: the code does not use a constant-time compare.** `apps/api/src/auth/auth.service.ts:408`:

```ts
if (key.secret_hash !== hashString(secret)) return undefined;
```

A plain string comparison of the stored hash against the hash of the presented secret.
`docs/quality/authorization-matrix.md:26` claims "(constant-time compare)" — that claim is **false** and was
corrected in place. The fix belongs in 23.1 (`timingSafeEqual` over the two digests, with a length check).

### C5 — CSRF token entropy and its consumption contract

**Resolved.** Generation is `apps/api/src/auth/auth.controller.ts:328-333` — 32 characters from
`Math.random()` over a 62-character alphabet. Consumption is `apps/api/src/auth/auth.guard.ts:64-74`: a plain
`csrfHeader !== csrfCookie` comparison of the `CRM-CSRF` cookie against the `x-csrf-token` header.

The weaknesses, precisely:

1. **Entropy** — `Math.random()` is not a CSPRNG. `crypto.randomBytes` is already used elsewhere in the same
   file family (`randomBytes` in `auth.service.ts`, `oauth-flow.service.ts`), so no new dependency is needed.
2. **Not session-bound** — the token is unsigned and unrelated to `sid`. A cookie-injection vector (sibling
   subdomain, response splitting, XSS) could fix a known token.
3. **Not constant-time** — a plain `!==`.
4. **A real bypass surface**: `POST /api/v1/Refresh` is `@Public()` (`auth.controller.ts:114`) and is driven by the
   `CRM-REFRESH` cookie with **no CSRF check**, because `auth.guard.ts:28-30` returns `true` for `@Public()`
   before any CSRF comparison. A cross-site top-level POST navigation can therefore rotate a session.
5. **No `Origin` / `Referer` / `Sec-Fetch-Site` check** anywhere in the auth path.
6. **The SPA never exercises the cookie path** — `apps/web/src/api/client.ts:290,292` sends
   `Authorization: Bearer` from `localStorage` and **never sends `x-csrf-token`**; `csrfToken` exists in
   `apps/web/src/api/types.ts:441` but is unused. The whole cookie/CSRF contract is dormant in the shipped SPA.

**Impact:** medium-low as an exploit today (`SameSite=Lax` stops a genuinely cross-site attacker from attaching
the cookies), medium as a hardening item, and **not** a "one-line `Math.random()` → `crypto.randomBytes()`" fix.
The 23.1 scope must cover the whole contract, including the `@Public()` refresh route.

### C6 — The CORS default

**Resolved by execution, not by reading.** `apps/api/src/bootstrap.ts:204-210`:

```ts
origin: config.corsOrigins === '' ? true : config.corsOrigins.split(','),
credentials: true,
```

`config.corsOrigins` defaults to `''` (`config.ts:35`), so an unconfigured deployment takes the permissive
branch. The probe with `Origin: https://evil.example` returned:

```
Access-Control-Allow-Origin: https://evil.example
Access-Control-Allow-Credentials: true
```

on both the GET and the preflight. The origin is **reflected**, and credentials are **allowed**.

Additional facts that change the severity:

- There is exactly **one** CORS registration in the repository — no route-level exception, no SPA-dev allowlist.
- `.env` does not set `CORS_ORIGINS`, and **`.env.example` has no `CORS_ORIGINS` key at all** — an operator gets
  no prompt to set it.
- The allowlist is not trimmed: `"http://a, http://b"` produces `['http://a',' http://b']`, and the second never matches.
- The API **does** serve browser credentials (`CRM-SESSION`, `CRM-REFRESH`, `CRM-CSRF`; `auth.controller.ts:300-304`).
- `SameSite=Lax` on the session cookies means a **truly cross-site** attacker cannot have the browser attach
  them on a fetch/XHR. The exploitable variant is a **same-site sibling subdomain** (`evil.crm.example.com` vs
  `api.crm.example.com`): the cookies *are* same-site, the origin is reflected, and there is no `Origin` check.
- `POST /api/v1/Authentication` is `@Public()`, so login CSRF (a cross-site form post that sets the session
  cookie) is reachable; its impact is muted because the SPA is bearer-first.

**Resolution:** the reflected-origin default is a **finding**, not a configuration preference. It is a **Medium**
(fail-open default, no prompt to configure, exploitable from a same-site sibling), owned by platform, fixed in 23.1
by replacing the branch with an explicit allowlist that fails closed when unset.

### C7 — The expired / stale exception list

**Resolved: the defect is status drift, not expiry.** The Phase 22.17 review dates (2026-11-15, 2026-11-30) are
still in the future on 2026-11-09, so nothing has expired. But the register itself was stale: commit `fe27adb`
(2026-11-03) fixed **G37, G38, G39 and G63**, and `docs/quality/known-gaps.md` was updated in that commit while
`docs/quality/phase-22-security-privacy-regression-suite.md` §7 and §9 were not.

| Finding | Phase 22.17 §9 | `known-gaps.md` today | Agree? | Phase 23 disposition |
|---|---|---|---|---|
| G37 | Medium exception | Fixed 2026-11-03 | No | **Closed** — `service-desk-write-guard.service.ts:94,144` |
| G38 | Medium exception | Fixed 2026-11-03 | No | **Closed** — `crm-chat.controller.ts:247,385` |
| G39 | Low exception | Fixed 2026-11-03 | No | **Closed** — `crm-chat-citations.service.ts:410` |
| G63 | Medium exception | Fixed 2026-11-03 | No | **Closed** — `apps/web/src/admin/RequireAdministration.tsx`, `AppRoutes.tsx:212-221` |
| G47 | Medium, review 2026-11-30 | Open | Yes | **Carried forward**, review 2026-12-09 |
| G48 | Medium, review 2026-11-30 | Open | Yes | **Carried forward**, review 2026-12-09 |
| G49 | Low, review 2026-11-30 | Open | Yes | **Carried forward**, review 2026-12-09 |
| G64 | Medium, review 2026-11-30 | Open | Yes | **Carried forward**, review 2026-12-09 |
| G65 | Low, review 2026-11-15 | Open | Yes | **Carried forward**, review 2026-12-09 |

Two structural defects were found alongside it:

- §8 claimed "remaining open findings are Medium/Low and are dispositioned in §9" — **false**. `known-gaps.md`
  still carries open Medium/Low findings that appear in no exception list: **G50** (Medium), plus G51, G52, G53,
  G33, G66, G67, G68, G29, G27.
- The §9 preamble said "Open Medium findings" but the table contained three **Low** rows and four already-**Fixed**
  rows.

**Resolution:** all exceptions now live in `docs/security/exception-register.md`; the Phase 22.17 §9 now links there
instead of keeping a second table.

---

## 4. Threat-surface inventory

### 4.1 Public routes

Every route is authenticated **by default** — the global `AuthGuard` is opt-out via `@Public()`
(`auth.guard.ts:28-30`), so no route is exposed by forgetting a decorator. The `@Public()` surface is 45 routes:

| Group | Routes | Independent verification before any state change |
|---|---|---|
| Auth | `POST /Authentication`, `POST /Authentication/challenge`, `POST /Refresh` | Password + TOTP/recovery challenge (5 attempts, 5-minute expiry); refresh is token-only and **has no CSRF check** (C5) |
| Health / settings / i18n | `GET /health/live`, `/health/ready`, `/Settings`, `/Settings/logo`, `/I18n` | Read-only. `/health/ready` returns database reachability to an anonymous caller |
| Worker doors | 1 report + 2 sales + 1 service-desk + 9 customer-success + 5 lead-score + 5 AI-agent + 5 advanced-integrations + 2 esignature | Shared `x-worker-secret` (or `x-report-worker-secret`), compared with `timingSafeEqual` (`report.service.ts:306-313`) |
| Provider webhooks | advanced-integrations, esignature, voice, omnichannel, marketing | advanced-integrations / esignature / voice / omnichannel verify a **provider signature before recording**; marketing compares the **shared secret** and treats the timestamp as optional (**G33**) |
| OAuth callbacks | advanced-integrations, esignature | Single-use `state`; the connection is derived from the state, never from the request |
| Public intake | `ServiceDesk/action/webToCase`, `MarketingAutomation/public/form/submit` | Honeypot + per-IP rate limit only. Both write CRM records through a `sysAdmin` principal. The marketing form **reuses an existing Lead by email** — it does not overwrite its fields, but it does record a consent entry and a journey enrolment against that Lead |
| Marketing public | `public/preferences/:token`, `public/unsubscribe/:token`, `public/confirm/:token`, `public/click`, `public/open` | Hashed scoped token with a scope check and an attempt budget; `public/click` resolves its target against a configured base URL (no open redirect) |
| Omnichannel chat | `Omnichannel/chat/session`, `/messages` | 128-bit visitor cookie + an origin allowlist that fails closed |

**F2 — the `@Public()` webhook verification gap named in the plan is largely closed**, with one exception: the
marketing webhook path. The plan's claim that "esignature / omnichannel `@Public()` webhooks are a verification
gap" is **not reproducible** — both verify a provider signature before any state change.

### 4.2 Admin authorization

There is **no admin guard** in the platform. Admin is a per-route or per-service check:

- `scope.isAdmin` (`principal.userType === 'admin'`, `common/request-scope.ts:71-73`);
- `roleIds().includes('sysAdmin')` (`acl/acl-api.service.ts:342,374`);
- 23 `requireAdmin(...)` call sites across sales, marketing, customer-success, voice, service-desk, document,
  workflow, process, formula, extensions, jobs, scheduled-jobs, metadata, portal-admin, identity, admin-panel,
  setup-checklist, storage-usage, navigation, settings, email accounts.

**G63 clarification:** G63 was a **SPA** gap ("no route guard in front of `/admin/*`") and it is **fixed**
(`RequireAdministration` wraps every standalone `/admin/*` route). There is **no server-side `/admin/*` path
prefix** to guard: the API's admin surface is `api/v1/AdminPanel` and `api/v1/AdminInternal`, each with its own
check. The plan's 23.4 task "confirm the `/admin/*` route guard (G63) still matches the server ACL" was based on a
misreading and is corrected here.

### 4.3 Outbound URL fetch (SSRF) sites

| Site | URL source | Control |
|---|---|---|
| `ai-agents/ai-provider-anthropic.ts:71`, `ai-provider-openai-compatible.ts:68` | admin-configured provider `baseUrl` | `assertSafeProviderBaseUrl` (https-only, no credentials, no metadata host, no private/loopback IP) + `redirect: 'error'` |
| `voice-communications/voice-media.service.ts:167` | provider recording URL from a webhook | `assertSafeMediaUrl` (host allowlist, **empty by default ⇒ refuse all**) — **but the fetch follows redirects** |
| `advanced-integrations/provider-http-client.ts:127` | connector endpoint | `assertProviderUrl` + `redirect: 'manual'` (3xx surfaced, never followed) |
| `esignature/providers/docusign/docusign-transport.ts:110`, `dropbox-sign-transport.ts:83` | connection base URI | `assertProviderUrl` |
| `modules/webhook-integration/src/delivery.ts:66` | admin-registered endpoint | `assertPublicUrl` — **a third independent validator** |
| `advanced-integrations/connectors/enrichment/rest-enrichment.adapter.ts:216` | connector endpoint option | config-time check, not per-request |
| `esignature/providers/docusign/docusign-oauth.ts:257,292` | OAuth token endpoint (config) | `assertProviderUrl` |

**Finding:** there are **four** SSRF validators where the plan expects one shared helper, and the DNS-rebinding
gap between validation and fetch is acknowledged only in `ai-provider-url.ts:20-22`.

### 4.4 Secret sources in `apps/api/src/config.ts`

| Key | Default | Fails closed? |
|---|---|---|
| `jwtSecret` | `dev-only-secret-change-me` | **Only in production** (`config.ts:125-134`); a dev/test deployment accepts the known default |
| `encryptionKey` | `''` | **At use, not at boot** — an empty key lets the app boot and fails only when a credential is written (`credential-vault.ts:200,209`) |
| `reportWorkerSecret` | `''` | **At use** — every `assertWorkerSecret` throws when empty |
| `marketingWebhookSecret` | `''` | **At use** — an unset secret makes every delivery `signatureValid = false` (fails closed) |
| `databaseUrl` / `databaseAdminUrl` | a local dev URL with a **known default password** (`config.ts:10-11`) | **No** — the default is accepted and the app connects if that database exists. The literal is not reproduced here on purpose |
| `redisUrl` | `redis://127.0.0.1:6379` | **No** |
| `s3AccessKeyId` / `s3SecretAccessKey` | `''` | **No, and silently** — `packages/files/src/s3/index.ts:206-209` drops **both** when either is blank, and the SDK falls back to its default credential chain. `S3_BUCKET`/`S3_REGION` *do* throw |
| SMTP credentials | unset, parsed in `packages/mail/src/smtp/index.ts:131-170` | **At boot** — `SMTP_HOST` required; `MAIL_TRANSPORT` defaults to `none` |
| — | **no session secret and no CSRF secret exist** | Sessions are stateless JWTs and CSRF is a double-submit comparison, so neither needs one |

### 4.5 `runAs` / worker principals

| Site | Principal | Record ACL re-checked at execution? |
|---|---|---|
| `reports/report.service.ts:290-303` | **real user**, re-derived from the DB | **Yes** — owner-match check, then `acl.assertAccess` / `visibleFields` / `recordPredicate` inside `runDefinition`. This is the reference pattern |
| `ai-agents/runs/executor.ts:149-153`, `runs/triggers.ts:168-174` | **real user**, re-derived per run; a missing user fails `principal_unavailable` | **Yes** |
| `customer-success-authority.ts`, `lead-score-authority.ts`, `service-desk-authority.ts`, `advanced-integrations-authority.ts`, `esignature-authority.ts`, `marketing-automation-authority.ts`, `voice-communications-authority.ts` | `system` principal carrying **`roles: ['sysAdmin']`** | **No** — `acl-api.service.ts:374` marks the snapshot as admin and `:235` returns `canAccessRecord → {allowed: true}` unconditionally |
| `service-desk/web-to-case.service.ts:98`, `marketing-automation/marketing-form.service.ts:205` | the same `sysAdmin` principal, reached from a **public, unauthenticated** request | **No** |

**F1 — confirmed, and wider than the plan states.** The plan cites `reports/report.service.ts:290-314` as the
pattern to generalise. In fact that file is already the *correct* implementation, and the gap lives in the **seven
module authority files**, whose own comments assert a guarantee the code does not deliver — e.g.
`marketing-automation-authority.ts:15-18` ("never bypasses the *record's* ACL, because the command has already
passed that check"), which is true for an admin door and false for a worker door, where there is no prior caller
check.

**Additional finding:** the worker's BPM/workflow handlers (`apps/worker/src/workflows/workflow-handlers.ts:63,88,198`)
carry a `userId` into the job but write through the worker's **own** DB access (`bpm-store.ts`, `workflow-store.ts`),
not through the API's ACL layer — so those writes are **not** ACL-checked at all.

### 4.6 A defect found in the audit: three worker doors cannot be called by the worker

`apps/worker/src/handlers/sales-handlers.ts:37,136` and `marketing-handlers.ts:25,29,68,88` post to three routes
with only the `x-worker-secret` header:

- `POST /api/v1/Sales/action/generate-subscription-invoices`
- `POST /api/v1/MarketingAutomation/action/delivery/run-scheduled-batch`
- `POST /api/v1/MarketingAutomation/action/journey/run-batch`

None of the three carries `@Public()` (`sales.controller.ts` has `@Public()` only at `:780` and `:818`;
`marketing-automation.controller.ts` only at `:627,634,641,650,657,678,818,931,949`). The global guard therefore
demands a Bearer token or a session cookie first, and the worker sends neither.

**Executed proof:** all three return **401 `AUTHENTICATION_REQUIRED`**, while the sibling `Sales/action/expire-quotes`
(which *is* `@Public()`) returns **401 `AUTHENTICATION_FAILED` / "Invalid worker capability"** — i.e. it reached the
capability check and failed there, exactly as designed.

This is an **availability** defect (three scheduled jobs cannot run), not an authorization bypass — it fails
closed. It is recorded as a new gap and routed to 23.4, because 23.4 is the sub-phase that owns the async/worker
authorization model.

---

## 5. Test-coverage baseline and false confidence

### 5.1 What the DB-free gate actually proves

`vitest.ci.config.ts` includes `packages/*/src/**/*.test.ts` plus 42 named API suites. Of those, the security-relevant
ones are `config-jwt-secret`, `error-payload-hygiene`, `request-scope`, `reports` (with a **stubbed** ACL),
`phase22-provider-contract`, `esignature-approval-policy`, `ai-agent-actor`, `ai-agent-periods`, plus the
`packages/*` glob (logger redaction, crypto-at-rest, malware/MIME, path traversal, formula sandbox, extension
manifest).

**Every API-level authorization, BOLA and injection suite is excluded**, because all of them boot the API against
the database. `apps/api/test/ai-agent-adversarial.test.ts` — the repository's **only** SSRF suite — is DB-free and
**not** in the include list, so it is an easy, deliberate win for 23.8.

Combined with the owner decision to keep CI nightly-only (D3), the consequence is: **no authorization assertion
runs in CI at all**, on any schedule.

### 5.2 False confidence — concrete weak assertions

These are the assertions that make a security test pass for the wrong reason. Each was read in the current source.

| Location | Assertion | Why it is weak |
|---|---|---|
| `phase22-security-injection.test.ts:25-26` | `expect(res.statusCode).not.toBe(500); expect(res.statusCode).not.toBe(502);` | A 200 that *executed* the payload passes. The strong sibling already exists: `entity-crud.test.ts:266-269` asserts `toBe(400)` |
| `phase22-security-injection.test.ts:36-37` | same | same |
| `phase22-security-injection.test.ts:48-58` | `expect(String(body['description'])).toContain(payload)` | Proves the payload round-trips as **data**, not that any renderer escapes it. The test name says "without executing it" — no browser context exists |
| `phase22-security-regression.test.ts:111` | `expect(read.statusCode).not.toBe(200);` | A 500 satisfies it. The comment promises "no record body leaked" but there is **no body assertion** |
| `phase22-security-regression.test.ts:121` | `expect(write.statusCode).not.toBe(200);` | The payload is `name: 'Hacked'` and the record is **never re-read** — the write is not proved to have had no effect |
| `crm-chat-security.test.ts:167` | `expect([403, 404]).toContain(result.status);` | Asserted against a **non-existent** id (`fake-id-123`), so a 404 is returned even with ownership checks removed |
| `crm-chat-security.test.ts:216` | `expect([200, 201, 400, 403]).toContain(result.status);` | Includes the success statuses — tautological |
| `crm-chat-security.test.ts:259` | `expect([200, 400, 422]).toContain(result.status);` | The comment admits it may still succeed; the assertion includes 200 |
| `crm-chat-security.test.ts:397` | `expect(statuses.some((s) => [200, 201, 400, 403, 422, 429].includes(s))).toBe(true);` | Vacuously true for every status the API can return |
| `crm-chat-security.test.ts:430-439` | assertion **inside** `if (result.status === 404 …)` | A 500 skips the check silently |
| `service-desk-security.test.ts:76-77` | `toBeGreaterThanOrEqual(400)` | A 500 reads as a security refusal |
| `service-desk-security.test.ts:109-112` | "SLA checkBreaches **requires no auth**" — but the request **sends the admin token** and asserts 200 | The named behaviour is not exercised at all |
| `service-desk-portal.test.ts:152` | `toBeGreaterThanOrEqual(400)` | The portal-forgery property is not pinned to a code, and the stored `visibility` is not re-read |
| `marketing-automation.test.ts:304-312, 746-751` | `toBeGreaterThanOrEqual(400)` | "A stranger cannot read/schedule" accepts any 4xx **or 5xx** |
| `marketing-automation-provider.test.ts` (8 occurrences) | `toBeGreaterThanOrEqual(400)` | Every provider gate is unpinned |
| `ai-agent-triggers.test.ts:253,611` | `expect([401, 403]).toContain(res.status);` | No persisted-state assertion — nothing proves no run was started |
| `auth.test.ts:132` | `expect([200, 201]).toContain(out.statusCode);` | "logout revokes the session" asserts the **logout status**; the revoked token is never reused |
| `two-factor.test.ts:72-90` | test named "completes the challenge with a valid TOTP code" — the body uses `recoveryCodes[0]` | The TOTP path is **never** exercised |
| `reports.test.ts:26` | `assertAccess: vi.fn().mockResolvedValue('all')` | The whole report suite stubs the ACL, so the field-ACL test proves the *service* calls `visibleFields`, not that the real ACL denies the field |
| `advanced-integrations-admin.test.ts:455,495,512` | `if (first === undefined) return;` | A missing precondition makes the test **pass with zero assertions** |

### 5.3 Coverage gaps by surface × role

Roles: owner, team, unrelated, admin, API user, portal user, anonymous.

| Surface | owner | team | unrelated | admin | API user | portal | anonymous |
|---|---|---|---|---|---|---|---|
| Entity CRUD / bulk | ✅ | ✅ | ✅ | ✅ | ❌ | ◐ | ✅ |
| Attachments / media / exports / audit history | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | ◐ (upload only) |
| Search / reports / dashboards / CSV | ❌ | ❌ | ❌ | ✅ (admin-only suite) | ❌ | ❌ | ❌ |
| Login / 2FA / reset / sessions / API keys | ◐ | ❌ | ❌ | ✅ | ✅ | ❌ | ✅ |
| OAuth / OIDC callbacks | — | — | — | ✅ | ❌ | — | ✅ |
| Provider webhooks | — | — | — | ✅ | — | — | ✅ |
| Worker jobs / outbox / AI agents / CRM chat tools | ✅ | ❌ | ✅ | ✅ | ❌ | ❌ | ✅ |
| Portal + omnichannel | ❌ | ❌ | ✅ | ✅ | ❌ | ✅ | ✅ |
| Templates / formula / extensions | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ |
| Logs / errors / traces / artifacts / backups | — | — | — | ✅ | — | — | — |

The **API-user** role appears on exactly **one** surface (its own authentication). There is **no** attachment IDoA
test: `attachments.test.ts` covers upload validation and *delete* authorization, never a foreign-user download.
CSV import/export, global search and dashboards are exercised **only** as admin.

---

## 6. Owner decisions (plan §0.3)

The four decisions the owner answered, plus the two answered by the plan's documented default.

| # | Decision | **Answer** | Consequence |
|---|---|---|---|
| **D1** | Is generic OIDC in scope for Phase 23, or formally deferred? | **In scope for 23.3.** SAML, SCIM and enterprise directory sync are explicitly deferred with a written rationale | 23.3 gains a generic authorization-code + PKCE adapter behind a provider interface, with a fake provider in tests. Google/Microsoft are configuration profiles, not provider-specific code |
| **D2** | Is multi-tenancy a Phase 23 deliverable? | **No — document only.** Phase 23 records the single-tenant boundary, why §48 "Tenant isolation" is unmet by design, and the trigger for a separate tenant-isolation phase | 23.9 task 5 is a documentation task. The §48 control is marked *Not applicable by decision* in the controls matrix |
| **D3** | Is PR-gated CI approved, replacing the 22.22 nightly-only decision (and closing G78)? | **No — keep nightly-only** | G78 stays open as a live exception. **23.8 changes shape:** it no longer converts the workflow to a PR gate. What remains for 23.8: add the DB-free security suites (notably `ai-agent-adversarial.test.ts`) to `vitest.ci.config.ts` so the nightly gate covers SSRF, keep the nightly DB-free gate green, and add security telemetry. The "prove the gate blocks a regression" task becomes "prove the nightly gate detects a deliberately failing security assertion". The release gate in 23.11 must therefore read *"the required (nightly) DB-free gate passes"*, not *"required PR gates pass"* — the plan's §17 wording is updated accordingly |
| **D4** | Are the recovery environment and RPO/RTO approved for the restore drill (G80, 23.9)? | **No — 23.9 is Blocked** | 23.9 records G80 as **Blocked** from the start, with the missing approval named. `scripts/restore-drill.mjs` stays as shipped tooling. **No database is created to work around this** (`AGENTS.MD` §3.6). G81's installation steps stay owner-owned |
| **D5** | Who owns the clean-room/AGPL distribution compliance review and the repository `LICENSE`? | **Unanswered → plan default applies:** recorded as a release blocker; **no distribution claim is made** | The missing `LICENSE` stays an explicit release blocker in 23.9/23.11. The coding agent does not create a licence file or make a legal claim |
| **D6** | Which open findings are accepted, with mitigation and review date? | **Unanswered → plan default applies:** **none accepted by default**; all P0 findings remain **Open** | Every P0 finding stays open until an owner signs it. The exception register carries mitigations and review dates but records no agent-made acceptance. `High`/`Critical` rows await explicit owner acceptance |

---

## 7. New findings raised by Phase 23.0

New IDs continue from **G83** in `docs/quality/known-gaps.md`. One ID (`G85`) was assigned during this audit and
then **withdrawn** as a duplicate of **G33** — the marketing webhook is one finding, so it keeps one ID. The
sequence is not renumbered, so it carries one deliberate gap.

| ID | Finding | Severity | Target |
|---|---|---|---|
| G83 | Three worker doors are unreachable by the worker — `Sales/action/generate-subscription-invoices`, `MarketingAutomation/action/delivery/run-scheduled-batch`, `MarketingAutomation/action/journey/run-batch` lack `@Public()`, so the global guard answers 401 before the capability check (reproduced 2026-11-09) | Medium (availability; fails closed) | 23.4 |
| G84 | The OAuth callback **never compares a redirect URI**, although its own comment says it does. The strict callback schema rejects `redirect_uri` outright, so the provider's echoed value is never read; the exchange sends the platform constant (the safe direction, but the code comment is false) | Medium | 23.3 |
| G86 | Four independent SSRF validators exist (`ai-provider-url.ts`, `media-url.ts`, `provider-http-client.ts`, `modules/webhook-integration/src/shared.ts`) and `voice-media.service.ts:167` is the only outbound fetch that **follows redirects**, so an allowlisted host can redirect to a private address | Medium | 23.5 |
| G87 | `s3AccessKeyId` / `s3SecretAccessKey` are silently **dropped** when only one is set, and the SDK falls back to its default credential chain — a half-configured object store does not fail closed | Low | 23.1 / 23.6 |
| G88 | Every module system principal carries `roles: ['sysAdmin']`, so `AclApiService.canAccessRecord` returns `allowed: true` unconditionally for every worker and every public-intake write; the authority files' comments assert the opposite (this is the concrete shape of F1) | Medium | 23.4 |
| G89 | The worker's BPM/workflow handlers write CRM records through the worker's own DB access, bypassing the API's ACL layer entirely; the `userId` carried in the job is never re-checked | Medium | 23.4 |
| G90 | `GET /api/v1/OpenApi` is served without authentication and exposes the platform's complete route surface (772 paths, including admin, worker and webhook paths) | Low | 23.5 |
| G91 | `GET /health/ready` returns database reachability to an anonymous caller | Low | 23.8 |
| G92 | The DB-free CI lane contains **no** API authorization assertion, and `apps/api/test/ai-agent-adversarial.test.ts` — the only SSRF suite — is DB-free but not in the include list | Medium | 23.8 |
| G93 | `docs/quality/phase-22-security-privacy-regression-suite.md` §7/§9 drifted from `known-gaps.md` after the 2026-11-03 fixes, and its §8 acceptance claim ("all remaining open findings are dispositioned in §9") was false | Low | 23.0 (closed here) |
| G94 | `POST /api/v1/Refresh` is `@Public()` and cookie-driven with no CSRF check, and `AuthGuard` returns `true` for `@Public()` before any CSRF comparison — a cross-site top-level POST can rotate a session | Medium | 23.1 |

---

## 8. Recommended implementation order

Reordered from the plan's §5 by **observed** risk rather than the plan's original sequence. Each item names its
sub-phase and the evidence that justifies its position.

| # | Item | Why first | Sub-phase |
|---|---|---|---|
| 1 | **CORS fails closed** (contradiction C6) | Reflected origin + credentials, no `.env.example` prompt, exploitable from a same-site sibling. A configuration change with a large blast radius and no code migration | 23.1 |
| 2 | **CSRF contract, end to end** (G94) — CSPRNG, constant-time compare, session binding, `@Public()` refresh route, `Origin`/`Sec-Fetch-Site` check | The gap is a whole contract, not one line; the SPA is bearer-first, so the fix can be made without breaking the shipped client | 23.1 |
| 3 | **API-key constant-time compare** (C4) | One line of code plus a wrong sentence in `authorization-matrix.md` | 23.1 |
| 4 | **OpenAPI contract** (C1, G90) | The document exists but says nothing; it is the precondition for contract-testing 23.4/23.5 and for a machine-checked API surface | 23.5 (with 23.1 CSP) |
| 5 | **Login throttling, self-service reset, enforceable MFA** | PLAN §17/§48 items with **zero** implementation today; brute-force and account-takeover exposure is the highest-impact missing control | 23.2 |
| 6 | **Async principal model** (F1, G88, G89) | Seven module authorities plus the worker's direct-DB writers bypass record ACL. This is the largest *authorization* surface left and it is systemic | 23.4 |
| 7 | **Worker doors that cannot be called** (G83) | Same sub-phase as #6; three scheduled jobs are dead today | 23.4 |
| 8 | **Webhook authenticity** (G33) | The marketing path is the only provider webhook that does not verify a signature over the body | 23.5 |
| 9 | **One SSRF helper** (G86) | Four validators, one redirect-following fetch; consolidating removes a class of drift | 23.5 |
| 10 | **CI lane coverage** (G92) | Adding `ai-agent-adversarial.test.ts` and the remaining DB-free security suites to the nightly gate is cheap and immediately widens what CI proves — even without a PR trigger | 23.8 |
| 11 | **Backup installation, restore drill, runbook** (G80, G81) | Blocked on owner approval (D4); the code and the templates are shipped, so the remaining work is deployment + approval, not development | 23.9 |

**Sequencing note:** #1–#4 (23.1) and #5 (23.2) are independent of each other and of the 23.4 work. #6/#7 must land
before 23.5's adversarial suite, because the adversarial suite needs the async model to be honest first.

---

## 9. Definition-of-done status for Phase 23.0

| Acceptance criterion | Status |
|---|---|
| Every control and finding has a source path, a test/command reference, a label, a severity and an owner | **Met** — §2, §4 and `docs/security/security-controls-matrix.md` |
| All seven §2.3 contradictions have an explicit resolution or a documented hypothesis | **Met** — §3, all seven resolved with evidence (C5 and C6 additionally by execution) |
| No business data was modified; no code, configuration or CI file changed during the audit | **Met** — documentation only; the API and the database were read-only except for test-owned records |
| Owner decisions are recorded; the next sub-phase starts only after review | **Met** — §6; **23.1 awaits review** |

**Honest limitations of this baseline:**

- The browser/e2e layer was **not** run (no Playwright browser in this environment). G66 (browser error/denial/empty
  states) therefore stays **unverified**, not "closed".
- The restore drill was **not** run (G80 blocked — D4), so no recovery claim is made.
- No live-provider or sandbox-provider evidence was gathered; every provider claim is from fake adapters and
  source reading.
- `pnpm verify` (the DB-backed full gate) was **not** run as a single command; the DB-free gate passed in full and
  the DB-backed suites were run file-by-file. The known G69/G75/G79 shared-database flakes remain a reason the
  DB-free gate is the stable required gate.
- The G83 worker-door defect was found by reading the route decorators and **reproduced by execution**; the other
  new findings (G84–G91) are reproduced statically and are labelled as such until their sub-phase writes the
  regression test.
