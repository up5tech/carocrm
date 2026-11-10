# Phase 23 Security Test Evidence

> **Date:** 2026-11-10
> **Sub-phase:** 23.2 — Authentication Hardening (tasks 1–6 delivered)
> **Plan:** `plans/PLAN_Phase_23_Security_Hardening.md` §8
> **Baseline:** `docs/security/phase-23-security-baseline.md`

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