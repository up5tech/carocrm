# ESignature — operations and recovery runbook

> Phase 19-ES.20 deliverable (`PLAN_Phase_19_ESignature.md` §14, §16, §18 `19-ES.20`).
> Companion documents: `docs/compatibility/esignature.md` · `esignature-es20-completion-report.md`.
> UI: **E-Signature → Operations and recovery** (`/esignature`, shown to `SignatureConnection:read`).

This runbook answers the question an operator has during an incident: **what is broken, what is safe
to retry, and what must never be retried?** The workbench reads stored diagnostics; it never calls
DocuSign to render its page. That is deliberate: during a provider outage the screen must still open.

## 0. The commands you will need

| Command | Capability | What it answers |
| --- | --- | --- |
| `GET /api/v1/ESignature/action/operations?staleAfterHours=24&limit=25` | `SignatureConnection:read` | Connection health, webhook counters, four recovery queues and failed module jobs. Request ids obey your own `SignatureRequest` scope. |
| `GET /api/v1/ESignature/action/health` | `SignatureRequest:read` (`use`) | Platform foundation plus the ES.20 checks: token refresh, Connect secrets, recent provider errors, inbox backlog, credential age. |
| `POST /api/v1/ESignature/action/operations/webhooks/:id/retry` | `SignatureConnection:edit` (`connectionManage`) | Re-apply one **verified** inbound delivery that is `retryable` or `dead_letter`. Never a send. |
| `POST /api/v1/ESignature/requests/:id/reconcile` | `SignatureSend:edit` (`send`) + record scope | Ask the provider for the envelope's current state and project it. The only recovery for an ambiguous send. |
| `GET /api/v1/Jobs` (`/admin/jobs` in the SPA) | platform admin | The shared job records. Retry a failed artifact job there; this module's workbench never re-enqueues a send. |

**Never** look for a "retry send" button. It does not exist by design: a `send_unknown` request is
resolved only by reconciliation, and a `provider_error` request is recovered on its detail page
(deliberate recover → deliberate send), where the send guard applies again.

## 1. Token refresh failed / reauthorization required

**Symptom.** The connection health row is `Blocked` with `Reauthorization required`; the token state
is `Expired` or `Reauthorization required`; `checks.token_refresh` is red.

**Cause.** The grant expired, an administrator revoked consent, a scope was removed, or the rotating
refresh token was invalidated. A refresh does **not** fix a revoked grant.

**Safe action.**

1. Confirm the connection is the intended environment (demo vs production is never mixed).
2. `POST /api/v1/ESignature/connections/:id/re-authorize` — the administrator completes the OAuth
   consent. A successful callback sets `connected`, restores scopes and leaves `is_active` as the
   operator set it.
3. If the grant returns with missing scopes, the state stays `reauthorization_required`; read
   `grantedScopes`/`consentStatus` on the connection. Do not paste a token anywhere — there is no
   field for one.

A connection in that state is refused by the gate for every provider operation. Requests already
sent remain readable; no evidence is lost.

## 2. Connect webhook setup or HMAC failure

**Symptom.** `checks.webhook_secrets` is red (`N active connection(s) have no Connect HMAC secret`),
or `webhook.signatureStatus.invalid` grows, or deliveries never arrive (`last delivery: —`).

**Check, in order.**

1. The connection's public routing id is the segment used in
   `POST /api/v1/integrations/esignature/:publicId`. An unknown id is a 404 and records nothing —
   that is intentional.
2. DocuSign Connect must be configured to send the account's HMAC signature
   (`X-DocuSign-Signature-1`, base64 HMAC-SHA-256 over the raw body). The secret is stored in the
   encrypted vault, never in settings.
3. If `webhooks.requireHmac` is on and no secret is stored, every delivery is unverified and stored
   as an invalid receipt. Rotate with
   `POST /api/v1/ESignature/connections/:id/secret` `{kind:'webhook_secret', value:'…'}` and update
   the Connect configuration at the provider **in the same maintenance window**.
4. `webhook.countsByState.retryable` means the queue accepted the delivery but applying it failed
   transiently; `dead_letter` means it failed the bounded attempt count. Follow §5.

Do not switch off `requireHmac` in production to "make deliveries flow". It is a debugging-only
setting and the health check names it.

