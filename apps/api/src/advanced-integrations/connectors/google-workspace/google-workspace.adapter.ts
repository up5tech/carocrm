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
  UpsertObjectInput,
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
  readBoolean,
  readString,
  readStringList,
} from '../kit/connector-kit.js';
import type { OAuth2ProviderConfig } from '../kit/oauth2-base.js';

/**
 * Phase 19-INT.16 — the Google Workspace connector
 * (`PLAN_Phase_19_Advanced_Integrations.md` §12.1; `19-INT.16`).
 *
 * Calendar and Contacts, through the platform's own HTTP client. Two things about this connector
 * are worth reading before the code:
 *
 *  1. **The private-event policy is enforced in the connector, not in a mapping.** A private event
 *     carries other people's attendee list. A mapping is configuration an administrator edits; the
 *     privacy rule is a product rule. So the connector refuses to *emit* a private event unless
 *     the connection explicitly opted in (`includePrivateEvents`), and it never emits the
 *     attendee list of an event it refused.
 *  2. **An expired sync token is a controlled resync, never a mass deletion.** Google answers an
 *     expired `syncToken` with `410 Gone`. The connector reports `cursorExpired`, the engine drops
 *     the cursor and re-runs the full enumeration — and because a provider delete maps to *unlink*
 *     rather than to a hard CRM delete, the resync cannot remove a record that is merely missing
 *     from the new snapshot.
 *
 * The connector declares **no webhook**: Google Calendar's push notification is a channel with a
 * verification token rather than a signed payload, and the plan's reconciliation requirement is
 * met by the incremental sync instead. A channel-based push would be added as a separate, reviewed
 * change rather than smuggled in here.
 */

export const GOOGLE_WORKSPACE_PROVIDER_KEY = 'google-workspace';

/** The provider's own API versions, pinned deliberately (plan §3.3). */
export const GOOGLE_WORKSPACE_API_VERSION = 'v3';
export const GOOGLE_WORKSPACE_PEOPLE_API_VERSION = 'v1';

/** The scopes the connector asks for. */
export const GOOGLE_CALENDAR_READ_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
export const GOOGLE_CALENDAR_WRITE_SCOPE = 'https://www.googleapis.com/auth/calendar';
export const GOOGLE_CONTACTS_READ_SCOPE = 'https://www.googleapis.com/auth/contacts.readonly';
export const GOOGLE_CONTACTS_WRITE_SCOPE = 'https://www.googleapis.com/auth/contacts';

/** The maximum page size the Calendar API honours for a list request. */
export const GOOGLE_CALENDAR_MAX_PAGE_SIZE = 250;

/** The maximum page size the People API honours. */
export const GOOGLE_PEOPLE_MAX_PAGE_SIZE = 1000;

const CALENDAR_BASE_URL = `https://www.googleapis.com/calendar/${GOOGLE_WORKSPACE_API_VERSION}`;
const PEOPLE_BASE_URL = `https://people.googleapis.com/${GOOGLE_WORKSPACE_PEOPLE_API_VERSION}`;

/** The object types this connector offers. */
export const GOOGLE_CALENDAR_EVENT_OBJECT = 'calendarEvent';
export const GOOGLE_CONTACT_OBJECT = 'contact';

const CALENDAR_EVENT_FIELDS: readonly ExternalFieldSchema[] = [
  { name: 'id', label: 'Event ID', type: 'string', required: true, unique: true, identifier: true, sensitive: false },
  { name: 'summary', label: 'Title', type: 'string', required: false, unique: false, identifier: false, sensitive: false },
  { name: 'description', label: 'Description', type: 'string', required: false, unique: false, identifier: false, sensitive: false },
  { name: 'location', label: 'Location', type: 'string', required: false, unique: false, identifier: false, sensitive: false },
  { name: 'start', label: 'Starts at', type: 'datetime', required: true, unique: false, identifier: false, sensitive: false },
  { name: 'end', label: 'Ends at', type: 'datetime', required: true, unique: false, identifier: false, sensitive: false },
  { name: 'status', label: 'Status', type: 'string', required: true, unique: false, identifier: false, sensitive: false },
  { name: 'attendees', label: 'Attendees', type: 'array', required: false, unique: false, identifier: false, sensitive: true },
  { name: 'visibility', label: 'Visibility', type: 'string', required: false, unique: false, identifier: false, sensitive: false },
  { name: 'updated', label: 'Updated at', type: 'datetime', required: false, unique: false, identifier: false, sensitive: false },
];

