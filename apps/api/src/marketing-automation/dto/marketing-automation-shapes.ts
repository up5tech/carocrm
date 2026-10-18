import { z } from "zod";

import {
  AUDIENCE_CATEGORY_CODES,
  CAMPAIGN_COMMANDS,
  CAMPAIGN_PURPOSES,
  CAMPAIGN_STATUSES,
  CONSENT_BASES,
  CONSENT_CHANNELS,
  CONSENT_SOURCES,
  CONSENT_STATUSES,
  PUBLIC_TOKEN_SCOPES,
  SEGMENT_ENTITY_TYPES,
  SUPPRESSION_REASONS,
  SUPPRESSION_SCOPES,
  TARGET_LIST_ENTRY_SOURCES,
} from "../marketing-automation-domain.js";

/**
 * Phase 19-MA.1 – MA.5 — request shapes for the Marketing Automation commands
 * (`/api/v1/MarketingAutomation`, PLAN_Phase_19_Marketing_Automation.md §8.1–§8.4).
 *
 * Entity CRUD stays on the generic `/api/v1/:entity` API, so these shapes cover the module-level commands:
 * settings, the campaign state machine, audience membership and snapshots, consent and suppression, and the
 * public links. Validation happens here at the boundary **and again** in the domain services against stored
 * state, because a client payload is never the authority (§8.4).
 */

/**
 * Zod's `enum` wants a mutable non-empty tuple and the domain vocabulary is a `readonly` const tuple, so
 * every enum below re-types the same list instead of repeating its values — the domain file stays the single
 * source and a status added there cannot be accepted here without existing there (§0.2, AGENTS.md §7).
 */
function enumSchema<T extends string>(values: readonly T[]) {
  return z.enum(values as unknown as [T, ...T[]]);
}

const CampaignStatusSchema = enumSchema(CAMPAIGN_STATUSES);
const CampaignCommandSchema = enumSchema(CAMPAIGN_COMMANDS);
const CampaignPurposeSchema = enumSchema(CAMPAIGN_PURPOSES);
const ConsentStatusSchema = enumSchema(CONSENT_STATUSES);
const ConsentChannelSchema = enumSchema(CONSENT_CHANNELS);
const ConsentBasisSchema = enumSchema(CONSENT_BASES);
const ConsentSourceSchema = enumSchema(CONSENT_SOURCES);
const SuppressionScopeSchema = enumSchema(SUPPRESSION_SCOPES);
const SuppressionReasonSchema = enumSchema(SUPPRESSION_REASONS);
const PublicTokenScopeSchema = enumSchema(PUBLIC_TOKEN_SCOPES);
const SegmentEntityTypeSchema = enumSchema(SEGMENT_ENTITY_TYPES);
const TargetListEntrySourceSchema = enumSchema(TARGET_LIST_ENTRY_SOURCES);
const AudienceCategorySchema = enumSchema(AUDIENCE_CATEGORY_CODES);

export const SettingsPatchSchema = z.record(z.string(), z.unknown());

export type SettingsPatchInput = z.infer<typeof SettingsPatchSchema>;

const IdSchema = z.string().trim().min(1).max(64);
const IdempotencyKeySchema = z.string().trim().min(1).max(128);
const ReasonSchema = z.string().trim().max(2_000);
/** The keyed address identity this platform computes: 64 lowercase hex characters, never free text. */
const HashSchema = z.string().trim().regex(/^[0-9a-f]{64}$/, "An address identity must be a 64-character digest.");

// ---------------------------------------------------------------------------
// Template content commands (19-MA.6, §5.4)
// ---------------------------------------------------------------------------

/**
 * The sample recipient a content preview renders against. `Contact`/`Lead` only: those are the entity
 * types a marketing audience resolves to (§5.2), and the placeholder allowlist reads fields each of
 * them actually carries. Empty body renders without a recipient — every recipient value falls back
 * and the preview says so.
 */
export const ContentPreviewSchema = z
  .object({
    recipientType: SegmentEntityTypeSchema.optional(),
    recipientId: IdSchema.optional(),
  })
  .strict()
  .refine((value) => !(value.recipientId !== undefined && value.recipientType === undefined), {
    message: "Naming a sample recipient needs its entity type.",
  });

export type ContentPreviewInput = z.infer<typeof ContentPreviewSchema>;

/**
 * The safe test-send command (19-MA.7, §8.2, §10.5). Recipients are named explicitly and never default to
 * the campaign's audience; `confirm` is the §10.2 acknowledgement that this message leaves the system. The
 * service still enforces the administrator's allowlist, the confirmation policy and the provider ceiling
 * against stored settings — this shape only carries the caller's intent.
 */
