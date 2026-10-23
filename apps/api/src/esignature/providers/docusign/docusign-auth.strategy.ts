import type { ESignatureConnectionEnvironment } from '../../esignature-domain.js';
import { PROVIDER_KEY_DOCUSIGN } from '../signature-provider.keys.js';
import type {
  SignatureProviderAccount,
  SignatureProviderAccountLookupInput,
  SignatureProviderAuthorizationUrlInput,
  SignatureProviderAuthStrategy,
  SignatureProviderCodeExchangeInput,
  SignatureProviderRefreshInput,
  SignatureProviderTokenSet,
} from '../signature-provider-auth.port.js';
import {
  DOCUSIGN_REQUIRED_SCOPES,
  docusignAuthorizeUrl,
  DocuSignOAuthClient,
  type DocuSignTokenSet,
  resolveScopes,
  selectDocuSignAccount,
} from './docusign-oauth.js';
import type { DocuSignTransport } from './docusign-transport.js';

/**
 * Multi-provider follow-on — DocuSign's authorization strategy
 * (`PLAN_Phase_19_ESignature.md` §9.2; wrapped out of `docusign-oauth.ts`).
 *
 * The connection service no longer constructs a DocuSign client: it asks this strategy, which is
 * registered under the provider key, to build the consent URL, exchange the code, refresh the token
 * and resolve the account. Everything vendor-specific — hosts, scopes, userinfo, account selection —
 * stays in `docusign-oauth.ts` and this thin adapter, exactly as envelope shapes stay in
 * `docusign-adapter.ts`.
 *
 * The strategy holds no state and no credential: the transport is the platform's, and every value
 * arrives per call from the service's vault read.
 */
class DocuSignAuthStrategy implements SignatureProviderAuthStrategy {
  readonly providerKey = PROVIDER_KEY_DOCUSIGN;
  readonly authStyle = 'oauth2_authorization_code' as const;
  readonly defaultScopes = DOCUSIGN_REQUIRED_SCOPES;

  constructor(private readonly oauth: DocuSignOAuthClient) {}

  resolveScopes(requested: readonly string[]): string[] {
    return resolveScopes(requested);
  }

  authorizeUrl(input: SignatureProviderAuthorizationUrlInput): string {
    return docusignAuthorizeUrl({
      environment: input.environment,
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      state: input.state,
      scopes: input.scopes,
      codeChallenge: input.codeChallenge,
    });
  }

  async exchangeCode(input: SignatureProviderCodeExchangeInput): Promise<SignatureProviderTokenSet> {
    return toTokenSet(
      await this.oauth.exchangeCode({
        environment: input.environment,
        clientId: input.clientId,
        clientSecret: input.clientSecret,
        code: input.code,
        redirectUri: input.redirectUri,
        codeVerifier: input.codeVerifier,
      }),
    );
  }

  async refresh(input: SignatureProviderRefreshInput): Promise<SignatureProviderTokenSet> {
    return toTokenSet(
      await this.oauth.refresh({
        environment: input.environment,
        clientId: input.clientId,
        clientSecret: input.clientSecret,
        refreshToken: input.refreshToken,
        scopes: input.scopes,
      }),
    );
  }

  /** `userinfo` decides the account and its data-center base URI; nothing here infers them. */
  async accountContext(input: SignatureProviderAccountLookupInput): Promise<SignatureProviderAccount> {
    const info = await this.oauth.userinfo(input.environment as ESignatureConnectionEnvironment, input.accessToken);
    const account = selectDocuSignAccount(info, null);
    return {
      accountId: account.accountId,
      accountName: account.accountName,
      baseUri: account.baseUri,
      subjectUserId: info.subjectUserId,
    };
  }
}

export function createDocuSignAuthStrategy(transport: DocuSignTransport): SignatureProviderAuthStrategy {
  return new DocuSignAuthStrategy(new DocuSignOAuthClient(transport));
}

function toTokenSet(tokens: DocuSignTokenSet): SignatureProviderTokenSet {
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    grantedScopes: tokens.grantedScopes,
  };
}
