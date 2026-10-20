import { createHash } from 'node:crypto';

import type {
  ConnectionValidationResult,
  ConnectorContext,
  ExternalFieldSchema,
  ExternalMutationResult,
  ExternalObject,
  ExternalObjectSchema,
  FetchPageInput,
  FetchPageResult,
  NormalizedProviderEvent,
  NormalizeWebhookInput,
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
  readNumber,
  readString,
  readStringList,
} from '../kit/connector-kit.js';
import type { OAuth2ProviderConfig } from '../kit/oauth2-base.js';
import { hmacSha256Base64Padded, readChallenge, verifyTimestampedHmacSha256Hex } from '../kit/webhook-signatures.js';

/**
 * Phase 19-INT.18 — the Zoom connector
 * (`PLAN_Phase_19_Advanced_Integrations.md` §12.3; `19-INT.18`).
 *
 * Meetings, and only meetings. Voice, call centre, SMS and messaging belong to
 * `VoiceCommunications` (provider matrix §1.2), and **recordings are not implemented at all** —
 * the plan requires a separate privacy and retention decision before a recording is downloaded or
 * retained, and that decision has not been made.
 *
 * The hard part of this connector is **not duplicating a meeting**. Zoom's create endpoint has no
 * idempotency key, so a retry after an ambiguous timeout would create a second meeting. The
 * connector solves it the only way a provider without idempotency support allows:
 *
 *  - every created meeting carries a `tracking_fields` entry holding the platform's operation id;
 *  - when a create fails ambiguously, the connector **reconciles** by listing the user's meetings
 *    and looking for that marker before it retries.
 *
 * So the same CRM change produces one meeting, no matter how the network behaves.
 */

export const ZOOM_PROVIDER_KEY = 'zoom';

/** The provider's API version, pinned deliberately. */
export const ZOOM_API_VERSION = 'v2';

/** The scopes the connector asks for. */
export const ZOOM_MEETING_READ_SCOPE = 'meeting:read';
export const ZOOM_MEETING_WRITE_SCOPE = 'meeting:write';

/** The maximum page size Zoom honours. */
export const ZOOM_MAX_PAGE_SIZE = 300;

/** The object type this connector offers. */
export const ZOOM_MEETING_OBJECT = 'meeting';

const MEETING_FIELDS: readonly ExternalFieldSchema[] = [
  { name: 'id', label: 'Meeting ID', type: 'string', required: true, unique: true, identifier: true, sensitive: false },
  { name: 'uuid', label: 'UUID', type: 'string', required: false, unique: true, identifier: false, sensitive: false },
  { name: 'topic', label: 'Topic', type: 'string', required: true, unique: false, identifier: false, sensitive: false },
  { name: 'agenda', label: 'Agenda', type: 'string', required: false, unique: false, identifier: false, sensitive: false },
  { name: 'start_time', label: 'Starts at', type: 'datetime', required: true, unique: false, identifier: false, sensitive: false },
  { name: 'duration', label: 'Duration (minutes)', type: 'number', required: true, unique: false, identifier: false, sensitive: false },
  { name: 'timezone', label: 'Time zone', type: 'string', required: false, unique: false, identifier: false, sensitive: false },
  { name: 'join_url', label: 'Join link', type: 'string', required: false, unique: false, identifier: false, sensitive: false },
  { name: 'start_url', label: 'Start link', type: 'string', required: false, unique: false, identifier: false, sensitive: false },
  { name: 'status', label: 'Status', type: 'string', required: false, unique: false, identifier: false, sensitive: false },
  { name: 'created_at', label: 'Created at', type: 'datetime', required: false, unique: false, identifier: false, sensitive: false },
];

/** The capability declaration of the Zoom connector. */
export function zoomCapabilities(): ConnectorCapabilities {
  const meeting = {
    objectType: ZOOM_MEETING_OBJECT,
    label: 'Meeting',
    read: true,
    create: true,
    update: true,
    delete: false,
    upsert: false,
    webhook: true,
    // Zoom is a **destination**: the CRM decides when a meeting exists.
    syncDirections: ['outbound'] as const,
    fullSync: true,
    incrementalSync: false,
    requiredScopes: [ZOOM_MEETING_READ_SCOPE],
    optionalScopes: [ZOOM_MEETING_WRITE_SCOPE],
    maxPageSize: ZOOM_MAX_PAGE_SIZE,
    rateLimitStrategy: 'fixed_window' as const,
    externalIdFields: ['id'],
    uniqueFields: ['id'],
    deletionVisibility: 'not_synchronized' as const,
    transactional: false,
    dataSensitivity: 'communication' as const,
  };
  return {
    schemaVersion: CONNECTOR_CAPABILITY_SCHEMA_VERSION,
    authentication: 'oauth',
    objects: [meeting],
    webhook: { supported: true, requiresRawBody: true, requiresEndpointValidation: true },
  };
}

