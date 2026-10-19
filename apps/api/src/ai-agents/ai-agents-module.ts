import type { AclAction } from '@carocrm/acl/types/index.js';

/**
 * Phase 19-AI.2 — the `AIAgents` module descriptor
 * (PLAN_Phase_19_AI_Agents.md §1.1, §4.2, §5, §9, §20 `19-AI.2`).
 *
 * The module is a kernel domain directory under `apps/api/src`, like Projects, Sales, Customer
 * Success, Service Desk and Marketing Automation. Its records do **not** live in `entity_records`:
 * an agent version, a run and an approval are lifecycle data with unique invariants, so they get
 * dedicated additive tables. Everything cross-cutting — ACL, jobs, outbox, audit, stream, settings
 * and the SPA — is the platform's and is reused.
 *
 * The id carries no prefix (`AIAgents`, never `Ua…`). The registry key / route slug is `ai-agents`.
 */

/** A capability is one separable right the module checks on the server. */
export interface AIAgentsCapabilityDefinition {
  readonly key: AIAgentsCapabilityKey;
  readonly label: string;
  readonly description: string;
  /**
   * Synthetic permission resource evaluated through the platform's `AclApiService`. The platform has
   * no arbitrary-permission mechanism, so a module right is addressed as an entity/action pair; a
   * role's `*` entry grants it exactly as it grants every future entity (documented in the audit).
   */
  readonly resource: string;
  readonly action: AclAction;
}

export type AIAgentsCapabilityKey =
  | 'use'
  | 'manageDraft'
  | 'publish'
  | 'lifecycle'
  | 'toolAdmin'
  | 'policyAdmin'
  | 'providerAdmin'
  | 'approval'
  | 'audit'
  | 'usage'
  | 'evaluation';

export const AI_AGENTS_CAPABILITIES: readonly AIAgentsCapabilityDefinition[] = [
  {
    key: 'use',
    label: 'Use agents',
    description: 'See the AI Agents menu, list available agents and start a run.',
    resource: 'AIAgent',
    action: 'read',
  },
  {
    key: 'manageDraft',
    label: 'Manage drafts',
    description: 'Create and edit draft agent definitions and configurations.',
    resource: 'AIAgent',
    action: 'edit',
  },
  {
    key: 'publish',
    label: 'Publish versions',
    description: 'Publish an immutable agent version after validation and evaluation gates.',
    resource: 'AIAgentVersion',
    action: 'edit',
  },
  {
    key: 'lifecycle',
    label: 'Pause, resume and archive',
    description: 'Change an agent lifecycle state without deleting history.',
    resource: 'AIAgentLifecycle',
    action: 'edit',
  },
  {
    key: 'toolAdmin',
    label: 'Tool administration',
    description: 'Enable or disable registered tools and review their effect classes.',
    resource: 'AIAgentTool',
    action: 'edit',
  },
  {
    key: 'policyAdmin',
    label: 'Policy administration',
    description: 'Change module features, run limits, approvals, retention and the kill switch.',
    resource: 'AIAgentPolicy',
    action: 'edit',
  },
  {
    key: 'providerAdmin',
    label: 'Provider administration',
    description: 'Configure model providers, their model allowlists and encrypted credentials.',
    resource: 'AIAgentProvider',
    action: 'edit',
  },
  {
    key: 'approval',
    label: 'Review approvals',
    description: 'Review the approval inbox and approve or reject a proposed action.',
    resource: 'AIAgentApproval',
    action: 'edit',
  },
  {
    key: 'audit',
    label: 'View audit and timelines',
    description: 'Read run timelines and audit entries with their redaction rules.',
    resource: 'AIAgentAudit',
    action: 'read',
  },
  {
    key: 'usage',
    label: 'View usage and cost',
    description: 'Read usage ledgers, quotas and cost reports.',
    resource: 'AIAgentUsage',
    action: 'read',
  },
  {
    key: 'evaluation',
    label: 'Manage evaluations',
    description: 'Manage evaluation suites, cases, runs and publication thresholds.',
    resource: 'AIAgentEvaluation',
    action: 'edit',
  },
];

/** Lifecycle vocabulary from §5.2. A published version is immutable; the definition moves state. */
export const AGENT_STATUSES = ['draft', 'published', 'paused', 'archived'] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

