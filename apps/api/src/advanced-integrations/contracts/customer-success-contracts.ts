import { Inject, Injectable, Optional } from '@nestjs/common';

import { CustomerSuccessProfileService } from '../../customer-success/customer-success-profile.service.js';
import { IntegrationContractRegistry } from '../integration-contracts.js';

/**
 * Phase 19-INT.25 — the `CustomerSuccess` contract
 * (`PLAN_Phase_19_Advanced_Integrations.md` §14.2, §19 `19-INT.25`).
 *
 * `CustomerSuccess` owns the customer health, the renewal tracking and the CSM assignment. The
 * compatibility document says it plainly: *"May sync approved fields; never computes CSM health."*
 *
 * So the contract this module publishes is deliberately narrow: it **ensures that a profile
 * exists** for an account, with the segment and the lifecycle stage the caller knows. It does not
 * compute a health score, and it does not assign a CSM — a connector has no business deciding
 * who owns a customer.
 *
 * The contract is optional: a deployment without `CustomerSuccess` publishes none of it.
 */

/** The input of the profile contract. */
export interface CustomerSuccessProfileInput {
  readonly accountId: string;
  /** The segment the provider reported, when it reported one. */
  readonly segment?: string | undefined;
  /** The lifecycle stage the provider reported, when it reported one. */
  readonly lifecycleStage?: string | undefined;
  /** The renewal date the provider reported, when it reported one. */
  readonly renewalDate?: string | undefined;
}

export interface CustomerSuccessProfileOutput {
  readonly id: string;
  /** True when the profile was created by this call. */
  readonly created: boolean;
}

@Injectable()
export class CustomerSuccessIntegrationContracts {
  constructor(
    @Inject(IntegrationContractRegistry) private readonly registry: IntegrationContractRegistry,
    @Optional()
    @Inject(CustomerSuccessProfileService)
    private readonly profiles: CustomerSuccessProfileService | null,
  ) {
    if (this.profiles !== null) {
      this.registry.register<CustomerSuccessProfileInput, CustomerSuccessProfileOutput>({
        contractKey: 'customerSuccess.profile.ensure',
        contractVersion: 1,
        owningModule: 'CustomerSuccess',
        ownership:
          'The customer profile, its lifecycle stage and its renewal tracking. A connector may report a segment; it may not compute a health score or assign a CSM.',
        apply: async (input) => {
          const profiles = this.profiles;
          if (profiles === null) throw new Error('The Customer Success module is not available.');
          const result = await profiles.ensureForAccount({
            accountId: input.accountId,
            ...(input.segment === undefined ? {} : { segment: input.segment }),
            ...(input.lifecycleStage === undefined ? {} : { lifecycleStage: input.lifecycleStage }),
            ...(input.renewalDate === undefined ? {} : { renewalDate: input.renewalDate }),
          });
          return { value: { id: result.id, created: result.created }, affectedRecords: [] };
        },
      });
    }
  }

  /** The contracts this module publishes. Used by the diagnostics. */
  static readonly publishedContractKeys: readonly string[] = ['customerSuccess.profile.ensure'];
}
