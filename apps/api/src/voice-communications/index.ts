import type { Provider, Type } from "@nestjs/common";

import { LibPhoneNumberNormalizer, PHONE_NORMALIZER } from "./phone-number.js";
import { VoiceCallService } from "./voice-call.service.js";
import { VoiceCallNotificationService } from "./voice-call-notification.service.js";
import { VoiceCommunicationsController } from "./voice-communications.controller.js";
import { VoiceCommunicationsModuleHealthService } from "./voice-communications-module-health.service.js";
import { VoiceCommunicationsNavigationService } from "./voice-communications-navigation.service.js";
import { VoiceCommunicationsSettingsService } from "./voice-communications-settings.service.js";
import { VoiceConsentService } from "./voice-consent.service.js";
import { VoiceContactResolverService } from "./voice-contact-resolver.service.js";
import { VoiceEventProcessorService } from "./voice-event-processor.service.js";
import { VoiceMessagingService } from "./voice-messaging.service.js";
import { VoicePolicyService } from "./voice-policy.service.js";
import { VoiceProviderRegistry } from "./voice-provider.js";
import { VoiceProviderAccountsService } from "./voice-provider-accounts.service.js";
import { VoiceWebhookController } from "./voice-webhook.controller.js";
import { VoiceWebhookIngressService } from "./voice-webhook-ingress.service.js";
import { VoiceWhatsappTemplateService } from "./voice-whatsapp-template.service.js";

/**
 * Phase 19-VC.2 — Voice & Communications module barrel
 * (`PLAN_Phase_19_Voice_Communications.md` §3.3, §15 `19-VC.2`).
 *
 * Like Projects, Sales, Customer Success, Service Desk, Marketing Automation and AI Agents, this is a
 * directory under `apps/api/src` and not a second framework: CRM records use the generic
 * `entity_records` store, and ACL, validation, audit, stream, hooks, jobs, events and search are the
 * kernel's and are **reused, not re-implemented** (AGENTS.md §5.1–§5.2). The audit
 * (`docs/implementation/voice-communications-audit.md` §1) records which kernel piece serves which
 * concern, and this list is the only thing the platform has to load.
 *
 * `VOICE_COMMUNICATIONS_CONTROLLERS` is spread into `AppModule` **before** `ENTITY_CONTROLLERS`: it
 * owns the static `/api/v1/VoiceCommunications` and `/api/v1/integrations/voice-communications`
 * prefixes, and the generic `:entity` wildcard has to stay last so static routes win.
 *
 * Order inside `VOICE_COMMUNICATIONS_PROVIDERS` is registration order: settings first (every other
 * service reads it), then the provider registry, then the services that resolve accounts, then the
 * ingress/processor pair, then the read-only health and navigation reports.
 */
export const VOICE_COMMUNICATIONS_CONTROLLERS: Type<unknown>[] = [
  VoiceCommunicationsController,
  VoiceWebhookController,
];

export const VOICE_COMMUNICATIONS_PROVIDERS: Provider[] = [
  VoiceCommunicationsSettingsService,
  // The active phone-number implementation. `libphonenumber-js` is the maintained default; the
  // conservative fallback stays exported for contract tests and for a deployment that cannot ship
  // the metadata package.
  { provide: PHONE_NORMALIZER, useFactory: () => new LibPhoneNumberNormalizer() },
  VoiceProviderRegistry,
  VoiceProviderAccountsService,
  VoiceCallNotificationService,
  VoiceCallService,
  VoiceMessagingService,
  VoiceWhatsappTemplateService,
  VoiceConsentService,
  VoicePolicyService,
  VoiceContactResolverService,
  VoiceWebhookIngressService,
  VoiceEventProcessorService,
  VoiceCommunicationsModuleHealthService,
  VoiceCommunicationsNavigationService,
];

export { VoiceCallService } from "./voice-call.service.js";
export { VOICE_COMMUNICATIONS_MODULE } from "./voice-communications-module.js";
export { VOICE_FEATURES } from "./voice-communications-module.js";
export { VoiceCommunicationsSettingsService } from "./voice-communications-settings.service.js";
export { VoiceConsentService } from "./voice-consent.service.js";
export { VoiceContactResolverService } from "./voice-contact-resolver.service.js";
export { VoiceEventProcessorService } from "./voice-event-processor.service.js";
export { VoicePolicyService } from "./voice-policy.service.js";
export { FakeVoiceProvider, signFakeWebhook,VoiceProviderRegistry } from "./voice-provider.js";
export { VoiceProviderAccountsService } from "./voice-provider-accounts.service.js";
export { VoiceWebhookIngressService } from "./voice-webhook-ingress.service.js";
