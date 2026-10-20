import { Inject, Injectable, Optional } from '@nestjs/common';

import { VoiceConsentService } from '../../voice-communications/voice-consent.service.js';
import { IntegrationContractRegistry } from '../integration-contracts.js';

/**
 * Phase 19-INT.25 — the `VoiceCommunications` contract
 * (`PLAN_Phase_19_Advanced_Integrations.md` §14.2, §19 `19-INT.25`).
 *
 * `VoiceCommunications` owns communication delivery, and with it the opt-outs: a person who asked
 * a number not to be called must not be called by anything, including a connector.
 *
 * The contract therefore does one thing: it records a **suppression** on the channel and address
 * the provider reported. It does not send anything, and it does not decide that a message is
 * deliverable — that is the owner's job.
 *
 * The contract is optional: a deployment without `VoiceCommunications` publishes none of it.
 */

/** The input of the voice suppression contract. */
export interface VoiceSuppressionInput {
  /** The channel the provider reported, e.g. `sms` or `voice`. */
  readonly channel: string;
  /** The address the provider reported. */
  readonly address: string;
  /** Why the provider blocked the address. */
  readonly reason: string;
  /** The provider's key, e.g. `mailchimp`. */
  readonly provider?: string | undefined;
}

export interface VoiceSuppressionOutput {
  readonly id: string;
  readonly channel: string;
  readonly address: string;
  readonly reason: string;
}

@Injectable()
export class VoiceCommunicationsIntegrationContracts {
  constructor(
    @Inject(IntegrationContractRegistry) private readonly registry: IntegrationContractRegistry,
    @Optional() @Inject(VoiceConsentService) private readonly consent: VoiceConsentService | null,
  ) {
    if (this.consent !== null) {
      this.registry.register<VoiceSuppressionInput, VoiceSuppressionOutput>({
        contractKey: 'voiceCommunications.consent.suppress',
        contractVersion: 1,
        owningModule: 'VoiceCommunications',
        ownership:
          'Communication delivery and the opt-out list. A connector may report that an address must not be contacted; it may not send anything and it may not deliver a message.',
        apply: async (input) => {
          const consent = this.consent;
          if (consent === null) throw new Error('The Voice Communications module is not available.');
          const view = await consent.suppress({
            channel: input.channel as never,
            address: input.address,
            reason: input.reason as never,
            source: 'provider_webhook',
          });
          return {
            value: {
              id: view.id,
              channel: view.channel,
              address: view.address,
              reason: view.reason,
            },
            affectedRecords: [],
          };
        },
      });
    }
  }

  /** The contracts this module publishes. Used by the diagnostics. */
  static readonly publishedContractKeys: readonly string[] = ['voiceCommunications.consent.suppress'];
}
