import type {
  OAuthAuthorizationStart,
  OAuthAuthorizeContext,
  OAuthExchangeContext,
  OAuthRefreshContext,
  OAuthRevokeContext,
  OAuthTokenSet,
} from './oauth-connector.js';
import type {
  ConnectorCapabilities,
  ConnectorOperation,
} from './provider-capabilities.js';

/**
 * Phase 19-INT.6 — the typed connector adapter port
 * (`PLAN_Phase_19_Advanced_Integrations.md` §5.3; `19-INT.6`).
 *
 * This is the contract every connector implements, and the only place a vendor's HTTP details,
 * payloads, token quirks, cursors and signature algorithms may live. The shared runtime consumes
 * typed results and normalized operations; it never sees a vendor type.
 *
 * Three properties make it work:
 *
 *  1. **Optional operations are optional.** A connector that only receives webhooks implements
 *     `verifyWebhook` and `normalizeWebhook` and nothing else. The plan is explicit: *"Do not
 *     force unsupported operations onto every connector."*
 *  2. **The capability declaration is the contract.** `getCapabilities()` returns the same
 *     declaration the registry validates, and the runtime checks it **before** dispatching.
 *  3. **Errors are normalized.** A connector throws `ProviderError`; nothing above it sees a
 *     vendor error type.
 */

/** The credential bundle a connector receives. The vault resolves it; it is never logged. */
export interface ConnectorCredential {
  readonly accessToken: string | null;
  readonly refreshToken: string | null;
  readonly apiKey: string | null;
  readonly clientSecret: string | null;
  /** ISO timestamp at which the access token stops being usable. */
  readonly expiresAt: string | null;
  /**
   * The shared secret the provider signs its webhooks with.
   *
   * It lives in the vault like every other credential, so a connector never receives a signing
   * secret through the ordinary configuration object — a configuration key that looks like a
   * credential is refused by `assertConfigIsSafe`.
   */
  readonly webhookSecret: string | null;
}

export interface ConnectorContext {
  readonly connectionId: string;
  readonly providerKey: string;
  readonly credential: ConnectorCredential;
  /** A non-secret provider account/tenant label, when the connection names one. */
  readonly tenantRef: string | null;
  /**
   * The connection's **non-secret** configuration.
   *
   * A connector needs per-connection facts the credential cannot carry: which calendars to sync,
   * which store to read, which enrichment profile to use. They arrive here rather than as
   * constructor arguments, because the adapter instance is shared by every connection of that
   * provider while the configuration is per connection.
   *
   * The value passed here has already passed `assertConfigIsSafe`, so it holds no credential.
   */
  readonly options: Readonly<Record<string, unknown>>;
  /**
   * The permission classes the provider actually granted.
   *
   * A connector checks them **before** a privileged operation, so a connection that was granted a
   * read-only scope refuses a write with an actionable `SCOPE_MISSING` instead of sending a
   * request the provider will reject.
   */
  readonly grantedScopes: readonly string[];
}

/** One field of a provider object. */
export interface ExternalFieldSchema {
  readonly name: string;
  readonly label: string;
  readonly type: string;
  readonly required: boolean;
  readonly unique: boolean;
  /** True when the field identifies an object across syncs. */
  readonly identifier: boolean;
  /** True when the value is personal, financial or communication data. */
  readonly sensitive: boolean;
  /** The provider's enum values, when the field is an enumeration. */
  readonly options?: readonly string[] | undefined;
}

export interface ExternalObjectSchema {
  readonly objectType: string;
  readonly label: string;
  readonly fields: readonly ExternalFieldSchema[];
  /** Whether the provider exposes an incremental feed for this object. */
  readonly incremental: boolean;
  /** The provider's maximum page size, when it publishes one. */
  readonly maxPageSize: number | null;
}

export interface ConnectionValidationResult {
  readonly ok: boolean;
  /** A stable, non-secret reason code: `TOKEN_EXPIRED`, `SCOPE_MISSING`, `ACCOUNT_MISMATCH`, … */
  readonly code: string | null;
  /** A redacted, operator-facing message. Never a credential. */
  readonly message: string | null;
  /** A non-secret identifier of the provider account, so an operator can recognise it. */
  readonly accountRef: string | null;
  /** The scopes the provider actually holds. */
  readonly grantedScopes: readonly string[];
}

