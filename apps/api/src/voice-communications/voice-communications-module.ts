/**
 * Phase 19-VC.2 — the `VoiceCommunications` module descriptor
 * (`PLAN_Phase_19_Voice_Communications.md` §3.3, §15 `19-VC.2`).
 *
 * Like Sales, Service Desk, Customer Success, Marketing Automation and AI Agents, Voice &
 * Communications is a kernel domain directory under `apps/api/src`, not an installable extension
 * package: CRM records it touches (Contact, Lead, Account, Call, Case) stay metadata entities, and
 * ACL, validation, audit, stream, hooks, jobs and search are the platform's and are reused rather
 * than re-implemented (AGENTS.md §5.1–§5.2).
 *
 * The id carries **no prefix** (`VoiceCommunications`, never `UaVoiceCommunications`, and never a
 * per-vendor module such as `UaTwilio`). Provider adapters are classes inside this module, not
 * modules of their own (§3.3).
 *
 * This file is the module's identity and the single source the health endpoint reads: the platform
 * capabilities it builds on (each proven by a fact about the running system), the optional modules
 * it can talk to (each detected by a metadata marker, never an import — §3.2), and its feature flags
 * with the settings path that controls each.
 */

export interface VoiceFeatureDescriptor {
  readonly key: string;
  readonly label: string;
  /** Dotted path inside the `voiceCommunications` settings row. */
  readonly settingsPath: string;
  /** Feature keys that must also be enabled for this one to do anything. */
  readonly requires: readonly string[];
}

export interface VoiceOptionalIntegration {
  readonly id: string;
  readonly label: string;
  readonly provides: string;
  /** Metadata marker the optional module registers; detection reads the registry, never an import. */
  readonly markerEntity: string;
  /** Physical table the optional module owns, for a domain that has no metadata marker. */
  readonly markerTable?: string;
}

export type VoicePlatformEvidenceKind = "entity" | "table" | "column" | "hookPhase";

export interface VoicePlatformEvidence {
  readonly kind: VoicePlatformEvidenceKind;
  readonly value: string;
}

export interface VoicePlatformCapability {
  readonly id: string;
  readonly label: string;
  readonly evidence: readonly VoicePlatformEvidence[];
}

/**
 * Required platform capabilities. Voice & Communications owns no auth, ACL, audit, queue, event bus
 * or file store of its own (audit §1), so each entry is a piece of the kernel this module cannot
 * function without — reported present or missing from the running system, never hard-coded `true`.
 */
export const REQUIRED_CAPABILITIES: readonly VoicePlatformCapability[] = [
  {
    id: "entity-engine",
    label: "Entity Engine (CRM records the module links to)",
    evidence: [
      { kind: "entity", value: "Contact" },
      { kind: "entity", value: "Lead" },
      { kind: "entity", value: "Account" },
      { kind: "entity", value: "Call" },
      { kind: "table", value: "entity_records" },
    ],
  },
  {
    id: "acl",
    label: "ACL (roles, field permissions, record scope)",
    evidence: [
      { kind: "table", value: "roles" },
      { kind: "table", value: "users_roles" },
      { kind: "column", value: "roles.field_permissions" },
    ],
  },
  {
    id: "jobs",
    label: "Background jobs (durable webhook processing and replay)",
    evidence: [
      { kind: "table", value: "jobs" },
      { kind: "table", value: "job_logs" },
    ],
  },
  {
    id: "domain-events",
    label: "Transactional outbox and domain events",
    evidence: [{ kind: "table", value: "outbox_events" }],
  },
  {
    id: "audit-stream",
    label: "Audit log and stream",
    evidence: [
      { kind: "table", value: "audit_log" },
      { kind: "table", value: "stream_items" },
    ],
  },
  {
    id: "settings",
    label: "Instance settings store",
    evidence: [{ kind: "table", value: "app_settings" }],
  },
  {
    id: "secret-encryption",
    label: "Encrypted secret storage for provider credentials",
    evidence: [{ kind: "column", value: "email_accounts.smtp_password_encrypted" }],
  },
  {
    id: "hooks",
    label: "Hook registry (module write guard)",
    evidence: [
      { kind: "hookPhase", value: "beforeValidate" },
      { kind: "hookPhase", value: "afterSave" },
    ],
  },
];

/**
 * Optional integrations (§3.2). Each is named by a marker the owning module registers — this module
 * never imports another domain — and must load with any of them absent, which the health endpoint
 * proves.
 */
