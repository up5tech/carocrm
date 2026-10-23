import { errorForStatus, parseRetryAfter, ProviderError } from '../../../advanced-integrations/provider-error.js';
import {
  type DropboxSignHttpRequest,
  type DropboxSignHttpResponse,
  type DropboxSignTransport,
  parseJsonText,
} from './dropbox-sign-transport.js';

/**
 * Phase 19-ES multi-provider follow-on — the Dropbox Sign API v3 client
 * (`PLAN_Phase_19_ESignature.md` §5.1, §5.2, §9.3).
 *
 * One small client, shared by the authorization strategy (the account lookup) and the adapter (every
 * envelope operation). It owns exactly three things:
 *
 *  - the documented base URL and Basic credential header (`API_KEY:` — key as username, empty
 *    password), the form the API reference specifies;
 *  - the JSON/form/multipart request shapes; and
 *  - the translation of an HTTP status into the platform's `ProviderError` categories.
 *
 * The last point is the boundary rule from ES.3: nothing above the adapter may read a Dropbox Sign
 * `error_name`, and an error message never travels — only a stable code, a category and a sanitized
 * detail. A 401 is `authorization` (a human must act), a 429 carries the provider's `Retry-After`, and
 * a 5xx is an outage. A 400 is `permanent_validation`, because the payload will be just as wrong on a
 * retry.
 */

/** The documented API host. It is a constant, not a per-account discovery result. */
export const DROPBOX_SIGN_API_BASE = 'https://api.hellosign.com/v3';

/** Per-call ceiling the adapter passes to every request; a call must never wait forever. */
export const DROPBOX_SIGN_TIMEOUT_MS = 20_000;

export interface DropboxSignRequestInput {
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** A path below the base, e.g. `/signature_request` or `/signature_request/abc`. */
  readonly path: string;
  readonly query?: Readonly<Record<string, string>> | undefined;
  /** A JSON body for the endpoints that accept one. */
  readonly json?: unknown;
  /** An already-encoded body (multipart), with its content type. */
  readonly raw?: { readonly body: Uint8Array; readonly contentType: string } | undefined;
  /** A hint that the answer is bytes (a signed PDF); the transport always returns bytes. */
  readonly binary?: boolean | undefined;
  readonly timeoutMs?: number | undefined;
}

export class DropboxSignApi {
  constructor(
    private readonly transport: DropboxSignTransport,
    private readonly apiKey: string,
  ) {}

  /** One authenticated API call. Returns the raw response; the caller classifies non-2xx itself. */
  async request(input: DropboxSignRequestInput): Promise<DropboxSignHttpResponse> {
    const query = new URLSearchParams(input.query ?? {}).toString();
    const url = `${DROPBOX_SIGN_API_BASE}${input.path}${query === '' ? '' : `?${query}`}`;
    const headers: Record<string, string> = {
      // Basic auth with the API key as the username and an empty password, per the API reference.
      authorization: `Basic ${Buffer.from(`${this.apiKey}:`, 'utf8').toString('base64')}`,
      'user-agent': 'CaroCRM-ESignature/1.0',
    };
    let body: Uint8Array | undefined;
    if (input.raw !== undefined) {
      headers['content-type'] = input.raw.contentType;
      body = input.raw.body;
    } else if (input.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = new TextEncoder().encode(JSON.stringify(input.json));
    }
    return this.transport.request({
      method: input.method,
      url,
      headers,
      ...(body === undefined ? {} : { body }),
      ...(input.binary === true ? { binary: true } : {}),
      timeoutMs: input.timeoutMs ?? DROPBOX_SIGN_TIMEOUT_MS,
    } satisfies DropboxSignHttpRequest);
  }

  /**
   * The account the credential belongs to.
   *
   * `GET /account` (without `account_id`/`email_address`) answers for the caller's own account — the
   * only identity question an API key can answer without guessing which account to ask about.
   */
  async account(timeoutMs: number = DROPBOX_SIGN_TIMEOUT_MS): Promise<{
    readonly accountId: string;
    readonly accountName: string | null;
    readonly email: string | null;
  }> {
    const response = await this.request({ method: 'GET', path: '/account', timeoutMs });
    if (response.status >= 400) throw dropboxSignErrorFor(response);
    const body = parseJsonText(response.text);
    const account = isRecord(body['account']) ? body['account'] : {};
    const accountId = stringOf(account['account_id']);
    if (accountId === null) {
      throw new ProviderError('PROVIDER_UNAVAILABLE', 'Dropbox Sign answered without an account identity.', {
        category: 'provider_outage',
        retryable: false,
        detail: 'account_missing',
      });
    }
    const email = stringOf(account['email_address']);
    return {
      accountId,
      // The API does not expose a team/company display name on this endpoint; the account email is
      // the honest label an administrator can recognise.
      accountName: email,
      email,
    };
  }
}

/**
 * Translate a refused Dropbox Sign answer into the platform taxonomy.
 *
 * The vendor's `error_name` is kept only as a bounded, sanitized `detail` — it is a stable code like
 * `invalid_auth`, not user text — and `error_msg` is never stored, because it can quote a field value.
 */
export function dropboxSignErrorFor(response: DropboxSignHttpResponse): ProviderError {
  const retryAfterMs = parseRetryAfter(response.headers['retry-after'] ?? null);
  const body = parseJsonText(response.text);
  const error = isRecord(body['error']) ? body['error'] : {};
  const name = stringOf(error['error_name']);
  if (response.status === 401 || response.status === 403) {
    return new ProviderError('TOKEN_EXPIRED', 'Dropbox Sign refused the API key.', {
      category: 'authorization',
      retryable: false,
      status: response.status,
      detail: name === null ? 'invalid_auth' : name.slice(0, 64),
    });
  }
  const base = errorForStatus(response.status, retryAfterMs);
  if (name === null) return base;
  return new ProviderError(base.code, base.message, {
    category: base.category,
    retryable: base.retryable,
    retryAfterMs: base.retryAfterMs,
    status: response.status,
    detail: name.slice(0, 64),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}
