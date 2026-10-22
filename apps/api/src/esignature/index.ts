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
import { ESignatureConnectionGate } from './esignature-connection-gate.service.js';
import { ESignatureModuleHealthService } from './esignature-module-health.service.js';
import { ESignatureNavigationService } from './esignature-navigation.service.js';
import { ESignaturePermissionService } from './esignature-permission.service.js';
import { ESignatureSettingsService } from './esignature-settings.service.js';

export const ESIGNATURE_CONTROLLERS = [ESignatureController] as const;

export const ESIGNATURE_PROVIDERS = [
  // The capability gate, the settings document, the visibility report, the module health view and
  // the single gate that stands in front of every provider operation.
  ESignaturePermissionService,
  ESignatureSettingsService,
  ESignatureNavigationService,
  ESignatureModuleHealthService,
  ESignatureConnectionGate,
] as const;

export { ESignatureController } from './esignature.controller.js';
export {
  ESIGNATURE_OPERATIONS,
  type ESignatureOperation,
  type GateAssessment,
} from './esignature-connection-gate.service.js';
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
export {
  DEFAULT_ESIGNATURE_SETTINGS,
  type ESignatureSettings,
  ESignatureSettingsSchema,
  ESignatureSettingsService,
  type ESignatureSettingsView,
} from './esignature-settings.service.js';
