import { Inject, Injectable, Optional } from '@nestjs/common';

import { MarketingSuppressionService } from '../marketing-automation/marketing-suppression.service.js';
import { ConnectorEventHandlerRegistry, type ConnectorProviderEvent } from './connector-event-handlers.js';

/**
 * Phase 19-INT.20 — the Mailchimp consent bridge
 * (`PLAN_Phase_19_Advanced_Integrations.md` §12.5; `19-INT.20`).
 *
 * An external unsubscribe, a complaint and a hard bounce are **three different facts**, and the
 * plan requires each of them to reach `MarketingAutomation` *"promptly, using its explicit
 * contract"*. This bridge is that routing.
 *
 * It maps the three facts onto the three suppression reasons the module already distinguishes:
 *
 *  | Mailchimp event | Suppression reason | Why |
 *  | --- | --- | --- |
 *  | `unsubscribe` | `GlobalOptOut` | The person asked not to be contacted. |
 *  | `unsubscribe` with a complaint reason | `Complaint` | The person reported the message. |
 *  | `cleaned` | `HardBounce` | The address is no longer deliverable. |
 *
 * Two properties make this safe:
 *
 *  - **The provider's own event id travels with the block.** The suppression row therefore records
 *    *where* the evidence came from, and a later report refreshes that evidence rather than
 *    creating a second row.
 *  - **The block outranks an ordinary profile sync.** `GlobalOptOut` and `Complaint` are not
 *    overridable in `MarketingAutomation`, so a later profile sync that would resubscribe the
 *    person cannot undo the block. The connector refuses that write as well (see
 *    `mailchimp.adapter.ts`), so the refusal happens on both sides of the boundary.
 *
 * The bridge is **optional**: a deployment without `MarketingAutomation` still loads this module.
 */
@Injectable()
export class MailchimpConsentBridge {
  constructor(
    @Inject(ConnectorEventHandlerRegistry) private readonly registry: ConnectorEventHandlerRegistry,
    @Optional() @Inject(MarketingSuppressionService) private readonly suppression: MarketingSuppressionService | null,
  ) {
    if (this.suppression === null) return;
    this.registry.register({
      providerKey: 'mailchimp',
      eventTypes: ['audienceMember.unsubscribed', 'audienceMember.complained', 'audienceMember.bounced'],
      handle: async (event) => this.handle(event),
    });
  }

  /** Apply one Mailchimp event to the suppression list. */
  private async handle(event: ConnectorProviderEvent): Promise<void> {
    const suppression = this.suppression;
    if (suppression === null) return;
    const email = typeof event.fields['email'] === 'string' ? event.fields['email'] : '';
    if (email.trim() === '') return;
    const reason =
      event.eventType === 'audienceMember.complained'
        ? 'Complaint'
        : event.eventType === 'audienceMember.bounced'
          ? 'HardBounce'
          : 'GlobalOptOut';
    await suppression.add({
      emailAddress: email,
      channel: 'Email',
      scope: 'Global',
      reason,
      source: 'ProviderEvent',
      provider: 'mailchimp',
      providerEventId: event.deliveryId,
    });
  }
}
