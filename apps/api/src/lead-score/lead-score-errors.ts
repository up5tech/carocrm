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

/**
 * A conversion target this installation will not build (19-LS.12, contract §5.2).
 *
 * 422, not 403: the caller may be perfectly entitled — the *configuration* says this target does not exist
 * here, or its phase has not shipped. The two are separated in `state` because one has a fix an operator can
 * apply on this screen and the other has only time.
 */
export function leadScoreTargetDisabledError(target: string, state: 'notEnabled' | 'pending', pendingPhase?: string): LeadScoreError {
  const message =
    state === 'pending'
      ? `Converting a Lead to "${target}" is implemented in ${String(pendingPhase ?? 'a later sub-phase')}, so it cannot be built yet.`
      : `"${target}" is not an enabled conversion target on this instance.`;
  return new LeadScoreError('LEADSCORE_TARGET_DISABLED', message, { target, state, ...(pendingPhase === undefined ? {} : { pendingPhase }) }, 422);
}

/** Which part of a preview fingerprint no longer matches the server's answer (contract §8.3). */
export type PreviewStaleComponent = 'revision' | 'mapping' | 'targets' | 'readerScope' | 'confirmation' | 'hash';

/**
 * A preview the caller is holding is out of date, and the fix is to take it again.
 *
 * The answer names *which* component moved so the wizard can say "the Lead changed" rather than "try again",
 * and it never carries a value: a stale preview is a statement about the operation, not about the record.
 */
export function leadScorePreviewStaleError(leadId: string, component: PreviewStaleComponent, numbers: { expected?: number; current?: number } = {}): LeadScoreError {
  return new LeadScoreError(
    'LEADSCORE_PREVIEW_STALE',
    'This conversion preview no longer describes the Lead, so it has to be taken again before anything is written.',
    {
      leadId,
      component,
      ...(numbers.expected === undefined ? {} : { expected: numbers.expected }),
      ...(numbers.current === undefined ? {} : { current: numbers.current }),
    },
  );
}

/**
 * The Lead is already converted (19-LS.13; contract §4.2).
 *
 * The operation id is echoed only when this caller may read operations — the Lead's own `convertedAt` is
 * already theirs to see, but another operation's id is not.
 */
export function leadScoreAlreadyConvertedError(leadId: string, convertedAt: string | null, operationId: string | null): LeadScoreError {
  return new LeadScoreError(
    'LEADSCORE_ALREADY_CONVERTED',
    'This Lead has already been converted. A second conversion of the same Lead is refused; review or correct the existing one instead.',
    { leadId, ...(convertedAt === null ? {} : { convertedAt }), ...(operationId === null ? {} : { operationId }) },
  );
}

/** The key is taken by an operation this caller may not read. A conflict, never a disclosure (contract §4.1). */
export function leadScoreConversionConflictError(leadId: string): LeadScoreError {
  return new LeadScoreError(
    'LEADSCORE_CONVERSION_CONFLICT',
    'That operation key is already in use. Pick a new key for a new conversion.',
    { leadId },
  );
}

/** Same key, still running: the caller polls rather than starting a second attempt (contract §4.2). */
export function leadScoreConversionInFlightError(operationId: string): LeadScoreError {
  return new LeadScoreError('LEADSCORE_CONVERSION_IN_FLIGHT', 'That conversion is still running.', { operationId });
}

/** A transient failure that left nothing behind: retrying the same operation is safe (contract §10.1). */
export function leadScoreConversionRetryableError(operationId: string, failureCode: string): LeadScoreError {
  return new LeadScoreError(
    'LEADSCORE_CONVERSION_RETRYABLE',
    'The conversion could not be completed because of a temporary failure, and nothing was written. Retry the operation.',
    { operationId, failureCode },
    503,
  );
}

/** This attempt needs a human before anything else happens — a retry or a close, not a new conversion. */
export function leadScoreConversionNeedsRecoveryError(operationId: string, failureCode: string): LeadScoreError {
  return new LeadScoreError(
    'LEADSCORE_CONVERSION_NEEDS_RECOVERY',
    'This conversion attempt cannot be re-issued as it stands. Recover it: retry it from the operations view, or close it.',
    { operationId, failureCode },
  );
}

/** Exact matches exist and nobody said what to do about them (plan §7.3, contract §9.5). */
export function leadScoreDuplicateReviewRequiredError(leadId: string, visibleCandidates: number, hiddenMatches: number): LeadScoreError {
  return new LeadScoreError(
    'LEADSCORE_DUPLICATE_REVIEW_REQUIRED',
    'Possible duplicates exist for this Lead. Decide before converting: link an existing record, or create anyway with the override right.',
    { leadId, visibleCandidates, hiddenMatches },
  );
}

