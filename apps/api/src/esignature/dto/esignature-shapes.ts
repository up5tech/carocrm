import { z } from 'zod';

/**
 * Phase 19-ES.1 — request shapes (`PLAN_Phase_19_ESignature.md` §8; AGENTS.md §5.4).
 *
 * Every shape is strict: an unknown key is rejected instead of silently ignored, so a typo in a
 * feature name cannot be stored and quietly do nothing. The controller parses shape only; policy
 * lives in the settings service and the connection gate.
 *
 * No shape here can carry a credential. A provider secret has no settings field and no route in
 * this module — it reaches the encrypted vault through ES.4's connection commands only (plan §4.1).
 */

/**
 * The settings patch: an object of any shape, whose *fields* are enforced by
 * `ESignatureSettingsSchema` in the settings service — that service, not this file, is where an
 * unknown key is refused and a secret-shaped value is rejected.
 */
export const SettingsPatchSchema = z.record(z.string(), z.unknown());

/** The operation the caller asks the gate to admit, as a probe of the security contract. */
export const OperationProbeSchema = z
  .object({
    operation: z.enum([
      'testConnection',
      'listTemplates',
      'templateDetails',
      'prepareEnvelope',
      'sendEnvelope',
      'envelopeStatus',
      'listRecipients',
      'recipientView',
      'resendNotifications',
      'voidEnvelope',
      'correctEnvelope',
      'downloadCompletedDocuments',
      'downloadCompletionEvidence',
      'reconcile',
    ]),
  })
  .strict();

// ---------------------------------------------------------------------------
// Phase 19-ES.4 — the connection commands (plan §8.1)
// ---------------------------------------------------------------------------

/**
 * A connection's name, environment and public client id.
 *
 * `environment` has no default: guessing demo versus production is plan §9.4's incident. The client
 * **secret** is not on this shape — it is its own write-only field, because a shape that carries both
 * eventually gets logged as one object.
 */
const EnvironmentSchema = z.enum(['demo', 'production']);

export const ConnectionCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    environment: EnvironmentSchema,
    /** Written straight to the vault. Never read back, never echoed, never logged (plan §4.1). */
    clientSecret: z.string().min(1).max(512),
    /** A public OAuth integration key. Optional: the settings document may already hold it. */
    oauthClientId: z.string().trim().max(128).optional(),
    redirectUri: z.string().trim().max(500).optional(),
    connectReference: z.string().trim().max(120).optional(),
  })
  .strict();

export const ConnectionUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    redirectUri: z.string().trim().max(500).optional(),
    connectReference: z.string().trim().max(120).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'At least one field is required.' });

/**
 * The credential a connection holds.
 *
 * The kind list is deliberately narrower than the vault's: an access or refresh token is produced by
 * the OAuth flow, so accepting one from a request would let an operator paste a token into a
 * connection that has never been authorized (plan §9.2).
 */
export const ConnectionSecretSchema = z
  .object({
    kind: z.enum(['client_secret', 'webhook_secret']),
    value: z.string().min(1).max(512),
  })
  .strict();

/** An authorization request may narrow the scopes; it cannot widen them past the allowlist. */
export const ConnectionAuthorizeSchema = z
  .object({
    scopes: z.array(z.string().trim().min(1).max(40)).max(5).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Phase 19-ES.6 — signature request drafts (plan §8.2)
// ---------------------------------------------------------------------------

/** An entity id from the metadata registry, e.g. "Account" — never a table name. */
const SourceEntitySchema = z.string().trim().regex(/^[A-Z][A-Za-z0-9]*$/, 'A source entity is named by its metadata entity id, e.g. "Quote".');
const NullableText = (max: number) => z.string().trim().max(max).nullable();

export const RequestCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2_000).optional(),
    subject: z.string().trim().max(300).optional(),
    message: z.string().trim().max(5_000).optional(),
    emailBlurb: z.string().trim().max(2_000).optional(),
    /** ISO instant. A bare date is not an instant, so the caller cannot silently change the timezone. */
    expiresAt: z.string().datetime({ offset: true }).optional(),
    connectionId: z.string().trim().max(64).optional(),
    templateMappingId: z.string().trim().max(64).optional(),
    sourceEntityType: SourceEntitySchema.optional(),
    sourceRecordId: z.string().trim().min(1).max(64).optional(),
    approvalRequired: z.boolean().optional(),
  })
  .strict();

/**
 * A draft edit.
 *
 * `version` is the optimistic check: two editors must not silently overwrite each other. A
 * server-owned field (status, envelope, timestamps) is refused by the service rather than accepted
 * and ignored, so a caller that believes it can set `status` is told so.
 */
export const RequestUpdateSchema = z
  .object({
    version: z.coerce.number().int().min(1),
    name: z.string().trim().min(1).max(200).optional(),
    description: NullableText(2_000).optional(),
    subject: NullableText(300).optional(),
    message: NullableText(5_000).optional(),
    emailBlurb: NullableText(2_000).optional(),
    expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
    connectionId: z.string().trim().max(64).nullable().optional(),
    templateMappingId: z.string().trim().max(64).nullable().optional(),
    sourceEntityType: SourceEntitySchema.nullable().optional(),
    sourceRecordId: z.string().trim().min(1).max(64).nullable().optional(),
    assignedUserId: z.string().trim().max(64).nullable().optional(),
    teamIds: z.array(z.string().trim().min(1).max(64)).max(50).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).some((key) => key !== 'version'), { message: 'At least one field is required.' });

