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
