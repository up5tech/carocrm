import { z } from 'zod';

/**
 * Phase 19-AI.4 — request shapes
 * (PLAN_Phase_19_AI_Agents.md §14.4, §20 `19-AI.4`).
 *
 * Every shape is strict: an unknown key is rejected instead of silently ignored. The controller
 * parses shape only; business rules (provider resolution, secret encryption, URL safety, model
 * allowlists) live in the services.
 */

export const PROVIDER_KEY_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;

const ProviderKeySchema = z
  .string()
  .trim()
  .regex(PROVIDER_KEY_PATTERN, 'Provider keys start with a letter and contain lowercase letters, digits or hyphens.');

const ModelNameSchema = z.string().trim().min(1).max(200);

export const ProviderConnectionConfigSchema = z
  .object({
    /**
     * A self-hosted runtime (local Ollama, an on-prem gateway) may be reached over loopback. The
     * service additionally refuses this in production and still requires `https`.
     */
    allowLoopback: z.boolean().default(false),
    /** Optional provider organization/tenant label sent as a header by the adapter. */
    organization: z.string().trim().max(200).optional(),
  })
  .strict();

export const ProviderConnectionCreateSchema = z
  .object({
    /** The connection `kind`; it selects a registered adapter. */
    kind: z.enum(['openai-compatible', 'fake']),
    key: ProviderKeySchema,
    label: z.string().trim().min(1).max(120),
    baseUrl: z.string().trim().min(1).max(500),
    models: z.array(ModelNameSchema).min(1).max(100),
    dataClasses: z
      .array(z.enum(['public', 'internal', 'confidential', 'restricted']))
      .min(1)
      .max(4)
      .default(['public', 'internal']),
    /** Write-only. Never returned by any read path; omitted means no credential. */
    apiKey: z.string().trim().min(1).max(512).optional(),
    config: ProviderConnectionConfigSchema.default({}),
    enabled: z.boolean().default(true),
  })
  .strict();

export const ProviderConnectionPatchSchema = z
  .object({
    label: z.string().trim().min(1).max(120).optional(),
    baseUrl: z.string().trim().min(1).max(500).optional(),
    models: z.array(ModelNameSchema).min(1).max(100).optional(),
    dataClasses: z
      .array(z.enum(['public', 'internal', 'confidential', 'restricted']))
      .min(1)
      .max(4)
      .optional(),
    /** Omit to keep the current secret; `null` clears it. */
    apiKey: z.string().trim().min(1).max(512).nullable().optional(),
    config: ProviderConnectionConfigSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

export const ProviderCheckSchema = z
  .object({
    /** Optional model from the connection's allowlist; defaults to the first one. */
    model: ModelNameSchema.optional(),
    /** A short prompt for the controlled check. Defaults to a fixed one-token probe. */
    prompt: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export const SettingsPatchSchema = z.record(z.string(), z.unknown());

// ---------------------------------------------------------------------------
// 19-AI.5/19-AI.10 — agent definitions, runs and approvals
// ---------------------------------------------------------------------------

export const AGENT_KEY_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;

const AgentKeySchema = z
  .string()
  .trim()
  .regex(AGENT_KEY_PATTERN, 'Agent keys start with a letter and contain lowercase letters, digits or hyphens.');

const VisibilitySchema = z.enum(['private', 'team', 'organization']);
const IconSchema = z.string().trim().regex(/^[a-zA-Z][a-zA-Z0-9-]{0,39}$/, 'Icons use letters, digits and hyphens.');

/** The configuration object is validated by the module's typed schema, not by this shape. */
export const AgentCreateSchema = z
  .object({
    key: AgentKeySchema,
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(1_000).optional(),
    purpose: z.string().trim().max(500).optional(),
    category: z.string().trim().max(80).optional(),
    icon: IconSchema.optional(),
    visibility: VisibilitySchema.default('team'),
    teamId: z.string().trim().min(1).max(120).nullable().optional(),
    config: z.record(z.string(), z.unknown()),
  })
  .strict();

export const AgentUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(1_000).nullable().optional(),
    purpose: z.string().trim().max(500).nullable().optional(),
    category: z.string().trim().max(80).nullable().optional(),
    icon: IconSchema.nullable().optional(),
    visibility: VisibilitySchema.optional(),
    teamId: z.string().trim().min(1).max(120).nullable().optional(),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const AgentPublishSchema = z
  .object({
    note: z.string().trim().max(1_000).optional(),
  })
  .strict();

export const RunCreateSchema = z
  .object({
    input: z
      .object({
        text: z.string().max(4_000).optional(),
        record: z
          .object({
            entity: z.string().trim().min(1).max(120),
            id: z.string().trim().min(1).max(120),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    idempotencyKey: z.string().trim().min(8).max(120).optional(),
  })
  .strict();

export const ApprovalDecisionSchema = z
  .object({
    note: z.string().trim().max(1_000).optional(),
  })
  .strict();

export const EmptyBodySchema = z.object({}).strict();

export type ProviderConnectionCreateInput = z.infer<typeof ProviderConnectionCreateSchema>;
export type ProviderConnectionPatchInput = z.infer<typeof ProviderConnectionPatchSchema>;
export type ProviderCheckInput = z.infer<typeof ProviderCheckSchema>;
export type AgentCreateInput = z.infer<typeof AgentCreateSchema>;
export type AgentUpdateInput = z.infer<typeof AgentUpdateSchema>;
export type RunCreateBody = z.infer<typeof RunCreateSchema>;
export type ApprovalDecisionInput = z.infer<typeof ApprovalDecisionSchema>;
