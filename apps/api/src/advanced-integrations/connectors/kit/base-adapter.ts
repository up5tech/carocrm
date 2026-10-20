import type {
  ConnectionValidationResult,
  ConnectorAdapter,
  ConnectorContext,
  ExternalFieldSchema,
  ExternalObjectSchema,
} from '../../connector-adapter.port.js';
import type {
  OAuthAuthorizationStart,
  OAuthAuthorizeContext,
  OAuthExchangeContext,
  OAuthRefreshContext,
  OAuthRevokeContext,
  OAuthTokenSet,
} from '../../oauth-connector.js';
import type { ConnectorCapabilities } from '../../provider-capabilities.js';
import { type OAuth2ConnectorOptions,OAuth2Flow } from './oauth2-base.js';

/**
 * Phase 19-INT.16–19-INT.24 — the base classes every connector extends
 * (`PLAN_Phase_19_Advanced_Integrations.md` §5.3; `19-INT.16`–`19-INT.24`).
 *
 * A connector is a **vendor adapter**, and the vendor-specific part of it is small: a URL, a
 * header, a field name, a pagination rule. Everything the platform owns — the capability
 * declaration, the error model, the OAuth flow, the webhook verification contract — is
 * implemented once and inherited.
 *
 * Two base classes:
 *
 *  - `AbstractConnectorAdapter` declares the operations a connector must implement, so a new
 *    connector cannot forget one without a type error.
 *  - `OAuth2ConnectorBase` adds the four OAuth operations on top of `OAuth2Flow`.
 *
 * A connector that does not use OAuth extends `AbstractConnectorAdapter` and leaves the OAuth
 * operations out, which is exactly what the contract suite expects of it.
 */

/** The operations a connector declares it implements. */
export interface ConnectorOperationFlags {
  readonly implementsFetch: boolean;
  readonly implementsWrite: boolean;
  readonly implementsDelete: boolean;
  readonly implementsWebhook: boolean;
}

/**
 * The mandatory part of a connector.
 *
 * The read surface is mandatory for every connector — the platform has to be able to ask a
 * provider what it offers before a mapping can be built. The write, delete and webhook operations
 * are optional, and a connector that does not implement one must not declare it.
 */
export abstract class AbstractConnectorAdapter implements ConnectorAdapter {
  abstract readonly providerKey: string;
  abstract readonly adapterVersion: string;
  abstract readonly providerApiVersion: string;
  abstract readonly capabilities: ConnectorCapabilities;
  abstract readonly operations: ConnectorOperationFlags;

  readonly supportsAuthorization: boolean = false;
  readonly supportsRefresh: boolean = false;
  readonly supportsRevocation: boolean = false;

  /** The capability declaration. The registry validates it; the runtime reads it. */
  getCapabilities(): ConnectorCapabilities {
    return this.capabilities;
  }

  abstract validateConnection(context: ConnectorContext): Promise<ConnectionValidationResult>;

  abstract listObjectSchemas(context: ConnectorContext): Promise<readonly ExternalObjectSchema[]>;

  abstract listFields(context: ConnectorContext, objectType: string): Promise<readonly ExternalFieldSchema[]>;
}

/**
 * A connector that authenticates with OAuth 2.0.
 *
 * The four OAuth operations are delegated to `OAuth2Flow`, so a connector only has to declare
 * its endpoints and its scopes.
 */
export abstract class OAuth2ConnectorBase extends AbstractConnectorAdapter {
  override readonly supportsAuthorization: boolean = true;
  override readonly supportsRefresh: boolean = true;
  override readonly supportsRevocation: boolean = true;

  protected readonly oauth: OAuth2Flow;

  constructor(options: OAuth2ConnectorOptions) {
    super();
    this.oauth = new OAuth2Flow(options);
  }

  async authorize(context: OAuthAuthorizeContext): Promise<OAuthAuthorizationStart> {
    return this.oauth.authorize(context);
  }

  async exchangeCode(context: OAuthExchangeContext): Promise<OAuthTokenSet> {
    return this.oauth.exchangeCode(context);
  }

  async refreshCredentials(context: OAuthRefreshContext): Promise<OAuthTokenSet> {
    return this.oauth.refreshCredentials(context);
  }

  async revokeCredentials(context: OAuthRevokeContext): Promise<void> {
    return this.oauth.revokeCredentials(context);
  }
}
