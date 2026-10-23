# Phase 19-ES.11 — DocuSign Connect Webhook Intake

> `PLAN_Phase_19_ESignature.md` §8.3, §10.1–§10.3, §12.1, §18 `Phase 19-ES.11`.
> Acceptance: an invalid webhook cannot change request state or create side effects; duplicate delivery
> creates no duplicate artifacts or notifications; an accepted event is durable before the success
> acknowledgement.
>
> Prerequisites read: `esignature-es2-completion-report.md` (the inbox and event tables),
> `esignature-es3-completion-report.md` (the HMAC kit and the adapter's verification contract),
> `esignature-es10-completion-report.md` (the send/reconcile states this intake feeds).

ES.11 makes the provider's word the only external source of status, and makes receiving that word safe:
verify the bytes, persist the delivery, acknowledge, and process it later under the module's own
authority.

---

## 1. Files

| File | What it owns |
| --- | --- |
| `esignature-webhook.controller.ts` | `POST /api/v1/integrations/esignature/:publicId`, public, raw-body only. `202` accepted/duplicate, `401` failed verification, `413` over the configured ceiling, `404` for a closed module or unknown routing id. |
| `esignature-webhook.service.ts` | `ingest` (verify → durable inbox → best-effort enqueue) and `processDelivery` (one transaction per delivery: event append, projection, audit, inbox state), plus a bounded `processPending` for the operator queue. |
| `esignature-jobs.ts` | The job names the API enqueues: `esignature.processProviderWebhook`, `esignature.retrieveCompletedArtifacts`. |
| `providers/signature-provider-signature.ts` | The documented Connect mechanism: base64 HMAC-SHA-256 over the raw body, `X-DocuSign-Signature-1` (plus the `-256` and fake candidates), constant-time comparison, multi-header acceptance. |
| `providers/docusign/docusign-adapter.ts` | `verifyAndParseWebhook`: verification first, then the modern `event` + `data.*` shape and the simplified shape; account mismatch refused after the signature is valid. |
| `bootstrap.ts` | Preserves the raw bytes for `/api/v1/integrations/esignature`; the parsed body for that prefix is replaced by an empty JSON object of the same length, so a malformed body reaches the adapter instead of being rejected by the framework (other routes keep strict JSON parsing). |
| `esignature.controller.ts` | `POST action/process-provider-webhook` — `@Public()` plus the shared `x-worker-secret` capability, run as the module's system principal. |
| `apps/worker/src/handlers/esignature-handlers.ts` | The worker job that calls the API endpoint; inert without a configured capability. |

**No migration.** ES.2's `signature_webhook_inbox` and `signature_provider_events` already carry the
unique dedup keys, verification result, minimized payload, processing states and purge deadline.

---

## 2. How each acceptance criterion is held

**An invalid webhook cannot change anything.** Verification precedes parsing: an invalid signature,
missing signature, missing secret, oversized body, malformed JSON, non-JSON content type or a provider
account that does not match the addressed connection returns `verified: false` with no envelope id. The
inbox stores the attempt with `signature_status = 'invalid'`, an empty minimized payload and state
`ignored`; no event is appended and no request is touched. The response never names which check failed.

**A duplicate creates nothing.** The inbox dedup key is the provider event id when supplied, otherwise
the provider, connection, envelope, event type and payload hash. The unique index makes a redelivery a
no-op; the response is `202 duplicate`, no job is enqueued and no second event row exists. The event
table has its own unique dedup key scoped by provider account (or connection), so a duplicate that
somehow reaches processing is still refused.

**Accepted is durable before success.** `ingest` writes the inbox row first and only then attempts the
queue hand-off. A queue failure is swallowed: the delivery stays `received` for the operator sweep,
and the provider still receives the acknowledgement. The inbox row, not the queue, is the record.

**Processing is separate and idempotent.** `processDelivery` answers an already-processed receipt instead
of replaying it. It appends the normalized event, applies the ES.12 mapper and the state machine inside
one transaction, marks the event applied/ignored/unmapped, marks the inbox processed/ignored and appends
`provider.event_accepted`. A transient failure is `retryable`, becomes `dead_letter` after five
attempts, and leaves a safe reason for the operator.

**Unknown envelopes are evidence.** A verified event whose envelope no request names is stored with
`request_id = NULL`, processing status `ignored` and the inbox reason `unknown_envelope`; it is visible to
the operator queue and never dropped.

---

## 3. Decisions taken here

- **The endpoint is off with the feature.** Module off or `features.webhooks` ineffective → `404`, no
  row is written. The routing id alone authenticates nothing; the account HMAC does.
- **The parsed body is discarded for this prefix only.** A tolerant JSON parser would weaken every API
  route. Replacing the parsed body with a same-length `{}` keeps Fastify's content-length check intact
  while the controller reads `rawBody`.
- **Queue failures do not fail the delivery.** Durable acceptance is the inbox; an enqueue is an
  optimisation, not the source of truth.
- **The worker route is a separate capability, not a user permission.** It is `@Public()`, compares
  `x-worker-secret` in constant time and runs under `runAsESignatureSystem`, so the audit trail says
  `system` for a projection.
- **HMAC headers accept a set, not one name.** DocuSign can emit numbered signature headers; any valid
  one is accepted, compared in constant time.

---

## 4. Verification

- `apps/api/test/esignature-lifecycle.test.ts` — valid delivery → delivered; duplicate (`202 duplicate`,
  one inbox row, one event); invalid signature; malformed body with a valid signature; misrouted account;
  unknown envelope; endpoint closed by the feature and by an unknown routing id.
- `apps/api/test/esignature-docusign.test.ts` — the live adapter's Connect parse (modern shape), account
  mismatch, signature header and minimized payload.
- Typecheck, lint and the web build were run for the phase; see the ES.16 report §4 for the combined run.

## 5. Still open

- The exact demo-account fixture (header spelling, payload shape, signature encoding) is ES.22's; the
  mechanism lives in one file so a correction is local.
- No scheduled sweep for `received` inbox rows is registered yet (ES.20 owns the operator workbench);
  `processPending` is the seam.
- An unknown routing id is not recorded, by design: an attacker cannot fill the inbox by guessing paths.
