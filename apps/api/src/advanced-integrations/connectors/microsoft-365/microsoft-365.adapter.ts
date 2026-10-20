import { createHash } from 'node:crypto';

import type {
  ConnectionValidationResult,
  ConnectorContext,
  DeleteObjectInput,
  ExternalFieldSchema,
  ExternalMutationResult,
  ExternalObject,
  ExternalObjectSchema,
  FetchChangesInput,
  FetchChangesResult,
  FetchPageInput,
  FetchPageResult,
  NormalizedProviderEvent,
  NormalizeWebhookInput,
  SubscriptionRenewalResult,
  UpsertObjectInput,
  VerifyWebhookInput,
  WebhookVerificationResult,
} from '../../connector-adapter.port.js';
import { CONNECTOR_CAPABILITY_SCHEMA_VERSION, type ConnectorCapabilities } from '../../provider-capabilities.js';
import { ProviderError } from '../../provider-error.js';
import { type ConnectorOperationFlags,OAuth2ConnectorBase } from '../kit/base-adapter.js';
import {
  buildUrl,
  ConnectorHttp,
  decodeCursor,
  encodeCursor,
  isJsonObject,
  readString,
} from '../kit/connector-kit.js';
import type { OAuth2ProviderConfig } from '../kit/oauth2-base.js';
import { readChallenge, verifyClientState } from '../kit/webhook-signatures.js';

/**
 * Phase 19-INT.17 — the Microsoft 365 connector
 * (`PLAN_Phase_19_Advanced_Integrations.md` §12.2; `19-INT.17`).
 *
 * Outlook calendar and contacts through Microsoft Graph.
 *
 * Three decisions shape this connector, and each of them exists because the obvious alternative
 * fails a specific acceptance criterion:
 *
 *  1. **The delta link is the cursor.** Graph's incremental feed answers with a `@odata.nextLink`
 *     while there is more and a `@odata.deltaLink` when there is not. The connector keeps the
 *     current link in its own opaque cursor, so the engine pages through the whole delta feed and
 *     the **final** delta link is what gets persisted. A connector that returned the first page's
 *     link would either re-read forever or skip a change.
 *  2. **A `nextLink` is followed only after it is checked.** Graph's links are absolute URLs, and
 *     an absolute URL that came from a provider is still an untrusted destination. Every link is
 *     re-validated against the Graph host before it is requested, so a tampered cursor cannot
 *     turn the connector into an SSRF gadget.
 *  3. **Change notifications are authenticated by `clientState`, not by a signature.** Graph does
 *     not sign its notifications. The subscriber chooses a `clientState` and the platform compares
 *     it in constant time; a delivery that does not carry it is refused.
 *
 * Mailbox transport is **not** implemented here: it belongs to the shared email subsystem
 * (plan §12.2, provider matrix §1.2).
 */

export const MICROSOFT_365_PROVIDER_KEY = 'microsoft-365';

/** The Graph API version, pinned deliberately. */
export const MICROSOFT_GRAPH_API_VERSION = 'v1.0';

/** The only host the connector ever talks to. */
export const MICROSOFT_GRAPH_HOST = 'graph.microsoft.com';

const GRAPH_BASE_URL = `https://${MICROSOFT_GRAPH_HOST}/${MICROSOFT_GRAPH_API_VERSION}`;

/** The scopes the connector asks for. */
export const MICROSOFT_CALENDAR_READ_SCOPE = 'Calendars.Read';
export const MICROSOFT_CALENDAR_WRITE_SCOPE = 'Calendars.ReadWrite';
export const MICROSOFT_CONTACTS_READ_SCOPE = 'Contacts.Read';
export const MICROSOFT_CONTACTS_WRITE_SCOPE = 'Contacts.ReadWrite';

/** The maximum page size Graph honours. */
export const MICROSOFT_GRAPH_MAX_PAGE_SIZE = 999;

/** The object types this connector offers. */
export const MICROSOFT_EVENT_OBJECT = 'outlookEvent';
export const MICROSOFT_CONTACT_OBJECT = 'outlookContact';

