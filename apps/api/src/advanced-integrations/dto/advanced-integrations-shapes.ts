import { z } from 'zod';

/**
 * Phase 19-INT.2–19-INT.5 — request shapes
 * (`PLAN_Phase_19_Advanced_Integrations.md` §13; `19-INT.2`).
 *
 * Every shape is strict: an unknown key is rejected instead of silently ignored. The controller
 * parses shape only; business rules (provider resolution, state-machine validation, secret
 * encryption, scope checks) live in the services.
 */

export const PROVIDER_KEY_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;

const ProviderKeySchema = z
  .string()
  .trim()
  .regex(PROVIDER_KEY_PATTERN, 'Provider keys start with a letter and contain lowercase letters, digits or hyphens.');

const ConnectionNameSchema = z.string().trim().min(1).max(120);

const ScopeSchema = z.string().trim().min(1).max(200);

/**
 * The configuration a connection may carry.
 *
 * A key that looks like a credential is refused by the service, not here — the rule is a domain
 * rule and the message belongs with the domain.
 */
const ConnectionOptionsSchema = z.record(z.string().trim().min(1).max(64), z.unknown());

export const ConnectionCreateSchema = z
  .object({
    providerKey: ProviderKeySchema,
    name: ConnectionNameSchema,
    /**
     * Ownership. `organization` is the default (feature contract §4); `user` scopes the
     * connection to one principal.
     */
    ownerType: z.enum(['organization', 'user']).default('organization'),
    /** The owner's id. Defaults to the current principal for a user-scoped connection. */
    ownerId: z.string().trim().min(1).max(64).optional(),
    /** A non-secret provider account/tenant label. */
    tenantRef: z.string().trim().max(200).optional(),
    connectionOptions: ConnectionOptionsSchema.optional(),
  })
  .strict();

