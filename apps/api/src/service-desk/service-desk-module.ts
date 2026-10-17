/**
 * Phase 19-SD.1 — the `ServiceDesk` module descriptor
 * (PLAN_Phase_19_ServiceDesk.md §7.1, `19-SD.1`).
 *
 * Like Projects, Sales and Customer Success, Service Desk is a kernel domain directory under
 * `apps/api/src`, not an installable extension package: entity records use the generic
 * `entity_records` store, and ACL, validation, audit, stream, attachments, jobs, search and reporting
 * are the kernel's and are reused rather than re-implemented (AGENTS.md §5.1, §5.2).
 *
 * The module id carries **no prefix** (`ServiceDesk`, never `Ua…` or `Sd`): entity names keep the
 * canonical `Case` name — the exact marker the shipped Customer Success integration already declares
 * for its `service-desk` optional integration, so registering this module flips that integration's
 * report to `available` without touching the Customer Success code.
 *
 * This descriptor is the module's identity and the single source the health endpoint reads: the
 * platform capabilities it builds on, the optional modules it can talk to (each detected by a
 * metadata marker, never an import), and its feature flags with the settings path that controls each.
 */

export interface ServiceDeskFeatureDescriptor {
  readonly key: string;
  readonly label: string;
  /** Dotted path inside the `serviceDesk` settings row. */
  readonly settingsPath: string;
  /** Feature keys that must also be enabled for this one to do anything. */
  readonly requires: readonly string[];
  /** Optional platform capability this feature depends on, if any. */
  readonly requiresIntegration?: string;
}

export interface ServiceDeskOptionalIntegration {
  readonly id: string;
  readonly label: string;
  readonly provides: string;
  /** Metadata marker the optional module registers; detection reads the registry, never an import (§4.3). */
  readonly markerEntity: string;
}

export type PlatformEvidenceKind = "entity" | "table" | "column" | "hookPhase";

export interface PlatformEvidence {
  readonly kind: PlatformEvidenceKind;
  readonly value: string;
}

export interface ServiceDeskPlatformCapability {
  readonly id: string;
  readonly label: string;
  readonly evidence: readonly PlatformEvidence[];
}

/**
 * Capabilities core case management needs. The health endpoint reports each one present/absent from
 * the running platform, so an operator sees *why* the module cannot work rather than a bare failure.
 */
export const REQUIRED_CAPABILITIES: readonly ServiceDeskPlatformCapability[] = [
  {
    id: "entity-engine",
    label: "Entity Engine (metadata-driven records)",
    evidence: [
      { kind: "entity", value: "Case" },
      { kind: "table", value: "entity_records" },
    ],
  },
  {
    id: "crm-core-records",
    label: "CRM core records",
    evidence: [
      { kind: "entity", value: "Account" },
      { kind: "entity", value: "Contact" },
      { kind: "entity", value: "Lead" },
      { kind: "entity", value: "Task" },
      { kind: "table", value: "users" },
      { kind: "table", value: "teams" },
    ],
  },
  {
    id: "acl",
    label: "ACL (roles and field permissions)",
    evidence: [
      { kind: "table", value: "roles" },
      { kind: "table", value: "users_roles" },
      { kind: "column", value: "roles.field_permissions" },
    ],
  },
  {
    id: "hooks",
    label: "Hook registry",
    evidence: [
      { kind: "hookPhase", value: "beforeValidate" },
      { kind: "hookPhase", value: "afterSave" },
    ],
  },
  {
    id: "audit-stream",
    label: "Audit log, stream and outbox",
    evidence: [
      { kind: "table", value: "audit_log" },
      { kind: "table", value: "stream_items" },
      { kind: "table", value: "outbox_events" },
    ],
  },
  {
    id: "jobs",
    label: "Background jobs",
    evidence: [
      { kind: "table", value: "jobs" },
      { kind: "table", value: "scheduled_jobs" },
      { kind: "table", value: "job_logs" },
    ],
  },
  {
    id: "settings",
    label: "Instance settings store",
    evidence: [{ kind: "table", value: "app_settings" }],
  },
  {
    id: "notifications",
    label: "In-app notifications store",
    evidence: [{ kind: "table", value: "notifications" }],
  },
];

