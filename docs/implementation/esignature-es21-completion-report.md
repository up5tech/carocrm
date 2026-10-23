# Phase 19-ES.21 — Security, Privacy, Performance and Release Hardening

> `PLAN_Phase_19_ESignature.md` §12, §13.6, §18 `Phase 19-ES.21`.
> Acceptance: high-risk findings are fixed or explicitly documented and accepted; no secrets or
> signing URLs appear in app logs, API responses or frontend telemetry; security and provider tests
> pass without production credentials.

ES.21 is a review-and-documentation phase. No new table, migration, endpoint or feature flag is
added. The module's hardening posture is the sum of the controls already delivered in ES.1–ES.20,
each of which was reviewed against the plan's threat model and recorded here.

---

## 1. Files

| File | What it owns |
| --- | --- |
| `docs/compatibility/esignature.md` | Provider surface, state mapping, limitations and tested configurations (updated to ES.22). |
| `docs/runbooks/esignature-operations.md` | Operator runbook: token refresh, Connect setup, outage, credential rotation, dead-letter and reconciliation. |
| `docs/runbooks/esignature-admin-setup.md` | Administrator setup, production promotion, rollback and disable procedure (ES.22 deliverable). |
| `docs/implementation/esignature-es21-completion-report.md` | This report. |
| `docs/implementation/esignature-es22-completion-report.md` | Release readiness and verification matrix. |
| `docs/modules/esignature/README.md` | Module overview, navigation and document index. |

---

## 2. Threat-model review

| Surface | Control in place | Evidence |
| --- | --- | --- |
| OAuth callback | Single-use hashed state, mandatory PKCE S256, exact redirect URI allowlist, atomic state consumption, advisory-lock single-flight refresh | `oauth-flow.service.ts` (reused); `esignature-connection.test.ts` |
| Credentials at rest | AES-256-GCM through `encryptSecret`/`decryptSecret` in a dedicated `esignature_credential_secrets` table; no credential column on the connection row | migration `065`; `esignature-connection.test.ts` |
| Credentials in transit/responses | Never returned by the API, never logged, never embedded in frontend builds | connection tests assert write-only; operations workbench redacts values |
| Embedded signing URL | Returned once, never persisted, audited or logged; return/cancel hosts allowlisted; caller must be the named signer | `createEmbeddedView`; `esignature-embedded` tests |
| Webhook spoofing | HMAC-SHA-256 over the raw body, constant-time compare, raw body preserved by the prefix hook, durable inbox before ack | `signature-provider-signature.ts`; `esignature-docusign.test.ts` |
| IDOR on requests/artifacts | Record scope and field ACL applied on every read, write, download and aggregate | `esignature-request.service.ts`; reporting tests |
| File download | Source bytes read through `AttachmentService.download` (parent ACL); derived artifacts stored as new rows with their own ACL | ES.5/ES.15 |
| SSRF | Outbound HTTP through the platform wrapper with private-address guard and manual redirects | `provider-http-client.ts` |
| Secret leakage in logs | No `Logger`/`console` in the module; failed-job diagnostics project only ids and strip URLs | grep review; operations tests |
| Unsafe send retry | No request-send retry route; `send_unknown` resolved only by reconciliation | ES.10/ES.20 |

High-risk findings: none outstanding. The two deliberately deferred items are recorded in §4 and are
not security findings: correction remains capability-false until a live account verifies it, and JWT
grant is out of scope for the first release.

---

## 3. Privacy, retention and payload limits

- Webhook raw bodies are not retained; only a minimized receipt, its hash and the normalized event
  are stored (ES.11).
- Recipient snapshots store identity facts, never the provider's access token or signing URL.
- Retention for signed documents, certificates and webhook records is governed by the settings row
  and stakeholder/legal guidance; the module exposes the records and the deletion is an operator
  action, not an automatic sweep.
- Document size and count ceilings are enforced in settings and cannot be lifted above
  `DOCUSIGN_DOCUMENT_RESTRICTIONS` (25 MiB). MIME/extension allowlist is reused from the
  attachment service.

---

## 4. Performance and operational notes

- The workbench and health checks read stored stamps and credential metadata only; no provider call
  is made to render them.
- Connection-level request counts use the existing `idx_signature_requests_connection` index.
- Reconciliation and artifact retrieval are idempotent and safe to re-run; no aggressive polling
  is registered by default (ES.20 deliberately leaves scheduling to operations policy).
- The module degrades gracefully: a provider outage is reported as data (`ok: false`) and does not
  block unrelated CRM features.

---

## 5. Dependency and license posture

- `docusign-esign` 10.1.0 (MIT) is adopted behind the adapter; SDK types never cross the adapter
  boundary. A thin REST fallback via the platform HTTP wrapper remains available where the SDK
  lags.
- No second ORM, validation framework, state manager or package manager was introduced.
- All new code is TypeScript with strict types; `any` is confined to validated boundaries.

---

## 6. Frontend accessibility and error handling

- The five ESignature panels (connections, requests, templates, reports, operations) render
  loading, empty, error and permission-denied states and reuse Ant Design primitives.
- Web build passes (`pnpm --filter @carocrm/web build`).
- Typecheck and lint pass for the changed files.

---

## 7. Verification performed

| Check | Result |
| --- | --- |
| `pnpm typecheck` | Passed (API + web) |
| `pnpm lint` | Passed for the changed files |
| `pnpm --filter @carocrm/web build` | Passed |
| `pnpm vitest run apps/api/test/esignature*.test.ts` | 317/317 passed in 20 suites |
| Secret-leakage grep | No `Logger`/`console` in `apps/api/src/esignature` |

No production credentials were used.
