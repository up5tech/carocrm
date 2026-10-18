import { AuthorizationDeniedError, InvalidQueryError } from "@carocrm/core/errors/index.js";
import {
  Body,
  Controller,
  Get,
  Headers,
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
  RunScheduledBatchSchema,
  SendApprovalSchema,
  SendCommandBodySchema,
  SendCreateSchema,
  SendRecipientsQuerySchema,
  SendRevokeApprovalSchema,
  SendTransitionSchema,
  SettingsPatchSchema,
  SnapshotEntriesQuerySchema,
  SnapshotModeSchema,
  SuppressionAddSchema,
  SuppressionListQuerySchema,
  SuppressionRevokeSchema,
  TestSendSchema,
} from "./dto/marketing-automation-shapes.js";
import { MarketingAttributionService } from "./marketing-attribution.service.js";
import { MarketingAudienceService } from "./marketing-audience.service.js";
import { MarketingAutomationModuleHealthService } from "./marketing-automation-module-health.service.js";
import { MarketingAutomationNavigationService } from "./marketing-automation-navigation.service.js";
import { MarketingAutomationSettingsService } from "./marketing-automation-settings.service.js";
import { MarketingCampaignService } from "./marketing-campaign.service.js";
import { MarketingCampaignLogService } from "./marketing-campaign-log.service.js";
import { MarketingConsentService } from "./marketing-consent.service.js";
import { MarketingDeliveryBatchService } from "./marketing-delivery-batch.service.js";
import { MarketingEventIngestionService } from "./marketing-event-ingestion.service.js";
import { MarketingFormService } from "./marketing-form.service.js";
import { MarketingIntegrationService } from "./marketing-integration.service.js";
import { MarketingJourneyDefinitionService } from "./marketing-journey-definition.service.js";
import { MarketingJourneyRuntimeService } from "./marketing-journey-runtime.service.js";
import { MarketingJourneyTriggerService } from "./marketing-journey-trigger.service.js";
import { MarketingOperationsService } from "./marketing-operations.service.js";
import { MarketingPublicTokenService } from "./marketing-public-token.service.js";
import { MarketingRetentionService } from "./marketing-retention.service.js";
import { MarketingSendService } from "./marketing-send.service.js";
import { MarketingSuppressionService } from "./marketing-suppression.service.js";
import { MarketingTemplateService } from "./marketing-template.service.js";
import { MarketingTestSendService } from "./marketing-test-send.service.js";

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
    @Inject(MarketingTestSendService) private readonly testSends: MarketingTestSendService,
    @Inject(MarketingSendService) private readonly sends: MarketingSendService,
    @Inject(MarketingCampaignLogService) private readonly campaignLogs: MarketingCampaignLogService,
    @Inject(MarketingJourneyDefinitionService) private readonly journeys: MarketingJourneyDefinitionService,
    @Inject(MarketingJourneyRuntimeService) private readonly journeyRuntime: MarketingJourneyRuntimeService,
    @Inject(MarketingJourneyTriggerService) private readonly journeyTriggers: MarketingJourneyTriggerService,
    @Inject(MarketingFormService) private readonly forms: MarketingFormService,
    @Inject(MarketingIntegrationService) private readonly integration: MarketingIntegrationService,
    @Inject(MarketingAttributionService) private readonly attribution: MarketingAttributionService,
    @Inject(MarketingRetentionService) private readonly retention: MarketingRetentionService,
    @Inject(MarketingOperationsService) private readonly operations: MarketingOperationsService,
    @Inject(MarketingDeliveryBatchService) private readonly deliveryBatch: MarketingDeliveryBatchService,
    @Inject(MarketingEventIngestionService) private readonly eventIngestion: MarketingEventIngestionService,
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

  /** Campaign event log (MA.11): normalized provider events with filters. */
  @Get("action/campaign/:id/log")
  async campaignLog(@Param("id") id: string, @Query() query: unknown) {
    const q = typeof query === "object" && query !== null ? (query as Record<string, unknown>) : {};
    return this.campaignLogs.log({
      campaignId: id,
      ...(typeof q["type"] === "string" ? { normalizedType: q["type"] } : {}),
      ...(q["limit"] !== undefined ? { limit: Number(q["limit"]) } : {}),
      ...(q["offset"] !== undefined ? { offset: Number(q["offset"]) } : {}),
    });
  }

  /** Campaign statistics (MA.11): counts by normalized event type, with as-of timestamp. */
  @Get("action/campaign/:id/stats")
  async campaignStats(@Param("id") id: string) {
    return this.campaignLogs.stats(id);
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

  /**
   * Send one clearly marked test message to explicitly named, administrator-allowlisted addresses
   * (19-MA.7, §8.2, §10.2, §10.5). The campaign's status, history, snapshots and metrics are untouched: a
   * test send is evidence about the provider, not a campaign send (§15 acceptance). The response carries the
   * provider's classified per-recipient result — never a credential or a raw provider body (§9.3).
   */
  @HttpCode(200)
  @Post("action/campaign/:id/sendTest")
  async campaignSendTest(@Param("id") id: string, @Body() body: unknown) {
    return this.testSends.send(id, parse(TestSendSchema, body));
  }

  // ---------------------------------------------------------------------------
  // Send definition, dry run, approval and transitions (19-MA.8, §5.5, §5.6, §8.2)
  //
  // A send is the record of a decision — content revision, frozen audience, validation hash, approval — and
  // these routes are that decision's whole surface. Entity CRUD for `MarketingSend` is refused by the module
  // write guard (§9.2): a send a client could create or edit would be a campaign send somebody authorised by
  // hand. Nothing here hands a recipient to a provider; that is MA.9's queue.
  // ---------------------------------------------------------------------------

  /** Define a send (a message within the campaign) in a numbered slot. */
  @HttpCode(200)
  @Post("action/campaign/:id/sends")
  async campaignSendCreate(@Param("id") id: string, @Body() body: unknown) {
    return this.sends.create(id, parse(SendCreateSchema, body));
  }

  /** The campaign's sends, with each one's decision state, ledger totals and allowed commands. */
  @Get("action/campaign/:id/sends")
  async campaignSendList(@Param("id") id: string) {
    return this.sends.list(id);
  }

  /** One send: approval state, content revision, snapshot, recipient totals and the stored dry-run report. */
  @Get("action/send/:id")
  async sendGet(@Param("id") id: string) {
    return this.sends.get(id);
  }

  /** Why this send moved where it moved: the command, the actor, the reason and the hashes. */
  @Get("action/send/:id/history")
  async sendHistory(@Param("id") id: string) {
    return this.sends.history(id);
  }

  /**
   * The §5.5 dry run: who would be included, how many per category, and the reason each category exists —
   * including the campaign's own findings and the approval state. It writes nothing, so it is safe to ask as
   * often as an operator likes, and it is refused for a caller who cannot read the campaign.
   */
  @HttpCode(200)
  @Post("action/send/:id/dryRun")
  async sendDryRun(@Param("id") id: string, @Body() body: unknown) {
    parse(EmptyCommandBodySchema, body);
    return this.sends.dryRun(id);
  }

  /**
   * Freeze the decision: seal the content revision, freeze the audience snapshot for this send, materialise
   * the recipient ledger, record the validation hash and clear any previous approval (§5.5).
   */
  @HttpCode(200)
  @Post("action/send/:id/validate")
  async sendValidate(@Param("id") id: string, @Body() body: unknown) {
    parse(EmptyCommandBodySchema, body);
    return this.sends.validate(id);
  }

  /** Approve the exact facts that were validated, attributed to the person who accepted them. */
  @HttpCode(200)
  @Post("action/send/:id/approve")
  async sendApprove(@Param("id") id: string, @Body() body: unknown) {
    return this.sends.approve(id, parse(SendApprovalSchema, body));
  }

  /** Withdraw an approval; the send returns to `Draft` with the reason recorded. */
  @HttpCode(200)
  @Post("action/send/:id/revokeApproval")
  async sendRevokeApproval(@Param("id") id: string, @Body() body: unknown) {
    return this.sends.revokeApproval(id, parse(SendRevokeApprovalSchema, body));
  }

  /**
   * One endpoint for the whole send state machine, for callers that already know the command. A bare target
   * status is refused rather than guessed: `Scheduled` is reachable by `schedule` alone, but `Queued` is
   * reachable by both `queue` and `resume`, and picking one for the caller would skip the gate the other one
   * applies (§8.2).
   */
  @HttpCode(200)
  @Post("action/send/:id/transition")
  async sendTransition(@Param("id") id: string, @Body() body: unknown) {
    const input = parse(SendTransitionSchema, body);
    if (input.command === undefined) {
      throw new InvalidQueryError(
        "A send transition must name the command that owns the move (schedule, queue, pause, resume, cancel, complete), so its checks cannot be skipped.",
      );
    }
    return this.sends.run(id, input.command, input);
  }

  @HttpCode(200)
  @Post("action/send/:id/schedule")
  async sendSchedule(@Param("id") id: string, @Body() body: unknown) {
    return this.sends.run(id, "schedule", parse(SendCommandBodySchema, body));
  }

  /** Hand the send to the delivery runtime (MA.9). Requires a live provider and a lifted global stop. */
  @HttpCode(200)
  @Post("action/send/:id/queue")
  async sendQueue(@Param("id") id: string, @Body() body: unknown) {
    return this.sends.run(id, "queue", parse(SendCommandBodySchema, body));
  }

  @HttpCode(200)
  @Post("action/send/:id/pause")
  async sendPause(@Param("id") id: string, @Body() body: unknown) {
    return this.sends.run(id, "pause", parse(SendCommandBodySchema, body));
  }

  @HttpCode(200)
  @Post("action/send/:id/resume")
  async sendResume(@Param("id") id: string, @Body() body: unknown) {
    return this.sends.run(id, "resume", parse(SendCommandBodySchema, body));
  }

  /** Stops the send's remaining messages; the only command that requires a reason (§10.2). */
  @HttpCode(200)
  @Post("action/send/:id/cancel")
  async sendCancel(@Param("id") id: string, @Body() body: unknown) {
    return this.sends.run(id, "cancel", parse(SendCommandBodySchema, body));
  }

  @HttpCode(200)
  @Post("action/send/:id/complete")
  async sendComplete(@Param("id") id: string, @Body() body: unknown) {
    return this.sends.run(id, "complete", parse(SendCommandBodySchema, body));
  }

  /**
   * Run the delivery batch for a send (MA.9). Claims and sends a bounded chunk of eligible
   * recipients through the delivery ledger. Requires a live provider and the global send pause to be
   * lifted. Admin-only: only an administrator may trigger delivery for a send.
   */
  @HttpCode(200)
  @Post("action/delivery/run-scheduled-batch")
  async runScheduledBatch(@Body() body: unknown) {
    this.requireAdmin("running delivery batch");
    const input = parse(RunScheduledBatchSchema, body);
    return this.deliveryBatch.run(input.sendId, input.slot);
  }

  /**
   * The recipient ledger of a send: state, forecast category and reasons, with records this caller may not
   * read counted rather than named (§9.2).
   */
  @Get("action/send/:id/recipients")
  async sendRecipients(@Param("id") id: string, @Query() query: unknown) {
    const parsed = parse(SendRecipientsQuerySchema, coercePage(query));
    return this.sends.recipients(id, {
      limit: parsed.limit,
      offset: parsed.offset,
      ...(parsed.state !== undefined ? { state: parsed.state } : {}),
    });
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

  @Public()
  @HttpCode(200)
  @Post("webhook/:providerKey")
  async providerWebhook(
    @Param("providerKey") providerKey: string,
    @Body() body: unknown,
    @Headers("x-webhook-signature") signature?: string,
    @Headers("x-webhook-timestamp") timestamp?: string,
  ) {
    const secret = process.env.MARKETING_WEBHOOK_SECRET ?? "dev-marketing-webhook-secret";
    return this.eventIngestion.ingest({
      provider: providerKey,
      signature,
      timestamp,
      secret,
      payload: (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>,
    });
  }

  @Public()
  @HttpCode(200)
  @Post("webhooks/:providerKey")
  async providerWebhooksAlias(
    @Param("providerKey") providerKey: string,
    @Body() body: unknown,
    @Headers("x-webhook-signature") signature?: string,
    @Headers("x-webhook-timestamp") timestamp?: string,
  ) {
    return this.providerWebhook(providerKey, body, signature, timestamp);
  }

  @HttpCode(200)
  @Post("action/journey/:id/validate")
  async journeyValidate(@Param("id") _id: string, @Body() body: unknown) {
    const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    const graph = b["graph"] ?? b;
    return this.journeys.validate(graph);
  }

  @HttpCode(200)
  @Post("action/journey/:id/publish")
  async journeyPublish(@Param("id") id: string, @Body() body: unknown) {
    const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    const graph = b["graph"] ?? b;
    const releaseNotes = typeof b["releaseNotes"] === "string" ? b["releaseNotes"] : undefined;
    return this.journeys.publish(id, graph, releaseNotes, this.scope.userId);
  }

  @HttpCode(200)
  @Post("action/journey/:id/enroll")
  async journeyEnroll(@Param("id") id: string, @Body() body: unknown) {
    const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    const versionId = typeof b.versionId === "string" ? b.versionId : null;
    const version = Number(b.version ?? 1);
    const graph = b.graph;
    const dedupeKey = typeof b.dedupeKey === "string" ? b.dedupeKey : crypto.randomUUID();
    if (graph === undefined) throw new Error("Enrollment needs the journey graph.");
    return this.journeyRuntime.enroll({
      journeyId: id,
      versionId: versionId ?? "",
      version,
      graph: graph as never,
      ...(typeof b.personType === "string" ? { personType: b.personType } : {}),
      ...(typeof b.personId === "string" ? { personId: b.personId } : {}),
      ...(typeof b.emailHash === "string" ? { emailHash: b.emailHash } : {}),
      source: typeof b.source === "string" ? b.source : "Manual",
      dedupeKey,
    });
  }

  @HttpCode(200)
  @Post("action/journey/run-batch")
  async journeyRunBatch(@Body() body: unknown) {
    this.requireAdmin("running the journey engine");
    const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    const limit = Number(b.limit ?? 25);
    const now = new Date().toISOString();
    const due = await this.journeyRuntime.dueEnrollments(now, limit);
    const results: unknown[] = [];
    for (const item of due) {
      const enrollment = await this.journeyRuntime.claim(item.id, now);
      if (enrollment === undefined) continue;
      const versionRow = item.versionId ? await this.journeyRuntime.versionGraph(item.versionId) : undefined;
      if (versionRow === undefined) {
        results.push({ enrollmentId: item.id, outcome: "failed", reason: "missing-version" });
        continue;
      }
      results.push(await this.journeyRuntime.runStep(item.id, versionRow));
    }
    return { ran: results.length, results };
  }

  @HttpCode(200)
  @Post("action/enrollment/:id/suspend")
  async enrollmentSuspend(@Param("id") id: string, @Body() body: unknown) {
    const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    const reason = typeof b.reason === "string" ? b.reason : "OperatorSuspend";
    await this.journeyRuntime.suspend(id, reason);
    return { id, state: "Suspended", reason };
  }

  @HttpCode(200)
  @Post("action/enrollment/:id/resume")
  async enrollmentResume(@Param("id") id: string) {
    await this.journeyRuntime.resume(id);
    return { id, state: "Active" };
  }

  @HttpCode(200)
  @Post("action/enrollment/:id/exit")
  async enrollmentExit(@Param("id") id: string, @Body() body: unknown) {
    const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    const reason = typeof b.reason === "string" ? b.reason : "OperatorExit";
    await this.journeyRuntime.exit(id, reason, new Date().toISOString());
    return { id, state: "Exited", reason };
  }

  /** Evaluate a whitelisted CRM event against a journey (worker/channel entry, §15 MA.14). */
  @Public()
  @HttpCode(200)
  @Post("action/journey/:id/trigger")
  async journeyTrigger(@Param("id") id: string, @Body() body: unknown) {
    const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    return this.journeyTriggers.trigger({
      journeyId: id,
      eventType: typeof b.eventType === "string" ? b.eventType : "",
      ...(typeof b.entityType === "string" ? { entityType: b.entityType } : {}),
      ...(typeof b.entityId === "string" ? { entityId: b.entityId } : {}),
      ...(typeof b.depth === "number" ? { depth: b.depth } : {}),
      ...(typeof b.correlationId === "string" ? { correlationId: b.correlationId } : {}),
    });
  }

  @Public()
  @HttpCode(200)
  @Post("public/form/submit")
  async publicFormSubmit(@Body() body: unknown) {
    const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    return this.forms.submit({
      ...(typeof b.firstName === "string" ? { firstName: b.firstName } : {}),
      ...(typeof b.lastName === "string" ? { lastName: b.lastName } : {}),
      email: typeof b.email === "string" ? b.email : "",
      ...(typeof b.company === "string" ? { company: b.company } : {}),
      consent: b.consent === true,
      ...(typeof b.campaignId === "string" ? { campaignId: b.campaignId } : {}),
      ...(typeof b.journeyId === "string" ? { journeyId: b.journeyId } : {}),
      ...(typeof b.journeyVersionId === "string" ? { journeyVersionId: b.journeyVersionId } : {}),
      ...(typeof b.source === "string" ? { source: b.source } : {}),
      ...(typeof b.utmSource === "string" ? { utmSource: b.utmSource } : {}),
      ...(typeof b.utmMedium === "string" ? { utmMedium: b.utmMedium } : {}),
      ...(typeof b.utmCampaign === "string" ? { utmCampaign: b.utmCampaign } : {}),
      ...(typeof b.idempotencyKey === "string" ? { idempotencyKey: b.idempotencyKey } : {}),
      ...(typeof b.website === "string" ? { honeypot: b.website } : {}),
    });
  }

  @HttpCode(200)
  @Post("action/attribution")
  async recordAttribution(@Body() body: unknown) {
    this.requireAdmin("recording attribution");
    const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    return this.integration.recordAttribution({
      ...(typeof b.campaignId === "string" ? { campaignId: b.campaignId } : {}),
      ...(typeof b.sendId === "string" ? { sendId: b.sendId } : {}),
      ...(typeof b.journeyId === "string" ? { journeyId: b.journeyId } : {}),
      outcome: typeof b.outcome === "string" ? b.outcome : "converted",
      ...(typeof b.referenceType === "string" ? { referenceType: b.referenceType } : {}),
      ...(typeof b.referenceId === "string" ? { referenceId: b.referenceId } : {}),
      ...(typeof b.correlationId === "string" ? { correlationId: b.correlationId } : {}),
    });
  }

  @HttpCode(200)
  @Post("action/portal/preferences")
  async portalPreferences(@Body() body: unknown) {
    const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    return this.integration.portalPreferenceUpdate({
      consent: b.consent === true,
      ...(typeof b.purpose === "string" ? { purpose: b.purpose } : {}),
    });
  }

  @HttpCode(200)
  @Post("action/crossModuleEvent")
  async crossModuleEvent(@Body() body: unknown) {
    this.requireAdmin("processing cross-module events");
    const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    return this.integration.handleCrossModuleEvent({
      eventType: typeof b.eventType === "string" ? b.eventType : "",
      sourceModule: typeof b.sourceModule === "string" ? b.sourceModule : "unknown",
      ...(typeof b.entityType === "string" ? { entityType: b.entityType } : {}),
      ...(typeof b.entityId === "string" ? { entityId: b.entityId } : {}),
      ...(typeof b.emailHash === "string" ? { emailHash: b.emailHash } : {}),
      ...(b.payload && typeof b.payload === "object" ? { payload: b.payload as Record<string, unknown> } : {}),
      ...(typeof b.causationDepth === "number" ? { causationDepth: b.causationDepth } : {}),
      ...(typeof b.correlationId === "string" ? { correlationId: b.correlationId } : {}),
    });
  }

  @HttpCode(200)
  @Get("action/campaign/:id/attribution")
  async campaignAttribution(@Param("id") id: string, @Query() query: unknown) {
    const q = typeof query === "object" && query !== null ? (query as Record<string, unknown>) : {};
    const model = typeof q["model"] === "string" ? (q["model"] as "first_touch" | "last_touch" | "influenced") : "influenced";
    return this.attribution.attribution(id, model);
  }

  @HttpCode(200)
  @Get("action/campaign/:id/funnel")
  async campaignFunnel(@Param("id") id: string) {
    return this.attribution.funnel(id);
  }

  @HttpCode(200)
  @Post("action/retention/dryRun")
  async retentionDryRun(@Body() body: unknown) {
    this.requireAdmin("running retention dry-run");
    const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    const days = Number(b.olderThanDays ?? 365);
    return this.retention.dryRun(days);
  }

  @Get("action/diagnostics")
  async diagnostics() {
    this.requireAdmin("reading marketing diagnostics");
    return this.operations.diagnostics();
  }


  @Public()
  @Get("public/click")
  async publicClick(@Query("to") to?: string) {
    const target = typeof to === "string" ? to : "";
    // Open-redirect guard: only http(s) URLs with an explicit host, or same-origin relative paths.
    let safe = "";
    try {
      if (target.startsWith("/")) {
        safe = target;
      } else {
        const u = new URL(target);
        if (u.protocol === "http:" || u.protocol === "https:") {
          safe = u.toString();
        }
      }
    } catch {
      safe = "";
    }
    if (safe === "") {
      throw new Error("Invalid redirect target.");
    }
    // Express/Nest redirect via a 302 header is not available on @Get returning JSON; return the safe target.
    return { redirect: safe };
  }

  @Public()
  @Get("public/open")
  async publicOpen() {
    return { ok: true };
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