export const OPTIONAL_INTEGRATIONS: readonly VoiceOptionalIntegration[] = [
  {
    id: "service-desk",
    label: "Service Desk",
    provides: "Link a conversation to an existing Case and hand off through the ServiceDesk contract (19-VC.13)",
    markerEntity: "Case",
  },
  {
    id: "marketing-automation",
    label: "Marketing Automation",
    provides: "Email consent/suppression authority; a campaign-triggered voice/SMS send must ask this module's policy service (19-VC.14)",
    markerEntity: "Campaign",
  },
  {
    id: "ai-agents",
    label: "AI Agents",
    provides: "Optional call summaries, topic extraction and suggested replies through the existing AI gateway (19-VC.16)",
    markerEntity: "AIAgent",
  },
  {
    id: "customer-success",
    label: "Customer Success",
    provides: "Permitted communication touchpoints as engagement signals (19-VC.17)",
    markerEntity: "CustomerSuccessProfile",
  },
  {
    id: "sales",
    label: "Sales",
    provides: "Link calls and conversations to Opportunities, Quotes and Orders through permitted relationships",
    markerEntity: "Opportunity",
  },
  {
    id: "projects",
    label: "Projects",
    provides: "Associate communication records with permitted project records",
    markerEntity: "Project",
  },
  {
    id: "portal",
    label: "Portal",
    provides: "Customer-facing conversation history when portal ACL and channel policy permit it (19-VC.17)",
    markerEntity: "",
    markerTable: "portals",
  },
];

/**
 * Feature flags. Every optional capability defaults **off**: a fresh installation records provider
 * configuration and nothing else. Enabling a feature whose infrastructure lands in a later
 * sub-phase is honest but inert, and the settings view says so (`PENDING_FEATURES`).
 */
export const VOICE_FEATURES: readonly VoiceFeatureDescriptor[] = [
  { key: "voice", label: "Voice calls (click-to-call, call events)", settingsPath: "features.voice", requires: [] },
  { key: "sms", label: "SMS messaging", settingsPath: "features.sms", requires: [] },
  { key: "mms", label: "MMS messaging", settingsPath: "features.mms", requires: ["sms"] },
  { key: "whatsapp", label: "WhatsApp Business messaging", settingsPath: "features.whatsapp", requires: [] },
  { key: "recordings", label: "Call recordings", settingsPath: "features.recordings", requires: ["voice"] },
  { key: "transcripts", label: "Call transcripts", settingsPath: "features.transcripts", requires: ["recordings"] },
  { key: "aiEnrichment", label: "AI summaries and suggested replies", settingsPath: "features.aiEnrichment", requires: [] },
];

/**
 * Features whose infrastructure is delivered by a later sub-phase. The settings view reports them as
 * pending instead of letting an operator believe enabling them does something.
 */
export const PENDING_FEATURES: readonly { readonly key: string; readonly phase: string }[] = [
  { key: "voice", phase: "19-VC.7–19-VC.9" },
  { key: "sms", phase: "19-VC.10" },
  { key: "mms", phase: "19-VC.10" },
  { key: "whatsapp", phase: "19-VC.11" },
  { key: "recordings", phase: "19-VC.15" },
  { key: "transcripts", phase: "19-VC.16" },
  { key: "aiEnrichment", phase: "19-VC.16" },
];

/** The physical structures the module's own contract depends on (migration 051). */
export const VOICE_STRUCTURES = {
  tables: [
    "voice_provider_accounts",
    "voice_endpoints",
    "voice_webhook_events",
    "voice_communication_events",
    "voice_call_sessions",
    "voice_conversations",
    "voice_conversation_participants",
    "voice_messages",
    "voice_media",
    "voice_consent_events",
    "voice_suppressions",
  ],
  indexes: [
    "uq_voice_webhook_events_dedup",
    "uq_voice_communication_events_receipt",
    "uq_voice_call_sessions_provider_call",
    "uq_voice_messages_provider_message",
  ],
} as const;

export const VOICE_COMMUNICATIONS_MODULE = {
  id: "VoiceCommunications",
  name: "Voice & Communications",
  version: "1.0.0",
  minPlatformVersion: "1.0.0",
  /** Kernel module directories load in order; Voice runs after AI Agents (`390`). */
  loadOrder: 390,
  /** API prefix owned by the module's domain commands; entity CRUD stays on `/api/v1/:entity`. */
  apiPrefix: "/api/v1/VoiceCommunications",
  /** Provider webhook prefix (§11.4). Provider keys are routing identifiers, never secrets. */
  webhookPrefix: "/api/v1/integrations/voice-communications",
  /** Frontend slug (§3.3). */
  slug: "voice-communications",
  /** Sub-phases delivered by this module so far. */
  implementedPhases: ["19-VC.0", "19-VC.1", "19-VC.2", "19-VC.3", "19-VC.4", "19-VC.5", "19-VC.6"],
  /**
   * Metadata entities this module owns. Empty on purpose: the CRM records it links to are the
   * platform's (`Contact`, `Lead`, `Account`, `Call`, `Case`), and its own communication data lives
   * in the dedicated tables below because its lifecycle and volume differ from a metadata record
   * (audit §6). No entity is duplicated to make the menu look populated.
   */
  entityTypes: [] as const,
  /** The tables migration 051 creates and this module owns. */
  ownedTables: VOICE_STRUCTURES.tables,
} as const;

export type VoiceCommunicationsModuleDescriptor = typeof VOICE_COMMUNICATIONS_MODULE;