/** A page request. The cursor is an **opaque** value; the runtime never decodes it. */
export interface FetchPageInput {
  readonly context: ConnectorContext;
  readonly objectType: string;
  /** The opaque cursor from the previous page, or `null` for the first page. */
  readonly cursor: string | null;
  /** The page size the runtime asks for. It is clamped by the connector's declared maximum. */
  readonly pageSize: number;
  /** A bound on how far back a full sync should look, when the caller scoped one. */
  readonly since: string | null;
}

export interface ExternalObject {
  readonly objectType: string;
  /** The provider's identifier. Always a **string**: a numeric-looking id is never parsed. */
  readonly externalId: string;
  /** The provider's parent identifier, when the object lives in a container. */
  readonly externalParentId: string | null;
  /** The raw fields. The runtime transforms them; the connector does not. */
  readonly fields: Readonly<Record<string, unknown>>;
  /** The provider's own timestamp, when it exposes a reliable one. */
  readonly updatedAt: string | null;
  /** The provider's version token or etag, when it exposes one. */
  readonly version: string | null;
  /** True when the provider reports the object as deleted. */
  readonly deleted: boolean;
}

export interface FetchPageResult {
  readonly objects: readonly ExternalObject[];
  /** The opaque continuation token, or `null` when the page is the last one. */
  readonly nextCursor: string | null;
  /** True when the provider reports that the cursor is no longer valid. */
  readonly cursorExpired: boolean;
}

/** An incremental request. The delta token is opaque, exactly like a cursor. */
export interface FetchChangesInput {
  readonly context: ConnectorContext;
  readonly objectType: string;
  /** The opaque delta token from the previous run, or `null` for the first run. */
  readonly deltaToken: string | null;
  readonly pageSize: number;
}

export interface FetchChangesResult {
  readonly objects: readonly ExternalObject[];
  readonly nextDeltaToken: string | null;
  readonly cursorExpired: boolean;
}

export interface UpsertObjectInput {
  readonly context: ConnectorContext;
  readonly objectType: string;
  /** The provider's identifier, when the object already exists. */
  readonly externalId: string | null;
  /**
   * The provider's parent identifier, when the object lives inside a container — a calendar, a
   * folder, a project. A connector needs it to address the object, because the same id may exist
   * in two containers.
   */
  readonly externalParentId: string | null;
  readonly fields: Readonly<Record<string, unknown>>;
  /** The provider's idempotency key, when it supports one. */
  readonly idempotencyKey: string | null;
}

export interface DeleteObjectInput {
  readonly context: ConnectorContext;
  readonly objectType: string;
  readonly externalId: string;
  /** The provider's parent identifier, when the object lives inside a container. */
  readonly externalParentId: string | null;
}

export interface ExternalMutationResult {
  readonly externalId: string;
  /** The provider's version token or etag after the mutation. */
  readonly version: string | null;
  readonly updatedAt: string | null;
  /** True when the provider created the object, false when it updated it. */
  readonly created: boolean;
}

export interface VerifyWebhookInput {
  readonly context: ConnectorContext;
  /** The exact bytes the provider sent, when the signature is computed over the raw body. */
  readonly rawBody: string | null;
  readonly headers: Readonly<Record<string, string | undefined>>;
  /** The parsed body, when the connector does not need the raw bytes. */
  readonly body: unknown;
  /** The provider's query parameters, including the endpoint-validation challenge. */
  readonly query: Readonly<Record<string, string | undefined>>;
}

export interface WebhookVerificationResult {
  readonly valid: boolean;
  /** A stable reason code when the signature is invalid. */
  readonly reason: string | null;
  /**
   * The challenge answer, when the provider requires an endpoint-validation handshake. The
   * runtime answers it with this value.
   */
  readonly challenge: string | null;
}

export interface NormalizeWebhookInput {
  readonly context: ConnectorContext;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: unknown;
}

export interface NormalizedProviderEvent {
  /** The provider's own event identifier, used for deduplication. */
  readonly deliveryId: string;
  readonly objectType: string;
  /** The provider's object identifier, when the event carries one. */
  readonly externalId: string | null;
  readonly eventType: string;
  /** The provider's own timestamp, when it exposes one. */
  readonly occurredAt: string | null;
  /** The raw fields, in the same shape a fetched object would have. */
  readonly fields: Readonly<Record<string, unknown>>;
  readonly deleted: boolean;
}

