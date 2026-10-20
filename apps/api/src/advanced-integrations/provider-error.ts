/**
 * Phase 19-INT.6 — the normalized provider error model
 * (`PLAN_Phase_19_Advanced_Integrations.md` §11.2; `19-INT.6`).
 *
 * A connector translates its vendor's error into this shape. **Nothing above the adapter sees a
 * vendor type**, and no error carries a credential: the provider's own message may quote a
 * response body, and a response body may quote a token.
 *
 * The category is what the runtime acts on. It decides whether the operation is retried, whether
 * the connection is paused, and whether the failure becomes a dead letter (plan §11.2):
 *
 * | Category | Meaning | Runtime reaction |
 * | --- | --- | --- |
 * | `transient` | A network blip or a 5xx | Bounded retry with exponential backoff and jitter |
 * | `rate_limited` | A 429 or a provider quota signal | Bounded retry, honouring `Retry-After` |
 * | `provider_outage` | The provider is degraded | Bounded retry; the circuit breaker opens |
 * | `authorization` | The token expired, was revoked, or lacks a scope | **Never retried.** The connection moves to `reauthorization_required` |
 * | `permanent_validation` | The payload or the request is wrong | **Never retried.** The operation fails and may become a dead letter |
 * | `conflict` | The provider rejected the state of the object | Not retried; a conflict record is opened |
 * | `configuration_invalid` | The connector or its configuration is wrong | **Never retried.** The connection is paused |
 * | `account_mismatch` | The credential belongs to a different account or tenant | **Never retried.** The connection is paused |
 * | `not_found` | The object is gone | Not retried; the deletion policy decides what happens |
 */

export const PROVIDER_ERROR_CATEGORIES = [
  'transient',
  'rate_limited',
  'provider_outage',
  'authorization',
  'permanent_validation',
  'conflict',
  'configuration_invalid',
  'account_mismatch',
  'not_found',
] as const;

export type ProviderErrorCategory = (typeof PROVIDER_ERROR_CATEGORIES)[number];

/** The stable codes the plan §7.4 names, plus the ones the runtime needs. */
export const PROVIDER_ERROR_CODES = [
  'TOKEN_EXPIRED',
  'SCOPE_MISSING',
  'ACCOUNT_MISMATCH',
  'RATE_LIMITED',
  'PROVIDER_UNAVAILABLE',
  'CONFIGURATION_INVALID',
  'PERMISSION_DENIED',
  'INVALID_REQUEST',
  'NOT_FOUND',
  'CONFLICT',
  'TIMEOUT',
  'NETWORK_ERROR',
  'UNKNOWN',
] as const;

export type ProviderErrorCode = (typeof PROVIDER_ERROR_CODES)[number];

export interface ProviderErrorOptions {
  readonly category: ProviderErrorCategory;
  readonly retryable: boolean;
  /** The provider's own guidance, in milliseconds. Honoured before the computed backoff. */
  readonly retryAfterMs?: number | null;
  /** A redacted, non-sensitive diagnostic. Never a payload, never a token. */
  readonly detail?: string | null;
  /** The provider's HTTP status, when there was one. */
  readonly status?: number | null;
  readonly cause?: unknown;
}

/**
 * The error every connector throws.
 *
 * `detail` is expected to be **redacted by the connector**: it is stored in run rows, operation
 * rows and dead letters, and it is shown to an operator.
 */
export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly category: ProviderErrorCategory;
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;
  readonly detail: string | null;
  readonly status: number | null;

  constructor(code: ProviderErrorCode, message: string, options: ProviderErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ProviderError';
    this.code = code;
    this.category = options.category;
    this.retryable = options.retryable;
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.detail = options.detail ?? null;
    this.status = options.status ?? null;
  }

  /** The value stored in a run/operation/dead-letter row. Never contains a credential. */
  toRecord(): { readonly code: string; readonly category: string; readonly detail: string | null; readonly status: number | null } {
    return { code: this.code, category: this.category, detail: this.detail, status: this.status };
  }
}

/** Whether an unknown thrown value is a `ProviderError`. */
export function isProviderError(value: unknown): value is ProviderError {
  return value instanceof ProviderError;
}

/**
 * The category an HTTP status implies.
 *
 * The mapping is the platform's, not the vendor's: a connector that knows better translates the
 * status itself and throws a `ProviderError` directly.
 */
export function categorizeHttpStatus(status: number): { category: ProviderErrorCategory; retryable: boolean } {
  if (status === 401 || status === 403) return { category: 'authorization', retryable: false };
  if (status === 404) return { category: 'not_found', retryable: false };
  if (status === 409 || status === 412) return { category: 'conflict', retryable: false };
  if (status === 422 || status === 400) return { category: 'permanent_validation', retryable: false };
  if (status === 429) return { category: 'rate_limited', retryable: true };
  if (status === 503 || status === 502 || status === 504) return { category: 'provider_outage', retryable: true };
  if (status >= 500) return { category: 'provider_outage', retryable: true };
  return { category: 'permanent_validation', retryable: false };
}

/** The error a status implies, with the provider's `Retry-After` guidance attached. */
export function errorForStatus(status: number, retryAfterMs: number | null = null): ProviderError {
  const { category, retryable } = categorizeHttpStatus(status);
  const code: ProviderErrorCode =
    category === 'authorization'
      ? status === 401
        ? 'TOKEN_EXPIRED'
        : 'PERMISSION_DENIED'
      : category === 'rate_limited'
        ? 'RATE_LIMITED'
        : category === 'provider_outage'
          ? 'PROVIDER_UNAVAILABLE'
          : category === 'not_found'
            ? 'NOT_FOUND'
            : category === 'conflict'
              ? 'CONFLICT'
              : category === 'permanent_validation'
                ? 'INVALID_REQUEST'
                : 'UNKNOWN';
  return new ProviderError(code, `The provider answered with HTTP ${String(status)}.`, {
    category,
    retryable,
    retryAfterMs,
    status,
  });
}

/** The error a transport failure implies. */
export function errorForTransport(cause: unknown): ProviderError {
  const message = cause instanceof Error ? cause.message : String(cause);
  const timedOut = /timeout|aborted/i.test(message);
  return new ProviderError(timedOut ? 'TIMEOUT' : 'NETWORK_ERROR', 'The provider could not be reached.', {
    category: 'transient',
    retryable: true,
    detail: timedOut ? 'timeout' : 'network',
    cause,
  });
}

/**
 * Parse a provider's `Retry-After` header.
 *
 * The header is either a number of seconds or an HTTP date. Both forms are accepted; an
 * unparsable value yields `null`, and the caller falls back to its computed backoff.
 */
export function parseRetryAfter(header: string | null | undefined, now: number = Date.now()): number | null {
  if (header === null || header === undefined) return null;
  const trimmed = header.trim();
  if (trimmed === '') return null;
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds) || seconds < 0) return null;
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  const delta = date - now;
  if (delta < 0) return 0;
  return Math.min(delta, MAX_RETRY_AFTER_MS);
}

/** A provider's `Retry-After` is honoured up to this ceiling. */
export const MAX_RETRY_AFTER_MS = 15 * 60 * 1000;

/**
 * Reduce an error to the value a log line may carry.
 *
 * The message of a vendor error can quote a response body, which can quote a token. Only the
 * stable code, the category and a redacted detail survive.
 */
export function redactProviderError(error: unknown): { code: string; category: string; detail: string | null } {
  if (isProviderError(error)) {
    return { code: error.code, category: error.category, detail: error.detail };
  }
  return { code: 'UNKNOWN', category: 'permanent_validation', detail: null };
}
