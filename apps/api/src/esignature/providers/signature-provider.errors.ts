import {
  ProviderError,
  type ProviderErrorCategory,
  type ProviderErrorCode,
} from '../../advanced-integrations/provider-error.js';
import { ESignatureError, notSupportedByProviderError, providerOutcomeUnknownError } from '../esignature-errors.js';
import type { SignatureProviderOperation } from './signature-provider.port.js';

/**
 * Phase 19-ES.3 — the adapter-side error taxonomy
 * (`PLAN_Phase_19_ESignature.md` §5.2, §4.3, §9.3, §16; audit §5.1, §5.8; `19-ES.3` task
 * "define provider error categories, capabilities, correlation IDs and idempotency behavior").
 *
 * The nine platform categories in `advanced-integrations/provider-error.ts` are **reused, not
 * redefined** — same retry semantics, same redaction guarantees, no vendor type crossing the
 * boundary. This file adds the one shape that taxonomy has no place for, and it is the shape the plan
 * is most insistent about:
 *
 * `unknown_outcome` — the CRM sent a request the provider **may have accepted**, and the answer was
 * lost. `transient` would say "retry it", which for a send means a second signature request to a real
 * person (plan §4.3, §16). So the category is extended here at the adapter layer with an explicit
 * module-owned type, rather than smuggled into a platform union that every connector shares and whose
 * members are wired to retry behaviour.
 *
 * Everything is then translated once, at the boundary, into the stable API codes ES.1 declared
 * (`NOT_SUPPORTED_BY_PROVIDER`, `PROVIDER_OUTCOME_UNKNOWN`, `PROVIDER_NOT_CONNECTED` …) so a caller
 * never sees a category, a provider status code or a provider body.
 */

/** The platform categories, plus this module's `unknown_outcome`. */
export type ESignatureProviderErrorCategory = ProviderErrorCategory | 'unknown_outcome';

/** What an adapter may report, as a stable category, after translation. */
export const ESIGNATURE_PROVIDER_ERROR_CATEGORIES: readonly ESignatureProviderErrorCategory[] = [
  'transient',
  'rate_limited',
  'provider_outage',
  'authorization',
  'permanent_validation',
  'conflict',
  'configuration_invalid',
  'account_mismatch',
  'not_found',
  'unknown_outcome',
];

/**
 * The adapter's answer when the platform asked for something it does not offer (plan §5.2).
 *
 * A silent no-op would be worse than a failure: a reminder that did nothing, or a void that left an
 * envelope live, both look like success to the person who clicked. The refusal names the operation and
 * the provider, and the registry raises it **before** any call is made.
 */
export class NotSupportedByProviderError extends Error {
  readonly operation: SignatureProviderOperation | string;
  readonly providerKey: string;

  constructor(operation: SignatureProviderOperation | string, providerKey: string) {
    super(`The signature provider "${providerKey}" does not support "${operation}".`);
    this.name = 'NotSupportedByProviderError';
    this.operation = operation;
    this.providerKey = providerKey;
  }
}

/**
 * The send whose outcome the platform cannot establish.
 *
 * It carries the correlation id and the idempotency key so the reconciliation path (ES.10/ES.12) can
 * ask the provider "did you take envelope X for request Y" instead of guessing. `retryable` is
 * deliberately absent: the only legal next action is a reconciliation, never a second send.
 */
export class SendOutcomeUnknownError extends Error {
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly providerEnvelopeId: string | null;
  readonly category = 'unknown_outcome' as const;

  constructor(input: { correlationId: string; idempotencyKey: string; providerEnvelopeId?: string | null }) {
    super('The provider may have accepted the envelope, but the response was lost.');
    this.name = 'SendOutcomeUnknownError';
    this.correlationId = input.correlationId;
    this.idempotencyKey = input.idempotencyKey;
    this.providerEnvelopeId = input.providerEnvelopeId ?? null;
  }
}

/** A transport failure the adapter is reporting. It carries the category, never a body. */
export type AdapterFailure = ProviderError | NotSupportedByProviderError | SendOutcomeUnknownError;

export function isNotSupportedByProviderError(value: unknown): value is NotSupportedByProviderError {
  return value instanceof NotSupportedByProviderError;
}