const EVENT_FIELDS: readonly ExternalFieldSchema[] = [
  { name: 'id', label: 'Event ID', type: 'string', required: true, unique: true, identifier: true, sensitive: false },
  { name: 'subject', label: 'Subject', type: 'string', required: false, unique: false, identifier: false, sensitive: false },
  { name: 'bodyPreview', label: 'Preview', type: 'string', required: false, unique: false, identifier: false, sensitive: false },
  { name: 'location', label: 'Location', type: 'string', required: false, unique: false, identifier: false, sensitive: false },
  { name: 'start', label: 'Starts at', type: 'datetime', required: true, unique: false, identifier: false, sensitive: false },
  { name: 'end', label: 'Ends at', type: 'datetime', required: true, unique: false, identifier: false, sensitive: false },
  { name: 'showAs', label: 'Show as', type: 'string', required: false, unique: false, identifier: false, sensitive: false },
  { name: 'sensitivity', label: 'Sensitivity', type: 'string', required: false, unique: false, identifier: false, sensitive: false },
  { name: 'isCancelled', label: 'Cancelled', type: 'boolean', required: false, unique: false, identifier: false, sensitive: false },
  { name: 'lastModifiedDateTime', label: 'Modified at', type: 'datetime', required: false, unique: false, identifier: false, sensitive: false },
];

const CONTACT_FIELDS: readonly ExternalFieldSchema[] = [
  { name: 'id', label: 'Contact ID', type: 'string', required: true, unique: true, identifier: true, sensitive: false },
  { name: 'displayName', label: 'Name', type: 'string', required: false, unique: false, identifier: false, sensitive: false },
  { name: 'emailAddresses', label: 'Email addresses', type: 'array', required: false, unique: false, identifier: false, sensitive: true },
  { name: 'phoneNumbers', label: 'Phone numbers', type: 'array', required: false, unique: false, identifier: false, sensitive: true },
  { name: 'jobTitle', label: 'Job title', type: 'string', required: false, unique: false, identifier: false, sensitive: false },
  { name: 'companyName', label: 'Company', type: 'string', required: false, unique: false, identifier: false, sensitive: false },
];

/** The capability declaration of the Microsoft 365 connector. */
export function microsoft365Capabilities(): ConnectorCapabilities {
  const outlookEvent = {
    objectType: MICROSOFT_EVENT_OBJECT,
    label: 'Outlook event',
    read: true,
    create: true,
    update: true,
    delete: true,
    upsert: false,
    webhook: true,
    syncDirections: ['inbound', 'outbound'] as const,
    fullSync: true,
    incrementalSync: true,
    requiredScopes: [MICROSOFT_CALENDAR_READ_SCOPE],
    optionalScopes: [MICROSOFT_CALENDAR_WRITE_SCOPE],
    maxPageSize: MICROSOFT_GRAPH_MAX_PAGE_SIZE,
    rateLimitStrategy: 'provider_header' as const,
    externalIdFields: ['id'],
    uniqueFields: ['id'],
    deletionVisibility: 'tombstoned' as const,
    transactional: false,
    dataSensitivity: 'communication' as const,
  };
  const outlookContact = {
    objectType: MICROSOFT_CONTACT_OBJECT,
    label: 'Outlook contact',
    read: true,
    create: true,
    update: true,
    delete: true,
    upsert: false,
    webhook: true,
    syncDirections: ['inbound', 'outbound'] as const,
    fullSync: true,
    incrementalSync: true,
    requiredScopes: [MICROSOFT_CONTACTS_READ_SCOPE],
    optionalScopes: [MICROSOFT_CONTACTS_WRITE_SCOPE],
    maxPageSize: MICROSOFT_GRAPH_MAX_PAGE_SIZE,
    rateLimitStrategy: 'provider_header' as const,
    externalIdFields: ['id'],
    uniqueFields: ['id'],
    deletionVisibility: 'tombstoned' as const,
    transactional: false,
    dataSensitivity: 'personal' as const,
  };
  return {
    schemaVersion: CONNECTOR_CAPABILITY_SCHEMA_VERSION,
    authentication: 'oauth',
    objects: [outlookEvent, outlookContact],
    webhook: { supported: true, requiresRawBody: false, requiresEndpointValidation: true },
  };
}

