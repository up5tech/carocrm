import type {
  OAuthAuthorizationStart,
  OAuthAuthorizeContext,
  OAuthExchangeContext,
  OAuthRefreshContext,
  OAuthRevokeContext,
  OAuthTokenSet,
} from '../../oauth-connector.js';
import { ProviderError } from '../../provider-error.js';
import { buildUrl, ConnectorHttp, isJsonObject, jsonBody, readString } from './connector-kit.js';

/**
 * Phase 19-INT.16–19-INT.24 — the shared OAuth 2.0 authorization-code flow
 * (`PLAN_Phase_19_Advanced_Integrations.md` §7.2; `19-INT.5`, `19-INT.16`–`19-INT.24`).
 *
 * The platform owns the flow; a connector owns only the vendor's endpoints and field names. That
 * split is already the rule of `OAuthFlowService` — it generates the state, the PKCE verifier and
 * the redirect URI, and it stores the tokens — so what is left for a connector is small and
 * identical for every OAuth provider:
 *
 *  1. build the authorization URL;
 *  2. exchange the code for a token set;
 *  3. refresh a token set;
 *  4. revoke a grant.
 *
 * Implementing that four times per provider would be nine copies of the same bug surface, so it is
 * implemented **once** here and configured per provider.
 *
 * Two rules are not configurable, because getting them wrong is a security failure:
 *
 *  - **The client secret never leaves the vault.** It is read from the credential bundle, sent in
 *    the token request, and never logged, never returned and never put in a URL.
 *  - **A failed exchange is a permanent failure.** The platform moves the connection to
 *    `reauthorization_required`; a connector that reported a transient failure would have the
 *    platform retry a grant that will never succeed.
 */

export type OAuthTokenAuthMethod = 'client_secret_post' | 'client_secret_basic';

export interface OAuth2ProviderConfig {
  readonly providerKey: string;
  /** The provider's authorization endpoint. */
  readonly authorizationEndpoint: string;
  /** The provider's token endpoint. */
  readonly tokenEndpoint: string;
  /** The provider's revocation endpoint, when it publishes one. */
  readonly revokeEndpoint?: string | undefined;
  /** How the provider separates scopes in the `scope` parameter. */
  readonly scopeSeparator: string;
  /** Whether the provider supports PKCE. */
  readonly supportsPkce: boolean;
  /** How the client authenticates at the token endpoint. */
  readonly tokenAuthMethod: OAuthTokenAuthMethod;
  /** Extra authorization parameters the provider requires. */
  readonly extraAuthorizeParams?: Readonly<Record<string, string>> | undefined;
  /** Extra token parameters the provider requires. */
  readonly extraTokenParams?: Readonly<Record<string, string>> | undefined;
  /**
   * Whether the provider returns the granted scopes in the token answer.
   *
   * When it does not, the platform keeps the scopes it asked for, which is what the provider
   * granted — a provider that does not report a reduced grant is treated as having granted what
   * was asked for.
   */
  readonly reportsGrantedScopes: boolean;
}

/** The client id of one provider, and whether the installation has one. */
export interface OAuthClientIdentity {
  readonly clientId: string;
  readonly clientSecret: string | null;
}

export interface OAuth2ConnectorOptions {
  readonly config: OAuth2ProviderConfig;
  /** Resolves the client id and secret. A connector that is not configured has no client id. */
  readonly identity: (providerKey: string) => OAuthClientIdentity | null;
  /** Injectable for tests, so an OAuth test never opens a socket. */
  readonly fetchImpl?: typeof fetch | undefined;
  /** Injectable for tests, so the address check can be exercised without DNS. */
  readonly resolveHost?: ((host: string) => Promise<string[]>) | undefined;
  /** A structured logger. Only non-sensitive fields ever reach it. */
  readonly log?: ((fields: Record<string, unknown>, message: string) => void) | undefined;
}

