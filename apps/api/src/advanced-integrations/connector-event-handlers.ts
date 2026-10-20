import { Injectable } from '@nestjs/common';

/**
 * Phase 19-INT.19 / 19-INT.20 — the connector event handler registry
 * (`PLAN_Phase_19_Advanced_Integrations.md` §12.4, §12.5, §19-INT.25; `19-INT.19`, `19-INT.20`).
 *
 * Some provider events are **not** CRM records. A Stripe payment event is a *fact about money*
 * and belongs to the Sales domain service, which knows the financial invariants, writes the audit
 * trail and is idempotent. A Mailchimp unsubscribe is a *fact about consent* and belongs to
 * `MarketingSuppressionService`, which owns the suppression rules.
 *
 * The generic sync path must not apply those events itself: it would write a payment without the
 * Sales invariants, or write a contact without the consent evidence. So a provider may register a
 * **handler** that claims an event, and a claimed event is *not* applied generically.
 *
 * That is the whole mechanism, and it is deliberately small:
 *
 *  - a handler claims events by provider and event type;
 *  - the registry dispatches a claimed event to its handler and reports that it was handled;
 *  - an event nobody claimed follows the ordinary mapping path.
 *
 * The bridges that use it are **optional**. A deployment without the Sales module still loads the
 * Advanced Integrations module, and a Stripe delivery is then simply not claimed — it is recorded
 * as a receipt and left for an operator, rather than crashing the module.
 */

/** One provider event, as a handler sees it. */
export interface ConnectorProviderEvent {
  readonly providerKey: string;
  readonly connectionId: string;
  /** The provider's own delivery id, or a derived one. It is the idempotency key. */
  readonly deliveryId: string;
  readonly objectType: string;
  readonly eventType: string;
  readonly externalId: string | null;
  /** The event's payload, already reduced to what the connector emitted. */
  readonly fields: Readonly<Record<string, unknown>>;
  readonly occurredAt: string | null;
}

/**
 * A handler that claims a provider's events.
 *
 * `eventTypes` may end with `*` to claim a family (`payment_intent.*`).
 */
export interface ConnectorEventHandler {
  readonly providerKey: string;
  readonly eventTypes: readonly string[];
  handle(event: ConnectorProviderEvent): Promise<void>;
}

/** The registry of the module's handlers. */
@Injectable()
export class ConnectorEventHandlerRegistry {
  private readonly handlers: ConnectorEventHandler[] = [];

  /** Register a handler. A handler for the same provider and event type replaces the earlier one. */
  register(handler: ConnectorEventHandler): void {
    const index = this.handlers.findIndex(
      (existing) =>
        existing.providerKey === handler.providerKey &&
        existing.eventTypes.join(',') === handler.eventTypes.join(','),
    );
    if (index >= 0) {
      this.handlers[index] = handler;
      return;
    }
    this.handlers.push(handler);
  }

  /** Every registered handler. */
  all(): readonly ConnectorEventHandler[] {
    return [...this.handlers];
  }

  /**
   * Dispatch an event to the handler that claims it.
   *
   * Returns `true` when a handler claimed the event — in which case the caller must **not** apply
   * the event through the generic mapping path.
   */
  async dispatch(event: ConnectorProviderEvent): Promise<boolean> {
    for (const handler of this.handlers) {
      if (handler.providerKey !== event.providerKey) continue;
      if (!claims(handler.eventTypes, event.eventType)) continue;
      await handler.handle(event);
      return true;
    }
    return false;
  }
}

/** Whether a handler's declared types claim an event type. */
function claims(eventTypes: readonly string[], eventType: string): boolean {
  for (const declared of eventTypes) {
    if (declared === '*') return true;
    if (declared.endsWith('*')) {
      if (eventType.startsWith(declared.slice(0, -1))) return true;
      continue;
    }
    if (declared === eventType) return true;
  }
  return false;
}
