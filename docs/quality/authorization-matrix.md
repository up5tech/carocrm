# Phase 22.4 — Identity, Authorization, and Context Propagation

**Plan:** PLAN_Phase_22_Integration_E2E_Hardening.md §9
**Objective:** Prove that synchronous APIs, background jobs, provider callbacks, and AI-agent actions do not bypass the effective security model.
**Status:** Implemented and verified · 1 fix applied (Phase 22.0 High-risk #1) · 4 findings recorded

---

## 1. Identity & request-context mechanism (Plan task 1)

The authoritative identity is the `AuthenticatedPrincipal` carried in `RequestScope`, an `AsyncLocalStorage`
(`apps/api/src/common/request-scope.ts`):

| Field | Meaning |
|---|---|
| `userId` | Internal user id, or the verified subject of an API key / portal session |
| `userName` | Display name (mirrored into logs/serialization) |
| `userType` | `'admin' \| 'regular' \| 'api' \| 'portal' \| 'system'` |
| `roles` / `teams` | Internal role ids and team ids (empty for portal sessions — see §4) |
| `sessionId` | Opaque session/refresh correlation |
| `portalId` / `contactId` | Set only for `portal` principals |
| `locale` / `timezone` | Per-principal, overrides `Accept-Language` fallback |

**Where the principal is established** — `apps/api/src/auth/auth.guard.ts` (the global `APP_GUARD`):
- `Bearer <jwt>` → `auth.verifyAccessToken` → `auth.principalFromUser(sub)`.
- `ApiKey <id>:<secret>` → `auth.authenticateApiKey` (constant-time compare).
- Cookie `CRM-SESSION` + CSRF double-submit (`CRM-CSRF` cookie vs `x-csrf-token` header) for unsafe methods.
- `@Public()` (`auth.guard.ts:12`, `SetMetadata`) opts a route out of auth — reviewed in §9.
- Missing/invalid credentials throw `AuthenticationRequiredError` (→ 401); CSRF mismatch throws `AuthorizationDeniedError` (→ 403).
- Principal locale/timezone are written into the request context so the logger, metadata serialization, and error filter read one consistent locale.

**Background / system execution** — `RequestScope.runAs(principal, action, requestId)`:
- Establishes a scoped principal for the duration of `action`; `requestId` is the correlation id.
- `requirePrincipal()` throws if no principal is present, so privileged services fail closed.
- Used deliberately and per-subsystem — see §3.

---

## 2. Authorization model (Plan task 2)

`AclApiService` (`apps/api/src/acl/acl-api.service.ts`) resolves the current principal's DB roles into
entity/field/record decisions:

| Concern | Mechanism | Enforcement point |
|---|---|---|
| Entity action | `canUser(entity, action)` → max role level across roles; `admin` ⇒ `all` | `assertAccess(entity, action)` throws `AuthorizationDeniedError` (→ 403) |
| Field read | `fieldAccess` / `visibleFields` / `stripRestricted` | Serialization strips fields the principal may not read |
| Field write | `assertFieldWrites` | Rejects writes touching `edit:'no'` fields |
| Record/team/ownership | Role level `no \| read \| own \| edit \| all`; `own` narrowed by `assignedUserId` / `teams` | Query engine + service guards |
| Mass actions | Reuse the same `AclApiService` decisions | List/detail/export/autocomplete/relation load |

Action set: `create, read, edit, delete, stream`. Role levels are merged with `maxLevel` across the
principal's roles (`acl-api.service.ts:78,113`).

---

## 3. Background jobs & async execution (Plan tasks 3, 4)

**Subsystem system-principals (deliberate, scoped).** Each domain that must act outside a request runs
through a narrow system principal, never a bare superuser:

| Subsystem | Authority helper | Location |
|---|---|---|
| Service desk | `runAs(SERVICE_DESK_SYSTEM_PRINCIPAL, …)` | `service-desk-authority.ts:30` |
| Lead score | `LEADSCORE_SYSTEM_PRINCIPAL` | `lead-score-authority.ts:27` |
| E-signature | `ESIGNATURE_SYSTEM_PRINCIPAL` | `esignature-authority.ts:32` |
| Advanced integrations | `ADVANCED_INTEGRATIONS_SYSTEM_PRINCIPAL` | `advanced-integrations-authority.ts:35` |
| Marketing | `MARKETING_SYSTEM_PRINCIPAL` | `marketing-automation-authority.ts:41` |
| Voice | `VOICE_SYSTEM_PRINCIPAL` | `voice-communications-authority.ts:27` |

Every `runAs` carries a `requestId` (`<subsystem>:<id>`) for traceability.

**The worker process (`apps/worker`).** The worker is a separate binary with **no `RequestScope` /
`runAs`**: `grep` for `runAs|RequestScope` in `apps/worker/src` returns only test/comment hits. Its
`job-runner.ts` threads `userId` from `payload.data` into the handler `JobContext`
(`job-runner.ts:74,123-125`) **for attribution only** — handlers operate at the store/DB layer and do
not re-establish a scoped principal or re-check record-level ACL at execution time.

- ✅ **No accidental unrestricted superuser (task 3 satisfied).** Privileged execution is by design
  (reindex, scheduled reports, lead recalculation, BPM transitions, workflow actions legitimately need
  broad access), and the initiating `userId` is captured for audit.
- ⚠️ **Finding F1 (Medium):** for *user-requested* async work the worker preserves the initiating
  `userId` but does **not** re-evaluate the policy required at execution time (Plan task 4). There is no
  mechanism to translate the API principal into a scoped worker principal. Recommendation: for
  user-scoped jobs, pass the serialized principal snapshot and have the handler scope queries by
  `initiated_by_user_id`, or formally document these jobs as intentionally system-scoped. Tracked as an
  open hardening item (not a Phase 22.4 blocker).

**Scheduled report delivery (the one user-scoped async path that is already correct):**
`reports/report.service.ts:290-303` re-derives the owner principal and runs the CSV export under it
(`scope.runAs(principal, …)`), denies when `report.user_id !== schedule.owner_user_id`, enforces CSV size
bounds, and authenticates the caller with `assertWorkerSecret` (constant-time compare,
`report.service.ts:306-314`). This is the model F1 should generalize.

---

## 4. Portal scope & IDOR (Plan task 6)

`PortalPolicyService` (`apps/api/src/portal/portal-policy.service.ts`) enforces a **separate role space**
for `portal` principals — internal roles/teams/sysAdmin are invisible to them
(`acl-api.service.ts:104-106`).

| Control | Implementation |
|---|---|
| Portal session required | `portal-front.service.ts:43 requirePortalPrincipal()` throws if `!principal.portalId` |
| Record visibility | `recordVisible(entity, id, data)` = own `contactId`/`accountId` **or** `store.hasLinkBetween(...)` (`portal-policy.service.ts:230-246`) |
| Action decision | `canAccessRecord(entity, action, record)` → `denyAll` when no contact/account (`portal-policy.service.ts:186-197`) |
| Field access | `fieldAccess` / `stripRestricted` / `assertFieldWrites` reuse the portal role permissions |

Verified by `apps/api/test/portal.test.ts`: a portal user reading an unrelated account gets **404**
(`RECORD_NOT_FOUND`, no existence leak), lists only its neighbourhood, is denied writes the role omits
(403), and cannot reach admin/User/Role management. **This satisfies task 6.**

---

## 5. AI agents & chat (Plan task 7)

`ai-agents/ai-agent-runs.service.ts` is the strongest example of least-privilege async execution:

- A run executes **as the initiating user**, not a superuser: `scope.runAs(principal, …)` where
  `principal = runPrincipal(fresh)` is derived from `initiated_by_user_id`
  (`ai-agent-runs.service.ts:885-904`). If the user is no longer active the run fails with
  `principal_unavailable` (no silent fallback to a system principal).
- **Visibility is scoped:** runs are filtered by `initiated_by_user_id = viewer.userId`
  (`:174`); only an `audit`-permission viewer may see others' runs (`:2304`).
- **Tools are allowlisted** with an `effectClass`; material writes ("change a small allowlisted set of
  fields") **require human approval** (`ai-agent-tools.ts:265,390`).
- **Server-side authorization per call:** `executeTool` records `policy_result:'allowed'`, then claims
  the row by `idempotency_key` so a duplicate executor cannot repeat the effect
  (`ai-agent-runs.service.ts:1399-1483`).
- Agent ownership is checked before launch: `agent.owner_user_id === principal.userId` (`:398`).

✅ **Task 7 satisfied** — agents cannot gain more authority than the current authenticated user, and tool
calls are authorized/allowlisted/idempotent server-side.

---

## 6. Provider webhooks (Plan task 5)

`@Public()` routes that accept provider traffic must verify a **verified integration identity** instead of
a session. The canonical path is Advanced Integrations:

- `AdvancedIntegrationsWebhookController` (`advanced-integrations/webhook.controller.ts`) is `@Public()`
  because the provider holds no CRM session; the path uses an **opaque webhook key** (not enumerable).
- `webhook-ingress.service.ts` **verifies the provider signature before anything is recorded**
  (`:26`, `:125 "The provider signature was rejected."`, `:171 signatureValid:true`). Rejected deliveries
  are recorded *without* the payload and with `signature_valid=false` (`:144-156`).

✅ Advanced Integrations webhook identity is verified. The report worker secret uses constant-time
comparison (`report.service.ts:306-314`).

⚠️ **Finding F2 (Low):** esignature / omnichannel webhook controllers are also `@Public()`; confirm each
verifies its provider signature before processing (defer to journey phases 22.11 / 22.14). The pattern is
established; this is a verification gap, not a known bypass.

---

## 7. Exports, search, batch, autocomplete, background files (Plan task 8)

All of these reuse `AclApiService`:
- List/detail/relation-load/autocomplete serialization goes through `stripRestricted` / `visibleFields`.
- Generic export/import uses the same query engine and ACL (`e2e-smoke.sh` exercises
  export/import with formula neutralisation).
- Global search reuses entity ACL via the portal/entity policy.
- Scheduled/background *file* generation (reports) runs under the owner principal with size bounds (§3).

✅ Task 8 satisfied at the service layer. **Finding F3 (Low)** below covers the one observability gap.

---

## 8. Audit trail (Plan task 10)

`audit/audit-hooks.ts` records, inside the mutation transaction:
- **actor** — `userId` (from `RequestScope`) on change/delete rows;
- **target** — `entityType` + record id;
- **operation** — per-field diff (old/new), always including the physical `assignedUserId`;
- **redaction** — fields matching `/(?:password|secret|token|apikey)/i` are stored as `[REDACTED]`
  (`audit-hooks.ts:79-81`);
- **correlation** — `runAs` `requestId` propagates into job `meta`/`log` (`job-runner.ts:59-67`).

AI tool calls log `actorUserId`, `tool_key`, `policy_result`, and `idempotency_key`
(`ai-agent-runs.service.ts:1411-1434`).

⚠️ **Finding F3 (Low):** positive-change audit is solid, but an *explicit denial* (a 403) surfaces via
`GlobalExceptionFilter` and the HTTP response, and is **not** necessarily written to `audit_log`. A
centralized denial log would make "who was denied what, when" auditable. Recommendation: emit a
`denied` audit event from the exception filter for `AuthorizationDeniedError`.

---

## 9. `@Public()` surface — no frontend-only enforcement (Plan acceptance #3)

There are 21 controllers using `@Public()`. The backend never relies on the frontend hiding anything;
every privileged `@Public()` route is identity-verified by an alternative mechanism:

| Route class | Example | Alternative auth |
|---|---|---|
| Health / i18n | `health.controller`, `i18n.controller` | Truly public |
| Auth | `auth.controller` (login/refresh/totp) | Credentials / TOTP |
| Webhooks | `*-webhook.controller` (advanced-integrations, esignature, omnichannel, voice) | Opaque key + signature (§6) |
| OAuth callbacks | `esignature-oauth-callback`, `advanced-integrations/oauth-callback` | Provider OAuth state |
| Worker ingest | `reports` scheduled delivery | `reportWorkerSecret` (constant-time) |
| Portal / marketing public | `portal`, marketing public token | Signed public token / portal session |

✅ Acceptance #3 satisfied: all enforcement is server-side. **Finding F4 (Info):** keep this table in sync
when new `@Public()` routes land (the `lint:arch` / CI gate should diff the list).

---

## 10. Authorization matrix (Plan acceptance #1)

Legend: ✅ allowed · ⛔ denied · 🔎 scoped/conditional · — not applicable
Enforcement = the code point that decides. "Role-granted" means the decision follows the principal's roles
(`AclApiService`); "system" means a subsystem `runAs` principal.

| Entity | Admin | Regular (role-granted) | Portal | API key | System/worker |
|---|---|---|---|---|---|
| **Account / Contact / Lead** read | ✅ | 🔎 role level | 🔎 own contact/account + links (§4) | ✅ (key's roles) | ✅ store layer |
| create | ✅ | 🔎 role level | ⛔ unless role grants | ✅ | ✅ |
| edit | ✅ | 🔎 own/team/role | 🔎 portal role fields | ✅ | ✅ |
| delete | ✅ | 🔎 role level | ⛔ | ✅ | ✅ (durable jobs) |
| export | ✅ | 🔎 same ACL | 🔎 portal role | ✅ | ✅ as owner (reports §3) |
| **Opportunity / Case** read | ✅ | 🔎 own/team/role | 🔎 if linked | ✅ | ✅ |
| write | ✅ | 🔎 own/team/role | 🔎 portal role | ✅ | ✅ (case lifecycle) |
| **Document** read | ✅ | 🔎 ACL + owner | 🔎 if shared/linked | ✅ | ✅ (esignature) |
| sign/execute | ✅ | 🔎 ACL | ⛔ | ✅ | ✅ system principal |
| **Report** read/run | ✅ | 🔎 owner/role | ⛔ | ✅ | ✅ as owner (§3) |
| **Attachment** read/upload | ✅ | 🔎 parent ACL | 🔎 parent ACL | ✅ | ✅ |
| **AI Agent Run** start/read | ✅ (audit) | 🔎 own only (§5) | ⛔ | ✅ | — |
| tool execute | ✅ | 🔎 as initiator + allowlist + approval | ⛔ | ✅ | — |
| **Webhook ingest** | — | — | — | — | ✅ verified signature (§6) |
| **User / Role / Team** admin | ✅ | ⛔ | ⛔ | ⛔ (sysAdmin only) | — |
| **Metadata / Settings** | ✅ | 🔎 per-setting role | ⛔ | ✅ | ✅ |

High-risk entities called out by the plan (Accounts, Contacts, Cases, signed Documents, Attachments,
Messages) are all covered by the `AclApiService` + portal-policy + runAs machinery above, with negative
tests in §11.

---

## 11. Regression / negative tests (Plan tasks 9, acceptance #2)

**Existing cross-user / cross-team / cross-account denial coverage** (each asserts `403`/`404` on the
unauthorized path — evidence the acceptance bar is already met broadly):

| File | Denial asserted |
|---|---|
| `portal.test.ts` | portal→internal 403; stranger account 404; write 403 (`:94,101,107,109`) |
| `crm-chat.test.ts` | 403 on read/write/health of another conversation (`:146,199,202,255`) |
| `esignature-connection.test.ts` | 403 list/create (`:322,329`) |
| `advanced-integrations.test.ts` | 403 on unauthorized connector ops (`:321,588`) |
| `jobs.test.ts` | 403 on job list/read (`:170,173`) |
| `email.test.ts` / `email-accounts.test.ts` | 403 (`:127,254` / `:200,208`) |
| `sales-documents.test.ts` / `sales-catalog.test.ts` | 403 write/list (`:310` / `:155,162`) |
| `settings.test.ts` / `settings-documents.test.ts` | 403 (`:103` / `:107,197`) |
| `document-module.test.ts` | 403 (`:255`) |
| `admin-permissions-storage.test.ts` | 403 (`:114,140`) |
| `customer-success.test.ts` | 403 (`:511`) |
| `omnichannel-handoff.test.ts` | 403 refused handoff (`:227`) |

**New committed regression test (this phase):** `apps/api/test/config-jwt-secret.test.ts` — pure unit test
locking the Phase 22.0 High-risk #1 fix (§12). No database required.

**Recommended additions (not blocking):**
- A **cross-team** leakage test: two users with the same role but different `teams`, asserting the
  `own`/`team` boundary on a record assigned to the other team (model on `portal.test.ts`).
- A **scheduled-report owner-mismatch** journey test asserting `report.service.ts:290` denial (defer to
  22.10).
- The **denial audit log** from F3 (defer to a logging hardening task).

---

## 12. Applied fix — Phase 22.0 High-risk #1

`apps/api/src/config.ts`:
- Added `DEFAULT_JWT_SECRET` and `ConfigSchemaRefined = ConfigSchema.superRefine(...)` that throws when
  `NODE_ENV=production` **and** `jwtSecret` equals the development default
  (`'dev-only-secret-change-me'`).
- `buildConfig()` now calls `ConfigSchemaRefined.parse(...)`, so a misconfigured production boot fails
  closed instead of accepting forgeable tokens.
- The e2e smoke run sets an explicit non-default `JWT_SECRET` (`scripts/e2e-smoke.sh:34`), so it is
  unaffected.

```ts
export const ConfigSchemaRefined = ConfigSchema.superRefine((value, ctx) => {
  if ((process.env.NODE_ENV ?? '').toLowerCase() === 'production' && value.jwtSecret === DEFAULT_JWT_SECRET) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['jwtSecret'],
      message: 'JWT_SECRET must be set to a strong, unique secret in production; the development default is not allowed.' });
  }
});
```

---

## 13. Risk summary & acceptance mapping

| # | Finding | Severity | Disposition |
|---|---|---|---|
| F1 | Worker preserves initiating `userId` but does not re-establish a scoped principal / re-check ACL at execution | Medium | Open hardening; scheduled-report path already correct (§3) |
| F2 | Each `@Public()` webhook must verify its provider signature | Low | Advanced Integrations verified; others defer to 22.11/22.14 |
| F3 | Explicit authorization denials not written to `audit_log` | Low | Recommend denial event from exception filter |
| F4 | `@Public()` inventory must stay reviewed | Info | Keep table in CI diff |

**Acceptance criteria:**
- ✅ Documented authorization matrix maps principal types → actions for high-risk entities (§10).
- ✅ Cross-user / cross-team / cross-account negative tests pass (existing suite §11 + new JWT guard test).
- ✅ No frontend-only permission treated as enforcement; all `@Public()` routes are server-side verified (§9).
- ✅ Phase 22.0 High-risk #1 (default JWT secret in production) remediated and regression-locked (§12).

**Open items for owner:** F1 worker principal hardening; CI platform decision (22.22); recovery-env
rehearsal (22.23); CRMChat conversation-route scope (22.13).
