import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ConnectionLifecycleService } from '../src/advanced-integrations/connection-lifecycle.service.js';
import { ConnectorEventHandlerRegistry } from '../src/advanced-integrations/connector-event-handlers.js';
import { IntegrationContractRegistry } from '../src/advanced-integrations/integration-contracts.js';
import { ProviderError } from '../src/advanced-integrations/provider-error.js';
import { RecordOriginService } from '../src/advanced-integrations/record-origin.service.js';
import { REQUEST_SCOPE_TOKEN, type RequestScope } from '../src/common/request-scope.js';
import { EntityCrudService } from '../src/entity/entity.service.js';
import { PaymentService } from '../src/sales/payments/payment.service.js';
import type { ApiContext } from './support/boot-api.js';
import { bootApi, shutdownApi } from './support/boot-api.js';
import { FakePaymentDelivery, FakePaymentProvider } from './support/fake-payment-provider.js';

/**
 * Phase 22.6 — the payment provider contract
 * (`PLAN_Phase_22_Integration_E2E_Hardening.md` §11 tasks 3, 10; `docs/architecture/contract-catalog.md` §3).
 *
 * Runs against the configured primary database (AGENTS.md §3.1). Nothing is reset or truncated; the
 * records this run creates are deleted by id.
 *
 * This is the one cross-module edge that moves money, so it is exercised the way it runs in
 * production: a provider delivery → the connector's event handler → the **`Sales` contract**
 * `sales.payment.providerEvent` → the `Sales` payment service. The contract test proves:
 *
 *  - the provider's event id is the idempotency key, so a redelivery changes nothing;
 *  - a payment request never leaves a terminal state;
 *  - the owner of the change is recorded, so the outbound path does not push the change back;
 *  - a payload that carries card data is refused, and so is an event without the provider's id;
 *  - a delivery that failed — a timeout, a rate limit, an expired credential — changes nothing.
 */

const runId = Date.now().toString(36);

let ctx: ApiContext;
let scope: RequestScope;
let payments: PaymentService;
let contracts: IntegrationContractRegistry;
let handlers: ConnectorEventHandlerRegistry;
let origins: RecordOriginService;
let provider: FakePaymentProvider;
let accountId = '';
let connectionId = '';
const requestIds: string[] = [];

function asSystem<T>(work: () => Promise<T>): Promise<T> {
  return scope.runAs(
    { userId: 'system', userName: 'system', userType: 'system', roles: ['sysAdmin'], teams: [] },
    work,
    `phase22:${runId}`,
  );
}

/**
 * Hand one delivery to the platform.
 *
 * The delivery runs under the module's system authority, the way the worker-authorised route does
 * when a provider calls back: the contract belongs to `Sales`, and the caller is the platform.
 */
async function deliver(delivery: FakePaymentDelivery): Promise<boolean> {
  return await asSystem(() => provider.deliver(handlers, delivery));
}

/** A fresh payment request, in the state a provider would report money against. */
async function createPaymentRequest(amount = '100.00'): Promise<string> {
  const created = await asSystem(() =>
    payments.createRequest({ amount, currency: 'USD', accountId }),
  );
  const id = String(created['id']);
  requestIds.push(id);
  return id;
}

async function statusOf(paymentRequestId: string): Promise<string | undefined> {
  const record = await asSystem(() =>
    ctx.app.get(EntityCrudService).get('PaymentRequest', paymentRequestId),
  );
  const status = record['status'];
  return typeof status === 'string' ? status : undefined;
}

async function eventLogRows(providerEventId: string): Promise<number> {
  const rows = await ctx.database.db
    .selectFrom('entity_records')
    .select('id')
    .where('entity_type', '=', 'PaymentProviderEventLog')
    .where(sql`attrs ->> 'providerEventId'`, '=', providerEventId)
    .execute();
  return rows.length;
}

