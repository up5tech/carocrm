import { Inject, Injectable } from '@nestjs/common';

import { LEADSCORE_MODULE_KEY } from './lead-score-domain.js';
import { leadScoreModuleDisabledError, leadScorePhasePendingError } from './lead-score-errors.js';
import {
  LEADSCORE_FEATURES,
  type LeadScoreCapabilityKey,
  type LeadScoreFeatureDescriptor,
} from './lead-score-module.js';
import { LeadScorePermissionService } from './lead-score-permission.service.js';
import { LeadScoreSettingsService } from './lead-score-settings.service.js';

/**
 * Phase 19-LS.1 — the single gate in front of every Lead Score operation
 * (`PLAN_Phase_19_LeadScore.md` §9.2, §15.2; audit §2, §9 D13).
 *
 * LS.1 ships no scoring and no conversion command. It ships the **answer** those commands will ask
 * for first, so that a later phase cannot forget one of the three questions and so that "nothing is
 * possible yet" is enforced in one place rather than remembered per endpoint:
 *
 * 1. does this caller hold the capability the operation needs (plan §9.1);
 * 2. is the module switched on at all (plan §15.2 stage 1);
 * 3. is the operation's own feature effective — which requires that its sub-phase has actually
 *    shipped, because a plan that describes a capability is not evidence that it exists (§0.1-4).
 *
 * `assess` never throws and is what the health view and the probe route report, so an operator can
 * see *why* something is closed. `assertOperation` is what a command calls before it touches a
 * record, a job or a provider.
 */

/**
 * The operations the module owns. The gate refuses one whose feature has not shipped, so a route cannot
 * forget the question; a later phase adds its own operation here rather than beside it.
 *
 * 19-LS.6 added `eventRecalculate`: the same write as `recalculateLead`, reached by nobody holding a session,
 * and therefore answering to a different switch. An operator who turns off event-driven recalculation has to
 * stop the jobs already in the queue, not only the ones that would be created next — a kill switch that only
 * applies to new work is a setting an administrator has to remember rather than one that works.
 */
export const LEADSCORE_OPERATIONS = [
  'readScore',
  'readScoreHistory',
  'recalculateLead',
  'eventRecalculate',
  'batchRecalculate',
  'validateModel',
  'createModelVersion',
  'previewModel',
  'publishModel',
  'conversionPreview',
  'conversionExecute',
  'conversionRetry',
  'aiInsight',
] as const;

export type LeadScoreOperation = (typeof LEADSCORE_OPERATIONS)[number];

interface OperationRule {
  /** The capability the caller must hold (plan §9.1). */
  readonly capability: LeadScoreCapabilityKey;
  /** The feature switch that must be effective for this operation to exist at all. */
  readonly feature: string;
  /**
   * Whether the operation performs a write. Refused the same way today, but the answer tells an
   * operator which closed door is the dangerous one (plan §2.2: no automatic conversion, ever).
   */
  readonly writes: boolean;
}

const OPERATION_RULES: Readonly<Record<LeadScoreOperation, OperationRule>> = {
  readScore: { capability: 'viewScore', feature: 'scoring', writes: false },
  readScoreHistory: { capability: 'explainScore', feature: 'scoreExplanation', writes: false },
  recalculateLead: { capability: 'recalculate', feature: 'manualRecalculation', writes: true },
  // The queued half of the same write, reached from a job rather than a session (19-LS.6).
  eventRecalculate: { capability: 'recalculate', feature: 'eventRecalculation', writes: true },
  batchRecalculate: { capability: 'batchRecalculate', feature: 'batchRecalculation', writes: true },
  validateModel: { capability: 'modelManage', feature: 'modelAdministration', writes: false },
  // A new draft version is a write, and it is the only way to change a published model (plan §5.1).
  createModelVersion: { capability: 'modelManage', feature: 'modelAdministration', writes: true },
  // A preview runs the evaluator over a bounded authorized sample and writes nothing: 19-LS.4 delivered it,
  // and it is the only door the engine opens until 19-LS.5 keeps a score.
  previewModel: { capability: 'modelManage', feature: 'scoringPreview', writes: false },
  publishModel: { capability: 'modelPublish', feature: 'modelAdministration', writes: true },
  conversionPreview: { capability: 'convertPreview', feature: 'conversionPreview', writes: false },
  conversionExecute: { capability: 'convertExecute', feature: 'leadConversion', writes: true },
  conversionRetry: { capability: 'conversionRecover', feature: 'conversionRecovery', writes: true },
  aiInsight: { capability: 'explainScore', feature: 'aiInsight', writes: true },
};

