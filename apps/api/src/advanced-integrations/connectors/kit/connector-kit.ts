import { ProviderError } from '../../provider-error.js';
import {
  createProviderHttpClient,
  type ProviderHttpClient,
  type ProviderHttpResponse,
} from '../../provider-http-client.js';

/**
 * Phase 19-INT.16–19-INT.24 — the shared connector kit
 * (`PLAN_Phase_19_Advanced_Integrations.md` §12; `19-INT.16`–`19-INT.24`).
 *
 * Nine connectors are delivered in these phases, and none of them may re-implement the rules the
 * platform already owns. This file is the first half of that: the **HTTP** half.
 *
 * What lives here and why it lives here:
 *
 *  - **One JSON request path.** Every connector speaks JSON over HTTP. The rules that must hold
 *    for all of them — a bounded timeout, no redirect following, an SSRF address check, a payload
 *    ceiling, a normalized error — are the platform's, not a vendor's. They are implemented once
 *    here, on top of `ProviderHttpClient`, and every connector inherits them.
 *  - **Option reading.** A connector's per-connection configuration arrives as plain JSON. Reading
 *    it is error-prone when nine connectors do it nine ways, so the readers live here: a missing
 *    value is `null`, a malformed value is a `ProviderError` naming the option, and a value is
 *    never silently coerced into something the provider would misread.
 *  - **Opaque cursors.** The runtime treats a cursor as an opaque string. A connector that has to
 *    carry several facts in one cursor (a calendar id, a sync token, a page token) needs a way to
 *    pack them without the runtime ever decoding them. `encodeCursor` / `decodeCursor` do exactly
 *    that, and `decodeCursor` refuses a cursor it did not write.
 *
 * Nothing in this file knows a vendor. That is the point: a vendor's URL, header name and field
 * names live in that vendor's adapter and nowhere else.
 */

/** The ceiling on a provider response body. A provider that answers with a huge body is refused. */
export const MAX_PROVIDER_RESPONSE_BYTES = 4 * 1024 * 1024;

/** The ceiling on a JSON body the platform sends to a provider. */
export const MAX_PROVIDER_REQUEST_BYTES = 256 * 1024;

export interface ConnectorHttpOptions {
  readonly providerKey: string;
  readonly connectionId: string | null;
  /** Per-connection timeout override. */
  readonly timeoutMs?: number | undefined;
  /** Whether a loopback destination is permitted (a self-hosted endpoint). */
  readonly allowLoopback?: boolean | undefined;
  /** Injectable for tests, so a connector test never opens a socket. */
  readonly fetchImpl?: typeof fetch | undefined;
  /** Injectable for tests, so the address check can be exercised without DNS. */
  readonly resolveHost?: ((host: string) => Promise<string[]>) | undefined;
  /** A structured logger. Only non-sensitive fields ever reach it. */
  readonly log?: ((fields: Record<string, unknown>, message: string) => void) | undefined;
}

export interface ConnectorJsonRequest {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  /** The request body, already serialized. */
  readonly body?: string | undefined;
  readonly timeoutMs?: number | undefined;
}

/**
 * A JSON-over-HTTP client for one connection.
 *
 * The instance is **per call site**, not per connection: the connector decides the timeout, the
 * loopback allowance and the log fields. Everything that must be identical for every provider is
 * inside `ProviderHttpClient` and cannot be skipped.
 */
export class ConnectorHttp {
  private readonly client: ProviderHttpClient;

  constructor(options: ConnectorHttpOptions) {
    this.client = createProviderHttpClient({
      providerKey: options.providerKey,
      connectionId: options.connectionId,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.allowLoopback === undefined ? {} : { allowLoopback: options.allowLoopback }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.resolveHost === undefined ? {} : { resolveHost: options.resolveHost }),
      ...(options.log === undefined ? {} : { log: options.log }),
    });
  }

  /**
   * Send a request and parse the answer as JSON.
   *
   * A malformed body is a `permanent_validation` failure: the provider answered, but not with
   * something this platform can read. Retrying it would produce the same answer, so it must not
   * become a retry storm.
   */
  async json<T>(request: ConnectorJsonRequest): Promise<T> {
    const response = await this.client.request({
      method: request.method,
      url: request.url,
      ...(request.headers === undefined ? {} : { headers: request.headers }),
      ...(request.body === undefined ? {} : { body: request.body }),
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
    });
    return parseProviderJson<T>(response);
  }

  /**
   * Send a request and parse the answer as JSON **with the response headers**.
   *
   * Some providers carry their pagination in a header — Shopify's `Link` header, for one — so a
   * connector that only sees the body cannot page.
   */
  async jsonWithHeaders<T>(
    request: ConnectorJsonRequest,
  ): Promise<{ readonly body: T; readonly headers: Readonly<Record<string, string>> }> {
    const response = await this.client.request({
      method: request.method,
      url: request.url,
      ...(request.headers === undefined ? {} : { headers: request.headers }),
      ...(request.body === undefined ? {} : { body: request.body }),
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
    });
    return { body: parseProviderJson<T>(response), headers: response.headers };
  }

  /** Send a request and return the raw answer. Used when the body is not JSON. */
  async raw(request: ConnectorJsonRequest): Promise<ProviderHttpResponse> {
    return this.client.request({
      method: request.method,
      url: request.url,
      ...(request.headers === undefined ? {} : { headers: request.headers }),
      ...(request.body === undefined ? {} : { body: request.body }),
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
    });
  }
}