beforeAll(async () => {
  ctx = await bootApi();
  scope = ctx.app.get(REQUEST_SCOPE_TOKEN);
  payments = ctx.app.get(PaymentService);
  contracts = ctx.app.get(IntegrationContractRegistry);
  handlers = ctx.app.get(ConnectorEventHandlerRegistry);
  origins = ctx.app.get(RecordOriginService);

  // The origin of a change is recorded against a real connection: the row that stops the event loop
  // points at one, and a delivery without one could not be traced back to a provider.
  const connection = await asSystem(() =>
    ctx.app.get(ConnectionLifecycleService).create({
      providerKey: 'stripe',
      name: `AGENT_TEST_payment_connection_${runId}`,
      ownerType: 'organization',
      ownerId: 'organization',
    }),
  );
  connectionId = connection.id;
  provider = new FakePaymentProvider('stripe', connectionId);

  const account = await asSystem(() =>
    ctx.app.get(EntityCrudService).create('Account', {
      name: `AGENT_TEST_payment_${runId}`,
    }),
  );
  accountId = String(account['id']);
});

afterAll(async () => {
  if (requestIds.length > 0) {
    await ctx.database.db
      .deleteFrom('entity_records')
      .where('entity_type', '=', 'PaymentProviderEventLog')
      .where(sql`attrs ->> 'paymentRequestId'`, 'in', requestIds)
      .execute();
    await ctx.database.db
      .deleteFrom('entity_records')
      .where('entity_type', '=', 'PaymentRequest')
      .where('id', 'in', requestIds)
      .execute();
  }
  await ctx.database.db.deleteFrom('entity_records').where('id', '=', accountId).execute();
  await ctx.database.db
    .deleteFrom('integration_record_origins')
    .where('connection_id', '=', connectionId)
    .execute();
  await ctx.database.db.deleteFrom('integration_connections').where('id', '=', connectionId).execute();
  // The events this run published about the payment requests go with them.
  await ctx.database.db
    .deleteFrom('outbox_events')
    .where('event_type', '=', 'sales.payment.providerEvent')
    .where(sql`payload ->> 'providerEventId' like ${`${runId}-%`}`)
    .execute();
  await shutdownApi();
});

