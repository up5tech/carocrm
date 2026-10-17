import { z } from "zod";

import {
  CASE_ASSIGNMENT_STRATEGIES,
  CASE_STATUSES,
  CASE_TRANSITION_COMMANDS,
  type CaseAssignmentStrategy,
  type CaseStatus,
  type CaseTransitionCommand,
} from "../service-desk-domain.js";

/**
 * Phase 19-SD — request shapes for the Service Desk domain commands
 * (`/api/v1/ServiceDesk`, PLAN_Phase_19_ServiceDesk.md §8.2).
 *
 * Entity CRUD stays on the generic `/api/v1/Case` API, so these shapes cover the module-level
 * commands: settings, numbering preview, the case state machine (SD.4) and assignment/routing
 * (SD.5). Validation happens here, at the boundary; the domain services validate the same facts again
 * against stored state, because a client payload is never the authority.
 */

export const SettingsPatchSchema = z.record(z.string(), z.unknown());

export type SettingsPatchInput = z.infer<typeof SettingsPatchSchema>;

const IdSchema = z.string().trim().min(1).max(64);
const IdempotencyKeySchema = z.string().trim().min(1).max(128);
const ReasonSchema = z.string().trim().max(2_000);

// Zod's `enum` wants a mutable tuple; the domain vocabulary is a `readonly` const tuple, so the
// shape is re-typed here as a tuple of the union (keeping the literal type) and never re-declared —
// the service remains the single source of the values.
const CaseStatusSchema = z.enum(CASE_STATUSES as unknown as [CaseStatus, ...CaseStatus[]]);
const CaseCommandSchema = z.enum(CASE_TRANSITION_COMMANDS as unknown as [CaseTransitionCommand, ...CaseTransitionCommand[]]);
const AssignmentStrategySchema = z.enum(CASE_ASSIGNMENT_STRATEGIES as unknown as [CaseAssignmentStrategy, ...CaseAssignmentStrategy[]]);

/**
 * A transition command and/or a target status. At least one is required; when both are given they
 * must agree, which the service checks against the server-side transition model.
 */
export const CaseTransitionSchema = z
  .object({
    command: CaseCommandSchema.optional(),
    to: CaseStatusSchema.optional(),
    reason: ReasonSchema.optional(),
    resolutionCode: z.string().trim().min(1).max(64).optional(),
    resolutionSummary: z.string().trim().min(1).max(8_000).optional(),
    idempotencyKey: IdempotencyKeySchema.optional(),
    /** Optimistic concurrency: a stale version is refused with a conflict rather than overwriting. */
    version: z.number().int().positive().optional(),
  })
  .strict()
  .refine((value) => value.command !== undefined || value.to !== undefined, {
    message: "A transition needs a command or a target status.",
  });

export type CaseTransitionInput = z.infer<typeof CaseTransitionSchema>;

/** Manual or team assignment; a null field explicitly clears that owner. */
export const CaseAssignSchema = z
  .object({
    assignedUserId: IdSchema.nullable().optional(),
    teamId: IdSchema.nullable().optional(),
    queueId: IdSchema.nullable().optional(),
    strategy: AssignmentStrategySchema.optional(),
    reason: ReasonSchema.optional(),
    idempotencyKey: IdempotencyKeySchema.optional(),
    version: z.number().int().positive().optional(),
  })
  .strict();

export type CaseAssignInput = z.infer<typeof CaseAssignSchema>;

/** Evaluate routing rules and apply the resulting decision. */
export const CaseRouteSchema = z
  .object({
    idempotencyKey: IdempotencyKeySchema.optional(),
  })
  .strict();

export type CaseRouteInput = z.infer<typeof CaseRouteSchema>;

/**
 * A conversation entry (§5.4, SD.6). The visibility is *not* a request field: `reply` and `note` fix
 * it, so a caller can never post an "internal note" the customer sees or a hidden "reply". The text
 * may be empty only when an attachment carries the entry, which the service enforces.
 */
export const CaseMessageSchema = z
  .object({
    text: z.string().trim().max(20_000).default(""),
    attachmentIds: z.array(IdSchema).max(50).optional(),
    mentionIds: z.array(IdSchema).max(50).optional(),
    idempotencyKey: IdempotencyKeySchema.optional(),
  })
  .strict();

export type CaseMessageRequest = z.infer<typeof CaseMessageSchema>;

/** Paging for the case timeline. */
export const CaseConversationQuerySchema = z.object({
  maxSize: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export type CaseConversationQuery = z.infer<typeof CaseConversationQuerySchema>;

/** Email-to-Case: process a stored inbound email (§5.5, SD.7). */
export const EmailToCaseSchema = z
  .object({
    emailId: IdSchema,
  })
  .strict();

export type EmailToCaseRequest = z.infer<typeof EmailToCaseSchema>;

/** Outbound email reply to a case (§5.5, SD.7). */
export const CaseEmailReplySchema = z
  .object({
    text: z.string().trim().min(1).max(20_000),
    attachmentIds: z.array(IdSchema).max(50).optional(),
  })
  .strict();

export type CaseEmailReplyRequest = z.infer<typeof CaseEmailReplySchema>;
