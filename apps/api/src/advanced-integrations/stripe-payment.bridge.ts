import { Inject, Injectable } from '@nestjs/common';

import { ConnectorEventHandlerRegistry } from './connector-event-handlers.js';
import { stripeEventSummary } from './connectors/stripe/stripe.adapter.js';
import { IntegrationContractRegistry } from './integration-contracts.js';
import { RecordOriginService } from './record-origin.service.js';

/**
 * Phase 19-INT.19 / 19-INT.25 — the Stripe payment bridge
 * (`PLAN_Phase_19_Advanced_Integrations.md` §12.4, §14.2; `19-INT.19`, `19-INT.25`).
 *
 * A Stripe payment event is a fact about money, so it is applied through the **`Sales` contract**
 * `sales.payment.providerEvent` and **not** through the generic mapping path. That single
 * decision is what makes the plan's requirement true — *"Payment state is changed only through the
 * `Sales` domain service and an auditable external event"* — rather than aspirational.
 *
 * The contract gives everything the connector cannot:
 *
 *  - **idempotency**: the provider's own event id is the key, so a duplicate delivery changes
 *    nothing;
 *  - **the financial invariants**: a payment request moves from `pending` to `paid` or `failed`,
 *    and never out of a terminal state;
 *  - **the audit trail**: an event log row and an outbox event are written in the same
 *    transaction;
 *  - **the refusal of card data**: the owner refuses a payload that looks like card data, and the
 *    bridge therefore sends a *summary*, never the provider's raw object.
 *
 * When the `Sales` module is not installed the contract is absent, the bridge says so, and the
 * delivery is left as a receipt for an operator. Nothing crashes.
 */
@Injectable()
export class StripePaymentBridge {
  constructor(
    @Inject(ConnectorEventHandlerRegistry) private readonly handlers: ConnectorEventHandlerRegistry,
    @Inject(IntegrationContractRegistry) private readonly contracts: IntegrationContractRegistry,
    @Inject(RecordOriginService) private readonly origins: RecordOriginService,
  ) {
    this.handlers.register({
      providerKey: 'stripe',
      eventTypes: ['payment_intent.*', 'checkout.session.*'],
      handle: async (event) => this.handle(event),
    });
  }

  /** Apply one Stripe event through the `Sales` contract. */
  private async handle(event: {
    connectionId: string;
    deliveryId: string;
    eventType: string;
    fields: Readonly<Record<string, unknown>>;
  }): Promise<void> {
    const summary = stripeEventSummary(event.eventType, { ...event.fields });
    const paymentRequestId = typeof summary['paymentRequestId'] === 'string' ? summary['paymentRequestId'] : null;
    const outcome = await this.contracts.apply<
      { providerEventId: string; eventType: string; paymentRequestId?: string | null; payload?: Record<string, unknown> },
      { duplicate: boolean }
    >('sales.payment.providerEvent', {
      providerEventId: event.deliveryId,
      eventType: event.eventType,
      paymentRequestId,
      payload: summary,
    });
    // A missing contract means the owning module is not installed. The event stays as a receipt
    // and an operator decides what to do with it; the worker must not fail on it.
    if (outcome === null) return;
    // The event loop is prevented here. The owner changed a CRM record, that change produces a
    // domain event, and the outbound path would otherwise push the record back to the provider —
    // which would report the change again. Recording the origin marks it as the provider's own.
    for (const record of outcome.affectedRecords) {
      await this.origins.record({
        entityType: record.entityType,
        entityId: record.entityId,
        connectionId: event.connectionId,
        origin: 'inbound_sync',
        originRef: event.deliveryId,
      });
    }
  }
}