export const TestSendSchema = z
  .object({
    recipients: z.array(z.string().trim().min(3).max(320)).min(1).max(20),
    confirm: z.boolean().default(false),
    recipientType: SegmentEntityTypeSchema.optional(),
    recipientId: IdSchema.optional(),
    idempotencyKey: IdempotencyKeySchema.optional(),
  })
  .strict()
  .refine((value) => !(value.recipientId !== undefined && value.recipientType === undefined), {
    message: "Naming a sample recipient needs its entity type.",
  });

export type TestSendInput = z.infer<typeof TestSendSchema>;

/** Commands that take no options accept an empty (or absent) body and nothing else. */
export const EmptyCommandBodySchema = z.object({}).strict();

export type EmptyCommandBody = z.infer<typeof EmptyCommandBodySchema>;

/**
 * A lifecycle command, optionally with an explicit target status. When both are given they must agree, and
 * the service checks that against the server-side transition model — a client cannot choose a destination
 * state by omitting or renaming a command (§8.2).
 */
export const CampaignTransitionSchema = z
  .object({
    command: CampaignCommandSchema.optional(),
    to: CampaignStatusSchema.optional(),
    reason: ReasonSchema.optional(),
    idempotencyKey: IdempotencyKeySchema.optional(),
    /** Optimistic concurrency: a stale version is refused rather than silently overwritten (§8.4). */
    version: z.number().int().positive().optional(),
  })
  .strict()
  .refine((value) => value.command !== undefined || value.to !== undefined, {
    message: "A campaign transition needs a command or a target status.",
  });

export type CampaignTransitionInput = z.infer<typeof CampaignTransitionSchema>;

/**
 * The body of a **named** command route (`…/schedule`, `…/start`, …). The command is already fixed by the
 * path, so the body carries only what a command may take: a reason, an idempotency key, and the version the
 * caller last read. It deliberately does not accept `command` or `to` — a route that names `pause` must not
 * be talked into `start` by its payload.
 */
export const CampaignCommandBodySchema = z
  .object({
    reason: ReasonSchema.optional(),
    idempotencyKey: IdempotencyKeySchema.optional(),
    version: z.number().int().positive().optional(),
  })
  .strict();

export type CampaignCommandInput = z.infer<typeof CampaignCommandBodySchema>;

/**
 * Duplicate-as-draft (§5.1). `includeAudience` and `includeContent` default to true because a copy of a
 * working campaign is the use case; delivery history, recipient state, live enrollments and provider
 * identifiers are **never** copied and are not options a caller can request.
 */
export const CampaignDuplicateSchema = z
  .object({
    name: z.string().trim().min(1).max(255).optional(),
    code: z.string().trim().max(64).optional(),
    includeAudience: z.boolean().default(true),
    includeContent: z.boolean().default(true),
    idempotencyKey: IdempotencyKeySchema.optional(),
  })
  .strict();

export type CampaignDuplicateInput = z.infer<typeof CampaignDuplicateSchema>;

/**
 * The optional filter on the validation report endpoint: validate as though the campaign were about to
 * become this status, so an operator sees the *scheduling* blockers before pressing schedule.
 */
export const CampaignValidateQuerySchema = z
  .object({
    as: CampaignStatusSchema.optional(),
  })
  .strict();

export type CampaignValidateQuery = z.infer<typeof CampaignValidateQuerySchema>;