export interface LeadScoreOperationAssessment {
  readonly operation: LeadScoreOperation;
  readonly admitted: boolean;
  readonly capability: LeadScoreCapabilityKey;
  readonly feature: string;
  readonly writes: boolean;
  /** The sub-phase that implements the operation; `null` once it has shipped. */
  readonly pendingPhase: string | null;
  /** Stable refusal code, present only when the operation is not admitted. */
  readonly code: string | null;
  readonly detail: string | null;
}

@Injectable()
export class LeadScoreFeatureGate {
  constructor(
    @Inject(LeadScorePermissionService) private readonly permissions: LeadScorePermissionService,
    @Inject(LeadScoreSettingsService) private readonly settings: LeadScoreSettingsService,
  ) {}

  rule(operation: LeadScoreOperation): OperationRule {
    const rule = OPERATION_RULES[operation];
    if (rule === undefined) throw new Error(`Unknown LeadScore operation "${String(operation)}".`);
    return rule;
  }

  /** The sub-phase that still owes this operation, read from the feature table rather than repeated. */
  pendingPhaseOf(featureKey: string): string | null {
    const feature: LeadScoreFeatureDescriptor | undefined = LEADSCORE_FEATURES.find((entry) => entry.key === featureKey);
    return feature?.pendingPhase ?? null;
  }

  /**
   * Whether the operation would be admitted for this caller right now.
   *
   * Capability is asked first: a caller who may not see the operation must not learn the deployment
   * state behind it. The module switch is asked next, then the feature's own effective answer.
   */
  async assess(operation: LeadScoreOperation): Promise<LeadScoreOperationAssessment> {
    const rule = this.rule(operation);
    const pendingPhase = this.pendingPhaseOf(rule.feature);
    const base: Omit<LeadScoreOperationAssessment, 'admitted' | 'code' | 'detail'> = {
      operation,
      capability: rule.capability,
      feature: rule.feature,
      writes: rule.writes,
      pendingPhase,
    };
    if (!(await this.permissions.can(rule.capability))) {
      return { ...base, admitted: false, code: 'AUTHORIZATION_DENIED', detail: rule.capability };
    }
    const view = await this.settings.read();
    if (view.settings.enabled !== true) {
      return { ...base, admitted: false, code: 'LEADSCORE_MODULE_DISABLED', detail: LEADSCORE_MODULE_KEY };
    }
    if (pendingPhase !== null) {
      return { ...base, admitted: false, code: 'LEADSCORE_PHASE_PENDING', detail: pendingPhase };
    }
    if (view.effective[rule.feature] !== true) {
      return { ...base, admitted: false, code: 'LEADSCORE_MODULE_DISABLED', detail: `${LEADSCORE_MODULE_KEY}.${rule.feature}` };
    }
    return { ...base, admitted: true, code: null, detail: null };
  }

  /** The refusal an operation would hit, as an error rather than an answer. */
  async assertOperation(operation: LeadScoreOperation): Promise<void> {
    const rule = this.rule(operation);
    await this.permissions.assert(rule.capability);
    const view = await this.settings.read();
    if (view.settings.enabled !== true) {
      throw leadScoreModuleDisabledError(LEADSCORE_MODULE_KEY);
    }
    const pendingPhase = this.pendingPhaseOf(rule.feature);
    if (pendingPhase !== null) {
      throw leadScorePhasePendingError(operation, rule.feature, pendingPhase);
    }
    if (view.effective[rule.feature] !== true) {
      throw leadScoreModuleDisabledError(`${LEADSCORE_MODULE_KEY}.${rule.feature}`);
    }
  }

  /** Every operation with its current answer — the health view and the probe route both read this. */
  async assessAll(): Promise<readonly LeadScoreOperationAssessment[]> {
    const out: LeadScoreOperationAssessment[] = [];
    for (const operation of LEADSCORE_OPERATIONS) out.push(await this.assess(operation));
    return out;
  }
}
