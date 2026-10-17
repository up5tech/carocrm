import { timingSafeEqual } from "node:crypto";

import { AuthenticationFailedError, AuthorizationDeniedError, InvalidQueryError, ValidationError } from "@carocrm/core/errors/index.js";
import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query, Req } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { ZodTypeAny } from "zod";
import { z } from "zod";

import { Public } from "../auth/auth.guard.js";
import { REQUEST_SCOPE_TOKEN, type RequestScope } from "../common/request-scope.js";
import { type AppConfig, CONFIG_TOKEN } from "../config.js";
import { CaseAssignmentService } from "./case-assignment.service.js";
import { CaseConversationService } from "./case-conversation.service.js";
import { CaseLifecycleService } from "./case-lifecycle.service.js";
import { CaseMergeService } from "./case-merge.service.js";
import { CaseNumberingService } from "./case-numbering.service.js";
import { CsatService } from "./csat.service.js";
import {
  CaseAssignSchema,
  CaseConversationQuerySchema,
  CaseEmailReplySchema,
  // (web-to-case uses an inline shape)
  CaseMessageSchema,
  CaseRouteSchema,
  CaseTransitionSchema,
  EmailToCaseSchema,
  SettingsPatchSchema,
} from "./dto/service-desk-shapes.js";
import { EmailToCaseService } from "./email-to-case.service.js";
import { KnowledgeBaseService } from "./knowledge-base.service.js";
import { runAsServiceDeskSystem } from "./service-desk-authority.js";
import { ServiceDeskMetricsService } from "./service-desk-metrics.service.js";
import { ServiceDeskModuleHealthService } from "./service-desk-module-health.service.js";
import { ServiceDeskSettingsService } from "./service-desk-settings.service.js";
import { SlaService } from "./sla.service.js";
import { WebToCaseService } from "./web-to-case.service.js";

/**
 * Phase 19-SD.1 – 19-SD.5 — Service Desk module commands (`/api/v1/ServiceDesk`, PLAN §8.2).
 *
 * Entity CRUD stays on the generic `/api/v1/:entity` API — a Case is a metadata record, and the
 * Entity Engine already serves list/detail/create/edit/delete for it, with ACL, field validation,
 * audit, stream and search. These routes exist only for what a single record cannot express: module
 * diagnostics, the settings document, the case **state machine** (§5.2) and **assignment/routing**
 * (§5.3). Both command families validate every fact server-side; the controller only parses shape.
 *
 * This controller is registered before `ENTITY_CONTROLLERS`, so the static `ServiceDesk` prefix can
 * never be swallowed by the generic `:entity` wildcard (docs/module-guide.md).
 */
