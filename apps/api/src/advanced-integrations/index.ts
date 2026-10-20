import { AdvancedIntegrationsController } from './advanced-integrations.controller.js';
import { AdvancedIntegrationsHealthService } from './advanced-integrations-health.service.js';
import { AdvancedIntegrationsNavigationService } from './advanced-integrations-navigation.service.js';
import { AdvancedIntegrationsPermissionService } from './advanced-integrations-permission.service.js';
import { AdvancedIntegrationsSettingsService } from './advanced-integrations-settings.service.js';
import { ConnectionLifecycleService,CREDENTIAL_VAULT } from './connection-lifecycle.service.js';
import { EncryptedCredentialVault } from './credential-vault.js';
import { IntegrationRegistry } from './integration-registry.service.js';
import { AdvancedIntegrationsOAuthCallbackController } from './oauth-callback.controller.js';
import { OAuthFlowService } from './oauth-flow.service.js';

/**
 * Phase 19-INT.2 — the module barrel
 * (`PLAN_Phase_19_Advanced_Integrations.md` §5.1; `19-INT.2`).
 *
 * The repository's module convention: a directory under `apps/api/src/`, an `index.ts` that exports
 * the controller and provider arrays, and one spread in `app.module.ts`. The shell never imports
 * the module's files directly.
 *
 * The controller order matters. The static `api/v1/AdvancedIntegrations` prefix must be matched
 * before the generic `/api/v1/:entity` wildcard, and the OAuth callback prefix
 * `/api/v1/integrations/advanced-integrations/...` before it too — the same reason
 * `VOICE_COMMUNICATIONS_CONTROLLERS` is spread before `ENTITY_CONTROLLERS`.
 */

export const ADVANCED_INTEGRATIONS_CONTROLLERS = [
  AdvancedIntegrationsController,
  AdvancedIntegrationsOAuthCallbackController,
] as const;

export const ADVANCED_INTEGRATIONS_PROVIDERS = [
  AdvancedIntegrationsPermissionService,
  AdvancedIntegrationsSettingsService,
  AdvancedIntegrationsNavigationService,
  AdvancedIntegrationsHealthService,
  IntegrationRegistry,
  ConnectionLifecycleService,
  OAuthFlowService,
  // The vault is bound to a token so a test can substitute a fake vault without touching the
  // domain (ADR 0001).
  { provide: CREDENTIAL_VAULT, useClass: EncryptedCredentialVault },
] as const;

export {
  ADVANCED_INTEGRATIONS_MODULE_KEY,
  assertCallable,
  assertTransition,
  canTransition,
  CONNECTION_STATUSES,
  CONNECTION_TRANSITIONS,
  INTEGRATION_CONNECTION_PERMISSION_ENTITY,
  INTEGRATION_CREDENTIAL_PERMISSION_ENTITY,
  INTEGRATION_PERMISSION_ENTITY,
  INTEGRATION_PROVIDER_PERMISSION_ENTITY,
  INTEGRATION_SETTINGS_PERMISSION_ENTITY,
  redactSecrets,
  secretHint,
} from './advanced-integrations-domain.js';
export {
  ADVANCED_INTEGRATIONS_CAPABILITIES,
  ADVANCED_INTEGRATIONS_SETTINGS_KEY,
} from './advanced-integrations-module.js';
export { IntegrationRegistry } from './integration-registry.service.js';
export { OAUTH_CALLBACK_PATH,OAuthFlowService } from './oauth-flow.service.js';
