import { errorForStatus, errorForTransport, parseRetryAfter, ProviderError } from './provider-error.js';

/**
 * Phase 19-INT.6 — the provider HTTP client
 * (`PLAN_Phase_19_Advanced_Integrations.md` §11.1, §11.4; `19-INT.6`).
 *
 * Every outbound call to a provider goes through this client. It exists so that the reliability
 * rules live in **one** place instead of being re-implemented by every connector:
 *
 *  - **A bounded timeout.** A provider that never answers must not hold a worker slot forever.
 *  - **Redirects are not followed.** A `302` to `http://169.254.169.254/` would turn a connector
 *    into an SSRF gadget. A redirect is surfaced to the connector, which may handle it deliberately.
 *  - **The destination is checked.** `https` is required; a private, loopback, link-local or
 *    cloud-metadata address is refused. Loopback is allowed only when the connection opts in,
 *    because a self-hosted generic REST endpoint legitimately runs on the same host.
 *  - **Nothing sensitive is logged.** The `Authorization` header, the body and the query string are
 *    never written to a log line; only the method, the host, the path and the status are.
 *  - **Errors are normalized.** A transport failure or an unexpected status becomes a
 *    `ProviderError`, so nothing above the client has to know what `fetch` throws.
 *
 * The client also offers the hook the resilience layer needs: `beforeRequest` is where a rate
 * limiter and a circuit breaker refuse a call before it leaves the process.
 */

/** The default request timeout. A provider call must not hold a worker slot indefinitely. */
export const DEFAULT_PROVIDER_TIMEOUT_MS = 20_000;

/** The upper bound on a provider timeout a connection may request. */
export const MAX_PROVIDER_TIMEOUT_MS = 120_000;

/** The headers a log line may name. Everything else is dropped. */
const LOGGABLE_HEADERS = new Set(['content-type', 'accept', 'user-agent', 'x-request-id']);

export interface ProviderHttpRequest {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly body?: string | undefined;
  /** Per-request override of the client's timeout. */
  readonly timeoutMs?: number | undefined;
  /**
   * A destination the connector has already vetted (a provider's own pagination link, for
   * example). It still goes through the address check — only the *scheme* check is relaxed.
   */
  readonly allowPrivateAddress?: boolean | undefined;
}

export interface ProviderHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  /** The provider's `Retry-After`, in milliseconds, when it sent one. */
  readonly retryAfterMs: number | null;
}

export interface ProviderRequestGuardContext {
  readonly providerKey: string;
  readonly connectionId: string | null;
  /** The provider's host, for a per-host quota. */
  readonly host: string;
}

/**
 * A hook the resilience layer installs.
 *
 * It may **refuse** a request by throwing. The rate limiter refuses with a rate-limited
 * `ProviderError`; the circuit breaker refuses with an outage one.
 */
export interface ProviderRequestGuard {
  beforeRequest(context: ProviderRequestGuardContext): Promise<void>;
}

export interface ProviderHttpClientOptions {
  readonly providerKey: string;
  readonly connectionId: string | null;
  readonly timeoutMs?: number | undefined;
  /** Whether a loopback destination is permitted (a self-hosted endpoint). */
  readonly allowLoopback?: boolean | undefined;
  readonly guard?: ProviderRequestGuard | undefined;
  /** A structured logger. Only non-sensitive fields ever reach it. */
  readonly log?: ((fields: Record<string, unknown>, message: string) => void) | undefined;
  /** Injectable for tests, so a client test never opens a socket. */
  readonly fetchImpl?: typeof fetch | undefined;
  /** Injectable for tests, so the address check can be exercised without DNS. */
  readonly resolveHost?: ((host: string) => Promise<string[]>) | undefined;
}

export class ProviderHttpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderHttpError';
  }
}

export interface ProviderHttpClient {
  request(input: ProviderHttpRequest): Promise<ProviderHttpResponse>;
}

/**
 * Build a client for one provider.
 *
 * Each connection gets its own client, because the timeout, the loopback allowance and the
 * resilience guard are all connection-scoped.
 */
export function createProviderHttpClient(options: ProviderHttpClientOptions): ProviderHttpClient {
  const timeoutMs = clampTimeout(options.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS);
  const allowLoopback = options.allowLoopback === true;
  const doFetch = options.fetchImpl ?? fetch;
  const resolve = options.resolveHost ?? defaultResolveHost;

  return {
    async request(input: ProviderHttpRequest): Promise<ProviderHttpResponse> {
      const url = await assertProviderUrl(input.url, { allowLoopback, resolve });
      const host = url.hostname;

      if (options.guard) {
        // The guard may refuse the request; its error is already a `ProviderError`.
        await options.guard.beforeRequest({ providerKey: options.providerKey, connectionId: options.connectionId, host });
      }

      const effectiveTimeout = clampTimeout(input.timeoutMs ?? timeoutMs);
      const headers = buildHeaders(input.headers);

      const started = Date.now();
      let response: Response;
      try {
        response = await doFetch(url.toString(), {
          method: input.method,
          headers,
          ...(input.body === undefined ? {} : { body: input.body }),
          // A redirect is never followed automatically.
          redirect: 'manual',
          signal: AbortSignal.timeout(effectiveTimeout),
        });
      } catch (error) {
        options.log?.(
          {
            providerKey: options.providerKey,
            connectionId: options.connectionId,
            method: input.method,
            host,
            path: url.pathname,
            durationMs: Date.now() - started,
            outcome: 'transport_error',
          },
          'provider request failed',
        );
        throw errorForTransport(error);
      }

      const body = await response.text().catch(() => '');
      const responseHeaders = readHeaders(response.headers);
      const retryAfterMs = parseRetryAfter(responseHeaders['retry-after']);

      options.log?.(
        {
          providerKey: options.providerKey,
          connectionId: options.connectionId,
          method: input.method,
          host,
          path: url.pathname,
          status: response.status,
          durationMs: Date.now() - started,
          retryAfterMs,
        },
        'provider request completed',
      );

      // A 3xx is surfaced rather than followed: the connector may handle it deliberately, and the
      // platform never follows a redirect on the provider's behalf.
      if (response.status >= 300 && response.status < 400) {
        throw new ProviderError(
          'UNKNOWN',
          `The provider answered with a redirect (HTTP ${String(response.status)}).`,
          {
            category: 'permanent_validation',
            retryable: false,
            detail: 'redirect_not_followed',
            status: response.status,
          },
        );
      }

      if (response.status >= 400) {
        throw errorForStatus(response.status, retryAfterMs);
      }

      return { status: response.status, headers: responseHeaders, body, retryAfterMs };
    },
  };
}