export const ConnectionPatchSchema = z
  .object({
    name: ConnectionNameSchema.optional(),
    tenantRef: z.string().trim().max(200).nullish(),
    connectionOptions: ConnectionOptionsSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

export const CredentialWriteSchema = z
  .object({
    kind: z.enum(['api_key', 'client_secret', 'webhook_secret', 'signing_secret']),
    /** The secret itself. It is write-only: no read path ever returns it. */
    value: z.string().min(1).max(8192),
    expiresAt: z.string().trim().max(40).nullish(),
  })
  .strict();

export const AuthorizeSchema = z
  .object({
    /**
     * Scopes to request. The platform intersects them with what the provider declares, so a
     * caller can narrow but never widen.
     */
    scopes: z.array(ScopeSchema).max(64).optional(),
  })
  .strict();

export const EmptyBodySchema = z.object({}).strict();

/** The OAuth callback's query string. */
export const OAuthCallbackSchema = z
  .object({
    state: z.string().min(1).max(512),
    code: z.string().min(1).max(4096).optional(),
    error: z.string().max(512).optional(),
    error_description: z.string().max(1024).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// 19-INT.8 — mappings
// ---------------------------------------------------------------------------

const FieldMappingSchema = z
  .object({
    /** A dotted path into the provider object. */
    sourcePath: z.string().trim().min(1).max(200),
    /** The CRM field the value is written to. */
    targetField: z.string().trim().min(1).max(120),
    /** The allowlisted transformation. `null` is a direct copy. */
    transform: z.unknown().nullable().optional(),
    required: z.boolean().default(false),
    direction: z.enum(['inbound', 'outbound', 'bidirectional']).default('inbound'),
  })
  .strict();

export const MappingCreateSchema = z
  .object({
    providerKey: z.string().trim().min(1).max(64),
    objectType: z.string().trim().min(1).max(64),
    crmEntityType: z.string().trim().min(1).max(64),
    direction: z.enum(['inbound', 'outbound', 'bidirectional']).default('inbound'),
    syncMode: z.enum(['full', 'incremental']).default('incremental'),
    conflictPolicy: z.enum(['provider_wins', 'crm_wins', 'manual', 'newest_wins']).default('manual'),
    deletionPolicy: z.enum(['unlink', 'archive', 'ignore']).default('unlink'),
    /** Per-field authority, e.g. `{"amount": "provider", "title": "crm"}`. */
    fieldAuthority: z.record(z.string().trim().min(1).max(120), z.string().trim().min(1).max(40)).default({}),
    fields: z.array(FieldMappingSchema).max(200).default([]),
  })
  .strict();

export const MappingPatchSchema = z
  .object({
    crmEntityType: z.string().trim().min(1).max(64).optional(),
    direction: z.enum(['inbound', 'outbound', 'bidirectional']).optional(),
    syncMode: z.enum(['full', 'incremental']).optional(),
    conflictPolicy: z.enum(['provider_wins', 'crm_wins', 'manual', 'newest_wins']).optional(),
    deletionPolicy: z.enum(['unlink', 'archive', 'ignore']).optional(),
    fieldAuthority: z.record(z.string().trim().min(1).max(120), z.string().trim().min(1).max(40)).optional(),
    fields: z.array(FieldMappingSchema).max(200).optional(),
  })
  .strict();

export const MappingPreviewSchema = z
  .object({
    /** A sample provider object. Nothing is written. */
    sample: z.record(z.string(), z.unknown()),
  })
  .strict();

// ---------------------------------------------------------------------------
// 19-INT.9 / 19-INT.10 / 19-INT.11 / 19-INT.13
// ---------------------------------------------------------------------------

export const SyncRunSchema = z
  .object({
    runType: z.enum(['full', 'incremental', 'webhook', 'manual']).optional(),
    triggerSource: z.enum(['schedule', 'manual', 'webhook', 'event']).optional(),
    /** Stop after this many provider objects. */
    maxRecords: z.number().int().min(1).max(1000).optional(),
    /** The page size the run asks the provider for. Clamped by the connector's declared maximum. */
    pageSize: z.number().int().min(1).max(1000).optional(),
  })
  .strict();

export const ConflictResolveSchema = z
  .object({
    resolution: z.enum(['keep_crm', 'keep_provider', 'ignore', 'unlink']),
  })
  .strict();

export const OutboundEventSchema = z
  .object({
    eventId: z.string().trim().min(1).max(200),
    eventType: z.string().trim().min(1).max(80),
    entityType: z.string().trim().min(1).max(80),
    entityId: z.string().trim().min(1).max(200),
  })
  .strict();

export const WebhookProcessSchema = z
  .object({
    connectionId: z.string().trim().min(1).max(64),
    deliveryId: z.string().trim().min(1).max(200),
    providerKey: z.string().trim().min(1).max(64),
    objectType: z.string().trim().min(1).max(64),
    externalId: z.string().trim().min(1).max(200).nullable(),
    eventType: z.string().trim().min(1).max(80),
    /**
     * True when a domain handler already claimed the event. The generic mapping path must then be
     * skipped, or the event would be applied twice — once by the domain that owns it and once by
     * the generic mapping.
     */
    handled: z.boolean().optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// 19-INT.17 / 19-INT.24
// ---------------------------------------------------------------------------

/** The fields a profile may opt in to. */
const EnrichmentFieldSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z][A-Za-z0-9_]*$/, 'A field name starts with a letter and contains letters, digits or underscores.');

export const EnrichmentProfileCreateSchema = z
  .object({
    providerKey: ProviderKeySchema,
    connectionId: z.string().trim().min(1).max(64),
    name: z.string().trim().min(1).max(120),
    entityType: z.string().trim().min(1).max(64),
    /** The fields the profile may ask the provider about. At least one. */
    allowedFields: z.array(EnrichmentFieldSchema).min(1).max(50),
    /** The fields the profile may never write, whatever the provider answers. */
    protectedFields: z.array(EnrichmentFieldSchema).max(50).optional(),
    /** The daily credit ceiling. Zero means no daily limit. */
    dailyQuota: z.number().int().min(0).max(1_000_000).optional(),
    costPerCredit: z.number().min(0).max(1_000_000).optional(),
    cacheTtlSeconds: z.number().int().min(0).max(2_592_000).optional(),
    /** The non-secret provider configuration: the endpoint and the field maps. */
    providerOptions: z.record(z.string().trim().min(1).max(64), z.unknown()).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

export const EnrichmentProfilePatchSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    enabled: z.boolean().optional(),
    allowedFields: z.array(EnrichmentFieldSchema).min(1).max(50).optional(),
    protectedFields: z.array(EnrichmentFieldSchema).max(50).optional(),
    dailyQuota: z.number().int().min(0).max(1_000_000).optional(),
    costPerCredit: z.number().min(0).max(1_000_000).optional(),
    cacheTtlSeconds: z.number().int().min(0).max(2_592_000).optional(),
    providerOptions: z.record(z.string().trim().min(1).max(64), z.unknown()).optional(),
  })
  .strict();

export const EnrichmentPreviewSchema = z
  .object({
    recordId: z.string().trim().min(1).max(64),
  })
  .strict();

export const OutboundPushSchema = z
  .object({
    operationId: z.string().trim().min(1).max(64),
  })
  .strict();

export const RotateSecretSchema = z
  .object({
    kind: z.enum(['api_key', 'client_secret', 'webhook_secret', 'signing_secret']),
    /** The secret itself. It is write-only: no read path ever returns it. */
    value: z.string().min(1).max(8192),
    expiresAt: z.string().trim().max(40).nullish(),
  })
  .strict();
