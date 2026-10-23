import { errorForTransport } from '../../../advanced-integrations/provider-error.js';
import { assertProviderUrl, ProviderHttpError } from '../../../advanced-integrations/provider-http-client.js';

/**
 * Phase 19-ES.4 — the HTTP door DocuSign is reached through
 * (`PLAN_Phase_19_ESignature.md` §9.3; audit §4 "never hard-code a data center host").
 *
 * Advanced Integrations' `createProviderHttpClient` owns the rules this module needs and are not
 * negotiable — a bounded timeout, redirects never followed, credentials banned from the URL, and the
 * destination checked against loopback/private/metadata addresses (SSRF). Those rules are **reused**
 * via `assertProviderUrl`, which is the same function that client calls.
 *
 * What is not reused is the client itself, for one specific reason: it throws a `ProviderError` for
 * every status ≥ 400 and discards the body. DocuSign's OAuth failures live *in* the body
 * (`{"error":"invalid_grant"}` is the difference between "the consent was revoked" and "the client
 * secret is wrong"), and the whole of plan §9.2's reauthorization handling depends on telling those
 * two apart. So this file keeps the address gate and the timeout, returns the status and the body
 * untouched, and leaves classification to the OAuth layer.
 *
 * Nothing here logs. A DocuSign request carries a bearer token in a header and an authorization code
 * in a body; neither may reach a log line (plan §9.3, §21).
 */

export interface DocuSignHttpRequest {
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly timeoutMs?: number;
  /** Read the answer as bytes (a signed PDF or a certificate), not as text. */
  readonly binary?: boolean;
}

export interface DocuSignHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  /** Present when the request asked for `binary: true`. */
  readonly bytes?: Uint8Array;
}

/** The transport seam. A test injects a stub and no socket is ever opened (plan §17.3). */
export interface DocuSignTransport {
  request(input: DocuSignHttpRequest): Promise<DocuSignHttpResponse>;
}

/**
 * The DI token for DocuSign's transport.
 *
 * One token, two consumers (the OAuth client and the live adapter), and a test suite that replaces it
 * once instead of monkey-patching `fetch`. The default provider is the platform-gated HTTPS transport;
 * the gate is `assertProviderUrl`, so a stored `base_uri` that points at a private or metadata address
 * is refused before a socket opens (plan §9.3, SSRF).
 */
export const DOCUSIGN_TRANSPORT = Symbol('DOCUSIGN_TRANSPORT');

export interface DocuSignTransportOptions {
  /** Injectable for tests, so a client test never opens a socket. */
  readonly fetchImpl?: typeof fetch;
  /**
   * Permit a loopback destination. Only a local validation harness uses this; a real DocuSign host is
   * never loopback, and the default stays closed.
   */
  readonly allowLoopback?: boolean;
  /** Injectable for tests of the address gate, so DNS is not required. */
  readonly resolveHost?: (host: string) => Promise<string[]>;
  readonly timeoutMs?: number;
}

/** A request that never left the process: the destination was refused before any socket. */
export class DocuSignDestinationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocuSignDestinationError';
  }
}

const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * The build's default transport.
 *
 * A loopback destination is permitted **only** under `NODE_ENV=test`, so the automated suite can drive
 * the real transport against a local stub (plan §9.4 step 1) while every other installation keeps the
 * rule that a provider is a public https host. Dev and production get the strict gate.
 */
export function createDefaultDocuSignTransport(): DocuSignTransport {
  return createDocuSignTransport({ allowLoopback: process.env.NODE_ENV === 'test' });
}

export function createDocuSignTransport(options: DocuSignTransportOptions = {}): DocuSignTransport {
  const doFetch = options.fetchImpl ?? fetch;
  const resolve = options.resolveHost ?? defaultResolve;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const allowLoopback = options.allowLoopback === true;

  return {
    async request(input: DocuSignHttpRequest): Promise<DocuSignHttpResponse> {
      let url: URL;
      try {
        url = await assertProviderUrl(input.url, { allowLoopback, resolve });
      } catch (error) {
        // The platform's gate is a `ProviderHttpError`; the adapter layer reports it as its own
        // stable failure so nothing above has to know which client produced it.
        if (error instanceof ProviderHttpError) throw new DocuSignDestinationError(error.message);
        throw error;
      }
      let response: Response;
      try {
        response = await doFetch(url.toString(), {
          method: input.method,
          headers: { accept: 'application/json', ...(input.headers ?? {}) },
          ...(input.body === undefined ? {} : { body: input.body }),
          // A redirect is never followed: a `302` from a provider is not an instruction to go elsewhere
          // with the same bearer token.
          redirect: 'manual',
          signal: AbortSignal.timeout(input.timeoutMs ?? timeoutMs),
        });
      } catch (error) {
        // A transport failure is classified with the platform's own rules and carries no body.
        throw errorForTransport(error);
      }
      let body = '';
      let bytes: Uint8Array | undefined;
      if (input.binary === true) {
        bytes = new Uint8Array(await response.arrayBuffer());
      } else {
        body = await response.text().catch(() => '');
      }
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
      return { status: response.status, headers, body, ...(bytes === undefined ? {} : { bytes }) };
    },
  };
}

async function defaultResolve(host: string): Promise<string[]> {
  if (host.includes(':') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return [host];
  try {
    const { lookup } = await import('node:dns/promises');
    const results = await lookup(host, { all: true });
    return results.map((entry) => entry.address);
  } catch {
    return [];
  }
}

/** `application/x-www-form-urlencoded`, in the order OAuth servers expect. */
export function formBody(fields: Readonly<Record<string, string>>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) params.set(key, value);
  return params.toString();
}

/** A JSON body that is allowed to be absent, malformed, or an HTML error page. */
export function parseJson(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
