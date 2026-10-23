import { ProviderError } from '../../../advanced-integrations/provider-error.js';
import { PROVIDER_KEY_DROPBOX_SIGN } from '../signature-provider.keys.js';
import type {
  SignatureProviderAccount,
  SignatureProviderAccountLookupInput,
  SignatureProviderAuthStrategy,
} from '../signature-provider-auth.port.js';
import { DROPBOX_SIGN_API_BASE, DROPBOX_SIGN_TIMEOUT_MS,DropboxSignApi } from './dropbox-sign-api.js';
import type { DropboxSignTransport } from './dropbox-sign-transport.js';

/**
 * Phase 19-ES multi-provider follow-on — Dropbox Sign's authorization strategy
 * (`PLAN_Phase_19_ESignature.md` §4.1, §9.2).
 *
 * Dropbox Sign's API-key style has no consent screen, no code exchange and no refresh: the key *is*
 * the grant. So the strategy answers the one question the connection service needs — "which account
 * does this credential belong to?" — and honestly omits the OAuth methods. The service asks the
 * catalog for the style first, and only an OAuth provider reaches the authorize/exchange path, so an
 * omission here is a stated position rather than a missing implementation.
 *
 * The account lookup is also the credential check: a key that `GET /account` refuses is a key the
 * connection service must not store, and a key that answers names the account and the API host
 * without any value being inferred from configuration.
 */
class DropboxSignAuthStrategy implements SignatureProviderAuthStrategy {
  readonly providerKey = PROVIDER_KEY_DROPBOX_SIGN;
  readonly authStyle = 'api_key' as const;
  /** An API key carries no scopes. */
  readonly defaultScopes: readonly string[] = [];

  constructor(private readonly transport: DropboxSignTransport) {}

  /**
   * Refuse every requested scope.
   *
   * There is nothing to narrow: the key's permissions are the account's API permissions and cannot be
   * requested or limited per connection. Accepting a scope name would let an admin screen claim a
   * least-privilege grant that does not exist.
   */
  resolveScopes(requested: readonly string[]): string[] {
    if (requested.length === 0) return [];
    throw new ProviderError('INVALID_REQUEST', 'Dropbox Sign API keys do not carry OAuth scopes.', {
      category: 'permanent_validation',
      retryable: false,
      detail: requested[0]?.slice(0, 40) ?? null,
    });
  }

  async accountContext(input: SignatureProviderAccountLookupInput): Promise<SignatureProviderAccount> {
    const api = new DropboxSignApi(this.transport, input.accessToken);
    const account = await api.account(DROPBOX_SIGN_TIMEOUT_MS);
    return {
      accountId: account.accountId,
      accountName: account.accountName,
      // The API is one host for every account; there is no per-account data center to discover.
      baseUri: DROPBOX_SIGN_API_BASE,
      subjectUserId: null,
    };
  }
}

export function createDropboxSignAuthStrategy(transport: DropboxSignTransport): SignatureProviderAuthStrategy {
  return new DropboxSignAuthStrategy(transport);
}
