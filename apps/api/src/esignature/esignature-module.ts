import type { AclAction } from '@carocrm/acl/types/index.js';

import {
  PROVIDER_KEY_DOCUSIGN,
  SIGNATURE_APPROVE_PERMISSION_ENTITY,
  SIGNATURE_AUDIT_PERMISSION_ENTITY,
  SIGNATURE_CONNECTION_PERMISSION_ENTITY,
  SIGNATURE_CORRECT_PERMISSION_ENTITY,
  SIGNATURE_DOWNLOAD_PERMISSION_ENTITY,
  SIGNATURE_REQUEST_PERMISSION_ENTITY,
  SIGNATURE_SEND_PERMISSION_ENTITY,
  SIGNATURE_TEMPLATE_PERMISSION_ENTITY,
  SIGNATURE_VOID_PERMISSION_ENTITY,
} from './esignature-domain.js';

/**
 * Phase 19-ES.1 — the `ESignature` module descriptor and security contract
 * (`PLAN_Phase_19_ESignature.md` §5, §12, §18 `19-ES.1`).
 *
 * ESignature is a kernel domain directory under `apps/api/src`, like AI Agents, Voice
 * Communications and Advanced Integrations: it owns no auth, ACL, queue, outbox, audit trail,
 * settings store or file store of its own (audit `docs/implementation/esignature-audit.md` §1–§2),
 * and its own records will be dedicated additive tables rather than `entity_records` rows — the
 * request state machine and the send guard must be the only mutation path (audit §6).
 *
 * The id carries **no `Ua` prefix**: `ESignature`, `esignature`, `ESignatureModule`, and the API
 * prefix `/api/v1/ESignature` (plan §0).
 *
 * This file is the module's identity and the single source the health endpoint and the settings
 * screen read: the capability matrix (plan §12's permission list, expressed as the platform's
 * synthetic ACL resources), the platform capabilities it builds on (each proven by a fact about the
 * running system), the optional modules it can talk to (detected by a marker, never an import), and
 * its feature flags with the settings path that controls each.
 */

/** A capability is one separable right the module checks on the server. */
export interface ESignatureCapabilityDefinition {
  readonly key: ESignatureCapabilityKey;
  readonly label: string;
  readonly description: string;
  /**
   * The synthetic ACL resource the capability is evaluated against (plan §12). The platform has no
   * arbitrary-permission mechanism, so a module right is an entity/action pair — a role's `*` entry
   * grants it exactly as it grants every future entity.
   */
  readonly resource: string;
  readonly action: AclAction;
}

/**
 * The dedicated permission set (plan §12), keyed the way the SPA and the admin UI will read them.
 *
 * `ESignature.request.read` → `use`; `…create`/`…prepare` → `manageDraft`; `…send`, `…approve`,
 * `…void`, `…correct`, `…downloadCompleted`, `…connection.read|manage`, `…templateMapping.manage`
 * and `…audit.read` each own one row. Separating `send` from `manageDraft` is what lets a policy
 * give preparation to one role and the deliberate external act of sending to another (plan §11.1).
 */
export type ESignatureCapabilityKey =
  | 'use'
  | 'manageDraft'
  | 'send'
  | 'approve'
  | 'void'
  | 'correct'
  | 'downloadCompleted'
  | 'connectionRead'
  | 'connectionManage'
  | 'templateMappingManage'
  | 'auditRead';

