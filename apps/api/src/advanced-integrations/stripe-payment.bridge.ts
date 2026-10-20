import { Inject, Injectable, Optional } from '@nestjs/common';

import { PaymentService } from '../sales/payments/payment.service.js';
import { ConnectorEventHandlerRegistry, type ConnectorProviderEvent } from './connector-event-handlers.js';
import { stripeEventSummary } from './connectors/stripe/stripe.adapter.js';

/**
 * Phase 19-INT.19 — the Stripe payment bridge
 * (`PLAN_Phase_19_Advanced_Integrations.md` §12.4; `19-INT.19`).
 *
 * A Stripe payment event is a fact about money, so it is applied through
 * `PaymentService.ingestProviderEvent` and **not** through the generic mapping path. That single
 * decision is what makes the plan's requirement true — *"Payment state is changed only through the
 * `Sales` domain service and an auditable external event"* — rather than aspirational.
 *
 * The domain service gives everything the connector cannot:
 *
 *  - **idempotency**: the provider's own event id is the key, so a duplicate delivery changes
 *    nothing;
 *  - **the financial invariants**: a payment request moves from `pending` to `paid` or `failed`,
 *    and never out of a terminal state;
 *  - **the audit trail**: an event log row and an outbox event are written in the same
 *    transaction;
 *  - **the refusal of card data**: the service refuses a payload that looks like card data, and
 *    the bridge therefore sends a *summary*, never the provider's raw object.
 *
 * The bridge is **optional**: a deployment without the Sales module still loads this module, and a
 * Stripe delivery is then recorded as a receipt and left for an operator rather than crashing
 * anything.
 */
@Injectable()
export class StripePaymentBridge {
  constructor(
    @Inject(ConnectorEventHandlerRegistry) private readonly registry: ConnectorEventHandlerRegistry,
    @Optional() @Inject(PaymentService) private readonly payments: PaymentService | null,
  ) {
    if (this.payments === null) return;
    this.registry.register({
      providerKey: 'stripe',
      eventTypes: ['payment_intent.*', 'checkout.session.*'],
      handle: async (event) => this.handle(event),
    });
  }

  /** Apply one Stripe event through the Sales domain service. */
  private async handle(event: ConnectorProviderEvent): Promise<void> {
    const payments = this.payments;
    if (payments === null) return;
    const summary = stripeEventSummary(event.eventType, { ...event.fields });
    const paymentRequestId = typeof summary['paymentRequestId'] === 'string' ? summary['paymentRequestId'] : null;
    await payments.ingestProviderEvent({
      provider: 'stripe',
      providerEventId: event.deliveryId,
      eventType: event.eventType,
      paymentRequestId,
      payload: summary,
    });
  }
}
