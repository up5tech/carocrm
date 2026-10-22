# Phase 19-ES.1 — Module registration and security contract

> `PLAN_Phase_19_ESignature.md` §18 `Phase 19-ES.1`.
> Acceptance: the module appears only for authorized users; no provider operation is possible before
> a connection is enabled; naming is `ESignature` / `esignature` / `ESignatureModule` with no `Ua`
> prefix. **No migration and no test database** (`AGENTS.md` §3), and no provider call.
>
> Prerequisite: `docs/implementation/esignature-audit.md` (19-ES.0). Provider facts:
> `docs/compatibility/esignature.md`.

ES.1 registers the module and declares the contract every later sub-phase is measured against. It
ships no schema, no adapter and no request surface; it ships the identity, the permission matrix, the
settings document, the one gate that stands in front of every provider call, the translations, and a
page that tells an operator why nothing can be sent yet.

---

## 1. Files

| File | What it owns |
| --- | --- |
| `apps/api/src/esignature/esignature-domain.ts` | Names: the synthetic ACL resources, the connection states and environments, the 14 normalized request states (plan §4.7) with terminality, recipient types, the three vault secret kinds, the 31 append-only audit actions (plan §6.6). |
| `apps/api/src/esignature/esignature-module.ts` | The module descriptor: 11 capabilities mapped 1:1 onto plan §12's permission list, the settings key and shape version, 9 feature flags with their settings paths and `requires` chains, `PENDING_FEATURES` with the phase that delivers each, the evidenced `REQUIRED_CAPABILITIES`, the 8 optional modules detected by marker (never an import), the 15 provider capability flags for `docusign`, the 11 stable error codes, the event and job names, the 8 planned tables. |
| `apps/api/src/esignature/esignature-permission.service.ts` | The only place a route asks about a capability: `level`/`can`/`assert`/`describe`/`capabilities` over `AclApiService`, with a non-revealing 403. |
| `apps/api/src/esignature/esignature-settings.service.ts` | The one `app_settings` row named `ESignature`: a strict Zod document, defaults, advisory warnings, `effective` flags (enabled **and** implemented **and** requirements met), the versioned write path, and the refusal of any secret-shaped value. |
| `apps/api/src/esignature/esignature-connection-gate.service.ts` | The gate: capability → module switch → effective feature → provider capability → connections → `ENCRYPTION_KEY` → an enabled connection. `OPERATION_RULES` is the matrix; `assessment()` reports the same decision without side effects. |
| `apps/api/src/esignature/esignature-errors.ts` | `ESignatureError extends AppError` for stable API codes; the provider taxonomy is **reused** from `advanced-integrations/provider-error.ts`, with `unknown_outcome` recorded as ES.3's addition rather than smuggled in now. |
| `apps/api/src/esignature/esignature-module-health.service.ts` | Health read from the running system: metadata registry, `information_schema`, the hook registry, the settings row and the gate. No hard-coded `true`, no secret. |
| `apps/api/src/esignature/esignature-navigation.service.ts` | The visibility report (`visible`/`admin`/`enabled`/`ready`/`reason`). A report, not a gate. |
| `apps/api/src/esignature/esignature.controller.ts` | `/api/v1/ESignature/action/{health,capabilities,nav,settings,gate/check,gate/operations}`. Settings read and write both require `connectionManage`. |
| `apps/api/src/esignature/dto/esignature-shapes.ts` | Strict request shapes; none can carry a credential. |
| `apps/api/src/esignature/index.ts` | The barrel: `ESIGNATURE_CONTROLLERS`, `ESIGNATURE_PROVIDERS`, the public contract surface. |
| `apps/api/src/app.module.ts` | The two spreads (controller before `ENTITY_CONTROLLERS`) and the `eSignature/enabled` branch of `NAVIGATION_FEATURE_GATE`. |
| `apps/api/src/admin-panel/navigation-defaults.ts` | The `esignature` page entry: `permission: SignatureRequest:read` **and** `feature: eSignature/enabled`. |
| `apps/api/src/admin-panel/admin-panel.service.ts` | The `integrations › E-Signature` admin tab (`moduleEndpoint: 'ESignature'`). |
| `i18n/en/esignature.json`, `i18n/vi/esignature.json` | The module catalog: labels, nav, page states and gate reasons, features, settings, capabilities, provider capabilities. |
| `i18n/{en,vi}/errors.json` | The 11 stable error codes, translated. |
| `apps/web/src/pages/ESignaturePage.tsx` | The module page: what is switched on, why the gate is closed, the caller's rights, the provider's declared capabilities. |
| `apps/web/src/admin/tabs/ESignatureSettingsTab.tsx` | The admin screen: the module switch, the 9 feature rows with their pending phase, integration keys, document ceilings, signing policy, Connect policy, retention, approval policy. |
| `apps/web/src/AppRoutes.tsx`, `apps/web/src/admin/tabs.ts`, `apps/web/src/api/{client,types}.ts` | Route, tab registration and the typed API surface. |
| `apps/api/test/esignature.test.ts` | 19 tests, listed in §4. |

