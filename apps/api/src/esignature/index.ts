/**
 * Phase 19-ES.1 — the module barrel (`PLAN_Phase_19_ESignature.md` §5.1, §18 `19-ES.1`).
 *
 * The repository's module convention: a directory under `apps/api/src/`, an `index.ts` that exports
 * the controller and provider arrays, and one spread in `app.module.ts`. The shell never imports the
 * module's files directly.
 *
 * The controller order matters. The static `/api/v1/ESignature` prefix must be matched before the
 * generic `/api/v1/:entity` wildcard, and the DocuSign Connect prefix
 * `/api/v1/integrations/esignature/...` (reserved in `ESIGNATURE_MODULE.webhookPrefix`, delivered by
 * 19-ES.11) before it too — the same reason `ADVANCED_INTEGRATIONS_CONTROLLERS` is spread before
 * `ENTITY_CONTROLLERS`.
 */

import { ESignatureController } from './esignature.controller.js';
import { ESignatureConnectionService } from './esignature-connection.service.js';
import { ESignatureConnectionGate } from './esignature-connection-gate.service.js';
import { ESignatureCredentialVault } from './esignature-credential-vault.js';
import { ESignatureDocumentService } from './esignature-document.service.js';
import { ESignatureModuleHealthService } from './esignature-module-health.service.js';
import { ESignatureNavigationService } from './esignature-navigation.service.js';
import { ESignatureOAuthCallbackController } from './esignature-oauth-callback.controller.js';
import { ESignaturePermissionService } from './esignature-permission.service.js';
import { ESignatureRecordEntryService } from './esignature-record-entry.service.js';
import { ESignatureReportService } from './esignature-report.service.js';
import { ESignatureRequestController } from './esignature-request.controller.js';
import { ESignatureRequestService } from './esignature-request.service.js';
import { ESignatureSettingsService } from './esignature-settings.service.js';
import { ESignatureTemplateController } from './esignature-template.controller.js';
import { ESignatureTemplateService } from './esignature-template.service.js';
import { ESignatureWebhookController } from './esignature-webhook.controller.js';
import { ESignatureWebhookService } from './esignature-webhook.service.js';
import { DocuSignAdapter } from './providers/docusign/docusign-adapter.js';
import {
  createDefaultDocuSignTransport,
  DOCUSIGN_TRANSPORT,
  type DocuSignTransport,
} from './providers/docusign/docusign-transport.js';
import { createFakeSignatureProviderAdapter } from './providers/fake-signature-provider.adapter.js';
import type { SignatureProviderAdapter } from './providers/signature-provider.port.js';
import { SIGNATURE_PROVIDER_ADAPTERS,SignatureProviderRegistry } from './providers/signature-provider.registry.js';
import { SignatureAuditRepository } from './signature-audit.repository.js';
import { SignatureConnectionRepository } from './signature-connection.repository.js';
import { SignatureDocumentSnapshotRepository } from './signature-document-snapshot.repository.js';
import { SignatureOAuthStateRepository } from './signature-oauth-state.repository.js';
import { SignatureProviderEventRepository } from './signature-provider-event.repository.js';
import { SignatureRecipientRepository } from './signature-recipient.repository.js';
import { SignatureReportRepository } from './signature-report.repository.js';
import { SignatureRequestRepository } from './signature-request.repository.js';
import { SignatureTemplateMappingRepository } from './signature-template-mapping.repository.js';
import { SignatureWebhookInboxRepository } from './signature-webhook-inbox.repository.js';

// Four controllers, in this order: the public Connect endpoint and the public OAuth callback are
// routes a provider or a browser arrives at with no session; the request surface is the module's
// largest API; the action controller is the control plane. All are registered before
// `ENTITY_CONTROLLERS`.
export const ESIGNATURE_CONTROLLERS = [
  ESignatureWebhookController,
  ESignatureOAuthCallbackController,
  ESignatureRequestController,
  ESignatureTemplateController,
  ESignatureController,
] as const;

/**
 * The one HTTP door to DocuSign. A test replaces this token and no socket is opened (plan §17.3); the
 * default is the platform's own destination gate, so a stored base URI that points at a private or
 * metadata address is refused before the request leaves the process (plan §9.3, SSRF).
 *
 * Declared outside the providers tuple: `as const` would make `inject` readonly, which Nest's
 * `FactoryProvider` type does not accept.
 */
const docuSignTransportProvider = {
  provide: DOCUSIGN_TRANSPORT,
  useFactory: () => createDefaultDocuSignTransport(),
};

