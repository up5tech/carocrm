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

export const SettingsPatchSchema = z.record(z.unknown());

export const ProviderAccountCreateSchema = z
  .object({
    key: Key,
    providerKey: z.string().trim().min(1).max(64),
    label: z.string().trim().min(1).max(128),
    environment: z.enum(["test", "production"]).default("test"),
    enabled: z.boolean().default(false),
    capabilities: z.array(z.enum(CAPABILITIES)).default([]),
    config: z.record(z.unknown()).default({}),
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
    config: z.record(z.unknown()).optional(),
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
