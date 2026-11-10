# Phase 23 Security Test Evidence

> **Date:** 2026-11-10
> **Sub-phase:** 23.2 — Authentication Hardening (tasks 1–2 delivered)
> **Plan:** `plans/PLAN_Phase_23_Security_Hardening.md` §8
> **Baseline:** `docs/security/phase-23-security-baseline.md`

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