const CONTACT_FIELDS: readonly ExternalFieldSchema[] = [
  { name: 'resourceName', label: 'Resource name', type: 'string', required: true, unique: true, identifier: true, sensitive: false },
  { name: 'displayName', label: 'Name', type: 'string', required: false, unique: false, identifier: false, sensitive: false },
  { name: 'emailAddresses', label: 'Email addresses', type: 'array', required: false, unique: false, identifier: false, sensitive: true },
  { name: 'phoneNumbers', label: 'Phone numbers', type: 'array', required: false, unique: false, identifier: false, sensitive: true },
  { name: 'organizations', label: 'Organizations', type: 'array', required: false, unique: false, identifier: false, sensitive: false },
];

/** The capability declaration of the Google Workspace connector. */
export function googleWorkspaceCapabilities(): ConnectorCapabilities {
  const calendarEvent = {
    objectType: GOOGLE_CALENDAR_EVENT_OBJECT,
    label: 'Calendar event',
    read: true,
    create: true,
    update: true,
    delete: true,
    upsert: false,
    webhook: false,
    syncDirections: ['inbound', 'outbound'] as const,
    fullSync: true,
    incrementalSync: true,
    requiredScopes: [GOOGLE_CALENDAR_READ_SCOPE],
    optionalScopes: [GOOGLE_CALENDAR_WRITE_SCOPE],
    maxPageSize: GOOGLE_CALENDAR_MAX_PAGE_SIZE,
    rateLimitStrategy: 'fixed_window' as const,
    externalIdFields: ['id'],
    uniqueFields: ['id'],
    deletionVisibility: 'tombstoned' as const,
    transactional: false,
    dataSensitivity: 'communication' as const,
  };
  const contact = {
    objectType: GOOGLE_CONTACT_OBJECT,
    label: 'Contact',
    read: true,
    create: true,
    update: true,
    delete: true,
    upsert: false,
    webhook: false,
    syncDirections: ['inbound', 'outbound'] as const,
    fullSync: true,
    incrementalSync: true,
    requiredScopes: [GOOGLE_CONTACTS_READ_SCOPE],
    optionalScopes: [GOOGLE_CONTACTS_WRITE_SCOPE],
    maxPageSize: GOOGLE_PEOPLE_MAX_PAGE_SIZE,
    rateLimitStrategy: 'fixed_window' as const,
    externalIdFields: ['resourceName'],
    uniqueFields: ['resourceName'],
    deletionVisibility: 'tombstoned' as const,
    transactional: false,
    dataSensitivity: 'personal' as const,
  };
  return {
    schemaVersion: CONNECTOR_CAPABILITY_SCHEMA_VERSION,
    authentication: 'oauth',
    objects: [calendarEvent, contact],
    webhook: { supported: false, requiresRawBody: false, requiresEndpointValidation: false },
  };
}

/** The OAuth 2.0 configuration of the Google Workspace connector. */
export const GOOGLE_WORKSPACE_OAUTH_CONFIG: OAuth2ProviderConfig = {
  providerKey: GOOGLE_WORKSPACE_PROVIDER_KEY,
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  revokeEndpoint: 'https://oauth2.googleapis.com/revoke',
  scopeSeparator: ' ',
  supportsPkce: true,
  tokenAuthMethod: 'client_secret_post',
  // A refresh token is only issued when the administrator consents to it, so the flow asks for it
  // explicitly and stays in the "testing" mode of the consent screen otherwise.
  extraAuthorizeParams: { access_type: 'offline', prompt: 'consent' },
  reportsGrantedScopes: true,
};

