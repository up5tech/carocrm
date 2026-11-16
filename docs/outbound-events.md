# Outbound events and webhook deliveries (Phase 24.8)

## D6 decision

No new CLI and no GraphQL endpoint. Integrators extend a single-tenant installation through
`packages/extension-sdk`, the `webhook-integration` module and the `api-spec/` registry. Every
public endpoint is documented in `api-spec/` before `pnpm ci:api-spec --strict` is enabled.

## Event catalogue (generic)

Events are emitted as domain events (`ExtensionDomainEventSubscription`,
`packages/extension-sdk/src/types/index.ts:40-45`) and delivered through the `webhook.deliver`
job. Stable names follow `<entity>.<verb>` (for example `Account.created`,
`Account.updated`, `Account.deleted`). A delivery payload is a JSON object:

```json
{
  "id": "<eventType>:<entityId>",
  "eventType": "Account.updated",
  "payload": {
    "entityType": "Account",
    "entityId": "<id>",
    "userId": "<id or null>",
    "version": 3
  }
}
```

`payload.version` is the payload version; the current version is `1`. Integrators must reject a
payload whose `version` they do not understand rather than guessing.

## Signature and replay

- The body is signed with HMAC-SHA256 over the **exact bytes** sent, using the endpoint secret:
  `x-caro-signature: sha256=<hex>`.
- `x-caro-delivery` carries an ISO-8601 timestamp; deliveries older than 5 minutes are rejected
  (replay window).
- A delivery id is derived from `eventType` + `entityId` (+ provider event id for provider
  webhooks), so a repeated delivery is recognised as the same delivery and is not applied twice.
- `x-caro-event` carries the event type.

## Delivery log, retry and dead letter

- Each attempt writes one row to the webhook delivery ledger (`webhook_integrations` migration),
  with endpoint, event type, status (`delivered`/`failed`/`skipped`), attempt count, response code
  and error.
- `webhook.deliver` runs in the worker with a 10 s timeout per endpoint. A transport failure or a
  5xx is re-thrown so BullMQ retries with backoff; a 4xx is recorded as failed and not retried.
- A provider that refuses a delivery is surfaced through the Advanced Integrations dead-letter
  table (`integration_dead_letters`) and can be replayed with
  `POST /api/v1/AdvancedIntegrations/action/dead-letters/:id/replay`.

## Single-tenant rule for extensions

One installation serves one organisation. An extension package must never process another
customer's data, must not assume a tenant id, and must run with `EXTENSION_TRUST_MODE=enforce`
and signed packages in production (Phase 23.6, G98). Extensions receive only the `ExtensionApi`
facade (database handle, job queue, scoped config, logger) — never the Nest container — so they
cannot reach kernel internals or bypass ACL.

## Typed client

`packages/api-client` is the typed client. It is consumed by at least one in-repo caller once the
`api-spec/` registry reaches `--strict` (24.4); until then it re-exports nothing and callers use
the documented REST contract. No GraphQL endpoint or second webhook framework exists.