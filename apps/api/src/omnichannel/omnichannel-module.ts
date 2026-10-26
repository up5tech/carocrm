/**
 * Phase 19-OM.2 — the `Omnichannel` module descriptor
 * (`PLAN_Phase_19_Omnichannel.md` §14 `19-OM.2`, `docs/omnichannel/feature-contract.md` §3 F1, §10).
 *
 * Omnichannel is a kernel domain directory under `apps/api/src`, not an installable extension
 * package, and it owns **no record store of its own** (contract decision D1): the canonical
 * conversation, message, participant and event records stay in `VoiceCommunications`, queues and
 * routing stay in `ServiceDesk`, and the realtime seam is the shared platform's (D2, D3). What this
 * module owns is the **workspace, the multi-channel policy and the read projections** — so its
 * permission resources describe capabilities, never tables.
 *
 * The id carries **no prefix** (`Omnichannel`, never `Ua…`), the route slug is `omnichannel`
 * (plan §0.1, audit §2.1).
 */

export interface OmnichannelFeatureDescriptor {
  readonly key: 'workspace';
  readonly label: string;
  /** Dotted path inside the `omnichannel` settings row. */
  readonly settingsPath: string;
  readonly requires: readonly string[];
}

/**
 * Feature flags. Only `workspace` exists at OM.2, and it starts on: the module page performs no
 * provider call and no mutation, so an enabled workspace on a fresh install is honest but inert —
 * it reports that no channel surfaces are implemented yet (contract §3 F1). Channel flags
 * (`webChat`, `aiDrafts`, …) arrive **with** their implementing sub-phases, never before
 * ("do not create empty placeholder controllers", plan §14 OM.2).
 */
export const OMNICHANNEL_FEATURES: readonly OmnichannelFeatureDescriptor[] = [
  { key: 'workspace', label: 'Agent conversation workspace', settingsPath: 'features.workspace', requires: [] },
];

/**
 * The capability keys are declared as a literal union, and the definitions array is annotated with
 * the interface that references it. Inferring the union from the array instead would be circular
 * (the array's type needs the interface, which needs the union), and an unannotated `as const` array
 * cannot be indexed by a union the compiler has not seen yet.
 */
export type OmnichannelCapabilityKey =
  | 'inboxView'
  | 'reply'
  | 'assign'
  | 'queueManage'
  | 'identityLink'
  | 'connectionManage'
  | 'opsRead'
  | 'opsReplay'
  | 'settingsManage';

export interface OmnichannelCapabilityDefinition {
  readonly key: OmnichannelCapabilityKey;
  /** Synthetic permission resource evaluated by `AclApiService` (convention: PascalCase entity names). */
  readonly resource: string;
  readonly action: 'read' | 'create' | 'edit';
  readonly label: string;
  readonly description: string;
}

/**
 * The capability matrix (contract §10). One synthetic resource per governed object of the
 * workspace — the flat, entity-name-based convention the platform evaluator already speaks
 * (`CommunicationConversation`, `VoiceProviderAccount`, `SignatureRequest` are its precedents).
 * Declaring them at OM.2 is the plan §14 task "configure permission keys"; the endpoints that
 * consume each capability arrive with their sub-phase and assert it here, in this one place.
 */
export const OMNICHANNEL_CAPABILITIES: readonly OmnichannelCapabilityDefinition[] = [
  {
    key: 'inboxView',
    resource: 'OmnichannelConversation',
    action: 'read',
    label: 'View the conversation inbox',
    description: 'Opens the workspace and reads permitted conversations, timeline and customer context.',
  },
  {
    key: 'reply',
    resource: 'OmnichannelMessage',
    action: 'create',
    label: 'Reply to a conversation',
    description: 'Sends customer-visible messages and internal notes through the owning transport.',
  },
  {
    key: 'assign',
    resource: 'OmnichannelAssignment',
    action: 'edit',
    label: 'Assign and transfer conversations',
    description: 'Changes ownership and status of a conversation; recorded with a reason.',
  },
  {
    key: 'queueManage',
    resource: 'OmnichannelQueue',
    action: 'edit',
    label: 'Manage queues and routing',
    description: 'Edits the ServiceDesk queues and routing rules conversations are routed through (D2).',
  },
  {
    key: 'identityLink',
    resource: 'OmnichannelIdentity',
    action: 'edit',
    label: 'Link customer identities',
    description: 'Confirms, links or unlinks a conversation participant to a CRM record (contract §6).',
  },
  {
    key: 'connectionManage',
    resource: 'OmnichannelConnection',
    action: 'edit',
    label: 'Manage channel connections',
    description: 'Administers channel connections and their health; credentials stay in the owning vault.',
  },
  {
    key: 'opsRead',
    resource: 'OmnichannelOps',
    action: 'read',
    label: 'View operations logs',
    description: 'Reads webhook receipts, send operations and provider health diagnostics.',
  },
  {
    key: 'opsReplay',
    resource: 'OmnichannelOps',
    action: 'edit',
    label: 'Replay webhook events',
    description: 'Re-processes a stored receipt. Administrative, audited, never shown to ordinary agents.',
  },
  {
    key: 'settingsManage',
    resource: 'OmnichannelSettings',
    action: 'edit',
    label: 'Administer the module',
    description: 'Reads and writes the omnichannel settings document, including the workspace switch.',
  },
];