/**
 * The provider adapters this build binds.
 *
 * The fake is withheld in production exactly as the connector registrar withholds its own
 * (`advanced-integrations/connector-registrar.service.ts:243`): a test double reachable by production
 * code would report a signature request as sent when nothing was. Since ES.4 the live DocuSign adapter
 * takes its place there, so `docusign` has exactly one answer in every build — and every build can say
 * which one it got (plan §9.4).
 */
const signatureProviderAdaptersProvider = {
  provide: SIGNATURE_PROVIDER_ADAPTERS,
  useFactory: (transport: DocuSignTransport): SignatureProviderAdapter[] =>
    process.env.NODE_ENV === 'production' ? [new DocuSignAdapter(transport)] : [createFakeSignatureProviderAdapter()],
  inject: [DOCUSIGN_TRANSPORT],
};

export const ESIGNATURE_PROVIDERS = [
  // The capability gate, the settings document, the visibility report, the module health view and
  // the single gate that stands in front of every provider operation.
  ESignaturePermissionService,
  ESignatureSettingsService,
  ESignatureNavigationService,
  ESignatureModuleHealthService,
  ESignatureConnectionGate,
  // Phase 19-ES.2 — the persistence of the module's own records. One repository per aggregate: the
  // state machine, the optimistic-concurrency check and the append-only rules live in these files,
  // which is why there is no generic `/api/v1/SignatureRequest` route to bypass them with.
  SignatureConnectionRepository,
  SignatureRequestRepository,
  SignatureRecipientRepository,
  SignatureDocumentSnapshotRepository,
  SignatureProviderEventRepository,
  SignatureWebhookInboxRepository,
  SignatureTemplateMappingRepository,
  SignatureAuditRepository,
  // Phase 19-ES.4 — the connection lifecycle. The state repository, the vault and the service are the
  // only paths between an administrator, DocuSign's identity host and a stored credential: no
  // controller reads a secret, and no credential-shaped value is ever a response field (plan §4.1).
  SignatureOAuthStateRepository,
  ESignatureCredentialVault,
  ESignatureConnectionService,
  // Phase 19-ES.5 — the document snapshot service. It reads a CRM file only through the attachment
  // service (which owns the ACL), copies it once into this module's own storage prefix, and refuses
  // anything the settings policy or DocuSign cannot accept (plan §4.5).
  ESignatureDocumentService,
  // Phase 19-ES.6 — the draft API. The capability and the record scope are checked in the service, so
  // a controller method is only ever a shape parser.
  ESignatureRequestService,
  // Phase 19-ES.18 — the CRM record entry point. It answers availability for a record detail page;
  // no optional module is imported, and an uninstalled module is simply not a candidate.
  ESignatureRecordEntryService,
  // Phase 19-ES.19 — the ACL-scoped operational read model and its curated reports. The Dashlet API
  // consumes `ESignatureReportService`; nothing here writes a request.
  SignatureReportRepository,
  ESignatureReportService,
  // Phase 19-ES.7 — the template catalog and mapping validation. Nothing here writes a provider template.
  ESignatureTemplateService,
  // Phase 19-ES.11/ES.12 — Connect intake, the durable inbox and the event projection.
  ESignatureWebhookService,
  docuSignTransportProvider,
  // Phase 19-ES.3 — the provider port. The registry answers for every adapter the build ships, and
  // `signatureProviderAdaptersProvider` decides which one answers for `docusign`.
  SignatureProviderRegistry,
  signatureProviderAdaptersProvider,
] as const;

