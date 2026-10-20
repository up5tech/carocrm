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