/**
 * Parse a provider response as JSON.
 *
 * An empty body is `null` rather than a failure: several providers answer `204 No Content` to a
 * delete, and that is a success.
 */
export function parseProviderJson<T>(response: ProviderHttpResponse): T {
  if (response.body.length > MAX_PROVIDER_RESPONSE_BYTES) {
    throw new ProviderError('INVALID_REQUEST', 'The provider answered with a response body that is too large.', {
      category: 'permanent_validation',
      retryable: false,
      detail: 'response_too_large',
    });
  }
  const trimmed = response.body.trim();
  if (trimmed === '') return null as T;
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    throw new ProviderError('INVALID_REQUEST', 'The provider answered with a body that is not valid JSON.', {
      category: 'permanent_validation',
      retryable: false,
      detail: 'malformed_json',
    });
  }
}

/** Whether a value is a plain JSON object. */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read a string field from a provider payload, or `null`. */
export function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

/** Read a number field from a provider payload, or `null`. */
export function readNumber(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/** Read a boolean field from a provider payload, or `null`. */
export function readBoolean(source: Record<string, unknown>, key: string): boolean | null {
  const value = source[key];
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

/** Read an array of strings from a provider payload, or an empty list. */
export function readStringList(source: Record<string, unknown>, key: string): readonly string[] {
  const value = source[key];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

// ---------------------------------------------------------------------------
// connection options
// ---------------------------------------------------------------------------

/**
 * Read a string option.
 *
 * A missing option is `null`; an option of the wrong type is a configuration failure, because a
 * connector that silently accepted `"yes"` as a boolean would send a request the provider would
 * reject in a way nobody can diagnose.
 */
export function readStringOption(
  options: Readonly<Record<string, unknown>>,
  key: string,
  providerKey: string,
): string | null {
  const value = options[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw invalidOption(providerKey, key, 'a string');
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** Read a required string option, or fail with a message that names the option. */
export function requireStringOption(
  options: Readonly<Record<string, unknown>>,
  key: string,
  providerKey: string,
): string {
  const value = readStringOption(options, key, providerKey);
  if (value === null) {
    throw invalidOption(providerKey, key, 'a non-empty string');
  }
  return value;
}

/** Read a list-of-strings option. */
export function readStringListOption(
  options: Readonly<Record<string, unknown>>,
  key: string,
  providerKey: string,
): readonly string[] {
  const value = options[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw invalidOption(providerKey, key, 'an array of strings');
  }
  return (value as readonly string[]).map((entry) => entry.trim()).filter((entry) => entry !== '');
}

/** Read a number option, clamped to a range. */
export function readNumberOption(
  options: Readonly<Record<string, unknown>>,
  key: string,
  providerKey: string,
  fallback: number,
  minimum = 1,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const value = options[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw invalidOption(providerKey, key, 'a number');
  }
  return Math.min(Math.max(Math.trunc(value), minimum), maximum);
}

/** Read a boolean option. */
export function readBooleanOption(
  options: Readonly<Record<string, unknown>>,
  key: string,
  providerKey: string,
  fallback: boolean,
): boolean {
  const value = options[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') {
    throw invalidOption(providerKey, key, 'a boolean');
  }
  return value;
}

function invalidOption(providerKey: string, key: string, expected: string): ProviderError {
  return new ProviderError(
    'CONFIGURATION_INVALID',
    `The connection option "${key}" of provider "${providerKey}" must be ${expected}.`,
    { category: 'configuration_invalid', retryable: false, detail: `option:${key}` },
  );
}

// ---------------------------------------------------------------------------
// opaque cursors
// ---------------------------------------------------------------------------

/**
 * Pack facts into an opaque cursor.
 *
 * The runtime never decodes a cursor; it stores it and hands it back. The connector therefore
 * encodes everything it needs to resume, and refuses a cursor it did not write.
 */
export function encodeCursor(payload: Readonly<Record<string, unknown>>): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/** Unpack a cursor this connector wrote, or fail with a precise message. */
export function decodeCursor<T extends object>(cursor: string | null, providerKey: string): T | null {
  if (cursor === null || cursor.trim() === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor(providerKey);
  }
  if (!isJsonObject(parsed)) {
    throw invalidCursor(providerKey);
  }
  return parsed as unknown as T;
}

function invalidCursor(providerKey: string): ProviderError {
  return new ProviderError(
    'INVALID_REQUEST',
    `The provider refused the cursor for "${providerKey}". The cursor was not produced by this connector.`,
    { category: 'permanent_validation', retryable: false, detail: 'invalid_cursor' },
  );
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

/**
 * Join a base URL with a path and a query.
 *
 * The path is **not** encoded here: a connector builds it from constants and validated values,
 * and encoding it twice would corrupt a path that legitimately contains a slash. The query values
 * *are* encoded, because a query value may contain anything.
 */
export function buildUrl(
  baseUrl: string,
  path: string,
  query?: Readonly<Record<string, string | number | boolean | undefined>> | undefined,
): string {
  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const suffix = path.startsWith('/') ? path : `/${path}`;
  if (query === undefined) return `${base}${suffix}`;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    params.append(key, String(value));
  }
  const serialized = params.toString();
  return serialized === '' ? `${base}${suffix}` : `${base}${suffix}?${serialized}`;
}

/** Serialize a JSON body for a request. */
export function jsonBody(payload: unknown): string {
  return JSON.stringify(payload);
}
