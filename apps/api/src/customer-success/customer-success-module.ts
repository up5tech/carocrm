/**
 * Phase 19-CS.1 — the `CustomerSuccess` module descriptor
 * (PLAN_Phase_19_Customer_Success.md §14, `19-CS.1`).
 *
 * Like Sales and Projects, Customer Success is a kernel domain directory under `apps/api/src`, not an
 * installable extension package: the extension SDK deliberately exposes no entity CRUD facade, so a
 * package that owned `CustomerSuccessProfile` records could only write them with raw SQL, bypassing
 * ACL, validation, audit, stream and domain events (AGENTS.md §5.2).
 *
 * This descriptor is the module's identity: a stable id, a version, the platform capabilities it
 * builds on, the optional modules it can talk to, and its feature flags with the settings path that
 * controls each one. The health endpoint reports all of it, so an operator sees *what* is installed.
 *
 * The module id carries **no prefix** (`CustomerSuccess`, not `cs`); entity names keep the
 * `CustomerSuccess` prefix, and `CustomerSuccessProfile` in particular is the exact marker the
 * shipped Sales integration already declares (§12.8) — hence `SALES_INTEGRATION_MARKER_ENTITY`.
 */

export interface CustomerSuccessFeatureDescriptor {
  readonly key: string;
  readonly label: string;
  /** Dotted path inside the `customerSuccess` settings row. */
  readonly settingsPath: string;
  readonly requires: readonly string[];
}

export interface CustomerSuccessOptionalIntegration {
  readonly id: string;
  readonly label: string;
  readonly provides: string;
  /** Metadata marker the optional module registers; detection reads the registry, never an import. */
  readonly markerEntity: string;
}

export type PlatformEvidenceKind = "entity" | "table" | "column" | "hookPhase";

export interface PlatformEvidence {
  readonly kind: PlatformEvidenceKind;
  readonly value: string;
}

export interface CustomerSuccessPlatformCapability {
  readonly id: string;
  readonly label: string;
  readonly evidence: readonly PlatformEvidence[];
}

/** The exact marker entity `sales-module.ts` already declares for this integration (§12.8). */
export const SALES_INTEGRATION_MARKER_ENTITY = "CustomerSuccessProfile";

export const REQUIRED_CAPABILITIES: readonly CustomerSuccessPlatformCapability[] = [
  {
    id: "entity-engine",
    label: "Entity Engine (metadata-driven records)",
    evidence: [
      { kind: "entity", value: "Account" },
      { kind: "table", value: "entity_records" },
    ],
  },
  {
    id: "crm-core-records",
    label: "CRM core records",
    evidence: [
      { kind: "entity", value: "Account" },
      { kind: "entity", value: "Contact" },
      { kind: "entity", value: "Task" },
      { kind: "entity", value: "Call" },
      { kind: "entity", value: "Meeting" },
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

export const OPTIONAL_INTEGRATIONS: readonly CustomerSuccessOptionalIntegration[] = [
  {
    id: "sales-subscriptions",
    label: "Sales & Subscriptions",
    provides: "Renewal horizon and commercial summary through a detected adapter",
    markerEntity: "Subscription",
  },
  {
    id: "projects",
    label: "Projects",
    provides: "Delivery milestones linked from a success plan or an onboarding step",
    markerEntity: "Project",
  },
  {
    id: "opportunities",
    label: "Opportunities",
    provides: "Renewal opportunity link",
    markerEntity: "Opportunity",
  },
  {
    id: "service-desk",
    label: "Service Desk",
    provides: "Support-derived health signals",
    // Detected from the `Case` entity Service Desk registers (Phase 19-SD). The support-signal
    // adapter reads each account's cases and feeds the `support` health signal (§12.6, 19-SD.16).
    markerEntity: "Case",
  },
  {
    id: "adoption-analytics",
    label: "Adoption analytics",
    provides: "Product-usage adoption signals",
    // No connector exists yet; the adapter contract is documented in §12.7.
    markerEntity: "AdoptionMetric",
  },
];

export const CUSTOMER_SUCCESS_FEATURES: readonly CustomerSuccessFeatureDescriptor[] = [
  { key: "healthScoring", label: "Health scoring", settingsPath: "features.healthScoring", requires: [] },
  { key: "healthHistory", label: "Health history", settingsPath: "features.healthHistory", requires: ["healthScoring"] },
  { key: "successPlans", label: "Success plans", settingsPath: "features.successPlans", requires: [] },
  { key: "goals", label: "Success goals", settingsPath: "features.goals", requires: ["successPlans"] },
  { key: "risks", label: "Risk management", settingsPath: "features.risks", requires: [] },
  { key: "onboarding", label: "Onboarding", settingsPath: "features.onboarding", requires: [] },
  { key: "playbooks", label: "Playbooks", settingsPath: "features.playbooks", requires: [] },
  { key: "reviews", label: "Success reviews", settingsPath: "features.reviews", requires: [] },
  { key: "renewalReadiness", label: "Renewal readiness", settingsPath: "features.renewalReadiness", requires: [] },
  { key: "notifications", label: "In-app notifications", settingsPath: "features.notifications", requires: [] },
  { key: "automation", label: "Playbook automation", settingsPath: "features.automation", requires: ["playbooks"] },
  { key: "adoptionSignal", label: "Adoption signals", settingsPath: "features.adoptionSignal", requires: [] },
];

export const CUSTOMER_SUCCESS_MODULE = {
  id: "CustomerSuccess",
  name: "Customer Success",
  version: "1.0.0",
  minPlatformVersion: "1.0.0",
  /** Kernel module directories load in order; Customer Success runs after Sales (`320`). */
  loadOrder: 340,
  apiPrefix: "/api/v1/CustomerSuccess",
  /** Sub-phases delivered by this module. */
  implementedPhases: [
    "19-CS.0",
    "19-CS.1",
    "19-CS.2",
    "19-CS.3",
    "19-CS.4",
    "19-CS.5",
    "19-CS.6",
    "19-CS.7",
    "19-CS.8",
    "19-CS.9",
    "19-CS.10",
    "19-CS.11",
    "19-CS.13",
    "19-CS.14",
  ],
  /** The entity set this module registers and owns. */
  entityTypes: [
    "CustomerSuccessProfile",
    "CustomerSuccessHealthSnapshot",
    "CustomerSuccessPlan",
    "CustomerSuccessGoal",
    "CustomerSuccessRisk",
    "CustomerSuccessPlaybookTemplate",
    "CustomerSuccessPlaybookRun",
    "CustomerSuccessPlaybookStepRun",
    "CustomerSuccessReview",
  ],
} as const;

export type CustomerSuccessModuleDescriptor = typeof CUSTOMER_SUCCESS_MODULE;
