import { z } from "zod";

import {
  PROVIDER_CAPABILITIES,
  type ProviderCapability,
  VOICE_CHANNELS,
  type VoiceChannel,
} from "../voice-communications-domain.js";
import {
  CONSENT_BASES,
  CONSENT_SOURCES,
  CONSENT_STATUSES,
  type ConsentBasis,
  type ConsentSource,
  type ConsentStatus,
  SUPPRESSION_REASONS,
  type SuppressionReason,
} from "../voice-consent.service.js";

/**
 * Phase 19-VC.2–19-VC.6 — request shapes for the module's static routes.
 *
 * The controller parses shape only; domain decisions stay in the services (plan §4.2). Every schema
 * is strict, so a typo in a field name is refused instead of silently ignored.
 */

const Key = z
  .string()
  .trim()
  .min(2)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, "Use letters, digits, '_' or '-'.");

// Zod 3's `z.enum` wants a mutable non-empty tuple; the domain constants are readonly `as const`.
const CHANNELS = [...VOICE_CHANNELS] as [VoiceChannel, ...VoiceChannel[]];
const CAPABILITIES = [...PROVIDER_CAPABILITIES] as [ProviderCapability, ...ProviderCapability[]];
const CONSENT_STATUS_VALUES = [...CONSENT_STATUSES] as [ConsentStatus, ...ConsentStatus[]];
const CONSENT_BASIS_VALUES = [...CONSENT_BASES] as [ConsentBasis, ...ConsentBasis[]];
const CONSENT_SOURCE_VALUES = [...CONSENT_SOURCES] as [ConsentSource, ...ConsentSource[]];
const SUPPRESSION_REASON_VALUES = [...SUPPRESSION_REASONS] as [SuppressionReason, ...SuppressionReason[]];

export const SettingsPatchSchema = z.record(z.string(), z.unknown());

export const ProviderAccountCreateSchema = z
  .object({
    key: Key,
    providerKey: z.string().trim().min(1).max(64),
    label: z.string().trim().min(1).max(128),
    environment: z.enum(["test", "production"]).default("test"),
    enabled: z.boolean().default(false),
    capabilities: z.array(z.enum(CAPABILITIES)).default([]),
    config: z.record(z.string(), z.unknown()).prefault({}),
    credential: z.string().min(1).max(4096).optional(),
    webhookSecret: z.string().min(1).max(4096).optional(),
  })
  .strict();

export const ProviderAccountPatchSchema = z
  .object({
    label: z.string().trim().min(1).max(128).optional(),
    environment: z.enum(["test", "production"]).optional(),
    enabled: z.boolean().optional(),
    capabilities: z.array(z.enum(CAPABILITIES)).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    credential: z.string().min(1).max(4096).nullable().optional(),
    webhookSecret: z.string().min(1).max(4096).nullable().optional(),
  })
  .strict();

export const EndpointCreateSchema = z
  .object({
    key: Key,
    channel: z.enum(CHANNELS),
    address: z.string().trim().min(3).max(64),
    country: z.string().trim().length(2).optional(),
    active: z.boolean().default(true),
    teamId: z.string().trim().max(64).nullable().optional(),
  })
  .strict();

export const EndpointStateSchema = z.object({ active: z.boolean() }).strict();
export const AccountStateSchema = z.object({ enabled: z.boolean() }).strict();
export const RevokeSuppressionSchema = z.object({ channel: z.enum(CHANNELS) }).strict();

