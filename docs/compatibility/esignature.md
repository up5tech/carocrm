# ESignature — compatibility and behavior reference

> Phase 19-ES.0 deliverable (`PLAN_Phase_19_ESignature.md` §3.3, §18).
> Status: **19-ES.0 delivered** (audit + contract only; no runtime code yet).
> Canonical module name: `ESignature` (no `Ua` prefix). API prefix: `/api/v1/ESignature`;
> webhook prefix: to be finalized in ES.11 (raw-body hook extension required — see the audit
> §8, `docs/implementation/esignature-audit.md`).

This document records the exact provider surface this module reimplements, the decisions taken
against the repository as it actually exists, and the compatibility limits a deploying
organization must know. A feature is **not** listed as supported until its adapter and
end-to-end behavior pass the relevant tests (plan §17). Provider facts below were verified on
**2026-10-22** against public documentation and the npm registry; each later sub-phase that
touches provider behavior must re-verify and update the date.

This is a clean-room reimplementation. No EspoCRM PHP class, frontend asset, icon, translation
or branding is copied. DocuSign product names are used only to describe the external contract.

---

## 1. Provider product/API surface implemented

| Item | Decision |
| --- | --- |
| Provider | DocuSign, first and only adapter for the initial release |
| API | **eSignature REST API v2.1** (`/restapi/v2.1/accounts/{accountId}/…`) — envelopes, recipients, templates, views, combined documents |
| Out of surface | CLM, Rooms, MA, Click, Connect *management* APIs (beyond minimal Connect event configuration), billing, bulk send, eSign admin APIs |
| API base URI | Discovered per account from `GET {authHost}/oauth/userinfo` → `accounts[]` → `base_uri`; REST calls go to `{base_uri}/restapi/v2.1/accounts/{account_id}/`. A data-center host is never hard-coded |
| Auth hosts | Demo: `https://account-d.docusign.com` · Production: `https://account.docusign.com` |
| Node SDK | `docusign-esign` **10.1.0** (2026-10-15, MIT, targets API v2.1-26.3.01.02, vendor states Node 12+). Adopted **behind the adapter** after dependency/license review (ES.21); SDK types never cross the adapter boundary; a thin REST fallback via the platform HTTP wrapper is allowed where the SDK lags |

## 2. Supported OAuth flows

| Flow | Status | Why |
| --- | --- | --- |
| Confidential Authorization Code Grant | **Default, planned (ES.4)** | An administrator explicitly connects a CRM-owned confidential client; matches the platform's existing OAuth machinery (single-use hashed `state`, PKCE option, exact callback path, advisory-lock refresh in `apps/api/src/advanced-integrations/oauth-flow.service.ts`) |
| JWT bearer grant | Not default; out of the first release | Only for approved server-to-server consent + certificate/key model; requires a separate admin setup path and security review (plan §9.2) |
| Any other grant | Never | DocuSign deprecates legacy grants; a new integration must not use them |

Rules enforced by design: minimum scopes (starting `signature`; `extended` only if refresh
lifetime requires it; `impersonation` only with an approved JWT use case); refresh-token
storage in the encrypted vault (`integration_credential_secrets` + `ENCRYPTION_KEY`), never in
settings, logs, responses or the browser; `consent_required` / `invalid_grant` → connection
moves to `reauthorization_required` and sends are disabled; demo and production clients,
redirect URIs, secrets and stored account identities are fully separate.

## 3. Envelope / recipient / template / signing / document behavior

| Behavior | Status | Notes |
| --- | --- | --- |
| Connection + Test Connection | Planned ES.4 | Stores account ID, base URI, granted scopes, environment badge; health view redacted |
| Local draft request (no provider call) | Planned ES.6 | Draft is local only; a provider envelope does not exist until preparation |
| Envelope preparation (provider draft) | Planned ES.9 | Idempotent via correlation; unsent provider drafts abandoned safely |
| Documents from CRM attachments | Planned ES.5 | Authorized bytes only; immutable snapshot + SHA-256 of the exact submitted bytes; source file never overwritten |
| Provider templates + role mapping | Planned ES.7 | Template IDs stay bound to the owning account; roles validated against an allowlist |
| Signers, CC, routing order | Planned ES.8 | Sequential/parallel routing; explicit sender affirmation of signer identity |
| Remote signing | Planned ES.10/ES.13 | DocuSign controls the signing journey and sends signing emails from the DocuSign account |
| Embedded signing (recipient view) | Planned ES.14, **off by default** | Server-side generation for a matched recipient only; short-lived URL never persisted/logged/analyzed |
| Reminders / resend | Planned ES.16 | Permission + rate policy guarded |
| Void with reason | Planned ES.16 | Only in provider-allowed states; audited |
| Correction | Planned ES.16, exception path | Only when provider state permits; fresh preview + full audit |
| Completed documents + certificate | Planned ES.15 | Stored as new derived artifacts (attachments) on the request; deduped by provider document identity / content hash |
| Connect status events | Planned ES.11/ES.12 | Verified inbox, dedup, async projection; reconciliation for gaps |
| Status/recipient reconciliation | Planned ES.12/ES.20 | Bounded job + operator action; no blanket polling |
| Approval before send | Planned ES.17 | Module policy; approval binds to the exact reviewed snapshot version |