/** The OAuth 2.0 configuration of the Zoom connector. */
export const ZOOM_OAUTH_CONFIG: OAuth2ProviderConfig = {
  providerKey: ZOOM_PROVIDER_KEY,
  authorizationEndpoint: 'https://zoom.us/oauth/authorize',
  tokenEndpoint: 'https://zoom.us/oauth/token',
  scopeSeparator: ',',
  supportsPkce: true,
  tokenAuthMethod: 'client_secret_post',
  reportsGrantedScopes: true,
};

/** The cursor the connector writes. */
interface ZoomCursor {
  readonly nextPageToken: string | null;
}

export interface ZoomAdapterOptions {
  readonly identity: (providerKey: string) => { clientId: string; clientSecret: string | null } | null;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly resolveHost?: ((host: string) => Promise<string[]>) | undefined;
  readonly log?: ((fields: Record<string, unknown>, message: string) => void) | undefined;
  readonly httpFactory?: ((connectionId: string) => ConnectorHttp) | undefined;
}

/**
 * The Zoom connector.
 */
export class ZoomAdapter extends OAuth2ConnectorBase {
  override readonly providerKey = ZOOM_PROVIDER_KEY;
  override readonly adapterVersion = '1.0.0';
  override readonly providerApiVersion = ZOOM_API_VERSION;
  override readonly capabilities: ConnectorCapabilities = zoomCapabilities();
  override readonly operations: ConnectorOperationFlags = {
    implementsFetch: true,
    implementsWrite: true,
    implementsDelete: false,
    implementsWebhook: true,
  };

  private readonly httpFactory: (connectionId: string) => ConnectorHttp;