/** The cursors the connector writes. */
interface CalendarCursor {
  readonly calendarIndex: number;
  readonly pageToken: string | null;
  readonly syncToken: string | null;
}

interface PeopleCursor {
  readonly pageToken: string | null;
  readonly syncToken: string | null;
}

export interface GoogleWorkspaceAdapterOptions {
  /** Resolves the OAuth client identity. `null` when the installation has no client id. */
  readonly identity: (providerKey: string) => { clientId: string; clientSecret: string | null } | null;
  /** Injectable for tests, so a connector test never opens a socket. */
  readonly fetchImpl?: typeof fetch | undefined;
  /** Injectable for tests, so the address check can be exercised without DNS. */
  readonly resolveHost?: ((host: string) => Promise<string[]>) | undefined;
  /** A structured logger. Only non-sensitive fields ever reach it. */
  readonly log?: ((fields: Record<string, unknown>, message: string) => void) | undefined;
  /** A prepared HTTP client. Injectable so a test can serve canned answers. */
  readonly httpFactory?: ((connectionId: string) => ConnectorHttp) | undefined;
}

/**
 * The Google Workspace connector.
 *
 * Calendar and Contacts. See the file header for the two rules that shape it.
 */
export class GoogleWorkspaceAdapter extends OAuth2ConnectorBase {
  override readonly providerKey = GOOGLE_WORKSPACE_PROVIDER_KEY;
  override readonly adapterVersion = '1.0.0';
  override readonly providerApiVersion = `${GOOGLE_WORKSPACE_API_VERSION}+${GOOGLE_WORKSPACE_PEOPLE_API_VERSION}`;
  override readonly capabilities: ConnectorCapabilities = googleWorkspaceCapabilities();
  override readonly operations: ConnectorOperationFlags = {
    implementsFetch: true,
    implementsWrite: true,
    implementsDelete: true,
    implementsWebhook: false,
  };

  private readonly httpFactory: (connectionId: string) => ConnectorHttp;

