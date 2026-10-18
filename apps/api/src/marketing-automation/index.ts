import type { Provider, Type } from "@nestjs/common";

import { MarketingAttributionService } from "./marketing-attribution.service.js";
import { MarketingAudienceService } from "./marketing-audience.service.js";
import { MarketingAutomationController } from "./marketing-automation.controller.js";
import { MarketingAutomationModuleHealthService } from "./marketing-automation-module-health.service.js";
import { MarketingAutomationNavigationService } from "./marketing-automation-navigation.service.js";
import { MarketingProviderRegistry } from "./marketing-automation-provider.js";
import { MarketingAutomationRecords } from "./marketing-automation-records.js";
import { MarketingAutomationSettingsService } from "./marketing-automation-settings.service.js";
import { MarketingAutomationWriteGuardService } from "./marketing-automation-write-guard.service.js";
import { MarketingCampaignService } from "./marketing-campaign.service.js";
import { MarketingCampaignLogService } from "./marketing-campaign-log.service.js";
import { MarketingCampaignValidationService } from "./marketing-campaign-validation.service.js";
import { MarketingConsentService } from "./marketing-consent.service.js";
import { MarketingDeliveryBatchService } from "./marketing-delivery-batch.service.js";
import { MarketingDeliveryLedger } from "./marketing-delivery-ledger.js";
import { MarketingEligibilityService } from "./marketing-eligibility.service.js";
import { MarketingEventIngestionService } from "./marketing-event-ingestion.service.js";
import { MarketingFormService } from "./marketing-form.service.js";
import { MarketingIntegrationService } from "./marketing-integration.service.js";
import { MarketingJourneyActionService } from "./marketing-journey-action.service.js";
import { MarketingJourneyDefinitionService } from "./marketing-journey-definition.service.js";
import { MarketingJourneyRuntimeService } from "./marketing-journey-runtime.service.js";
import { MarketingJourneyTriggerService } from "./marketing-journey-trigger.service.js";
import { MarketingOperationsService } from "./marketing-operations.service.js";
import { MarketingProviderBindingService } from "./marketing-provider-binding.service.js";
import { MarketingProviderLimiter } from "./marketing-provider-limiter.js";
import { MarketingPublicTokenService } from "./marketing-public-token.service.js";
import { MarketingRetentionService } from "./marketing-retention.service.js";
import { MarketingSendService } from "./marketing-send.service.js";
import { MarketingSuppressionService } from "./marketing-suppression.service.js";
import { MarketingTemplateService } from "./marketing-template.service.js";
import { MarketingTestSendService } from "./marketing-test-send.service.js";

/**
 * Phase 19-MA.1 – 19-MA.7 — Marketing Automation module barrel
 * (PLAN_Phase_19_Marketing_Automation.md §7.1, §15 `19-MA.1`).
 *
 * Like Projects, Sales, Customer Success and Service Desk, this is a directory under `apps/api/src` and not
 * a second framework: records use the generic `entity_records` store, and ACL, validation, audit, stream,
 * attachments, hooks, jobs, search, mail transport and reporting are the kernel's and are **reused, not
 * re-implemented** (AGENTS.md §5.1–§5.2, plan §0.1 rule 2). The audit
 * (`docs/implementation/marketing-automation-audit.md` §2) records which kernel piece serves which
 * marketing concern, and this list is the only thing the platform has to load.
 *
 * `MARKETING_AUTOMATION_CONTROLLERS` is spread into `AppModule` **before** `ENTITY_CONTROLLERS`: this
 * controller owns the static `/api/v1/MarketingAutomation` prefix, and the generic `:entity` wildcard has to
 * stay last so static routes win.
 *
 * Order inside `MARKETING_AUTOMATION_PROVIDERS` is the registration order; the write guard is last because
 * it registers its hooks at `onApplicationBootstrap`, once the records and settings services it reads exist,
 * and `MarketingProviderBindingService` (MA.7) sits next to the registry it fills at module init.
 */
export const MARKETING_AUTOMATION_CONTROLLERS: Type<unknown>[] = [MarketingAutomationController];

export const MARKETING_AUTOMATION_PROVIDERS: Provider[] = [
  MarketingAutomationSettingsService,
  MarketingAutomationRecords,
  MarketingProviderRegistry,
  // The live adapter is bound at bootstrap (MA.7); the limiter is the one ceiling both the test send and,
  // later, the delivery worker share (§5.8, §11.2).
  MarketingProviderBindingService,
  MarketingProviderLimiter,
  MarketingTemplateService,
  MarketingCampaignValidationService,
  MarketingConsentService,
  MarketingSuppressionService,
  MarketingEligibilityService,
  MarketingJourneyDefinitionService,
  MarketingJourneyActionService,
  MarketingJourneyRuntimeService,
  MarketingJourneyTriggerService,
  MarketingFormService,
  MarketingIntegrationService,
  MarketingAttributionService,
  MarketingRetentionService,
  MarketingOperationsService,
  MarketingPublicTokenService,
  MarketingAudienceService,
  MarketingCampaignService,
  MarketingCampaignLogService,
  // MA.8: the delivery ledger is the send service's storage — one row per resolved recipient — and the send
  // service itself owns the definition, the dry run, the approval and the transitions.
  MarketingDeliveryLedger,
  MarketingDeliveryBatchService,
  MarketingEventIngestionService,
  MarketingSendService,
  MarketingTestSendService,
  MarketingAutomationModuleHealthService,
  MarketingAutomationNavigationService,
  MarketingAutomationWriteGuardService,
];

export { MARKETING_AUTOMATION_MODULE } from "./marketing-automation-module.js";
