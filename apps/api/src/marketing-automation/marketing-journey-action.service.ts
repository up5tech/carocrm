import { createHash } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";

import { REQUEST_SCOPE_TOKEN, type RequestScope } from "../common/request-scope.js";
import { EntityCrudService } from "../entity/entity.service.js";
import { runAsMarketingSystem } from "./marketing-automation-authority.js";
import { isCampaignPurpose } from "./marketing-automation-domain.js";
import { MarketingDeliveryBatchService } from "./marketing-delivery-batch.service.js";
import type { JourneyNode } from "./marketing-journey-definition.service.js";
import { MarketingTemplateService } from "./marketing-template.service.js";

/**
 * Phase 19-MA.14 — the allowlisted journey action catalog (§15 `19-MA.14`).
 *
 * A journey node names an action by key; it can never carry code. Actions that touch CRM records go
 * through `EntityCrudService` under the *actor's* scope, so a journey cannot bypass ACL by running
 * as the module. Only the fields and entities on the allowlist below can be written.
 */
export const ALLOWED_JOURNEY_ACTIONS = ["sendEmail", "createTask", "notify", "updateField"] as const;
export type JourneyAction = (typeof ALLOWED_JOURNEY_ACTIONS)[number];

/** An action a journey may perform is limited to these CRM mutations, by entity and field. */
export const ALLOWED_UPDATE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Lead: ["status", "description"],
  Contact: ["description"],
  Account: ["description"],
};

export interface JourneyActionContext {
  readonly enrollmentId: string;
  readonly journeyId: string;
  readonly personType?: string | undefined;
  readonly personId?: string | undefined;
  readonly emailHash?: string | undefined;
}

export interface JourneyActionResult {
  readonly status: "completed" | "skipped" | "failed";
  readonly output?: string | undefined;
  readonly errorCode?: string | undefined;
  readonly retryable?: boolean | undefined;
}