/** The OAuth 2.0 configuration of the Microsoft 365 connector. */
export const MICROSOFT_365_OAUTH_CONFIG: OAuth2ProviderConfig = {
  providerKey: MICROSOFT_365_PROVIDER_KEY,
  authorizationEndpoint: `https://login.microsoftonline.com/common/oauth2/v2.0/authorize`,
  tokenEndpoint: `https://login.microsoftonline.com/common/oauth2/v2.0/token`,
  scopeSeparator: ' ',
  supportsPkce: true,
  tokenAuthMethod: 'client_secret_post',
  reportsGrantedScopes: true,
};

/** The cursor the connector writes. */
interface GraphCursor {
  readonly nextLink: string | null;
  readonly deltaLink: string | null;
}

export interface Microsoft365AdapterOptions {
  readonly identity: (providerKey: string) => { clientId: string; clientSecret: string | null } | null;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly resolveHost?: ((host: string) => Promise<string[]>) | undefined;
  readonly log?: ((fields: Record<string, unknown>, message: string) => void) | undefined;
  readonly httpFactory?: ((connectionId: string) => ConnectorHttp) | undefined;
}

/**
 * The Microsoft 365 connector.
 */
export class Microsoft365Adapter extends OAuth2ConnectorBase {
  override readonly providerKey = MICROSOFT_365_PROVIDER_KEY;
  override readonly adapterVersion = '1.0.0';
  override readonly providerApiVersion = MICROSOFT_GRAPH_API_VERSION;
  override readonly capabilities: ConnectorCapabilities = microsoft365Capabilities();
  override readonly operations: ConnectorOperationFlags = {
    implementsFetch: true,
    implementsWrite: true,
    implementsDelete: true,
    implementsWebhook: true,
  };

  private readonly httpFactory: (connectionId: string) => ConnectorHttp;

