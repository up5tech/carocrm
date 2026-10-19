import { timingSafeEqual } from "node:crypto";

import {
  AuthenticationFailedError,
  AuthorizationDeniedError,
  ValidationError,
} from "@carocrm/core/errors/index.js";
import { Body, Controller, Delete, Get, Headers, HttpCode, Inject, Param, Patch, Post, Query } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { z,type ZodTypeAny } from "zod";

import { REQUEST_SCOPE_TOKEN, type RequestScope } from "../common/request-scope.js";
import { type AppConfig, CONFIG_TOKEN } from "../config.js";
import {
  AccountStateSchema,
  CallLinkSchema,
  CallListQuerySchema,
  CallNoteSchema,
  CaseHandoffSchema,
  CaseLinkSchema,
  ComposerValidateSchema,
  ConsentRecordSchema,
  ConversationAssignSchema,
  ConversationListQuerySchema,
  ConversationStatusSchema,
  EndpointCreateSchema,
  EndpointStateSchema,
  InboxQuerySchema,
  InitiateCallSchema,
  MediaActionSchema,
  PageQuerySchema,
  PanelLinkSchema,
  PanelQuerySchema,
  PolicyEvaluateSchema,
  ProviderAccountCreateSchema,
  ProviderAccountPatchSchema,
  ResolvePhoneSchema,
  RevokeSuppressionSchema,
  SendMessageSchema,
  SettingsPatchSchema,
  SuppressionAddSchema,
  SuppressionQuerySchema,
  TemplateRenderSchema,
  TemplateUpsertSchema,
  TimelineQuerySchema,
  TranscriptReviewSchema,
  WhatsappTemplateSchema,
  WhatsappTemplateStatusSchema,
  WorkerProcessSchema,
} from "./dto/voice-communications-shapes.js";
import { VoiceCallService } from "./voice-call.service.js";
import { VoiceCommunicationsModuleHealthService } from "./voice-communications-module-health.service.js";
import { VoiceCommunicationsNavigationService } from "./voice-communications-navigation.service.js";
import { VoiceCommunicationsSettingsService } from "./voice-communications-settings.service.js";
import { VoiceConsentService } from "./voice-consent.service.js";
import { VoiceContactResolverService } from "./voice-contact-resolver.service.js";
import { VoiceEventProcessorService } from "./voice-event-processor.service.js";
import { VoiceInboxService } from "./voice-inbox.service.js";
import { VoiceMediaService } from "./voice-media.service.js";
import { VoiceMessageTemplateService } from "./voice-message-template.service.js";
import { VoiceMessagingService } from "./voice-messaging.service.js";
import { VoicePanelService } from "./voice-panel.service.js";
import { VoicePolicyService } from "./voice-policy.service.js";
import { VoiceProviderRegistry } from "./voice-provider.js";
import { VoiceProviderAccountsService } from "./voice-provider-accounts.service.js";
import { VoiceTranscriptionService } from "./voice-transcription.service.js";
import { VoiceWebhookIngressService } from "./voice-webhook-ingress.service.js";
import { VoiceWhatsappTemplateService } from "./voice-whatsapp-template.service.js";

/**
 * Phase 19-VC.2–19-VC.6 — the `VoiceCommunications` command surface
 * (`PLAN_Phase_19_Voice_Communications.md` §11.1–§11.3, §12.4, §15).
 *
 * CRM record CRUD stays on the generic `/api/v1/:entity` API. These routes exist for what a single
 * record cannot express: module diagnostics, the settings document, provider/account lifecycle,
 * webhook inbox inspection and replay, contact resolution and channel-policy evaluation.
 *
 * Registered before `ENTITY_CONTROLLERS`, so the static `VoiceCommunications` prefix can never be
 * swallowed by the generic `:entity` wildcard (AGENTS.md §5.4).
 */
