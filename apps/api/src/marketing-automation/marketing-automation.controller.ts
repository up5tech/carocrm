import { AuthorizationDeniedError, InvalidQueryError } from "@carocrm/core/errors/index.js";
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { type ZodTypeAny } from "zod";

import { REQUEST_SCOPE_TOKEN, type RequestScope } from "../common/request-scope.js";
import {
  CampaignCommandBodySchema,
  CampaignDuplicateSchema,
  CampaignTransitionSchema,
  CampaignValidateQuerySchema,
  GlobalSendPauseSchema,
  SettingsPatchSchema,
} from "./dto/marketing-automation-shapes.js";
import { MarketingAutomationModuleHealthService } from "./marketing-automation-module-health.service.js";
import { MarketingAutomationNavigationService } from "./marketing-automation-navigation.service.js";
import { MarketingAutomationSettingsService } from "./marketing-automation-settings.service.js";
import { MarketingCampaignService } from "./marketing-campaign.service.js";

/**
 * Phase 19-MA.1/MA.3 — the `MarketingAutomation` command surface
 * (PLAN_Phase_19_Marketing_Automation.md §8.1–§8.4, §15 `19-MA.1`, `19-MA.3`).
 *
 * Entity CRUD stays on the generic `/api/v1/:entity` API — a campaign and a target list are metadata
 * records, and the Entity Engine already serves list/detail/create/edit/delete for them with ACL, field
 * validation, audit, stream and search. These routes exist only for what a single record cannot express:
 * module diagnostics, the settings document, the visibility signal for navigation, the global emergency
 * stop, and the **campaign state machine** with its send-readiness gate (§5.1). Every one of them validates
 * server-side; this controller parses shape and nothing else (§8.4).
 *
 * Registered before `ENTITY_CONTROLLERS`, so the static `MarketingAutomation` prefix can never be swallowed
 * by the generic `:entity` wildcard (AGENTS.md §5.4, docs/module-guide.md).
 */
