# webhook-integration

A backend extension package (PLAN §38): provider + controller + job + domain-event subscriber +
its own migration, with **no change to the core application**.

## What it contributes

| Contribution | Where |
|---|---|
| `WebhookEndpointService` provider | `src/endpoint.service.ts` |
| `/api/v1/WebhookEndpoint` controller (admin-only) | `src/endpoint.controller.ts` |
| `webhook.deliver` job handler | `src/delivery.ts` |
| `*` domain-event subscriber that queues a delivery per mutation | `src/index.ts` |
| `extension_webhook_endpoints`, `extension_webhook_deliveries` | `migrations/001_webhook_endpoints.sql` |
| "Webhooks" admin navigation entry | `manifest.json` → `frontend.nav` |

## Flow

```text
entity write → outbox event (entity.created/updated/deleted)
  → worker DomainEventBus → webhook-integration subscriber
  → webhook.deliver job (queue, retryable, cancellable in /admin/jobs)
  → POST https://… with X-Caro-Signature: sha256=<hmac>
  → one extension_webhook_deliveries row per endpoint
```

## Security decisions

- **Signing secrets are encrypted at rest** with the platform `ENCRYPTION_KEY` (AES-256-GCM) and are
  never returned by a read path — the API answers `hasSecret: true|false`.
- **SSRF protection** (PLAN §48): only `https`, no embedded credentials, and every address the
  hostname resolves to must be public — loopback, RFC1918, link-local and cloud-metadata ranges are
  refused. The check runs again on each delivery attempt, and redirects are not followed.
- **Admin-only**: registering an endpoint means the installation will contact that URL on its own
  initiative, so `POST/PUT/DELETE /api/v1/WebhookEndpoint` requires an administrator.

## Install

```bash
curl -X POST /api/v1/Extension/action/install -H "Authorization: Bearer $TOKEN" \
     -H 'Content-Type: application/json' -d '{"id":"webhook-integration"}'
# restart API + worker
```

No endpoint is created by the installer, so an installation that never registers one never makes an
outbound request.

## Building

```bash
pnpm --filter @carocrm-ext/webhook-integration build   # emits dist/index.js
# then set manifest.json -> backend.entry = "dist/index.js"
```

Development (`tsx`) and the test suite load `src/index.ts` as the manifest declares.
