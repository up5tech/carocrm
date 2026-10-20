import { Inject, Injectable } from '@nestjs/common';

import { ConnectorEventHandlerRegistry } from './connector-event-handlers.js';
import { IntegrationContractRegistry } from './integration-contracts.js';
import { RecordOriginService } from './record-origin.service.js';

/**
 * Phase 19-INT.20 / 19-INT.25 — the Mailchimp consent bridge
 * (`PLAN_Phase_19_Advanced_Integrations.md` §12.5, §14.2; `19-INT.20`, `19-INT.25`).
 *
 * An external unsubscribe, a complaint and a hard bounce are **three different facts**, and the
 * plan requires each of them to reach `MarketingAutomation` *"promptly, using its explicit
 * contract"*. This bridge is that routing, through the
 * `marketing.consent.providerSuppression` contract.
 *
 * The contract maps the three facts onto the three suppression reasons the owner already
 * distinguishes:
 *
 *  | Mailchimp event | Suppression reason | Why |
 *  | --- | --- | --- |
 *  | `unsubscribe` | `GlobalOptOut` | The person asked not to be contacted. |
 *  | `unsubscribe` with a complaint reason | `Complaint` | The person reported the message. |
 *  | `cleaned` | `HardBounce` | The address is no longer deliverable. |
 *
 * Two properties make this safe:
 *
 *  - **The provider's own event id travels with the block.** The owner therefore records *where*
 *    the evidence came from, and a later report refreshes that evidence rather than creating a
 *    second row.
 *  - **The block outranks an ordinary profile sync.** `GlobalOptOut` and `Complaint` are not
 *    overridable in `MarketingAutomation`, so a later profile sync that would resubscribe the
 *    person cannot undo the block. The connector refuses that write as well (see
 *    `mailchimp.adapter.ts`), so the refusal holds on both sides of the boundary.
 *
 * When the `MarketingAutomation` module is not installed the contract is absent, the bridge says
 * so, and the delivery is left as a receipt for an operator.
 */
@Injectable()
export class MailchimpConsentBridge {
  constructor(
    @Inject(ConnectorEventHandlerRegistry) private readonly handlers: ConnectorEventHandlerRegistry,
    @Inject(IntegrationContractRegistry) private readonly contracts: IntegrationContractRegistry,
    @Inject(RecordOriginService) private readonly origins: RecordOriginService,
  ) {
    this.handlers.register({
      providerKey: 'mailchimp',
      eventTypes: ['audienceMember.unsubscribed', 'audienceMember.complained', 'audienceMember.bounced'],
      handle: async (event) => this.handle(event),
    });
  }

  /** Apply one Mailchimp event to the owner's suppression list. */
  private async handle(event: {
    connectionId: string;
    deliveryId: string;
    eventType: string;
    fields: Readonly<Record<string, unknown>>;
  }): Promise<void> {
    const email = typeof event.fields['email'] === 'string' ? event.fields['email'] : '';
    if (email.trim() === '') return;
    const reason =
      event.eventType === 'audienceMember.complained'
        ? 'Complaint'
        : event.eventType === 'audienceMember.bounced'
          ? 'HardBounce'
          : 'GlobalOptOut';
    const outcome = await this.contracts.apply<
      { emailAddress: string; reason: 'GlobalOptOut' | 'Complaint' | 'HardBounce'; providerEventId: string; provider: string },
      { id: string }
    >('marketing.consent.providerSuppression', {
      emailAddress: email,
      reason,
      providerEventId: event.deliveryId,
      provider: 'mailchimp',
    });
    if (outcome === null) return;
    // The same loop guard as the payment bridge: a record the owner changed because the provider
    // said so must not be pushed back to the provider.
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
