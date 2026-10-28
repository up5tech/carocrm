import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runAsAdvancedIntegrationsSystem } from '../src/advanced-integrations/advanced-integrations-authority.js';
import { ConnectionLifecycleService } from '../src/advanced-integrations/connection-lifecycle.service.js';
import type { ConnectorAdapter } from '../src/advanced-integrations/connector-adapter.port.js';
import { IntegrationRegistry } from '../src/advanced-integrations/integration-registry.service.js';
import { REQUEST_SCOPE_TOKEN, type RequestScope } from '../src/common/request-scope.js';
import { EntityCrudService } from '../src/entity/entity.service.js';
import { PaymentService } from '../src/sales/payments/payment.service.js';
import type { ApiContext } from './support/boot-api.js';
import { bootApi, shutdownApi } from './support/boot-api.js';

/**
 * Phase 22.7 — the replay contract
 * (`PLAN_Phase_22_Integration_E2E_Hardening.md` §12 tasks 2, 3 and 6; required scenarios "same
 * webhook delivered at least twice", "an idempotency key is reused with a different request body").
 *
 * Runs against the configured primary database (AGENTS.md §3.1). Nothing is reset or truncated; every
 * row this run creates is deleted by exact id in `afterAll`. No provider is contacted: the marketing
 * door is a local secret, the connector door is a stub adapter, and the payment door is a service
 * call.
 *
 * The rule every door must keep: **a replay is answered safely and changes nothing.** It never
 * creates a second business effect, it never refuses the provider (which would make it retry
 * forever), and it never lets an unverified delivery pass as a replay of a verified one.
 */

const runId = Date.now().toString(36);
const MARKETING_SECRET = `p22-marketing-${runId}`;
const MARKETING_PROVIDER = `p22-marketing-${runId}`;
const CONNECTOR_PROVIDER_KEY = `agent-test-p22-${runId}`;
const WEBHOOK_SIGNATURE = 'p22-test-signature';

let ctx: ApiContext;
let scope: RequestScope;
let payments: PaymentService;
let connectorRegistry: IntegrationRegistry;
let connectionId = '';
let webhookKey = '';
let accountId = '';

function asSystem<T>(work: () => Promise<T>): Promise<T> {
  return runAsAdvancedIntegrationsSystem(scope, `test:${runId}`, work);
}

/** A connector that receives webhooks, with a fixed signature. */
const webhookAdapter: ConnectorAdapter = {
  providerKey: CONNECTOR_PROVIDER_KEY,
  adapterVersion: '1.0.0',
  providerApiVersion: '2026-01-01',
  capabilities: {
    schemaVersion: 1,
    authentication: 'api_key',
    objects: [
      {
        objectType: 'contact',
        label: 'Contact',
        read: true,
        create: false,
        update: true,
        delete: false,
        upsert: false,
        webhook: true,
        syncDirections: ['inbound'],
        fullSync: true,
        incrementalSync: false,
        requiredScopes: [],
        optionalScopes: [],
        maxPageSize: 100,
        rateLimitStrategy: 'unknown',
        externalIdFields: ['id'],
        uniqueFields: ['id'],
        deletionVisibility: 'tombstoned',
        transactional: true,
        dataSensitivity: 'business',
      },
    ],
    webhook: { supported: true, requiresRawBody: true, requiresEndpointValidation: false },
  },
  operations: {
    implementsFetch: true,
    implementsWrite: true,
    implementsDelete: false,
    implementsWebhook: true,
  },
  supportsAuthorization: false,
  supportsRefresh: false,
  supportsRevocation: false,
  getCapabilities: () => webhookAdapter.capabilities,
  validateConnection: async () => ({
    ok: true,
    code: null,
    message: null,
    accountRef: 'p22-account',
    grantedScopes: [],
  }),
  listObjectSchemas: async () => [
    {
      objectType: 'contact',
      label: 'Contact',
      incremental: false,
      maxPageSize: 100,
      fields: [
        { name: 'id', label: 'Id', type: 'string', required: true, unique: true, identifier: true, sensitive: false },
      ],
    },
  ],
  listFields: async () => [
    { name: 'id', label: 'Id', type: 'string', required: true, unique: true, identifier: true, sensitive: false },
  ],
  verifyWebhook: async (input) => {
    const signature = input.headers['x-test-signature'];
    if (signature !== WEBHOOK_SIGNATURE) {
      return { valid: false, reason: 'invalid_signature', challenge: null };
    }
    return { valid: true, reason: null, challenge: null };
  },
  normalizeWebhook: async (input) => {
    const body = input.body as { deliveryId?: string; externalId?: string; eventType?: string } | null;
    return [
      {
        deliveryId: body?.deliveryId ?? 'delivery-1',
        objectType: 'contact',
        externalId: body?.externalId ?? 'contact-1',
        eventType: body?.eventType ?? 'contact.updated',
        occurredAt: null,
        fields: { id: body?.externalId ?? 'contact-1', fullName: 'P22 Contact' },
        deleted: false,
      },
    ];
  },
};

