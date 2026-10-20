# AI provider configuration

> **Plan:** `PLAN_Phase_19_AI_Agents.md` §6, §14.4, §20 Phase 19-AI.4.
> **Status:** delivered in 19-AI.4.
> **Audience:** administrators configuring model providers; operators diagnosing a connection.

---

## 1. What a provider connection is

A connection is one approved model endpoint. It is stored in `ai_provider_connections` and contains:

| Field | Meaning |
| --- | --- |
| `key` | Stable lowercase identifier, `^[a-z][a-z0-9-]{1,63}$`; agents/policies refer to it. |
| `kind` | Registered adapter: `openai-compatible` (production) or `fake` (non-production only). |
| `label` | Human label for the admin screen. |
| `baseUrl` | Endpoint root. The adapter appends `/chat/completions`. |
| `models` | **Allowlist** of model ids an agent may request. Empty is refused. |
| `dataClasses` | Data classes this endpoint is approved to receive: `public`, `internal`, `confidential`, `restricted`. |
| `apiKey` | Write-only credential. Encrypted at rest; read paths return `hasApiKey`. |
| `config.allowLoopback` | Allow a self-hosted runtime on loopback (still `https`, never in production). |
| `config.organization` | Optional provider organization/tenant header. |
| `enabled` | A disabled connection cannot be used by a run. |

A definition/version references a connection by `key` and a model from its allowlist. Changing the
credential never changes the agent definition, and rotating a key is a `PATCH` with the new
`apiKey`.

---

## 2. Credential handling

- `ENCRYPTION_KEY` (64 hex characters, 32 bytes) is the platform key. It is the same key
  `email_accounts` uses. Generate one with `openssl rand -hex 32`.
- Saving an `apiKey` when the key is missing fails with a clear message; there is **no plaintext
  fallback**.
- The stored value is `v1:<iv>:<tag>:<ciphertext>` (AES-256-GCM). It is never returned by any API,
  written to a run/event/tool row, or logged.
- `PATCH` with `"apiKey": null` clears a credential; omitting `apiKey` keeps the current one.
- A wrong key or a tampered row yields an auth-category provider error. The cause is not returned.

---

## 3. URL safety

The base URL is administrator-supplied, which makes it an outbound destination. The gateway applies
the same checks when the connection is saved **and** immediately before each call:

1. `https` only. Plain `http` is refused.
2. No username/password in the URL.
3. Cloud metadata hosts and `169.254.169.254` are always refused.
4. Loopback is refused unless `config.allowLoopback` is true, and it is refused in production
   regardless of that flag.
5. Non-loopback names must resolve to public addresses; RFC1918, ULA, link-local and CGNAT ranges
   are refused.
6. Adapter requests use `redirect: 'error'`, so an approved host cannot bounce the call inward.

A self-hosted runtime must therefore expose `https` (behind a TLS terminator) and be reachable at a
public name, or be explicitly loopback-enabled outside production. A LAN-only `192.168.x` endpoint is
**not** accepted by the default rules; use an ingress with a public name.

---

## 4. Data classes

Both the module and the connection must allow the request's data class:

- `dataPolicy.allowedExternalDataClasses` in the `aiAgents` settings row (default `public`,
  `internal`);
- `dataClasses` on the connection.

A caller handling `confidential` or `restricted` data must say so explicitly, and the connection must
have been approved for it. The default keeps customer-confidential data out of an endpoint that was
only approved for internal use.

---

## 5. Managing connections

All routes require the `AIAgentProvider:edit` capability (administrators hold it).

### In the admin UI

An administrator manages connections in the **Providers** tab of the AI Agents module page
(`/ai-agents`). The tab appears only for a caller the server reports as holding the provider
capability; every endpoint re-checks it. The form offers:

- the registered adapters, read from the running platform (the `fake` adapter is absent in production);
- the model allowlist as a tag list — an agent can only request a model listed here;
- the four data classes, intersected with the module's own `dataPolicy`;
- the credential as a **write-only** field. It is stored encrypted and never shown again; leaving it
  empty on an edit keeps the stored secret;
