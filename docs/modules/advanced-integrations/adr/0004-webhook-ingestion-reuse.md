# ADR 0004 — Webhook ingress: reuse, extend, or add

* **Status:** Accepted
* **Phase:** 19-INT.1 (decided), implemented in 19-INT.12
* **Related:** `docs/implementation/advanced-integrations-audit.md` §3.4 ·
  `docs/modules/advanced-integrations/feature-contract.md` §2

## Context

Three webhook-related things exist in the repository today:

| | Voice ingress | Marketing ingress | `modules/webhook-integration` |
| --- | --- | --- | --- |
| Route | `POST /api/v1/integrations/voice-communications/:providerKey/:accountKey/:kind` | `POST /api/v1/MarketingAutomation/webhook/:providerKey` | `GET/POST/PUT/DELETE /api/v1/WebhookEndpoint` |
| Direction | Inbound | Inbound | **Outbound** |
| Signature | Delegated to the provider adapter | Plain string equality of `x-webhook-signature` against `MARKETING_WEBHOOK_SECRET` | HMAC on the outbound body |
| Replay window | `WEBHOOK_REPLAY_WINDOW_MS = 5 min` | None — `x-webhook-timestamp` is accepted but never verified | n/a |
| Body ceiling | `WEBHOOK_MAX_BODY_BYTES = 256 KB` | None | n/a |
| Raw body | Contract only; never supplied | No | n/a |
| Dedup | Unique `(account_key, dedup_key)` | Unique `(provider, dedup_key)` | n/a |
| Receipt table | `voice_webhook_events` | `marketing_provider_webhook_inbox` | delivery ledger |

There is **no shared generic ingress**. The two inbound implementations use different route
shapes, different signature schemes and different deduplication, and they duplicate their payload
redaction helper (`redactPayload` exists in both `voice-communications-domain.ts:531` and
`marketing-event-ingestion.service.ts:297`).

## Decision

1. **Build a third, shared ingress** in `AdvancedIntegrations`, at
   `/api/v1/integrations/advanced-integrations/:providerKey/:connectionKey/:kind`. It is the ingress
   every connector shares.
2. **Do not migrate the Voice or Marketing ingresses.** They are live, provider-specific paths
   with their own semantics. Migrating them is unrelated scope for this module and would risk
   breaking live integrations.
3. **Do not copy the Marketing signature scheme.** A plain string comparison of a header against a
   shared secret is not a signature check. The shared ingress delegates verification to the
   **connector adapter** (`verifyWebhook`), exactly as the Voice ingress does, and the adapter
   chooses the algorithm. The platform never hard-codes one provider's scheme.
4. **Model the Voice ingress as the template** — it is the better of the two. It has: signature
   delegated to the adapter, a replay window, a body ceiling, idempotent dedup with a unique
   index, an operator-visible receipt table, and a shared redaction helper.
5. **Require raw-body capture.** The Fastify adapter is created without a raw-body plugin
   (`apps/api/src/bootstrap.ts:117`), so the bytes a provider signed are not currently available.
   Almost every real provider signs the exact bytes it sent. The shared ingress therefore requires
   a raw-body capture path, and the choice of mechanism is part of 19-INT.12's scope.
6. **Verify before any effect.** Signature verification happens before the receipt is written and
   before any job is enqueued. An unverified payload is rejected and **not** recorded as a
   processed event.
7. **Acknowledge fast, process asynchronously.** The endpoint verifies, writes a receipt, enqueues
   the processing job and acknowledges. A slow provider must never hold an HTTP connection open.

## Consequences

**Positive**

* Every connector gets one ingress with one reviewed security posture.
* The duplicated redaction helper is not duplicated a third time — the shared one is used.
* Voice and Marketing keep working exactly as they do.

**Negative**

* There are temporarily **three** webhook paths in the codebase. This is the cost of not
  destabilising live integrations; a consolidation is a separate, explicitly-scoped change.
* The raw-body requirement (unresolved dependency **U-1**) gates the shared ingress. Until it
  exists, a connector whose provider signs exact bytes cannot be implemented safely.

**Alternatives rejected**

| Alternative | Why rejected |
| --- | --- |
| Extend the Voice ingress | It is bound to voice's provider/account/kind model and its own tables. Generalising it in place would mean rewriting live telephony code. |
| Extend the Marketing ingress | Its signature check is a plain string comparison and it has no replay window or body ceiling. It is the weaker of the two and must not become the template. |
| Migrate both to the new ingress | Unrelated scope, live-integration risk, and it would change the URL contract of two deployed integrations. |
| One hard-coded HMAC scheme for all providers | Providers do not share a scheme, and the platform must not own provider-specific crypto. |
| Acknowledge and process inline | A slow provider would hold the connection open and invite provider-side timeouts and retries. |
