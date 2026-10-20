import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { assertConfigIsSafe } from '../src/advanced-integrations/advanced-integrations-domain.js';
import type { ConnectorContext } from '../src/advanced-integrations/connector-adapter.port.js';
import { assertConnectorContract, runConnectorContract } from '../src/advanced-integrations/connector-contract.js';
import { ConnectorRegistrar } from '../src/advanced-integrations/connector-registrar.service.js';
import { parseRestEnrichmentConfig } from '../src/advanced-integrations/connectors/enrichment/rest-enrichment.adapter.js';
import { GenericRestAdapter } from '../src/advanced-integrations/connectors/generic-rest/generic-rest.adapter.js';
import {
  assertGenericRestBaseUrl,
  parseGenericRestEndpoint,
} from '../src/advanced-integrations/connectors/generic-rest/generic-rest-endpoint.js';
import { GoogleWorkspaceAdapter } from '../src/advanced-integrations/connectors/google-workspace/google-workspace.adapter.js';
import { MailchimpAdapter } from '../src/advanced-integrations/connectors/mailchimp/mailchimp.adapter.js';
import { MetaLeadAdsAdapter } from '../src/advanced-integrations/connectors/meta-lead-ads/meta-lead-ads.adapter.js';
import { Microsoft365Adapter } from '../src/advanced-integrations/connectors/microsoft-365/microsoft-365.adapter.js';
import { QuickbooksOnlineAdapter } from '../src/advanced-integrations/connectors/quickbooks-online/quickbooks-online.adapter.js';
import { ShopifyAdapter } from '../src/advanced-integrations/connectors/shopify/shopify.adapter.js';
import { StripeAdapter, stripeEventSummary, stripeKeyMode } from '../src/advanced-integrations/connectors/stripe/stripe.adapter.js';
import { ZoomAdapter } from '../src/advanced-integrations/connectors/zoom/zoom.adapter.js';
import { IntegrationRegistry } from '../src/advanced-integrations/integration-registry.service.js';
import { ProviderError } from '../src/advanced-integrations/provider-error.js';

/**
 * Phase 19-INT.16–19-INT.24 — the connector tests
 * (`PLAN_Phase_19_Advanced_Integrations.md` §12, §17.1; `19-INT.16`–`19-INT.24`).
 *
 * These are **unit** tests: no database, no network, no clock. Every provider is reached through
 * an injected `fetch`, so a test can never open a socket, and the assertions are about behaviour
 * rather than about a live vendor.
 *
 * What is proved here:
 *
 *  - every delivered connector honours the connector contract;
 *  - a provider's signature is verified over the **exact bytes** it signed, and a tampered body, a
 *    stale timestamp and a missing header are all refused;
 *  - a duplicated webhook delivery is recognised as the same delivery;
 *  - the connectors that must not write do not write;
 *  - the generic REST connector refuses a private address, a non-https URL, a traversing path and
 *    a malformed answer.
 */

const PUBLIC_IP = '93.184.216.34';

const identity = (): { clientId: string; clientSecret: string | null } => ({
  clientId: 'test-client',
  clientSecret: 'test-secret',
});

/** A context for a connector that has no credential. */
function context(overrides: Partial<ConnectorContext> = {}): ConnectorContext {
  return {
    connectionId: 'conn-1',
    providerKey: 'test',
    credential: {
      accessToken: 'access-token',
      refreshToken: null,
      apiKey: null,
      clientSecret: null,
      expiresAt: null,
      webhookSecret: null,
    },
    tenantRef: null,
    options: {},
    grantedScopes: [],
    ...overrides,
  };
}

