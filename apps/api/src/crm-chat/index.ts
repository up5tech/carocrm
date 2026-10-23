import type { Provider, Type } from '@nestjs/common';

import { CRMChatController } from './crm-chat.controller.js';
import { CRMChatActionService } from './crm-chat-actions.service.js';
import { CRMChatAIAgentsClientService } from './crm-chat-ai-agents-client.service.js';
import { CRMChatAssistantService } from './crm-chat-assistant.service.js';
import { CRMChatCitationService } from './crm-chat-citations.service.js';
import { CRMChatConversationService } from './crm-chat-conversations.service.js';
import { CRMChatCrossModuleService } from './crm-chat-cross-module.service.js';
import { CRMChatFeedbackService } from './crm-chat-feedback.service.js';
import { CRMChatHelpService } from './crm-chat-help.service.js';
import { CRMChatModuleHealthService } from './crm-chat-module-health.service.js';
import { CRMChatObservabilityService } from './crm-chat-observability.service.js';
import { CRMChatPermissionService } from './crm-chat-permission.service.js';
import { CRMChatPolicyService } from './crm-chat-policy.service.js';
import { CRMChatPromptService } from './crm-chat-prompts.service.js';
import { CRMChatQueryService } from './crm-chat-query.service.js';
import { CRMChatSettingsService } from './crm-chat-settings.service.js';
import { CRMChatStreamingService } from './crm-chat-streaming.service.js';
import { CRM_CHAT_MENU_INVALIDATOR, noopMenuInvalidator } from './crm-chat-tokens.js';

export type { CRMChatCapabilitiesView } from './crm-chat.controller.js';
export { CRMChatController } from './crm-chat.controller.js';
export type { CRMChatActionDecision, CRMChatActionView } from './crm-chat-actions.service.js';
export { CRMChatActionService } from './crm-chat-actions.service.js';
export type {
  CrmChatTurnResult,
  CrmChatTurnStatus,
  CrmChatTurnSubmission,
} from './crm-chat-ai-agents-client.service.js';
export { CRMChatAIAgentsClientService } from './crm-chat-ai-agents-client.service.js';
export type { AssistantReadiness } from './crm-chat-assistant.service.js';
export { CRMChatAssistantService } from './crm-chat-assistant.service.js';
export type { CRMChatCitationView } from './crm-chat-citations.service.js';
export { CRMChatCitationService } from './crm-chat-citations.service.js';
export {
  CRM_CHAT_BLOCKED_CAPABILITIES,
  CRM_CHAT_CONTRACT_VERSION,
  CRM_CHAT_ERROR_CODES,
  CRM_CHAT_ROUTES,
  CRM_CHAT_STREAM_EVENTS,
  type CRMChatHttpMethod,
  type CRMChatRouteContract,
} from './crm-chat-contract.js';
export {
  type CRMChatConversationListQuery,
  CRMChatConversationService,
  type CRMChatConversationStatus,
  type CRMChatConversationView,
  type CRMChatMessageListQuery,
  type CRMChatMessagePage,
  type CRMChatMessageView,
} from './crm-chat-conversations.service.js';
export type {
  CRMChatCrossModuleResult,
  CRMChatCrossModuleScenario,
  CRMChatCrossModuleStepResult,
} from './crm-chat-cross-module.service.js';
export { CRMChatCrossModuleService } from './crm-chat-cross-module.service.js';
export type { CRMChatFeedbackInput, CRMChatFeedbackView } from './crm-chat-feedback.service.js';
export { CRMChatFeedbackService } from './crm-chat-feedback.service.js';
export type { HelpSearchResult, HelpSource } from './crm-chat-help.service.js';
export { CRMChatHelpService } from './crm-chat-help.service.js';
export {
  type AssistantStateKey,
  CRM_CHAT_CAPABILITIES,
  CRM_CHAT_FEATURES,
  CRM_CHAT_MODULE,
  CRM_CHAT_OPTIONAL_INTEGRATIONS,
  CRM_CHAT_REQUIRED_CAPABILITIES,
  CRM_CHAT_TABLES,
  type CRMChatCapabilityDefinition,
  type CRMChatCapabilityKey,
  type CRMChatFeatureKey,
  type CRMChatModuleDescriptor,
} from './crm-chat-module.js';
export type { CRMChatModuleHealthView } from './crm-chat-module-health.service.js';
export { CRMChatModuleHealthService } from './crm-chat-module-health.service.js';
export type { CRMChatUsageSummary } from './crm-chat-observability.service.js';
export { CRMChatObservabilityService } from './crm-chat-observability.service.js';
export { CRMChatPermissionService } from './crm-chat-permission.service.js';
export { CRMChatPolicyService } from './crm-chat-policy.service.js';
export type { CRMChatPromptView } from './crm-chat-prompts.service.js';
export { CRMChatPromptService } from './crm-chat-prompts.service.js';
export type { QueryPlan, QueryResult, RecordSummary } from './crm-chat-query.service.js';
export { CRMChatQueryService } from './crm-chat-query.service.js';
export {
  type CRMChatSettings,
  CRMChatSettingsSchema,
  CRMChatSettingsService,
  type CRMChatSettingsView,
  type CRMChatSettingsWarning,
  crmChatSettingsWarnings,
  DEFAULT_CRM_CHAT_SETTINGS,
  effectiveFeatureFlags,
  rawFeatureFlags,
} from './crm-chat-settings.service.js';
export type { CrmChatStreamEvent, CrmChatStreamEventType } from './crm-chat-streaming.service.js';
export { CRMChatStreamingService } from './crm-chat-streaming.service.js';
export { CRM_CHAT_MENU_INVALIDATOR, type MenuInvalidator, noopMenuInvalidator } from './crm-chat-tokens.js';
export { type CRMChatSettingsPatch, CRMChatSettingsPatchSchema } from './dto/crm-chat-shapes.js';

/**
 * `CRMChat` barrel (AGENTS.md §5.1, docs/module-guide.md).
 *
 * `CRM_CHAT_CONTROLLERS` owns the static `/api/v1/CRMChat` prefix and is spread before
 * `ENTITY_CONTROLLERS` in `AppModule`. The provider list contains only the module's own services;
 * everything it depends on — `AclApiService`, `DatabaseService`, `METADATA_STORE`,
 * `REQUEST_SCOPE_TOKEN`, `AIAgentDefinitionService`, `AIAgentsSettingsService` — is registered by the
 * kernel or by the `AIAgents` module. The module owns three tables (citations, feedback, saved prompts),
 * one settings row, no queue, no provider adapter and no model call of its own.
 */
export const CRM_CHAT_CONTROLLERS: Type<unknown>[] = [CRMChatController];

export const CRM_CHAT_PROVIDERS: Provider[] = [
  CRMChatSettingsService,
  CRMChatConversationService,
  CRMChatCitationService,
  CRMChatPermissionService,
  CRMChatPolicyService,
  CRMChatAssistantService,
  CRMChatAIAgentsClientService,
  CRMChatCrossModuleService,
  CRMChatFeedbackService,
  CRMChatHelpService,
  CRMChatObservabilityService,
  CRMChatPromptService,
  CRMChatQueryService,
  CRMChatStreamingService,
  CRMChatActionService,
  CRMChatModuleHealthService,
  // Default seam: an isolated module test has no navigation surface to invalidate. `AppModule`
  // overrides this with `NavigationService.invalidate()`.
  { provide: CRM_CHAT_MENU_INVALIDATOR, useValue: noopMenuInvalidator },
];
