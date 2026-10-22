import { createHash } from 'node:crypto';

import { ProviderError, type ProviderErrorCode } from '../../../advanced-integrations/provider-error.js';
import { type DocuSignHttpResponse, type DocuSignTransport,formBody, parseJson } from './docusign-transport.js';

/**
 * Phase 19-ES.4 — DocuSign's OAuth 2.0 surface
 * (`PLAN_Phase_19_ESignature.md` §8.1, §9.2, §9.4; audit §4 "OAuth"; `19-ES.4`).
 *
 * The grant is **Confidential Authorization Code** — the default the plan and the audit agree on for
 * an administrator-authorized integration. JWT server-to-server is explicitly non-default (plan §9.2)
 * and is not implemented here; adding it later means a new client in this folder, a private key in the
 * vault, and a separate security review, not a flag on this one.
 *
 * The hosts are a table keyed by the connection's stored environment, never a settings field and never
 * request input: demo is `account-d.docusign.com`, production is `account.docusign.com` (audit §4). A
 * connection is *also* bound to its environment, so a state started against demo cannot complete
 * against production.
 *
 * What this file refuses to do:
 *
 *  - **Ask for more than the operations need.** `signature` and `impersonation` are the pair a
 *    user-authorized eSignature integration requires; `extended` only lengthens refresh-token lifetime
 *    and is off unless an administrator names it. `agent` and `admin` — account-wide administrative
 *    scopes — are on a deny list, because plan §9.2 forbids requesting them without separate approval,
 *    and an unknown scope string is refused rather than passed through.
 *  - **Log or return a code or token.** The authorization code lives only inside `exchangeCode`, and the
 *    only thing that leaves this file is a `DocuSignTokenSet` handed straight to the vault.
 *  - **Quote the provider.** An OAuth failure body can contain a token; the classification keeps the
 *    `error` *name* (`invalid_grant`) and throws away the rest.
 */

/** The identity hosts, by connection environment. There is no default; a caller must name one. */
export const DOCUSIGN_AUTH_HOSTS: Readonly<Record<'demo' | 'production', string>> = {
  demo: 'account-d.docusign.com',
  production: 'account.docusign.com',
};

/**
 * The environment variable that points the identity calls at a local harness (plan §9.4 step 1).
 *
 * It replaces the *host* of `/oauth/auth`, `/oauth/token` and `/oauth/userinfo` only; the REST base
 * URI still comes from `userinfo` and is never redirected by it. It exists so a developer or a test
 * can drive the real transport, the real query encoding and the real form body against a stub instead
 * of a hand-built object — and so nothing in the automated suite can reach DocuSign (plan §17.3).
 * Deployment-wide and deliberate, like `WEBHOOK_ENDPOINT_URL`; the module health view reports when it
 * is in force, because an installation whose consent screen is not DocuSign's must be visible.
 */
export const DOCUSIGN_BASE_URL_ENV = 'DOCUSIGN_BASE_URL';

/** The scopes every user-authorized eSignature integration needs (audit §4). */
export const DOCUSIGN_REQUIRED_SCOPES = ['signature', 'impersonation'] as const;

/** Scopes an administrator may add deliberately, each with what it buys. */
export const DOCUSIGN_OPTIONAL_SCOPES: Readonly<Record<string, string>> = {
  extended: 'Lengthens the refresh-token lifetime, so a connection needs re-authorization less often.',
};

/**
 * Scopes this module will never request, whatever a caller asks for: they grant account-wide
 * administration, which is outside the product and outside plan §9.2's minimum-necessary rule.
 */
export const DOCUSIGN_FORBIDDEN_SCOPES = ['agent', 'admin'] as const;

/** The OAuth credential kinds, named once so a typo cannot create a second vault row. */
export const DOCUSIGN_KIND_CLIENT_SECRET = 'client_secret';
export const DOCUSIGN_KIND_ACCESS_TOKEN = 'oauth_access_token';
export const DOCUSIGN_KIND_REFRESH_TOKEN = 'oauth_refresh_token';