export function isSendOutcomeUnknownError(value: unknown): value is SendOutcomeUnknownError {
  return value instanceof SendOutcomeUnknownError;
}

/** The category an unknown thrown value falls into, for the safe log line. */
export function classifyAdapterError(error: unknown): ESignatureProviderErrorCategory {
  if (isSendOutcomeUnknownError(error)) return 'unknown_outcome';
  if (isNotSupportedByProviderError(error)) return 'configuration_invalid';
  if (error instanceof ProviderError) return error.category;
  return 'provider_outage';
}

/**
 * Translate an adapter failure into the API-visible failure, once, at the boundary.
 *
 * Nothing above the adapter reads a provider status code, a provider message or an SDK type — the
 * redaction that plan §9.3 demands is this function's job, so no call site has to remember it.
 */
export function toModuleError(error: unknown, providerKey: string): ESignatureError {
  if (isNotSupportedByProviderError(error)) return notSupportedByProviderError(error.operation, error.providerKey || providerKey);
  if (isSendOutcomeUnknownError(error)) return providerOutcomeUnknownError(error.correlationId);
  if (error instanceof ProviderError) {
    switch (error.category) {
      case 'authorization':
        return new ESignatureError(
          'SIGNATURE_CONNECTION_NOT_AVAILABLE',
          'The signature provider refused the credential. The connection needs re-authorization before anything can be sent.',
          { providerCode: error.code, category: error.category },
          409,
        );
      case 'account_mismatch':
        return new ESignatureError(
          'SIGNATURE_CONNECTION_NOT_AVAILABLE',
          'The credential belongs to a different provider account than this connection.',
          { providerCode: error.code, category: error.category },
          409,
        );
      case 'rate_limited':
        return new ESignatureError(
          'SIGNATURE_CONNECTION_NOT_AVAILABLE',
          'The signature provider is rate limiting this installation. Try again shortly.',
          { providerCode: error.code, retryAfterMs: error.retryAfterMs },
          429,
        );
      case 'configuration_invalid':
        return new ESignatureError(
          'SIGNATURE_CONNECTION_NOT_AVAILABLE',
          'The installed DocuSign credentials are not valid, so this connection cannot be authorized.',
          { providerCode: error.code, category: error.category },
          422,
        );
      case 'transient':
      case 'provider_outage':
        return new ESignatureError(
          'SIGNATURE_CONNECTION_NOT_AVAILABLE',
          'The signature provider could not be reached. The request has not been sent again.',
          { providerCode: error.code, category: error.category },
          503,
        );
      case 'not_found':
        return new ESignatureError(
          'SIGNATURE_REQUEST_INVALID_STATE',
          'The provider has no record of that envelope.',
          { providerCode: error.code },
          409,
        );
      default:
        return new ESignatureError(
          'SIGNATURE_REQUEST_INVALID_STATE',
          'The signature provider refused the operation.',
          { providerCode: error.code, category: error.category },
          409,
        );
    }
  }
  // An unexpected throw is reported as an outage, not echoed: its message may contain anything the
  // vendor put in a response body.
  return new ESignatureError('SIGNATURE_CONNECTION_NOT_AVAILABLE', 'The signature provider could not be reached.', {}, 503);
}

/**
 * The safe value a log line or an error row may carry about an adapter failure (plan §9.3).
 * Mirrors `redactProviderError` and extends it with the two module-owned failures.
 */
export function redactAdapterError(error: unknown): {
  code: ProviderErrorCode | 'NOT_SUPPORTED_BY_PROVIDER' | 'PROVIDER_OUTCOME_UNKNOWN' | 'UNKNOWN';
  category: ESignatureProviderErrorCategory;
  detail: string | null;
} {
  if (isSendOutcomeUnknownError(error)) {
    return { code: 'PROVIDER_OUTCOME_UNKNOWN', category: 'unknown_outcome', detail: error.idempotencyKey.slice(0, 64) };
  }
  if (isNotSupportedByProviderError(error)) {
    return { code: 'NOT_SUPPORTED_BY_PROVIDER', category: 'configuration_invalid', detail: error.operation };
  }
  if (error instanceof ProviderError) {
    return { code: error.code, category: error.category, detail: error.detail };
  }
  return { code: 'UNKNOWN', category: 'provider_outage', detail: null };
}