- **Check**, which performs one controlled provider turn and reports status, latency and usage only.

The **Settings** tab of the same page holds the module policy — the feature switches, the run
ceilings, the approval classes, the retention windows, the operator kill switch, the data classes
an external provider may receive, the disabled tools and the default connection.

### Through the API

```http
GET    /api/v1/AIAgents/action/providers
GET    /api/v1/AIAgents/action/providers/:key
POST   /api/v1/AIAgents/action/providers
PATCH  /api/v1/AIAgents/action/providers/:key
DELETE /api/v1/AIAgents/action/providers/:key
POST   /api/v1/AIAgents/action/providers/:key/check
```

Create an OpenAI-compatible connection:

```json
{
  "kind": "openai-compatible",
  "key": "primary-openai",
  "label": "Primary OpenAI-compatible endpoint",
  "baseUrl": "https://api.example.com/v1",
  "models": ["gpt-4o-mini"],
  "dataClasses": ["public", "internal"],
  "apiKey": "…write-only…",
  "config": { "allowLoopback": false },
  "enabled": true
}
```

The response never includes `apiKey`; it reports `hasApiKey`.

Delete is refused when a published version references the connection (foreign key), with a message
to disable it instead. Disabling preserves history and configuration.

---

## 6. Connectivity check

`POST .../check` performs one tiny provider turn (`maxOutputTokens: 16`, 15 s timeout) and returns:

```json
{
  "ok": true,
  "connectionKey": "primary-openai",
  "model": "gpt-4o-mini",
  "latencyMs": 412,
  "category": null,
  "message": "The provider answered successfully.",
  "providerRequestId": "req_…",
  "usage": { "inputTokens": 18, "outputTokens": 1, "cachedInputTokens": 0 }
}
```

- It never returns the model's text, the request body or the credential.
- A failure returns `ok: false` with a normalized category (`auth`, `rate_limit`, `timeout`,
  `canceled`, `invalid_request`, `provider_unavailable`, `invalid_response`, `content_filter`,
  `unknown`) and a remediation hint.
- A model outside the allowlist is a `422`, not a provider call.
- The check is administrator-triggered; routine tests never call it against a real provider.

---

## 7. Request ledger

Every call through the gateway writes `ai_agent_provider_requests`:

- provider key, actual model, request hash (SHA-256), message/tool counts, response format;
- input/output/cached token counts, latency, normalized outcome and error category;
- provider request id and an optional, admin-maintained estimated cost.

It does **not** store the prompt or the completion by default. `request_meta` contains counts and
settings only. A ledger write failure is logged with the run id and never exposes request content; it
does not fail a call whose tokens were already consumed.

---

## 8. Adapters

| Kind | Availability | Notes |
| --- | --- | --- |
| `openai-compatible` | all environments | `/chat/completions`, tool calls, JSON-schema response format, usage; no vendor SDK. |
| `fake` | **non-production only** | Deterministic; simulates errors, delays and tool proposals. Never selected in production. |

Adding a provider is a code change: implement `AIProviderAdapter`, register it in the module barrel,
and document its capabilities. No table, API or model output can register an adapter at runtime.

---

## 9. Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| `PROVIDER_KEY` save fails with an encryption message | `ENCRYPTION_KEY` is missing or malformed. |
| `auth` on every call | Credential rejected or `ENCRYPTION_KEY` changed after the secret was saved; re-enter the key. |
| `invalid_request` on check | Model name not on the allowlist or unsupported by the endpoint. |
| `provider_unavailable` | Endpoint unreachable, DNS failure, TLS problem or 5xx. |
| Base URL refused at save | `http`, credentials in the URL, loopback without opt-in, or a private address. |
| `feature "AI agent execution" is disabled` | `features.execution` is false; this is the shipped default. |
