import { AdvancedIntegrationsController } from './advanced-integrations.controller.js';
import { AdvancedIntegrationsHealthService } from './advanced-integrations-health.service.js';
import { AdvancedIntegrationsNavigationService } from './advanced-integrations-navigation.service.js';
import { AdvancedIntegrationsPermissionService } from './advanced-integrations-permission.service.js';
import { AdvancedIntegrationsSettingsService } from './advanced-integrations-settings.service.js';
import { ConflictService } from './conflict.service.js';
import { ConnectionDetailService } from './connection-detail.service.js';
import { ConnectionLifecycleService,CREDENTIAL_VAULT } from './connection-lifecycle.service.js';
import { ConnectorExecutor } from './connector-executor.service.js';
import { EncryptedCredentialVault } from './credential-vault.js';
import { DeadLetterService } from './dead-letter.service.js';
import { ExternalLinkService } from './external-link.service.js';
import { IntegrationRegistry } from './integration-registry.service.js';
import { MappingService } from './mapping.service.js';
import { AdvancedIntegrationsOAuthCallbackController } from './oauth-callback.controller.js';
import { OAuthFlowService } from './oauth-flow.service.js';
import { OutboundSyncService } from './outbound-sync.service.js';
import { RecordOriginService } from './record-origin.service.js';
import { ProviderCircuitBreaker, ProviderRateLimiter } from './resilience.js';
import { SyncOrchestrator } from './sync-orchestrator.service.js';
import { AdvancedIntegrationsWebhookController } from './webhook.controller.js';
import { WebhookIngressService } from './webhook-ingress.service.js';

/**
 * Phase 19-INT.2–19-INT.13 — the module barrel
 * (`PLAN_Phase_19_Advanced_Integrations.md` §5.1; `19-INT.2`).
 *
 * The repository's module convention: a directory under `apps/api/src/`, an `index.ts` that exports
 * the controller and provider arrays, and one spread in `app.module.ts`. The shell never imports
 * the module's files directly.
 *
 * The controller order matters. The static `api/v1/AdvancedIntegrations` prefix must be matched
 * before the generic `/api/v1/:entity` wildcard, and the OAuth callback and webhook prefixes
 * `/api/v1/integrations/advanced-integrations/...` before it too — the same reason
 * `VOICE_COMMUNICATIONS_CONTROLLERS` is spread before `ENTITY_CONTROLLERS`.
 */

export const ADVANCED_INTEGRATIONS_CONTROLLERS = [
  AdvancedIntegrationsController,
  AdvancedIntegrationsOAuthCallbackController,
  AdvancedIntegrationsWebhookController,
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
  // 19-INT.7 — external id links.
  ExternalLinkService,
  // 19-INT.8 — object and field mappings.
  MappingService,
  // 19-INT.9 — the sync engine.
  SyncOrchestrator,
  // 19-INT.10 — conflicts.
  ConflictService,
  // 19-INT.11 — retry, rate limiting, the circuit breaker and dead letters.
  ProviderRateLimiter,
  ProviderCircuitBreaker,
  DeadLetterService,
  // 19-INT.12 — the shared webhook ingress.
  WebhookIngressService,
  // 19-INT.13 — outbound sync and echo prevention.
  RecordOriginService,
  OutboundSyncService,
  // 19-INT.6 / 19-INT.11 — the single path from the engine to a connector.
  ConnectorExecutor,
  // 19-INT.14 — the connector catalog and the connection detail document.
  ConnectionDetailService,
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
export { ConflictService } from './conflict.service.js';
export { ConnectionDetailService } from './connection-detail.service.js';
export { ConnectorExecutor } from './connector-executor.service.js';
export { DeadLetterService } from './dead-letter.service.js';
export { ExternalLinkService } from './external-link.service.js';
export { IntegrationRegistry } from './integration-registry.service.js';
export { MappingService } from './mapping.service.js';
export { OAUTH_CALLBACK_PATH, OAuthFlowService } from './oauth-flow.service.js';
export { OutboundSyncService } from './outbound-sync.service.js';
export { ProviderError } from './provider-error.js';
export { RecordOriginService } from './record-origin.service.js';
export {
  computeRetryDelay,
  decideRetry,
  ProviderCircuitBreaker,
  ProviderRateLimiter,
} from './resilience.js';
export { SyncOrchestrator } from './sync-orchestrator.service.js';
export { WebhookIngressService } from './webhook-ingress.service.js';
export { ADVANCED_INTEGRATIONS_WEBHOOK_PREFIX } from './webhook-prefix.js';