@ApiTags("voice-communications")
@Controller("api/v1/VoiceCommunications")
export class VoiceCommunicationsController {
  constructor(
    @Inject(VoiceCommunicationsModuleHealthService) private readonly health: VoiceCommunicationsModuleHealthService,
    @Inject(VoiceCommunicationsSettingsService) private readonly settings: VoiceCommunicationsSettingsService,
    @Inject(VoiceCommunicationsNavigationService) private readonly navigation: VoiceCommunicationsNavigationService,
    @Inject(VoiceProviderAccountsService) private readonly accounts: VoiceProviderAccountsService,
    @Inject(VoiceProviderRegistry) private readonly providers: VoiceProviderRegistry,
    @Inject(VoiceCallService) private readonly calls: VoiceCallService,
    @Inject(VoiceMessagingService) private readonly messaging: VoiceMessagingService,
    @Inject(VoiceWhatsappTemplateService) private readonly whatsappTemplates: VoiceWhatsappTemplateService,
    @Inject(VoiceMessageTemplateService) private readonly snippets: VoiceMessageTemplateService,
    @Inject(VoiceInboxService) private readonly inbox: VoiceInboxService,
    @Inject(VoiceMediaService) private readonly media: VoiceMediaService,
    @Inject(VoiceTranscriptionService) private readonly transcription: VoiceTranscriptionService,
    @Inject(VoicePanelService) private readonly panels: VoicePanelService,
    @Inject(VoiceWebhookIngressService) private readonly ingress: VoiceWebhookIngressService,
    @Inject(VoiceEventProcessorService) private readonly processor: VoiceEventProcessorService,
    @Inject(VoiceContactResolverService) private readonly resolver: VoiceContactResolverService,
    @Inject(VoicePolicyService) private readonly policy: VoicePolicyService,
    @Inject(VoiceConsentService) private readonly consent: VoiceConsentService,
    @Inject(CONFIG_TOKEN) private readonly config: AppConfig,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  // ---------------------------------------------------------------------------
  // Module surface (19-VC.2)
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
    this.requireAdmin("changing Voice & Communications settings");
    parse(SettingsPatchSchema, body);
    return this.settings.update(body);
  }

  /** ACL-scoped visibility for the SPA's Voice submenu — a report, never a gate. */
  @Get("action/nav")
  async navigationVisibility() {
    return this.navigation.visibility();
  }

  // ---------------------------------------------------------------------------
  // Providers and accounts (19-VC.4)
  // ---------------------------------------------------------------------------

  /** Capability metadata for every resolvable adapter; never a credential. */
  @Get("action/providers")
  async providerCatalog() {
    this.requireAdmin("reading provider capabilities");
    return {
      providers: this.providers.describeAll(),
      defaultAccountKey: (await this.settings.settings()).provider.defaultAccountKey,
    };
  }

  @Get("action/accounts")
  async listAccounts() {
    this.requireAdmin("reading provider accounts");
    return { list: await this.accounts.list() };
  }

  @HttpCode(201)
  @Post("action/accounts")
  async createAccount(@Body() body: unknown) {
    this.requireAdmin("creating a provider account");
    return this.accounts.create(parse(ProviderAccountCreateSchema, body));
  }

  @Get("action/accounts/:key")
  async getAccount(@Param("key") key: string) {
    this.requireAdmin("reading a provider account");
    return this.accounts.get(key);
  }

  @HttpCode(200)
  @Patch("action/accounts/:key")
  async updateAccount(@Param("key") key: string, @Body() body: unknown) {
    this.requireAdmin("updating a provider account");
    return this.accounts.update(key, parse(ProviderAccountPatchSchema, body));
  }

  @Delete("action/accounts/:key")
  async removeAccount(@Param("key") key: string) {
    this.requireAdmin("removing a provider account");
    return this.accounts.remove(key);
  }

  @HttpCode(200)
  @Post("action/accounts/:key/enabled")
  async setAccountEnabled(@Param("key") key: string, @Body() body: unknown) {
    this.requireAdmin("enabling or disabling a provider account");
    const input = parse(AccountStateSchema, body);
    return this.accounts.setEnabled(key, input.enabled);
  }

  @HttpCode(200)
  @Post("action/accounts/:key/health")
  async accountHealth(@Param("key") key: string) {
    this.requireAdmin("running a provider health check");
    return this.accounts.healthCheck(key);
  }

  @Get("action/accounts/:key/endpoints")
  async listEndpoints(@Param("key") key: string) {
    this.requireAdmin("reading endpoints");
    return { list: await this.accounts.listEndpoints(key) };
  }

  @HttpCode(201)
  @Post("action/accounts/:key/endpoints")
  async createEndpoint(@Param("key") key: string, @Body() body: unknown) {
    this.requireAdmin("registering an endpoint");
    return this.accounts.createEndpoint(key, parse(EndpointCreateSchema, body));
  }

