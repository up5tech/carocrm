import type { AclAction } from '@carocrm/acl/types/index.js';

/**
 * Phase 19-CHAT.2 — the `CRMChat` module descriptor
 * (PLAN_Phase_19_CRM_Chat.md §4.1, §7, §13, §17 `19-CHAT.2`).
 *
 * `CRMChat` is the conversational product experience. It owns conversations, turns, citations,
 * feedback and prompt templates as a *user-facing* surface, and delegates every model call, tool
 * invocation, approval decision and usage record to `AIAgents`. The audit
 * (`docs/modules/crm-chat/repository-audit.md`) proves that delegation is possible without a second
 * runtime, and the contract (`docs/architecture/crm-chat-contract.md`) fixes the boundary.
 *
 * Like the other Phase 19 modules this is a kernel domain directory, not an extension package. It owns
 * exactly three tables — citations, feedback and saved prompts — because conversation and message
 * history stay in `ai_agent_conversations` / `ai_agent_messages` (contract D1).
 *
 * The id carries no prefix (`CRMChat`, never `Ua…`). The registry key / route slug is `crm-chat`.
 */

/** A capability is one separable right the module checks on the server. */
export interface CRMChatCapabilityDefinition {
  readonly key: CRMChatCapabilityKey;
  readonly label: string;
  readonly description: string;
  /**
   * Synthetic permission resource evaluated through the platform's `AclApiService` — the same
   * technique `AIAgents`, Marketing, Service Desk and Advanced Integrations use. A role's `*` entry
   * grants it exactly as it grants every future entity (documented in the audit §7).
   */
  readonly resource: string;
  readonly action: AclAction;
}

export type CRMChatCapabilityKey =
  | 'use'
  | 'manage'
  | 'delete'
  | 'feedback'
  | 'prompts'
  | 'admin';

export const CRM_CHAT_CAPABILITIES: readonly CRMChatCapabilityDefinition[] = [
  {
    key: 'use',
    label: 'Use CRM Chat',
    description: 'See the Chat menu, open the workspace and read the caller’s own conversations.',
    resource: 'CRMChatConversation',
    action: 'read',
  },
  {
    key: 'manage',
    label: 'Manage own conversations',
    description: 'Create, rename and archive conversations owned by the caller.',
    resource: 'CRMChatConversation',
    action: 'edit',
  },
  {
    key: 'delete',
    label: 'Delete own conversations',
    description: 'Delete conversations the caller owns, according to the retention policy.',
    resource: 'CRMChatConversation',
    action: 'delete',
  },
  {
    key: 'feedback',
    label: 'Submit answer feedback',
    description: 'Rate an assistant answer and attach an optional category.',
    resource: 'CRMChatFeedback',
    action: 'edit',
  },
  {
    key: 'prompts',
    label: 'Manage saved prompts',
    description: 'Create and maintain the caller’s own prompt templates; templates are data only.',
    resource: 'CRMChatPrompt',
    action: 'edit',
  },
  {
    key: 'admin',
    label: 'Administer CRM Chat',
    description: 'Read and change Chat feature flags, limits and the default assistant reference.',
    resource: 'CRMChatAdmin',
    action: 'edit',
  },
];

/**
 * Feature flags (§13), each independent so a deployment can open the shell, then reads, then writes.
 *
 * `workspace` is the only flag that defaults to **on**: the shell issues no model call and performs no
 * mutation, and a module that cannot be opened after an upgrade is indistinguishable from a broken
 * one. Everything that spends money or changes CRM data starts **off** and is enabled deliberately.
 */
export interface CRMChatFeatureDescriptor {
  readonly key: CRMChatFeatureKey;
  readonly label: string;
  readonly description: string;
  readonly settingsPath: string;
  readonly requires: readonly CRMChatFeatureKey[];
  readonly defaultEnabled: boolean;
}

export type CRMChatFeatureKey =
  | 'workspace'
  | 'readTools'
  | 'helpRetrieval'
  | 'actionProposals'
  | 'feedback'
  | 'conversationSearch';

export const CRM_CHAT_FEATURES: readonly CRMChatFeatureDescriptor[] = [
  {
    key: 'workspace',
    label: 'Chat workspace',
    description: 'Open the Chat page and read the caller’s own conversation history.',
    settingsPath: 'features.workspace',
    requires: [],
    defaultEnabled: true,
  },
  {
    key: 'readTools',
    label: 'Grounded CRM answers',
    description:
      'Answer from live CRM data through allowlisted read tools. Requires AI Agent execution and conversation memory.',
    settingsPath: 'features.readTools',
    requires: ['workspace'],
    defaultEnabled: false,
  },
  {
    key: 'helpRetrieval',
    label: 'Help article answers',
    description: 'Answer “how do I” questions from published knowledge articles through a read tool.',
    settingsPath: 'features.helpRetrieval',
    requires: ['workspace'],
    defaultEnabled: false,
  },
  {
    key: 'actionProposals',
    label: 'Action proposals',
    description:
      'Propose a write (for example creating a follow-up task) and execute it only after the caller confirms it.',
    settingsPath: 'features.actionProposals',
    requires: ['workspace', 'readTools'],
    defaultEnabled: false,
  },
  {
    key: 'feedback',
    label: 'Answer feedback',
    description: 'Let users rate an answer and attach a category.',
    settingsPath: 'features.feedback',
    requires: ['workspace'],
    defaultEnabled: false,
  },
  {
    key: 'conversationSearch',
    label: 'Conversation search',
    description: 'Search the caller’s own conversation history by text.',
    settingsPath: 'features.conversationSearch',
    requires: ['workspace'],
    defaultEnabled: false,
  },
];