export const ESIGNATURE_CAPABILITIES: readonly ESignatureCapabilityDefinition[] = [
  {
    key: 'use',
    label: 'Use e-signatures',
    description: 'See the ESignature menu, list signature requests and read the ones their ACL allows.',
    resource: SIGNATURE_REQUEST_PERMISSION_ENTITY,
    action: 'read',
  },
  {
    key: 'manageDraft',
    label: 'Prepare signature requests',
    description: 'Create and edit draft requests, attach source documents and configure recipients.',
    resource: SIGNATURE_REQUEST_PERMISSION_ENTITY,
    action: 'create',
  },
  {
    key: 'send',
    label: 'Send signature requests',
    description:
      'Perform the deliberate external action of sending an envelope to remote signers. Separate from preparation, so sending can be restricted to fewer people than drafting.',
    resource: SIGNATURE_SEND_PERMISSION_ENTITY,
    action: 'edit',
  },
  {
    key: 'approve',
    label: 'Approve signature requests',
    description: 'Grant or reject the approval a request requires before it may be sent.',
    resource: SIGNATURE_APPROVE_PERMISSION_ENTITY,
    action: 'edit',
  },
  {
    key: 'void',
    label: 'Void signature requests',
    description: 'Withdraw a sent envelope with a recorded reason.',
    resource: SIGNATURE_VOID_PERMISSION_ENTITY,
    action: 'edit',
  },
  {
    key: 'correct',
    label: 'Correct a sent request',
    description: 'Use the exception path that edits a sent envelope, only while the provider state permits it.',
    resource: SIGNATURE_CORRECT_PERMISSION_ENTITY,
    action: 'edit',
  },
  {
    key: 'downloadCompleted',
    label: 'Download completed documents',
    description: 'Fetch and read the signed documents and the completion evidence of a completed request.',
    resource: SIGNATURE_DOWNLOAD_PERMISSION_ENTITY,
    action: 'read',
  },
  {
    key: 'connectionRead',
    label: 'Read provider connections',
    description: 'See the DocuSign connections, their environment, health and redacted diagnostics.',
    resource: SIGNATURE_CONNECTION_PERMISSION_ENTITY,
    action: 'read',
  },
  {
    key: 'connectionManage',
    label: 'Administer provider connections',
    description:
      'Create, authorize, test, enable, re-authorize and disconnect a provider connection. This right reaches the credential vault; secrets are write-only.',
    resource: SIGNATURE_CONNECTION_PERMISSION_ENTITY,
    action: 'edit',
  },
  {
    key: 'templateMappingManage',
    label: 'Administer template mappings',
    description: 'Refresh the provider template catalog and map its roles and fields to CRM sources.',
    resource: SIGNATURE_TEMPLATE_PERMISSION_ENTITY,
    action: 'edit',
  },
  {
    key: 'auditRead',
    label: 'Read signature audit trail',
    description: 'Read the append-only lifecycle audit and the accepted provider event history.',
    resource: SIGNATURE_AUDIT_PERMISSION_ENTITY,
    action: 'read',
  },
];

/**
 * The module's settings row in `app_settings`.
 *
 * One validated JSON document per module — the pattern `VoiceCommunicationsSettingsService` and
 * `AdvancedIntegrationsSettingsService` established. The admin screen is hosted by the settings
 * shell through the module endpoint (`GET`/`POST /api/v1/ESignature/action/settings`).
 */
export const ESIGNATURE_SETTINGS_KEY = 'ESignature';

/**
 * The settings document's shape version.
 *
 * Bumped when the stored document changes shape; a stored document of an unknown version is refused
 * rather than partially interpreted.
 */
export const ESIGNATURE_SETTINGS_VERSION = 1;

/**
 * The provider-integration key decision the ES.0 audit left open (audit §8, "decided in ES.1").
 *
 * **Decision: the settings document owns the DocuSign integration keys; no new environment variable
 * is introduced, and `INTEGRATION_OAUTH_CLIENT_IDS` is deliberately *not* reused.** That variable is
 * Advanced Integrations' JSON map keyed by one provider key, and a DocuSign connection is
 * environment-scoped (plan §9.2: demo and production keep separate clients) — one `docusign` key
 * cannot address both, and a connection's environment, account identity and Connect configuration
 * belong to this module, not to the generic sync control plane (audit §3).
 *
 * The stored value is a public OAuth **client id**, never the client secret, which is why it may sit
 * in `app_settings` at all. `DOCUSIGN_DEMO_INTEGRATION_KEY` / `DOCUSIGN_PRODUCTION_INTEGRATION_KEY`
 * are recorded here as *names only*: a deployment that prefers to inject them keeps that option, and
 * ES.4 reads them when it creates a connection. No secret value is ever committed, logged or
 * returned (plan §21).
 */