  @HttpCode(200)
  @Patch("action/accounts/:key/endpoints/:endpointKey")
  async setEndpointActive(
    @Param("key") key: string,
    @Param("endpointKey") endpointKey: string,
    @Body() body: unknown,
  ) {
    this.requireAdmin("changing an endpoint");
    const input = parse(EndpointStateSchema, body);
    return this.accounts.setEndpointActive(key, endpointKey, input.active);
  }

  // ---------------------------------------------------------------------------
  // Webhook operations (19-VC.5)
  // ---------------------------------------------------------------------------

  @Get("action/webhook-events")
  async listWebhookEvents(@Query() query: unknown) {
    this.requireAdmin("reading the webhook inbox");
    return this.ingress.list(parse(PageQuerySchema, coerceQuery(query)));
  }

  @Get("action/webhook-events/:id")
  async getWebhookEvent(@Param("id") id: string) {
    this.requireAdmin("reading a webhook receipt");
    return this.ingress.get(id);
  }

  @HttpCode(200)
  @Post("action/webhook-events/:id/replay")
  async replayWebhookEvent(@Param("id") id: string) {
    this.requireAdmin("replaying a webhook receipt");
    return this.ingress.replay(id);
  }

  /**
   * The worker door onto processing. The queue job carries `{ eventId }`; the worker calls this with
   * the shared `x-worker-secret` capability (`REPORT_WORKER_SECRET`, the same door Sales, Service Desk,
   * Customer Success and Marketing Automation use). An administrator may also press it for one event.
   * Processing is idempotent, so a repeated call is harmless.
   */
  @HttpCode(200)
  @Post("action/webhook-events/process")
  async processWebhookEvent(@Body() body: unknown, @Headers("x-worker-secret") workerSecret?: string) {
    if (workerSecret !== undefined) this.assertWorkerSecret(workerSecret);
    else this.requireAdmin("processing a webhook event");
    const input = parse(WorkerProcessSchema, body);
    return this.processor.process(input.eventId);
  }

  // ---------------------------------------------------------------------------
  // Calls: click-to-call, session and caller context (19-VC.7–19-VC.9)
  // ---------------------------------------------------------------------------

  /**
   * Place a call through the configured adapter. The client supplies `idempotencyKey`; repeating the
   * request returns the same session with `duplicate: true` and places no second call.
   */
  @HttpCode(201)
  @Post("action/calls/initiate")
  async initiateCall(@Body() body: unknown) {
    return this.calls.initiate(parse(InitiateCallSchema, body));
  }

  @Get("action/calls")
  async listCalls(@Query() query: unknown) {
    return { list: await this.calls.list(parse(CallListQuerySchema, coerceQuery(query))) };
  }

  /** Inbound calls still ringing for this caller — the popup's polling source (§7.2). */
  @Get("action/calls/incoming")
  async incomingCalls() {
    return { list: await this.calls.incoming() };
  }

  @Get("action/calls/:id")
  async getCall(@Param("id") id: string) {
    return this.calls.get(id);
  }

  /** Caller context for the incoming-call panel: permitted matches only, ambiguity preserved. */
  @Get("action/calls/:id/context")
  async callContext(@Param("id") id: string) {
    return this.calls.contextFor(id);
  }

  @HttpCode(200)
  @Post("action/calls/:id/note")
  async callNote(@Param("id") id: string, @Body() body: unknown) {
    const input = parse(CallNoteSchema, body);
    return this.calls.note(id, input.description);
  }

  @HttpCode(200)
  @Post("action/calls/:id/link")
  async callLink(@Param("id") id: string, @Body() body: unknown) {
    const input = parse(CallLinkSchema, body);
    return this.calls.link(id, input.entityType, input.entityId);
  }

  // ---------------------------------------------------------------------------
  // Messaging and WhatsApp templates (19-VC.10–19-VC.11)
  // ---------------------------------------------------------------------------

  /** One outbound attempt. A repeated `idempotencyKey` returns the same message, never a second send. */
  @HttpCode(201)
  @Post("action/messages/send")
  async sendMessage(@Body() body: unknown) {
    return this.messaging.send(parse(SendMessageSchema, body));
  }

  @Get("action/conversations")
  async listConversations(@Query() query: unknown) {
    return { list: await this.messaging.listConversations(parse(ConversationListQuerySchema, coerceQuery(query))) };
  }