export type PlatformEvidenceKind = 'entity' | 'table' | 'column' | 'hookPhase';

export interface PlatformEvidence {
  readonly kind: PlatformEvidenceKind;
  readonly value: string;
}

export interface CRMChatPlatformCapability {
  readonly id: string;
  readonly label: string;
  readonly evidence: readonly PlatformEvidence[];
}

/**
 * Platform capabilities the module needs, read from the running system — never hard-coded `true`.
 * The Chat-owned tables are absent on purpose: 19-CHAT.3 adds them, and the health view reports the
 * `AIAgents` structures it reads instead of pretending to own them.
 */
export const CRM_CHAT_REQUIRED_CAPABILITIES: readonly CRMChatPlatformCapability[] = [
  {
    id: 'settings',
    label: 'Instance settings store',
    evidence: [{ kind: 'table', value: 'app_settings' }],
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
    id: 'aia-runs',
    label: 'AIAgents durable runs and timelines',
    evidence: [
      { kind: 'table', value: 'ai_agent_runs' },
      { kind: 'table', value: 'ai_agent_run_events' },
      { kind: 'table', value: 'ai_agent_tool_calls' },
    ],
  },
  {
    id: 'aia-conversations',
    label: 'AIAgents conversation and message store',
    evidence: [
      { kind: 'table', value: 'ai_agent_conversations' },
      { kind: 'table', value: 'ai_agent_messages' },
    ],
  },
  {
    id: 'aia-approvals',
    label: 'AIAgents approval ledger',
    evidence: [{ kind: 'table', value: 'ai_agent_approvals' }],
  },
  {
    id: 'notifications',
    label: 'Notification and stream surface',
    evidence: [
      { kind: 'table', value: 'notifications' },
      { kind: 'table', value: 'stream_items' },
    ],
  },
];

/**
 * The module-owned structures, created by 19-CHAT.3. Conversations and messages are deliberately
 * absent: they belong to `AIAgents` (contract D1) and are reported as a dependency, not as ownership.
 */
export const CRM_CHAT_TABLES: readonly string[] = ['crm_chat_citations', 'crm_chat_feedback', 'crm_chat_prompts'];

/** Optional integrations (§14.3). Detected by metadata/table markers, never by imports. */
export interface CRMChatOptionalIntegration {
  readonly id: string;
  readonly label: string;
  readonly provides: string;
  readonly markerEntity: string;
  readonly markerTable?: string;
}

export const CRM_CHAT_OPTIONAL_INTEGRATIONS: readonly CRMChatOptionalIntegration[] = [
  {
    id: 'aia',
    label: 'AIAgents',
    provides: 'Agent runtime, tool registry, approvals, usage and conversation memory.',
    markerEntity: '',
    markerTable: 'ai_agent_runs',
  },
  {
    id: 'aa-knowledge',
    label: 'Service Desk knowledge base',
    provides: 'Published help articles for “how do I” answers (19-CHAT.9).',
    markerEntity: 'KnowledgeArticle',
  },
  {
    id: 'notifications',
    label: 'Notifications',
    provides: 'Long-running run and approval outcome alerts.',
    markerEntity: '',
    markerTable: 'notifications',
  },
];

/** Assistant readiness the health view reports; `ready` requires every part, in this order. */
export type AssistantStateKey =
  | 'not-configured'
  | 'unresolvable'
  | 'not-found'
  | 'not-published'
  | 'execution-disabled'
  | 'execution-paused'
  | 'memory-disabled'
  | 'agent-memory-off'
  | 'ready';

export const CRM_CHAT_MODULE = {
  id: 'CRMChat',
  name: 'CRM Chat',
  /** Delivered sub-phases; 19-CHAT.5+ add the turn endpoints and streaming. */
  version: '0.4.0',
  minPlatformVersion: '1.0.0',
  /** Kernel module directories load in order; Chat runs after AI Agents (`390`). */
  loadOrder: 395,
  /** API prefix owned by the module's domain commands. */
  apiPrefix: '/api/v1/CRMChat',
  /** Frontend route of the human-facing surface. */
  frontendRoute: '/crm-chat',
  implementedPhases: ['19-CHAT.0', '19-CHAT.1', '19-CHAT.2', '19-CHAT.3', '19-CHAT.4', '19-CHAT.5', '19-CHAT.6'],
  /** Tables the module owns. Conversation storage stays with `AIAgents`. */
  tables: CRM_CHAT_TABLES,
  /** The module cannot function without this owner; it is a dependency, not a copy. */
  dependsOn: ['AIAgents'],
} as const;

export type CRMChatModuleDescriptor = typeof CRM_CHAT_MODULE;
