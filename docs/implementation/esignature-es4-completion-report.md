# Phase 19-ES.4 — DocuSign OAuth and connection lifecycle

> `PLAN_Phase_19_ESignature.md` §6.1, §8.1, §9.2, §9.3, §9.4, §13.4, §18 `Phase 19-ES.4`.
> Acceptance: a demo account can authorize and the connection test succeeds; credentials are absent
> from logs, frontend bundles, API responses and normal configuration output; an expired or revoked
> consent changes the connection state and disables unsafe sends.
>
> Prerequisites read: `esignature-es1-completion-report.md` (the gate, the settings policy, the
> two-layer error model); `esignature-es2-completion-report.md` (the connection row, the transition
> table, the audit trail); `esignature-es3-completion-report.md` (the adapter port, the registry, the
> production guard); `docs/implementation/esignature-audit.md` §3, §4, §6.

ES.4 is where the module stops being a contract and starts holding a credential. It adds the
administrator's connection surface — create, authorize, test, switch, disconnect — DocuSign's OAuth
2.0 confidential authorization-code grant, and this module's own encrypted vault. **No envelope can be
created or sent yet**: the live adapter declares only the connection operations, so a send is still
refused by name (plan §5.2), which is the honest answer until ES.9 and ES.10 write it.

---

## 1. Files