export { ESignatureController } from './esignature.controller.js';
export {
  ESIGNATURE_SYSTEM_PRINCIPAL,
  runAsESignatureSystem,
} from './esignature-authority.js';
export {
  assertRedirectUri,
  ESIGNATURE_OAUTH_CALLBACK_PATH,
  ESignatureConnectionService,
  type SignatureAuthorizationOutcome,
  type SignatureAuthorizationStart,
  type SignatureConnectionTest,
  type SignatureConnectionView,
  type SignatureCredentialView,
} from './esignature-connection.service.js';
export {
  ESIGNATURE_OPERATIONS,
  type ESignatureOperation,
  type GateAssessment,
} from './esignature-connection-gate.service.js';
export {
  ESignatureCredentialVault,
  type ESignatureCredentialVaultPort,
  type ESignatureStoredCredential,
} from './esignature-credential-vault.js';
export {
  type AttachResult,
  documentCeiling,
  ESignatureDocumentService,
  extensionOf,
  SNAPSHOT_STORAGE_ROOT,
  type SnapshotRefusal,
} from './esignature-document.service.js';
// Phase 19-ES.6 — the draft API. The capability and the record scope are checked in the service, so a
// controller method is only ever a shape parser.
export type { ESignatureReportKey } from './dto/esignature-shapes.js';
export {
  type ApprovalPolicyDecision,
  type ApprovalPolicyReason,
  type ApprovalPolicyReasonCode,
  evaluateApprovalPolicy,
} from './esignature-approval-policy.js';
export {
  AUDIT_ACTIONS,
  CONNECTED_STATUS,
  CONNECTION_ENVIRONMENTS,
  CONNECTION_STATUSES,
  ESIGNATURE_MODULE_KEY,
  PROVIDER_KEY_DOCUSIGN,
  PROVIDER_KEYS,
  RECIPIENT_TYPES,
  REQUEST_STATUSES,
  SECRET_KIND_LABELS,
  SECRET_KINDS,
  SIGNATURE_APPROVE_PERMISSION_ENTITY,
  SIGNATURE_AUDIT_PERMISSION_ENTITY,
  SIGNATURE_CONNECTION_PERMISSION_ENTITY,
  SIGNATURE_CORRECT_PERMISSION_ENTITY,
  SIGNATURE_DOWNLOAD_PERMISSION_ENTITY,
  SIGNATURE_REQUEST_PERMISSION_ENTITY,
  SIGNATURE_SEND_PERMISSION_ENTITY,
  SIGNATURE_TEMPLATE_PERMISSION_ENTITY,
  SIGNATURE_VOID_PERMISSION_ENTITY,
  TERMINAL_REQUEST_STATUSES,
} from './esignature-domain.js';
export {
  encryptionKeyMissingError,
  ESignatureError,
  isESignatureError,
  notSupportedByProviderError,
  providerNotConnectedError,
  providerOutcomeUnknownError,
  signatureModuleDisabledError,
  signatureRequestInvalidStateError,
} from './esignature-errors.js';
export {
  buildSignatureEvent,
  ESIGNATURE_EVENT_SCHEMA_VERSION,
  eventForStatus,
  type SignatureEventPayload,
} from './esignature-events.js';
export {
  DOCUSIGN_PROVIDER_CAPABILITIES,
  ESIGNATURE_CAPABILITIES,
  ESIGNATURE_ERROR_CODES,
  ESIGNATURE_EVENT_TYPES,
  ESIGNATURE_FEATURES,
  ESIGNATURE_JOB_NAMES,
  ESIGNATURE_MODULE,
  ESIGNATURE_SETTINGS_KEY,
  ESIGNATURE_TABLES,
  type ESignatureCapabilityKey,
  type ESignatureErrorCode,
  type ESignatureProviderCapabilityKey,
  OPTIONAL_INTEGRATIONS,
  PENDING_FEATURES,
  PROVIDER_CAPABILITY_KEYS,
  REQUIRED_CAPABILITIES,
} from './esignature-module.js';
export { ESignatureOAuthCallbackController } from './esignature-oauth-callback.controller.js';
export {
  buildSignaturePreview,
  type PreviewProblem,
  type SignaturePreview,
} from './esignature-preview.js';
export {
  ENTRY_POINT_ENTITIES,
  ESignatureRecordEntryService,
  type RecordEntryReason,
  type RecordEntryRequestView,
  type RecordEntryView,
} from './esignature-record-entry.service.js';
export {
  ESIGNATURE_REPORT_DEFINITIONS,
  type ESignatureReportOverview,
  type ESignatureReportQuery,
  type ESignatureReportSection,
  ESignatureReportService,
  type ESignatureReportWindow,
} from './esignature-report.service.js';
export { ESignatureRequestController } from './esignature-request.controller.js';
export {
  ESignatureRequestService,
  type RequestDraftPatch,
  type RequestListQuery,
  type SignatureRequestDocumentView,
  type SignatureRequestListRow,
  type SignatureRequestRecipientView,
  type SignatureRequestSourceView,
  type SignatureRequestView,
} from './esignature-request.service.js';
export {
  artifactRetentionFor,
  type ESignatureRetentionClass,
  isAppendOnly,
  purgeAfterFor,
  RETENTION_CLASSES,
  type RetentionDecision,
  retentionPolicy,
  SOFT_DELETE_RULES,
} from './esignature-retention.js';
export {
  APPROVAL_RULE_OPERATORS,
  type ApprovalRule,
  type ApprovalRuleOperator,
  ApprovalRuleSchema,
  DEFAULT_ESIGNATURE_SETTINGS,
  type ESignatureSettings,
  ESignatureSettingsSchema,
  ESignatureSettingsService,
  type ESignatureSettingsView,
} from './esignature-settings.service.js';
export {
  approvalStillApplies,
  buildSnapshot,
  canonicalJson,
  type OutgoingSnapshotData,
  outgoingSnapshotDigest,
  readSnapshot,
  SNAPSHOT_VERSION,
  snapshotDigest,
  type SnapshotEnvelope,
} from './esignature-snapshot.js';
export {
  allowedTargets,
  ATTENTION_STATUSES,
  RECIPIENT_STATUSES,
  REQUEST_TRANSITIONS,
  type SignatureRecipientStatus,
  TRANSITION_ORIGINS,
  type TransitionOrigin,
} from './esignature-state-machine.js';
export {
  mapProviderEvent,
  normalizeEnvelopeStatus,
  normalizeProviderEventType,
  normalizeRecipientStatus,
  PROVIDER_EVENT_TYPES,
  type ProviderEventType,
  type StatusMapping,
} from './esignature-status-mapper.js';
export { ESignatureTemplateController } from './esignature-template.controller.js';
export {
  ESignatureTemplateService,
  MAPPABLE_SOURCE_FIELD_TYPES,
  type MappingInput,
  type MappingProblem,
  type MappingUsageCheck,
  type MappingValidation,
  type TemplateCatalogResult,
  type TemplateDetailView,
  validateMappingDefinition,
} from './esignature-template.service.js';
export { ESignatureWebhookController } from './esignature-webhook.controller.js';
export {
  ESignatureWebhookService,
  MAX_PROCESSING_ATTEMPTS,
  type WebhookIngestResult,
  type WebhookProcessResult,
} from './esignature-webhook.service.js';
export {
  createFakeSignatureProviderAdapter,
  type FakeProviderOptions,
  FakeSignatureProviderAdapter,
} from './providers/fake-signature-provider.adapter.js';
export {
  classifyAdapterError,
  type ESignatureProviderErrorCategory,
  isSendOutcomeUnknownError,
  NotSupportedByProviderError,
  redactAdapterError,
  SendOutcomeUnknownError,
  toModuleError,
} from './providers/signature-provider.errors.js';
export {
  artifactIdentity,
  correlationId,
  idempotencyKey,
  prepareIdentity,
  sendIdentity,
} from './providers/signature-provider.idempotency.js';
export {
  adapterSupports,
  assertAdapterContract,
  BASE_SIGNATURE_PROVIDER_CAPABILITIES,
  FUTURE_SIGNATURE_PROVIDER_OPERATIONS,
  type PreparedEnvelope,
  type PrepareEnvelopeInput,
  type ProviderArtifact,
  type ProviderEnvelopeStatus,
  type ProviderRecipientStatus,
  type ProviderWebhookNotification,
  redactContext,
  type SendEnvelopeInput,
  SIGNATURE_PROVIDER_OPERATIONS,
  type SignatureProviderAdapter,
  type SignatureProviderCapabilities,
  type SignatureProviderContext,
  type SignatureProviderOperation,
  type VerifyWebhookInput,
} from './providers/signature-provider.port.js';
export {
  SIGNATURE_PROVIDER_ADAPTERS,
  type SignatureProviderDescriptor,
} from './providers/signature-provider.registry.js';
export {
  redactDetail,
  type SignatureAuditEntry,
} from './signature-audit.repository.js';
export {
  assertConnectionTransition,
  canConnectionTransition,
  CONNECTION_TRANSITIONS,
  type SignatureConnection,
} from './signature-connection.repository.js';
export {
  ARTIFACT_KINDS,
  type SignatureArtifactKind,
  type SignatureDocumentSnapshot,
} from './signature-document-snapshot.repository.js';
export {
  type ConsumedOAuthState,
  type NewOAuthState,
  OAUTH_STATE_TTL_SECONDS,
  SignatureOAuthStateRepository,
} from './signature-oauth-state.repository.js';
export {
  buildEventDedupKey,
  payloadDigest,
  type SignatureProviderEvent,
} from './signature-provider-event.repository.js';
export {
  type RecipientInput,
  type SignatureRecipient,
} from './signature-recipient.repository.js';
export {
  type RequestDraftInput,
  type RequestListFilters,
  type SignatureRequest,
} from './signature-request.repository.js';
export {
  type ESignatureMappingType,
  MAPPING_TYPES,
  normalizeFieldMappings,
  normalizeRoleMappings,
  type SignatureTemplateMapping,
} from './signature-template-mapping.repository.js';
export {
  deliveryDedupKey,
  payloadHashOf,
  type SignatureWebhookDelivery,
} from './signature-webhook-inbox.repository.js';
