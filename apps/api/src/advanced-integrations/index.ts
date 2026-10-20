import { AdvancedIntegrationsController } from './advanced-integrations.controller.js';
import { AdvancedIntegrationsHealthService } from './advanced-integrations-health.service.js';
import { AdvancedIntegrationsNavigationService } from './advanced-integrations-navigation.service.js';
import { AdvancedIntegrationsPermissionService } from './advanced-integrations-permission.service.js';
import { AdvancedIntegrationsSettingsService } from './advanced-integrations-settings.service.js';
import { ConflictService } from './conflict.service.js';
import { ConnectionDetailService } from './connection-detail.service.js';
import { ConnectionLifecycleService,CREDENTIAL_VAULT } from './connection-lifecycle.service.js';
import { ConnectorEventHandlerRegistry } from './connector-event-handlers.js';
import { ConnectorExecutor } from './connector-executor.service.js';
import { ConnectorRegistrar } from './connector-registrar.service.js';
import { CustomerSuccessIntegrationContracts } from './contracts/customer-success-contracts.js';
import { MarketingIntegrationContracts } from './contracts/marketing-contracts.js';
import { ProjectsIntegrationContracts } from './contracts/projects-contracts.js';
import { SalesIntegrationContracts } from './contracts/sales-contracts.js';
import { ServiceDeskIntegrationContracts } from './contracts/service-desk-contracts.js';
import { VoiceCommunicationsIntegrationContracts } from './contracts/voice-contracts.js';
import { EncryptedCredentialVault } from './credential-vault.js';
import { DeadLetterService } from './dead-letter.service.js';
import { ENRICHMENT_ADAPTERS,EnrichmentService } from './enrichment.service.js';
import { ExternalLinkService } from './external-link.service.js';
import { IntegrationAuditService } from './integration-audit.service.js';
import { IntegrationContractRegistry } from './integration-contracts.js';
import { IntegrationEventPublisher } from './integration-events.js';
import { IntegrationMetricsService } from './integration-metrics.service.js';
import { IntegrationRegistry } from './integration-registry.service.js';
import { IntegrationRetentionService } from './integration-retention.service.js';
import { MailchimpConsentBridge } from './mailchimp-consent.bridge.js';
import { MappingService } from './mapping.service.js';
import { AdvancedIntegrationsOAuthCallbackController } from './oauth-callback.controller.js';
import { OAuthFlowService } from './oauth-flow.service.js';
import { OutboundSyncService } from './outbound-sync.service.js';
import { RecordOriginService } from './record-origin.service.js';
import { ProviderCircuitBreaker, ProviderRateLimiter } from './resilience.js';
import { StripePaymentBridge } from './stripe-payment.bridge.js';
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
  // 19-INT.16–19-INT.24 — the delivered connectors. The registrar is code-registered, so a
  // capability can never drift from the adapter that implements it.
  ConnectorRegistrar,
  // 19-INT.19 / 19-INT.20 — the cross-module bridges that claim a provider event for the domain
  // that owns it. They are optional: a deployment without Sales or Marketing Automation still
  // loads this module.
  ConnectorEventHandlerRegistry,
  StripePaymentBridge,
  MailchimpConsentBridge,
  // 19-INT.25 — the cross-module contracts. Each adapter publishes the contracts of the module
  // it belongs to, and each is optional: a deployment without that module publishes none of them.
  IntegrationContractRegistry,
  SalesIntegrationContracts,
  MarketingIntegrationContracts,
  CustomerSuccessIntegrationContracts,
  ProjectsIntegrationContracts,
  ServiceDeskIntegrationContracts,
  VoiceCommunicationsIntegrationContracts,
  // 19-INT.25 — the integration events, published through the platform's transactional outbox.
  IntegrationEventPublisher,
  // 19-INT.26 — the module's own audit trail, the derived metrics and the retention policy.
  IntegrationAuditService,
  IntegrationMetricsService,
  IntegrationRetentionService,
  // 19-INT.24 — the bounded enrichment service: profiles, preview, accept, reject, quota.
  EnrichmentService,
  {
    // The enrichment providers. The token exists so a test can substitute a provider that never
    // opens a socket, and so a second provider can be added without touching the service.
    provide: ENRICHMENT_ADAPTERS,
    useValue: [],
  },
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
export { ConnectorEventHandlerRegistry } from './connector-event-handlers.js';
export { ConnectorExecutor } from './connector-executor.service.js';
export { ConnectorRegistrar } from './connector-registrar.service.js';
export { DeadLetterService } from './dead-letter.service.js';
export { EnrichmentService } from './enrichment.service.js';
export { ExternalLinkService } from './external-link.service.js';
export { IntegrationAuditService } from './integration-audit.service.js';
export { IntegrationContractRegistry } from './integration-contracts.js';
export { IntegrationEventPublisher } from './integration-events.js';
export { IntegrationMetricsService } from './integration-metrics.service.js';
export { IntegrationRegistry } from './integration-registry.service.js';
export { IntegrationRetentionService } from './integration-retention.service.js';
export { MailchimpConsentBridge } from './mailchimp-consent.bridge.js';
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
export { StripePaymentBridge } from './stripe-payment.bridge.js';
export { SyncOrchestrator } from './sync-orchestrator.service.js';
export { WebhookIngressService } from './webhook-ingress.service.js';
export { ADVANCED_INTEGRATIONS_WEBHOOK_PREFIX } from './webhook-prefix.js';