  constructor(options: Microsoft365AdapterOptions) {
    super({
      config: MICROSOFT_365_OAUTH_CONFIG,
      identity: options.identity,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.resolveHost === undefined ? {} : { resolveHost: options.resolveHost }),
      ...(options.log === undefined ? {} : { log: options.log }),
    });
    this.httpFactory =
      options.httpFactory ??
      ((connectionId: string) =>
        new ConnectorHttp({
          providerKey: MICROSOFT_365_PROVIDER_KEY,
          connectionId,
          ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
          ...(options.resolveHost === undefined ? {} : { resolveHost: options.resolveHost }),
          ...(options.log === undefined ? {} : { log: options.log }),
        }));
  }

  /**
   * Check the connection with the cheapest read-only call.
   *
   * `GET /me` is the smallest call Graph offers and it exercises the token and the tenant context
   * at the same time.
   */
  async validateConnection(context: ConnectorContext): Promise<ConnectionValidationResult> {
    const http = this.httpFactory(context.connectionId);
    try {
      const payload = await http.json<unknown>({
        method: 'GET',
        url: buildUrl(GRAPH_BASE_URL, '/me', { '$select': 'id,displayName,userPrincipalName' }),
        headers: this.authHeaders(context),
      });
      const body = isJsonObject(payload) ? payload : {};
      return {
        ok: true,
        code: null,
        message: null,
        accountRef: readString(body, 'userPrincipalName') ?? context.tenantRef,
        grantedScopes: [...context.grantedScopes],
      };
    } catch (error) {
      return this.failure(error);
    }
  }

  async listObjectSchemas(_context: ConnectorContext): Promise<readonly ExternalObjectSchema[]> {
    return [
      {
        objectType: MICROSOFT_EVENT_OBJECT,
        label: 'Outlook event',
        fields: EVENT_FIELDS,
        incremental: true,
        maxPageSize: MICROSOFT_GRAPH_MAX_PAGE_SIZE,
      },
      {
        objectType: MICROSOFT_CONTACT_OBJECT,
        label: 'Outlook contact',
        fields: CONTACT_FIELDS,
        incremental: true,
        maxPageSize: MICROSOFT_GRAPH_MAX_PAGE_SIZE,
      },
    ];
  }

  async listFields(_context: ConnectorContext, objectType: string): Promise<readonly ExternalFieldSchema[]> {
    if (objectType === MICROSOFT_EVENT_OBJECT) return EVENT_FIELDS;
    if (objectType === MICROSOFT_CONTACT_OBJECT) return CONTACT_FIELDS;
    throw new ProviderError('NOT_FOUND', `The provider offers no object type "${objectType}".`, {
      category: 'not_found',
      retryable: false,
      detail: objectType,
    });
  }

  /** Enumerate one page of the object set. */
  async fetchPage(input: FetchPageInput): Promise<FetchPageResult> {
    const http = this.httpFactory(input.context.connectionId);
    const path = input.objectType === MICROSOFT_CONTACT_OBJECT ? '/me/contacts' : '/me/events';
    if (input.objectType !== MICROSOFT_EVENT_OBJECT && input.objectType !== MICROSOFT_CONTACT_OBJECT) {
      throw this.unknownObject(input.objectType);
    }
    const cursor = decodeCursor<GraphCursor>(input.cursor, MICROSOFT_365_PROVIDER_KEY);
    const url =
      cursor?.nextLink === null || cursor === null || cursor.nextLink === undefined
        ? buildUrl(GRAPH_BASE_URL, path, {
            '$top': this.clampPageSize(input.pageSize),
            '$select': this.selectFor(input.objectType),
          })
        : this.assertGraphUrl(cursor.nextLink);
    const payload = await this.request(http, input.context, url);
    const body = isJsonObject(payload) ? payload : {};
    const nextLink = readString(body, '@odata.nextLink');
    return {
      objects: this.readValues(body, input.objectType),
      nextCursor: nextLink === null ? null : encodeCursor({ nextLink, deltaLink: null }),
      cursorExpired: false,
    };
  }

  /**
   * Read the incremental feed.
   *
   * The cursor holds the Graph link the next request must use: the `nextLink` while the feed is
   * still paging, the `deltaLink` once the feed is complete.
   */
  async fetchChanges(input: FetchChangesInput): Promise<FetchChangesResult> {
    const http = this.httpFactory(input.context.connectionId);
    if (input.objectType !== MICROSOFT_EVENT_OBJECT && input.objectType !== MICROSOFT_CONTACT_OBJECT) {
      throw this.unknownObject(input.objectType);
    }
    const cursor = decodeCursor<GraphCursor>(input.deltaToken, MICROSOFT_365_PROVIDER_KEY);
    const path = input.objectType === MICROSOFT_CONTACT_OBJECT ? '/me/contacts/delta' : '/me/calendarView/delta';
    const url =
      cursor?.nextLink === null || cursor === undefined || cursor === null
        ? buildUrl(GRAPH_BASE_URL, path, {
            '$top': this.clampPageSize(input.pageSize),
            '$select': this.selectFor(input.objectType),
          })
        : this.assertGraphUrl(cursor.nextLink);
    const payload = await this.request(http, input.context, url);
    const body = isJsonObject(payload) ? payload : {};
    const nextLink = readString(body, '@odata.nextLink');
    const deltaLink = readString(body, '@odata.deltaLink');
    const nextDeltaToken =
      nextLink !== null
        ? encodeCursor({ nextLink, deltaLink: null })
        : deltaLink !== null
          ? encodeCursor({ nextLink: null, deltaLink })
          : null;
    return { objects: this.readValues(body, input.objectType), nextDeltaToken, cursorExpired: false };
  }

  /** Create or update one object. */
  async upsertObject(input: UpsertObjectInput): Promise<ExternalMutationResult> {
    if (input.objectType !== MICROSOFT_EVENT_OBJECT && input.objectType !== MICROSOFT_CONTACT_OBJECT) {
      throw this.unknownObject(input.objectType);
    }
    this.assertScope(
      input.context,
      input.objectType === MICROSOFT_EVENT_OBJECT ? MICROSOFT_CALENDAR_WRITE_SCOPE : MICROSOFT_CONTACTS_WRITE_SCOPE,
    );
    const http = this.httpFactory(input.context.connectionId);
    const path = input.objectType === MICROSOFT_CONTACT_OBJECT ? '/me/contacts' : '/me/events';
    const url =
      input.externalId === null
        ? buildUrl(GRAPH_BASE_URL, path)
        : buildUrl(GRAPH_BASE_URL, `${path}/${encodeURIComponent(input.externalId)}`);
    const payload = await this.request(http, input.context, url, {
      method: input.externalId === null ? 'POST' : 'PATCH',
      body: JSON.stringify(
        input.objectType === MICROSOFT_EVENT_OBJECT ? toEventBody(input.fields) : toContactBody(input.fields),
      ),
    });
    const body = isJsonObject(payload) ? payload : {};
    return {
      externalId: readString(body, 'id') ?? input.externalId ?? '',
      version: null,
      updatedAt: readString(body, 'lastModifiedDateTime'),
      created: input.externalId === null,
    };
  }

  /** Delete one object. */
  async deleteObject(input: DeleteObjectInput): Promise<ExternalMutationResult> {
    if (input.objectType !== MICROSOFT_EVENT_OBJECT && input.objectType !== MICROSOFT_CONTACT_OBJECT) {
      throw this.unknownObject(input.objectType);
    }
    this.assertScope(
      input.context,
      input.objectType === MICROSOFT_EVENT_OBJECT ? MICROSOFT_CALENDAR_WRITE_SCOPE : MICROSOFT_CONTACTS_WRITE_SCOPE,
    );
    const http = this.httpFactory(input.context.connectionId);
    const path = input.objectType === MICROSOFT_CONTACT_OBJECT ? '/me/contacts' : '/me/events';
    await http.raw({
      method: 'DELETE',
      url: buildUrl(GRAPH_BASE_URL, `${path}/${encodeURIComponent(input.externalId)}`),
      headers: this.authHeaders(input.context),
    });
    return { externalId: input.externalId, version: null, updatedAt: null, created: false };
  }

  /**
   * Verify a change notification.
   *
   * Graph validates an endpoint by calling it with a `validationToken` and expecting the same
   * value back. A real notification carries a `clientState` the subscriber chose.
   */
  async verifyWebhook(input: VerifyWebhookInput): Promise<WebhookVerificationResult> {
    const challenge = readChallenge(input.query, ['validationToken']);
    if (challenge !== null) return { valid: true, reason: null, challenge };
    const expected = typeof input.context.options['clientState'] === 'string' ? input.context.options['clientState'] : null;
    const received = readStringFromHeaders(input.headers, 'clientstate');
    const verification = verifyClientState(expected, received);
    return { valid: verification.valid, reason: verification.reason, challenge: null };
  }

  /**
   * Turn a change notification into normalized events.
   *
   * Graph does not give a delivery identifier, so one is derived from the change itself: the same
   * change delivered twice produces the same identifier and is therefore processed once.
   */
  async normalizeWebhook(input: NormalizeWebhookInput): Promise<readonly NormalizedProviderEvent[]> {
    const body = input.body;
    const notifications = Array.isArray(body) ? body : [];
    const events: NormalizedProviderEvent[] = [];
    for (const notification of notifications) {
      if (!isJsonObject(notification)) continue;
      const resource = readString(notification, 'resource') ?? '';
      const changeType = readString(notification, 'changeType') ?? 'updated';
      const subscriptionId = readString(notification, 'subscriptionId') ?? '';
      const resourceData = isJsonObject(notification['resourceData']) ? notification['resourceData'] : {};
      const externalId = readString(resourceData, 'id');
      const objectType = resource.includes('contacts') ? MICROSOFT_CONTACT_OBJECT : MICROSOFT_EVENT_OBJECT;
      const deliveryId = createHash('sha256')
        .update(`${subscriptionId}|${resource}|${changeType}|${externalId ?? ''}`)
        .digest('hex');
      events.push({
        deliveryId,
        objectType,
        externalId,
        eventType: `${objectType}.${changeType}`,
        occurredAt: null,
        // Graph does not send the changed fields; the object is re-read through the delta feed.
        fields: {},
        deleted: changeType === 'deleted',
      });
    }
    return events;
  }

  /**
   * Renew the Graph subscriptions of this connection.
   *
   * Graph subscriptions expire after at most a few days, and an expired one silently stops
   * delivering. The subscription ids live in the connection's configuration, because the connector
   * has no database of its own; a connection without them simply has nothing to renew.
   */
  async renewSubscriptions(context: ConnectorContext): Promise<SubscriptionRenewalResult> {
    const ids = Array.isArray(context.options['subscriptionIds'])
      ? (context.options['subscriptionIds'] as unknown[]).filter((entry): entry is string => typeof entry === 'string')
      : [];
    if (ids.length === 0) {
      return { renewed: [], created: [], expiresAt: null, detail: 'no_subscriptions' };
    }
    const http = this.httpFactory(context.connectionId);
    const expiresAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
    const renewed: string[] = [];
    for (const id of ids) {
      await http.raw({
        method: 'PATCH',
        url: buildUrl(GRAPH_BASE_URL, `/subscriptions/${encodeURIComponent(id)}`),
        headers: { ...this.authHeaders(context), 'content-type': 'application/json' },
        body: JSON.stringify({ expirationDateTime: expiresAt }),
      });
      renewed.push(id);
    }
    return { renewed, created: [], expiresAt, detail: null };
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  /** A request whose 403 is translated into an actionable scope failure. */
  private async request(
    http: ConnectorHttp,
    context: ConnectorContext,
    url: string,
    init?: { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: string },
  ): Promise<unknown> {
    try {
      return await http.json<unknown>({
        method: init?.method ?? 'GET',
        url,
        headers: {
          ...this.authHeaders(context),
          ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(init?.body === undefined ? {} : { body: init.body }),
      });
    } catch (error) {
      if (error instanceof ProviderError && (error.status === 403 || error.status === 401)) {
        throw new ProviderError(
          'SCOPE_MISSING',
          'Microsoft Graph refused the request. The connection needs a permission it was not granted, or its grant expired.',
          { category: 'authorization', retryable: false, detail: 'insufficient_scope', status: error.status },
        );
      }
      throw error;
    }
  }

  /**
   * Refuse a link that does not point at Graph.
   *
   * A cursor is data the platform stores; a cursor that a provider or an attacker filled with a
   * foreign URL would otherwise make the connector request an arbitrary destination.
   */
  private assertGraphUrl(raw: string): string {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new ProviderError('INVALID_REQUEST', 'Microsoft Graph answered with an unreadable link.', {
        category: 'permanent_validation',
        retryable: false,
        detail: 'malformed_link',
      });
    }
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== MICROSOFT_GRAPH_HOST) {
      throw new ProviderError('INVALID_REQUEST', 'Microsoft Graph answered with a link that points somewhere else.', {
        category: 'permanent_validation',
        retryable: false,
        detail: 'foreign_link',
      });
    }
    return url.toString();
  }

  /** The values of a Graph answer, as external objects. */
  private readValues(body: Record<string, unknown>, objectType: string): readonly ExternalObject[] {
    const values = Array.isArray(body['value']) ? (body['value'] as unknown[]) : [];
    return values
      .filter(isJsonObject)
      .map((entry) =>
        objectType === MICROSOFT_CONTACT_OBJECT ? toContactObject(entry) : toEventObject(entry),
      )
      .filter((entry): entry is ExternalObject => entry !== null);
  }

  private selectFor(objectType: string): string {
    return objectType === MICROSOFT_CONTACT_OBJECT
      ? 'id,displayName,emailAddresses,phoneNumbers,jobTitle,companyName'
      : 'id,subject,bodyPreview,location,start,end,showAs,sensitivity,isCancelled,lastModifiedDateTime';
  }

  private authHeaders(context: ConnectorContext): Record<string, string> {
    const token = context.credential.accessToken;
    if (token === null) {
      throw new ProviderError('TOKEN_EXPIRED', 'The connection holds no access token.', {
        category: 'authorization',
        retryable: false,
        detail: 'no_access_token',
      });
    }
    return { authorization: `Bearer ${token}` };
  }

  private assertScope(context: ConnectorContext, scope: string): void {
    if (context.grantedScopes.includes(scope)) return;
    throw new ProviderError('SCOPE_MISSING', `The connection was not granted the "${scope}" permission.`, {
      category: 'authorization',
      retryable: false,
      detail: 'scope_missing',
    });
  }

  private clampPageSize(pageSize: number): number {
    if (!Number.isFinite(pageSize) || pageSize <= 0) return MICROSOFT_GRAPH_MAX_PAGE_SIZE;
    return Math.min(Math.trunc(pageSize), MICROSOFT_GRAPH_MAX_PAGE_SIZE);
  }

  private unknownObject(objectType: string): ProviderError {
    return new ProviderError('NOT_FOUND', `The provider offers no object type "${objectType}".`, {
      category: 'not_found',
      retryable: false,
      detail: objectType,
    });
  }

  private failure(error: unknown): ConnectionValidationResult {
    if (error instanceof ProviderError) {
      return { ok: false, code: error.code, message: error.message, accountRef: null, grantedScopes: [] };
    }
    return {
      ok: false,
      code: 'UNKNOWN',
      message: 'Microsoft Graph could not be reached.',
      accountRef: null,
      grantedScopes: [],
    };
  }
}