@ApiTags("marketing-automation")
@Controller("api/v1/MarketingAutomation")
export class MarketingAutomationController {
  constructor(
    @Inject(MarketingAutomationModuleHealthService) private readonly health: MarketingAutomationModuleHealthService,
    @Inject(MarketingAutomationSettingsService) private readonly settings: MarketingAutomationSettingsService,
    @Inject(MarketingAutomationNavigationService) private readonly navigation: MarketingAutomationNavigationService,
    @Inject(MarketingCampaignService) private readonly campaigns: MarketingCampaignService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  // ---------------------------------------------------------------------------
  // Module surface (19-MA.1)
  // ---------------------------------------------------------------------------

  @Get("action/health")
  async moduleHealth() {
    this.requireAdmin("module diagnostics");
    return this.health.health();
  }

  @Get("action/settings")
  async readSettings() {
    return this.settings.read();
  }

  @HttpCode(200)
  @Post("action/settings")
  async updateSettings(@Body() body: unknown) {
    this.requireAdmin("changing Marketing Automation settings");
    parse(SettingsPatchSchema, body);
    return this.settings.update(body);
  }

  /** ACL-scoped visibility for the SPA's Marketing submenu — a report, never a gate (§9.2). */
  @Get("action/nav")
  async navigationVisibility() {
    return this.navigation.visibility();
  }

  /**
   * The §13 global emergency stop. Administrator-only: it halts every marketing send in the deployment, so
   * it must not be reachable by whoever happens to own a campaign — and lifting it is equally attributable.
   */
  @HttpCode(200)
  @Post("action/globalSendPause")
  async globalSendPause(@Body() body: unknown) {
    this.requireAdmin("stopping all marketing sending");
    const input = parse(GlobalSendPauseSchema, body);
    return this.settings.setGlobalSendPaused(input.paused, input.reason);
  }

  // ---------------------------------------------------------------------------
  // Campaign lifecycle (19-MA.3, §5.1, §8.2)
  // ---------------------------------------------------------------------------

  /** The status, the commands this actor may run, and the current send-readiness report. */
  @Get("action/campaign/:id/capabilities")
  async campaignCapabilities(@Param("id") id: string) {
    return this.campaigns.capabilities(id);
  }

  /** Who moved this campaign where, when, why, and under which validation report. */
  @Get("action/campaign/:id/history")
  async campaignHistory(@Param("id") id: string) {
    return this.campaigns.history(id);
  }

  /**
   * The validation report — blocking findings and warnings separately (§8.4). `?as=Scheduled` asks the
   * question the schedule button is about, so an operator sees the refusal before pressing it.
   */
  @HttpCode(200)
  @Post("action/campaign/:id/validate")
  async campaignValidate(@Param("id") id: string, @Query() query: unknown) {
    const parsed = parse(CampaignValidateQuerySchema, coerceQuery(query));
    return this.campaigns.validate(id, parsed.as === undefined ? {} : { as: parsed.as });
  }

  /** One endpoint for the whole state machine, for callers that already know the command. */
  @HttpCode(200)
  @Post("action/campaign/:id/transition")
  async campaignTransition(@Param("id") id: string, @Body() body: unknown) {
    return this.campaigns.transition(id, parse(CampaignTransitionSchema, body));
  }

  @HttpCode(200)
  @Post("action/campaign/:id/schedule")
  async campaignSchedule(@Param("id") id: string, @Body() body: unknown) {
    return this.campaigns.run(id, "schedule", parse(CampaignCommandBodySchema, body));
  }

  @HttpCode(200)
  @Post("action/campaign/:id/unschedule")
  async campaignUnschedule(@Param("id") id: string, @Body() body: unknown) {
    return this.campaigns.run(id, "unschedule", parse(CampaignCommandBodySchema, body));
  }

  @HttpCode(200)
  @Post("action/campaign/:id/start")
  async campaignStart(@Param("id") id: string, @Body() body: unknown) {
    return this.campaigns.run(id, "start", parse(CampaignCommandBodySchema, body));
  }

  @HttpCode(200)
  @Post("action/campaign/:id/pause")
  async campaignPause(@Param("id") id: string, @Body() body: unknown) {
    return this.campaigns.run(id, "pause", parse(CampaignCommandBodySchema, body));
  }

  @HttpCode(200)
  @Post("action/campaign/:id/resume")
  async campaignResume(@Param("id") id: string, @Body() body: unknown) {
    return this.campaigns.run(id, "resume", parse(CampaignCommandBodySchema, body));
  }

  @HttpCode(200)
  @Post("action/campaign/:id/complete")
  async campaignComplete(@Param("id") id: string, @Body() body: unknown) {
    return this.campaigns.run(id, "complete", parse(CampaignCommandBodySchema, body));
  }

  /** Stops the campaign and its messages; the only command that requires a reason (§10.2). */
  @HttpCode(200)
  @Post("action/campaign/:id/cancel")
  async campaignCancel(@Param("id") id: string, @Body() body: unknown) {
    return this.campaigns.run(id, "cancel", parse(CampaignCommandBodySchema, body));
  }

  @HttpCode(200)
  @Post("action/campaign/:id/archive")
  async campaignArchive(@Param("id") id: string, @Body() body: unknown) {
    return this.campaigns.run(id, "archive", parse(CampaignCommandBodySchema, body));
  }

  /**
   * Duplicate as a fresh Draft. Delivery history, recipient state, live enrollments and provider
   * identifiers are not copied and are not options a caller can ask for (§5.1).
   */
  @HttpCode(200)
  @Post("action/campaign/:id/duplicateAsDraft")
  async campaignDuplicate(@Param("id") id: string, @Body() body: unknown) {
    return this.campaigns.duplicateAsDraft(id, parse(CampaignDuplicateSchema, body));
  }

  private requireAdmin(action: string): void {
    if (!this.scope.isAdmin) {
      throw new AuthorizationDeniedError(`Administrator access is required for ${action}.`);
    }
  }
}

/** A query string arrives as text; the optional status is the only key this endpoint reads. */
function coerceQuery(query: unknown): unknown {
  if (typeof query !== "object" || query === null) return {};
  return { as: (query as Record<string, unknown>)["as"] };
}

function parse<T extends ZodTypeAny>(schema: T, body: unknown): T["_output"] {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    throw new InvalidQueryError("The request is not valid.", {
      issues: parsed.error.issues.map((issue) => issue.message),
    });
  }
  return parsed.data;
}
