import type {
  ConnectionValidationResult,
  ConnectorContext,
  DeleteObjectInput,
  ExternalFieldSchema,
  ExternalMutationResult,
  ExternalObject,
  ExternalObjectSchema,
  FetchPageInput,
  FetchPageResult,
  UpsertObjectInput,
} from '../../connector-adapter.port.js';
import { CONNECTOR_CAPABILITY_SCHEMA_VERSION, type ConnectorCapabilities } from '../../provider-capabilities.js';
import { ProviderError } from '../../provider-error.js';
import { AbstractConnectorAdapter, type ConnectorOperationFlags } from '../kit/base-adapter.js';
import { buildUrl, ConnectorHttp, decodeCursor, encodeCursor, isJsonObject } from '../kit/connector-kit.js';
import {
  endpointSupportsMethod,
  GENERIC_REST_MAX_RESPONSE_BYTES,
  type GenericRestEndpoint,
  parseGenericRestEndpoint,
  readPointer,
  resolveGenericRestUrl,
} from './generic-rest-endpoint.js';

/**
 * Phase 19-INT.24 — the generic REST connector
 * (`PLAN_Phase_19_Advanced_Integrations.md` §12.10; `19-INT.24`).
 *
 * A connector for a **vetted** external REST API. Not a way to reach any URL: the endpoint is a
 * reviewed configuration (see `generic-rest-endpoint.ts`) and this file only reads through it.
 *
 * The first release is **read-only**. The plan allows outbound delivery, but outbound means the
 * platform writes to a third party, and the review of *which* data may leave the CRM is a decision
 * the plan puts with an administrator — so the write surface is deliberately absent here and the
 * limitation is recorded rather than implied.
 *
 * Two behaviours are worth naming:
 *
 *  - **A malformed answer is refused, not half-read.** The connector requires the pointer to reach
 *    an array and every item to carry an id. An answer that does not is a `permanent_validation`
 *    failure: it will not become better on a retry, and half-mapping it would create records that
 *    cannot be correlated later.
 *  - **A payload is bounded twice.** The HTTP client refuses an answer that is too large, and the
 *    endpoint's own ceiling is lower still.
 */

export const GENERIC_REST_PROVIDER_KEY = 'generic-rest';

/** The object type the generic connector offers. */
export const GENERIC_REST_OBJECT = 'restObject';

const OBJECT_FIELDS: readonly ExternalFieldSchema[] = [
  { name: 'id', label: 'ID', type: 'string', required: true, unique: true, identifier: true, sensitive: false },
  { name: 'updatedAt', label: 'Updated at', type: 'datetime', required: false, unique: false, identifier: false, sensitive: false },
  { name: 'version', label: 'Version', type: 'string', required: false, unique: false, identifier: false, sensitive: false },
  { name: 'deleted', label: 'Deleted', type: 'boolean', required: false, unique: false, identifier: false, sensitive: false },
  { name: 'payload', label: 'Payload', type: 'object', required: true, unique: false, identifier: false, sensitive: true },
];

/** The capability declaration of the generic REST connector. */
export function genericRestCapabilities(): ConnectorCapabilities {
  const object = {
    objectType: GENERIC_REST_OBJECT,
    label: 'REST object',
    read: true,
    create: false,
    update: false,
    delete: false,
    upsert: false,
    webhook: false,
    syncDirections: ['inbound'] as const,
    fullSync: true,
    incrementalSync: false,
    requiredScopes: [] as readonly string[],
    optionalScopes: [] as readonly string[],
    maxPageSize: 500,
    rateLimitStrategy: 'fixed_window' as const,
    externalIdFields: ['id'],
    uniqueFields: ['id'],
    deletionVisibility: 'tombstoned' as const,
    transactional: false,
    dataSensitivity: 'business' as const,
  };
  return {
    schemaVersion: CONNECTOR_CAPABILITY_SCHEMA_VERSION,
    authentication: 'api_key',
    objects: [object],
    webhook: { supported: false, requiresRawBody: false, requiresEndpointValidation: false },
  };
}

/** The cursor the connector writes. */
interface GenericRestCursor {
  readonly nextCursor: string | null;
}

export interface GenericRestAdapterOptions {
  readonly fetchImpl?: typeof fetch | undefined;
  readonly resolveHost?: ((host: string) => Promise<string[]>) | undefined;
  readonly log?: ((fields: Record<string, unknown>, message: string) => void) | undefined;
  readonly httpFactory?: ((connectionId: string) => ConnectorHttp) | undefined;
}

/**
 * The generic REST connector.
 */
export class GenericRestAdapter extends AbstractConnectorAdapter {
  override readonly providerKey = GENERIC_REST_PROVIDER_KEY;
  override readonly adapterVersion = '1.0.0';
  override readonly providerApiVersion = '1';
  override readonly capabilities: ConnectorCapabilities = genericRestCapabilities();
  override readonly operations: ConnectorOperationFlags = {
    implementsFetch: true,
    implementsWrite: false,
    implementsDelete: false,
    implementsWebhook: false,
  };

