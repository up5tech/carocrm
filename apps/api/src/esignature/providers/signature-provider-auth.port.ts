import type { ESignatureConnectionEnvironment } from '../esignature-domain.js';
import type { SignatureProviderAuthStyle } from './signature-provider.catalog.js';
import type { SignatureProviderKey } from './signature-provider.keys.js';

/**
 * Multi-provider follow-on — the provider **authorization** contract
 * (`PLAN_Phase_19_ESignature.md` §4.1, §5.2, §9.2).
 *
 * Envelope operations live on `SignatureProviderAdapter`; establishing the credential they run
 * against lives here. Keeping the two apart is what lets the connection service be provider-neutral:
 * it owns the state, the vault, the redirect-URI policy, the refresh lock and the lifecycle, while a
 * provider supplies only its own protocol.
 *
 * The DocuSign implementation wraps `docusign-oauth.ts`; a Dropbox Sign implementation will
 * exchange an API key for an account context instead of running a code grant. The connection service
 * asks the catalog which style a provider uses and refuses one it has no strategy for, so a cataloged
 * provider that is not installed fails with a stated reason instead of a half-built flow.
 *
 * Nothing here returns or accepts a value that may be logged: a code, a token and an API key are
 * handed straight to the vault by the caller.
 */

/** The token set an authorization or refresh produces, ready for the encrypted vault. */
export interface SignatureProviderTokenSet {
  readonly accessToken: string;
  /** `null` when the provider does not rotate one (an API-key provider has none at all). */
  readonly refreshToken: string | null;
  /** ISO instant, resolved from the provider's `expires_in`; `null` when the provider did not say. */
  readonly expiresAt: string | null;
  readonly grantedScopes: readonly string[];
}

export interface SignatureProviderAuthorizationUrlInput {
  readonly environment: ESignatureConnectionEnvironment;
  /** The public client id (OAuth) or public app key; never a secret. */
  readonly clientId: string;
  readonly redirectUri: string;
  /** The single-use state this platform issued. */
  readonly state: string;
  readonly scopes: readonly string[];
  /** PKCE S256 challenge. `null` only for a provider whose grant does not support PKCE. */
  readonly codeChallenge: string | null;
}

export interface SignatureProviderCodeExchangeInput {
  readonly environment: ESignatureConnectionEnvironment;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly code: string;
  readonly redirectUri: string;
  readonly codeVerifier: string | null;
}

export interface SignatureProviderRefreshInput {
  readonly environment: ESignatureConnectionEnvironment;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
  readonly scopes: readonly string[];
}

export interface SignatureProviderAccountLookupInput {
  readonly environment: ESignatureConnectionEnvironment;
  readonly accessToken: string;
}

/** The account a provider says the credential belongs to. Never inferred from configuration. */
export interface SignatureProviderAccount {
  readonly accountId: string;
  readonly accountName: string | null;
  /** The account-specific API base URI the adapter will address. */
  readonly baseUri: string;
  readonly subjectUserId: string | null;
}

/**
 * One provider's authorization protocol.
 *
 * `providerKey` is the dispatch key; a strategy that is registered for a cataloged provider makes
 * that provider connectable, which is why `create` asks for a strategy before it writes a row. The
 * optional methods are the honest "this provider's style does not need it" positions: an API-key
 * provider has no authorize URL and no code exchange, and it must not pretend to have them.
 */
export interface SignatureProviderAuthStrategy {
  readonly providerKey: SignatureProviderKey;
  readonly authStyle: SignatureProviderAuthStyle;
  /** The scopes the provider requests when the caller names none. Empty for a non-OAuth provider. */
  readonly defaultScopes: readonly string[];

  /** Narrow a caller's requested scopes to the provider's allowlist; an unknown scope is refused. */
  resolveScopes(requested: readonly string[]): string[];
  /** The provider's consent URL. Absent for a provider with no interactive authorization. */
  authorizeUrl?(input: SignatureProviderAuthorizationUrlInput): string;
  /** Trade an authorization code for tokens. */
  exchangeCode?(input: SignatureProviderCodeExchangeInput): Promise<SignatureProviderTokenSet>;
  /** Refresh an expired access token. */
  refresh?(input: SignatureProviderRefreshInput): Promise<SignatureProviderTokenSet>;
  /** Ask the provider which account the credential belongs to and where its API lives. */
  accountContext(input: SignatureProviderAccountLookupInput): Promise<SignatureProviderAccount>;
}

/**
 * The strategies this build binds, injected as an array so a provider module registers its own
 * without the connection service importing vendor code.
 */
export const SIGNATURE_PROVIDER_AUTHS = Symbol('SIGNATURE_PROVIDER_AUTHS');