/** Run states from §8.2. Every terminal state is explicit; none may transition again. */
export const RUN_STATUSES = [
  'queued',
  'running',
  'waiting_for_approval',
  'waiting_for_input',
  'retry_wait',
  'cancel_requested',
  'succeeded',
  'partially_succeeded',
  'failed',
  'canceled',
  'expired',
  'blocked_by_policy',
  'outcome_unknown',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set([
  'succeeded',
  'partially_succeeded',
  'failed',
  'canceled',
  'expired',
  'blocked_by_policy',
  'outcome_unknown',
]);

export const RUN_TRIGGERS = ['manual', 'record', 'event', 'schedule', 'integration'] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];

/** Effect classes from §9.1. The class drives the default approval requirement. */
export const EFFECT_CLASSES = ['read', 'low_write', 'material_write', 'high_impact'] as const;
export type EffectClass = (typeof EFFECT_CLASSES)[number];

/**
 * Default approval matrix. `read` and `low_write` may run automatically **within ACL and only when
 * granted**; material and high-impact writes require a human decision. Phase 19-AI.10 implements
 * the approval service that consumes this matrix.
 */
export const DEFAULT_APPROVAL_MATRIX: Readonly<Record<EffectClass, boolean>> = {
  read: false,
  low_write: false,
  material_write: true,
  high_impact: true,
};

/** Data classes a provider connection may be approved for (§6.2, §11.4). */
export const DATA_CLASSES = ['public', 'internal', 'confidential', 'restricted'] as const;
export type DataClass = (typeof DATA_CLASSES)[number];

export type PlatformEvidenceKind = 'entity' | 'table' | 'column' | 'hookPhase';

export interface PlatformEvidence {
  readonly kind: PlatformEvidenceKind;
  readonly value: string;
}

export interface AIAgentsPlatformCapability {
  readonly id: string;
  readonly label: string;
  readonly evidence: readonly PlatformEvidence[];
}

/**
 * Required platform capabilities — read from the running system by the health service, never
 * hard-coded `true`. The module owns no queue, ACL, audit trail or settings store of its own
 * (AGENTS.md §5.1–§5.2).
 */
export const REQUIRED_CAPABILITIES: readonly AIAgentsPlatformCapability[] = [
  {
    id: 'database',
    label: 'PostgreSQL and the Kysely access layer',
    evidence: [{ kind: 'table', value: 'entity_records' }],
  },
  {
    id: 'acl',
    label: 'ACL (roles, field permissions, record scope)',
    evidence: [
      { kind: 'table', value: 'roles' },
      { kind: 'table', value: 'users_roles' },
      { kind: 'column', value: 'roles.field_permissions' },
    ],
  },
  {
    id: 'jobs',
    label: 'Durable jobs and scheduling',
    evidence: [
      { kind: 'table', value: 'jobs' },
      { kind: 'table', value: 'scheduled_jobs' },
      { kind: 'table', value: 'job_logs' },
    ],
  },
  {
    id: 'domain-events',
    label: 'Transactional outbox and domain events',
    evidence: [{ kind: 'table', value: 'outbox_events' }],
  },
  {
    id: 'audit-stream',
    label: 'Audit log and stream',
    evidence: [
      { kind: 'table', value: 'audit_log' },
      { kind: 'table', value: 'stream_items' },
    ],
  },
  {
    id: 'settings',
    label: 'Instance settings store',
    evidence: [{ kind: 'table', value: 'app_settings' }],
  },
  {
    id: 'hooks',
    label: 'Hook registry',
    evidence: [
      { kind: 'hookPhase', value: 'beforeSave' },
      { kind: 'hookPhase', value: 'afterSave' },
    ],
  },
];

/** Optional integrations (§13). Detected by metadata/table markers, never by imports. */
export interface AIAgentsOptionalIntegration {
  readonly id: string;
  readonly label: string;
  readonly provides: string;
  readonly markerEntity: string;
  readonly markerTable?: string;
}

