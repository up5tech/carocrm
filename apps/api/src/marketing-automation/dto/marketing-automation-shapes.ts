import { z } from "zod";

import {
  CAMPAIGN_COMMANDS,
  CAMPAIGN_STATUSES,
  type CampaignCommand,
  type CampaignStatus,
} from "../marketing-automation-domain.js";

/**
 * Phase 19-MA.1/MA.3 — request shapes for the Marketing Automation commands
 * (`/api/v1/MarketingAutomation`, PLAN_Phase_19_Marketing_Automation.md §8.2, §8.4).
 *
 * Entity CRUD stays on the generic `/api/v1/:entity` API, so these shapes cover the module-level commands:
 * settings, the campaign state machine and duplicate-as-draft. Validation happens here at the boundary and
 * **again** in the domain services against stored state, because a client payload is never the authority
 * (§8.4: "commands should be explicit operations with server-side state-transition validation").
 */

export const SettingsPatchSchema = z.record(z.string(), z.unknown());

export type SettingsPatchInput = z.infer<typeof SettingsPatchSchema>;

// The domain vocabulary is a `readonly` const tuple, so the zod enum re-types the same tuple instead of
// re-declaring its values — the domain file stays the single source (§0.2, AGENTS.md §7).
const CampaignStatusSchema = z.enum(CAMPAIGN_STATUSES as unknown as [CampaignStatus, ...CampaignStatus[]]);
const CampaignCommandSchema = z.enum(CAMPAIGN_COMMANDS as unknown as [CampaignCommand, ...CampaignCommand[]]);

const IdempotencyKeySchema = z.string().trim().min(1).max(128);
const ReasonSchema = z.string().trim().max(2_000);

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
