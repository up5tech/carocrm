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
