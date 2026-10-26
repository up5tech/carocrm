/**
 * Phase 19-OM.2 — the module barrel (`PLAN_Phase_19_Omnichannel.md` §14 `19-OM.2`).
 *
 * The repository's module convention: a directory under `apps/api/src/`, an `index.ts` that exports
 * the controller and provider arrays, and one spread in `app.module.ts`. The shell never imports
 * the module's files directly.
 *
 * `OMNICHANNEL_CONTROLLERS` is spread into `AppModule` **before** `ENTITY_CONTROLLERS`: it owns the
 * static `/api/v1/Omnichannel` prefix, and the generic `:entity` wildcard has to stay last so static
 * routes win. `OmnichannelWebhookController` (19-OM.5) answers on the module's webhook prefix and
 * delegates to the shared `VoiceWebhookIngressService` — one receipt pipeline, one dedup rule, no
 * second store (D1/§2.4); its `bootstrap.ts` raw-body entry (extension E2) landed with it.
 */

import type { Provider, Type } from '@nestjs/common';

import { OmnichannelController } from './omnichannel.controller.js';
import { OmnichannelAiService } from './omnichannel-ai.service.js';
import { OmnichannelAiTools } from './omnichannel-ai-tools.js';
import { OmnichannelAnalyticsService } from './omnichannel-analytics.service.js';
import { OmnichannelCallService } from './omnichannel-call.service.js';
import { OmnichannelCapabilityService } from './omnichannel-capability.service.js';
import { OmnichannelChatController } from './omnichannel-chat.controller.js';
import { OmnichannelConversationService } from './omnichannel-conversation.service.js';
import { OmnichannelDataService } from './omnichannel-data.service.js';
import { OmnichannelDraftService } from './omnichannel-draft.service.js';
import { OmnichannelHandoffService } from './omnichannel-handoff.service.js';
import { OmnichannelIdentityService } from './omnichannel-identity.service.js';
import { OmnichannelModuleHealthService } from './omnichannel-module-health.service.js';
import { OmnichannelNavigationService } from './omnichannel-navigation.service.js';
import { OmnichannelOperationsService } from './omnichannel-operations.service.js';
import { OmnichannelPermissionService } from './omnichannel-permission.service.js';
import { OmnichannelRoutingService } from './omnichannel-routing.service.js';
import { noopMenuInvalidator, OMNICHANNEL_MENU_INVALIDATOR, OmnichannelSettingsService } from './omnichannel-settings.service.js';
import { OmnichannelSnippetService } from './omnichannel-snippet.service.js';
import { OmnichannelWebChatTransport } from './omnichannel-webchat.adapter.js';
import { OmnichannelWebChatService } from './omnichannel-webchat.service.js';
import { OmnichannelWebhookController } from './omnichannel-webhook.controller.js';

export const OMNICHANNEL_CONTROLLERS: Type<unknown>[] = [OmnichannelController, OmnichannelChatController, OmnichannelWebhookController];

export const OMNICHANNEL_PROVIDERS: Provider[] = [
  // Default menu-invalidator binding so an isolated boot works; `AppModule` overrides the token
  // with the lazy `NavigationService` resolver (the `CRM_CHAT_MENU_INVALIDATOR` wiring).
  { provide: OMNICHANNEL_MENU_INVALIDATOR, useValue: noopMenuInvalidator },
  // Settings first: the permission-free switch every other service and the kernel gate reads.
  OmnichannelSettingsService,
  OmnichannelPermissionService,
  OmnichannelNavigationService,
  OmnichannelCapabilityService,
  OmnichannelConversationService,
  OmnichannelIdentityService,
  OmnichannelRoutingService,
  OmnichannelCallService,
  OmnichannelAiService,
  OmnichannelAiTools,
  OmnichannelAnalyticsService,
  OmnichannelOperationsService,
  OmnichannelHandoffService,
  OmnichannelDataService,
  OmnichannelSnippetService,
  OmnichannelDraftService,
  OmnichannelWebChatService,
  OmnichannelWebChatTransport,
  OmnichannelModuleHealthService,
];

export type { OmnichannelAiRunView, OmnichannelAiTask } from './omnichannel-ai.service.js';
export { OMNICHANNEL_AI_TASKS } from './omnichannel-ai.service.js';
export type { OmnichannelAnalytics } from './omnichannel-analytics.service.js';
export type { OmnichannelCallView } from './omnichannel-call.service.js';
export type { OmnichannelCapabilityCatalog, OmnichannelChannelCapabilityView, OmnichannelChannelKey } from './omnichannel-capability.service.js';
export { OMNICHANNEL_CAPABILITY_CATALOG_VERSION } from './omnichannel-capability.service.js';
export type { OmnichannelConversationView, OmnichannelThreadView } from './omnichannel-conversation.service.js';
export type { ConversationExport } from './omnichannel-data.service.js';
export type { DraftView } from './omnichannel-draft.service.js';
export type { OmnichannelHandoffResult } from './omnichannel-handoff.service.js';
export type { OmnichannelIdentityCandidateView, OmnichannelIdentityConflict, OmnichannelIdentityReview, OmnichannelParticipantIdentityView } from './omnichannel-identity.service.js';
export type { OmnichannelCapabilityDefinition,OmnichannelCapabilityKey } from './omnichannel-module.js';
export { OMNICHANNEL_CAPABILITIES, OMNICHANNEL_FEATURES, OMNICHANNEL_MODULE } from './omnichannel-module.js';
export type { OmnichannelHealthView } from './omnichannel-module-health.service.js';
export type { OperationsAccountView, OperationsOverview } from './omnichannel-operations.service.js';
export { OmnichannelOperationsService } from './omnichannel-operations.service.js';
export type { MenuInvalidator, OmnichannelSettings, OmnichannelSettingsView } from './omnichannel-settings.service.js';
export { noopMenuInvalidator, OMNICHANNEL_MENU_INVALIDATOR, OmnichannelSettingsService } from './omnichannel-settings.service.js';
export { OMNICHANNEL_WEB_CHAT_ACCOUNT_KEY, OMNICHANNEL_WEB_CHAT_PROVIDER_KEY } from './omnichannel-webchat.adapter.js';
export type { WebChatMessageView, WebChatSessionView } from './omnichannel-webchat.service.js';