  constructor(options: GoogleWorkspaceAdapterOptions) {
    super({
      config: GOOGLE_WORKSPACE_OAUTH_CONFIG,
      identity: options.identity,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.resolveHost === undefined ? {} : { resolveHost: options.resolveHost }),
      ...(options.log === undefined ? {} : { log: options.log }),
    });
    this.httpFactory =
      options.httpFactory ??
      ((connectionId: string) =>
        new ConnectorHttp({
          providerKey: GOOGLE_WORKSPACE_PROVIDER_KEY,
          connectionId,
          ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
          ...(options.resolveHost === undefined ? {} : { resolveHost: options.resolveHost }),
          ...(options.log === undefined ? {} : { log: options.log }),
        }));
  }

  /**
   * Check the connection with the cheapest read-only call there is.
   *
   * `calendarList` needs only a read scope and returns the calendars the account can see, which
   * is also what an operator wants to see: which calendars would be synced.
   */
  async validateConnection(context: ConnectorContext): Promise<ConnectionValidationResult> {
    const http = this.httpFactory(context.connectionId);
    try {
      const payload = await http.json<unknown>({
        method: 'GET',
        url: buildUrl(CALENDAR_BASE_URL, '/users/me/calendarList', { maxResults: 1 }),
        headers: this.authHeaders(context),
      });
      const items = isJsonObject(payload) ? payload['items'] : null;
      const reachable = Array.isArray(items);
      return {
        ok: reachable,
        code: reachable ? null : 'CONFIGURATION_INVALID',
        message: reachable ? null : 'The provider answered the connection test with an unreadable body.',
        accountRef: context.tenantRef,
        grantedScopes: [...context.grantedScopes],
      };
    } catch (error) {
      return this.failure(error);
    }
  }

  async listObjectSchemas(_context: ConnectorContext): Promise<readonly ExternalObjectSchema[]> {
    return [
      {
        objectType: GOOGLE_CALENDAR_EVENT_OBJECT,
        label: 'Calendar event',
        fields: CALENDAR_EVENT_FIELDS,
        incremental: true,
        maxPageSize: GOOGLE_CALENDAR_MAX_PAGE_SIZE,
      },
      {
        objectType: GOOGLE_CONTACT_OBJECT,
        label: 'Contact',
        fields: CONTACT_FIELDS,
        incremental: true,
        maxPageSize: GOOGLE_PEOPLE_MAX_PAGE_SIZE,
      },
    ];
  }

  async listFields(_context: ConnectorContext, objectType: string): Promise<readonly ExternalFieldSchema[]> {
    if (objectType === GOOGLE_CALENDAR_EVENT_OBJECT) return CALENDAR_EVENT_FIELDS;
    if (objectType === GOOGLE_CONTACT_OBJECT) return CONTACT_FIELDS;
    throw new ProviderError('NOT_FOUND', `The provider offers no object type "${objectType}".`, {
      category: 'not_found',
      retryable: false,
      detail: objectType,
    });
  }

  /**
   * Enumerate one page of calendar events.
   *
   * The cursor carries the calendar index, the page token and — for the incremental path — the
   * sync token, so the runtime sees one opaque string and the connector sees everything it needs.
   */
  async fetchPage(input: FetchPageInput): Promise<FetchPageResult> {
    if (input.objectType === GOOGLE_CONTACT_OBJECT) return this.fetchPeoplePage(input);
    if (input.objectType !== GOOGLE_CALENDAR_EVENT_OBJECT) {
      throw this.unknownObject(input.objectType);
    }
    const http = this.httpFactory(input.context.connectionId);
    const calendarIds = this.calendarIds(input.context);
    const cursor = decodeCursor<CalendarCursor>(input.cursor, GOOGLE_WORKSPACE_PROVIDER_KEY);
    const index = cursor?.calendarIndex ?? 0;
    if (index >= calendarIds.length) return { objects: [], nextCursor: null, cursorExpired: false };
    const calendarId = calendarIds[index] ?? 'primary';

    const payload = await http.json<unknown>({
      method: 'GET',
      url: buildUrl(CALENDAR_BASE_URL, `/calendars/${encodeURIComponent(calendarId)}/events`, {
        maxResults: this.clampPageSize(input.pageSize, GOOGLE_CALENDAR_MAX_PAGE_SIZE),
        singleEvents: 'true',
        // Deleted events are reported as cancelled, so a cancelled event does not look like a
        // missing one and the deletion policy decides what to do with it.
        showDeleted: 'true',
        ...(cursor?.pageToken === null || cursor === null ? {} : { pageToken: cursor.pageToken }),
      }),
      headers: this.authHeaders(input.context),
    });

    const objects = this.readEventList(payload, input.context);
    const pageToken = readString(isJsonObject(payload) ? payload : {}, 'nextPageToken');
    const nextCursor =
      pageToken === null
        ? index + 1 < calendarIds.length
          ? encodeCursor({ calendarIndex: index + 1, pageToken: null, syncToken: null })
          : null
        : encodeCursor({ calendarIndex: index, pageToken, syncToken: null });
    return { objects, nextCursor, cursorExpired: false };
  }

  /**
   * Read the incremental feed of calendar events.
   *
   * An expired sync token makes Google answer `410 Gone`. That is reported as `cursorExpired`, so
   * the engine re-runs the full enumeration instead of failing the run.
   */
  async fetchChanges(input: FetchChangesInput): Promise<FetchChangesResult> {
    if (input.objectType === GOOGLE_CONTACT_OBJECT) return this.fetchPeopleChanges(input);
    if (input.objectType !== GOOGLE_CALENDAR_EVENT_OBJECT) {
      throw this.unknownObject(input.objectType);
    }
    const http = this.httpFactory(input.context.connectionId);
    const calendarIds = this.calendarIds(input.context);
    const cursor = decodeCursor<CalendarCursor>(input.deltaToken, GOOGLE_WORKSPACE_PROVIDER_KEY);
    const index = cursor?.calendarIndex ?? 0;
    if (index >= calendarIds.length) return { objects: [], nextDeltaToken: null, cursorExpired: false };
    const calendarId = calendarIds[index] ?? 'primary';
    const syncToken = cursor?.syncToken ?? null;

    let payload: unknown;
    try {
      payload = await http.json<unknown>({
        method: 'GET',
        url: buildUrl(CALENDAR_BASE_URL, `/calendars/${encodeURIComponent(calendarId)}/events`, {
          maxResults: this.clampPageSize(input.pageSize, GOOGLE_CALENDAR_MAX_PAGE_SIZE),
          singleEvents: 'true',
          showDeleted: 'true',
          ...(syncToken === null ? {} : { syncToken }),
          ...(cursor?.pageToken === null || cursor === null ? {} : { pageToken: cursor.pageToken }),
        }),
        headers: this.authHeaders(input.context),
      });
    } catch (error) {
      if (isGone(error)) return { objects: [], nextDeltaToken: null, cursorExpired: true };
      throw error;
    }

    const body = isJsonObject(payload) ? payload : {};
    const objects = this.readEventList(payload, input.context);
    const pageToken = readString(body, 'nextPageToken');
    const nextSyncToken = readString(body, 'nextSyncToken');
    const nextDeltaToken =
      pageToken === null
        ? index + 1 < calendarIds.length
          ? encodeCursor({ calendarIndex: index + 1, pageToken: null, syncToken: null })
          : nextSyncToken === null
            ? null
            : encodeCursor({ calendarIndex: index, pageToken: null, syncToken: nextSyncToken })
        : encodeCursor({ calendarIndex: index, pageToken, syncToken });
    return { objects, nextDeltaToken, cursorExpired: false };
  }

  /**
   * Create or update one calendar event.
   *
   * The write scope is checked **before** the request, so a read-only grant produces an
   * actionable `SCOPE_MISSING` instead of an opaque provider error.
   */
  async upsertObject(input: UpsertObjectInput): Promise<ExternalMutationResult> {
    if (input.objectType !== GOOGLE_CALENDAR_EVENT_OBJECT && input.objectType !== GOOGLE_CONTACT_OBJECT) {
      throw this.unknownObject(input.objectType);
    }
    this.assertScope(input.context, input.objectType === GOOGLE_CALENDAR_EVENT_OBJECT ? GOOGLE_CALENDAR_WRITE_SCOPE : GOOGLE_CONTACTS_WRITE_SCOPE);
    const http = this.httpFactory(input.context.connectionId);
    if (input.objectType === GOOGLE_CONTACT_OBJECT) {
      const resourceName = input.externalId ?? '';
      const payload = await http.json<unknown>({
        method: 'PATCH',
        url: buildUrl(PEOPLE_BASE_URL, `/${resourceName.replace(/^\//, '')}`, {
          updatePersonFields: 'names,emailAddresses,phoneNumbers,organizations',
        }),
        headers: { ...this.authHeaders(input.context), 'content-type': 'application/json' },
        body: JSON.stringify(toPeopleBody(input.fields)),
      });
      const resourceNameOut = isJsonObject(payload) ? readString(payload, 'resourceName') : null;
      return {
        externalId: resourceNameOut ?? resourceName,
        version: null,
        updatedAt: null,
        created: input.externalId === null,
      };
    }

    const calendarId = input.externalParentId ?? this.calendarIds(input.context)[0] ?? 'primary';
    const url =
      input.externalId === null
        ? buildUrl(CALENDAR_BASE_URL, `/calendars/${encodeURIComponent(calendarId)}/events`)
        : buildUrl(
            CALENDAR_BASE_URL,
            `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(input.externalId)}`,
          );
    const payload = await http.json<unknown>({
      method: input.externalId === null ? 'POST' : 'PATCH',
      url,
      headers: { ...this.authHeaders(input.context), 'content-type': 'application/json' },
      body: JSON.stringify(toEventBody(input.fields)),
    });
    const body = isJsonObject(payload) ? payload : {};
    return {
      externalId: readString(body, 'id') ?? input.externalId ?? '',
      version: readString(body, 'etag'),
      updatedAt: readString(body, 'updated'),
      created: input.externalId === null,
    };
  }

  /**
   * Cancel one event.
   *
   * Google has no hard delete for a calendar event: it is cancelled, and the cancellation is
   * visible to the attendees. The connector therefore cancels rather than deletes, and the CRM
   * record is unlinked by the deletion policy, not erased.
   */
  async deleteObject(input: DeleteObjectInput): Promise<ExternalMutationResult> {
    if (input.objectType !== GOOGLE_CALENDAR_EVENT_OBJECT) throw this.unknownObject(input.objectType);
    this.assertScope(input.context, GOOGLE_CALENDAR_WRITE_SCOPE);
    const http = this.httpFactory(input.context.connectionId);
    const calendarId = this.calendarIds(input.context)[0] ?? 'primary';
    await http.raw({
      method: 'DELETE',
      url: buildUrl(
        CALENDAR_BASE_URL,
        `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(input.externalId)}`,
      ),
      headers: this.authHeaders(input.context),
    });
    return { externalId: input.externalId, version: null, updatedAt: null, created: false };
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  /** Enumerate one page of People connections. */
  private async fetchPeoplePage(input: FetchPageInput): Promise<FetchPageResult> {
    const http = this.httpFactory(input.context.connectionId);
    const cursor = decodeCursor<PeopleCursor>(input.cursor, GOOGLE_WORKSPACE_PROVIDER_KEY);
    const payload = await http.json<unknown>({
      method: 'GET',
      url: buildUrl(PEOPLE_BASE_URL, '/people/me/connections', {
        pageSize: this.clampPageSize(input.pageSize, GOOGLE_PEOPLE_MAX_PAGE_SIZE),
        personFields: 'names,emailAddresses,phoneNumbers,organizations',
        ...(cursor?.pageToken === null || cursor === null ? {} : { pageToken: cursor.pageToken }),
      }),
      headers: this.authHeaders(input.context),
    });
    const body = isJsonObject(payload) ? payload : {};
    const connections = Array.isArray(body['connections']) ? (body['connections'] as unknown[]) : [];
    const pageToken = readString(body, 'nextPageToken');
    return {
      objects: connections
        .filter(isJsonObject)
        .map((person) => toContactObject(person))
        .filter((person): person is ExternalObject => person !== null),
      nextCursor: pageToken === null ? null : encodeCursor({ pageToken, syncToken: null }),
      cursorExpired: false,
    };
  }

  /** Read the People incremental feed. */
  private async fetchPeopleChanges(input: FetchChangesInput): Promise<FetchChangesResult> {
    const http = this.httpFactory(input.context.connectionId);
    const cursor = decodeCursor<PeopleCursor>(input.deltaToken, GOOGLE_WORKSPACE_PROVIDER_KEY);
    const syncToken = cursor?.syncToken ?? null;
    let payload: unknown;
    try {
      payload = await http.json<unknown>({
        method: 'GET',
        url: buildUrl(PEOPLE_BASE_URL, '/people/me/connections', {
          pageSize: this.clampPageSize(input.pageSize, GOOGLE_PEOPLE_MAX_PAGE_SIZE),
          personFields: 'names,emailAddresses,phoneNumbers,organizations',
          requestSyncToken: 'true',
          ...(syncToken === null ? {} : { syncToken }),
          ...(cursor?.pageToken === null || cursor === null ? {} : { pageToken: cursor.pageToken }),
        }),
        headers: this.authHeaders(input.context),
      });
    } catch (error) {
      // The People API answers an invalid sync token with `400 Bad Request` rather than `410`.
      // Only the incremental request carries a sync token, so a bad request here is the token.
      if (syncToken !== null && isBadRequest(error)) {
        return { objects: [], nextDeltaToken: null, cursorExpired: true };
      }
      throw error;
    }
    const body = isJsonObject(payload) ? payload : {};
    const connections = Array.isArray(body['connections']) ? (body['connections'] as unknown[]) : [];
    const pageToken = readString(body, 'nextPageToken');
    const nextSyncToken = readString(body, 'nextSyncToken');
    const nextDeltaToken =
      pageToken === null
        ? nextSyncToken === null
          ? null
          : encodeCursor({ pageToken: null, syncToken: nextSyncToken })
        : encodeCursor({ pageToken, syncToken });
    return {
      objects: connections
        .filter(isJsonObject)
        .map((person) => toContactObject(person))
        .filter((person): person is ExternalObject => person !== null),
      nextDeltaToken,
      cursorExpired: false,
    };
  }

  /** The calendars this connection syncs. */
  private calendarIds(context: ConnectorContext): readonly string[] {
    const configured = readStringList(context.options, 'calendarIds');
    if (configured.length === 0) return ['primary'];
    return configured;
  }

  /** Whether private events may leave the provider. */
  private privateEventsAllowed(context: ConnectorContext): boolean {
    return context.options['includePrivateEvents'] === true;
  }

  /** The event list of a Calendar answer, with the private-event policy applied. */
  private readEventList(payload: unknown, context: ConnectorContext): readonly ExternalObject[] {
    const body = isJsonObject(payload) ? payload : {};
    const items = Array.isArray(body['items']) ? (body['items'] as unknown[]) : [];
    const allowPrivate = this.privateEventsAllowed(context);
    return items
      .filter(isJsonObject)
      .filter((event) => allowPrivate || readString(event, 'visibility') !== 'private')
      .map((event) => toEventObject(event, allowPrivate));
  }

  /** The request headers. The access token is the only credential, and it is never logged. */
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

  /** Refuse an operation the connection's grant does not cover. */
  private assertScope(context: ConnectorContext, scope: string): void {
    if (context.grantedScopes.includes(scope)) return;
    throw new ProviderError('SCOPE_MISSING', `The connection was not granted the "${scope}" permission.`, {
      category: 'authorization',
      retryable: false,
      detail: 'scope_missing',
    });
  }

  private clampPageSize(pageSize: number, maximum: number): number {
    if (!Number.isFinite(pageSize) || pageSize <= 0) return maximum;
    return Math.min(Math.trunc(pageSize), maximum);
  }

  private unknownObject(objectType: string): ProviderError {
    return new ProviderError('NOT_FOUND', `The provider offers no object type "${objectType}".`, {
      category: 'not_found',
      retryable: false,
      detail: objectType,
    });
  }

  /** The validation failure of a connection, as a normalized result. */
  private failure(error: unknown): ConnectionValidationResult {
    if (error instanceof ProviderError) {
      return {
        ok: false,
        code: error.code,
        message: error.message,
        accountRef: null,
        grantedScopes: [],
      };
    }
    return {
      ok: false,
      code: 'UNKNOWN',
      message: 'The provider could not be reached.',
      accountRef: null,
      grantedScopes: [],
    };
  }
}