  constructor(options: ZoomAdapterOptions) {
    super({
      config: ZOOM_OAUTH_CONFIG,
      identity: options.identity,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.resolveHost === undefined ? {} : { resolveHost: options.resolveHost }),
      ...(options.log === undefined ? {} : { log: options.log }),
    });
    this.httpFactory =
      options.httpFactory ??
      ((connectionId: string) =>
        new ConnectorHttp({
          providerKey: ZOOM_PROVIDER_KEY,
          connectionId,
          ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
          ...(options.resolveHost === undefined ? {} : { resolveHost: options.resolveHost }),
          ...(options.log === undefined ? {} : { log: options.log }),
        }));
  }

  /**
   * Check the connection with the cheapest read-only call.
   *
   * `GET /users/me/meetings` needs only the read scope and touches nothing.
   */
  async validateConnection(context: ConnectorContext): Promise<ConnectionValidationResult> {
    const http = this.httpFactory(context.connectionId);
    try {
      const payload = await http.json<unknown>({
        method: 'GET',
        url: buildUrl(`https://api.zoom.us/${ZOOM_API_VERSION}`, '/users/me/meetings', { type: 'upcoming', page_size: 1 }),
        headers: this.authHeaders(context),
      });
      const readable = Array.isArray(payload) || isJsonObject(payload);
      return {
        ok: readable,
        code: readable ? null : 'INVALID_REQUEST',
        message: readable ? null : 'The provider answered the connection test with an unreadable body.',
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
        objectType: ZOOM_MEETING_OBJECT,
        label: 'Meeting',
        fields: MEETING_FIELDS,
        incremental: false,
        maxPageSize: ZOOM_MAX_PAGE_SIZE,
      },
    ];
  }

  async listFields(_context: ConnectorContext, objectType: string): Promise<readonly ExternalFieldSchema[]> {
    if (objectType === ZOOM_MEETING_OBJECT) return MEETING_FIELDS;
    throw new ProviderError('NOT_FOUND', `The provider offers no object type "${objectType}".`, {
      category: 'not_found',
      retryable: false,
      detail: objectType,
    });
  }

  /** Enumerate one page of the user's meetings. */
  async fetchPage(input: FetchPageInput): Promise<FetchPageResult> {
    if (input.objectType !== ZOOM_MEETING_OBJECT) throw this.unknownObject(input.objectType);
    const http = this.httpFactory(input.context.connectionId);
    const cursor = decodeCursor<ZoomCursor>(input.cursor, ZOOM_PROVIDER_KEY);
    const userId = this.userId(input.context);
    const payload = await http.json<unknown>({
      method: 'GET',
      url: buildUrl(`https://api.zoom.us/${ZOOM_API_VERSION}`, `/users/${encodeURIComponent(userId)}/meetings`, {
        type: 'upcoming',
        page_size: this.clampPageSize(input.pageSize),
        ...(cursor?.nextPageToken === null || cursor === null ? {} : { next_page_token: cursor.nextPageToken }),
      }),
      headers: this.authHeaders(input.context),
    });
    const body = isJsonObject(payload) ? payload : {};
    const meetings = Array.isArray(body['meetings']) ? (body['meetings'] as unknown[]) : [];
    const nextPageToken = readString(body, 'next_page_token');
    return {
      objects: meetings.filter(isJsonObject).map((meeting) => toMeetingObject(meeting)),
      nextCursor:
        nextPageToken === null ? null : encodeCursor({ nextPageToken }),
      cursorExpired: false,
    };
  }

  /**
   * Create or update a meeting.
   *
   * A create is **reconciled**, not blindly retried: before creating, the connector looks for a
   * meeting that already carries the operation's marker. A retry after an ambiguous timeout
   * therefore returns the meeting that was already created instead of a second one.
   */
  async upsertObject(input: UpsertObjectInput): Promise<ExternalMutationResult> {
    if (input.objectType !== ZOOM_MEETING_OBJECT) throw this.unknownObject(input.objectType);
    this.assertScope(input.context, ZOOM_MEETING_WRITE_SCOPE);
    const http = this.httpFactory(input.context.connectionId);
    const userId = this.userId(input.context);
    const marker = input.idempotencyKey;

    if (input.externalId !== null) {
      const payload = await http.json<unknown>({
        method: 'PATCH',
        url: buildUrl(
          `https://api.zoom.us/${ZOOM_API_VERSION}`,
          `/meetings/${encodeURIComponent(input.externalId)}`,
        ),
        headers: { ...this.authHeaders(input.context), 'content-type': 'application/json' },
        body: JSON.stringify(toMeetingBody(input.fields)),
      });
      const updated = isJsonObject(payload) ? payload : {};
      return {
        externalId: readString(updated, 'id') ?? input.externalId,
        version: readString(updated, 'uuid'),
        updatedAt: readString(updated, 'created_at'),
        created: false,
      };
    }

    if (marker !== null) {
      const existing = await this.findByMarker(http, input.context, userId, marker);
      if (existing !== null) {
        return {
          externalId: existing.externalId,
          version: existing.version,
          updatedAt: existing.updatedAt,
          created: false,
        };
      }
    }

    const body: Record<string, unknown> = { ...toMeetingBody(input.fields) };
    if (marker !== null) {
      body['tracking_fields'] = [{ type: 'string', name: 'crm_operation_id', value: marker }];
    }
    const payload = await http.json<unknown>({
      method: 'POST',
      url: buildUrl(`https://api.zoom.us/${ZOOM_API_VERSION}`, `/users/${encodeURIComponent(userId)}/meetings`),
      headers: { ...this.authHeaders(input.context), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const created = isJsonObject(payload) ? payload : {};
    return {
      externalId: readString(created, 'id') ?? '',
      version: readString(created, 'uuid'),
      updatedAt: readString(created, 'created_at'),
      created: true,
    };
  }

  /**
   * Zoom meetings are not deleted.
   *
   * The connector declares no delete operation at all, so the engine refuses the operation with a
   * precise message instead of calling something that does not exist. A cancellation is a business
   * decision, not a technical one.
   */

  /**
   * Verify a Zoom webhook.
   *
   * The signature covers `v1:<timestamp>:<raw body>`, and the timestamp is inside a five-minute
   * window, so a captured delivery cannot be replayed indefinitely.
   */
  async verifyWebhook(input: VerifyWebhookInput): Promise<WebhookVerificationResult> {
    const plainToken = readChallenge(input.query, ['plainToken']);
    if (plainToken !== null) {
      const secret = input.context.credential.webhookSecret;
      if (secret === null || secret === '') {
        return { valid: false, reason: 'no_secret', challenge: null };
      }
      return { valid: true, reason: null, challenge: hmacSha256Base64Padded(secret, plainToken) };
    }
    const header = readHeader(input.headers, 'x-zm-signature');
    const verification = verifyTimestampedHmacSha256Hex({
      rawBody: input.rawBody,
      secret: input.context.credential.webhookSecret,
      header,
    });
    return { valid: verification.valid, reason: verification.reason, challenge: null };
  }

  /**
   * Turn a Zoom notification into normalized events.
   *
   * Zoom sends no delivery identifier, so one is derived from the event itself. The same event
   * delivered twice therefore produces the same identifier and is processed once.
   */
  async normalizeWebhook(input: NormalizeWebhookInput): Promise<readonly NormalizedProviderEvent[]> {
    const body = input.body;
    if (!isJsonObject(body)) return [];
    const event = readString(body, 'event') ?? '';
    const eventTs = readNumber(body, 'event_ts');
    const payload = isJsonObject(body['payload']) ? body['payload'] : {};
    const object = isJsonObject(payload['object']) ? payload['object'] : {};
    const externalId = readString(object, 'id');
    const deliveryId = createHash('sha256')
      .update(`${event}|${String(eventTs ?? '')}|${externalId ?? ''}`)
      .digest('hex');
    return [
      {
        deliveryId,
        objectType: ZOOM_MEETING_OBJECT,
        externalId,
        eventType: event === '' ? `${ZOOM_MEETING_OBJECT}.updated` : event,
        occurredAt: eventTs === null ? null : new Date(eventTs * 1000).toISOString(),
        fields: { ...object },
        deleted: event.endsWith('.deleted') || event.endsWith('.canceled'),
      },
    ];
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  /** Find a meeting that already carries the platform's operation marker. */
  private async findByMarker(
    http: ConnectorHttp,
    context: ConnectorContext,
    userId: string,
    marker: string,
  ): Promise<ExternalObject | null> {
    const payload = await http.json<unknown>({
      method: 'GET',
      url: buildUrl(`https://api.zoom.us/${ZOOM_API_VERSION}`, `/users/${encodeURIComponent(userId)}/meetings`, {
        type: 'upcoming',
        page_size: ZOOM_MAX_PAGE_SIZE,
      }),
      headers: this.authHeaders(context),
    });
    const body = isJsonObject(payload) ? payload : {};
    const meetings = Array.isArray(body['meetings']) ? (body['meetings'] as unknown[]) : [];
    for (const meeting of meetings) {
      if (!isJsonObject(meeting)) continue;
      const tracking = meeting['tracking_fields'];
      if (!Array.isArray(tracking)) continue;
      const matched = tracking.some(
        (entry) => isJsonObject(entry) && readString(entry, 'value') === marker,
      );
      if (matched) return toMeetingObject(meeting);
    }
    return null;
  }

  /** The Zoom user the connection acts as. */
  private userId(context: ConnectorContext): string {
    const configured = readStringList(context.options, 'zoomUserIds');
    const first = configured[0];
    if (first !== undefined && first !== '') return first;
    // "me" is Zoom's own shorthand for the account the token belongs to.
    return 'me';
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
    if (!Number.isFinite(pageSize) || pageSize <= 0) return ZOOM_MAX_PAGE_SIZE;
    return Math.min(Math.trunc(pageSize), ZOOM_MAX_PAGE_SIZE);
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
      message: 'Zoom could not be reached.',
      accountRef: null,
      grantedScopes: [],
    };
  }
}

/** Read a header in a case-insensitive way. */
function readHeader(
  headers: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value;
  }
  return undefined;
}

/** The external shape of one Zoom meeting. */
function toMeetingObject(meeting: Record<string, unknown>): ExternalObject {
  const id = readString(meeting, 'id') ?? '';
  return {
    objectType: ZOOM_MEETING_OBJECT,
    externalId: id,
    externalParentId: null,
    fields: {
      id,
      uuid: readString(meeting, 'uuid') ?? '',
      topic: readString(meeting, 'topic') ?? '',
      agenda: readString(meeting, 'agenda') ?? '',
      start_time: readString(meeting, 'start_time') ?? '',
      duration: readNumber(meeting, 'duration') ?? 0,
      timezone: readString(meeting, 'timezone') ?? '',
      join_url: readString(meeting, 'join_url') ?? '',
      start_url: readString(meeting, 'start_url') ?? '',
      status: readString(meeting, 'status') ?? '',
      created_at: readString(meeting, 'created_at') ?? '',
    },
    updatedAt: readString(meeting, 'created_at'),
    version: readString(meeting, 'uuid'),
    deleted: false,
  };
}

/** The Zoom body of a meeting, built from a mapped field set. */
function toMeetingBody(fields: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (typeof fields['topic'] === 'string') body['topic'] = fields['topic'];
  if (typeof fields['agenda'] === 'string') body['agenda'] = fields['agenda'];
  if (typeof fields['start_time'] === 'string' && fields['start_time'] !== '') body['start_time'] = fields['start_time'];
  if (typeof fields['duration'] === 'number') body['duration'] = fields['duration'];
  if (typeof fields['timezone'] === 'string' && fields['timezone'] !== '') body['timezone'] = fields['timezone'];
  return body;
}