| File | What it owns |
| --- | --- |
| `database/migrations/065_phase19_esignature_oauth.sql` | `esignature_credential_secrets` (one row per `(connection, kind)`, AES-256-GCM payload, expiry, rotation and revocation stamps) and `esignature_oauth_states` (hashed state, PKCE verifier, environment binding, redirect URI, single-use consumption). **Applied to `carocrm_dev`.** |
| `esignature-credential-vault.ts` | The vault port and its implementation: `store`, `read`, `describe`, `list`, `revoke`, `clear`. `read` is the only plaintext path and has two callers; no logger is injected, so nothing here *can* write a credential to a log line. |
| `signature-oauth-state.repository.ts` | The authorization state: 256-bit value, hashed primary key, PKCE S256 pair, TTL, atomic `consume`, `countPending`, `discardPending`. |
| `providers/docusign/docusign-transport.ts` | `DOCUSIGN_TRANSPORT`, the one HTTP door to DocuSign. Reuses the platform's `assertProviderUrl` (https, no credentials in the URL, private/loopback/metadata addresses refused), keeps redirects unfollowed and the timeout bounded, and returns status + body instead of throwing — DocuSign puts the OAuth error *name* in the body. |
| `providers/docusign/docusign-oauth.ts` | The grant: environment hosts, the scope allowlist and its administrative deny list, `docusignAuthorizeUrl`, `DocuSignOAuthClient.exchangeCode/refresh/userinfo`, `parseDocuSignUserinfo`, `selectDocuSignAccount`, `statusError`, `hashOAuthState`, `pkceChallengeFor`. |
| `providers/docusign/docusign-adapter.ts` | The **live** adapter (`mode: 'live'`): `connectionStatus` (Test Connection) and `accountContext`, with the seven later-phase operations declared `false` and fenced by `NotSupportedByProviderError`. |
| `esignature-authority.ts` | The documented service authority for the callback and the background refresh (ADR 0003's model, as Advanced Integrations and Voice use it). |
| `esignature-connection.service.ts` | The lifecycle: `list`/`get`/`view`, `create`, `update`, `storeSecret`, `authorize`, `complete`, `test`, `setActive`, `disconnect`, `refresh`, `contextFor`, plus `assertRedirectUri` and `ESIGNATURE_OAUTH_CALLBACK_PATH`. |
| `esignature.controller.ts` | `GET/POST /connections`, `GET/PATCH /connections/:id`, `POST /connections/:id/{secret,authorize,re-authorize,test,enable,disable,disconnect}`. |
| `esignature-oauth-callback.controller.ts` | The module's **only** `@Public()` route, kept out of the capability-checked controller on purpose. |
| `dto/esignature-shapes.ts` | `ConnectionCreate/Update/Secret/Authorize` and `OAuthCallbackQuery` shapes, all strict. |
| `signature-connection.repository.ts` | `updateProfile`, a `consentStatus` override on `setStatus`, and `not_connected → reauthorization_required` added to the transition table. |
| `esignature-module.ts` / `esignature-module-health.service.ts` | `connections` leaves `PENDING_FEATURES`; `19-ES.3`/`19-ES.4` join `IMPLEMENTED_PHASES`; the two new tables join the schema check; `provider-adapter` is now a real check rather than an observation. |
| `pages/esignature/ESignatureConnectionsPanel.tsx` (+ `ESignaturePage.tsx`, `api/client.ts`, `api/types.ts`) | The administrator's connection table, create and credential dialogs, Test result with the adapter mode. |
| `i18n/{en,vi}/esignature.json` | The `connections.*` namespace (51 keys each) — and the English catalog is now English: `i18n/en/esignature.json` had shipped with Vietnamese strings in ES.1. |

---

## 2. Decisions taken here

- **ESignature gets its own vault tables.** The audit listed `integration_credential_secrets` and
  `integration_oauth_states` as reusable machinery. The *code* was reused; the tables cannot be: both
  carry `connection_id … REFERENCES integration_connections (id)`, and an ESignature connection is an
  `esignature_connections` row. Widening those constraints is not additive and would change a table
  Advanced Integrations owns, so migration `065` mirrors the column set, the `kind` vocabulary and the
  `state` machine exactly. `oauth_access_token` joins the module's `SECRET_KINDS` here, because a
  short-lived bearer value is still a credential.
- **The transport is a seam, not a `fetch` call.** One token, two consumers (the OAuth client and the
  live adapter). The platform's `createProviderHttpClient` is not used directly because it discards the
  body on a 4xx, and `invalid_grant` — the difference between "the consent is gone" and "the installed
  secret is wrong" — lives in that body. The SSRF gate is reused verbatim.
- **The live adapter implements the connection only.** `prepareEnvelope`, `sendEnvelope`,
  `envelopeStatus`, `listRecipients`, the two downloads and `verifyWebhook` are declared `false` and
  their method bodies refuse. That is plan §5.2's rule made visible: the gate reads the *bound*
  adapter, so a production installation refuses a send with `NOT_SUPPORTED_BY_PROVIDER` until ES.9/10
  ship it, instead of admitting an operation that does not exist.
- **The redirect URI is stored per connection and validated against the platform's own callback path.**
  DocuSign compares it exactly, and a deployment behind a proxy has a different public host than the
  API sees; deriving it from the request would make the authorization flow an open redirect with a live
  consent attached. `https` is required, with a loopback exception for local validation only.
- **Starting a re-authorization stops the live grant.** A connection in `connected` moves to
  `reauthorization_required` the moment a new flow starts, because `recordAuthorized` may only enter
  `connected` from a non-connected state — and, more importantly, because a send during that window
  would be judged against a consent that is about to be replaced.
- **A grant that is real but insufficient is `reauthorization_required` with `consentStatus =
  insufficient`**, and its tokens are still stored: an administrator must be able to see that a
  credential exists and when it expires. The connection does not become active, so nothing can be sent.
- **A refresh is serialized with `pg_advisory_xact_lock(hashtext(connection_id))` and re-checked under
  the lock**, mirroring Advanced Integrations: a rotating refresh token is destroyed by a second
  concurrent refresh, so the loser of that race must make no provider call at all.
- **Disconnect destroys credentials before it soft-deletes the row**, and discards any unfinished
  authorization state with it. History — requests, events, artifacts, audit — survives (plan §21.12).
- **`DOCUSIGN_BASE_URL`** replaces the identity host for `/oauth/auth`, `/oauth/token` and
  `/oauth/userinfo` only, so a developer or the suite can drive the *real* transport against a local
  harness (plan §9.4 step 1). It never redirects the REST base URI, which comes from `userinfo`, and
  the transport's loopback exception applies only under `NODE_ENV=test`.
- **Provider failures arrive at the caller as module failures.** `toModuleError` is applied at every
  throw site in the flow, so an OAuth error never surfaces as a 500 and the provider's words — which
  can quote a token — never reach a response.

---

## 3. Verification

**Automated: 41 new checks, all green; the module's own suites are 145 green.**

| Suite | Covers |
| --- | --- |
| `apps/api/test/esignature-connection.test.ts` (22) | Capability refusal for a read-only role; create with the secret write-only (absent from the response, the list, the audit detail, and stored as ciphertext); every redirect-URI rejection shape; a pasted access token refused; state unpredictable, hashed at rest, bound to environment and redirect; forged / replayed / expired callbacks refused with one answer; the code, token and state absent from the redirect target; account and base URI resolved from `userinfo`; a refused consent recorded without quoting the provider; `invalid_grant` → `reauthorization_required`, `is_active` false, nothing stored; an insufficient grant with its missing scope audited; re-authorization stopping a live grant and restoring it; Test refused before authorization and admitted after; the **live adapter** driven against the stub transport, including the `401 → refresh → retry` path and the move out of the usable set; **one refresh under two concurrent callers**; a revoked refresh token disabling sends; the operator switch; disconnect destroying credentials and states while the audit survives; rename and re-point; and a sweep asserting no credential appears in any ES.4 response. |
| `apps/api/test/esignature-docusign.test.ts` (19) | Environment hosts and the authorize request; PKCE and state hashing; the scope allowlist, its deny list and the no-narrowing rule; the Basic credential header with the secret absent from the body; an echoed scope trusted over the request; `invalid_grant` / `invalid_client` / 429 / 5xx classified by category with the provider body discarded; account resolution, preference for the stored account, and refusal to guess among accounts; Test Connection against the stored base URI with no inferred data-center host; every failure detail code; a non-JSON success and an unreachable provider; the declared-capability fence; and the transport's destination gate (http, private, metadata, credentials-in-URL, loopback opt-in). |

`pnpm typecheck`, `pnpm -r build` (API, worker, web) and `pnpm lint` are green. The whole `pnpm test`
run is reported in §5 with its pre-existing failures named.

**Live check** (scratch API on `:3041` from the repo root, Vite on `:5141`, admin session):
the module page renders the connections panel; a created connection shows `Not authorized`, `Stopped`,
`Authorization in progress`, a disabled Test button and one `Client secret` chip; after the account
context and tokens are present it shows `Authorized`, `Active`, the account name, the data-center base
URI, `signature`/`impersonation`, three credential chips and `Re-authorize`; Test answers
"The connection answered." with the honest note *"A fake adapter answered, so nothing reached
DocuSign."*; Disconnect confirms with the retention sentence and reports
"Disconnected; 1 credential(s) were destroyed." The `authorize` call returned
`https://account-d.docusign.com/oauth/auth?response_type=code&client_id=…&redirect_uri=http%3A%2F%2Flocalhost%3A5141%2Fapi%2Fv1%2FESignature%2Foauth/callback…`
— the demo host, the platform callback path, PKCE challenge and the minimum scopes.
Both locale catalogs serve 168 `esignature.*` keys each. Afterwards the shared dev database holds
**zero rows** in `esignature_connections`, `esignature_credential_secrets`, `esignature_oauth_states`
and `signature_audit_entries`, and the `ESignature` settings row was removed.

---

## 4. What the plan's acceptance line still needs

**"Demo account can authorize and connection test succeeds" is not closed.** It needs DocuSign demo
credentials, and plan §17.3 forbids an automated test from using them, so every link in that chain is
proved against a stub transport instead: the URL the browser is sent to, the token exchange, the
`userinfo` account resolution, the credential storage, the health answer and the reauthorization
transition. The remaining step is a human one and belongs to ES.22 (release QA): register an
integration key in a DocuSign developer account, add this installation's redirect URI there, authorize,
and press Test. Two things are known only at that moment and are deliberately *not* claimed here:

- that DocuSign's token response carries no `scope` echo for this grant, so the requested set is
  recorded as granted (the code says so, and the missing-scope branch stays reachable);
- that `GET /restapi/v2.1/accounts/{id}/envelopes?count=1` is the cheapest read a `signature`-scoped
  user may call — chosen over `GET /accounts/{id}` because the account record needs administrator
  rights this module does not request.

---

## 5. Known limits after this phase

- The live adapter implements the connection only; ES.9/ES.10/ES.11/ES.15 add the envelope, Connect
  verification and artifact operations and flip their flags.
- The Connect HMAC secret can be stored (`webhook_secret`) but nothing verifies a delivery yet — that
  is ES.11's endpoint.
- No scheduled sweep calls `discardPending`/purge; states are bounded per connection (a new
  authorization discards the previous unfinished ones) and destroyed on disconnect.
- `apps/api/src/advanced-integrations`'s own `OAUTH_REDIRECT_URI` remains a *path*; this module needed
  an absolute URI and stores it per connection. The two conventions are documented, not unified.
- Pre-existing full-suite failures, unchanged by this phase and listed in the ES.2/ES.3 reports:
  `docs-content` and `packages/docs/corpus` (`/EmailTemplate` `unknownAppRoute`, from commit `5ce375e`)
  and the `service-desk*` suites (shared dev-DB state and a time-of-day-dependent SLA assertion).