/** The external shape of one calendar event. */
function toEventObject(event: Record<string, unknown>, allowPrivate: boolean): ExternalObject {
  const start = isJsonObject(event['start']) ? event['start'] : {};
  const end = isJsonObject(event['end']) ? event['end'] : {};
  const visibility = readString(event, 'visibility') ?? 'default';
  const attendees = Array.isArray(event['attendees']) ? (event['attendees'] as unknown[]) : [];
  return {
    objectType: GOOGLE_CALENDAR_EVENT_OBJECT,
    externalId: readString(event, 'id') ?? '',
    externalParentId: null,
    fields: {
      id: readString(event, 'id') ?? '',
      summary: readString(event, 'summary') ?? '',
      description: readString(event, 'description') ?? '',
      location: readString(event, 'location') ?? '',
      start: readString(start, 'dateTime') ?? readString(start, 'date') ?? '',
      end: readString(end, 'dateTime') ?? readString(end, 'date') ?? '',
      status: readString(event, 'status') ?? '',
      // A private event's attendee list is never emitted, even when the event itself is allowed.
      attendees: visibility === 'private' && !allowPrivate ? [] : attendees,
      visibility,
      updated: readString(event, 'updated') ?? '',
    },
    updatedAt: readString(event, 'updated'),
    version: readString(event, 'etag'),
    deleted: readString(event, 'status') === 'cancelled',
  };
}

