import type { Provider, Type } from "@nestjs/common";

import { MarketingAudienceService } from "./marketing-audience.service.js";
import { MarketingAutomationController } from "./marketing-automation.controller.js";
import { MarketingAutomationModuleHealthService } from "./marketing-automation-module-health.service.js";
import { MarketingAutomationNavigationService } from "./marketing-automation-navigation.service.js";
import { MarketingProviderRegistry } from "./marketing-automation-provider.js";
import { MarketingAutomationRecords } from "./marketing-automation-records.js";
import { MarketingAutomationSettingsService } from "./marketing-automation-settings.service.js";
import { MarketingAutomationWriteGuardService } from "./marketing-automation-write-guard.service.js";
import { MarketingCampaignService } from "./marketing-campaign.service.js";
import { MarketingCampaignValidationService } from "./marketing-campaign-validation.service.js";
import { MarketingConsentService } from "./marketing-consent.service.js";
import { MarketingEligibilityService } from "./marketing-eligibility.service.js";
import { MarketingPublicTokenService } from "./marketing-public-token.service.js";
import { MarketingSuppressionService } from "./marketing-suppression.service.js";
import { MarketingTemplateService } from "./marketing-template.service.js";

/**
 * Phase 19-MA.1 – 19-MA.5 — Marketing Automation module barrel
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
 * it registers its hooks at `onApplicationBootstrap`, once the records and settings services it reads exist.
 */
export const MARKETING_AUTOMATION_CONTROLLERS: Type<unknown>[] = [MarketingAutomationController];

export const MARKETING_AUTOMATION_PROVIDERS: Provider[] = [
  MarketingAutomationSettingsService,
  MarketingAutomationRecords,
  MarketingProviderRegistry,
  MarketingTemplateService,
  MarketingCampaignValidationService,
  MarketingConsentService,
  MarketingSuppressionService,
  MarketingEligibilityService,
  MarketingPublicTokenService,
  MarketingAudienceService,
  MarketingCampaignService,
  MarketingAutomationModuleHealthService,
  MarketingAutomationNavigationService,
  MarketingAutomationWriteGuardService,
];

export { MARKETING_AUTOMATION_MODULE } from "./marketing-automation-module.js";