---

## 2. Decisions taken in this phase

**The permission matrix is the plan's list, not a coarser one.** Plan §12 names twelve permissions;
they collapse to eleven capabilities because `request.read` and the module's own `use` are the same
right, and each keeps its own synthetic ACL resource. `send` is deliberately separate from
`manageDraft`: preparation is a draft edit, sending is a deliberate external legal act, and a
deployment must be able to give them to different people (§11.1). No role is created — `sysAdmin`
holds the wildcard and every capability, the default user role holds `{}` and none, which is what
makes "appears only for authorized users" an ACL fact rather than a filter.

**The module switch lives in the settings document, and the navigation gate reads it.** Plan §18 asks
for a module that "is disabled cleanly when unconfigured". `enabled: false` (the default) drops the
sidebar entry through `NAVIGATION_FEATURE_GATE` — which the platform runs *after* the ACL, so a
switch can only remove an entry, never reveal one — and closes the gate for every caller. Stored
history stays readable; nothing is deleted.

**DocuSign integration keys are settings, and `INTEGRATION_OAUTH_CLIENT_IDS` is not reused.** This was
the ES.0 audit's open question (§8, "decided in ES.1"). That environment variable is Advanced
Integrations' JSON map keyed by one provider key; a DocuSign identity is per *environment*, and demo
and production must never share a client (§9.2). One `docusign` key cannot address both, so the
settings document holds `provider.demoIntegrationKey` and `provider.productionIntegrationKey`. This
is safe only because an OAuth **client id** is not a secret — the client secret, the refresh token and
the Connect HMAC secret are the three vault kinds (`integration_credential_secrets`, keyed by
`ENCRYPTION_KEY`), and no settings route can accept a field that looks like one.

