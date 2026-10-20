import { Inject, Injectable, Optional } from '@nestjs/common';

import { CaseLifecycleService } from '../../service-desk/case-lifecycle.service.js';
import { IntegrationContractRegistry } from '../integration-contracts.js';

/**
 * Phase 19-INT.25 — the `ServiceDesk` contract
 * (`PLAN_Phase_19_Advanced_Integrations.md` §14.2, §19 `19-INT.25`).
 *
 * `ServiceDesk` owns the case lifecycle: the statuses, the allowed transitions, the resolution
 * codes and the transition history. A connector may report that a conversation happened; it may
 * not move a case.
 *
 * The contract therefore runs a **named transition** through the owner's own service, which
 * enforces the allowed transitions, the resolution requirements and the actor attribution. The
 * connector does not write a `Case` status.
 *
 * The contract is optional: a deployment without `ServiceDesk` publishes none of it.
 */

/** The input of the case transition contract. */
export interface ServiceDeskCaseTransitionInput {
  readonly caseId: string;
  /** The transition to run, e.g. `resolve` or `close`. */
  readonly command: string;
  /** The reason the transition happened, when one is required. */
  readonly reason?: string | undefined;
  /** The resolution code, when the case's settings require one. */
  readonly resolutionCode?: string | undefined;
  /** The summary, when the case's settings require one. */
  readonly summary?: string | undefined;
}

export interface ServiceDeskCaseTransitionOutput {
  readonly caseId: string;
  readonly fromStatus: string;
  readonly toStatus: string;
  readonly changed: boolean;
  readonly idempotent: boolean;
  readonly transitionId: string | null;
}

@Injectable()
export class ServiceDeskIntegrationContracts {
  constructor(
    @Inject(IntegrationContractRegistry) private readonly registry: IntegrationContractRegistry,
    @Optional() @Inject(CaseLifecycleService) private readonly lifecycle: CaseLifecycleService | null,
  ) {
    if (this.lifecycle !== null) {
      this.registry.register<ServiceDeskCaseTransitionInput, ServiceDeskCaseTransitionOutput>({
        contractKey: 'serviceDesk.case.transition',
        contractVersion: 1,
        owningModule: 'ServiceDesk',
        ownership:
          'The case lifecycle, the allowed transitions, the resolution codes and the transition history. A connector may report; it may not move a case.',
        apply: async (input) => {
          const lifecycle = this.lifecycle;
          if (lifecycle === null) throw new Error('The Service Desk module is not available.');
          const result = await lifecycle.run(input.caseId, input.command as never, {
            ...(input.reason === undefined ? {} : { reason: input.reason }),
            ...(input.resolutionCode === undefined ? {} : { resolutionCode: input.resolutionCode }),
            ...(input.summary === undefined ? {} : { summary: input.summary }),
          } as never);
          return {
            value: {
              caseId: result.caseId,
              fromStatus: result.from,
              toStatus: result.to,
              changed: result.changed,
              idempotent: result.idempotent,
              transitionId: result.transitionId,
            },
            // The case the owner changed. The integration module records its origin so the change
            // is not pushed back to the provider.
            affectedRecords: [{ entityType: 'Case', entityId: input.caseId }],
          };
        },
      });
    }
  }

  /** The contracts this module publishes. Used by the diagnostics. */
  static readonly publishedContractKeys: readonly string[] = ['serviceDesk.case.transition'];
}