/**
 * The connector adapter.
 *
 * A connector implements this and registers itself with `IntegrationRegistry`. The registry
 * validates the declaration against the adapter's declared operations at registration, so a
 * capability the adapter cannot honour never reaches the admin UI.
 */
export interface ConnectorAdapter {
  readonly providerKey: string;
  readonly adapterVersion: string;
  readonly providerApiVersion: string;
  readonly capabilities: ConnectorCapabilities;
  /** Which optional operations the adapter implements. */
  readonly operations: {
    readonly implementsFetch: boolean;
    readonly implementsWrite: boolean;
    readonly implementsDelete: boolean;
    readonly implementsWebhook: boolean;
  };
  readonly supportsAuthorization: boolean;
  readonly supportsRefresh: boolean;
  readonly supportsRevocation: boolean;

  /** The capability declaration. The registry validates it; the runtime reads it. */
  getCapabilities(): ConnectorCapabilities;

  /**
   * Check a connection with the provider's **lowest-cost, read-only** call.
   *
   * It never creates, updates, charges, sends or deletes a provider object (plan §7.4).
   */
  validateConnection(context: ConnectorContext): Promise<ConnectionValidationResult>;

  /** The provider's objects and their fields. Used by the mapping builder. */
  listObjectSchemas(context: ConnectorContext): Promise<readonly ExternalObjectSchema[]>;
  listFields(context: ConnectorContext, objectType: string): Promise<readonly ExternalFieldSchema[]>;

  /** Enumerate one page of an object. */
  fetchPage?(input: FetchPageInput): Promise<FetchPageResult>;
  /** Read the incremental feed of an object. */
  fetchChanges?(input: FetchChangesInput): Promise<FetchChangesResult>;
  /** Create or update one provider object. */
  upsertObject?(input: UpsertObjectInput): Promise<ExternalMutationResult>;
  /** Delete one provider object. */
  deleteObject?(input: DeleteObjectInput): Promise<ExternalMutationResult>;

  /** Verify a provider callback's signature. */
  verifyWebhook?(input: VerifyWebhookInput): Promise<WebhookVerificationResult>;
  /** Turn a provider callback into normalized events. */
  normalizeWebhook?(input: NormalizeWebhookInput): Promise<readonly NormalizedProviderEvent[]>;

  /** The OAuth operations. A connector that does not use OAuth leaves them out. */
  authorize?(context: OAuthAuthorizeContext): Promise<OAuthAuthorizationStart>;
  exchangeCode?(context: OAuthExchangeContext): Promise<OAuthTokenSet>;
  refreshCredentials?(context: OAuthRefreshContext): Promise<OAuthTokenSet>;
  revokeCredentials?(context: OAuthRevokeContext): Promise<void>;

  /**
   * Renew the provider's **push** subscriptions for this connection.
   *
   * Only a provider that pushes changes needs it, and only a connector that implements webhooks
   * may implement it. It is a separate operation rather than a side effect of a read, because a
   * read must stay read-only (plan §7.4) and a renewal is a write to the provider.
   */
  renewSubscriptions?(context: ConnectorContext): Promise<SubscriptionRenewalResult>;
}

/** The outcome of a subscription renewal. */
export interface SubscriptionRenewalResult {
  /** The subscriptions that were renewed. */
  readonly renewed: readonly string[];
  /** The subscriptions that were created because none existed. */
  readonly created: readonly string[];
  /** The earliest moment a renewed subscription expires, when one is known. */
  readonly expiresAt: string | null;
  /** A non-secret diagnostic for the operator. Never a credential. */
  readonly detail: string | null;
}

/**
 * The operations a connector must implement for a declared capability to be honoured.
 *
 * The runtime checks a declaration **before** dispatching, so an operation the connector does not
 * implement is refused with a precise message rather than failing inside the adapter.
 */
export function adapterSupports(
  adapter: ConnectorAdapter,
  operation: ConnectorOperation,
): boolean {
  switch (operation) {
    case 'read':
      return adapter.operations.implementsFetch;
    case 'create':
    case 'update':
    case 'upsert':
      return adapter.operations.implementsWrite;
    case 'delete':
      return adapter.operations.implementsDelete;
    case 'webhook':
      return adapter.operations.implementsWebhook;
  }
}