async function marketingEvent(
  payload: Record<string, unknown>,
  signature = MARKETING_SECRET,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/MarketingAutomation/webhook/${MARKETING_PROVIDER}`,
    headers: {
      'content-type': 'application/json',
      'x-webhook-signature': signature,
      'x-webhook-timestamp': new Date().toISOString(),
    },
    payload,
  });
  let body: Record<string, unknown> = {};
  try {
    body = res.json() as Record<string, unknown>;
  } catch {
    body = {};
  }
  return { status: res.statusCode, body };
}

async function connectorWebhook(
  deliveryId: string,
  signature = WEBHOOK_SIGNATURE,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/integrations/advanced-integrations/${CONNECTOR_PROVIDER_KEY}/${webhookKey}/contact`,
    headers: { 'content-type': 'application/json', 'x-test-signature': signature },
    payload: { deliveryId, externalId: `contact-${deliveryId}`, eventType: 'contact.updated' },
  });
  let body: Record<string, unknown> = {};
  try {
    body = res.json() as Record<string, unknown>;
  } catch {
    body = {};
  }
  return { status: res.statusCode, body };
}

async function marketingRows(provider: string): Promise<{ inbox: number; events: number }> {
  const inbox = await sql<{ count: string }>`
    select count(*)::text as count from marketing_provider_webhook_inbox where provider = ${provider}
  `.execute(ctx.database.db);
  const events = await sql<{ count: string }>`
    select count(*)::text as count from marketing_events where provider = ${provider}
  `.execute(ctx.database.db);
  return { inbox: Number(inbox.rows[0]?.count ?? '0'), events: Number(events.rows[0]?.count ?? '0') };
}

beforeAll(async () => {
  process.env.MARKETING_WEBHOOK_SECRET = MARKETING_SECRET;
  ctx = await bootApi();
  scope = ctx.app.get(REQUEST_SCOPE_TOKEN);
  payments = ctx.app.get(PaymentService);
  connectorRegistry = ctx.app.get(IntegrationRegistry);

  connectorRegistry.register({
    providerKey: CONNECTOR_PROVIDER_KEY,
    displayName: 'Agent test Phase 22.7 connector',
    description: 'A connector that receives webhooks, used by the replay contract tests.',
    category: 'test',
    adapterVersion: webhookAdapter.adapterVersion,
    providerApiVersion: webhookAdapter.providerApiVersion,
    status: 'available',
    capabilities: webhookAdapter.capabilities,
    requiredScopes: [],
    optionalScopes: [],
    docsUrl: null,
    setupInstructionsKey: 'advancedintegrations.providers.setup',
    iconKey: 'ApiOutlined',
    adapter: webhookAdapter,
  });

  const lifecycle = ctx.app.get(ConnectionLifecycleService);
  const created = await asSystem(() =>
    lifecycle.create({
      providerKey: CONNECTOR_PROVIDER_KEY,
      name: `AGENT_TEST_p22_replay_${runId}`,
      ownerType: 'organization',
      ownerId: 'organization',
    }),
  );
  connectionId = created.id;
  // A draft connection is inert on purpose: a provider may only call through a usable one.
  await asSystem(() => lifecycle.transition(connectionId, 'pending_authorization'));
  await asSystem(() => lifecycle.transition(connectionId, 'connected', { grantedScopes: [] }));
  await asSystem(() => lifecycle.update(connectionId, { enabled: true }));
  const connection = await asSystem(() => lifecycle.get(connectionId));
  webhookKey = connection.webhookKey ?? '';

  const account = await asSystem(() =>
    ctx.app.get(EntityCrudService).create('Account', { name: `AGENT_TEST_p22_replay_${runId}` }),
  );
  accountId = String(account['id']);
});