export const DOCUSIGN_INTEGRATION_KEY_ENV_VARS = [
  'DOCUSIGN_DEMO_INTEGRATION_KEY',
  'DOCUSIGN_PRODUCTION_INTEGRATION_KEY',
] as const;

export interface ESignatureFeatureDescriptor {
  readonly key: string;
  readonly label: string;
  /** Dotted path inside the `ESignature` settings row. */
  readonly settingsPath: string;
  /** Feature keys that must also be enabled for this one to do anything. */
  readonly requires: readonly string[];
}

/**
 * Feature flags, each with the settings path an administrator flips.
 *
 * Everything that has an external side effect defaults **off**: a fresh installation has no
 * connection, so nothing can be sent and the module reports exactly that. `embeddedSigning` is off
 * by policy, not by omission (plan §4.6): a recipient view URL is a bearer credential.
 */
export const ESIGNATURE_FEATURES: readonly ESignatureFeatureDescriptor[] = [
  { key: 'requests', label: 'Signature requests', settingsPath: 'features.requests', requires: [] },
  { key: 'connections', label: 'Provider connections', settingsPath: 'features.connections', requires: [] },
  {
    key: 'documents',
    label: 'Attach CRM documents to a request',
    settingsPath: 'features.documents',
    requires: ['requests'],
  },
  { key: 'templates', label: 'Provider templates and role mappings', settingsPath: 'features.templates', requires: ['connections'] },
  { key: 'send', label: 'Send envelopes to remote signers', settingsPath: 'features.send', requires: ['connections'] },
  {
    key: 'webhooks',
    label: 'DocuSign Connect status events',
    settingsPath: 'features.webhooks',
    requires: ['connections'],
  },
  {
    key: 'embeddedSigning',
    label: 'Embedded signing (recipient view)',
    settingsPath: 'features.embeddedSigning',
    requires: ['send'],
  },
  {
    key: 'artifacts',
    label: 'Completed documents and completion evidence',
    settingsPath: 'features.artifacts',
    requires: ['connections'],
  },
  { key: 'approvals', label: 'Approval required before send', settingsPath: 'features.approvals', requires: ['requests'] },
];

/**
 * Features whose implementation is delivered by a later sub-phase.
 *
 * The settings view and the health report present them as *pending* rather than letting an
 * administrator believe a switch does something: plan §18 sequences them, and a flag whose consumer
 * does not exist yet is a false promise in an admin screen.
 */
export const PENDING_FEATURES: readonly { readonly key: string; readonly phase: string }[] = [
  { key: 'approvals', phase: '19-ES.17' },
];

export type ESignatureEvidenceKind = 'entity' | 'table' | 'column' | 'hookPhase';

export interface ESignaturePlatformEvidence {
  readonly kind: ESignatureEvidenceKind;
  readonly value: string;
}

export interface ESignaturePlatformCapability {
  readonly id: string;
  readonly label: string;
  readonly evidence: readonly ESignaturePlatformEvidence[];
}

/**
 * Required platform capabilities (audit §1–§2), read from the running system by the health service,
 * never hard-coded `true`.
 *
 * Each entry is a piece of the kernel ESignature cannot function without. The list is the audited
 * reuse decision, and it is also the guard against re-building one: there is no second ACL engine,
 * queue, outbox, audit trail, settings store, secret cipher or file store here because the evidence
 * below proves the platform's own is present.
 */
