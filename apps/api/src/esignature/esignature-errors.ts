import { AppError } from '@carocrm/core/errors/index.js';

import { PROVIDER_ERROR_CATEGORIES, type ProviderErrorCategory } from '../advanced-integrations/provider-error.js';
import type { ESignatureErrorCode } from './esignature-module.js';

/**
 * Phase 19-ES.1 — the module's error contract
 * (`PLAN_Phase_19_ESignature.md` §8.2, §5.2, §16; audit §5.8; `19-ES.1`).
 *
 * Two layers, deliberately kept apart:
 *
 * 1. **`ESignatureError`** — what an API caller is answered. It extends the platform `AppError`, so
 *    it reaches the client inside the established envelope
 *    (`{ error: { code, message, details } }`) with its own stable code; the human-readable text is
 *    resolved per locale from `errors.<CODE>` in the i18n catalog. A caller switches on `code`, never
 *    on the message.
 * 2. **`ProviderError` / `ProviderErrorCategory`** — what an *adapter* throws, reused unchanged from
 *    Advanced Integrations (`advanced-integrations/provider-error.ts`): the same nine categories the
 *    runtime already acts on (retry, pause, circuit-break, dead-letter), the same redaction rules, and
 *    the same guarantee that no vendor type or credential crosses the adapter boundary.
 *
 * ES.3 extends the provider side with the one category the plan's send semantics need and the generic
 * connector taxonomy has no place for: `unknown_outcome` — the provider may have accepted the request
 * while the local process lost the answer. That state is never a retry (plan §4.3, §16), so it is
 * *not* smuggled into `transient`, and it is not claimed here before the adapter port exists.
 */

/**
 * A stable module failure carried to the API caller.
 *
 * `details` is expected to be **already safe**: it is stored in audit rows and shown to an operator.
 * Never put a provider body, a token, a signing URL or document content in it.
 */
export class ESignatureError extends AppError {
  readonly esignatureCode: ESignatureErrorCode;

  constructor(code: ESignatureErrorCode, message: string, details?: Record<string, unknown>, statusCode = 409) {
    super(code, message, details, statusCode);
    this.name = 'ESignatureError';
    this.esignatureCode = code;
  }
}

/** The connection is missing, disabled, or not in the one state that permits provider work. */
export function providerNotConnectedError(reason: 'no_connection' | 'disabled' | 'not_authorized' | 'reauthorization_required'): ESignatureError {
  return new ESignatureError(
    'PROVIDER_NOT_CONNECTED',
    'No enabled signature provider connection is available, so no request can be sent.',
    { reason },
    409,
  );
}

/** A feature flag an administrator has not switched on. */
export function signatureModuleDisabledError(feature: string): ESignatureError {
  return new ESignatureError(
    'SIGNATURE_MODULE_DISABLED',
    'The e-signature module is not enabled on this instance.',
    { feature },
    403,
  );
}

/**
 * The approval policy requires a decision, and none has been given for these exact bytes.
 *
 * Plan §11.1/§11.2: a request whose source type requires approval may not leave the CRM until someone
 * approved the digest the sender is about to send. The message says which, never who.
 */
export function signatureApprovalRequiredError(requestId: string): ESignatureError {
  return new ESignatureError(
    'SIGNATURE_APPROVAL_REQUIRED',
    'This request needs an approval for its current contents before it can be sent.',
    { requestId },
    409,
  );
}

/** The request is not in a state that permits the requested transition. */
export function signatureRequestInvalidStateError(status: string, attempted: string): ESignatureError {
  return new ESignatureError(
    'SIGNATURE_REQUEST_INVALID_STATE',
    `A signature request in state "${status}" cannot perform "${attempted}".`,
    { status, attempted },
    409,
  );
}

/**
 * A policy or provider-state refusal on a lifecycle action (ES.16).
 *
 * Distinct from an invalid state: the request may be sendable, but this installation has not allowed
 * reminders, or the provider does not offer the operation. The stable code lets the SPA disable the
 * action instead of showing a failure a user cannot fix.
 */