afterAll(async () => {
  await sql`delete from marketing_provider_webhook_inbox where provider = ${MARKETING_PROVIDER}`.execute(ctx.database.db);
  await sql`delete from marketing_events where provider = ${MARKETING_PROVIDER}`.execute(ctx.database.db);
  await ctx.database.db.deleteFrom('integration_webhook_deliveries').where('connection_id', '=', connectionId).execute();
  await ctx.database.db.deleteFrom('integration_connections').where('id', '=', connectionId).execute();
  await ctx.database.db.deleteFrom('entity_records').where('id', '=', accountId).execute();
  await shutdownApi();
});

describe('the marketing webhook door', () => {
  it('answers a repeated delivery with a duplicate and creates no second effect', async () => {
    const payload = {
      eventId: `evt-${runId}-replay`,
      type: 'delivered',
      recipientEntityId: `${runId}-contact`,
      occurredAt: new Date().toISOString(),
    };
    const first = await marketingEvent(payload);
    expect(first.status).toBe(200);
    expect(first.body['processingStatus']).toBe('processed');
    expect(first.body['duplicate']).toBe(false);

    const replay = await marketingEvent(payload);
    expect(replay.status).toBe(200);
    // The answer is safe: the provider is told the event is known, so it stops retrying.
    expect(replay.body['duplicate']).toBe(true);

    const rows = await marketingRows(MARKETING_PROVIDER);
    expect(rows.inbox).toBe(1);
    expect(rows.events).toBe(1);
  });

  it('refuses a forged delivery that reuses a known key, without touching the genuine one', async () => {
    const eventId = `evt-${runId}-forged`;
    const genuine = {
      eventId,
      type: 'delivered',
      recipientEntityId: `${runId}-contact`,
      occurredAt: new Date().toISOString(),
    };
    const accepted = await marketingEvent(genuine);
    expect(accepted.body['processingStatus']).toBe('processed');

    // A forger replays the same key with a body of their own.
    const forged = await marketingEvent(
      { ...genuine, type: 'hard_bounce', emailHash: 'f'.repeat(64) },
      `${MARKETING_SECRET}-forged`,
    );
    expect(forged.status).toBe(200);
    // The forged delivery is refused, not welcomed as a replay of the genuine one.
    expect(forged.body['processingStatus']).toBe('rejected');
    expect(forged.body['duplicate']).toBe(false);

    const rows = await sql<{ id: string; signature_valid: boolean; processing_status: string; dedup_key: string }>`
      select id, signature_valid, processing_status, dedup_key
      from marketing_provider_webhook_inbox
      where provider = ${MARKETING_PROVIDER} and provider_event_id = ${eventId}
    `.execute(ctx.database.db);
    // The genuine row is untouched: still verified, still processed.
    const verified = rows.rows.find((row) => row.signature_valid);
    expect(verified?.processing_status).toBe('processed');
    expect(verified?.dedup_key).toBe(eventId);
    // And the rejection did not occupy the genuine key, so the genuine delivery can still arrive.
    const rejection = rows.rows.find((row) => !row.signature_valid);
    expect(rejection?.dedup_key).not.toBe(eventId);
    expect(rejection?.dedup_key.startsWith('rejected:')).toBe(true);
  });

  it('lets the genuine delivery through after a forged one tried its key', async () => {
    const eventId = `evt-${runId}-after-forgery`;
    const payload = {
      eventId,
      type: 'delivered',
      recipientEntityId: `${runId}-contact`,
      occurredAt: new Date().toISOString(),
    };
    const forged = await marketingEvent(payload, `${MARKETING_SECRET}-forged`);
    expect(forged.body['processingStatus']).toBe('rejected');

    const genuine = await marketingEvent(payload);
    expect(genuine.body['processingStatus']).toBe('processed');
    expect(genuine.body['duplicate']).toBe(false);
  });

  it('survives two deliveries of the same event arriving at the same time', async () => {
    const payload = {
      eventId: `evt-${runId}-concurrent`,
      type: 'delivered',
      recipientEntityId: `${runId}-contact`,
      occurredAt: new Date().toISOString(),
    };
    const before = await marketingRows(MARKETING_PROVIDER);
    const [first, second] = await Promise.all([marketingEvent(payload), marketingEvent(payload)]);
    // Both are answered — neither is a 500 the provider would retry forever.
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect([first.body['duplicate'], second.body['duplicate']].filter((value) => value === true)).toHaveLength(1);

    const after = await marketingRows(MARKETING_PROVIDER);
    // One event, one inbox row: the race produced one effect, not two.
    expect(after.events).toBe(before.events + 1);
    expect(after.inbox).toBe(before.inbox + 1);
  });

  it('does not apply a second body under a key it already knows', async () => {
    const eventId = `evt-${runId}-mutated`;
    const first = await marketingEvent({
      eventId,
      type: 'delivered',
      recipientEntityId: `${runId}-contact`,
      occurredAt: new Date().toISOString(),
    });
    expect(first.body['processingStatus']).toBe('processed');

    const before = await marketingRows(MARKETING_PROVIDER);
    // The same key with a different body: the body is discarded, the effect is not repeated.
    const mutated = await marketingEvent({
      eventId,
      type: 'hard_bounce',
      recipientEntityId: `${runId}-contact`,
      emailHash: 'e'.repeat(64),
      occurredAt: new Date().toISOString(),
    });
    expect(mutated.body['duplicate']).toBe(true);
    const after = await marketingRows(MARKETING_PROVIDER);
    expect(after.events).toBe(before.events);
  });
});