/** The whole recipient set, replaced at once (a partial edit could leave two signers in one slot). */
export const RequestRecipientsSchema = z
  .object({
    recipients: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(200),
            email: z.string().trim().email().max(320),
            recipientType: z.enum(['signer', 'carbon_copy']).optional(),
            crmContactId: z.string().trim().max(64).nullable().optional(),
            roleName: z.string().trim().max(120).nullable().optional(),
            routingOrder: z.coerce.number().int().min(1).max(100),
            authenticationMethod: z.string().trim().max(120).nullable().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict();

/** The sender's confirmation is a body field because it must be deliberate, not a default. */
export const RequestPrepareSchema = z
  .object({
    version: z.coerce.number().int().min(1),
    confirm: z.boolean(),
  })
  .strict();

/** Creating the provider draft from a prepared request: only the version is the caller's choice. */
export const RequestEnvelopeSchema = z.object({ version: z.coerce.number().int().min(1) }).strict();

/** The deliberate send: version, and the sender's confirmation — which must be deliberate, not defaulted. */
export const RequestSendSchema = z
  .object({
    version: z.coerce.number().int().min(1),
    confirm: z.boolean(),
  })
  .strict();

/** The worker's webhook-processing payload: the durable inbox row, nothing else. */
export const WebhookProcessSchema = z.object({ inboxId: z.string().trim().min(1).max(64) }).strict();

export const RequestDocumentAttachSchema = z
  .object({
    attachmentId: z.string().trim().min(1).max(64),
    documentOrder: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

export const RequestDocumentReplaceSchema = z.object({ attachmentId: z.string().trim().min(1).max(64) }).strict();

/**
 * The list query (plan §13.2).
 *
 * `status` is a comma-separated list because that is what a filter row sends, and it is validated
 * against the module's own status vocabulary in the controller — an unknown status is a bad query, not
 * an empty page.
 */
export const RequestListQuerySchema = z
  .object({
    status: z.string().trim().max(400).optional(),
    sourceEntityType: SourceEntitySchema.optional(),
    sourceRecordId: z.string().trim().max(64).optional(),
    connectionId: z.string().trim().max(64).optional(),
    assignedUserId: z.string().trim().max(64).optional(),
    needsAttention: z.enum(['true', 'false']).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

// ---------------------------------------------------------------------------
// Phase 19-ES.7 — template mappings (plan §6.7, §8.2)
// ---------------------------------------------------------------------------

const RoleMappingSchema = z
  .object({
    roleName: z.string().trim().min(1).max(120),
    recipientType: z.enum(['signer', 'carbon_copy']),
    routingOrder: z.coerce.number().int().min(1).max(99),
    source: z.enum(['crmField', 'manual']),
    crmField: z.string().trim().min(1).max(120).nullable().optional(),
  })
  .strict();

const FieldMappingSchema = z
  .object({
    tabName: z.string().trim().min(1).max(120),
    crmField: z.string().trim().min(1).max(120),
    required: z.boolean(),
    /** The template role the tab belongs to; required by the service when the template names one. */
    roleName: z.string().trim().min(1).max(120).nullable().optional(),
  })
  .strict();

export const TemplateCatalogRefreshSchema = z.object({ connectionId: z.string().trim().min(1).max(64) }).strict();

export const TemplateMappingCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    mappingType: z.enum(['workflow', 'document_type', 'process']).optional(),
    connectionId: z.string().trim().min(1).max(64),
    providerTemplateId: z.string().trim().min(1).max(128),
    supportedSourceEntities: z.array(SourceEntitySchema).min(1).max(30),
    roleMappings: z.array(RoleMappingSchema).min(1).max(20),
    fieldMappings: z.array(FieldMappingSchema).max(100).default([]),
    defaultSubject: z.string().trim().max(300).nullable().optional(),
    defaultMessage: z.string().trim().max(2_000).nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

export const TemplateMappingUpdateSchema = z
  .object({
    version: z.coerce.number().int().min(1),
    name: z.string().trim().min(1).max(160).optional(),
    mappingType: z.enum(['workflow', 'document_type', 'process']).optional(),
    providerTemplateId: z.string().trim().min(1).max(128).optional(),
    supportedSourceEntities: z.array(SourceEntitySchema).min(1).max(30).optional(),
    roleMappings: z.array(RoleMappingSchema).min(1).max(20).optional(),
    fieldMappings: z.array(FieldMappingSchema).max(100).optional(),
    defaultSubject: z.string().trim().max(300).nullable().optional(),
    defaultMessage: z.string().trim().max(2_000).nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).some((key) => key !== 'version'), { message: 'At least one field is required.' });

export const TemplateMappingActiveSchema = z.object({ active: z.boolean() }).strict();

/** What DocuSign is allowed to put in the callback query. Anything else is not this platform's answer. */
export const OAuthCallbackQuerySchema = z
  .object({
    state: z.string().min(1).max(512),
    code: z.string().max(4096).optional(),
    error: z.string().max(120).optional(),
    // DocuSign sends a description with a refused consent. It is read for nothing: the answer to the
    // browser is this module's stable message, never the provider's words, which can quote a token.
    error_description: z.string().max(1024).optional(),
  })
  .strict();