export const REQUIRED_CAPABILITIES: readonly ESignaturePlatformCapability[] = [
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
      { kind: 'table', value: 'teams_roles' },
      { kind: 'column', value: 'roles.field_permissions' },
    ],
  },
  {
    id: 'metadata',
    label: 'Metadata registry (source-record validation)',
    evidence: [
      { kind: 'table', value: 'metadata_entries' },
      { kind: 'entity', value: 'Account' },
      { kind: 'entity', value: 'Contact' },
    ],
  },
  {
    id: 'files',
    label: 'Attachments and secure file storage (source documents, signed artifacts)',
    evidence: [
      { kind: 'table', value: 'attachments' },
      { kind: 'table', value: 'file_uploads' },
    ],
  },
  {
    id: 'secret-encryption',
    label: 'Encrypted credential vault for provider secrets',
    evidence: [
      { kind: 'table', value: 'integration_credential_secrets' },
      { kind: 'column', value: 'integration_credential_secrets.payload_encrypted' },
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
    id: 'notifications',
    label: 'Notifications (approval requests, reauthorization, send-unknown)',
    evidence: [{ kind: 'table', value: 'notifications' }],
  },
  {
    id: 'settings',
    label: 'Instance settings store',
    evidence: [{ kind: 'table', value: 'app_settings' }],
  },
  {
    id: 'hooks',
    label: 'Hook registry (module write guard)',
    evidence: [
      { kind: 'hookPhase', value: 'beforeValidate' },
      { kind: 'hookPhase', value: 'afterSave' },
    ],
  },
];

/** Optional modules the request may be started from or reported to (plan §2.3). */
export interface ESignatureOptionalIntegration {
  readonly id: string;
  readonly label: string;
  readonly provides: string;
  /** Metadata entity the optional module registers; detection reads the registry, never an import. */
  readonly markerEntity?: string;
  /** Physical table the optional module owns, for a domain that has no metadata marker. */
  readonly markerTable?: string;
}

/**
 * Every entry is optional in the literal sense plan §2.3 requires: ESignature loads and works with
 * none of them present, and the health report says which ones are missing instead of failing.
 */
export const OPTIONAL_INTEGRATIONS: readonly ESignatureOptionalIntegration[] = [
  { id: 'sales', label: 'Sales', provides: 'quote, order and invoice documents as signature sources', markerEntity: 'Quote' },
  { id: 'projects', label: 'Projects', provides: 'project agreements as signature sources', markerEntity: 'Project' },
  {
    id: 'customer-success',
    label: 'Customer Success',
    provides: 'renewal and plan agreements as signature sources',
    markerEntity: 'CustomerSuccessProfile',
  },
  { id: 'service-desk', label: 'Service Desk', provides: 'case-linked documents', markerEntity: 'Case' },
  {
    id: 'marketing',
    label: 'Marketing Automation',
    provides: 'campaign collateral as a source',
    markerEntity: 'Campaign',
  },
  {
    id: 'ai-agents',
    label: 'AI Agents',
    provides: 'draft preparation only; never an automatic send',
    markerEntity: 'AIAgent',
  },
  {
    id: 'crm-chat',
    label: 'CRM Chat',
    provides: 'status surfacing and confirmed actions through this module API',
    markerEntity: 'CRMChatConversation',
  },
  {
    id: 'advanced-integrations',
    label: 'Advanced Integrations',
    provides: 'the credential vault and the OAuth flow machinery this module builds on',
    markerTable: 'integration_credential_secrets',
  },
];

/**
 * The provider capabilities of the first adapter (plan §5.2, §17; audit §5.1).
 *
 * Declared here, answered by `ESignatureCapabilitiesService`, and checked **before** a call is made
 * — an operation a provider does not offer fails with `NOT_SUPPORTED_BY_PROVIDER` instead of a
 * silent no-op or a "not implemented" thrown from inside an adapter. `correctEnvelope` is declared
 * false for the initial release: it is the exception path ES.16 may open after the demo behaviour
 * is verified.
 */
