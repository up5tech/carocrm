import type { ConnectorEventHandlerRegistry, ConnectorProviderEvent } from '../../src/advanced-integrations/connector-event-handlers.js';
import type { ProviderError } from '../../src/advanced-integrations/provider-error.js';

/**
 * Phase 22.6 — a fake payment provider.
 *
 * The CRM's payment boundary is the provider's **event**, not a gateway object: a provider reports
 * what happened to a payment, and the `Sales` domain decides what that means. So the fake here
 * produces provider events and can be scripted to fail the way a provider fails by accident — a
 * timeout, a rate-limit answer, an expired credential — which is what a contract test needs to prove
 * that a delivery that never arrived changes nothing.
 *
 * It is a **test double for an external boundary only**: it does not decide anything about money,
 * it does not touch the database, and the domain rules it exercises are the platform's own.
 */

/** One provider delivery, as the handler registry sees it. */
export type FakePaymentDelivery = ConnectorProviderEvent;

/** The options of one scripted payment delivery. */
export interface FakePaymentDeliveryInput {
  readonly deliveryId: string;
  readonly paymentRequestId?: string | undefined;
  readonly eventType?: string | undefined;
  readonly amount?: number | undefined;
  readonly currency?: string | undefined;
  readonly status?: string | undefined;
}

export class FakePaymentProvider {
  /** Every delivery that was handed to the registry, for the assertions about what was sent. */
  readonly deliveries: FakePaymentDelivery[] = [];
  private failure: ProviderError | null = null;

  constructor(
    private readonly providerKey = 'stripe',
    private readonly connectionId = 'agent-test-connection',
  ) {}

  /** Make the next delivery fail the way a provider fails. */
  failNextDelivery(error: ProviderError): void {
    this.failure = error;
  }

  /** The delivery of a Stripe payment intent, shaped as Stripe sends it. */
  paymentIntentDelivery(input: FakePaymentDeliveryInput): FakePaymentDelivery {
    const metadata =
      input.paymentRequestId === undefined
        ? {}
        : { crm_payment_request_id: input.paymentRequestId };
    return {
      providerKey: this.providerKey,
      connectionId: this.connectionId,
      deliveryId: input.deliveryId,
      objectType: 'payment_intent',
      eventType: input.eventType ?? 'payment_intent.succeeded',
      externalId: `pi_${input.deliveryId}`,
      fields: {
        id: `pi_${input.deliveryId}`,
        amount: input.amount ?? 10_000,
        currency: input.currency ?? 'usd',
        status: input.status ?? 'succeeded',
        metadata,
      },
      occurredAt: '2026-10-28T09:00:00.000Z',
    };
  }

  /**
   * Hand one delivery to the handler registry.
   *
   * A scripted failure is raised **before** the delivery is handed over, so a failed delivery leaves
   * the CRM exactly as it was — which is the whole point of the failure cases.
   */
  async deliver(registry: ConnectorEventHandlerRegistry, delivery: FakePaymentDelivery): Promise<boolean> {
    if (this.failure !== null) {
      const error = this.failure;
      this.failure = null;
      throw error;
    }
    this.deliveries.push(delivery);
    return await registry.dispatch(delivery);
  }
}