  private readonly httpFactory: (connectionId: string) => ConnectorHttp;

  constructor(options: GenericRestAdapterOptions = {}) {
    super();
    this.httpFactory =
      options.httpFactory ??
      ((connectionId: string) =>
        new ConnectorHttp({
          providerKey: GENERIC_REST_PROVIDER_KEY,
          connectionId,
          ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
          ...(options.resolveHost === undefined ? {} : { resolveHost: options.resolveHost }),
          ...(options.log === undefined ? {} : { log: options.log }),
        }));
  }

  /**
   * Check the connection with the cheapest read-only call the endpoint allows.
   *
   * The endpoint's own list path is used, so the test exercises the same allowlist the sync uses.
   */
  async validateConnection(context: ConnectorContext): Promise<ConnectionValidationResult> {
    const endpoint = this.endpoint(context);
    if (!endpointSupportsMethod(endpoint, 'GET')) {
      return {
        ok: false,
        code: 'CONFIGURATION_INVALID',
        message: 'The endpoint does not allow GET, so it cannot be read.',
        accountRef: null,
        grantedScopes: [],
      };
    }
    const http = this.httpFactory(context.connectionId);
    try {
      const url = resolveGenericRestUrl(endpoint, { externalId: null, cursor: null, pageSize: 1 });
      await http.json<unknown>({
        method: 'GET',
        url,
        headers: this.authHeaders(context, endpoint),
      });
      return {
        ok: true,
        code: null,
        message: null,
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
        objectType: GENERIC_REST_OBJECT,
        label: 'REST object',
        fields: OBJECT_FIELDS,
        incremental: false,
        maxPageSize: 500,
      },
    ];
  }

  async listFields(_context: ConnectorContext, objectType: string): Promise<readonly ExternalFieldSchema[]> {
    if (objectType === GENERIC_REST_OBJECT) return OBJECT_FIELDS;
    throw new ProviderError('NOT_FOUND', `The provider offers no object type "${objectType}".`, {
      category: 'not_found',
      retryable: false,
      detail: objectType,
    });
  }

  /**
   * Enumerate one page of the endpoint.
   *
   * The answer is read through the endpoint's pointers. An answer that does not match the declared
   * shape is refused outright.
   */
  async fetchPage(input: FetchPageInput): Promise<FetchPageResult> {
    if (input.objectType !== GENERIC_REST_OBJECT) {
      throw new ProviderError('NOT_FOUND', `The provider offers no object type "${input.objectType}".`, {
        category: 'not_found',
        retryable: false,
        detail: input.objectType,
      });
    }
    const endpoint = this.endpoint(input.context);
    if (!endpointSupportsMethod(endpoint, 'GET')) {
      throw new ProviderError('CONFIGURATION_INVALID', 'The endpoint does not allow GET.', {
        category: 'configuration_invalid',
        retryable: false,
        detail: 'method_not_allowed',
      });
    }
    const http = this.httpFactory(input.context.connectionId);
    const cursor = decodeCursor<GenericRestCursor>(input.cursor, GENERIC_REST_PROVIDER_KEY);
    const url = resolveGenericRestUrl(endpoint, {
      externalId: null,
      cursor: cursor?.nextCursor ?? null,
      pageSize: this.clampPageSize(input.pageSize, endpoint.pageSize),
    });
    const payload = await http.json<unknown>({
      method: 'GET',
      url,
      headers: this.authHeaders(input.context, endpoint),
      timeoutMs: endpoint.timeoutMs,
    });
    const items = readPointer(payload, endpoint.itemsPointer);
    if (!Array.isArray(items)) {
      throw new ProviderError(
        'INVALID_REQUEST',
        'The provider answered with a body that does not match the declared response schema.',
        { category: 'permanent_validation', retryable: false, detail: 'schema_mismatch' },
      );
    }
    const objects = items.map((item) => toExternalObject(item, endpoint));
    const nextCursor = this.readNextCursor(payload, endpoint);
    return {
      objects,
      nextCursor: nextCursor === null ? null : encodeCursor({ nextCursor }),
      cursorExpired: false,
    };
  }

  /** The generic connector reads. */
  async upsertObject(_input: UpsertObjectInput): Promise<ExternalMutationResult> {
    throw new ProviderError(
      'CONFIGURATION_INVALID',
      'The generic REST connector is read-only. Outbound delivery to a vetted endpoint needs a reviewed configuration.',
      { category: 'configuration_invalid', retryable: false, detail: 'read_only' },
    );
  }