function clampTimeout(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_PROVIDER_TIMEOUT_MS;
  return Math.min(Math.round(value), MAX_PROVIDER_TIMEOUT_MS);
}

/**
 * The headers a request carries.
 *
 * The `Authorization` header is passed through — a connector must be able to authenticate — but
 * it is **never logged**: `LOGGABLE_HEADERS` decides what may be named, and it does not include it.
 */
function buildHeaders(headers: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const out: Record<string, string> = { accept: 'application/json' };
  if (headers !== undefined) {
    for (const [key, value] of Object.entries(headers)) {
      if (value === undefined || value === null) continue;
      out[key.toLowerCase()] = value;
    }
  }
  return out;
}

/** The header names a log line may carry. */
export function loggableHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (LOGGABLE_HEADERS.has(key.toLowerCase())) out[key.toLowerCase()] = value;
  }
  return out;
}

function readHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

export interface ProviderUrlOptions {
  readonly allowLoopback: boolean;
  readonly resolve: (host: string) => Promise<string[]>;
}

/**
 * Check a provider destination.
 *
 * `https` is required, and every address the host resolves to must be public. Loopback and the
 * local network are refused unless the connection explicitly opted in — which only a self-hosted
 * generic endpoint does.
 */
export async function assertProviderUrl(rawUrl: string, options: ProviderUrlOptions): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ProviderHttpError('The provider URL is not a valid absolute URL.');
  }
  if (url.username !== '' || url.password !== '') {
    throw new ProviderHttpError('The provider URL must not carry credentials.');
  }
  const host = url.hostname.toLowerCase();
  const isLoopbackHost = host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '[::1]';

  if (url.protocol === 'http:') {
    if (!options.allowLoopback) {
      throw new ProviderHttpError('The provider URL must use https.');
    }
    if (!isLoopbackHost) {
      throw new ProviderHttpError('A plain http provider URL is only permitted for a loopback address.');
    }
  } else if (url.protocol !== 'https:') {
    throw new ProviderHttpError('The provider URL must use https.');
  }

  if (host === 'metadata.google.internal' || host === 'metadata') {
    throw new ProviderHttpError('The provider URL must not target the cloud metadata service.');
  }

  const addresses = await options.resolve(host);
  for (const address of addresses) {
    if (isLoopbackAddress(address)) {
      if (!options.allowLoopback) {
        throw new ProviderHttpError('The provider URL resolves to a loopback address.');
      }
      continue;
    }
    if (!isPublicAddress(address)) {
      throw new ProviderHttpError('The provider URL resolves to a private address.');
    }
  }
  return url;
}

async function defaultResolveHost(host: string): Promise<string[]> {
  if (isIpv4(host) || host.includes(':')) return [host];
  try {
    const { lookup } = await import('node:dns/promises');
    const results = await lookup(host, { all: true });
    return results.map((entry) => entry.address);
  } catch {
    // An unresolvable host is refused by the transport, not silently accepted here.
    return [];
  }
}

function isIpv4(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

export function isLoopbackAddress(address: string): boolean {
  const lower = address.toLowerCase();
  if (lower === '::1' || lower === '0:0:0:0:0:0:0:1') return true;
  if (isIpv4(lower)) {
    const parts = lower.split('.').map((part) => Number(part));
    return parts[0] === 127;
  }
  return false;
}

export function isPublicAddress(address: string): boolean {
  if (isLoopbackAddress(address)) return false;
  if (isIpv4(address)) return isPublicIpv4(address);
  const lower = address.toLowerCase();
  if (lower === '::' || lower === '::1') return false;
  // Unique-local (fc00::/7) and link-local (fe80::/10), plus IPv4-mapped private ranges.
  if (/^f[cd]/.test(lower)) return false;
  if (/^fe[89ab]/.test(lower)) return false;
  const mapped = /^::ffff:(\d{1,3}(\.\d{1,3}){3})$/.exec(lower);
  if (mapped?.[1] !== undefined) return isPublicIpv4(mapped[1]);
  return true;
}

function isPublicIpv4(address: string): boolean {
  const parts = address.split('.').map((part) => Number(part));
  const [a, b] = parts;
  if (a === undefined || b === undefined) return false;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 169 && b === 254) return false; // link-local, including cloud metadata endpoints
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
  return true;
}