## 3. Provider outage

**Symptom.** `checks.provider_errors` is red; one or more connections show a `lastErrorCode` and
`lastErrorAt` newer than `lastSuccessfulApiAt`. The gate may be closed; ordinary CRM screens are
unaffected.

**Safe action.**

1. Read `lastErrorCode` (a sanitized code, never a provider body). The runbook for the provider's
   status page applies; the CRM will not retry a send on its own.
2. Do **not** send, void, remind or reconcile in bulk during an outage. Those calls would fail or
   produce ambiguous outcomes and add noise to the queues.
3. When the provider is healthy again, use **Test Connection** on each connection. Successful calls
   update `lastSuccessfulApiAt`; only then resume deliberate sends.
4. Ambiguous sends that entered `send_unknown` during the outage are **reconciled**, one at a time
   (§4). A blind resend is how duplicates are made.

The workbench, module health and all non-ESignature CRM features read the database only, so this
screen and the rest of the CRM keep working while the provider is down.

## 4. Stuck, send_unknown and provider_error queues

| Queue | Meaning | Safe action |
| --- | --- | --- |
| **Stuck** | `sending` for more than 15 minutes, or an in-flight envelope (`sent`/`delivered`/`partially_signed`) with no projection for `staleAfterHours` (default 24) or past `expires_at`. | **Reconcile** the request. If reconciliation says the provider never took it, the request lands in `provider_error`; if it took it, the provider's state is projected. |
| **Send outcome unknown** | The send call lost its answer (`send_unknown`). | **Reconcile only.** The provider is the authority. |
| **Needs reconciliation** | A projection gap or an explicitly flagged drift. | **Reconcile**, then read the timeline. |
| **Provider errors** | A definite refusal (`provider_error`). | No reconcile and no workbench retry. Open the request, use the module's controlled **recover** path, then a *deliberate* new send — the send guard runs again, including approval. |
| **Failed module jobs** | Artifact retrieval or webhook application failed after its job attempts. | Artifact retrieval is idempotent and may be retried from `/admin/jobs`; webhook application should be retried with the delivery retry (§5) so the inbox row is the unit of work. |

`staleAfterHours` only changes which in-flight requests appear in the stuck list; it never changes
how an action behaves.

## 5. Dead-letter deliveries

**Symptom.** `webhook.countsByState.dead_letter > 0`; the delivery table shows `dead_letter` and a
safe error.

**Before retrying**, ask the queue:
- Is `signatureStatus` `verified`? An `invalid` receipt is evidence of a rejected POST and is
  **never** applied; the retry button is absent and the server refuses it.
- Is the failure transient (database timeout, queue lag) or permanent (malformed body, unknown
  envelope)? A permanent failure will dead-letter again; investigate the provider envelope and the
  request link first.

**Retry** (`POST …/operations/webhooks/:id/retry`) resets the bounded attempt window and re-applies
the same receipt. The dedup key and the projection's monotonic rules are untouched, so a repeated
click cannot create a second transition or artifact. Every retry writes a
`webhook.retryRequested` audit row with the previous state and the outcome. An `ignored` outcome for
an unknown envelope is a valid result: the event is preserved with no request binding.

## 6. Credential rotation

- **Client secret**: `POST /api/v1/ESignature/connections/:id/secret` with
  `{kind:'client_secret', value:'…'}`. The value is written to the vault and never returned. Rotate
  at the provider first, then here, in the same window; an old secret left behind is a credential
  that still exists.
- **Refresh/access tokens** are produced by the OAuth flow. Do not accept one from a user; there is
  no route that stores an arbitrary token.
- **Connect HMAC secret**: §2. Rotate at the provider and here together.
- `checks.credential_age` reports the oldest active credential. The runbook target is 180 days;
  exceeding it is a prompt to review, not an automatic break.

## 7. What the platform will not do on its own

- It will not retry a send. Ever.
- It will not apply an unverified delivery.
- It will not delete a dead-letter receipt, a provider event or a signed artifact as "cleanup".
- It will not call the provider to render diagnostics, so a provider outage cannot break the
  workbench or unrelated CRM features.
- It will not expose a token, a client secret, a signing URL or a webhook body in any view; the
  credential vault is read for metadata only.