/**
 * Optional dependencies. Each is named by a metadata marker the owning module registers; the module
 * never imports another domain module and degrades gracefully when one is absent (§4.3, §5.13).
 */
export const OPTIONAL_INTEGRATIONS: readonly ServiceDeskOptionalIntegration[] = [
  {
    id: "email",
    label: "Email",
    provides: "Email-to-case ingestion and outbound customer replies (SD.7)",
    markerEntity: "Email",
  },
  {
    id: "portal",
    label: "Portal",
    provides: "Customer self-service case access (SD.11)",
    markerEntity: "Portal",
  },
  {
    id: "knowledge-base",
    label: "Knowledge Base",
    provides: "Article suggestions and portal-safe knowledge search (SD.10)",
    markerEntity: "KnowledgeArticle",
  },
  {
    id: "projects",
    label: "Projects",
    provides: "Link a case to delivery work tracked as a project or task",
    markerEntity: "Project",
  },
  {
    id: "customer-success",
    label: "Customer Success",
    provides: "Support-derived risk and health signals (SD.16)",
    markerEntity: "CustomerSuccessProfile",
  },
  {
    id: "workflow",
    label: "Workflow / BPM",
    provides: "Case domain events consumed by workflows and processes (SD.16)",
    markerEntity: "Workflow",
  },
];

/**
 * Feature flags. Every optional capability is off by default: a fresh installation gets a working
 * case desk with numbering, CRUD and visibility, and nothing it does not yet have the infrastructure
 * for (AGENTS.md §5.5, PLAN §17 "module disablement must not break core").
 */
export const SERVICE_DESK_FEATURES: readonly ServiceDeskFeatureDescriptor[] = [
  { key: "caseManagement", label: "Case management", settingsPath: "features.caseManagement", requires: [] },
  { key: "queues", label: "Queues and routing", settingsPath: "features.queues", requires: [] },
  { key: "sla", label: "SLA policies and clocks", settingsPath: "features.sla", requires: [] },
  { key: "notifications", label: "Case notifications", settingsPath: "features.notifications", requires: [] },
  { key: "emailToCase", label: "Email-to-case", settingsPath: "features.emailToCase", requires: ["caseManagement"], requiresIntegration: "email" },
  { key: "portal", label: "Customer portal access", settingsPath: "features.portal", requires: ["caseManagement"], requiresIntegration: "portal" },
  { key: "knowledgeBase", label: "Knowledge base", settingsPath: "features.knowledgeBase", requires: ["caseManagement"], requiresIntegration: "knowledge-base" },
  { key: "csat", label: "Customer satisfaction surveys", settingsPath: "features.csat", requires: ["caseManagement"] },
];

export const SERVICE_DESK_MODULE = {
  id: "ServiceDesk",
  name: "Service Desk",
  version: "1.0.0",
  minPlatformVersion: "1.0.0",
  /** Kernel module directories load in order; Service Desk runs after Customer Success (`340`). */
  loadOrder: 360,
  apiPrefix: "/api/v1/ServiceDesk",
  /** Sub-phases delivered by this module so far. */
  implementedPhases: ["19-SD.0", "19-SD.1", "19-SD.2", "19-SD.3", "19-SD.4", "19-SD.5", "19-SD.6", "19-SD.7", "19-SD.8", "19-SD.9", "19-SD.10", "19-SD.11", "19-SD.12", "19-SD.13", "19-SD.14", "19-SD.15", "19-SD.16", "19-SD.17", "19-SD.18"],
  /** The canonical support-case entity and the configuration/history records this module owns. */
  entityTypes: ["Case", "CaseQueue", "QueueMember", "RoutingRule", "CaseTransition", "CaseAssignment"],
} as const;

export type ServiceDeskModuleDescriptor = typeof SERVICE_DESK_MODULE;
