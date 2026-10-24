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
 * A published or archived model version is frozen (plan §5.1).
 *
 * 409: the record is in a state that forbids the write, which is neither a permission problem nor a
 * shape problem. The message names the way forward, because "immutable" without it reads as a dead end —
 * a new version is how a published model is changed.
 */
export function leadScoreModelImmutableError(entity: string, modelId: string, status: string): LeadScoreError {
  return new LeadScoreError(
    'LEADSCORE_MODEL_IMMUTABLE',
    `A ${status} Lead Score model version cannot be created, edited or deleted. Create a new version to change it.`,
    { entity, modelId, status },
  );
}

/**
 * A lifecycle action asked of a model that is not in the state that permits it — publishing a published
 * version, archiving an archived one, or copying a draft that is already editable.
 *
 * 409 because the refusal is about the record's state, not the caller's rights and not the shape of the
 * request (plan §8.4: stable codes for each of those separately).
 */
export function leadScoreInvalidStateError(action: string, state: string, hint: string): LeadScoreError {
  return new LeadScoreError('LEADSCORE_INVALID_STATE', `Lead Score model cannot be ${action} while its state is "${state}". ${hint}`, {
    action,
    state,
  });
}

/**
 * Two drafts of one model name would make "the next version" ambiguous.
 *
 * The answer names the draft that already holds the slot, because the caller needs to edit that row
 * rather than create a second one — a silent second draft would leave two candidate rule sets for the
 * same name and version.
 */
export function leadScoreDraftExistsError(modelName: string, draftId: string): LeadScoreError {
  return new LeadScoreError('LEADSCORE_DRAFT_EXISTS', `A draft of score model "${modelName}" already exists.`, {
    modelName,
    draftId,
  });
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

/**
 * Nothing is scoring Leads right now, and the answer says which of the three states it found.
 *
 * 19-LS.5 computes a score only under the **active published model** (plan §5.1, audit §5.1), which an
 * administrator chooses in the module settings. So a recalculation can be blocked by configuration rather
 * than by the Lead or by the caller: no model chosen, a chosen row that is gone, or one that is still a
 * draft or has been archived. Those are named separately because the fix differs every time — and the id is
 * reported only when the row exists, so this cannot confirm that some other tenant's model id is real.
 *
 * The state travels as `state`, not `reason`: `GlobalExceptionFilter` overwrites `details.reason` with the
 * localized message, which is why this module never puts an answer a caller must switch on in that key.
 */
export function leadScoreNoActiveModelError(state: 'unset' | 'missing' | 'notPublished', modelId?: string, modelStatus?: string): LeadScoreError {
  const messages: Record<'unset' | 'missing' | 'notPublished', string> = {
    unset: 'No Lead Score model is active on this instance, so nothing can be scored. Publish a model and select it in the Lead Score settings.',
    missing: 'The active Lead Score model no longer exists, so nothing can be scored. Select the model that replaced it in the Lead Score settings.',
    notPublished: `The active Lead Score model is "${String(modelStatus ?? '')}", and only a published version may score a Lead. Publish it, or select a published model.`,
  };
  return new LeadScoreError(
    'LEADSCORE_NO_ACTIVE_MODEL',
    messages[state],
    { state, ...(modelId !== undefined ? { modelId } : {}), ...(modelStatus !== undefined ? { modelStatus } : {}) },
  );
}