/**
 * The shared OAuth 2.0 authorization-code implementation.
 *
 * A connector holds one of these and delegates its four OAuth operations to it.
 */
export class OAuth2Flow {
  private readonly config: OAuth2ProviderConfig;
  private readonly identity: (providerKey: string) => OAuthClientIdentity | null;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly resolveHost: ((host: string) => Promise<string[]>) | undefined;
  private readonly log: ((fields: Record<string, unknown>, message: string) => void) | undefined;

  constructor(options: OAuth2ConnectorOptions) {
    this.config = options.config;
    this.identity = options.identity;
    this.fetchImpl = options.fetchImpl;
    this.resolveHost = options.resolveHost;
    this.log = options.log;
  }

  /** Build the authorization URL the administrator's browser is sent to. */
  async authorize(context: OAuthAuthorizeContext): Promise<OAuthAuthorizationStart> {
    const identity = this.requireIdentity();
    const query: Record<string, string> = {
      client_id: identity.clientId,
      redirect_uri: context.redirectUri,
      response_type: 'code',
      state: context.state,
    };
    if (context.scopes.length > 0) {
      query['scope'] = context.scopes.join(this.config.scopeSeparator);
    }
    if (context.codeChallenge !== null && this.config.supportsPkce) {
      query['code_challenge'] = context.codeChallenge;
      query['code_challenge_method'] = context.codeChallengeMethod ?? 'S256';
    }
    for (const [key, value] of Object.entries(this.config.extraAuthorizeParams ?? {})) {
      query[key] = value;
    }
    return { authorizationUrl: buildUrl(this.config.authorizationEndpoint, '', query) };
  }