describe('the payment provider contract', () => {
  it('applies a provider payment event through the Sales contract, and the request becomes paid', async () => {
    const requestId = await createPaymentRequest();
    const delivery = provider.paymentIntentDelivery({
      deliveryId: `${runId}-paid-1`,
      paymentRequestId: requestId,
    });

    const claimed = await deliver(delivery);
    expect(claimed).toBe(true);
    expect(await statusOf(requestId)).toBe('paid');
    expect(await eventLogRows(delivery.deliveryId)).toBe(1);

    // The owner changed a CRM record, so the platform published an event about it.
    const events = await ctx.database.db
      .selectFrom('outbox_events')
      .select('payload')
      .where('event_type', '=', 'sales.payment.providerEvent')
      .where(sql`payload ->> 'providerEventId'`, '=', delivery.deliveryId)
      .execute();
    expect(events).toHaveLength(1);
  });

  it('records the origin of the change, so the outbound path does not push it back', async () => {
    const requestId = await createPaymentRequest();
    const delivery = provider.paymentIntentDelivery({
      deliveryId: `${runId}-origin-1`,
      paymentRequestId: requestId,
    });
    await deliver(delivery);

    const origin = await origins.find('PaymentRequest', requestId, delivery.connectionId);
    expect(origin?.origin).toBe('inbound_sync');
    expect(origin?.originRef).toBe(delivery.deliveryId);
  });

  it('changes nothing when the same delivery arrives twice', async () => {
    const requestId = await createPaymentRequest();
    const delivery = provider.paymentIntentDelivery({
      deliveryId: `${runId}-retry-1`,
      paymentRequestId: requestId,
    });

    await deliver(delivery);
    expect(await statusOf(requestId)).toBe('paid');

    const eventsBefore = await ctx.database.db
      .selectFrom('outbox_events')
      .select('id')
      .where('event_type', '=', 'sales.payment.providerEvent')
      .where(sql`payload ->> 'providerEventId'`, '=', delivery.deliveryId)
      .execute();

    // The redelivery is accepted and does nothing: the provider's event id is the idempotency key.
    await deliver(delivery);
    expect(await statusOf(requestId)).toBe('paid');
    expect(await eventLogRows(delivery.deliveryId)).toBe(1);

    const eventsAfter = await ctx.database.db
      .selectFrom('outbox_events')
      .select('id')
      .where('event_type', '=', 'sales.payment.providerEvent')
      .where(sql`payload ->> 'providerEventId'`, '=', delivery.deliveryId)
      .execute();
    expect(eventsAfter).toHaveLength(eventsBefore.length);
  });

  it('never moves a paid request out of its terminal state', async () => {
    const requestId = await createPaymentRequest();
    await deliver(provider.paymentIntentDelivery({ deliveryId: `${runId}-terminal-1`, paymentRequestId: requestId }));
    expect(await statusOf(requestId)).toBe('paid');

    // A later failure report for the same request is recorded, but it does not undo the payment.
    await deliver(
      provider.paymentIntentDelivery({
        deliveryId: `${runId}-terminal-2`,
        paymentRequestId: requestId,
        eventType: 'payment_intent.payment_failed',
        status: 'failed',
      }),
    );
    expect(await statusOf(requestId)).toBe('paid');
  });

  it('refuses a provider event without the provider\'s event id', async () => {
    const refusal = await asSystem(() =>
      contracts
        .apply('sales.payment.providerEvent', {
          providerEventId: '   ',
          eventType: 'payment_intent.succeeded',
        })
        .catch((error: unknown) => error),
    );
    expect(refusal).toBeInstanceOf(Error);
    expect((refusal as Error).message).toContain("provider's event id");
  });

  it('refuses a payload that carries card data', async () => {
    const refusal = await asSystem(() =>
      contracts
        .apply('sales.payment.providerEvent', {
          providerEventId: `${runId}-card-1`,
          eventType: 'payment_intent.succeeded',
          payload: { cardNumber: '4111111111111111' },
        })
        .catch((error: unknown) => error),
    );
    expect(refusal).toBeInstanceOf(Error);
    expect(await eventLogRows(`${runId}-card-1`)).toBe(0);
  });

  it('changes nothing when the delivery itself failed', async () => {
    const requestId = await createPaymentRequest();
    const delivery = provider.paymentIntentDelivery({
      deliveryId: `${runId}-timeout-1`,
      paymentRequestId: requestId,
    });

    provider.failNextDelivery(
      new ProviderError('TIMEOUT', 'The provider did not answer in time.', {
        category: 'transient',
        retryable: true,
        detail: 'timeout',
      }),
    );
    const failure = await deliver(delivery).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProviderError);
    expect((failure as ProviderError).category).toBe('transient');

    // The request is untouched: a delivery that never arrived is not a fact about money.
    expect(await statusOf(requestId)).toBe('pending');
    expect(await eventLogRows(delivery.deliveryId)).toBe(0);
  });

  it('changes nothing when the provider answered with a rate limit or an expired credential', async () => {
    const requestId = await createPaymentRequest();

    provider.failNextDelivery(
      new ProviderError('RATE_LIMITED', 'Slow down.', {
        category: 'rate_limited',
        retryable: true,
        retryAfterMs: 1_000,
        detail: 'rate_limited',
      }),
    );
    const rateLimited = await deliver(
      provider.paymentIntentDelivery({ deliveryId: `${runId}-rate-1`, paymentRequestId: requestId }),
    ).catch((error: unknown) => error);
    expect((rateLimited as ProviderError).category).toBe('rate_limited');

    provider.failNextDelivery(
      new ProviderError('TOKEN_EXPIRED', 'The token expired.', {
        category: 'authorization',
        retryable: false,
        detail: 'token_expired',
      }),
    );
    const expired = await deliver(
      provider.paymentIntentDelivery({ deliveryId: `${runId}-auth-1`, paymentRequestId: requestId }),
    ).catch((error: unknown) => error);
    expect((expired as ProviderError).category).toBe('authorization');

    expect(await statusOf(requestId)).toBe('pending');
  });
});