  /** The generic connector does not delete. */
  async deleteObject(_input: DeleteObjectInput): Promise<ExternalMutationResult> {
    throw new ProviderError('CONFIGURATION_INVALID', 'The generic REST connector is read-only.', {
      category: 'configuration_invalid',
      retryable: false,
      detail: 'read_only',
    });
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  /** The endpoint of the connection, validated. */
  private endpoint(context: ConnectorContext): GenericRestEndpoint {
    return parseGenericRestEndpoint(context.options, GENERIC_REST_PROVIDER_KEY);
  }

  /** The request headers. The credential never leaves the endpoint's own host. */
  private authHeaders(context: ConnectorContext, endpoint: GenericRestEndpoint): Record<string, string> {
    const headers: Record<string, string> = { accept: 'application/json' };
    switch (endpoint.authMode) {
      case 'none':
        return headers;
      case 'bearer': {
        const value = context.credential.apiKey;
        if (value === null || value === '') {
          throw new ProviderError('CONFIGURATION_INVALID', 'The connection holds no credential.', {
            category: 'configuration_invalid',
            retryable: false,
            detail: 'no_credential',
          });
        }
        headers['authorization'] = `Bearer ${value}`;
        return headers;
      }
      case 'header': {
        const value = context.credential.apiKey;
        if (value === null || value === '') {
          throw new ProviderError('CONFIGURATION_INVALID', 'The connection holds no credential.', {
            category: 'configuration_invalid',
            retryable: false,
            detail: 'no_credential',
          });
        }
        if (endpoint.authHeaderName === null) {
          throw new ProviderError('CONFIGURATION_INVALID', 'The endpoint names no credential header.', {
            category: 'configuration_invalid',
            retryable: false,
            detail: 'no_credential_header',
          });
        }
        headers[endpoint.authHeaderName.toLowerCase()] = value;
        return headers;
      }
      case 'oauth': {
        const token = context.credential.accessToken;
        if (token === null) {
          throw new ProviderError('TOKEN_EXPIRED', 'The connection holds no access token.', {
            category: 'authorization',
            retryable: false,
            detail: 'no_access_token',
          });
        }
        headers['authorization'] = `Bearer ${token}`;
        return headers;
      }
    }
  }

  /** The next cursor of the answer, when the endpoint declares one. */
  private readNextCursor(payload: unknown, endpoint: GenericRestEndpoint): string | null {
    if (endpoint.nextCursorPointer === null) return null;
    const value = readPointer(payload, endpoint.nextCursorPointer);
    if (typeof value === 'string' && value.trim() !== '') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return null;
  }

  private clampPageSize(pageSize: number, maximum: number): number {
    if (!Number.isFinite(pageSize) || pageSize <= 0) return maximum;
    return Math.min(Math.trunc(pageSize), maximum);
  }

  private failure(error: unknown): ConnectionValidationResult {
    if (error instanceof ProviderError) {
      return { ok: false, code: error.code, message: error.message, accountRef: null, grantedScopes: [] };
    }
    return {
      ok: false,
      code: 'UNKNOWN',
      message: 'The endpoint could not be reached.',
      accountRef: null,
      grantedScopes: [],
    };
  }
}

/** The maximum payload the connector accepts. */
export const GENERIC_REST_PAYLOAD_CEILING = GENERIC_REST_MAX_RESPONSE_BYTES;

/** The external shape of one REST item. */
function toExternalObject(item: unknown, endpoint: GenericRestEndpoint): ExternalObject {
  if (!isJsonObject(item)) {
    throw new ProviderError('INVALID_REQUEST', 'The provider answered with an item that is not an object.', {
      category: 'permanent_validation',
      retryable: false,
      detail: 'schema_mismatch',
    });
  }
  const id = readPointer(item, endpoint.idPointer);
  if (typeof id !== 'string' && typeof id !== 'number') {
    throw new ProviderError(
      'INVALID_REQUEST',
      'The provider answered with an item that carries no identifier.',
      { category: 'permanent_validation', retryable: false, detail: 'schema_mismatch' },
    );
  }
  const externalId = String(id);
  const updatedAt = endpoint.updatedAtPointer === null ? null : readPointer(item, endpoint.updatedAtPointer);
  const version = endpoint.versionPointer === null ? null : readPointer(item, endpoint.versionPointer);
  const deleted = endpoint.deletedPointer === null ? null : readPointer(item, endpoint.deletedPointer);
  return {
    objectType: GENERIC_REST_OBJECT,
    externalId,
    externalParentId: null,
    fields: {
      id: externalId,
      updatedAt: typeof updatedAt === 'string' ? updatedAt : null,
      version: typeof version === 'string' || typeof version === 'number' ? String(version) : null,
      deleted: deleted === true,
      payload: item,
    },
    updatedAt: typeof updatedAt === 'string' ? updatedAt : null,
    version: typeof version === 'string' ? version : null,
    deleted: deleted === true,
  };
}

/** The URL of an endpoint, for a caller that wants to show it. */
export function genericRestEndpointUrl(options: Readonly<Record<string, unknown>>): string {
  const endpoint = parseGenericRestEndpoint(options, GENERIC_REST_PROVIDER_KEY);
  return buildUrl(endpoint.baseUrl, '');
}
