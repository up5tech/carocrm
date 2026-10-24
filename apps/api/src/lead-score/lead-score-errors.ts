import { AppError } from '@carocrm/core/errors/index.js';

import type { LeadScoreErrorCode } from './lead-score-module.js';

/**
 * Phase 19-LS.1 — the module's error contract
 * (`PLAN_Phase_19_LeadScore.md` §8.4; audit §2).
 *
 * `LeadScoreError` extends the platform `AppError`, so a refusal reaches the client inside the
 * established envelope (`{ error: { code, message, details } }`) with a stable code, and the
 * human-readable text is resolved per locale from `errors.<CODE>` in the i18n catalog. A caller
 * switches on `code`, never on the message.
 *
 * `details` is expected to be **already safe**: it is what an operator and an audit row see. Never a
 * Lead payload, a raw rule body, a candidate record the caller may not read, or a credential. The
 * key `reason` is avoided — the global exception filter overwrites `details.reason` with the
 * localized message, which is why the switch name goes in `feature` and `blockedBy`.
 */
export class LeadScoreError extends AppError {
  readonly leadScoreCode: LeadScoreErrorCode;

  constructor(code: LeadScoreErrorCode, message: string, details?: Record<string, unknown>, statusCode = 409) {
    super(code, message, details, statusCode);
    this.name = 'LeadScoreError';
    this.leadScoreCode = code;
  }
}

/**
 * A switch an administrator has not opened, or the module as a whole.
 *
 * 403 rather than 409: this is a policy refusal, and the answer does not depend on the record state.
 * The message names the switch so the caller can fix the configuration; it never names a role.
 */
export function leadScoreModuleDisabledError(feature: string): LeadScoreError {
  return new LeadScoreError(
    'LEADSCORE_MODULE_DISABLED',
    'Lead Score is not enabled on this instance.',
    { feature },
    403,
  );
}

/**
 * The feature is switched on, but its implementation lands in a later sub-phase.
 *
 * Distinct from `LEADSCORE_MODULE_DISABLED` on purpose: a deployment flag is an operator choice, while
 * this says the code does not exist yet. A plan that describes a capability is not evidence of it
 * (plan §0.1-4), and an interface must not present a button whose phase has not shipped.
 */
export function leadScorePhasePendingError(operation: string, feature: string, phase: string): LeadScoreError {
  return new LeadScoreError('LEADSCORE_PHASE_PENDING', `Lead Score "${operation}" is implemented in ${phase}.`, {
    operation,
    feature,
    blockedBy: phase,
  });
}