## 4. Local state ↔ provider state mapping (draft — verify against demo payloads in ES.12)

Local request states (plan §4.7): `draft`, `pending_approval`, `ready_to_send`, `sending`,
`send_unknown`, `sent`, `delivered` (aggregate, only if unambiguous), `partially_signed`,
`completed`, `declined`, `voided`, `expired`, `provider_error`, `reconciliation_required`.

Expected provider vocabulary (unverified against live fixtures at ES.0 — **the mapper is
corrected from demo-account captures in ES.12, never from this table alone**):

| Provider envelope status | Local target | Rule |
| --- | --- | --- |
| `created` (draft, unsent) | `ready_to_send` / prepared | provider draft exists; request not yet sent |
| `sent` | `sent` | first trusted event after send |
| `delivered` | `delivered` or stay `partially_signed` | aggregate only when unambiguous |
| (recipients signed, envelope open) | `partially_signed` | a recipient completing never completes the envelope |
| `completed` | `completed` | **only** from a verified Connect event or reconciliation API result |
| `declined` | `declined` | recipient decline reason stored, sanitized |
| `voided` | `voided` | |
| `deleted` / `timedout` / expiry | `expired` / terminal per evidence | |
| unmapped / unknown | keep prior state + `unmapped` event | unknown is never success |

Recipient statuses expected: `created`, `sent`, `delivered`, `signed`, `completed`,
`declined`, `autoresponded` (to verify). Out-of-order or duplicate events never move a
terminal state backwards; ambiguity triggers reconciliation (plan §4.7, §10.3).

## 5. Known provider-plan / account limitations

- Feature availability (embedded signing, bulk, advanced recipient auth, Connect
  configuration options, certificate of completion retention) depends on the DocuSign account
  plan and account settings; the admin runbook must verify the account's capabilities before
  enabling dependent features.
- Connect must be configured on the DocuSign account (or via an approved management path) to
  point at the CRM webhook URL; event coverage and delivery guarantees are the provider's.
- Provider status vocabulary and payload shapes evolve; stored raw event metadata is
  minimized and versioned, and the status mapper is the single translation point.
- Rate limits, throttling and Retry-After behavior are the provider's; the adapter honors
  them through the platform resilience layer.

## 6. Unsupported / explicitly excluded (initial release)

- Any non-DocuSign provider (adapter contract only until DocuSign is end-to-end stable).
- JWT grant, multi-provider failover, provider template authoring/editing, bulk sending,
  CLM/Rooms/Click, marketplace/billing.
- Automated/AI-initiated sends (disabled by default; human approval required — plan §11.3).
- Any claim of qualified electronic signature status, jurisdictional compliance (ESIGN/UETA/
  eIDAS/…) or legal enforceability — DocuSign remains the signing authority and compliance
  provider; this module is an operational orchestration and evidence layer (plan §1.2, §2.2).

## 7. Tested account configurations

| Configuration | Status |
| --- | --- |
| Fake adapter (no provider) — full lifecycle | The only configuration used by automated tests (ES.3+) |
| DocuSign demo/developer account, single account, authorization-code grant, remote signing, Connect events | Planned deliberate smoke test in ES.22 with synthetic documents/signers; recorded here with date when executed |
| Production account | Not tested; remains disabled until an explicit administrator enablement (plan §9.4) |

## 8. Environment and secret handling (names only)

- Reused env: `ENCRYPTION_KEY` (vault), `RATE_LIMIT_MAX`, `UPLOAD_MAX_MB`, worker `JOB_*`.
- Non-secret integration keys: `INTEGRATION_OAUTH_CLIENT_IDS` (JSON) or the `ESignature`
  settings document — decided in ES.1.
- Per-connection secrets (client secret, refresh token, Connect HMAC secret) live only in
  the encrypted credential vault. No secret values are ever committed, logged, returned by
  the API, or embedded in frontend builds or documentation (plan §4.1, §21).

## 9. Upstream references (verified 2026-10-22)

- eSignature REST API overview: https://developers.docusign.com/docs/esign-rest-api/
- eSignature how-to guides: https://developers.docusign.com/docs/esign-rest-api/how-to/
- Authentication overview: https://developers.docusign.com/platform/auth/
- Confidential Authorization Code Grant: https://developers.docusign.com/platform/auth/confidential-authcode-get-token/
- Embedded signing: https://developers.docusign.com/docs/esign-rest-api/esign101/concepts/embedding/
- DocuSign Connect webhooks: https://developers.docusign.com/platform/webhooks/connect/
- Node.js SDK: https://github.com/docusign/docusign-esign-node-client (npm `docusign-esign` 10.1.0)
- Recipients API: https://developers.docusign.com/docs/esign-rest-api/reference/envelopes/enveloperecipients/list/
- API endpoint base paths / go-live: https://developers.docusign.com/docs/esign-rest-api/go-live/