@ApiTags("service-desk")
@Controller("api/v1/ServiceDesk")
export class ServiceDeskController {
  constructor(
    @Inject(ServiceDeskModuleHealthService) private readonly health: ServiceDeskModuleHealthService,
    @Inject(ServiceDeskSettingsService) private readonly settings: ServiceDeskSettingsService,
    @Inject(ServiceDeskMetricsService) private readonly metricsService: ServiceDeskMetricsService,
    @Inject(CaseNumberingService) private readonly numbering: CaseNumberingService,
    @Inject(CaseLifecycleService) private readonly lifecycle: CaseLifecycleService,
    @Inject(CaseAssignmentService) private readonly assignment: CaseAssignmentService,
    @Inject(CaseConversationService) private readonly conversation: CaseConversationService,
    @Inject(EmailToCaseService) private readonly emailToCaseService: EmailToCaseService,
    @Inject(KnowledgeBaseService) private readonly knowledgeBase: KnowledgeBaseService,
    @Inject(CaseMergeService) private readonly caseMerge: CaseMergeService,
    @Inject(CsatService) private readonly csat: CsatService,
    @Inject(SlaService) private readonly slaService: SlaService,
    @Inject(WebToCaseService) private readonly webToCase: WebToCaseService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
    @Inject(CONFIG_TOKEN) private readonly config: AppConfig,
  ) {}

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
    this.requireAdmin("changing Service Desk settings");
    parse(SettingsPatchSchema, body);
    return this.settings.update(body);
  }

  /** The next case number, without consuming it — configuration visibility, so admin-only. */
  @Get("action/caseNumberPreview")
  async caseNumberPreview() {
    this.requireAdmin("case number configuration");
    return this.numbering.preview();
  }

  /**
   * ACL-scoped service metrics (§13, SD.15). The range bounds case creation; every aggregate runs
   * through the same record ACL as the list API, so counts never include an unreadable case.
   */
  @Get("action/metrics")
  async metrics(@Query() query: unknown) {
    const parsed = z
      .object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() })
      .safeParse(query ?? {});
    if (!parsed.success) {
      throw new InvalidQueryError("Invalid metrics range.", { issues: parsed.error.issues.map((issue) => issue.message) });
    }
    return this.metricsService.metrics({
      ...(parsed.data.from !== undefined ? { from: parsed.data.from.toISOString() } : {}),
      ...(parsed.data.to !== undefined ? { to: parsed.data.to.toISOString() } : {}),
    });
  }

  // ---------------------------------------------------------------------------
  // Case state machine (§5.2, SD.4)
  // ---------------------------------------------------------------------------

  /** What the current actor may do on this case: allowed commands, resolution and conversation. */
  @Get("action/case/:id/capabilities")
  async caseCapabilities(@Param("id") id: string) {
    const [lifecycle, assignment, conversation] = await Promise.all([
      this.lifecycle.capabilities(id),
      this.assignment.capabilities(id),
      this.conversation.capabilities(id),
    ]);
    return { ...lifecycle, assignment, conversation };
  }

  @Post("action/case/:id/transition")
  @HttpCode(200)
  async caseTransition(@Param("id") id: string, @Body() body: unknown) {
    return this.lifecycle.transition(id, parse(CaseTransitionSchema, body));
  }

  @Post("action/case/:id/start")
  @HttpCode(200)
  async caseStart(@Param("id") id: string, @Body() body: unknown) {
    return this.lifecycle.run(id, "start", parse(CaseTransitionSchema, body));
  }

  @Post("action/case/:id/resolve")
  @HttpCode(200)
  async caseResolve(@Param("id") id: string, @Body() body: unknown) {
    return this.lifecycle.run(id, "resolve", parse(CaseTransitionSchema, body));
  }

  @Post("action/case/:id/close")
  @HttpCode(200)
  async caseClose(@Param("id") id: string, @Body() body: unknown) {
    return this.lifecycle.run(id, "close", parse(CaseTransitionSchema, body));
  }

  @Post("action/case/:id/reopen")
  @HttpCode(200)
  async caseReopen(@Param("id") id: string, @Body() body: unknown) {
    return this.lifecycle.run(id, "reopen", parse(CaseTransitionSchema, body));
  }

  @Post("action/case/:id/cancel")
  @HttpCode(200)
  async caseCancel(@Param("id") id: string, @Body() body: unknown) {
    return this.lifecycle.run(id, "cancel", parse(CaseTransitionSchema, body));
  }

  @Post("action/case/:id/escalate")
  @HttpCode(200)
  async caseEscalate(@Param("id") id: string, @Body() body: unknown) {
    return this.lifecycle.run(id, "escalate", parse(CaseTransitionSchema, body));
  }

  @Post("action/case/:id/deEscalate")
  @HttpCode(200)
  async caseDeEscalate(@Param("id") id: string, @Body() body: unknown) {
    return this.lifecycle.run(id, "deEscalate", parse(CaseTransitionSchema, body));
  }

  /** The status-transition history, so prior resolution/reopen cycles stay auditable. */
  @Get("action/case/:id/history")
  async caseHistory(@Param("id") id: string) {
    return this.lifecycle.history(id);
  }

  // ---------------------------------------------------------------------------
  // Conversation: public replies, internal notes, timeline (§5.4, SD.6)
  // ---------------------------------------------------------------------------

  /** Post a customer-visible reply to the case. */
  @Post("action/case/:id/reply")
  @HttpCode(200)
  async caseReply(@Param("id") id: string, @Body() body: unknown) {
    return this.conversation.reply(id, parse(CaseMessageSchema, body));
  }

  /** Post an internal-only note; it is never returned to a portal or customer-facing path. */
  @Post("action/case/:id/note")
  @HttpCode(200)
  async caseNote(@Param("id") id: string, @Body() body: unknown) {
    return this.conversation.note(id, parse(CaseMessageSchema, body));
  }

  /** The visibility-filtered conversation timeline, oldest first. */
  @Get("action/case/:id/conversation")
  async caseConversation(@Param("id") id: string, @Query() query: unknown) {
    return this.conversation.timeline(id, parse(CaseConversationQuerySchema, query));
  }

  // ---------------------------------------------------------------------------
  // Email-to-Case (§5.5, SD.7)
  // ---------------------------------------------------------------------------

  /** Process a stored inbound email into a case (or append it to its thread). */
  @Post("action/emailToCase")
  @HttpCode(200)
  async emailToCase(@Body() body: unknown) {
    return this.emailToCaseService.processEmail(parse(EmailToCaseSchema, body).emailId);
  }

  /** Drive the kernel inbound poller and process every newly stored message. */
  @Post("action/emailToCase/processInbound")
  @HttpCode(200)
  async processInbound() {
    return this.emailToCaseService.processInbound();
  }

  /** Send a customer-visible reply to a case by email. */
  @Post("action/case/:id/emailReply")
  @HttpCode(200)
  async caseEmailReply(@Param("id") id: string, @Body() body: unknown) {
    return this.emailToCaseService.replyByEmail(id, parse(CaseEmailReplySchema, body));
  }

  /** Idempotent SLA breach/warning pass (§5.7, SD.8). Administrator only. */
  @Post("action/sla/checkBreaches")
  @HttpCode(200)
  async slaCheckBreaches() {
    this.requireAdmin("running an SLA scan");
    return this.slaService.checkBreaches();
  }

  /**
   * Idempotent SLA scan: warnings, breaches, escalations, notifications, knowledge expiry (§5.7,
   * SD.9). Administrator only; the worker calls the `@Public()` route below with the shared
   * worker→API capability.
   */
  @Post("action/sla/runScheduledCheck")
  @HttpCode(200)
  async slaRunScheduledCheck() {
    this.requireAdmin("running a scheduled SLA scan");
    return runAsServiceDeskSystem(this.scope, "sla-scan", () => this.slaService.runScheduledCheck());
  }

  /**
   * The worker's twin of `runScheduledCheck`. The worker has no user session, so the shared
   * worker→API capability (`x-worker-secret`, `REPORT_WORKER_SECRET`) is the authorisation,
   * compared in constant time and refused when no capability is configured. The pass is
   * idempotent by clock state and notification dedup keys, so a retry is safe (SD.9).
   */
  @Public()
  @Post("action/sla/run-scheduled-check")
  @HttpCode(200)
  async slaRunScheduledCheckForWorker(@Headers("x-worker-secret") secret?: string) {
    this.assertWorkerSecret(secret);
    return runAsServiceDeskSystem(this.scope, "sla-scan", () => this.slaService.runScheduledCheck());
  }

  /** Publish a knowledge article (admin). */
  @Post("action/knowledge/:id/publish")
  @HttpCode(200)
  async kbPublish(@Param("id") id: string) {
    this.requireAdmin("knowledge");
    return this.knowledgeBase.publish(id);
  }

  /** Archive a knowledge article (admin). */
  @Post("action/knowledge/:id/archive")
  @HttpCode(200)
  async kbArchive(@Param("id") id: string) {
    this.requireAdmin("knowledge");
    return this.knowledgeBase.archive(id);
  }

  /** Portal-safe published articles. */
  @Get("action/knowledge/portal")
  async kbPortal() {
    return this.knowledgeBase.portalArticles();
  }

  /** Suggested articles for a case. */
  @Get("action/case/:id/knowledgeSuggestions")
  async kbSuggestions(@Param("id") id: string) {
    return this.knowledgeBase.suggestForCase(id);
  }

  // ---------------------------------------------------------------------------
  // Assignment, queues and routing (§5.3, SD.5)
  // ---------------------------------------------------------------------------

  @Post("action/case/:id/assign")
  @HttpCode(200)
  async caseAssign(@Param("id") id: string, @Body() body: unknown) {
    return this.assignment.assign(id, parse(CaseAssignSchema, body));
  }

  @Post("action/case/:id/route")
  @HttpCode(200)
  async caseRoute(@Param("id") id: string, @Body() body: unknown) {
    return this.assignment.route(id, parse(CaseRouteSchema, body));
  }

  @Get("action/case/:id/assignments")
  async caseAssignments(@Param("id") id: string) {
    return this.assignment.history(id);
  }

  @Get("action/queues")
  async queues() {
    return this.assignment.queues();
  }

  @Get("action/queues/:id/workload")
  async queueWorkload(@Param("id") id: string) {
    return this.assignment.workload(id);
  }

  /** Public web-to-case intake (§5.10, SD.12). Unauthenticated; strict allowlist + abuse controls. */
  @Public()
  @Post("action/webToCase")
  @HttpCode(200)
  async webToCaseIntake(@Body() body: unknown, @Req() request: { ip?: string }) {
    const parsed = z.object({
      name: z.string().trim().min(1).max(255),
      description: z.string().trim().max(10_000).optional(),
      requesterName: z.string().trim().max(255).optional(),
      requesterEmail: z.string().trim().max(255).optional(),
      idempotencyKey: z.string().trim().min(1).max(128).optional(),
      website: z.string().optional(),
    }).safeParse(body ?? {});
    if (!parsed.success) {
      throw new ValidationError("Invalid intake payload.", { issues: parsed.error.issues.map((i) => i.message) });
    }
    return this.webToCase.submit({ ...parsed.data, clientIp: request?.ip });
  }

  /** Duplicate candidates for a case (P2). */
  @Get("action/case/:id/duplicateCandidates")
  async duplicateCandidates(@Param("id") id: string) {
    return { caseId: id, candidates: await this.caseMerge.duplicateCandidates(id) };
  }

  /** Merge source case into target case. */
  @Post("action/case/:id/merge")
  @HttpCode(200)
  async caseMergeCmd(@Param("id") id: string, @Body() body: unknown) {
    const parsed = z.object({ intoCaseId: z.string().min(1) }).safeParse(body ?? {});
    if (!parsed.success) throw new ValidationError("Invalid merge payload.", { issues: parsed.error.issues.map((i) => i.message) });
    return this.caseMerge.merge(id, parsed.data.intoCaseId);
  }

  /** Create a CSAT invitation for a case. */
  @Post("action/case/:id/csat/invite")
  @HttpCode(200)
  async csatInvite(@Param("id") id: string) {
    return this.csat.createInvitation(id);
  }

  /** Submit a CSAT response (public, token-based). */
  @Public()
  @Post("action/csat/submit")
  @HttpCode(200)
  async csatSubmit(@Body() body: unknown) {
    const parsed = z.object({ token: z.string().min(1), rating: z.coerce.number().int().min(1).max(5), feedback: z.string().max(4000).optional() }).safeParse(body ?? {});
    if (!parsed.success) throw new ValidationError("Invalid CSAT payload.", { issues: parsed.error.issues.map((i) => i.message) });
    return this.csat.submit(parsed.data.token, parsed.data.rating, parsed.data.feedback);
  }

  /** CSAT results for a case. */
  @Get("action/case/:id/csat")
  async csatResults(@Param("id") id: string) {
    return this.csat.results(id);
  }

  private requireAdmin(action: string): void {
    if (!this.scope.isAdmin) {
      throw new AuthorizationDeniedError(`Administrator access is required for ${action}.`);
    }
  }

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

function parse<T extends ZodTypeAny>(schema: T, body: unknown): T["_output"] {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    throw new InvalidQueryError("The request is not valid.", {
      issues: parsed.error.issues.map((issue) => issue.message),
    });
  }
  return parsed.data;
}