export interface DocuSignTokenSet {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  /** ISO timestamp. DocuSign returns `expires_in` in seconds; the vault stores the resolved instant. */
  readonly expiresAt: string | null;
  readonly grantedScopes: readonly string[];
}

export interface DocuSignUserAccount {
  readonly accountId: string;
  readonly accountName: string | null;
  readonly baseUri: string;
  readonly isDefault: boolean;
}

export interface DocuSignUserInfo {
  readonly subjectUserId: string | null;
  readonly email: string | null;
  readonly accounts: readonly DocuSignUserAccount[];
}

export interface DocuSignAuthorizationRequest {
  readonly environment: 'demo' | 'production';
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly scopes: readonly string[];
  readonly codeChallenge: string | null;
}

export interface DocuSignTokenExchangeRequest {
  readonly environment: 'demo' | 'production';
  readonly clientId: string;
  readonly clientSecret: string;
  readonly code?: string;
  readonly redirectUri?: string;
  readonly codeVerifier?: string | null;
  readonly refreshToken?: string;
  readonly scopes?: readonly string[];
}

/**
 * The identity root for one environment.
 *
 * `https://account-d…` or `https://account…` unless a local validation harness named one (see
 * `DOCUSIGN_BASE_URL_ENV`). An unknown environment is a data fault, never a default.
 */
export function docusignIdentityBase(environment: 'demo' | 'production'): string {
  const override = process.env[DOCUSIGN_BASE_URL_ENV]?.trim() ?? '';
  if (override !== '') return override.replace(/\/+$/, '');
  return `https://${docusignAuthHost(environment)}`;
}

/** Resolve the identity host for a stored environment. An unknown environment is a data fault, not a default. */
export function docusignAuthHost(environment: string): string {
  const host = DOCUSIGN_AUTH_HOSTS[environment as 'demo' | 'production'];
  if (host === undefined) {
    throw new ProviderError('CONFIGURATION_INVALID', 'The signature connection names an unknown DocuSign environment.', {
      category: 'configuration_invalid',
      retryable: false,
      detail: 'environment_invalid',
    });
  }
  return host;
}

/**
 * The scopes this installation will ask for.
 *
 * The required pair is always present; a caller may add an *allowlisted* optional scope and may not add
 * anything else. Narrowing below the required pair is refused rather than silently widened, so an
 * administrator who asks for `signature` alone learns that the connection would not work.
 */
const REQUIRED: readonly string[] = DOCUSIGN_REQUIRED_SCOPES;
const FORBIDDEN: readonly string[] = DOCUSIGN_FORBIDDEN_SCOPES;

export function resolveScopes(requested: readonly string[] = []): string[] {
  const cleaned = requested.map((scope) => scope.trim()).filter((scope) => scope !== '');
  const forbidden = cleaned.filter((scope) => FORBIDDEN.includes(scope));
  if (forbidden.length > 0) {
    throw new ProviderError('CONFIGURATION_INVALID', 'These DocuSign scopes are administrative and are never requested by this module.', {
      category: 'configuration_invalid',
      retryable: false,
      detail: forbidden.join(','),
    });
  }
  const optional = new Set(Object.keys(DOCUSIGN_OPTIONAL_SCOPES));
  const unknown = cleaned.filter((scope) => !optional.has(scope) && !REQUIRED.includes(scope));
  if (unknown.length > 0) {
    throw new ProviderError('CONFIGURATION_INVALID', 'Unknown DocuSign scope requested.', {
      category: 'configuration_invalid',
      retryable: false,
      detail: 'scope_not_allowlisted',
    });
  }
  const narrowed = cleaned.filter((scope) => REQUIRED.includes(scope));
  if (cleaned.length > 0 && narrowed.length > 0 && narrowed.length < DOCUSIGN_REQUIRED_SCOPES.length) {
    throw new ProviderError('CONFIGURATION_INVALID', 'DocuSign requires both the signature and impersonation scopes for a user-authorized integration.', {
      category: 'configuration_invalid',
      retryable: false,
      detail: 'required_scope_narrowed',
    });
  }
  const scopes: string[] = [...DOCUSIGN_REQUIRED_SCOPES];
  for (const scope of cleaned) if (!scopes.includes(scope)) scopes.push(scope);
  return scopes;
}