  @Get("action/conversations/:id")
  async getConversation(@Param("id") id: string) {
    return this.messaging.getConversation(id);
  }

  @Get("action/templates/:accountKey")
  async listTemplates(@Param("accountKey") accountKey: string) {
    this.requireAdmin("reading WhatsApp templates");
    return { list: await this.whatsappTemplates.list(accountKey) };
  }

  @HttpCode(200)
  @Post("action/templates/:accountKey")
  async upsertTemplate(@Param("accountKey") accountKey: string, @Body() body: unknown) {
    this.requireAdmin("recording a WhatsApp template");
    const input = parse(WhatsappTemplateSchema, body);
    return this.whatsappTemplates.upsert({ accountKey, ...input, components: input.components ?? [] });
  }

  @HttpCode(200)
  @Post("action/templates/:accountKey/:templateKey/:language/status")
  async setTemplateStatus(
    @Param("accountKey") accountKey: string,
    @Param("templateKey") templateKey: string,
    @Param("language") language: string,
    @Body() body: unknown,
  ) {
    this.requireAdmin("changing a WhatsApp template status");
    const input = parse(WhatsappTemplateStatusSchema, body);
    return this.whatsappTemplates.setStatus(accountKey, templateKey, language, input.status, {
      ...(input.vendorStatus !== undefined ? { vendorStatus: input.vendorStatus } : {}),
      ...(input.rejectionReason !== undefined ? { rejectionReason: input.rejectionReason } : {}),
    });
  }

  // ---------------------------------------------------------------------------
  // Unified inbox: conversations, timeline, assignment, case handoff (19-VC.12–13)
  // ---------------------------------------------------------------------------

  @Get("action/inbox")
  async inboxList(@Query() query: unknown) {
    return this.inbox.list(parse(InboxQuerySchema, coerceQuery(query)));
  }

  @Get("action/conversations/:id/timeline")
  async conversationTimeline(@Param("id") id: string, @Query() query: unknown) {
    return this.inbox.timeline(id, parse(TimelineQuerySchema, coerceQuery(query)));
  }

  /** History: assignment/status/case events with actor and time (§9.1 acceptance). */
  @Get("action/conversations/:id/history")
  async conversationHistory(@Param("id") id: string) {
    return this.inbox.history(id);
  }

  @HttpCode(200)
  @Post("action/conversations/:id/read")
  async conversationMarkRead(@Param("id") id: string) {
    return this.inbox.markRead(id);
  }

  @HttpCode(200)
  @Post("action/conversations/:id/status")
  async conversationSetStatus(@Param("id") id: string, @Body() body: unknown) {
    const input = parse(ConversationStatusSchema, body);
    return this.inbox.setStatus(id, input.status, input.reason);
  }

  @HttpCode(200)
  @Post("action/conversations/:id/assign")
  async conversationAssign(@Param("id") id: string, @Body() body: unknown) {
    return this.inbox.assign(id, parse(ConversationAssignSchema, body));
  }

  @HttpCode(200)
  @Post("action/conversations/:id/case/link")
  async conversationLinkCase(@Param("id") id: string, @Body() body: unknown) {
    const input = parse(CaseLinkSchema, body);
    return this.inbox.linkCase(id, input.caseId);
  }

  /**
   * Hand off to a Service Desk Case. The conversation's `case_id` is the deduplication key: a
   * repeated click returns the existing Case with `duplicate: true` (§9.2 acceptance).
   */
  @HttpCode(201)
  @Post("action/conversations/:id/case/handoff")
  async conversationHandoff(@Param("id") id: string, @Body() body: unknown) {
    const input = parse(CaseHandoffSchema, body);
    return this.inbox.handoffToCase(id, input);
  }

  // ---------------------------------------------------------------------------
  // Service snippets and composer validation (19-VC.14)
  // ---------------------------------------------------------------------------

  @Get("action/snippets")
  async listSnippets(@Query() query: unknown) {
    const parsed = parse(z.object({ channel: z.enum(["sms", "mms", "whatsapp", "any"]).optional() }).strict(), coerceQuery(query));
    return this.snippets.list({ ...(parsed.channel !== undefined ? { channel: parsed.channel } : {}) });
  }

  @Get("action/snippets/:key")
  async getSnippet(@Param("key") key: string) {
    return this.snippets.get(key);
  }