export function signatureActionNotAvailableError(
  action: 'resend' | 'void' | 'correct' | 'embeddedView' | 'artifacts',
  reason:
    | 'reminders_disabled'
    | 'recipient_not_embedded'
    | 'recipient_not_matched'
    | 'return_url_not_allowed'
    | 'not_completed'
    | 'provider_not_supported',
  detail: Record<string, unknown> = {},
): ESignatureError {
  const messages: Record<typeof reason, string> = {
    reminders_disabled: 'Reminders are switched off for this installation, so no resend was made.',
    recipient_not_embedded: 'That recipient does not sign inside the CRM, so no embedded view can be generated.',
    recipient_not_matched: 'The signed-in user is not the recipient this signing link is for.',
    return_url_not_allowed: 'The return URL is not on this installation\'s allowlist, so no signing link was generated.',
    not_completed: 'The request has not completed, so there are no completed documents to retrieve.',
    provider_not_supported: 'The provider does not offer this action in this release.',
  };
  return new ESignatureError('SIGNATURE_ACTION_NOT_AVAILABLE', messages[reason], { action, refusal: reason, ...detail }, 422);
}

/** A reminder was asked for again inside the configured cooldown. */
export function signatureResendRateLimitedError(retryAfterSeconds: number): ESignatureError {
  return new ESignatureError(
    'SIGNATURE_RESEND_RATE_LIMITED',
    'A reminder was sent for this request recently. Wait before sending another one.',
    { retryAfterSeconds },
    429,
  );
}

/** A delivery that failed verification. The inbox keeps the evidence; the caller learns nothing useful. */
export function signatureWebhookRejectedError(reason: string): ESignatureError {
  return new ESignatureError('SIGNATURE_WEBHOOK_REJECTED', 'The delivery was refused.', { reason }, 401);
}

/** A send whose result the platform could not establish — never blind-retried. */
export function providerOutcomeUnknownError(correlationId: string): ESignatureError {
  return new ESignatureError(
    'PROVIDER_OUTCOME_UNKNOWN',
    'The provider may have accepted the request but no confirmation was received. The request is held for reconciliation; it has not been sent again.',
    { correlationId },
    409,
  );
}

/** The provider does not offer the requested operation for this account (plan §5.2). */
export function notSupportedByProviderError(capability: string, providerKey: string): ESignatureError {
  return new ESignatureError(
    'NOT_SUPPORTED_BY_PROVIDER',
    `The signature provider "${providerKey}" does not support "${capability}" in this release.`,
    { capability, providerKey },
    422,
  );
}

/**
 * A document could not become part of a request (plan §4.5, §12.9).
 *
 * `reason` is the machine-readable half of the answer and is deliberately one of a closed list:
 * `not_readable` covers the ACL refusal (the caller may not see the source file), while
 * `type_not_allowed`, `too_large`, `too_many` and `empty` are policy refusals an administrator can
 * explain, and `storage_unavailable` / `checksum_mismatch` are installation faults that must never be
 * reported as if the user had done something wrong. The filename is safe to include; the bytes never are.
 */
export function signatureDocumentNotReadableError(
  reason:
    | 'not_readable'
    | 'type_not_allowed'
    | 'too_large'
    | 'too_many'
    | 'empty'
    | 'storage_unavailable'
    | 'checksum_mismatch',
  detail: { filename?: string; limitBytes?: number; limitCount?: number; allowed?: readonly string[] } = {},
): ESignatureError {
  const messages: Record<typeof reason, string> = {
    not_readable: 'The source document cannot be read by this user, so it cannot be attached to a signature request.',
    type_not_allowed: 'That document type is not allowed by the signature policy or by the provider.',
    too_large: 'The document is larger than the signature policy or the provider permits.',
    too_many: 'This request already holds the maximum number of documents.',
    empty: 'The document has no bytes to sign.',
    storage_unavailable: 'The stored document could not be read, so no snapshot was created.',
    checksum_mismatch: 'The stored document did not match its recorded checksum, so no snapshot was created.',
  };
  return new ESignatureError('SIGNATURE_DOCUMENT_NOT_READABLE', messages[reason], { reason, ...detail }, 422);
}

/** `ENCRYPTION_KEY` absent: a credential can neither be stored nor read, so nothing may reach a provider. */
export function encryptionKeyMissingError(): ESignatureError {
  return new ESignatureError(
    'ENCRYPTION_KEY_MISSING',
    'ENCRYPTION_KEY is not configured, so provider credentials cannot be read and no provider operation is possible.',
    {},
    422,
  );
}

/** The provider error categories this module's adapter may produce (reused, not redefined). */
export const ESIGNATURE_PROVIDER_ERROR_CATEGORIES: readonly ProviderErrorCategory[] = PROVIDER_ERROR_CATEGORIES;

/** Whether a thrown value is one of the module's stable API failures. */
export function isESignatureError(value: unknown): value is ESignatureError {
  return value instanceof ESignatureError;
}