/** The S256 PKCE challenge for a verifier. */
export function pkceChallengeFor(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/**
 * The stored key of an authorization state.
 *
 * The state itself is never persisted: a database read must not yield something that can be presented
 * to the callback (plan §8.1).
 */
export function hashOAuthState(state: string): string {
  return createHash('sha256').update(state).digest('hex');
}

/** The URL the administrator's browser is sent to. Nothing else may build it. */
export function docusignAuthorizeUrl(input: DocuSignAuthorizationRequest): string {
  const params = new URLSearchParams();
  params.set('response_type', 'code');
  params.set('client_id', input.clientId);
  params.set('redirect_uri', input.redirectUri);
  params.set('scope', input.scopes.join(' '));
  params.set('state', input.state);
  if (input.codeChallenge !== null && input.codeChallenge !== '') {
    params.set('code_challenge', input.codeChallenge);
    params.set('code_challenge_method', 'S256');
  }
  return `${docusignIdentityBase(input.environment)}/oauth/auth?${params.toString()}`;
}

/**
 * DocuSign's OAuth client.
 *
 * The connection-lifecycle service owns the state machine; this class owns only the wire. It is
 * constructed with a transport, so ES.4's tests drive a stub and no test can reach DocuSign
 * (plan §17.3), while a production build gets the platform-gated HTTPS transport.
 */
export class DocuSignOAuthClient {
  constructor(private readonly transport: DocuSignTransport) {}

  /** Exchange an authorization code for tokens. The code is never stored and never returned. */
  async exchangeCode(input: DocuSignTokenExchangeRequest): Promise<DocuSignTokenSet> {
    const fields: Record<string, string> = {
      grant_type: 'authorization_code',
      code: input.code ?? '',
      redirect_uri: input.redirectUri ?? '',
    };
    if (input.codeVerifier !== undefined && input.codeVerifier !== null && input.codeVerifier !== '') {
      fields.code_verifier = input.codeVerifier;
    }
    return this.tokenRequest(input, fields);
  }

  /**
   * Exchange a refresh token for a new access token.
   *
   * DocuSign requires the scope list on a refresh; it is the scopes the connection actually holds.
   * A rotating refresh token is destroyed by a second concurrent refresh, which is why the *caller*
   * serialises this call with an advisory lock.
   */
  async refresh(input: DocuSignTokenExchangeRequest): Promise<DocuSignTokenSet> {
    const fields: Record<string, string> = {
      grant_type: 'refresh_token',
      refresh_token: input.refreshToken ?? '',
      scope: (input.scopes ?? DOCUSIGN_REQUIRED_SCOPES).join(' '),
    };
    return this.tokenRequest(input, fields);
  }

  /**
   * `GET /oauth/userinfo` — the call that resolves the account id and the account-specific REST base URI.
   *
   * DocuSign returns one entry per account the user belongs to, and `base_uri` differs per account and
   * per data center, so it is read from here and never derived from the environment (audit §4).
   */
  async userinfo(environment: DocuSignAuthorizationRequest['environment'], accessToken: string): Promise<DocuSignUserInfo> {
    const url = `${docusignIdentityBase(environment)}/oauth/userinfo`;
    let response: DocuSignHttpResponse;
    try {
      response = await this.transport.request({ method: 'GET', url, headers: { authorization: `Bearer ${accessToken}` } });
    } catch (error) {
      throw classifyTransportError(error);
    }
    if (response.status === 401 || response.status === 403) {
      throw new ProviderError('TOKEN_EXPIRED', 'DocuSign refused the access token.', {
        category: 'authorization',
        retryable: false,
        detail: 'userinfo_unauthorized',
        status: response.status,
      });
    }
    if (response.status >= 400) throw statusError(response.status, parseJson(response.body));

    return parseDocuSignUserinfo(parseJson(response.body));
  }

  private async tokenRequest(input: DocuSignTokenExchangeRequest, fields: Record<string, string>): Promise<DocuSignTokenSet> {
    const url = `${docusignIdentityBase(input.environment)}/oauth/token`;
    // Confidential client: the credential goes in the Basic header, never in the body. DocuSign accepts
    // either; the header keeps the secret out of a form-encoded payload that a proxy may log.
    const basic = Buffer.from(`${input.clientId}:${input.clientSecret}`, 'utf8').toString('base64');
    let response: DocuSignHttpResponse;
    try {
      response = await this.transport.request({
        method: 'POST',
        url,
        headers: {
          authorization: `Basic ${basic}`,
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: formBody(fields),
      });
    } catch (error) {
      throw classifyTransportError(error);
    }
    const body = parseJson(response.body);
    if (response.status >= 400) throw statusError(response.status, body);

    const accessToken = stringOf(body['access_token']);
    if (accessToken === null || accessToken === '') {
      throw new ProviderError('CONFIGURATION_INVALID', 'DocuSign answered the token request without an access token.', {
        category: 'configuration_invalid',
        retryable: false,
        detail: 'token_missing',
        status: response.status,
      });
    }
    const expiresIn = Number(body['expires_in']);
    // DocuSign does not always echo `scope`. When it does, the answer is authoritative and a missing
    // scope is a real permission gap the caller must report; when it does not, the set that was asked
    // for is recorded as granted — DocuSign grants the full requested set or refuses the request.
    // ES.22 confirms this against a live demo account before any installation is called verified.
    const echoed = stringOf(body['scope']);
    const grantedScopes =
      echoed !== null
        ? echoed.split(' ').filter((scope) => scope !== '')
        : fields['scope'] !== undefined
          ? fields['scope'].split(' ').filter((scope) => scope !== '')
          : [...DOCUSIGN_REQUIRED_SCOPES];
    return {
      accessToken,
      refreshToken: stringOf(body['refresh_token']),
      expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000).toISOString() : null,
      grantedScopes,
    };
  }
}

/**
 * Parse DocuSign's user-information payload.
 *
 * Shared by the OAuth host (`GET /oauth/userinfo`, used at authorization) and the REST host
 * (`GET /restapi/v2.1/userinfo`, used by the adapter's health check): both return the same account
 * list, and the shapes drift by API version, so every field is read defensively and an account
 * without an id or a base URI is dropped rather than guessed at.
 */
export function parseDocuSignUserinfo(body: Record<string, unknown>): DocuSignUserInfo {
  const rawAccounts = Array.isArray(body['accounts']) ? body['accounts'] : [];
  const accounts: DocuSignUserAccount[] = [];
  for (const entry of rawAccounts) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const account = entry as Record<string, unknown>;
    const accountId = stringOf(account['account_id']);
    const baseUri = stringOf(account['base_uri']);
    if (accountId === null || baseUri === null) continue;
    const organization = account['organization'];
    const organizationName =
      organization !== null && typeof organization === 'object' && !Array.isArray(organization)
        ? stringOf((organization as Record<string, unknown>)['account_name'])
        : null;
    accounts.push({
      accountId,
      // `account` is the account *name* in DocuSign's payload; `organization.account_name` is the
      // newer field. Either is fine, neither is guaranteed.
      accountName: organizationName ?? stringOf(account['account']),
      baseUri,
      // DocuSign sends "true"/"false" as a string in some API versions.
      isDefault: account['is_default'] === true || account['is_default'] === 'true',
    });
  }
  return {
    subjectUserId: stringOf(body['sub']) ?? stringOf(body['user_id']),
    email: stringOf(body['email']),
    accounts,
  };
}