describe('the connector webhook door', () => {
  it('answers a repeated delivery as a duplicate and keeps one receipt', async () => {
    const deliveryId = `delivery-${runId}-1`;
    const first = await connectorWebhook(deliveryId);
    expect(first.status).toBe(202);
    expect(first.body['status']).not.toBe('duplicate');

    const replay = await connectorWebhook(deliveryId);
    expect(replay.status).toBe(202);
    expect(replay.body['status']).toBe('duplicate');

    const receipts = await ctx.database.db
      .selectFrom('integration_webhook_deliveries')
      .select('id')
      .where('connection_id', '=', connectionId)
      .where('delivery_id', '=', deliveryId)
      .execute();
    expect(receipts).toHaveLength(1);
  });

  it('answers a delivery that failed verification with 401, so the provider stops retrying it', async () => {
    const rejected = await connectorWebhook(`delivery-${runId}-bad`, 'not-the-signature');
    expect(rejected.status).toBe(401);
    expect(rejected.body['status']).toBe('rejected');
  });
});

describe('the payment provider event door', () => {
  it('lets only one of two concurrent deliveries settle the request', async () => {
    const request = await asSystem(() =>
      payments.createRequest({ amount: '50.00', currency: 'USD', accountId }),
    );
    const requestId = String(request['id']);
    const providerEventId = `evt-${runId}-concurrent`;

    const [first, second] = await Promise.all([
      asSystem(() =>
        payments.ingestProviderEvent({
          provider: 'stripe',
          providerEventId,
          eventType: 'payment_intent.succeeded',
          paymentRequestId: requestId,
        }),
      ),
      asSystem(() =>
        payments.ingestProviderEvent({
          provider: 'stripe',
          providerEventId,
          eventType: 'payment_intent.succeeded',
          paymentRequestId: requestId,
        }),
      ),
    ]);

    // Exactly one delivery was applied; the other is the duplicate it lost the race to.
    expect([first.duplicate, second.duplicate].filter((value) => value === false)).toHaveLength(1);

    const rows = await sql<{ count: string }>`
      select count(*)::text as count from entity_records
      where entity_type = 'PaymentProviderEventLog' and attrs->>'providerEventId' = ${providerEventId}
    `.execute(ctx.database.db);
    expect(Number(rows.rows[0]?.count ?? '0')).toBe(1);

    const settled = await asSystem(() =>
      ctx.app.get(EntityCrudService).get('PaymentRequest', requestId),
    );
    expect(settled['status']).toBe('paid');

    await ctx.database.db
      .deleteFrom('entity_records')
      .where('entity_type', '=', 'PaymentProviderEventLog')
      .where(sql`attrs ->> 'providerEventId'`, '=', providerEventId)
      .execute();
    await ctx.database.db.deleteFrom('entity_records').where('id', '=', requestId).execute();
  });
});
