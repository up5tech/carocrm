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

import { Public } from "../auth/auth.guard.js";
import { REQUEST_SCOPE_TOKEN, type RequestScope } from "../common/request-scope.js";
import {
  AudienceMemberRemoveSchema,
  AudienceMembersSchema,
  AudiencePageQuerySchema,
  CampaignCommandBodySchema,
  CampaignDuplicateSchema,
  CampaignTransitionSchema,
  CampaignValidateQuerySchema,
  ConsentRecordSchema,
  ContentPreviewSchema,
  EmptyCommandBodySchema,
  GlobalSendPauseSchema,
  PublicLinkIssueSchema,
  PublicUnsubscribeSchema,
  SettingsPatchSchema,
  SnapshotEntriesQuerySchema,
  SnapshotModeSchema,
  SuppressionAddSchema,
  SuppressionListQuerySchema,
  SuppressionRevokeSchema,
} from "./dto/marketing-automation-shapes.js";
import { MarketingAudienceService } from "./marketing-audience.service.js";
import { MarketingAutomationModuleHealthService } from "./marketing-automation-module-health.service.js";
import { MarketingAutomationNavigationService } from "./marketing-automation-navigation.service.js";
import { MarketingAutomationSettingsService } from "./marketing-automation-settings.service.js";
import { MarketingCampaignService } from "./marketing-campaign.service.js";
import { MarketingConsentService } from "./marketing-consent.service.js";
import { MarketingPublicTokenService } from "./marketing-public-token.service.js";
import { MarketingSuppressionService } from "./marketing-suppression.service.js";
import { MarketingTemplateService } from "./marketing-template.service.js";

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
    @Inject(MarketingAudienceService) private readonly audience: MarketingAudienceService,
    @Inject(MarketingConsentService) private readonly consent: MarketingConsentService,
    @Inject(MarketingSuppressionService) private readonly suppression: MarketingSuppressionService,
    @Inject(MarketingPublicTokenService) private readonly links: MarketingPublicTokenService,
    @Inject(MarketingTemplateService) private readonly templates: MarketingTemplateService,
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

  // ---------------------------------------------------------------------------
  // Template content: preview and revisions (19-MA.6, §5.4, §6.2)
  //
  // Reads and writes go through MarketingTemplateService, whose renderer is allowance-based
  // (§5.4) and whose revisions are immutable; entity CRUD for `MarketingTemplateRevision` stays
  // refused for direct writes by the module write guard (the rows are module-written evidence).
  // ---------------------------------------------------------------------------

  /**
   * Render the linked template as it would go out: subject, sanitized HTML, plain-text fallback,
   * resolved/fallback placeholders and the content findings (§5.4). Optional sample recipient —
   * resolved only if this actor may read it.
   */
  @HttpCode(200)
  @Post("action/campaign/:id/previewContent")
  async campaignPreviewContent(@Param("id") id: string, @Body() body: unknown) {
    const input = parse(ContentPreviewSchema, body);
    return this.templates.previewCampaignContent(id, input);
  }

  /** Seal the current template content into an immutable revision (idempotent for identical content). */
  @HttpCode(200)
  @Post("action/campaign/:id/contentRevision")
  async campaignSealRevision(@Param("id") id: string, @Body() body: unknown) {
    parse(EmptyCommandBodySchema, body);
    return this.templates.sealRevision(id);
  }

  /** The revisions sealed for this campaign's template, newest first. */
  @Get("action/campaign/:id/contentRevisions")
  async campaignContentRevisions(@Param("id") id: string) {
    return this.templates.revisionsForCampaign(id);
  }

  // ---------------------------------------------------------------------------
  // Audience membership, resolution and snapshots (19-MA.4, §5.2)
  //
  // A campaign's *composition* (which audiences it includes and excludes) is managed through the platform's
  // own relation API — `PUT /api/v1/Campaign/:id/includedTargetLists/:listId` — because that path already
  // enforces record ACL on both ends. These routes are for what a relation link cannot express: audited
  // membership of a static audience, resolution, and an immutable snapshot.
  // ---------------------------------------------------------------------------

  /** Who is in an audience, as the caller's ACL can see them, plus how many entries were hidden. */
  @Get("action/segment/:id/members")
  async segmentMembers(@Param("id") id: string, @Query() query: unknown) {
    const page = AudiencePageQuerySchema.parse(coercePage(query));
    return this.audience.members(id, page);
  }

  /** Add records to a static audience. Membership is written as evidence, with who added it and when. */
  @HttpCode(200)
  @Post("action/segment/:id/members")
  async segmentAddMembers(@Param("id") id: string, @Body() body: unknown) {
    const input = parse(AudienceMembersSchema, body);
    return this.audience.addMembers(id, input.members, input.source);
  }

  /** Remove one member. The row is kept and stamped, so the audience's history stays explainable. */
  @HttpCode(200)
  @Post("action/segment/:id/members/remove")
  async segmentRemoveMember(@Param("id") id: string, @Body() body: unknown) {
    const input = parse(AudienceMemberRemoveSchema, body);
    return this.audience.removeMember(id, { entityType: input.entityType, entityId: input.entityId }, input.reason);
  }

  /** Recompute an audience's summary fields. An explicit command, not a side effect of reading. */
  @HttpCode(200)
  @Post("action/segment/:id/refresh")
  async segmentRefresh(@Param("id") id: string) {
    return this.audience.refresh(id);
  }

  /**
   * The campaign's audience resolved and classified (§5.5's dry-run categories), with samples the caller is
   * allowed to read. Counts are computed from the ACL-filtered set, so they cannot disclose records the
   * caller may not see (§9.2).
   */
  @Get("action/campaign/:id/audiencePreview")
  async campaignAudiencePreview(@Param("id") id: string) {
    return this.audience.previewCampaign(id);
  }

  /** Freeze the current composition into an immutable snapshot. A later change creates a new one. */
  @HttpCode(200)
  @Post("action/campaign/:id/audienceSnapshot")
  async campaignAudienceSnapshot(@Param("id") id: string, @Body() body: unknown) {
    const input = parse(SnapshotModeSchema, body);
    return this.audience.snapshot(id, { mode: input.mode });
  }

  /** Snapshot entries by category. Identities are digests, so this never returns an address. */
  @Get("action/snapshot/:id/entries")
  async snapshotEntries(@Param("id") id: string, @Query() query: unknown) {
    const parsed = parse(SnapshotEntriesQuerySchema, coercePage(query));
    return this.audience.snapshotEntries(id, {
      limit: parsed.limit,
      ...(parsed.category !== undefined ? { category: parsed.category } : {}),
    });
  }

  // ---------------------------------------------------------------------------
  // Consent, suppression and public links (19-MA.5, §5.3)
  // ---------------------------------------------------------------------------

  /** Record a consent decision. Every accepted mutation appends history in the same transaction. */
  @HttpCode(200)
  @Post("action/consent")
  async consentRecord(@Body() body: unknown) {
    return this.consent.record(parse(ConsentRecordSchema, body));
  }

  @Get("action/consent/:id")
  async consentGet(@Param("id") id: string) {
    return this.consent.get(id);
  }

  /** The audit trail of one consent decision: prior state, new state, actor, source, reason (§5.3.9). */
  @Get("action/consent/:id/history")
  async consentHistory(@Param("id") id: string) {
    return this.consent.history(id);
  }

  @HttpCode(200)
  @Post("action/suppression")
  async suppressionAdd(@Body() body: unknown) {
    return this.suppression.add(parse(SuppressionAddSchema, body));
  }

  /** Lifting a block is a recorded decision, and only for the reasons an operator may lift (§5.3.8). */
  @HttpCode(200)
  @Post("action/suppression/:id/revoke")
  async suppressionRevoke(@Param("id") id: string, @Body() body: unknown) {
    const input = parse(SuppressionRevokeSchema, body);
    return this.suppression.revoke(id, input.reason);
  }

  @Get("action/suppression")
  async suppressionList(@Query() query: unknown) {
    const parsed = parse(SuppressionListQuerySchema, coercePage(query));
    const emailHash = parsed.emailAddress === undefined
      ? undefined
      : this.consent.identity(parsed.emailAddress) ?? undefined;
    return { list: await this.suppression.list({ ...(emailHash !== undefined ? { emailHash } : {}) }) };
  }

  /** Mint a public unsubscribe / preference / confirmation link for an address. */
  @HttpCode(200)
  @Post("action/publicLink")
  async publicLinkIssue(@Body() body: unknown) {
    const input = parse(PublicLinkIssueSchema, body);
    const emailHash = input.emailHash ?? this.consent.identity(input.emailAddress);
    if (emailHash === null || emailHash === undefined) {
      throw new InvalidQueryError("A public link needs an email address or its identity.");
    }
    return this.links.issue(input.scope, {
      emailHash,
      channel: input.channel,
      ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
      ...(input.campaignId !== undefined ? { campaignId: input.campaignId } : {}),
      ...(input.targetListId !== undefined ? { targetListId: input.targetListId } : {}),
    });
  }

  // ---------------------------------------------------------------------------
  // Public endpoints (19-MA.5, §5.3.1, §8.3)
  //
  // Unauthenticated by design: an opt-out must not require a CRM login. They are deliberately GET/POST
  // pairs — a GET renders the page and changes nothing, because mail clients and link-preview crawlers
  // fetch URLs, and a GET that unsubscribed would silently opt people out of communications they never
  // meant to leave (§5.3.1). Every failure answers the same generic sentence, so the endpoints cannot be
  // used to test whether an address is in the CRM (§15 `19-MA.5` acceptance).
  // ---------------------------------------------------------------------------

  @Public()
  @Get("public/preferences/:token")
  async publicPreferences(@Param("token") token: string) {
    return this.links.preferences(token);
  }

  /** The confirmation page a one-click link opens. It performs nothing. */
  @Public()
  @Get("public/unsubscribe/:token")
  async publicUnsubscribePage(@Param("token") token: string) {
    return this.links.preferences(token);
  }

  /** The deliberate act. Idempotent: pressing it twice is one unsubscribe, reported as such. */
  @Public()
  @HttpCode(200)
  @Post("public/unsubscribe/:token")
  async publicUnsubscribe(@Param("token") token: string, @Body() body: unknown) {
    const input = parse(PublicUnsubscribeSchema, body);
    return this.links.unsubscribe(token, { all: input.all });
  }

  /** Double opt-in confirmation. Its own scope, so an unsubscribe link can never grant consent. */
  @Public()
  @HttpCode(200)
  @Post("public/confirm/:token")
  async publicConfirm(@Param("token") token: string) {
    return this.links.confirmOptIn(token);
  }

  private requireAdmin(action: string): void {
    if (!this.scope.isAdmin) {
      throw new AuthorizationDeniedError(`Administrator access is required for ${action}.`);
    }
  }
}

/** A query string arrives as text, so paging keys are coerced before the schema sees them. */
function coercePage(query: unknown): Record<string, unknown> {
  return typeof query === "object" && query !== null ? (query as Record<string, unknown>) : {};
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
