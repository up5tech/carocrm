/**
 * Phase 19-MA.1 — the `MarketingAutomation` module descriptor
 * (PLAN_Phase_19_Marketing_Automation.md §0.1–§0.2, §4.3, §7.1, §15 `19-MA.1`).
 *
 * Like Projects, Sales, Customer Success and Service Desk, Marketing Automation is a kernel domain
 * directory under `apps/api/src`, not an installable extension package: its records use the generic
 * `entity_records` store, and ACL, validation, audit, stream, hooks, jobs, search and reporting are the
 * platform's and are reused rather than re-implemented (AGENTS.md §5.1–§5.2).
 *
 * The id carries **no prefix** (`MarketingAutomation`, never `Ua…`). Names are the documented product
 * concepts, not parallel inventions: the canonical campaign record is `Campaign` and the audience record
 * is `TargetList`, exactly as `PLAN_Phase_19_Marketing_Automation.md` §0.2 and the audit
 * (`docs/implementation/marketing-automation-audit.md` §3) decide, so a second "marketing" table for the
 * same fact can never appear beside them.
 *
 * This file is the module's identity and the single source the health endpoint reads: the platform
 * capabilities it builds on (each proven by a fact about the running system), the optional modules it can
 * talk to (each detected by a metadata marker, never an import — §4.3), and its feature flags with the
 * settings path that controls each.
 */

export interface MarketingAutomationFeatureDescriptor {
  readonly key: string;
  readonly label: string;
  /** Dotted path inside the `marketingAutomation` settings row. */
  readonly settingsPath: string;
  /** Feature keys that must also be enabled for this one to do anything. */
  readonly requires: readonly string[];
  /** Optional platform capability this feature depends on, if any. */
  readonly requiresIntegration?: string;
}

export interface MarketingAutomationOptionalIntegration {
  readonly id: string;
  readonly label: string;
  readonly provides: string;
  /**
   * Metadata marker the optional module registers; detection reads the registry, never an import (§4.3).
   * Mutually exclusive with `markerTable` — a few platform domains persist a table instead of an entity.
   */
  readonly markerEntity: string;
  /** Physical table the optional module owns, for a domain that has no metadata marker. */
  readonly markerTable?: string;
}

export type PlatformEvidenceKind = "entity" | "table" | "column" | "hookPhase";

export interface PlatformEvidence {
  readonly kind: PlatformEvidenceKind;
  readonly value: string;
}

export interface MarketingAutomationPlatformCapability {
  readonly id: string;
  readonly label: string;
  readonly evidence: readonly PlatformEvidence[];
}

/**
 * Required platform capabilities. Marketing Automation deliberately owns **no** email engine, queue,
 * scheduler, expression language, workflow engine or database of its own (audit §2.3, §2.5, §7), so each
 * entry below is a piece of the kernel this module cannot function without — and the health endpoint
 * reports each one present or missing from the running system, never hard-coded `true`.
 *
 * `query-engine`, `documents` and `portal` are deliberately **not** listed: they belong to capabilities
 * delivered in later sub-phases, and §15 `19-MA.1` task 2 asks for dependency metadata naming only what
 * is actually required today.
 */
