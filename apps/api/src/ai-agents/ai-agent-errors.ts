import { AppError } from '@carocrm/core/errors/index.js';

import type { AIAgentErrorCode } from './ai-agents-module.js';

/**
 * Phase 19-AI.21 — the module's error contract
 * (`plans/PLAN_Phase_19_AI_Agents.md` §24, `19-AI.21`).
 *
 * One layer, deliberately thin: a **stable code** in the platform error envelope
 * (`{ error: { code, message, details } }`) plus the human-readable text the i18n catalog
 * resolves per locale (`errors.<CODE>`). A caller switches on the code, never on the message, so a
 * translated or reworded sentence never breaks an integration.
 *
 * The eSignature module established this shape for the same kind of decision
 * (`SIGNATURE_APPROVAL_SEPARATION_REQUIRED`); the AI Agents codes follow it rather than inventing a
 * second convention.
 *
 * `details` is expected to be **already safe**: it is stored in audit rows and shown to an operator.
 * Never put record content, a prompt, a provider body or a secret in it.
 */
export class AIAgentError extends AppError {
  readonly aiAgentCode: AIAgentErrorCode;

  constructor(
    code: AIAgentErrorCode,
    message: string,
    details?: Record<string, unknown>,
    statusCode = 409,
  ) {
    super(code, message, details, statusCode);
    this.name = 'AIAgentError';
    this.aiAgentCode = code;
  }
}

/**
 * The requester tried to approve their own proposal and the installation forbids it.
 *
 * A 403 with a stable code, not a generic 500: the refusal is a *policy* the caller can act on
 * (ask a second approver), and the SPA explains it instead of showing a failure nobody can fix.
 * The proposal stays **pending** — nothing is decided, so another approver may still act on it.
 */
export function aiApprovalSelfApprovalForbiddenError(
  details: Record<string, unknown> = {},
): AIAgentError {
  return new AIAgentError(
    'AI_APPROVAL_SELF_APPROVAL_FORBIDDEN',
    'You cannot approve your own proposal. Another approver has to review it.',
    details,
    403,
  );
}

/**
 * The requester's own decision was **recorded**, but the action still needs a second approver.
 *
 * The permissive policy (`permitted_with_audit`) is not a blank cheque: a `material_write` proposal
 * the requester signed still needs somebody else's signature before it can execute. The first
 * signature is kept in the audit trail; the second one completes the approval.
 */
export function aiApprovalSecondApproverRequiredError(
  details: Record<string, unknown> = {},
): AIAgentError {
  return new AIAgentError(
    'AI_APPROVAL_SECOND_APPROVER_REQUIRED',
    'Your approval was recorded, but this action still needs a second approver before it can execute.',
    details,
    403,
  );
}
