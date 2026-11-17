import { createHmac } from 'node:crypto';

import { DOMAIN_EVENT_TYPES, entityEventType } from '@carocrm/core/domain-events/index.js';
import type { JobContext } from '@carocrm/jobs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WebhookDeliveryPort } from '../../../modules/webhook-integration/src/delivery.js';
import { deliverWebhook } from '../../../modules/webhook-integration/src/delivery.js';
import type { WebhookEndpointRow } from '../../../modules/webhook-integration/src/shared.js';
import { parseEvents, signBody, SUPPORTED_EVENTS } from '../../../modules/webhook-integration/src/shared.js';

/**
 * Phase 24.8 — outbound webhook contract tests (DB-free).
 *
 * The `webhook-integration` extension is the generic outbound connector: entity domain events
 * fan out through the `webhook.deliver` job to admin-registered endpoints. These tests pin the
 * published contract an integrator relies on — stable event names, the delivery envelope, the
 * HMAC signature, the timestamp header and the retry boundary — so a refactor cannot silently
 * change what receivers see. Docs: docs/outbound-events.md.
 */

// A literal public IPv4 keeps assertPublicUrl off the DNS path, so the suite is hermetic.
const ENDPOINT_URL = 'https://93.184.216.34/hook';
const SECRET = 'test-signing-secret';

function endpointRow(events: string[]): WebhookEndpointRow {
  return {
    id: 'ep-1',
    name: 'test receiver',
    url: ENDPOINT_URL,
    events,
    secret_encrypted: 'encrypted',
    enabled: true,
    created_at: new Date('2026-01-01T00:00:00Z'),
    modified_at: new Date('2026-01-01T00:00:00Z'),
  };
}

function fakePort(rows: WebhookEndpointRow[]) {
  const deliveries: Array<Record<string, unknown>> = [];
  const port: WebhookDeliveryPort = {
    dueEndpoints: async () => rows,
    secretOf: () => SECRET,
    recordDelivery: async (input) => {
      deliveries.push(input as unknown as Record<string, unknown>);
    },
  };
  return { port, deliveries };
}

function jobContext(data: Record<string, unknown>): JobContext {
  return {
    data,
    progress: () => undefined,
    log: () => undefined,
    shouldStop: async () => false,
  };
}

const EVENT_PAYLOAD = {
  entityType: 'Account',
  entityId: 'acc-1',
  changed: ['name'],
  userId: 'user-1',
  version: 3,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('webhook event catalogue (Phase 24.8)', () => {
  it('the subscribable event names are exactly the domain event types the kernel emits', () => {
    expect([...SUPPORTED_EVENTS].sort()).toEqual([...Object.values(DOMAIN_EVENT_TYPES)].sort());
  });

  it('entityEventType maps every record mutation to a subscribable name', () => {
    expect(entityEventType('create')).toBe('entity.created');
    expect(entityEventType('update')).toBe('entity.updated');
    expect(entityEventType('delete')).toBe('entity.deleted');
    expect(entityEventType('restore')).toBe('entity.restored');
  });

  it('parseEvents accepts the jsonb array form the ledger stores', () => {
    expect(parseEvents('["entity.created","entity.updated"]')).toEqual(['entity.created', 'entity.updated']);
    expect(parseEvents(['entity.deleted'])).toEqual(['entity.deleted']);
    expect(parseEvents('not-json')).toEqual([]);
  });
});

describe('webhook.deliver contract', () => {
  it('posts the documented envelope with a verifiable signature and fresh timestamp', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { port, deliveries } = fakePort([endpointRow(['entity.updated'])]);

    const result = await deliverWebhook(
      jobContext({ eventType: 'entity.updated', payload: EVENT_PAYLOAD }),
      port,
    );

    expect(result).toEqual({ status: 'completed', result: { delivered: 1, failed: 0, endpoints: 1 } });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe(ENDPOINT_URL);
    const headers = init.headers as Record<string, string>;
    expect(headers['x-caro-event']).toBe('entity.updated');
    expect(headers['content-type']).toBe('application/json');

    // x-caro-delivery is an ISO-8601 timestamp inside the documented 5-minute replay window.
    const deliveredAt = Date.parse(headers['x-caro-delivery'] ?? '');
    expect(Number.isNaN(deliveredAt)).toBe(false);
    expect(Math.abs(Date.now() - deliveredAt)).toBeLessThan(5 * 60 * 1000);

    // The body is the documented envelope and the signature verifies over the exact bytes sent.
    const body = init.body as string;
    expect(JSON.parse(body)).toEqual({
      id: 'entity.updated:acc-1',
      eventType: 'entity.updated',
      payload: EVENT_PAYLOAD,
    });
    const expected = `sha256=${createHmac('sha256', SECRET).update(body, 'utf8').digest('hex')}`;
    expect(headers['x-caro-signature']).toBe(expected);
    expect(headers['x-caro-signature']).toBe(signBody(SECRET, body));

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ endpointId: 'ep-1', eventType: 'entity.updated', status: 'delivered', responseCode: 200 });
  });

  it('skips endpoints that did not subscribe to the event type', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    // dueEndpoints filters by subscription, so an unsubscribed event type yields no targets.
    const { port, deliveries } = fakePort([]);

    const result = await deliverWebhook(
      jobContext({ eventType: 'entity.deleted', payload: EVENT_PAYLOAD }),
      port,
    );
    expect(result).toEqual({ status: 'completed', result: { delivered: 0, endpoints: 0 } });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(deliveries).toHaveLength(0);
  });

  it('records an HTTP failure in the ledger without throwing (no BullMQ retry for answered requests)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('no', { status: 500 })));
    const { port, deliveries } = fakePort([endpointRow(['entity.created'])]);

    const result = await deliverWebhook(
      jobContext({ eventType: 'entity.created', payload: EVENT_PAYLOAD }),
      port,
    );

    expect(result).toEqual({ status: 'completed', result: { delivered: 0, failed: 1, endpoints: 1 } });
    expect(deliveries[0]).toMatchObject({ status: 'failed', responseCode: 500, error: 'HTTP 500' });
  });

  it('rethrows transport failures so BullMQ retries with backoff', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('connection refused'))));
    const { port, deliveries } = fakePort([endpointRow(['entity.created'])]);

    await expect(
      deliverWebhook(jobContext({ eventType: 'entity.created', payload: EVENT_PAYLOAD }), port),
    ).rejects.toThrow('connection refused');
    expect(deliveries[0]).toMatchObject({ status: 'failed', error: 'connection refused' });
  });

  it('fails loudly when the job payload carries no eventType', async () => {
    const { port } = fakePort([]);
    const result = await deliverWebhook(jobContext({ payload: EVENT_PAYLOAD }), port);
    expect(result.status).toBe('failed');
  });
});
