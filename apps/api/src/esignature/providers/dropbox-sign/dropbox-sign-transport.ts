import { errorForTransport } from '../../../advanced-integrations/provider-error.js';
import { assertProviderUrl, ProviderHttpError } from '../../../advanced-integrations/provider-http-client.js';

/**
 * Phase 19-ES multi-provider follow-on — the HTTP door Dropbox Sign is reached through
 * (`PLAN_Phase_19_ESignature.md` §5.2, §9.3).
 *
 * DocuSign's transport is reused in shape, not in code: that one is typed for JSON strings, and
 * Dropbox Sign's create-and-send call is `multipart/form-data` with the document bytes inline. The
 * platform rules are the same and are **reused**, not re-implemented — `assertProviderUrl` is the
 * same destination gate (loopback/private/metadata refused), a bounded timeout, redirects never
 * followed, and no credential in a URL.
 *
 * Nothing here logs. A request carries the account's API key in an `Authorization` header.
 */

export interface DropboxSignHttpRequest {
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** A JSON body, a form body, or the encoded multipart payload. Never a credential. */
  readonly body?: Uint8Array;
  readonly timeoutMs?: number;
  /** Read the answer as bytes (a signed PDF), not only as text. */
  readonly binary?: boolean;
}

export interface DropboxSignHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  /** The body decoded as UTF-8, for JSON and error pages. */
  readonly text: string;
}

/** The transport seam. A test injects a stub and no socket is ever opened (plan §17.3). */
export interface DropboxSignTransport {
  request(input: DropboxSignHttpRequest): Promise<DropboxSignHttpResponse>;
}

/** One token for the OAuth-style account lookup and the adapter. */
export const DROPBOX_SIGN_TRANSPORT = Symbol('DROPBOX_SIGN_TRANSPORT');

export interface DropboxSignTransportOptions {
  readonly fetchImpl?: typeof fetch;
  readonly allowLoopback?: boolean;
  readonly resolveHost?: (host: string) => Promise<string[]>;
  readonly timeoutMs?: number;
}

/** A request that never left the process: the destination was refused before any socket. */
export class DropboxSignDestinationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DropboxSignDestinationError';
  }
}

const DEFAULT_TIMEOUT_MS = 20_000;

/** The build's default transport. Loopback is permitted only under `NODE_ENV=test`, as for DocuSign. */
export function createDefaultDropboxSignTransport(): DropboxSignTransport {
  return createDropboxSignTransport({ allowLoopback: process.env.NODE_ENV === 'test' });
}

export function createDropboxSignTransport(options: DropboxSignTransportOptions = {}): DropboxSignTransport {
  const doFetch = options.fetchImpl ?? fetch;
  const resolve = options.resolveHost ?? defaultResolve;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const allowLoopback = options.allowLoopback === true;

  return {
    async request(input: DropboxSignHttpRequest): Promise<DropboxSignHttpResponse> {
      let url: URL;
      try {
        url = await assertProviderUrl(input.url, { allowLoopback, resolve });
      } catch (error) {
        if (error instanceof ProviderHttpError) throw new DropboxSignDestinationError(error.message);
        throw error;
      }
      let response: Response;
      try {
        response = await doFetch(url.toString(), {
          method: input.method,
          headers: { accept: 'application/json', ...(input.headers ?? {}) },
          ...(input.body === undefined ? {} : { body: input.body }),
          // A redirect is never followed: a `302` from a provider is not an instruction to go
          // elsewhere with the same API key.
          redirect: 'manual',
          signal: AbortSignal.timeout(input.timeoutMs ?? timeoutMs),
        });
      } catch (error) {
        throw errorForTransport(error);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
      return { status: response.status, headers, body: bytes, text: Buffer.from(bytes).toString('utf8') };
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

/** A JSON body that is allowed to be absent, malformed, or an HTML error page. */
export function parseJsonText(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// multipart encoding
// ---------------------------------------------------------------------------

export interface MultipartPart {
  readonly name: string;
  readonly value: string | Uint8Array;
  /** Present on a file part: Dropbox Sign requires the original filename to type the document. */
  readonly filename?: string;
  readonly contentType?: string;
}

/**
 * Encode a `multipart/form-data` body.
 *
 * Written by hand rather than through `FormData`/`Blob`: the payload must be a `Uint8Array` the
 * transport can bound, the encoding must be identical between the real build and a test stub, and a
 * library that reorders fields would make a wire assertion meaningless. The boundary is random per
 * request and never appears in a field.
 */
export function encodeMultipart(parts: readonly MultipartPart[], boundary: string): Uint8Array {
  const chunks: Uint8Array[] = [];
  const text = (value: string) => new TextEncoder().encode(value);
  for (const part of parts) {
    chunks.push(text(`--${boundary}\r\n`));
    const safeName = part.name.replace(/["\r\n]/g, '_');
    if (part.filename !== undefined) {
      const safeFilename = part.filename.replace(/["\r\n]/g, '_');
      chunks.push(
        text(
          `Content-Disposition: form-data; name="${safeName}"; filename="${safeFilename}"\r\n` +
            `Content-Type: ${part.contentType ?? 'application/octet-stream'}\r\n\r\n`,
        ),
      );
      chunks.push(typeof part.value === 'string' ? text(part.value) : part.value);
    } else {
      chunks.push(text(`Content-Disposition: form-data; name="${safeName}"\r\n\r\n`));
      chunks.push(typeof part.value === 'string' ? text(part.value) : part.value);
    }
    chunks.push(text('\r\n'));
  }
  chunks.push(text(`--${boundary}--\r\n`));
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
