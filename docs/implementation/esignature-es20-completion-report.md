# Phase 19-ES.20 — Admin Operations and Recovery Workbench

> `PLAN_Phase_19_ESignature.md` §14, §16, §18 `Phase 19-ES.20`.
> Acceptance: operators can diagnose common integration problems without secret exposure; manual
> retry is unavailable where it could create duplicate sends; a provider outage does not block
> unrelated CRM features.
>
> Prerequisites read: `esignature-es19-completion-report.md` (the report read model and its ACL
> predicate), `esignature-es12-completion-report.md` (reconciliation), `esignature-es11-completion-report.md`
> (the inbox and its states), and the platform's `jobs`/`job_logs` administration.

ES.20 adds the operator's side of the module: a redacted health and webhook diagnostics view, four
recovery queues, failed module jobs, five new health checks, one narrowly scoped retry command, and
the runbook that ties them together. There is **no new table or migration**.

---

## 1. Files

| File | What it owns |
| --- | --- |
| `apps/api/src/esignature/esignature-operations.service.ts` | The workbench read model: connection health, webhook diagnostics, recovery queues, failed jobs and the five ES.20 health checks. No provider call. |
| `apps/api/src/esignature/signature-operations.repository.ts` | SQL for the four request queues (under `requestAccessSql`), grouped counts per connection, and failed `esignature.%` jobs with an allowlisted payload projection. |
| `apps/api/src/esignature/signature-webhook_inbox.repository.ts` | Diagnostics counters, state-filtered lists, and `resetForRetry` (verified receipts only, fresh attempt window). |
| `apps/api/src/esignature/esignature-webhook.service.ts` | `retryDelivery`: capability, module/feature, verified-signature and state guards; runs the normal `processDelivery`; audits `webhook.retryRequested`. |
| `apps/api/src/esignature/esignature-module-health.service.ts` | Appends the ES.20 checks to `/action/health`. |
| `apps/api/src/esignature/esignature.controller.ts` | `GET /action/operations` and `POST /action/operations/webhooks/:id/retry`. |
| `apps/api/src/esignature/dto/esignature-shapes.ts` | `OperationsQuerySchema` (`staleAfterHours`, `limit`). |
| `apps/api/src/esignature/esignature-domain.ts` | Audit action `webhook.retryRequested`. |
| `apps/web/src/pages/esignature/ESignatureOperationsPanel.tsx` | The workbench UI: checks, connection health, webhook deliveries with retry, four queues with reconcile, failed jobs. |
| `apps/api/test/esignature-operations.test.ts` | The ES.20 acceptance suite. |
| `docs/runbooks/esignature-operations.md` | Token refresh, Connect setup, provider outage, credential rotation, dead-letter and reconciliation procedures. |

---

## 2. How each acceptance criterion is held

**Operators can diagnose without secret exposure.** Every field in the overview is a count, a
timestamp, a state, an opaque id or a credential *fact* (`hasRefreshToken`, `expiresAt`,
`configured`). The service reads `ESignatureCredentialVault.list` for metadata and never `read`; the
credential value is used only by the OAuth/adapter context paths. The suite stores a uniquely marked
client secret, refresh token, access token and webhook secret, then asserts neither the operations
response nor the module health response contains the value. Failed-job diagnostics additionally
project only `requestId`/`inboxId` from a job's untyped `target`, and strip URLs from the recorded
error text.

**Manual retry is unavailable where it could create duplicate sends.** The only retry command is
`POST …/operations/webhooks/:id/retry`, and it calls `processDelivery`, never an adapter send. It
refuses an `invalid` receipt by name and only accepts `retryable`/`dead_letter`; the inbox dedup key
and the state machine remain the idempotency boundary. Requests are offered **reconcile**, not retry:
`provider_error` rows explicitly report `reconcileAllowed: false`, because their only recovery is
the deliberate recover→send path on the request detail (which re-runs approval and the send guard).
The suite asserts the send-unknown row is reconcile-only and that a fictional
`/operations/requests/:id/retry` route is a 404.