  @HttpCode(200)
  @Post("action/snippets")
  async upsertSnippet(@Body() body: unknown) {
    this.requireAdmin("editing a service snippet");
    return this.snippets.upsert(parse(TemplateUpsertSchema, body));
  }

  @Delete("action/snippets/:key")
  async removeSnippet(@Param("key") key: string) {
    this.requireAdmin("removing a service snippet");
    await this.snippets.remove(key);
    return { removed: true };
  }

  @HttpCode(200)
  @Post("action/snippets/:key/render")
  async renderSnippet(@Param("key") key: string, @Body() body: unknown) {
    const input = parse(TemplateRenderSchema, body);
    return this.snippets.render(key, input.variables);
  }

  /** The same checks the send path applies, before the agent commits (§10.1). */
  @HttpCode(200)
  @Post("action/composer/validate")
  async composerValidate(@Body() body: unknown) {
    const input = parse(ComposerValidateSchema, body);
    return this.snippets.validateComposer(input);
  }

  // ---------------------------------------------------------------------------
  // Recordings and media (19-VC.15)
  // ---------------------------------------------------------------------------

  @Get("action/calls/:id/media")
  async listCallMedia(@Param("id") id: string) {
    return this.media.listForCall(id);
  }

  /** Authorized playback: bytes from private storage, never a provider redirect. */
  @Get("action/media/:id/playback")
  async mediaPlayback(@Param("id") id: string) {
    const result = await this.media.playback(id);
    return { contentType: result.contentType, filename: result.filename, dataBase64: result.body.toString("base64") };
  }

  /** The worker door for a media fetch (`voiceCommunications.fetchMedia`). */
  @HttpCode(200)
  @Post("action/media/fetch")
  async mediaFetch(@Body() body: unknown, @Headers("x-worker-secret") workerSecret?: string) {
    if (workerSecret !== undefined) this.assertWorkerSecret(workerSecret);
    else this.requireAdmin("fetching media");
    const input = parse(MediaActionSchema, body);
    return this.media.fetchAndStore(input.mediaId);
  }

  /** The worker door for the retention sweep (`voiceCommunications.retentionSweep`). */
  @HttpCode(200)
  @Post("action/media/retention-sweep")
  async mediaRetentionSweep(@Headers("x-worker-secret") workerSecret?: string) {
    if (workerSecret !== undefined) this.assertWorkerSecret(workerSecret);
    else this.requireAdmin("running the media retention sweep");
    return this.media.retentionSweep();
  }

  // ---------------------------------------------------------------------------
  // Transcription and AI enrichment (19-VC.16)
  // ---------------------------------------------------------------------------

  @Get("action/calls/:id/transcript")
  async callTranscript(@Param("id") id: string) {
    return { transcript: await this.transcription.get(id) };
  }

  @HttpCode(200)
  @Post("action/calls/:id/transcript/request")
  async requestTranscript(@Param("id") id: string) {
    return this.transcription.requestTranscript(id);
  }

  /** Draft-only AI enrichment: provenance and review state are part of the answer (§7.6). */
  @HttpCode(200)
  @Post("action/calls/:id/transcript/enrich")
  async enrichTranscript(@Param("id") id: string) {
    return this.transcription.enrich(id);
  }

  @HttpCode(200)
  @Post("action/calls/:id/transcript/review")
  async reviewTranscript(@Param("id") id: string, @Body() body: unknown) {
    const input = parse(TranscriptReviewSchema, body);
    return this.transcription.setReviewStatus(id, input.status);
  }

  // ---------------------------------------------------------------------------
  // CRM panels and Customer Success touchpoints (19-VC.17)
  // ---------------------------------------------------------------------------

  /** Record-ACL aware panel data: summaries only, bodies load lazily elsewhere. */
  @Get("action/panels/:entityType/:entityId")
  async recordPanel(@Param("entityType") entityType: string, @Param("entityId") entityId: string, @Query() query: unknown) {
    return this.panels.forRecord(entityType, entityId, parse(PanelQuerySchema, coerceQuery(query)));
  }

  @Get("action/panels/:entityType/:entityId/touchpoints")
  async recordTouchpoints(@Param("entityType") entityType: string, @Param("entityId") entityId: string) {
    return this.panels.touchpoints(entityType, entityId);
  }

  @HttpCode(200)
  @Post("action/conversations/:id/link-record")
  async linkConversation(@Param("id") id: string, @Body() body: unknown) {
    const input = parse(PanelLinkSchema, body);
    return this.panels.linkConversation(id, input.entityType, input.entityId);
  }

