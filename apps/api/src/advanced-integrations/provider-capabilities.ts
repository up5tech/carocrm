import { ValidationError } from '@carocrm/core/errors/index.js';

/**
 * Phase 19-INT.3 — the versioned connector capability schema
 * (`PLAN_Phase_19_Advanced_Integrations.md` §5.4; `19-INT.3`).
 *
 * A connector declares what it can do. The declaration is **data**, validated against this file's
 * rules, and it is the single answer to two questions:
 *
 *  - *may the admin UI offer this action?* — the declaration says yes or no;
 *  - *may the dispatcher perform this operation?* — the same declaration is checked **before** a
 *    call is made, so an unsupported operation is refused with a precise message instead of
 *    throwing "not implemented" from deep inside an adapter.
 *
 * Capabilities live with the adapter that implements them (ADR 0002, decision 5), so they cannot
 * drift from the code that would honour them.
 *
 * The version is explicit. A declaration of an unknown schema version is refused at startup rather
 * than partially interpreted.
 */

export const CONNECTOR_CAPABILITY_SCHEMA_VERSION = 1;

export const SYNC_DIRECTIONS = ['inbound', 'outbound', 'bidirectional'] as const;
export type SyncDirection = (typeof SYNC_DIRECTIONS)[number];

export const AUTHENTICATION_TYPES = ['oauth', 'api_key', 'service_account', 'none'] as const;
export type AuthenticationType = (typeof AUTHENTICATION_TYPES)[number];

export const DELETION_VISIBILITIES = ['visible', 'tombstoned', 'not_synchronized'] as const;
export type DeletionVisibility = (typeof DELETION_VISIBILITIES)[number];

export const DATA_SENSITIVITIES = ['none', 'business', 'personal', 'communication', 'financial'] as const;
export type DataSensitivity = (typeof DATA_SENSITIVITIES)[number];

export const RATE_LIMIT_STRATEGIES = ['provider_header', 'fixed_window', 'unknown'] as const;
export type RateLimitStrategy = (typeof RATE_LIMIT_STRATEGIES)[number];

/** What one provider object supports. */
export interface ConnectorObjectCapability {
  readonly objectType: string;
  readonly label: string;
  readonly read: boolean;
  readonly create: boolean;
  readonly update: boolean;
  readonly delete: boolean;
  readonly upsert: boolean;
  /** The provider pushes changes for this object through a webhook. */
  readonly webhook: boolean;
  readonly syncDirections: readonly SyncDirection[];
  /** A full enumeration of the object is possible. */
  readonly fullSync: boolean;
  /** The provider offers a cursor / delta feed. */
  readonly incrementalSync: boolean;
  /** Scopes the provider demands before this object may be used. */
  readonly requiredScopes: readonly string[];
  readonly optionalScopes: readonly string[];
  /** The provider's maximum page size, when it publishes one. */
  readonly maxPageSize: number | null;
  readonly rateLimitStrategy: RateLimitStrategy;
  /** Provider fields that identify an object across syncs. */
  readonly externalIdFields: readonly string[];
  /** Provider fields that are unique per object. */
  readonly uniqueFields: readonly string[];
  readonly deletionVisibility: DeletionVisibility;
  /** Whether a provider write is applied atomically. */
  readonly transactional: boolean;
  readonly dataSensitivity: DataSensitivity;
}

export interface ConnectorWebhookCapability {
  readonly supported: boolean;
  /** The provider signs the exact bytes it sent, so the raw body must be preserved. */
  readonly requiresRawBody: boolean;
  /** The provider requires a challenge round-trip before it will deliver. */
  readonly requiresEndpointValidation: boolean;
}

export interface ConnectorCapabilities {
  readonly schemaVersion: number;
  readonly authentication: AuthenticationType;
  readonly objects: readonly ConnectorObjectCapability[];
  readonly webhook: ConnectorWebhookCapability;
}

/** The operation names the platform may ask a connector to perform. */
export const CONNECTOR_OPERATIONS = ['read', 'create', 'update', 'delete', 'upsert', 'webhook'] as const;
export type ConnectorOperation = (typeof CONNECTOR_OPERATIONS)[number];

/**
 * What an adapter must implement for a declared capability to be honoured.
 *
 * A declaration the adapter cannot satisfy is a **startup failure**, not a runtime surprise.
 */
export interface ConnectorAdapterShape {
  readonly implementsFetch: boolean;
  readonly implementsWrite: boolean;
  readonly implementsDelete: boolean;
  readonly implementsWebhook: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new ValidationError(`Capability "${path}" must be a boolean.`, { path });
  return value;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`Capability "${path}" must be a non-empty string.`, { path });
  }
  return value;
}

function requireStringArray(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new ValidationError(`Capability "${path}" must be an array of strings.`, { path });
  }
  return value as readonly string[];
}

function requireOneOf<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new ValidationError(`Capability "${path}" must be one of: ${allowed.join(', ')}.`, { path });
  }
  return value as T;
}