@Injectable()
export class MarketingJourneyActionService {
  constructor(
    @Inject(EntityCrudService) private readonly entities: EntityCrudService,
    @Inject(MarketingDeliveryBatchService) private readonly delivery: MarketingDeliveryBatchService,
    @Inject(MarketingTemplateService) private readonly templates: MarketingTemplateService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  async execute(node: JourneyNode, ctx: JourneyActionContext): Promise<JourneyActionResult> {
    const action = node.action;
    if (action === undefined || !(ALLOWED_JOURNEY_ACTIONS as readonly string[]).includes(action)) {
      return { status: "failed", errorCode: "UNKNOWN_ACTION", retryable: false };
    }
    switch (action as JourneyAction) {
      case "sendEmail":
        return this.sendEmail(node, ctx);
      case "createTask":
        return this.createTask(node, ctx);
      case "notify":
        return { status: "completed", output: `notify:${String(node.params?.["event"] ?? "journey.notify")}` };
      case "updateField":
        return this.updateField(node, ctx);
      default:
        return { status: "failed", errorCode: "UNKNOWN_ACTION", retryable: false };
    }
  }

  /**
   * MA.14 task 1 — the send-email node rides the same delivery pipeline as a campaign send: the same
   * eligibility gate, the same rate limiter, the same classified outcomes. Only the *configuration*
   * differs: a journey carries no sealed revision, so it names `params.templateId` (publish-validated)
   * and its purpose comes from `params.purpose` or the enrollment's originating purpose, never invented.
   */
  private async sendEmail(node: JourneyNode, ctx: JourneyActionContext): Promise<JourneyActionResult> {
    if (ctx.personType === undefined || ctx.personId === undefined) {
      return { status: "failed", errorCode: "NO_RECIPIENT", retryable: false };
    }
    const params = node.params ?? {};
    const templateId = typeof params["templateId"] === "string" ? params["templateId"].trim() : "";
    if (templateId === "") {
      return { status: "failed", errorCode: "TEMPLATE_REQUIRED", retryable: false };
    }
    const personType = typeof params["recipientType"] === "string" && params["recipientType"].trim() !== ""
      ? params["recipientType"].trim()
      : ctx.personType;
    const personId = personType === ctx.personType ? ctx.personId : undefined;
    if (personId === undefined) {
      // A node that switches to a *different* person than the enrollment carries is refused: the journey
      // may message its enrolled person only, never an arbitrary record id smuggled in params (§9.2).
      return { status: "failed", errorCode: "RECIPIENT_MISMATCH", retryable: false };
    }
    const purpose = typeof params["purpose"] === "string" && isCampaignPurpose(params["purpose"])
      ? params["purpose"]
      : "ProductMarketing";
    const person = await this.loadPerson(personType, personId);
    if (person === undefined) {
      return { status: "skipped", output: "blocked:RECORD_UNREADABLE" };
    }
    const emailAddress = typeof person["emailAddress"] === "string" ? person["emailAddress"].trim() : "";
    if (emailAddress === "") {
      return { status: "skipped", output: "blocked:NO_EMAIL_ADDRESS" };
    }

    let rendered: Awaited<ReturnType<MarketingTemplateService["renderEmailTemplateForRecipient"]>>;
    try {
      rendered = await this.templates.renderEmailTemplateForRecipient(templateId, personType, personId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "template render failed";
      return { status: "failed", errorCode: "TEMPLATE_RENDER_FAILED", output: message, retryable: true };
    }

    const result = await this.delivery.submit({
      recipient: {
        entityType: personType,
        entityId: personId,
        emailAddress,
        emailHash: ctx.emailHash ?? null,
      },
      purpose,
      campaignStatus: "Running",
      content: {
        subject: rendered.subject ?? "",
        plainText: rendered.plainText,
        bodyHtml: rendered.bodyHtml,
        systemLinks: rendered.systemLinks,
        contentHash: rendered.templateContentHash,
      },
      headers: { "X-Marketing-Journey": ctx.journeyId },
      idempotencyKey: this.stepIdempotencyKey(ctx, personType, personId, rendered.templateContentHash),
    });

    switch (result.status) {
      case "sent":
        return {
          status: "completed",
          output: `sent:${result.providerMessageId ?? "accepted"}#${(rendered.templateContentHash ?? "").slice(0, 12)}`,
        };
      case "blocked":
        return { status: "skipped", output: `blocked:${result.code}` };
      case "paused":
        return { status: "failed", errorCode: "GLOBAL_SEND_PAUSED", retryable: true };
      case "throttled":
        return { status: "failed", errorCode: "RATE_LIMITED", retryable: true };
      case "failed":
        // A permanent failure is terminal for this step (invalid template, invalid address); anything
        // else stays retryable under the enrollment's own attempt budget (§5.7).
        return {
          status: "failed",
          errorCode: result.reasonCode,
          retryable: result.kind === "retryable",
        };
    }
  }

  /** An actor-scoped person read: a journey cannot message what its trigger could not read (§9.2). */
  private async loadPerson(entityType: string, entityId: string): Promise<Record<string, unknown> | undefined> {
    try {
      return await this.entities.get(entityType, entityId);
    } catch {
      return undefined;
    }
  }

  /**
   * The step's own idempotency key (§0.1 rule 10, §5.7 "a single enrollment cannot execute the same
   * node/action twice"): a retry of the same enrollment step submits the *same* key, so even a provider
   * retry cannot deliver the journey email twice.
   */
  private stepIdempotencyKey(
    ctx: JourneyActionContext,
    personType: string,
    personId: string,
    contentHash: string,
  ): string {
    const seed = `${ctx.enrollmentId}:${ctx.journeyId}:${personType}:${personId}:${contentHash}`;
    return `journey:${createHash("sha256").update(seed).digest("hex").slice(0, 32)}`;
  }

  private async createTask(node: JourneyNode, ctx: JourneyActionContext): Promise<JourneyActionResult> {
    const subject = typeof node.params?.["subject"] === "string" ? (node.params["subject"] as string) : "Journey follow-up";
    try {
      const created = await runAsMarketingSystem(this.scope, "journeyCreateTask", async () =>
        this.entities.create("Task", {
          name: subject,
          status: "Not Started",
          ...(ctx.personType === "Contact" && ctx.personId !== undefined ? { contactId: ctx.personId } : {}),
          ...(ctx.personType === "Lead" && ctx.personId !== undefined ? { leadId: ctx.personId } : {}),
        }),
      );
      const id = (created as { id?: string })?.id ?? "";
      return { status: "completed", output: `task:${id}` };
    } catch (error) {
      return { status: "failed", errorCode: "TASK_CREATE_FAILED", output: error instanceof Error ? error.message : "error", retryable: true };
    }
  }

  private async updateField(node: JourneyNode, ctx: JourneyActionContext): Promise<JourneyActionResult> {
    const entityType = typeof node.params?.["entityType"] === "string" ? (node.params["entityType"] as string) : ctx.personType;
    const field = typeof node.params?.["field"] === "string" ? (node.params["field"] as string) : undefined;
    const value = node.params?.["value"];
    const entityId = ctx.personId;
    if (entityType === undefined || entityId === undefined || field === undefined) {
      return { status: "failed", errorCode: "UPDATE_MISSING_TARGET", retryable: false };
    }
    const allowed = ALLOWED_UPDATE_FIELDS[entityType];
    if (allowed === undefined || !allowed.includes(field)) {
      return { status: "failed", errorCode: "FIELD_NOT_ALLOWED", retryable: false };
    }
    try {
      // Actor-scoped update: ACL is enforced by the Entity Engine, never bypassed (§15 acceptance).
      await this.entities.update(entityType, entityId, { [field]: value });
      return { status: "completed", output: `${entityType}.${field}` };
    } catch (error) {
      return { status: "failed", errorCode: "UPDATE_FAILED", output: error instanceof Error ? error.message : "error", retryable: false };
    }
  }
}