/** The global emergency stop (§13) as a named command rather than a settings patch an operator composes. */
export const GlobalSendPauseSchema = z
  .object({
    paused: z.boolean(),
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict()
  .refine((value) => value.paused || value.reason === undefined, {
    message: "A reason is recorded when sending is paused; resuming needs no reason.",
  });

export type GlobalSendPauseInput = z.infer<typeof GlobalSendPauseSchema>;

// ---------------------------------------------------------------------------
// Audience commands (19-MA.4, §5.2)
// ---------------------------------------------------------------------------

/**
 * Static membership. The caller names CRM records by type and id; the service checks that each record
 * exists and that *this* caller may read it, so an audience cannot be populated with records nobody can
 * verify (§9.2).
 */
export const AudienceMembersSchema = z
  .object({
    members: z
      .array(
        z
          .object({
            entityType: SegmentEntityTypeSchema,
            entityId: IdSchema,
          })
          .strict(),
      )
      .min(1)
      .max(500),
    source: TargetListEntrySourceSchema.optional(),
  })
  .strict();

export type AudienceMembersInput = z.infer<typeof AudienceMembersSchema>;

export const AudienceMemberRemoveSchema = z
  .object({
    entityType: SegmentEntityTypeSchema,
    entityId: IdSchema,
    reason: ReasonSchema.optional(),
  })
  .strict();

export type AudienceMemberRemoveInput = z.infer<typeof AudienceMemberRemoveSchema>;

export const AudiencePageQuerySchema = z.object({
  maxSize: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const SnapshotModeSchema = z
  .object({
    // A preview snapshot is explicitly distinguishable from the final one (§5.5), and the default is the
    // conservative choice: nothing is labelled "final" unless the caller says so.
    mode: z.enum(["preview", "final"]).default("preview"),
  })
  .strict();

/** Read-side filter for the suppression list: an address, never a raw digest from a client. */
export const SuppressionListQuerySchema = z
  .object({
    emailAddress: z.string().trim().max(320).optional(),
  })
  .strict();

export const SnapshotEntriesQuerySchema = z.object({
  category: AudienceCategorySchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

// ---------------------------------------------------------------------------
// Consent and suppression commands (19-MA.5, §5.3)
// ---------------------------------------------------------------------------

/**
 * Recording a consent decision. `emailAddress` and `emailHash` are alternatives: an external import knows
 * the address, a preference page holds only the digest. Both are refused together rather than silently
 * preferring one, because the two can name different people.
 */
export const ConsentRecordSchema = z
  .object({
    emailAddress: z.string().trim().max(320).optional(),
    emailHash: HashSchema.optional(),
    channel: ConsentChannelSchema.default("Email"),
    purpose: CampaignPurposeSchema,
    to: ConsentStatusSchema,
    basis: ConsentBasisSchema.optional(),
    source: ConsentSourceSchema,
    reason: ReasonSchema.optional(),
    policyVersion: z.string().trim().max(64).optional(),
    locale: z.string().trim().max(16).optional(),
    captureContext: z.string().trim().max(255).optional(),
    campaignId: IdSchema.optional(),
    targetListId: IdSchema.optional(),
    contactId: IdSchema.optional(),
    leadId: IdSchema.optional(),
    idempotencyKey: IdempotencyKeySchema.optional(),
  })
  .strict()
  .refine((value) => !(value.emailAddress !== undefined && value.emailHash !== undefined), {
    message: "Give an email address or its identity, not both.",
  });

export type ConsentRecordInput = z.infer<typeof ConsentRecordSchema>;

export const SuppressionAddSchema = z
  .object({
    emailAddress: z.string().trim().max(320).optional(),
    emailHash: HashSchema.optional(),
    channel: ConsentChannelSchema.default("Email"),
    scope: SuppressionScopeSchema,
    purpose: CampaignPurposeSchema.optional(),
    targetListId: IdSchema.optional(),
    reason: SuppressionReasonSchema,
    source: ConsentSourceSchema.optional(),
    note: z.string().trim().max(2_000).optional(),
  })
  .strict()
  .refine((value) => !(value.emailAddress !== undefined && value.emailHash !== undefined), {
    message: "Give an email address or its identity, not both.",
  });

export type SuppressionAddInput = z.infer<typeof SuppressionAddSchema>;

export const SuppressionRevokeSchema = z
  .object({
    reason: z.string().trim().min(1).max(2_000),
  })
  .strict();

/** Issuing a public link is a privileged act: the link is a credential for one address. */
export const PublicLinkIssueSchema = z
  .object({
    scope: PublicTokenScopeSchema,
    emailAddress: z.string().trim().max(320).optional(),
    emailHash: HashSchema.optional(),
    channel: ConsentChannelSchema.default("Email"),
    purpose: CampaignPurposeSchema.optional(),
    campaignId: IdSchema.optional(),
    targetListId: IdSchema.optional(),
  })
  .strict()
  .refine((value) => !(value.emailAddress !== undefined && value.emailHash !== undefined), {
    message: "Give an email address or its identity, not both.",
  });

export type PublicLinkIssueInput = z.infer<typeof PublicLinkIssueSchema>;

/** The public form body. `all` is the deliberate "unsubscribe from everything" choice (§5.3.2). */
export const PublicUnsubscribeSchema = z
  .object({
    all: z.boolean().default(false),
  })
  .strict();

export type PublicUnsubscribeInput = z.infer<typeof PublicUnsubscribeSchema>;