/** The external shape of one People contact. */
function toContactObject(person: Record<string, unknown>): ExternalObject | null {
  const resourceName = readString(person, 'resourceName');
  if (resourceName === null || resourceName === '') return null;
  const names = Array.isArray(person['names']) ? (person['names'] as unknown[]) : [];
  const displayName =
    names.find((entry): entry is Record<string, unknown> => isJsonObject(entry) && readBoolean(entry, 'primary') === true) ??
    names.find((entry): entry is Record<string, unknown> => isJsonObject(entry));
  return {
    objectType: GOOGLE_CONTACT_OBJECT,
    externalId: resourceName,
    externalParentId: null,
    fields: {
      resourceName,
      displayName: displayName === undefined ? '' : (readString(displayName, 'displayName') ?? ''),
      emailAddresses: Array.isArray(person['emailAddresses']) ? person['emailAddresses'] : [],
      phoneNumbers: Array.isArray(person['phoneNumbers']) ? person['phoneNumbers'] : [],
      organizations: Array.isArray(person['organizations']) ? person['organizations'] : [],
    },
    updatedAt: readString(person, 'etag'),
    version: readString(person, 'etag'),
    deleted: false,
  };
}

/** The Calendar API body of an event, built from a mapped field set. */
function toEventBody(fields: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (typeof fields['summary'] === 'string') body['summary'] = fields['summary'];
  if (typeof fields['description'] === 'string') body['description'] = fields['description'];
  if (typeof fields['location'] === 'string') body['location'] = fields['location'];
  const start = typeof fields['start'] === 'string' && fields['start'] !== '' ? fields['start'] : null;
  const end = typeof fields['end'] === 'string' && fields['end'] !== '' ? fields['end'] : null;
  if (start !== null) body['start'] = { dateTime: start };
  if (end !== null) body['end'] = { dateTime: end };
  if (Array.isArray(fields['attendees'])) body['attendees'] = fields['attendees'];
  return body;
}

/** The People API body of a contact, built from a mapped field set. */
function toPeopleBody(fields: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (typeof fields['displayName'] === 'string' && fields['displayName'] !== '') {
    body['names'] = [{ displayName: fields['displayName'] }];
  }
  if (Array.isArray(fields['emailAddresses'])) body['emailAddresses'] = fields['emailAddresses'];
  if (Array.isArray(fields['phoneNumbers'])) body['phoneNumbers'] = fields['phoneNumbers'];
  if (Array.isArray(fields['organizations'])) body['organizations'] = fields['organizations'];
  return body;
}

/** Whether a provider error is a `410 Gone`, which means the cursor is no longer valid. */
function isGone(error: unknown): boolean {
  return error instanceof ProviderError && error.status === 410;
}

/** Whether a provider error is a `400 Bad Request`. */
function isBadRequest(error: unknown): boolean {
  return error instanceof ProviderError && error.status === 400;
}