/** Read a header in a case-insensitive way. */
function readStringFromHeaders(
  headers: Readonly<Record<string, string | undefined>>,
  name: string,
): string | null {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name && typeof value === 'string' && value.trim() !== '') return value;
  }
  return null;
}

/** The external shape of one Outlook event. */
function toEventObject(entry: Record<string, unknown>): ExternalObject | null {
  const id = readString(entry, 'id');
  if (id === null || id === '') return null;
  const start = isJsonObject(entry['start']) ? entry['start'] : {};
  const end = isJsonObject(entry['end']) ? entry['end'] : {};
  const cancelled = entry['isCancelled'] === true;
  return {
    objectType: MICROSOFT_EVENT_OBJECT,
    externalId: id,
    externalParentId: null,
    fields: {
      id,
      subject: readString(entry, 'subject') ?? '',
      bodyPreview: readString(entry, 'bodyPreview') ?? '',
      location: isJsonObject(entry['location']) ? (readString(entry['location'], 'displayName') ?? '') : '',
      start: readString(start, 'dateTime') ?? '',
      end: readString(end, 'dateTime') ?? '',
      showAs: readString(entry, 'showAs') ?? '',
      sensitivity: readString(entry, 'sensitivity') ?? 'normal',
      isCancelled: cancelled,
      lastModifiedDateTime: readString(entry, 'lastModifiedDateTime') ?? '',
    },
    updatedAt: readString(entry, 'lastModifiedDateTime'),
    version: null,
    deleted: cancelled,
  };
}