export const OPTIONAL_INTEGRATIONS: readonly AIAgentsOptionalIntegration[] = [
  {
    id: 'sales',
    label: 'Sales',
    provides: 'Authorized quote/order/invoice summaries and approval-gated financial drafts (AI.15).',
    markerEntity: 'Opportunity',
  },
  {
    id: 'customer-success',
    label: 'Customer Success',
    provides: 'Health, risk, renewal and success-plan context through its public services (AI.16).',
    markerEntity: 'CustomerSuccessProfile',
  },
  {
    id: 'service-desk',
    label: 'Service Desk',
    provides: 'Case, SLA and conversation summaries with internal-note boundaries (AI.16).',
    markerEntity: 'Case',
  },
  {
    id: 'marketing-automation',
    label: 'Marketing Automation',
    provides: 'Campaign aggregates and draft proposals; consent and dispatch stay there (AI.17).',
    markerEntity: 'Campaign',
  },
  {
    id: 'projects',
    label: 'Projects',
    provides: 'Project status, milestones and blockers (AI.16).',
    markerEntity: 'Project',
  },
  {
    id: 'portal',
    label: 'Portal',
    provides: 'A separate customer-facing agent classification with portal-scoped tools (AI.17).',
    markerEntity: '',
    markerTable: 'portals',
  },
];

export interface AIAgentsFeatureDescriptor {
  readonly key: string;
  readonly label: string;
  readonly settingsPath: string;
  readonly requires: readonly string[];
}

/**
 * Feature flags. Execution is **off by default** (§19.2): migrations and the module ship disabled,
 * and an administrator enables read-only runs first. Definitions stay available so an instance can
 * be prepared before execution is switched on.
 */
export const AI_AGENTS_FEATURES: readonly AIAgentsFeatureDescriptor[] = [
  { key: 'definitions', label: 'Agent definitions and versions', settingsPath: 'features.definitions', requires: [] },
  { key: 'execution', label: 'Agent execution', settingsPath: 'features.execution', requires: ['definitions'] },
  { key: 'memory', label: 'Conversation and long-term memory', settingsPath: 'features.memory', requires: ['execution'] },
  { key: 'evaluations', label: 'Evaluation suites and publication gates', settingsPath: 'features.evaluations', requires: ['definitions'] },
  { key: 'eventTriggers', label: 'Event-triggered runs', settingsPath: 'features.eventTriggers', requires: ['execution'] },
  { key: 'scheduledTriggers', label: 'Scheduled runs', settingsPath: 'features.scheduledTriggers', requires: ['execution'] },
  { key: 'portalAssistant', label: 'Customer-facing portal assistant', settingsPath: 'features.portalAssistant', requires: ['execution'] },
];

/** Module-owned structures the health endpoint verifies. Migration 045 creates them. */
export const AI_AGENTS_TABLES = [
  'ai_agents',
  'ai_agent_versions',
  'ai_agent_tool_grants',
  'ai_agent_runs',
  'ai_agent_run_events',
  'ai_agent_tool_calls',
  'ai_agent_approvals',
  'ai_agent_conversations',
  'ai_agent_messages',
  'ai_agent_memory_items',
  'ai_agent_provider_requests',
  'ai_agent_budget_policies',
  'ai_agent_pricing_snapshots',
  'ai_agent_eval_suites',
  'ai_agent_eval_cases',
  'ai_agent_eval_runs',
  'ai_provider_connections',
] as const;

export const AI_AGENTS_MODULE = {
  id: 'AIAgents',
  name: 'AI Agents',
  version: '1.0.0',
  minPlatformVersion: '1.0.0',
  /** Kernel module directories load in order; AI Agents runs after Marketing Automation (`380`). */
  loadOrder: 390,
  /** API prefix owned by the module's domain commands. */
  apiPrefix: '/api/v1/AIAgents',
  /** Frontend route of the human-facing surface. */
  frontendRoute: '/ai-agents',
  /** Sub-phases delivered so far. */
  implementedPhases: [
    '19-AI.0',
    '19-AI.1',
    '19-AI.2',
    '19-AI.3',
    '19-AI.4',
    '19-AI.5',
    '19-AI.6',
    '19-AI.7',
    '19-AI.8',
    '19-AI.9',
    '19-AI.10',
    '19-AI.11',
    '19-AI.12',
    '19-AI.13',
    '19-AI.14',
    '19-AI.15',
    '19-AI.16',
    '19-AI.17',
  ],
  /** Tables the module owns; no other module may write them directly. */
  tables: AI_AGENTS_TABLES,
} as const;

export type AIAgentsModuleDescriptor = typeof AI_AGENTS_MODULE;