  // ---------------------------------------------------------------------------
  // Resolution, consent and policy (19-VC.6)
  // ---------------------------------------------------------------------------

  /** Caller lookup for a popup/inbox: ACL-filtered, ambiguity-safe, never a silent wrong match. */
  @HttpCode(200)
  @Post("action/resolve")
  async resolvePhone(@Body() body: unknown) {
    const input = parse(ResolvePhoneSchema, body);
    return this.resolver.resolve(input.phone, {
      ...(input.defaultRegion !== undefined ? { defaultRegion: input.defaultRegion } : {}),
      ...(input.entities !== undefined ? { entities: input.entities } : {}),
    });
  }

  @HttpCode(200)
  @Post("action/policy/evaluate")
  async evaluatePolicy(@Body() body: unknown) {
    const input = parse(PolicyEvaluateSchema, body);
    return this.policy.evaluate({
      channel: input.channel,
      address: input.address,
      ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
      ...(input.accountKey !== undefined ? { accountKey: input.accountKey } : {}),
      ...(input.lastInboundAt !== undefined ? { lastInboundAt: input.lastInboundAt } : {}),
      ...(input.messageLength !== undefined ? { messageLength: input.messageLength } : {}),
      ...(input.templateKey !== undefined ? { templateKey: input.templateKey } : {}),
    });
  }

  @Get("action/consent")
  async consentState(
    @Query("channel") channel: string,
    @Query("address") address: string,
    @Query("purpose") purpose?: string,
  ) {
    const parsed = parse(
      ConsentRecordSchema.pick({ channel: true, address: true, purpose: true }),
      { channel, address, purpose: purpose ?? "service" },
    );
    return this.consent.state(parsed.channel, parsed.address, parsed.purpose);
  }

  @HttpCode(201)
  @Post("action/consent")
  async recordConsent(@Body() body: unknown) {
    return this.consent.record(parse(ConsentRecordSchema, body));
  }

  @Get("action/suppressions")
  async listSuppressions(@Query() query: unknown) {
    return this.consent.listSuppressions(parse(SuppressionQuerySchema, coerceQuery(query)));
  }

  @HttpCode(201)
  @Post("action/suppressions")
  async addSuppression(@Body() body: unknown) {
    return this.consent.suppress(parse(SuppressionAddSchema, body));
  }

  @HttpCode(200)
  @Delete("action/suppressions/:channel/:address")
  async revokeSuppression(@Param("channel") channel: string, @Param("address") address: string) {
    const parsed = parse(RevokeSuppressionSchema, { channel });
    return this.consent.revokeSuppression(parsed.channel, address);
  }

  private requireAdmin(action: string): void {
    if (!this.scope.isAdmin) {
      throw new AuthorizationDeniedError(`Administrator access is required for ${action}.`);
    }
  }

  /** Constant-time comparison of the worker capability; an unconfigured deployment refuses outright. */
  private assertWorkerSecret(supplied: string | undefined): void {
    const expected = this.config.reportWorkerSecret;
    if (expected === "" || supplied === undefined) {
      throw new AuthenticationFailedError("Invalid worker capability.");
    }
    const expectedBytes = Buffer.from(expected);
    const suppliedBytes = Buffer.from(supplied);
    if (expectedBytes.length !== suppliedBytes.length || !timingSafeEqual(expectedBytes, suppliedBytes)) {
      throw new AuthenticationFailedError("Invalid worker capability.");
    }
  }
}

/** Shape parsing: a zod failure becomes the platform's `ValidationError`, not a raw ZodError. */
export function parse<T extends ZodTypeAny>(schema: T, value: unknown): T["_output"] {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ValidationError("Invalid request.", {
      issues: result.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    });
  }
  return result.data;
}

/** A query string arrives as text, so paging and numeric keys are coerced before the schema sees them. */
function coerceQuery(query: unknown): Record<string, unknown> {
  if (typeof query !== "object" || query === null) return {};
  const out: Record<string, unknown> = { ...(query as Record<string, unknown>) };
  for (const key of ["limit", "offset"]) {
    const value = out[key];
    if (typeof value === "string" && value.trim() !== "") out[key] = Number(value);
  }
  for (const [key, value] of Object.entries(out)) {
    if (value === "" || value === undefined) delete out[key];
  }
  return out;
}
