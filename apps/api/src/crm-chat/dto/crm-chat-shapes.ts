import { z } from 'zod';

import { CRMChatSettingsSchema } from '../crm-chat-settings.service.js';

/**
 * Phase 19-CHAT.2 — request shapes for the module's domain commands
 * (PLAN_Phase_19_CRM_Chat.md §8.5, §17 `19-CHAT.2`).
 *
 * Every shape is **strict**: an unknown key is a 422, not a silently ignored field. Each nested
 * object is derived from the settings schema and made partial, so a patch keeps exactly the
 * constraints a full write has — including every numeric range — instead of restating them here.
 *
 * Chat endpoints are `action/…` commands, so no body schema accepts a record id or an owner from the
 * client: the route names the target and the server derives ownership from the authenticated
 * principal.
 */
export const CRMChatSettingsPatchSchema = z
  .object({
    features: CRMChatSettingsSchema.shape.features.removeDefault().partial().strict().optional(),
    assistant: CRMChatSettingsSchema.shape.assistant.removeDefault().partial().strict().optional(),
    execution: CRMChatSettingsSchema.shape.execution.removeDefault().partial().strict().optional(),
    limits: CRMChatSettingsSchema.shape.limits.removeDefault().partial().strict().optional(),
    retention: CRMChatSettingsSchema.shape.retention.removeDefault().partial().strict().optional(),
    safety: CRMChatSettingsSchema.shape.safety.removeDefault().partial().strict().optional(),
  })
  .strict();

export type CRMChatSettingsPatch = z.infer<typeof CRMChatSettingsPatchSchema>;

/**
 * Phase 19-CHAT.4 — conversation read and mutation shapes (contract §6.2).
 *
 * Query values arrive as strings from the adapter, so the numbers are coerced and then bounded; an
 * out-of-range `maxSize` is a `400` here instead of being silently clamped to something the client did
 * not ask for. The list is `strict()`: a typo in a filter name is an error, not an unfiltered answer.
 */
export const CRMChatConversationListQuerySchema = z
  .object({
    status: z.enum(['active', 'archived', 'all']).default('active'),
    offset: z.coerce.number().int().min(0).max(100_000).default(0),
    maxSize: z.coerce.number().int().min(1).max(50).default(25),
    /**
     * 19-CHAT.14 — free-text search over the caller's own threads (title *and* message bodies).
     * The search is owner-scoped in SQL, so a term can never reach another user's conversation.
     */
    q: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

export type CRMChatConversationListQueryShape = z.infer<typeof CRMChatConversationListQuerySchema>;

export const CRMChatMessageListQuerySchema = z
  .object({
    before: z.coerce.number().int().min(1).optional(),
    maxSize: z.coerce.number().int().min(1).max(100).default(30),
  })
  .strict();

export type CRMChatMessageListQueryShape = z.infer<typeof CRMChatMessageListQuerySchema>;

/** `status` is the only way to archive or reopen; `deleted` is reachable only through `DELETE`. */
export const CRMChatConversationPatchSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    status: z.enum(['active', 'archived']).optional(),
  })
  .strict();

export type CRMChatConversationPatchShape = z.infer<typeof CRMChatConversationPatchSchema>;

/**
 * Phase 19-CHAT.5 — turn submission shapes (contract §8.2).
 *
 * A turn is a single user message submitted to the assistant agent. The server creates or continues
 * a conversation thread, submits the prompt to AIAgents, and returns a turn/run ID for status polling.
 */
export const CRMChatTurnCreateSchema = z
  .object({
    /** User-visible prompt text. Required. */
    prompt: z.string().trim().min(1).max(4_000),
    /** Optional conversation thread to continue; refused if the agent has memory off. */
    conversationId: z.string().trim().min(1).max(120).optional(),
    /** Client-generated idempotency key to prevent duplicate turns on retry. */
    idempotencyKey: z.string().trim().min(8).max(120).optional(),
    /** Optional safe context references (record IDs the user is viewing). */
    contextRefs: z
      .array(
        z.object({
          entity: z.string().trim().min(1).max(120),
          id: z.string().trim().min(1).max(120),
        }).strict(),
      )
      .max(10)
      .optional(),
  })
  .strict();

export type CRMChatTurnCreateShape = z.infer<typeof CRMChatTurnCreateSchema>;

/**
 * Phase 19-CHAT.14 — answer feedback and saved prompt templates (contract §6.3, §6.5).
 *
 * The rating vocabulary is the one the `crm_chat_feedback` check constraint enforces (`up` / `down`),
 * so a value the database would reject is rejected here first, as a 400 with a stable shape.
 *
 * A prompt template is **data**: it is inserted into the composer and submitted like any other
 * message, under the current user's own authorization. Nothing in this shape can select a tool,
 * an entity, a role or a permission.
 */
export const CRMChatFeedbackCreateSchema = z
  .object({
    rating: z.enum(['up', 'down']),
    category: z.string().trim().min(1).max(60).optional(),
    comment: z.string().trim().min(1).max(2000).optional(),
  })
  .strict();

export type CRMChatFeedbackCreateShape = z.infer<typeof CRMChatFeedbackCreateSchema>;

export const CRMChatPromptCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    promptTemplate: z.string().trim().min(1).max(8000),
    description: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export type CRMChatPromptCreateShape = z.infer<typeof CRMChatPromptCreateSchema>;

export const CRMChatPromptPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    promptTemplate: z.string().trim().min(1).max(8000).optional(),
    description: z.string().trim().min(1).max(500).nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

export type CRMChatPromptPatchShape = z.infer<typeof CRMChatPromptPatchSchema>;