/**
 * The resources the workspace needs from its owning modules (contract §2, D1–D3). Omnichannel
 * detects these by marker — a metadata entity or a physical table — never by importing the
 * module, exactly like the Voice and ESignature descriptors.
 */
export interface OmnichannelDependency {
  readonly id: string;
  readonly label: string;
  readonly kind: 'entity' | 'table';
  readonly value: string;
  /** Whether the workspace is useless without it (required) or degrades with a report (optional). */
  readonly required: boolean;
}

export const OMNICHANNEL_DEPENDENCIES: readonly OmnichannelDependency[] = [
  { id: 'conversation-store', label: "Conversation records (VoiceCommunications, D1)", kind: 'table', value: 'voice_conversations', required: true },
  { id: 'message-store', label: "Message records (VoiceCommunications, D1)", kind: 'table', value: 'voice_messages', required: true },
  { id: 'participant-store', label: "Participant records (VoiceCommunications, D1)", kind: 'table', value: 'voice_conversation_participants', required: true },
  { id: 'thread-store', label: "Channel-thread records (VoiceCommunications, E6)", kind: 'table', value: 'voice_conversation_threads', required: true },
  { id: 'webhook-receipts', label: "Webhook receipt pipeline (VoiceCommunications)", kind: 'table', value: 'voice_webhook_events', required: true },
  { id: 'queue-engine', label: 'Queue and routing engine (ServiceDesk, D2)', kind: 'entity', value: 'CaseQueue', required: false },
  { id: 'crm-contacts', label: 'CRM contacts (identity matching)', kind: 'entity', value: 'Contact', required: true },
  { id: 'crm-leads', label: 'CRM leads (identity matching)', kind: 'entity', value: 'Lead', required: false },
  { id: 'crm-accounts', label: 'CRM accounts (identity matching)', kind: 'entity', value: 'Account', required: false },
  { id: 'acl', label: 'ACL (roles, record scope)', kind: 'table', value: 'roles', required: true },
  { id: 'settings', label: 'Instance settings store', kind: 'table', value: 'app_settings', required: true },
  { id: 'audit-stream', label: 'Audit log and stream', kind: 'table', value: 'audit_log', required: true },
  { id: 'realtime', label: 'Realtime notification transport (D3 seam)', kind: 'table', value: 'notifications', required: false },
];

/** Optional integrations the workspace enriches itself with when present (markers, never imports). */
export const OMNICHANNEL_OPTIONAL_INTEGRATIONS = [
  { id: 'service-desk', label: 'Service Desk', provides: 'Case hand-off and queue routing for conversations (contract §2.2, §8)', markerEntity: 'Case' },
  { id: 'ai-agents', label: 'AI Agents', provides: 'Draft-only reply suggestions and summaries behind explicit approval (contract §1 OM1.7)', markerEntity: '', markerTable: 'ai_agents' },
  { id: 'marketing-automation', label: 'Marketing Automation', provides: 'Campaign-originated touchpoints shown as source metadata (audit §6)', markerEntity: 'Campaign' },
  { id: 'portal', label: 'Portal', provides: 'Authenticated customer identity for the web-chat path (contract §7)', markerEntity: '', markerTable: 'portals' },
] as const;

export const OMNICHANNEL_MODULE = {
  id: 'Omnichannel',
  name: 'Omnichannel',
  version: '1.0.0',
  minPlatformVersion: '1.0.0',
  /** Kernel module directories load in order; Omnichannel runs after ESignature (`396`). */
  loadOrder: 397,
  /** API prefix owned by the module's workspace commands; entity CRUD stays on `/api/v1/:entity`. */
  apiPrefix: '/api/v1/Omnichannel',
  /**
   * The webhook prefix **reserved** for provider ingress (contract §3 F6, extension E2).
   * No webhook controller answers on it yet — declaring it here is what lets `bootstrap.ts`
   * learn the raw-body prefix (E2) in the same change that delivers the first real channel
   * ingress (OM.5), not before.
   */
  webhookPrefix: '/api/v1/integrations/omnichannel',
  /** Frontend route of the agent workspace. */
  frontendRoute: '/omnichannel',
  /** Sub-phases delivered by this module so far. */
  implementedPhases: ['19-OM.0', '19-OM.1', '19-OM.2', '19-OM.3', '19-OM.4'],
  /**
   * Metadata entities this module owns — deliberately empty (D1): the records live in their
   * owning modules and the workspace consumes facades. No entity is invented to populate menus.
   */
  entityTypes: [] as const,
  /**
   * Physical tables this module owns. Empty at OM.2 by the same reasoning; the only table
   * Omnichannel is contracted to own is the visitor-session store of the web-chat channel
   * (contract §7), which arrives with OM.9.
   */
  ownedTables: [] as const,
} as const;

export type OmnichannelModuleDescriptor = typeof OMNICHANNEL_MODULE;