**A provider outage does not block unrelated CRM features.** The workbench and health checks read
the database and credential metadata only; no provider request is made to render them, and a failed
health check is reported as data (`ok: false`) rather than thrown. The suite records a provider
error on the connection, then confirms the operations view and an ordinary `GET /Account` both
answer. The check `provider_errors` turns red and says so.

---

## 3. Definitions an operator relies on

- **Stuck** — `sending` for more than 15 minutes, or an in-flight request
  (`sent`/`delivered`/`partially_signed`) whose `coalesce(last_provider_sync_at, sent_at,
  modified_at)` is older than `staleAfterHours` (default 24), or whose `expires_at` has passed. The
  query parameter changes the list, never an action.
- **Failed** — `provider_error`. **Send unknown** — `send_unknown`. **Reconciliation** —
  `reconciliation_required`. These are disjoint status filters, not inferred categories.
- **Dead letter** — a webhook receipt that exhausted `MAX_PROCESSING_ATTEMPTS` (5). A manual retry
  resets the window; it does not change the dedup key or the signature verdict.
- **Webhook counters** — inbox states: `processed` (applied), `ignored` (verified but nothing to
  apply), `duplicate` (normalized event already recorded), `retryable`/`dead_letter` (application
  failed), and `invalid` signature receipts (never applied).
- **Connection health** — `blocked` when the connection is not `connected` or is inactive;
  `attention` when a redacted issue remains (token expiring/missing, no refresh token, no webhook
  secret, recent provider error, dead-letter/retryable deliveries); `ok` otherwise.
- **Credential age** — the oldest active credential's `rotatedAt` (or `createdAt`); the 180-day
  target is a runbook prompt, not an automatic disable.

---

## 4. Verification performed

| Check | Result |
| --- | --- |
| `pnpm vitest run apps/api/test/esignature-operations.test.ts` | **8/8 passed**. |
| `pnpm vitest run apps/api/test/esignature-*.test.ts` | **297/297 passed in 19 suites**. |
| `pnpm typecheck` | Passed (API + web). |
| `pnpm lint` | Passed for the changed files. |
| `pnpm --filter @carocrm/web build` | Passed. |
| Browser | The workbench renders checks, connection health, deliveries with retry, four queue tabs, reconcile actions and failed jobs; the module page shows it only for `connectionRead` holders (see the session log/screenshot). |
| Migration | **None** — ES.20 adds reads and one command over existing tables. |

Fixtures are created in the configured database with the `AGENT_TEST_es20_` marker and removed by
their own ids; the ESignature settings row is restored after the suite.

---

## 5. Known limitations / deferred

- **Automatic stuck-request reconciliation and inbox sweeping are not scheduled.** `processPending`
  and `reconcileSend` are the seams; registering the cron jobs is an operations policy decision and
  belongs with the scheduled-job administration rather than this phase. The workbench shows the
  backlog an operator would otherwise have to find.
- **Failed job retry is delegated to `/admin/jobs`.** Artifact retrieval is idempotent and safe to
  re-enqueue there; this module deliberately does not add a second job command surface, and no job
  retry can send an envelope.
- **Provider API latency/error-rate series, OAuth refresh failure counts, and webhook dead-letter
  age histograms** would require a metrics store. ES.20 reports the current state and 15-minute
  error recency; it does not introduce a second telemetry pipeline.
- **Connection-level request counts** are grouped reads over `signature_requests`; on an
  exceptionally large installation the workbench may eventually need an index on
  `(connection_id, status)` — the existing `idx_signature_requests_connection` already covers it.
- The raw provider payload is never shown, even to an audit reader. Diagnosis uses the minimized
  receipt, its hash, the safe error and the normalized event; the raw body is not retained by design
  (ES.11 §12.1).
