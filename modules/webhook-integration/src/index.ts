import type { ExtensionApi, ExtensionBackend, ExtensionDb } from '@carocrm/extension-sdk';

import type { WebhookDeliveryPort } from './delivery.js';
import { deliverWebhook } from './delivery.js';
import { WebhookEndpointController } from './endpoint.controller.js';
import { WebhookEndpointService } from './endpoint.service.js';
import type { WebhookEndpointRow } from './shared.js';
import { decodeSecret, newEndpointId, parseEvents } from './shared.js';

/**
 * `webhook-integration` — a **backend** extension (Phase 14 acceptance).
 *
 * It contributes the full range an extension may have, and nothing more:
 *
 *  - a provider (`WebhookEndpointService`) and a controller under `/api/v1/WebhookEndpoint`;
 *  - a job handler (`webhook.deliver`) that the worker registers;
 *  - a domain-event subscriber that turns record mutations into queued deliveries;
 *  - its own SQL migration, applied by the installer and ledgered separately.
 *
 * Every value the extension touches is reached through the SDK facade and tokens, never by
 * importing the application, so the package stays installable next to any host version.
 */
export default {
  providers: [WebhookEndpointService],
  controllers: [WebhookEndpointController],

  jobs: [
    {
      name: 'webhook.deliver',
      handler: async (context) => deliverWebhook(context, requirePorts()),
    },
  ],

  domainEvents: [
    {
      eventType: '*',
      name: 'queue-delivery',
      handler: async (event) => {
        const payload = event.payload;
        const entityType = typeof payload['entityType'] === 'string' ? (payload['entityType'] as string) : undefined;
        const entityId = typeof payload['entityId'] === 'string' ? (payload['entityId'] as string) : undefined;
        if (entityType === undefined || entityId === undefined) return;
        // The job decides which endpoints (if any) subscribed; the subscriber only fans out
        // (PLAN §23.2 durable events + §24 queue).
        await requireEnqueue()(event.eventType, { entityType, entityId, userId: payload['userId'] ?? null });
      },
    },
  ],

  setup(api: ExtensionApi): void {
    ports = buildPorts(api);
    enqueue = async (eventType, payload) => api.enqueue('webhook.deliver', { eventType, payload });
    api.log.info({ id: api.id, version: api.version }, 'webhook integration ready');
  },
} satisfies ExtensionBackend;

/**
 * Worker-side wiring.
 *
 * The API process never runs these jobs, but both processes run `setup()`, so the ports are built
 * from the facade in either one. `setup()` always runs before a job can be picked up; a handler
 * that somehow runs earlier fails loudly instead of silently delivering nothing.
 */
let ports: WebhookDeliveryPort | undefined;
let enqueue: ((eventType: string, payload: Record<string, unknown>) => Promise<string>) | undefined;

function requirePorts(): WebhookDeliveryPort {
  if (ports === undefined) throw new Error('webhook.deliver ran before the webhook integration setup().');
  return ports;
}

function requireEnqueue(): (eventType: string, payload: Record<string, unknown>) => Promise<string> {
  if (enqueue === undefined) throw new Error('A webhook domain event arrived before the webhook integration setup().');
  return enqueue;
}

function buildPorts(api: ExtensionApi): WebhookDeliveryPort {
  const db: ExtensionDb = api.db;
  return {
    dueEndpoints: async (eventType) => {
      const rows = await db.query<WebhookEndpointRow>(
        'SELECT id, name, url, events, secret_encrypted, enabled, created_at, modified_at FROM extension_webhook_endpoints WHERE enabled = TRUE',
      );
      return rows.filter((row) => parseEvents(row.events).includes(eventType));
    },
    secretOf: (row) => decodeSecret(row),
    recordDelivery: async (input) => {
      await db.query(
        `INSERT INTO extension_webhook_deliveries (id, endpoint_id, event_type, payload, status, attempts, response_code, error, created_at, modified_at)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $9)`,
        [
          newEndpointId(),
          input.endpointId,
          input.eventType,
          JSON.stringify(input.payload),
          input.status,
          input.attempts ?? 1,
          input.responseCode ?? null,
          input.error ?? null,
          new Date(),
        ],
      );
    },
  };
}