export const PROVIDER_CAPABILITY_KEYS = [
  'connectionStatus',
  'accountContext',
  'listTemplates',
  'templateDetails',
  'prepareEnvelope',
  'sendEnvelope',
  'envelopeStatus',
  'listRecipients',
  'recipientView',
  'resendNotifications',
  'voidEnvelope',
  'correctEnvelope',
  'downloadCompletedDocuments',
  'downloadCompletionEvidence',
  'verifyWebhook',
] as const;
export type ESignatureProviderCapabilityKey = (typeof PROVIDER_CAPABILITY_KEYS)[number];

/** What the initial release commits to, per capability key, for `docusign`. */
export const DOCUSIGN_PROVIDER_CAPABILITIES: Readonly<Record<ESignatureProviderCapabilityKey, boolean>> = {
  connectionStatus: true,
  accountContext: true,
  listTemplates: true,
  templateDetails: true,
  prepareEnvelope: true,
  sendEnvelope: true,
  envelopeStatus: true,
  listRecipients: true,
  recipientView: true,
  resendNotifications: true,
  voidEnvelope: true,
  // Plan §4.3 and §16: an ambiguous send is reconciled, never corrected blindly, and correction is
  // an exception path that must be verified against the live account before it is offered.
  correctEnvelope: false,
  downloadCompletedDocuments: true,
  downloadCompletionEvidence: true,
  verifyWebhook: true,
};

/**
 * The document restrictions DocuSign's eSignature API is documented to impose, as far as the audit
 * could establish them (`docs/implementation/esignature-audit.md` §4 verified the API surface, not the
 * per-document limits).
 *
 * They are a **ceiling the settings cannot lift**, not a policy: the effective limit for an attachment
 * is the tighter of this table and the `ESignature` settings document (plan §4.5 asks for "file type,
 * count, size **and provider-supported format**", and only the provider knows the last one). A format
 * the provider does not accept is refused before any bytes are copied, so a request never discovers at
 * send time that its document was unsignable. ES.22 re-verifies the numbers against a live demo
 * account; a correction lands here and nowhere else.
 */
export const DOCUSIGN_DOCUMENT_RESTRICTIONS = {
  /** The documented per-document size ceiling, in bytes (25 MiB). */
  maxDocumentBytes: 26_214_400,
  /** Formats DocuSign accepts for an eSignature envelope, lower-case and without the dot. */
  supportedExtensions: [
    'pdf',
    'doc',
    'docx',
    'rtf',
    'txt',
    'xls',
    'xlsx',
    'htm',
    'html',
    'xml',
    'bmp',
    'gif',
    'jpg',
    'jpeg',
    'png',
  ] as const,
} as const;

/**
 * The stable module error codes (plan §8.2, audit §5.8).
 *
 * A caller switches on these; the human-readable text is the i18n catalog's job
 * (`errors.<CODE>`). None of them may carry a provider body, a token, or a signing URL.
 */
export const ESIGNATURE_ERROR_CODES = [
  'SIGNATURE_MODULE_DISABLED',
  'SIGNATURE_CONNECTION_NOT_AVAILABLE',
  'PROVIDER_NOT_CONNECTED',
  'PROVIDER_OUTCOME_UNKNOWN',
  'SIGNATURE_REQUEST_INVALID_STATE',
  'SIGNATURE_APPROVAL_REQUIRED',
  'RECIPIENT_NOT_AUTHORIZED',
  'SIGNATURE_DOCUMENT_NOT_READABLE',
  'SIGNATURE_SOURCE_RECORD_NOT_READABLE',
  'SIGNATURE_WEBHOOK_REJECTED',
  'NOT_SUPPORTED_BY_PROVIDER',
  'ENCRYPTION_KEY_MISSING',
] as const;
export type ESignatureErrorCode = (typeof ESIGNATURE_ERROR_CODES)[number];

