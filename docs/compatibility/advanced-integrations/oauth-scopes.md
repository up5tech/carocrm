# Advanced Integrations — OAuth scopes and client configuration

> Phase 19-INT.16–19-INT.24 deliverable (`PLAN_Phase_19_Advanced_Integrations.md` §7.2, §3.3;
> `19-INT.16`–`19-INT.24`).
> Status: **the mechanism is delivered; the scope names below are the implementation's pins, not
> verified observations of a live account.**
> Parent document: `docs/compatibility/advanced-integrations.md`.

## 1. How the platform asks for a grant

The platform owns the flow; a connector owns only its endpoints. The rules, in the order they
apply:

1. **The requested scope set is the provider's declared set**, optionally narrowed by the caller.
   A caller can never widen it: `OAuthFlowService.authorize` filters the requested scopes against
   `provider.requiredScopes ∪ provider.optionalScopes`.
2. **The state is single-use and stored hashed.** 256 bits of entropy, consumed atomically. A second
   callback with the same state finds nothing and is refused.
3. **The state is bound.** It names the connection, the provider and the user who started the flow.
   The callback derives the connection *from the state*, never from the request, so a callback
   cannot be aimed at somebody else's connection.
4. **PKCE (S256)** is used wherever the provider supports it. The verifier is generated per flow,
   stored with the state and deleted with it.
5. **The redirect URI is a constant of the platform** (`/api/v1/integrations/advanced-integrations/oauth/callback`),
   never request input.
6. **The client secret is per connection** and lives in the credential vault. Two installations — or
   two connections of one installation — never share a secret. The secret is read from the vault at
   the exchange, the refresh and the revocation, and is never logged.
7. **The granted scopes are compared with the requested scopes** before the connection becomes
   usable. A missing scope moves the connection to `reauthorization_required` and is reported as a
   *permission class*, never as a credential.
8. **A narrowed request narrows the requirement.** When the operator narrows the request, the
   connection's required set becomes the narrowed set, so a connection that asked for less does not
   report a permanently missing scope.

## 2. Client ids and client secrets

| What | Where it lives | Why |
| --- | --- | --- |
| The OAuth **client id** | The deployment configuration: `INTEGRATION_OAUTH_CLIENT_IDS`, a JSON object keyed by provider key, e.g. `{"google-workspace":"1234.apps.googleusercontent.com"}`. | A client id is not a secret, so it belongs to the deployment rather than to the vault. |
| The OAuth **client secret** | The credential vault, per connection, as the `client_secret` kind. | It is a secret, and it is per connection so two tenants never share one. |

The configuration is parsed leniently: a malformed value yields an empty map rather than a boot
failure, and the connector reports the missing client id with a precise message when somebody
tries to authorize it.

```bash
# .env
INTEGRATION_OAUTH_CLIENT_IDS={"google-workspace":"...","microsoft-365":"...","zoom":"...","mailchimp":"...","meta-lead-ads":"...","quickbooks-online":"..."}
```

## 3. The scope sets

The **required** set is what a connection needs. The **optional** set widens what may be synced
and is never required. The **write** scope is what a write operation needs, and the connector
refuses the write with `SCOPE_MISSING` when the grant does not carry it — an actionable
reauthorization error rather than an opaque provider failure.

### 3.1 Google Workspace

| Scope | Required | Grants |
| --- | --- | --- |
| `https://www.googleapis.com/auth/calendar.readonly` | yes | Reading calendar events. |
| `https://www.googleapis.com/auth/contacts.readonly` | yes | Reading contacts. |
| `https://www.googleapis.com/auth/calendar` | no | Creating and updating calendar events. |
| `https://www.googleapis.com/auth/contacts` | no | Creating and updating contacts. |

The authorization URL asks for `access_type=offline` and `prompt=consent`, because Google only
issues a refresh token when the administrator consents to it.

### 3.2 Microsoft 365

| Scope | Required | Grants |
| --- | --- | --- |
| `Calendars.Read` | yes | Reading Outlook events. |
| `Contacts.Read` | yes | Reading Outlook contacts. |
| `Calendars.ReadWrite` | no | Creating, updating and deleting Outlook events. |
| `Contacts.ReadWrite` | no | Creating, updating and deleting Outlook contacts. |

The tenant is the `common` endpoint, so the connection's `tenantRef` records which tenant the
grant belongs to.

### 3.3 Zoom

| Scope | Required | Grants |
| --- | --- | --- |
| `meeting:read` | yes | Listing the user's meetings. |
| `meeting:write` | no | Creating and updating a meeting. |

### 3.4 Mailchimp

| Scope | Required | Grants |
| --- | --- | --- |
| — | — | Mailchimp's OAuth publishes **no per-object scope**: a grant is account-wide. |

The connector therefore declares no scope and reads only the objects it declares. **This is a
limitation, not a design choice**: a Mailchimp grant is broader than the connector's own reach.
A deployment that needs a narrower grant must use a Mailchimp plan or a separate account.

### 3.5 Meta Lead Ads

| Scope | Required | Grants |
| --- | --- | --- |
| `ads_read` | yes | Reading lead form submissions and lead forms. |

The access token is sent as an `Authorization: Bearer` header rather than as an `access_token`
query parameter, so it never appears in a URL that could be logged or forwarded.

### 3.6 QuickBooks Online

| Scope | Required | Grants |
| --- | --- | --- |
| — | — | The connector reads customers, invoices and payments through the company query endpoint; the grant is the one Intuit issues for the connected company. |

The company (realm) id is the connection's `tenantRef`; a connection without one is refused.

### 3.7 Shopify, Stripe and the generic REST connector

None of the three uses OAuth.

| Connector | Credential | Kind |
| --- | --- | --- |
| Shopify | A custom-app access token, sent as `X-Shopify-Access-Token`. | `api_key` |
| Stripe | A **restricted** API key, sent as `Authorization: Bearer`. | `api_key` |
| Generic REST | None, a bearer secret, an API key header, or an OAuth token. | `api_key` / `oauth_access_token` |

## 4. The scope check at runtime

The platform checks a scope in two places, and both are load-bearing:

- **At the connection level.** The granted set is compared with the required set when the
  connection would become usable, when it resumes, and when the catalog is read. A connection with a
  missing scope is visible as *missing permissions*, not as a broken object.
- **At the operation level.** The connector checks the scope **before** the request. A Google
  connection that was granted only the read scope refuses to create an event with `SCOPE_MISSING`
  and the detail `scope_missing`, rather than sending a request the provider would reject.

## 5. Revocation and reauthorization

- `POST /action/connections/:id/revoke` withdraws the provider grant (when the provider publishes
  a revocation endpoint) and then revokes the stored credential — either way, so a provider that
  cannot revoke still leaves nothing usable behind.
- A refresh failure moves the connection to `reauthorization_required` with the code
  `TOKEN_EXPIRED`; a scope shortfall moves it with `SCOPE_MISSING`. Both are recoverable through
  `POST /action/connections/:id/reconnect`, which re-runs the same flow.
- The refresh runs inside a transaction that holds a per-connection Postgres advisory lock, so two
  concurrent operations cannot refresh a rotating token twice. The second one finds a fresh token
  and does nothing.

## 6. What a deployment must confirm

Before a connector is enabled in production, confirm against the vendor's current documentation:

1. the exact scope names — they are spelled by the vendor and change;
2. whether the provider requires PKCE for the grant the connector performs;
3. whether the provider reports the granted scopes in the token answer. The connector keeps the
   scopes it asked for when the provider does not report them, which is correct for a provider that
   does not reduce a grant — but it is an assumption, not an observation.