/** The external shape of one Outlook contact. */
function toContactObject(entry: Record<string, unknown>): ExternalObject | null {
  const id = readString(entry, 'id');
  if (id === null || id === '') return null;
  return {
    objectType: MICROSOFT_CONTACT_OBJECT,
    externalId: id,
    externalParentId: null,
    fields: {
      id,
      displayName: readString(entry, 'displayName') ?? '',
      emailAddresses: Array.isArray(entry['emailAddresses']) ? entry['emailAddresses'] : [],
      phoneNumbers: Array.isArray(entry['phoneNumbers']) ? entry['phoneNumbers'] : [],
      jobTitle: readString(entry, 'jobTitle') ?? '',
      companyName: readString(entry, 'companyName') ?? '',
    },
    updatedAt: null,
    version: null,
    deleted: false,
  };
}

/** The Graph body of an event. */
function toEventBody(fields: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (typeof fields['subject'] === 'string') body['subject'] = fields['subject'];
  if (typeof fields['bodyPreview'] === 'string') body['bodyPreview'] = fields['bodyPreview'];
  if (typeof fields['start'] === 'string' && fields['start'] !== '') {
    body['start'] = { dateTime: fields['start'], timeZone: 'UTC' };
  }
  if (typeof fields['end'] === 'string' && fields['end'] !== '') {
    body['end'] = { dateTime: fields['end'], timeZone: 'UTC' };
  }
  if (typeof fields['location'] === 'string' && fields['location'] !== '') {
    body['location'] = { displayName: fields['location'] };
  }
  if (typeof fields['isCancelled'] === 'boolean') body['isCancelled'] = fields['isCancelled'];
  return body;
}

/** The Graph body of a contact. */
function toContactBody(fields: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (typeof fields['displayName'] === 'string') body['displayName'] = fields['displayName'];
  if (Array.isArray(fields['emailAddresses'])) body['emailAddresses'] = fields['emailAddresses'];
  if (Array.isArray(fields['phoneNumbers'])) body['phoneNumbers'] = fields['phoneNumbers'];
  if (typeof fields['jobTitle'] === 'string') body['jobTitle'] = fields['jobTitle'];
  if (typeof fields['companyName'] === 'string') body['companyName'] = fields['companyName'];
  return body;
}