  /** Exchange the one-time code for a token set. */
  async exchangeCode(context: OAuthExchangeContext): Promise<OAuthTokenSet> {
    const identity = this.requireIdentity();
    const secret = context.clientSecret ?? identity.clientSecret;
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: context.code,
      redirect_uri: context.redirectUri,
    });
    if (context.codeVerifier !== null) body.append('code_verifier', context.codeVerifier);
    if (this.config.tokenAuthMethod === 'client_secret_post') {
      body.append('client_id', identity.clientId);
      if (secret !== null) body.append('client_secret', secret);
    }
    for (const [key, value] of Object.entries(this.config.extraTokenParams ?? {})) {
      body.append(key, value);
    }
    return this.tokenRequest(body, { ...identity, clientSecret: secret }, context.scopes, 'authorization_code');
  }

  /** Refresh an access token. */
  async refreshCredentials(context: OAuthRefreshContext): Promise<OAuthTokenSet> {
    const identity = this.requireIdentity();
    const secret = context.clientSecret ?? identity.clientSecret;
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: context.refreshToken,
    });
    if (this.config.tokenAuthMethod === 'client_secret_post') {
      body.append('client_id', identity.clientId);
      if (secret !== null) body.append('client_secret', secret);
    }
    for (const [key, value] of Object.entries(this.config.extraTokenParams ?? {})) {
      body.append(key, value);
    }
    return this.tokenRequest(body, { ...identity, clientSecret: secret }, context.scopes, 'refresh_token');
  }

  /** Revoke the provider grant. A provider without a revocation endpoint is a no-op. */
  async revokeCredentials(context: OAuthRevokeContext): Promise<void> {
    if (this.config.revokeEndpoint === undefined) return;
    const identity = this.requireIdentity();
    const secret = context.clientSecret ?? identity.clientSecret;
    const body = new URLSearchParams();
    if (context.accessToken !== null) body.append('token', context.accessToken);
    if (this.config.tokenAuthMethod === 'client_secret_post') {
      body.append('client_id', identity.clientId);
      if (secret !== null) body.append('client_secret', secret);
    }
    const http = this.http(context.connectionId);
    await http.raw({
      method: 'POST',
      url: this.config.revokeEndpoint,
      headers: this.headers({ ...identity, clientSecret: secret }, { 'content-type': 'application/x-www-form-urlencoded' }),
      body: body.toString(),
    });
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private async tokenRequest(
    body: URLSearchParams,
    identity: OAuthClientIdentity,
    requestedScopes: readonly string[],
    grant: string,
  ): Promise<OAuthTokenSet> {
    const http = this.http(null);
    const payload = await http.json<unknown>({
      method: 'POST',
      url: this.config.tokenEndpoint,
      headers: this.headers(identity, { 'content-type': 'application/x-www-form-urlencoded' }),
      body: body.toString(),
    });
    if (!isJsonObject(payload)) {
      throw new ProviderError('TOKEN_EXPIRED', `The provider answered the ${grant} request with an unreadable body.`, {
        category: 'authorization',
        retryable: false,
        detail: 'malformed_token_response',
      });
    }
    const accessToken = readString(payload, 'access_token');
    if (accessToken === null || accessToken === '') {
      throw new ProviderError('TOKEN_EXPIRED', `The provider refused the ${grant} request.`, {
        category: 'authorization',
        retryable: false,
        detail: 'no_access_token',
      });
    }
    const expiresIn = payload['expires_in'];
    const expiresAt =
      typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0
        ? new Date(Date.now() + expiresIn * 1000).toISOString()
        : null;
    const reportedScope = readString(payload, 'scope');
    const grantedScopes = this.config.reportsGrantedScopes
      ? reportedScope === null || reportedScope === ''
        ? [...requestedScopes]
        : reportedScope.split(this.config.scopeSeparator).map((scope) => scope.trim()).filter((scope) => scope !== '')
      : [...requestedScopes];
    return {
      accessToken,
      refreshToken: readString(payload, 'refresh_token'),
      expiresAt,
      grantedScopes,
      tokenType: readString(payload, 'token_type') ?? 'Bearer',
      accountRef: null,
    };
  }

  private headers(identity: OAuthClientIdentity, extra: Readonly<Record<string, string>>): Record<string, string> {
    if (this.config.tokenAuthMethod === 'client_secret_basic' && identity.clientSecret !== null) {
      const basic = Buffer.from(`${identity.clientId}:${identity.clientSecret}`).toString('base64');
      return { ...extra, authorization: `Basic ${basic}` };
    }
    return { ...extra };
  }

  private http(connectionId: string | null): ConnectorHttp {
    return new ConnectorHttp({
      providerKey: this.config.providerKey,
      connectionId,
      ...(this.fetchImpl === undefined ? {} : { fetchImpl: this.fetchImpl }),
      ...(this.resolveHost === undefined ? {} : { resolveHost: this.resolveHost }),
      ...(this.log === undefined ? {} : { log: this.log }),
    });
  }

  private requireIdentity(): OAuthClientIdentity {
    const identity = this.identity(this.config.providerKey);
    if (identity === null) {
      throw new ProviderError(
        'CONFIGURATION_INVALID',
        `Provider "${this.config.providerKey}" has no OAuth client id configured for this installation, so it cannot be authorized.`,
        { category: 'configuration_invalid', retryable: false, detail: 'no_client_id' },
      );
    }
    return identity;
  }
}

/**
 * The OAuth client ids of the installation, parsed from the deployment configuration.
 *
 * A malformed value yields an empty map rather than a boot failure: a broken configuration must
 * not stop the whole platform from loading, and the connector reports the missing client id with
 * a precise message when somebody tries to authorize it.
 */
export function parseOauthClientIds(raw: string): Readonly<Record<string, string>> {
  const trimmed = raw.trim();
  if (trimmed === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return {};
  }
  if (!isJsonObject(parsed)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') continue;
    const trimmedValue = value.trim();
    if (trimmedValue === '') continue;
    out[key] = trimmedValue;
  }
  return out;
}

/** Serialize a form body. */
export function formBody(values: Readonly<Record<string, string>>): string {
  return new URLSearchParams(values).toString();
}

/** Serialize a JSON body. */
export { jsonBody };
