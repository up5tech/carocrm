/**
 * Phase 19-INT.5 — the OAuth surface a connector implements
 * (`PLAN_Phase_19_Advanced_Integrations.md` §7.2; `19-INT.5`).
 *
 * These are the **provider-facing** types. The platform owns the flow — the state machine, the
 * single-use state, the PKCE verifier, the scope bookkeeping, the vault and the refresh lock — and
 * the connector owns only what is provider-specific: the authorization URL, the token exchange
 * and the provider's own error shape.
 *
 * 19-INT.6 turns this into the full typed adapter port with its HTTP client; the shapes below are
 * what the OAuth flow needs, and they are deliberately narrow.
 */

/** What the connector needs to build the authorization URL. */
export interface OAuthAuthorizeContext {
  readonly connectionId: string;
  readonly providerKey: string;
  /**
   * The redirect URI the platform will use. It is **allowlisted by the platform** and never taken
   * from request input.
   */
  readonly redirectUri: string;
  readonly scopes: readonly string[];
  /** The single-use state. The platform generated it; the connector only forwards it. */
  readonly state: string;
  /** The PKCE challenge, or `null` when the provider does not support PKCE. */
  readonly codeChallenge: string | null;
  readonly codeChallengeMethod: 'S256' | null;
  /** A non-secret provider account/tenant label, when the connection names one. */
  readonly tenantRef: string | null;
}

export interface OAuthAuthorizationStart {
  /** The URL the administrator's browser is sent to. */
  readonly authorizationUrl: string;
}

export interface OAuthExchangeContext {
  readonly connectionId: string;
  readonly providerKey: string;
  /** The one-time authorization code. It is never logged and never persisted. */
  readonly code: string;
  readonly redirectUri: string;
  /** The PKCE verifier, when the flow used one. */
  readonly codeVerifier: string | null;
  readonly scopes: readonly string[];
  /**
   * The connection's OAuth client secret.
   *
   * It comes from the credential vault, so it is per connection: two connections of one provider
   * never share a secret, and the platform never holds a deployment-wide client secret.
   */
  readonly clientSecret: string | null;
}

/** The provider's answer to a token request. */
export interface OAuthTokenSet {
  readonly accessToken: string;
  /** The refresh token, when the provider issued one. */
  readonly refreshToken: string | null;
  /** ISO timestamp at which the access token stops being usable. */
  readonly expiresAt: string | null;
  /** The scopes the provider actually granted. */
  readonly grantedScopes: readonly string[];
  readonly tokenType: string;
  /** A non-secret identifier of the connected provider account, for the operator to recognise. */
  readonly accountRef: string | null;
}

export interface OAuthRefreshContext {
  readonly connectionId: string;
  readonly providerKey: string;
  readonly refreshToken: string;
  readonly scopes: readonly string[];
  /** The connection's OAuth client secret, from the credential vault. */
  readonly clientSecret: string | null;
}

export interface OAuthRevokeContext {
  readonly connectionId: string;
  readonly providerKey: string;
  readonly accessToken: string | null;
  readonly refreshToken: string | null;
  /** The connection's OAuth client secret, from the credential vault. */
  readonly clientSecret: string | null;
}

/**
 * A provider error the platform did not expect.
 *
 * The connector translates its vendor's error into this shape. Nothing above the connector sees a
 * vendor type, and the message never carries a token.
 */
export class OAuthProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = 'OAuthProviderError';
  }
}