/** Linking would move a Contact to another Account, which is a decision, not a side effect (contract §6.3). */
export function leadScoreReparentRequiredError(contactId: string, accountId: string, currentAccountId: string | null): LeadScoreError {
  return new LeadScoreError(
    'LEADSCORE_CONVERSION_REPARENT_REQUIRED',
    'This Contact already belongs to another Account. Moving it is an explicit decision and needs the field-change right.',
    { contactId, accountId, ...(currentAccountId === null ? {} : { currentAccountId }) },
  );
}

// ---------------------------------------------------------------------------
// 19-LS.17 — the optional AI fit insight
// ---------------------------------------------------------------------------

/**
 * The AI insight switch is on, but no published agent has been chosen.
 *
 * 409: the request is well formed and the caller may ask, and the deployment is not configured for it.
 * The id of a missing agent is never echoed, because the question is "what do I configure", not "does this
 * agent exist".
 */
export function leadScoreInsightNotConfiguredError(): LeadScoreError {
  return new LeadScoreError(
    'LEADSCORE_INSIGHT_NOT_CONFIGURED',
    'AI insight is switched on, but no AI agent is configured for it. An administrator chooses one in the Lead Score settings.',
    { section: 'insight.agentId' },
  );
}

/**
 * AIAgents cannot run right now, or the run it produced did not finish with an answer.
 *
 * `state` names which fact it is — `executionDisabled`, `runNotFinished`, `runFailed` — because the fix
 * differs, and a failed run's id is included so an AIAgents operator can inspect it. No failure message
 * from the provider is echoed here: it may contain prompt content (AGENTS.md §5.3).
 */
export function leadScoreInsightUnavailableError(
  state: 'executionDisabled' | 'runNotFinished' | 'runFailed' | 'agentUnavailable',
  details: { readonly runId?: string; readonly status?: string; readonly failureCategory?: string | null } = {},
): LeadScoreError {
  const messages: Record<typeof state, string> = {
    executionDisabled: 'AI agent execution is disabled or paused on this instance, so no insight can be generated.',
    runNotFinished: 'The AI run has not finished, so there is no answer yet. Try again when it completes.',
    runFailed: 'The AI run did not produce an answer.',
    agentUnavailable: 'The configured AI agent is not available to you, or is no longer published.',
  };
  return new LeadScoreError('LEADSCORE_INSIGHT_UNAVAILABLE', messages[state], { state, ...details });
}

/**
 * The configured agent is not the kind of agent this action may use (plan §6.7).
 *
 * 19-LS.17 sends evidence text and nothing else, so the agent must read text rather than a record, and it
 * may not hold a tool that writes: an explanation must not become a second way to act. `issue` is a stable
 * token; the agent's configuration is not repeated in the response.
 */
export function leadScoreInsightAgentUnsuitableError(agentId: string, issue: 'recordInput' | 'writeTool' | 'version'): LeadScoreError {
  const messages: Record<typeof issue, string> = {
    recordInput: 'The configured AI agent reads a record rather than a text task, so it cannot be used for an evidence-bounded insight.',
    writeTool: 'The configured AI agent has a tool that writes, and an insight may only read. Remove the tool or choose another agent.',
    version: 'The configured AI agent has no usable published version.',
  };
  return new LeadScoreError('LEADSCORE_INSIGHT_AGENT_UNSUITABLE', messages[issue], { agentId, issue }, 409);
}

/**
 * An AI explanation is only meaningful about a deterministic score (plan §6.7 "only after scoring").
 *
 * 409: the Lead exists and is readable; it simply has not been scored yet (or its score failed). The answer
 * names the state rather than a null score so the screen can say "score it first".
 */
export function leadScoreInsightNotScoredError(leadId: string, state: string): LeadScoreError {
  return new LeadScoreError(
    'LEADSCORE_INSIGHT_NOT_SCORED',
    'This Lead has no current score, so there is no deterministic judgement for an AI explanation to describe.',
    { leadId, state },
  );
}

/**
 * The run succeeded in AIAgents' sense but its result is not an explanation this module can show.
 *
 * 502, not 422: the caller's request was valid and the failure is the provider's output shape. The run id
 * is included so the AIAgents side can be inspected; the raw result is not echoed.
 */
export function leadScoreInsightUnusableError(runId: string): LeadScoreError {
  return new LeadScoreError(
    'LEADSCORE_INSIGHT_UNUSABLE',
    'The AI run finished without a usable explanation. The agent should answer with text or a JSON object carrying "summary".',
    { runId },
    502,
  );
}