export const PageQuerySchema = z
  .object({
    status: z.string().trim().max(32).optional(),
    accountKey: z.string().trim().max(64).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

export const ConsentRecordSchema = z
  .object({
    channel: z.enum(CHANNELS),
    address: z.string().trim().min(3).max(64),
    purpose: z.string().trim().min(1).max(64),
    status: z.enum(CONSENT_STATUS_VALUES),
    basis: z.enum(CONSENT_BASIS_VALUES).nullable().optional(),
    source: z.enum(CONSENT_SOURCE_VALUES),
    evidence: z.string().trim().max(2000).nullable().optional(),
    occurredAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

export const SuppressionAddSchema = z
  .object({
    channel: z.enum(CHANNELS),
    address: z.string().trim().min(3).max(64),
    reason: z.enum(SUPPRESSION_REASON_VALUES),
    source: z.enum(CONSENT_SOURCE_VALUES),
  })
  .strict();

export const SuppressionQuerySchema = z
  .object({
    channel: z.enum(CHANNELS).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

export const PolicyEvaluateSchema = z
  .object({
    channel: z.enum(CHANNELS),
    address: z.string().trim().min(3).max(64),
    purpose: z.string().trim().min(1).max(64).optional(),
    accountKey: z.string().trim().max(64).optional(),
    lastInboundAt: z.string().datetime({ offset: true }).nullable().optional(),
    messageLength: z.number().int().min(0).max(100_000).optional(),
    templateKey: z.string().trim().max(128).nullable().optional(),
    templateLanguage: z.string().trim().max(16).optional(),
    templateVariables: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export const ResolvePhoneSchema = z
  .object({
    phone: z.string().trim().min(3).max(64),
    defaultRegion: z.string().trim().length(2).optional(),
    entities: z.array(z.enum(["Contact", "Lead", "Account"])).min(1).max(3).optional(),
  })
  .strict();

export const WorkerProcessSchema = z.object({ eventId: z.string().uuid() }).strict();

/** Phase 19-VC.8 — click-to-call. `idempotencyKey` is client-generated so a double click is one call. */
export const InitiateCallSchema = z
  .object({
    to: z.string().trim().min(3).max(64),
    accountKey: z.string().trim().max(64).optional(),
    endpointKey: z.string().trim().max(64).optional(),
    idempotencyKey: z.string().trim().min(8).max(128),
    relatedEntityType: z.string().trim().max(64).optional(),
    relatedEntityId: z.string().trim().max(64).optional(),
  })
  .strict();

export const CallListQuerySchema = z
  .object({
    state: z.string().trim().max(32).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

export const CallNoteSchema = z.object({ description: z.string().trim().min(1).max(10_000) }).strict();

/**
 * Phase 19-VC.9 — an agent-side control on a live call. The server, not this schema, decides whether
 * the provider can perform it; an unsupported action is a refusal, never a silent success.
 */
export const CallControlSchema = z.object({ action: z.enum(["answer", "hangup"]) }).strict();

export const CallLinkSchema = z
  .object({
    entityType: z.string().trim().min(1).max(64),
    entityId: z.string().trim().min(1).max(64),
  })
  .strict();

/** Phase 19-VC.10 — one outbound message attempt. */
export const SendMessageSchema = z
  .object({
    channel: z.enum(["sms", "mms", "whatsapp"]),
    body: z.string().trim().max(10_000).default(""),
    idempotencyKey: z.string().trim().min(8).max(128),
    accountKey: z.string().trim().max(64).optional(),
    conversationId: z.string().trim().max(64).optional(),
    to: z.string().trim().max(64).optional(),
    purpose: z.string().trim().max(64).optional(),
    mediaAttachmentIds: z.array(z.string().trim().max(64)).max(10).optional(),
    templateKey: z.string().trim().max(128).optional(),
    templateLanguage: z.string().trim().max(16).optional(),
    templateVariables: z.record(z.string(), z.string()).optional(),
    isInternalNote: z.boolean().optional(),
  })
  .strict();

export const ConversationListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

/** Phase 19-VC.11 — a locally recorded WhatsApp template. */
export const WhatsappTemplateSchema = z
  .object({
    templateKey: z.string().trim().min(1).max(128),
    name: z.string().trim().min(1).max(256),
    category: z.string().trim().min(1).max(64),
    language: z.string().trim().min(2).max(16),
    components: z.unknown().optional(),
    status: z.enum(["pending", "approved", "rejected", "disabled"]).default("pending"),
    vendorStatus: z.string().trim().max(64).nullable().optional(),
    rejectionReason: z.string().trim().max(1000).nullable().optional(),
  })
  .strict();

export const WhatsappTemplateStatusSchema = z
  .object({
    status: z.enum(["pending", "approved", "rejected", "disabled"]),
    vendorStatus: z.string().trim().max(64).nullable().optional(),
    rejectionReason: z.string().trim().max(1000).nullable().optional(),
  })
  .strict();

/** Phase 19-VC.12 — inbox queries and conversation actions. */
export const InboxQuerySchema = z
  .object({
    status: z.string().trim().max(32).optional(),
    channel: z.enum(["sms", "mms", "whatsapp"]).optional(),
    assignee: z.string().trim().max(64).optional(),
    includeArchived: z
      .union([z.literal("true"), z.literal("false")])
      .optional()
      .transform((value) => value === "true"),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

export const TimelineQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(100),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

export const ConversationStatusSchema = z
  .object({ status: z.enum(["open", "pending_customer", "pending_internal", "resolved", "closed", "spam"]), reason: z.string().trim().max(500).optional() })
  .strict();

export const ConversationAssignSchema = z
  .object({
    userId: z.string().trim().max(64).nullable().optional(),
    teamId: z.string().trim().max(64).nullable().optional(),
    reason: z.string().trim().max(500).optional(),
  })
  .strict();

export const CaseLinkSchema = z.object({ caseId: z.string().trim().min(1).max(64) }).strict();

export const CaseHandoffSchema = z
  .object({
    subject: z.string().trim().min(1).max(256),
    description: z.string().trim().min(1).max(10_000),
    reason: z.string().trim().max(500).optional(),
  })
  .strict();

/** Phase 19-VC.14 — local service snippets and composer validation. */
export const TemplateUpsertSchema = z
  .object({
    key: z.string().trim().min(2).max(64),
    name: z.string().trim().min(1).max(256),
    channel: z.enum(["sms", "mms", "whatsapp", "any"]),
    body: z.string().min(1).max(10_000),
    active: z.boolean().optional(),
    // 19-OM.12 — per-team visibility and language tag; omitted means shared/language-neutral.
    teamId: z.string().trim().min(1).max(120).nullable().optional(),
    language: z.string().trim().max(20).nullable().optional(),
  })
  .strict();

export const TemplateRenderSchema = z
  .object({ variables: z.record(z.string(), z.string()).prefault({}) })
  .strict();

export const ComposerValidateSchema = z
  .object({ channel: z.enum(["sms", "mms", "whatsapp"]), body: z.string().max(10_000) })
  .strict();

/** Phase 19-VC.15/16 — media and transcription worker/actions. */
export const MediaActionSchema = z.object({ mediaId: z.string().trim().min(1).max(64) }).strict();

export const TranscriptRequestSchema = z.object({ callSessionId: z.string().trim().min(1).max(64) }).strict();

export const TranscriptReviewSchema = z
  .object({ status: z.enum(["approved", "dismissed"]) })
  .strict();

/** Phase 19-VC.17 — CRM panel queries. */
export const PanelQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

export const PanelLinkSchema = z
  .object({ entityType: z.enum(["Account", "Contact", "Lead", "Opportunity", "Case"]), entityId: z.string().trim().min(1).max(64) })
  .strict();
