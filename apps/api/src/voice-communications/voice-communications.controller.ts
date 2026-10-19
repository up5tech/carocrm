import { timingSafeEqual } from "node:crypto";

import {
  AuthenticationFailedError,
  AuthorizationDeniedError,
  ValidationError,
} from "@carocrm/core/errors/index.js";
import { Body, Controller, Delete, Get, Headers, HttpCode, Inject, Param, Patch, Post, Query } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { type ZodTypeAny } from "zod";

import { REQUEST_SCOPE_TOKEN, type RequestScope } from "../common/request-scope.js";
import { type AppConfig, CONFIG_TOKEN } from "../config.js";
import {
  AccountStateSchema,
  ConsentRecordSchema,
  EndpointCreateSchema,
  EndpointStateSchema,
  PageQuerySchema,
  PolicyEvaluateSchema,
  ProviderAccountCreateSchema,
  ProviderAccountPatchSchema,
  ResolvePhoneSchema,
  RevokeSuppressionSchema,
  SettingsPatchSchema,
  SuppressionAddSchema,
  SuppressionQuerySchema,
  WorkerProcessSchema,
} from "./dto/voice-communications-shapes.js";
import { VoiceCommunicationsModuleHealthService } from "./voice-communications-module-health.service.js";
import { VoiceCommunicationsNavigationService } from "./voice-communications-navigation.service.js";
import { VoiceCommunicationsSettingsService } from "./voice-communications-settings.service.js";
import { VoiceConsentService } from "./voice-consent.service.js";
import { VoiceContactResolverService } from "./voice-contact-resolver.service.js";
import { VoiceEventProcessorService } from "./voice-event-processor.service.js";
import { VoicePolicyService } from "./voice-policy.service.js";
import { VoiceProviderRegistry } from "./voice-provider.js";
import { VoiceProviderAccountsService } from "./voice-provider-accounts.service.js";
import { VoiceWebhookIngressService } from "./voice-webhook-ingress.service.js";

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