**A provider taxonomy is not invented twice.** The nine `ProviderErrorCategory` values, the redaction
rules and the `Retry-After` parsing from Advanced Integrations are the module's provider-side error
model, referenced, not copied. `unknown_outcome` (plan §4.3's `send_unknown`) is recorded as ES.3's
addition at the adapter port, because that phase decides how a lost send response is represented —
and it must not be classified `transient`, which would invite a retry.

**Health separates "the platform is intact" from "a send is possible".** `ok` answers the first and is
true; the schema check is reported as *pending 19-ES.2* rather than as a fault, because ES.1 owns no
table and a red module health would misreport a correct installation. `gate.ready` answers the second
and is false for the right reason.

**Every feature flag is declared before its consumer exists, and marked pending.** `requests`,
`documents`, `connections`, `templates`, `send`, `webhooks`, `embeddedSigning`, `artifacts`,
`approvals` — each names the phase that implements it. `effective` is false while a flag is pending,
so no code path can treat "the admin switched it on" as "the platform can do it".

---

## 3. How the security contract reads today

| Concern | Where it is decided |
| --- | --- |
| Who may see the module | `SignatureRequest:read` (ACL, last word after the settings switch) |
| Who may prepare / send / approve / void / correct / download | one capability and one synthetic resource each, asserted by the gate service before any service is called |
| Who may touch credentials | `connectionManage` only; settings writes refuse a secret-shaped key with `VALIDATION_FAILED` |
| Can a provider be reached before a connection exists | no — `assertOperation` ends at "is there a `connected`, active connection", and there is none until ES.4 |
| Can an unsupported operation no-op silently | no — `correctEnvelope` is declared `false` and answers `NOT_SUPPORTED_BY_PROVIDER` |
| Can embedded signing start by accident | no — it needs the flag, `send`, and a non-empty return-host allowlist |
| Can an unsigned webhook change a contract | policy says `webhooks.requireHmac` defaults `true`; disabling it raises an admin warning now, and ES.11 enforces it |
| What an error may say | stable codes only; no provider body, token, signing URL or document content |

---

## 4. Verification actually run

`apps/api/test/esignature.test.ts` — 19 tests, against the already-configured primary database, no
new database or schema, the `ESignature` settings row and the test roles/users restored/deleted by
their own ids.

- Registration: prefix, id, `apiPrefix`, `webhookPrefix`, `frontendRoute`, `providerKeys`,
  `implementedPhases`; **no `Ua` prefix** anywhere; the evidenced foundation (`acl`, `metadata`,
  `files`, `secret-encryption`, `jobs`, `domain-events`, `audit-stream`, `settings`, `hooks`) all
  present; the eight adjacent modules reported `available`/`unavailable`; the eight planned tables
  reported absent with the schema check still green.
- Permissions: administrator holds all eleven and sees the entry; a `SignatureRequest:read` role sees
  the page and is refused a settings write with `AUTHORIZATION_DENIED`; a role without the capability
  is refused capabilities, health, nav, settings and the operation list, and the entry is absent.
- Clean disable: with `enabled: false` the entry leaves the administrator's sidebar as well.
- Gate: `sendEnvelope` with the module off ⇒ 403 `SIGNATURE_MODULE_DISABLED`; with connections and
  send switched on but pending ⇒ still refused, and the health gate names the reason among
  `connections_disabled | encryption_key_missing | schema_pending | no_enabled_connection`;
  `correctEnvelope` ⇒ 403/422 by the caller's right, never a silent success; an undeclared operation
  ⇒ 400 `INVALID_QUERY`.
- Settings and secrets: defaults off; unknown key refused; `{ provider: { clientSecret: … } }` refused
  **and the value verified absent from both the response and the stored row**; an oversized value
  refused; version bumped with the actor recorded on an accepted change; a pending flag reported in
  `effective` as false with a `pending:embeddedSigning` warning; embedded signing without return hosts
  warned and its view refused.

Also run: `navigation.test.ts` (10), `i18n.test.ts` (6), `admin-internal.test.ts` (3) green together
with this suite (36 tests in the three-module run); `pnpm typecheck` (`tsconfig.json` + web) green;
`eslint --max-warnings=0` green on every touched path; `pnpm -r build` green (API, worker, web,
packages and modules).

**Full-suite comparison against the same checkout with ES.1 removed** (the module's files moved aside
and the eleven tracked edits stashed):

| | Files failed | Tests failed |
| --- | --- | --- |
| baseline (no ES.1) | 4 | 6 |
| with ES.1 | 5 | 8 |

The delta is exactly two tests in `service-desk-sla.test.ts`, which is time-of-day dependent — it
crossed an SLA boundary between the two runs and passes on its own. Everything else failing in both
runs predates this phase: `docs-content.test.ts` and `packages/docs/src/corpus.test.ts` report
`unknownAppRoute` for `user/activities-and-tasks` linking `/EmailTemplate` (added in commit
`5ce375e`), and `service-desk.test.ts` / `service-desk-workflow.test.ts` fail on the shared
development database — a pre-existing `ServiceDesk` settings row and case rows whose SLA state a test
asserts as `NotApplicable`. ES.1 changes none of those paths.

## 6. Browser verification

Against a scratch build of this checkout on ports `3031`/`8081`, leaving the user's own dev servers
untouched and the configured database restored afterwards (the `ESignature` settings row deleted, so
the installation is back to "unconfigured"; no test users or roles left behind).

| What was checked | Result |
| --- | --- |
| Sidebar with the module unconfigured | no `ESignature` entry, while every other module page is unchanged |
| Admin rail `Modules and integrations` | the `E-Signature` tab renders, with the whole policy form (25 fields, localized in `vi`) |
| Control geometry vs the `voiceCommunications` reference tab | identical: 36 px inputs/selects/numbers, 22×54 px switches |
| Enabling the module and saving from the UI | `POST /ESignature/action/settings` 200, success toast, and the sidebar entry appears on the next render |
| `/esignature` while enabled | the gate warning, the nine features each tagged with the phase that delivers them, the caller's eleven rights, and the provider capability tags |
| `/esignature` while disabled | the page still renders for an authorized user and says `The module is switched off in settings`; the API still refuses every operation |
| Console | no errors or warnings |

Two defects found by this walk and fixed before the phase was called done:

1. The secret-shaped-key guard matched **substrings**, so it refused the legitimate `webhooks.requireHmac`
   policy switch and the admin screen could not save at all. It now matches whole key segments
   (`hmac`, `secret`, `token`, `password`, `privatekey`), and `esignature.test.ts` pins the full
   document the screen submits.
2. Reading the settings document was gated on `use`. It now requires `connectionManage` like the
   write, matching `AdvancedIntegrations`: the document *is* the security policy. A user's own screens
   read the effective answer from `action/capabilities` and `action/nav` instead.

## 5. Deliberately not in this phase

- Any table, migration or entity (ES.2), the adapter port and the fake adapter (ES.3), OAuth and the
  connection lifecycle (ES.4), documents (ES.5), requests (ES.6), templates (ES.7), routing and
  preview (ES.8), preparation and send (ES.9–ES.10), the Connect endpoint and the raw-body hook
  extension (ES.11), status mapping (ES.12), the request workspace UI (ES.13), embedded signing
  (ES.14), artifacts (ES.15), actions (ES.16), approval engine (ES.17), entry points and events
  (ES.18), reporting (ES.19), the ops workbench (ES.20), the hardening review (ES.21), QA/release
  (ES.22).
- No `docusign-esign` dependency was added: plan §9.3 puts the SDK adoption decision behind the
  dependency/license review, and ES.1 has no code that calls a provider.