/**
 * Pick the account a connection should use.
 *
 * An exact id match wins — that is a re-authorization of a connection that already named an account.
 * Otherwise the account DocuSign marks default. A user with several accounts and no default is reported
 * as `account_ambiguous` rather than guessed at, because sending a contract to the wrong DocuSign
 * account is not a mistake an automatic choice may make (plan §9.2).
 */
export function selectDocuSignAccount(
  info: DocuSignUserInfo,
  preferredAccountId?: string | null,
): DocuSignUserAccount {
  const preferred = preferredAccountId?.trim() ?? '';
  if (preferred !== '') {
    const exact = info.accounts.find((account) => account.accountId === preferred);
    if (exact !== undefined) return exact;
  }
  if (info.accounts.length === 0) {
    throw new ProviderError('ACCOUNT_MISMATCH', 'DocuSign returned no account for this authorization.', {
      category: 'account_mismatch',
      retryable: false,
      detail: 'account_missing',
    });
  }
  const byDefault = info.accounts.find((account) => account.isDefault);
  if (byDefault !== undefined) return byDefault;
  if (info.accounts.length === 1) {
    const [only] = info.accounts;
    if (only === undefined) throw new ProviderError('ACCOUNT_MISMATCH', 'DocuSign returned no account.', { category: 'account_mismatch', retryable: false, detail: 'account_missing' });
    return only;
  }
  throw new ProviderError('ACCOUNT_MISMATCH', 'DocuSign returned several accounts and no default, so the connection cannot choose one.', {
    category: 'account_mismatch',
    retryable: false,
    detail: 'account_ambiguous',
  });
}