/** A `fetch` stub that answers with the given responses, in order. */
function stubFetch(responses: readonly { status?: number; body?: string; headers?: Record<string, string> }[]): {
  fetchImpl: typeof fetch;
  calls: { url: string; init: RequestInit | undefined }[];
} {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  let index = 0;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const answer = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return new Response(answer?.body ?? '', {
      status: answer?.status ?? 200,
      headers: answer?.headers ?? { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** A resolver that reports every host as a public address. */
const publicResolver = async (): Promise<string[]> => [PUBLIC_IP];

describe('the delivered connectors honour the connector contract', () => {
  const connectors = [
    new GoogleWorkspaceAdapter({ identity }),
    new Microsoft365Adapter({ identity }),
    new ZoomAdapter({ identity }),
    new StripeAdapter(),
    new MailchimpAdapter({ identity }),
    new MetaLeadAdsAdapter({ identity }),
    new ShopifyAdapter(),
    new QuickbooksOnlineAdapter({ identity }),
    new GenericRestAdapter(),
  ];

  for (const connector of connectors) {
    it(`${connector.providerKey} passes the conformance suite`, async () => {
      const failures = await runConnectorContract(connector);
      expect(failures).toEqual([]);
      expect(() => {
        assertConnectorContract(connector);
      }).not.toThrow();
    });
  }

  it('a deliberately broken connector is refused, so the rule set is real', async () => {
    const broken = new StripeAdapter();
    // A connector that claims a webhook it does not implement must fail the suite.
    Object.defineProperty(broken, 'operations', {
      value: { implementsFetch: true, implementsWrite: false, implementsDelete: false, implementsWebhook: false },
    });
    const failures = await runConnectorContract(broken);
    expect(failures.length).toBeGreaterThan(0);
  });
});

describe('the connector registrar publishes the catalog', () => {
  it('registers every delivered connector and keeps the fake provider out of production', () => {
    const registry = new IntegrationRegistry();
    const previous = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'test';
    try {
      const registrar = new ConnectorRegistrar(registry, {
        integrationOauthClientIds: '{}',
      } as never);
      registrar.registerAll();
    } finally {
      process.env['NODE_ENV'] = previous;
    }
    const keys = registry.all().map((definition) => definition.providerKey);
    expect(keys).toContain('google-workspace');
    expect(keys).toContain('microsoft-365');
    expect(keys).toContain('zoom');
    expect(keys).toContain('stripe');
    expect(keys).toContain('mailchimp');
    expect(keys).toContain('meta-lead-ads');
    expect(keys).toContain('shopify');
    expect(keys).toContain('quickbooks-online');
    expect(keys).toContain('generic-rest');
    expect(keys).toContain('fake-provider');
    // The fake provider fabricates answers, so it must never be offered in production.
    expect(registry.require('fake-provider').status).toBe('deprecated');
  });
});

describe('the Stripe connector verifies a webhook over the exact bytes it signed', () => {
  const secret = 'whsec_test';
  const payload = JSON.stringify({ id: 'evt_1', type: 'payment_intent.succeeded', data: { object: { id: 'pi_1' } } });

  function header(body: string, timestamp: number): string {
    const signature = createHmac('sha256', secret).update(`${String(timestamp)}.${body}`).digest('hex');
    return `t=${String(timestamp)},v1=${signature}`;
  }

  it('accepts a correctly signed delivery', async () => {
    const adapter = new StripeAdapter();
    const now = Date.now();
    const result = await adapter.verifyWebhook({
      context: context({ credential: { ...context().credential, webhookSecret: secret } }),
      rawBody: payload,
      headers: { 'stripe-signature': header(payload, Math.floor(now / 1000)) },
      body: JSON.parse(payload),
      query: {},
    });
    expect(result.valid).toBe(true);
  });

  it('refuses a body that was tampered with', async () => {
    const adapter = new StripeAdapter();
    const now = Math.floor(Date.now() / 1000);
    const result = await adapter.verifyWebhook({
      context: context({ credential: { ...context().credential, webhookSecret: secret } }),
      rawBody: `${payload} `,
      headers: { 'stripe-signature': header(payload, now) },
      body: JSON.parse(payload),
      query: {},
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('signature_mismatch');
  });

  it('refuses a delivery outside the replay window', async () => {
    const adapter = new StripeAdapter();
    const stale = Math.floor(Date.now() / 1000) - 4000;
    const result = await adapter.verifyWebhook({
      context: context({ credential: { ...context().credential, webhookSecret: secret } }),
      rawBody: payload,
      headers: { 'stripe-signature': header(payload, stale) },
      body: JSON.parse(payload),
      query: {},
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('stale_timestamp');
  });

  it('refuses a delivery without a signature at all', async () => {
    const adapter = new StripeAdapter();
    const result = await adapter.verifyWebhook({
      context: context({ credential: { ...context().credential, webhookSecret: secret } }),
      rawBody: payload,
      headers: {},
      body: JSON.parse(payload),
      query: {},
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('missing_signature');
  });

  it('uses the provider event id as the delivery id, so a repeat is a repeat', async () => {
    const adapter = new StripeAdapter();
    const events = await adapter.normalizeWebhook({
      context: context(),
      headers: {},
      body: JSON.parse(payload),
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.deliveryId).toBe('evt_1');
    expect(events[0]?.eventType).toBe('payment_intent.succeeded');
  });

  it('never carries card data into the summary a domain service receives', () => {
    const summary = stripeEventSummary('payment_intent.succeeded', {
      id: 'pi_1',
      status: 'succeeded',
      amount: 1000,
      currency: 'usd',
      client_secret: 'pi_secret_value',
      payment_method: { card: { number: '4242424242424242', cvc: '123' } },
    });
    expect(summary['client_secret']).toBeUndefined();
    expect(JSON.stringify(summary)).not.toContain('4242424242424242');
    expect(JSON.stringify(summary)).not.toContain('cvc');
  });

  it('separates the test mode from the live mode by the credential', () => {
    expect(stripeKeyMode('sk_test_abc')).toBe('test');
    expect(stripeKeyMode('sk_live_abc')).toBe('live');
    expect(stripeKeyMode('rk_live_abc')).toBe('live');
    expect(stripeKeyMode(null)).toBe('unknown');
  });

  it('refuses to write, so a charge can never be created through it', async () => {
    const adapter = new StripeAdapter();
    await expect(
      adapter.upsertObject({
        context: context(),
        objectType: 'paymentIntent',
        externalId: null,
        externalParentId: null,
        fields: {},
        idempotencyKey: null,
      }),
    ).rejects.toBeInstanceOf(ProviderError);
  });
});

describe('the Zoom connector verifies a webhook and does not duplicate a meeting', () => {
  const secret = 'zoom-secret';

  it('accepts a correctly signed delivery and refuses a stale one', async () => {
    const adapter = new ZoomAdapter({ identity });
    const body = JSON.stringify({ event: 'meeting.started', event_ts: 1700000000, payload: { object: { id: '123' } } });
    const now = Math.floor(Date.now() / 1000);
    const signature = createHmac('sha256', secret).update(`v1:${String(now)}:${body}`).digest('hex');
    const valid = await adapter.verifyWebhook({
      context: context({ credential: { ...context().credential, webhookSecret: secret } }),
      rawBody: body,
      headers: { 'x-zm-signature': `v1=${String(now)}:${signature}` },
      body: JSON.parse(body),
      query: {},
    });
    expect(valid.valid).toBe(true);

    const stale = now - 4000;
    const staleSignature = createHmac('sha256', secret).update(`v1:${String(stale)}:${body}`).digest('hex');
    const invalid = await adapter.verifyWebhook({
      context: context({ credential: { ...context().credential, webhookSecret: secret } }),
      rawBody: body,
      headers: { 'x-zm-signature': `v1=${String(stale)}:${staleSignature}` },
      body: JSON.parse(body),
      query: {},
    });
    expect(invalid.valid).toBe(false);
  });

  it('answers the endpoint validation challenge with the provider algorithm', async () => {
    const adapter = new ZoomAdapter({ identity });
    const result = await adapter.verifyWebhook({
      context: context({ credential: { ...context().credential, webhookSecret: secret } }),
      rawBody: null,
      headers: {},
      body: null,
      query: { plainToken: 'abc' },
    });
    expect(result.valid).toBe(true);
    expect(result.challenge).toBe(
      `${createHmac('sha256', secret).update('abc').digest('base64')}=`,
    );
  });

  it('reuses a meeting that already carries the operation marker instead of creating a second one', async () => {
    const { fetchImpl, calls } = stubFetch([
      {
        body: JSON.stringify({
          meetings: [
            {
              id: '999',
              topic: 'Existing',
              tracking_fields: [{ type: 'string', name: 'crm_operation_id', value: 'op-1' }],
            },
          ],
        }),
      },
    ]);
    const adapter = new ZoomAdapter({ identity, fetchImpl, resolveHost: publicResolver });
    const result = await adapter.upsertObject({
      context: context({ grantedScopes: ['meeting:write'] }),
      objectType: 'meeting',
      externalId: null,
      externalParentId: null,
      fields: { topic: 'Existing' },
      idempotencyKey: 'op-1',
    });
    expect(result.externalId).toBe('999');
    expect(result.created).toBe(false);
    // Only the listing was called: no meeting was created.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain('/meetings');
  });

  it('refuses a write the connection was not granted the scope for', async () => {
    const adapter = new ZoomAdapter({ identity });
    await expect(
      adapter.upsertObject({
        context: context({ grantedScopes: ['meeting:read'] }),
        objectType: 'meeting',
        externalId: null,
        externalParentId: null,
        fields: {},
        idempotencyKey: null,
      }),
    ).rejects.toMatchObject({ code: 'SCOPE_MISSING' });
  });
});

describe('the Shopify connector verifies a webhook over the raw body', () => {
  const secret = 'shopify-app-secret';
  const body = JSON.stringify({ id: 1, topic: 'orders/create', order_number: 1001 });

  it('accepts a correctly signed delivery and refuses a tampered one', async () => {
    const adapter = new ShopifyAdapter();
    const signature = createHmac('sha256', secret).update(body).digest('base64');
    const valid = await adapter.verifyWebhook({
      context: context({ credential: { ...context().credential, webhookSecret: secret } }),
      rawBody: body,
      headers: { 'x-shopify-hmac-sha256': signature },
      body: JSON.parse(body),
      query: {},
    });
    expect(valid.valid).toBe(true);

    const invalid = await adapter.verifyWebhook({
      context: context({ credential: { ...context().credential, webhookSecret: secret } }),
      rawBody: `${body} `,
      headers: { 'x-shopify-hmac-sha256': signature },
      body: JSON.parse(body),
      query: {},
    });
    expect(invalid.valid).toBe(false);
  });

  it('uses the provider event id as the delivery id', async () => {
    const adapter = new ShopifyAdapter();
    const events = await adapter.normalizeWebhook({
      context: context(),
      headers: { 'x-shopify-event-id': 'evt-1' },
      body: JSON.parse(body),
    });
    expect(events[0]?.deliveryId).toBe('evt-1');
    expect(events[0]?.eventType).toBe('orders/create');
  });

  it('refuses a connection that does not name a store', async () => {
    const adapter = new ShopifyAdapter();
    const result = await adapter.validateConnection(context());
    expect(result.ok).toBe(false);
    expect(result.code).toBe('CONFIGURATION_INVALID');
  });
});

describe('the Microsoft 365 connector follows a delta link and refuses a foreign one', () => {
  it('refuses a next link that points at another host', async () => {
    const { fetchImpl } = stubFetch([{ body: JSON.stringify({ value: [] }) }]);
    const adapter = new Microsoft365Adapter({ identity, fetchImpl, resolveHost: publicResolver });
    const foreign = Buffer.from(JSON.stringify({ nextLink: 'https://evil.example/steal' }), 'utf8').toString('base64url');
    await expect(
      adapter.fetchPage({
        context: context(),
        objectType: 'outlookEvent',
        cursor: foreign,
        pageSize: 10,
        since: null,
      }),
    ).rejects.toMatchObject({ detail: 'foreign_link' });
  });

  it('answers the Graph endpoint validation challenge', async () => {
    const adapter = new Microsoft365Adapter({ identity });
    const result = await adapter.verifyWebhook({
      context: context(),
      rawBody: null,
      headers: {},
      body: null,
      query: { validationToken: 'token-1' },
    });
    expect(result.valid).toBe(true);
    expect(result.challenge).toBe('token-1');
  });

  it('refuses a notification without the client state', async () => {
    const adapter = new Microsoft365Adapter({ identity });
    const result = await adapter.verifyWebhook({
      context: context({ options: { clientState: 'expected' } }),
      rawBody: null,
      headers: {},
      body: null,
      query: {},
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('missing_client_state');
  });

  it('derives a stable delivery id from the change, so a repeat is a repeat', async () => {
    const adapter = new Microsoft365Adapter({ identity });
    const body = [
      {
        subscriptionId: 'sub-1',
        resource: '/me/events',
        changeType: 'updated',
        resourceData: { id: 'evt-1' },
      },
    ];
    const first = await adapter.normalizeWebhook({ context: context(), headers: {}, body });
    const second = await adapter.normalizeWebhook({ context: context(), headers: {}, body });
    expect(first[0]?.deliveryId).toBe(second[0]?.deliveryId);
  });
});

describe('the Google Workspace connector keeps private events private', () => {
  it('never emits a private event unless the connection opted in', async () => {
    const { fetchImpl } = stubFetch([
      {
        body: JSON.stringify({
          items: [
            { id: 'e1', summary: 'Public', visibility: 'default', status: 'confirmed' },
            { id: 'e2', summary: 'Secret', visibility: 'private', status: 'confirmed', attendees: [{ email: 'a@b.test' }] },
          ],
        }),
      },
    ]);
    const adapter = new GoogleWorkspaceAdapter({ identity, fetchImpl, resolveHost: publicResolver });
    const page = await adapter.fetchPage({
      context: context(),
      objectType: 'calendarEvent',
      cursor: null,
      pageSize: 10,
      since: null,
    });
    expect(page.objects).toHaveLength(1);
    expect(page.objects[0]?.externalId).toBe('e1');
  });

  it('reports an expired sync token as a cursor that must be re-run', async () => {
    const { fetchImpl } = stubFetch([{ status: 410, body: '{}' }]);
    const adapter = new GoogleWorkspaceAdapter({ identity, fetchImpl, resolveHost: publicResolver });
    const changes = await adapter.fetchChanges({
      context: context(),
      objectType: 'calendarEvent',
      deltaToken: Buffer.from(JSON.stringify({ calendarIndex: 0, pageToken: null, syncToken: 'old' }), 'utf8').toString(
        'base64url',
      ),
      pageSize: 10,
    });
    expect(changes.cursorExpired).toBe(true);
  });
});

describe('the Mailchimp connector will not silently resubscribe a suppressed member', () => {
  it('refuses a resubscribe without consent evidence and accepts one with it', async () => {
    const { fetchImpl } = stubFetch([
      { body: JSON.stringify({ id: 'abc', email_address: 'a@b.test', status: 'unsubscribed' }) },
    ]);
    const adapter = new MailchimpAdapter({ identity, fetchImpl, resolveHost: publicResolver });
    const ctx = context({ tenantRef: 'us21', options: { audienceIds: ['list-1'] } });

    await expect(
      adapter.upsertObject({
        context: ctx,
        objectType: 'audienceMember',
        externalId: 'abc',
        externalParentId: 'list-1',
        fields: { status: 'subscribed' },
        idempotencyKey: null,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    const allowed = await adapter.upsertObject({
      context: ctx,
      objectType: 'audienceMember',
      externalId: 'abc',
      externalParentId: 'list-1',
      fields: { status: 'subscribed', consentEvidence: 'ticket-123' },
      idempotencyKey: null,
    });
    expect(allowed.externalId).toBe('abc');
  });

  it('distinguishes an unsubscribe, a complaint and a bounce', async () => {
    const adapter = new MailchimpAdapter({ identity });
    const unsubscribe = await adapter.normalizeWebhook({
      context: context(),
      headers: {},
      body: { type: 'unsubscribe', fired_at: '2026-01-01T00:00:00Z', data: { id: 'm1', list_id: 'l1', email: 'a@b.test' } },
    });
    expect(unsubscribe[0]?.eventType).toBe('audienceMember.unsubscribed');

    const complaint = await adapter.normalizeWebhook({
      context: context(),
      headers: {},
      body: {
        type: 'unsubscribe',
        fired_at: '2026-01-01T00:00:00Z',
        data: { id: 'm1', list_id: 'l1', email: 'a@b.test', unsubscribe_reason: 'spam' },
      },
    });
    expect(complaint[0]?.eventType).toBe('audienceMember.complained');

    const bounce = await adapter.normalizeWebhook({
      context: context(),
      headers: {},
      body: { type: 'cleaned', fired_at: '2026-01-01T00:00:00Z', data: { id: 'm1', list_id: 'l1', email: 'a@b.test' } },
    });
    expect(bounce[0]?.eventType).toBe('audienceMember.bounced');
  });

  it('refuses a connection that does not name a data centre', async () => {
    const adapter = new MailchimpAdapter({ identity });
    const result = await adapter.validateConnection(context());
    expect(result.ok).toBe(false);
    expect(result.code).toBe('CONFIGURATION_INVALID');
  });
});

describe('the Meta Lead Ads connector answers the endpoint validation challenge', () => {
  it('echoes the challenge back', async () => {
    const adapter = new MetaLeadAdsAdapter({ identity });
    const result = await adapter.verifyWebhook({
      context: context(),
      rawBody: null,
      headers: {},
      body: null,
      query: { 'hub.challenge': 'challenge-1' },
    });
    expect(result.valid).toBe(true);
    expect(result.challenge).toBe('challenge-1');
  });

  it('derives a stable delivery id from the change', async () => {
    const adapter = new MetaLeadAdsAdapter({ identity });
    const body = {
      entry: [{ id: 'page-1', changes: [{ field: 'leadgen', value: { lead_id: 'lead-1', form_id: 'form-1' } }] }],
    };
    const first = await adapter.normalizeWebhook({ context: context(), headers: {}, body });
    const second = await adapter.normalizeWebhook({ context: context(), headers: {}, body });
    expect(first[0]?.deliveryId).toBe(second[0]?.deliveryId);
    expect(first[0]?.externalId).toBe('lead-1');
  });
});

describe('the generic REST connector refuses an endpoint that is not safe', () => {
  const base = {
    baseUrl: 'https://api.example.test',
    paths: ['/items'],
    methods: ['GET'],
    authMode: 'none',
    itemsPointer: 'items',
    idPointer: 'id',
  };

  it('refuses a plain http URL', () => {
    expect(() => parseGenericRestEndpoint({ ...base, baseUrl: 'http://api.example.test' }, 'generic-rest')).toThrow(
      ProviderError,
    );
  });

  it('refuses a URL that carries credentials', () => {
    expect(() => parseGenericRestEndpoint({ ...base, baseUrl: 'https://user:pass@api.example.test' }, 'generic-rest')).toThrow(
      ProviderError,
    );
  });

  it('refuses a path that tries to escape the base URL', () => {
    expect(() => parseGenericRestEndpoint({ ...base, paths: ['/items/../../etc'] }, 'generic-rest')).toThrow(ProviderError);
  });

  it('refuses a path that is not in the allowlist', () => {
    expect(() => parseGenericRestEndpoint({ ...base, listPath: '/other' }, 'generic-rest')).toThrow(ProviderError);
  });

  it('refuses a cloud metadata address', async () => {
    await expect(
      assertGenericRestBaseUrl('https://metadata.google.internal/computeMetadata/v1/', 'generic-rest'),
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it('refuses a loopback address', async () => {
    await expect(assertGenericRestBaseUrl('https://127.0.0.1/secret', 'generic-rest')).rejects.toBeInstanceOf(
      ProviderError,
    );
  });

  it('refuses a malformed answer rather than half-reading it', async () => {
    const { fetchImpl } = stubFetch([{ body: JSON.stringify({ unexpected: true }) }]);
    const adapter = new GenericRestAdapter({ fetchImpl, resolveHost: publicResolver });
    await expect(
      adapter.fetchPage({
        context: context({ options: base }),
        objectType: 'restObject',
        cursor: null,
        pageSize: 10,
        since: null,
      }),
    ).rejects.toMatchObject({ detail: 'schema_mismatch' });
  });

  it('refuses an item that carries no identifier', async () => {
    const { fetchImpl } = stubFetch([{ body: JSON.stringify({ items: [{ name: 'no id' }] }) }]);
    const adapter = new GenericRestAdapter({ fetchImpl, resolveHost: publicResolver });
    await expect(
      adapter.fetchPage({
        context: context({ options: base }),
        objectType: 'restObject',
        cursor: null,
        pageSize: 10,
        since: null,
      }),
    ).rejects.toMatchObject({ detail: 'schema_mismatch' });
  });

  it('refuses to write, so no arbitrary outbound request is possible', async () => {
    const adapter = new GenericRestAdapter();
    await expect(
      adapter.upsertObject({
        context: context({ options: base }),
        objectType: 'restObject',
        externalId: null,
        externalParentId: null,
        fields: {},
        idempotencyKey: null,
      }),
    ).rejects.toBeInstanceOf(ProviderError);
  });
});

describe('the enrichment provider is bounded', () => {
  const config = {
    endpointUrl: 'https://enrich.example.test/v1/enrich',
    authMode: 'none',
    requestFieldMap: { email: 'email' },
    responseFieldMap: { company: 'company' },
  };

  it('refuses a configuration without a field map', () => {
    expect(() => parseRestEnrichmentConfig({ endpointUrl: config.endpointUrl })).toThrow(ProviderError);
  });

  it('refuses a plain http endpoint', () => {
    expect(() => parseRestEnrichmentConfig({ ...config, endpointUrl: 'http://enrich.example.test' })).toThrow(ProviderError);
  });

  it('refuses a loopback endpoint', () => {
    expect(() => parseRestEnrichmentConfig({ ...config, endpointUrl: 'https://localhost/enrich' })).toThrow(ProviderError);
  });
});

describe('a connector configuration never holds a credential', () => {
  it('the generic endpoint options survive the credential guard', () => {
    // The option names are part of the product's contract: a name that looks like a credential
    // would be refused by `assertConfigIsSafe` before it could ever be saved.
    const options = {
      baseUrl: 'https://api.example.test',
      paths: ['/items'],
      methods: ['GET'],
      authMode: 'header',
      authHeaderName: 'X-Api-Key',
      itemsPointer: 'items',
      idPointer: 'id',
    };
    expect(() => {
      assertConfigIsSafe({ ...options });
    }).not.toThrow();
    expect(() => {
      parseGenericRestEndpoint(options, 'generic-rest');
    }).not.toThrow();
  });

  it('a credential-shaped option name is still refused', () => {
    expect(() => {
      assertConfigIsSafe({ credentialHeader: 'X-Api-Key' });
    }).toThrow(/credential/i);
  });
});
