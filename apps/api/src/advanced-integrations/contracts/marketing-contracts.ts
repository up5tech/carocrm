import { Inject, Injectable, Optional } from '@nestjs/common';

import { MarketingConsentService } from '../../marketing-automation/marketing-consent.service.js';
import { MarketingSuppressionService } from '../../marketing-automation/marketing-suppression.service.js';
import { IntegrationContractRegistry } from '../integration-contracts.js';

/**
 * Phase 19-INT.25 — the `MarketingAutomation` contracts
 * (`PLAN_Phase_19_Advanced_Integrations.md` §12.5, §14.2; `19-INT.25`).
 *
 * `MarketingAutomation` owns consent and suppression. A connector may **report** what a provider
 * said about a person; it may never decide the consent state itself.
 *
 * Two contracts, and the difference between them matters:
 *
 *  - **a provider suppression** — the provider told us the person unsubscribed, complained, or
 *    bounced. The owner's own rules decide what that means, and the row records the provider's
 *    event id as the provenance. The provider's own status is *not* copied into a CRM field.
 *  - **a provider decision** — the provider confirmed a subscription. The owner's own rules
 *    decide whether that is a consent the CRM may act on: re-consent is affirmative and
 *    attributable, and a `Suppressed` state is not cleared by a provider's report alone.
 *
 * Both are optional: a deployment without `MarketingAutomation` publishes neither.
 */

/** The input of the provider suppression contract. */
export interface MarketingProviderSuppressionInput {
  /** The address the provider reported. */
  readonly emailAddress: string;
  /** Why the provider blocked the address. */
  readonly reason: 'GlobalOptOut' | 'Complaint' | 'HardBounce' | 'InvalidAddress';
  /** The provider's own event id. The provenance of the evidence. */
  readonly providerEventId?: string | undefined;
  /** The provider's key, e.g. `mailchimp`. */
  readonly provider?: string | undefined;
  /** The channel the block applies to. */
  readonly channel?: 'Email' | undefined;
}

export interface MarketingProviderSuppressionOutput {
  readonly id: string;
  readonly emailHash: string;
  readonly reason: string;
  readonly scope: string;
  readonly overridable: boolean;
}

/** The input of the provider consent decision contract. */
export interface MarketingProviderDecisionInput {
  readonly emailAddress: string;
  /** The status the provider reported. The owner decides what it means. */
  readonly reportedStatus: string;
  /** The provider's own event id, for idempotency. */
  readonly providerEventId?: string | undefined;
  /** The provider's key, e.g. `mailchimp`. */
  readonly provider?: string | undefined;
}

export interface MarketingProviderDecisionOutput {
  readonly consentId: string;
  readonly status: string;
  readonly changed: boolean;
  readonly idempotent: boolean;
}

@Injectable()
export class MarketingIntegrationContracts {
  constructor(
    @Inject(IntegrationContractRegistry) private readonly registry: IntegrationContractRegistry,
    @Optional() @Inject(MarketingSuppressionService) private readonly suppression: MarketingSuppressionService | null,
    @Optional() @Inject(MarketingConsentService) private readonly consent: MarketingConsentService | null,
  ) {
    if (this.suppression !== null) {
      this.registry.register<MarketingProviderSuppressionInput, MarketingProviderSuppressionOutput>({
        contractKey: 'marketing.consent.providerSuppression',
        contractVersion: 1,
        owningModule: 'MarketingAutomation',
        ownership:
          'The suppression list, the block scopes and the overridability rules. A provider may report that an address must not be contacted; it may not decide how strong that block is.',
        apply: async (input) => {
          const suppression = this.suppression;
          if (suppression === null) throw new Error('The Marketing Automation module is not available.');
          const view = await suppression.add({
            emailAddress: input.emailAddress,
            channel: input.channel ?? 'Email',
            scope: 'Global',
            reason: input.reason,
            source: 'ProviderEvent',
            ...(input.provider === undefined ? {} : { provider: input.provider }),
            ...(input.providerEventId === undefined ? {} : { providerEventId: input.providerEventId }),
          });
          return {
            value: {
              id: view.id,
              emailHash: view.emailHash,
              reason: view.reason,
              scope: view.scope,
              overridable: view.overridable,
            },
            affectedRecords: [],
          };
        },
      });
    }

    if (this.consent !== null) {
      this.registry.register<MarketingProviderDecisionInput, MarketingProviderDecisionOutput>({
        contractKey: 'marketing.consent.providerDecision',
        contractVersion: 1,
        owningModule: 'MarketingAutomation',
        ownership:
          'The consent state, its history and the rule that a re-consent is affirmative and attributable. A provider may report a status; it may not clear a suppression.',
        apply: async (input) => {
          const consent = this.consent;
          if (consent === null) throw new Error('The Marketing Automation module is not available.');
          // The owner's own vocabulary, not the provider's. A provider says "subscribed"; the owner
          // says "Consented" — and only "Consented" authorises a send, so the translation is the
          // owner's decision, not the connector's.
          const reported = input.reportedStatus.trim().toLowerCase();
          const status =
            reported === 'subscribed' || reported === 'pending'
              ? 'Consented'
              : reported === 'unsubscribed'
                ? 'OptedOut'
                : 'Unknown';
          const result = await consent.record({
            emailAddress: input.emailAddress,
            channel: 'Email',
            purpose: 'Newsletter',
            to: status,
            source: 'ProviderWebhook',
            ...(input.provider === undefined ? {} : { basis: input.provider }),
            ...(input.providerEventId === undefined
              ? {}
              : { idempotencyKey: `provider:${input.providerEventId}` }),
          });
          return {
            value: {
              consentId: result.consent.consentId,
              status: result.consent.status,
              changed: result.changed,
              idempotent: result.idempotent,
            },
            affectedRecords: [],
          };
        },
      });
    }
  }

  /** The contracts this module publishes. Used by the diagnostics. */
  static readonly publishedContractKeys: readonly string[] = [
    'marketing.consent.providerSuppression',
    'marketing.consent.providerDecision',
  ];
}