/**
 * Map an OAuth failure to a platform category.
 *
 * The distinction that matters for plan §9.2 is `invalid_grant` — the consent was revoked, expired or
 * already used — which must move the connection to `reauthorization_required` and stop sends, versus
 * `invalid_client` — the installed credentials are wrong — which is a configuration fault an
 * administrator fixes and must not be reported as a revocation.
 */
export function statusError(status: number, body: Record<string, unknown>): ProviderError {
  const oauthError = stringOf(body['error']) ?? '';
  if (oauthError === 'invalid_grant') {
    return new ProviderError('TOKEN_EXPIRED', 'DocuSign refused the grant: the consent is expired, revoked, or was already used.', {
      category: 'authorization',
      retryable: false,
      detail: 'invalid_grant',
      status,
    });
  }
  if (oauthError === 'invalid_client' || oauthError === 'unauthorized_client') {
    return new ProviderError('CONFIGURATION_INVALID', 'DocuSign refused the integration credentials. Check the client id and secret.', {
      category: 'configuration_invalid',
      retryable: false,
      detail: oauthError,
      status,
    });
  }
  if (oauthError === 'invalid_request' || oauthError === 'unsupported_grant_type') {
    return new ProviderError('INVALID_REQUEST', 'DocuSign refused the OAuth request.', {
      category: 'permanent_validation',
      retryable: false,
      detail: oauthError,
      status,
    });
  }
  const code: ProviderErrorCode = status === 429 ? 'RATE_LIMITED' : status === 401 || status === 403 ? 'PERMISSION_DENIED' : status === 404 ? 'NOT_FOUND' : status >= 500 ? 'PROVIDER_UNAVAILABLE' : 'UNKNOWN';
  const category = status === 429 ? 'rate_limited' : status === 401 || status === 403 ? 'authorization' : status === 404 ? 'not_found' : status >= 500 ? 'provider_outage' : 'permanent_validation';
  return new ProviderError(code, `DocuSign answered the OAuth request with HTTP ${String(status)}.`, {
    category,
    retryable: status === 429 || status >= 500,
    detail: oauthError === '' ? null : oauthError.slice(0, 64),
    status,
  });
}

/** A failure before any HTTP status existed — DNS, timeout, aborted socket. */
export function classifyTransportError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  return new ProviderError('NETWORK_ERROR', 'The DocuSign OAuth service could not be reached.', {
    category: 'provider_outage',
    retryable: true,
    detail: 'transport_error',
  });
}

function stringOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}