/** The stable event names published through the platform outbox (plan §15). ES.18 wires them. */
export const ESIGNATURE_EVENT_TYPES = [
  'esignature.requestCreated',
  'esignature.requestPrepared',
  'esignature.requestApprovalRequested',
  'esignature.requestApproved',
  'esignature.requestRejected',
  'esignature.requestSent',
  'esignature.recipientCompleted',
  'esignature.requestCompleted',
  'esignature.requestDeclined',
  'esignature.requestVoided',
  'esignature.requestExpired',
  'esignature.requestNeedsReconciliation',
  'esignature.completedArtifactAvailable',
] as const;

/** The durable job names the worker will register (plan §16). None is enqueued before its phase. */
export const ESIGNATURE_JOB_NAMES = [
  'esignature.processProviderWebhook',
  'esignature.refreshEnvelopeProjection',
  'esignature.reconcileStuckRequests',
  'esignature.retrieveCompletedArtifacts',
  'esignature.refreshProviderConnectionHealth',
  'esignature.cleanupExpiredTemporaryArtifacts',
] as const;

/**
 * The structures this module owns, created by the additive migrations
 * `database/migrations/064_phase19_esignature.sql` and `065_phase19_esignature_oauth.sql`. No other
 * module may write them (audit §6).
 */
export const ESIGNATURE_TABLES = [
  'esignature_connections',
  'esignature_credential_secrets',
  'esignature_oauth_states',
  'signature_requests',
  'signature_recipients',
  'signature_document_snapshots',
  'signature_provider_events',
  'signature_webhook_inbox',
  'signature_template_mappings',
  'signature_audit_entries',
] as const;

/** Sub-phases delivered so far, reported verbatim by the health endpoint. */
export const IMPLEMENTED_PHASES = [
  '19-ES.0',
  '19-ES.1',
  '19-ES.2',
  '19-ES.3',
  '19-ES.4',
  '19-ES.5',
  '19-ES.6',
  '19-ES.7',
  '19-ES.8',
  '19-ES.9',
  '19-ES.10',
  '19-ES.11',
  '19-ES.12',
  '19-ES.13',
  '19-ES.14',
  '19-ES.15',
] as const;

/**
 * The DocuSign Connect prefix (`PLAN_Phase_19_ESignature.md` §8.3).
 *
 * The endpoint lives under the platform's integration webhook prefix because it needs the exact raw
 * body for HMAC verification; `bootstrap.ts` preserves that body for this prefix as well as the
 * Advanced Integrations one.
 */
export const ESIGNATURE_WEBHOOK_PREFIX = '/api/v1/integrations/esignature';

export const ESIGNATURE_MODULE = {
  id: 'ESignature',
  name: 'E-Signature',
  version: '1.0.0',
  minPlatformVersion: '1.0.0',
  /** Kernel module directories load in order; ESignature runs after Advanced Integrations (`395`). */
  loadOrder: 396,
  /** API prefix owned by the module's domain commands (plan §8). */
  apiPrefix: '/api/v1/ESignature',
  /** Frontend route of the human-facing surface. */
  frontendRoute: '/esignature',
  /**
   * The webhook prefix reserved for DocuSign Connect (plan §8.3).
   *
   * ES.11 implements it; the path is declared here so the raw-body hook, the routing table and the
   * admin runbook all name the same endpoint. It sits under the platform's integration webhook
   * prefix because it needs the raw bytes for HMAC verification.
   */
  webhookPrefix: ESIGNATURE_WEBHOOK_PREFIX,
  /** Provider products this release addresses (plan §1). */
  providerKeys: [PROVIDER_KEY_DOCUSIGN],
  /** Tables the module owns; no other module may write them (audit §6). */
  tables: ESIGNATURE_TABLES,
  implementedPhases: IMPLEMENTED_PHASES,
} as const;

export type ESignatureModuleDescriptor = typeof ESIGNATURE_MODULE;