export const REQUIRED_CAPABILITIES: readonly MarketingAutomationPlatformCapability[] = [
  {
    id: "entity-engine",
    label: "Entity Engine (metadata-driven records)",
    evidence: [
      { kind: "entity", value: "Campaign" },
      { kind: "entity", value: "TargetList" },
      { kind: "table", value: "entity_records" },
    ],
  },
  {
    id: "crm-core-records",
    label: "CRM core records (the audience is CRM data, never a copy of it)",
    evidence: [
      { kind: "entity", value: "Contact" },
      { kind: "entity", value: "Lead" },
      { kind: "entity", value: "Account" },
      { kind: "table", value: "users" },
      { kind: "table", value: "teams" },
    ],
  },
  {
    id: "email-outbound",
    label: "Shared outbound email (transport, accounts, delivery ledger)",
    evidence: [
      { kind: "entity", value: "Email" },
      { kind: "entity", value: "EmailTemplate" },
      { kind: "table", value: "email_deliveries" },
      { kind: "table", value: "email_accounts" },
    ],
  },
  {
    id: "jobs",
    label: "Background jobs and scheduling (required for any send)",
    evidence: [
      { kind: "table", value: "jobs" },
      { kind: "table", value: "scheduled_jobs" },
      { kind: "table", value: "job_logs" },
    ],
  },
  {
    id: "domain-events",
    label: "Transactional outbox and domain events",
    evidence: [{ kind: "table", value: "outbox_events" }],
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
    id: "hooks",
    label: "Hook registry (the write guard that keeps status and server state authoritative)",
    evidence: [
      { kind: "hookPhase", value: "beforeValidate" },
      { kind: "hookPhase", value: "afterSave" },
    ],
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
];

/**
 * Optional integrations (§4.3, §5.13). Each is named by a metadata marker the owning module registers —
 * the module never imports another domain — and the module must load with any of them absent, which is
 * what the health endpoint proves (§15 `19-MA.1` acceptance).
 */
export const OPTIONAL_INTEGRATIONS: readonly MarketingAutomationOptionalIntegration[] = [
  {
    id: "portal",
    label: "Portal",
    provides: "Preference center and self-service consent for portal contacts (MA.5, MA.16)",
    markerEntity: "",
    markerTable: "portals",
  },
  {
    id: "workflow",
    label: "Workflow / BPM",
    provides: "Campaign and consent domain events consumed by generic automation; journey actions reuse the workflow action catalog (MA.14)",
    markerEntity: "",
    markerTable: "workflows",
  },
  {
    id: "sales",
    label: "Sales",
    provides: "Opportunity stage and document signals for lifecycle segments and attribution (MA.16, MA.17)",
    markerEntity: "Opportunity",
  },
  {
    id: "customer-success",
    label: "Customer Success",
    provides: "Lifecycle, goal and renewal context for journey triggers (MA.16)",
    markerEntity: "CustomerSuccessProfile",
  },
  {
    id: "service-desk",
    label: "Service Desk",
    provides: "Support context that must keep marketing sends out of service conversations (MA.16)",
    markerEntity: "Case",
  },
  {
    id: "knowledge-base",
    label: "Knowledge Base",
    provides: "Article links inside campaign content (MA.6)",
    markerEntity: "KnowledgeArticle",
  },
  {
    id: "documents",
    label: "Documents",
    provides: "Rendered PDF/HTML assets attached to campaign content (MA.6)",
    markerEntity: "DocumentTemplate",
  },
];

/**
 * Feature flags. Optional capabilities default **off**: a fresh installation gets campaign management
 * and nothing whose infrastructure lands in a later sub-phase (§15 `19-MA.1`, AGENTS.md §5.5).
 */
export const MARKETING_AUTOMATION_FEATURES: readonly MarketingAutomationFeatureDescriptor[] = [
  { key: "campaigns", label: "Campaign management", settingsPath: "features.campaigns", requires: [] },
  {
    key: "audience",
    label: "Audience segments",
    settingsPath: "features.audience",
    requires: ["campaigns"],
  },
  {
    key: "templates",
    label: "Email templates and content preview",
    settingsPath: "features.templates",
    requires: ["campaigns"],
  },
];

/**
 * Declared features whose infrastructure is delivered by a later sub-phase. Enabling one is honest but
 * inert, and the settings view says so instead of silently doing nothing (the Service Desk precedent).
 */
export const PENDING_FEATURES: readonly { readonly key: string; readonly phase: string }[] = [];

/**
 * The physical structures the send definition depends on (19-MA.8). Migration 041 creates them, and the
 * health endpoint reports whether they are actually present — a send definition that cannot enforce "one
 * delivery record per recipient per slot" is a promise the database is not keeping.
 */
export const SEND_STRUCTURES = {
  tables: ["marketing_recipient_deliveries"],
  indexes: ["uq_entity_records_marketing_send_slot", "uq_marketing_recipient_deliveries_address"],
} as const;

export const MARKETING_AUTOMATION_MODULE = {
  id: "MarketingAutomation",
  name: "Marketing Automation",
  version: "1.0.0",
  minPlatformVersion: "1.0.0",
  /** Kernel module directories load in order; Marketing Automation runs after Service Desk (`360`). */
  loadOrder: 380,
  /** API prefix owned by the module's domain commands; entity CRUD stays on `/api/v1/:entity`. */
  apiPrefix: "/api/v1/MarketingAutomation",
  /** Sub-phases delivered by this module so far. */
  implementedPhases: ["19-MA.0", "19-MA.1", "19-MA.2", "19-MA.3", "19-MA.4", "19-MA.5", "19-MA.6", "19-MA.7", "19-MA.8", "19-MA.9", "19-MA.10", "19-MA.11", "19-MA.12", "19-MA.13", "19-MA.14", "19-MA.15", "19-MA.16", "19-MA.17", "19-MA.18", "19-MA.19"],
  /** The records this module owns. `Email`, `EmailTemplate` and the CRM person records stay platform-owned. */
  entityTypes: [
    "Campaign",
    "TargetList",
    "TargetListEntry",
    "CampaignTransition",
    "MarketingConsent",
    "MarketingConsentEvent",
    "MarketingSuppression",
    "MarketingPublicToken",
    "MarketingAudienceSnapshot",
    "MarketingTemplateRevision",
    "MarketingSend",
    "MarketingSendTransition",
    "MarketingJourney",
    "MarketingJourneyVersion",
    "MarketingJourneyEnrollment",
    "MarketingJourneyStepExecution",
  ],
} as const;

export type MarketingAutomationModuleDescriptor = typeof MARKETING_AUTOMATION_MODULE;