/**
 * Validate a capability declaration.
 *
 * Returns the normalised declaration. Throws `ValidationError` with the offending path, so a
 * connector author sees *which* field is wrong rather than "invalid capabilities".
 */
export function validateConnectorCapabilities(capabilities: unknown): ConnectorCapabilities {
  if (!isRecord(capabilities)) {
    throw new ValidationError('Connector capabilities must be an object.');
  }
  const schemaVersion = capabilities['schemaVersion'];
  if (schemaVersion !== CONNECTOR_CAPABILITY_SCHEMA_VERSION) {
    throw new ValidationError(
      `Unsupported capability schema version ${String(schemaVersion)}. This platform understands version ${String(CONNECTOR_CAPABILITY_SCHEMA_VERSION)}.`,
      { schemaVersion },
    );
  }
  const authentication = requireOneOf(capabilities['authentication'], AUTHENTICATION_TYPES, 'authentication');

  const rawObjects = capabilities['objects'];
  if (!Array.isArray(rawObjects)) {
    throw new ValidationError('Capability "objects" must be an array.');
  }
  const seen = new Set<string>();
  const objects = rawObjects.map((raw, index) => {
    const path = `objects[${String(index)}]`;
    if (!isRecord(raw)) throw new ValidationError(`Capability "${path}" must be an object.`, { path });
    const objectType = requireString(raw['objectType'], `${path}.objectType`);
    if (seen.has(objectType)) {
      throw new ValidationError(`Capability "objects" declares "${objectType}" twice.`, { path });
    }
    seen.add(objectType);

    const read = requireBoolean(raw['read'], `${path}.read`);
    const create = requireBoolean(raw['create'], `${path}.create`);
    const update = requireBoolean(raw['update'], `${path}.update`);
    const remove = requireBoolean(raw['delete'], `${path}.delete`);
    const upsert = requireBoolean(raw['upsert'], `${path}.upsert`);
    const webhook = requireBoolean(raw['webhook'], `${path}.webhook`);

    const rawDirections = requireStringArray(raw['syncDirections'], `${path}.syncDirections`);
    const syncDirections = rawDirections.map((direction) =>
      requireOneOf(direction, SYNC_DIRECTIONS, `${path}.syncDirections`),
    );
    for (const direction of syncDirections) {
      if (!SYNC_DIRECTIONS.includes(direction)) {
        throw new ValidationError(`Capability "${path}.syncDirections" names an unknown direction "${direction}".`, {
          path,
        });
      }
    }

    const fullSync = requireBoolean(raw['fullSync'], `${path}.fullSync`);
    const incrementalSync = requireBoolean(raw['incrementalSync'], `${path}.incrementalSync`);

    const requiredScopes = requireStringArray(raw['requiredScopes'] ?? [], `${path}.requiredScopes`);
    const optionalScopes = requireStringArray(raw['optionalScopes'] ?? [], `${path}.optionalScopes`);
    const externalIdFields = requireStringArray(raw['externalIdFields'] ?? [], `${path}.externalIdFields`);
    const uniqueFields = requireStringArray(raw['uniqueFields'] ?? [], `${path}.uniqueFields`);

    const rawMaxPageSize = raw['maxPageSize'];
    const maxPageSize = rawMaxPageSize === null || rawMaxPageSize === undefined ? null : requireNumber(rawMaxPageSize, `${path}.maxPageSize`);

    const rateLimitStrategy = requireOneOf(raw['rateLimitStrategy'] ?? 'unknown', RATE_LIMIT_STRATEGIES, `${path}.rateLimitStrategy`);
    const deletionVisibility = requireOneOf(
      raw['deletionVisibility'] ?? 'not_synchronized',
      DELETION_VISIBILITIES,
      `${path}.deletionVisibility`,
    );
    const dataSensitivity = requireOneOf(raw['dataSensitivity'] ?? 'business', DATA_SENSITIVITIES, `${path}.dataSensitivity`);
    const transactional = requireBoolean(raw['transactional'] ?? false, `${path}.transactional`);

    // ---- combination rules: a capability combination that cannot work is refused here. ----

    if (remove && !read) {
      throw new ValidationError(`Capability "${path}" deletes an object it cannot read.`, { path });
    }
    if (incrementalSync && !fullSync) {
      throw new ValidationError(`Capability "${path}" offers incremental sync without full sync.`, { path });
    }
    if (syncDirections.includes('inbound') && !read) {
      throw new ValidationError(`Capability "${path}" syncs inbound without being able to read.`, { path });
    }
    if (
      syncDirections.includes('outbound') &&
      !create &&
      !update &&
      !upsert &&
      !remove
    ) {
      throw new ValidationError(`Capability "${path}" syncs outbound without any write operation.`, { path });
    }
    if (syncDirections.includes('bidirectional') && !syncDirections.includes('inbound')) {
      throw new ValidationError(`Capability "${path}" declares bidirectional sync without inbound.`, { path });
    }
    if (syncDirections.includes('bidirectional') && !syncDirections.includes('outbound')) {
      throw new ValidationError(`Capability "${path}" declares bidirectional sync without outbound.`, { path });
    }
    if (read && externalIdFields.length === 0) {
      throw new ValidationError(
        `Capability "${path}" reads an object with no external identifier, so a record cannot be correlated across syncs.`,
        { path },
      );
    }
    if (requiredScopes.length > 0 && authentication === 'none') {
      throw new ValidationError(`Capability "${path}" requires scopes but the connector is unauthenticated.`, { path });
    }

    return {
      objectType,
      label: requireString(raw['label'] ?? objectType, `${path}.label`),
      read,
      create,
      update,
      delete: remove,
      upsert,
      webhook,
      syncDirections,
      fullSync,
      incrementalSync,
      requiredScopes,
      optionalScopes,
      maxPageSize,
      rateLimitStrategy,
      externalIdFields,
      uniqueFields,
      deletionVisibility,
      transactional,
      dataSensitivity,
    } satisfies ConnectorObjectCapability;
  });

  const rawWebhook = capabilities['webhook'];
  const webhookObject = isRecord(rawWebhook) ? rawWebhook : {};
  const webhook: ConnectorWebhookCapability = {
    supported: requireBoolean(webhookObject['supported'] ?? false, 'webhook.supported'),
    requiresRawBody: requireBoolean(webhookObject['requiresRawBody'] ?? false, 'webhook.requiresRawBody'),
    requiresEndpointValidation: requireBoolean(
      webhookObject['requiresEndpointValidation'] ?? false,
      'webhook.requiresEndpointValidation',
    ),
  };

  return { schemaVersion, authentication, objects, webhook };
}

function requireNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new ValidationError(`Capability "${path}" must be a positive number.`, { path });
  }
  return value;
}

/**
 * Check a declaration against the adapter that must honour it.
 *
 * A declaration the adapter cannot satisfy is a **startup failure**: an admin must never be shown
 * a capability that the connector would refuse at the first call.
 */
export function assertAdapterSatisfiesCapabilities(
  capabilities: ConnectorCapabilities,
  adapter: ConnectorAdapterShape,
  providerKey: string,
): void {
  const wantsRead = capabilities.objects.some((object) => object.read);
  const wantsWrite = capabilities.objects.some((object) => object.create || object.update || object.upsert);
  const wantsDelete = capabilities.objects.some((object) => object.delete);
  const wantsWebhook = capabilities.objects.some((object) => object.webhook) || capabilities.webhook.supported;

  if (wantsRead && !adapter.implementsFetch) {
    throw new ValidationError(
      `Connector "${providerKey}" declares readable objects but does not implement a fetch operation.`,
      { providerKey },
    );
  }
  if (wantsWrite && !adapter.implementsWrite) {
    throw new ValidationError(
      `Connector "${providerKey}" declares writable objects but does not implement a write operation.`,
      { providerKey },
    );
  }
  if (wantsDelete && !adapter.implementsDelete) {
    throw new ValidationError(
      `Connector "${providerKey}" declares deletable objects but does not implement a delete operation.`,
      { providerKey },
    );
  }
  if (wantsWebhook && !adapter.implementsWebhook) {
    throw new ValidationError(
      `Connector "${providerKey}" declares webhook support but does not implement webhook verification.`,
      { providerKey },
    );
  }
}

/**
 * The object declaration for `objectType`, or `undefined` when the connector does not offer it.
 */
export function findObjectCapability(
  capabilities: ConnectorCapabilities,
  objectType: string,
): ConnectorObjectCapability | undefined {
  return capabilities.objects.find((object) => object.objectType === objectType);
}

/**
 * Whether the connector may perform `operation` on `objectType`.
 *
 * This is the check the dispatcher makes **before** a call. It is the same declaration the admin
 * UI reads, so the UI can never offer an action the platform would refuse.
 */
export function supportsOperation(
  capabilities: ConnectorCapabilities,
  objectType: string,
  operation: ConnectorOperation,
): boolean {
  const object = findObjectCapability(capabilities, objectType);
  if (!object) return false;
  switch (operation) {
    case 'read':
      return object.read;
    case 'create':
      return object.create;
    case 'update':
      return object.update;
    case 'delete':
      return object.delete;
    case 'upsert':
      return object.upsert;
    case 'webhook':
      return object.webhook && capabilities.webhook.supported;
  }
}

/**
 * Every scope the connector needs before `objectType` may be used.
 *
 * The union of the object's required scopes and, when the object is synced in both directions,
 * the scopes of the objects it writes to. Deduplicated and stable in order.
 */
export function requiredScopesFor(
  capabilities: ConnectorCapabilities,
  objectType: string,
): readonly string[] {
  const object = findObjectCapability(capabilities, objectType);
  if (!object) return [];
  return [...new Set(object.requiredScopes)];
}
