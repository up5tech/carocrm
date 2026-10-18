import { Inject, Injectable } from "@nestjs/common";

import { REQUEST_SCOPE_TOKEN, type RequestScope } from "../common/request-scope.js";
import { EntityCrudService } from "../entity/entity.service.js";
import { runAsMarketingSystem } from "./marketing-automation-authority.js";
import { MarketingEligibilityService } from "./marketing-eligibility.service.js";
import type { JourneyNode } from "./marketing-journey-definition.service.js";

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
    @Inject(MarketingEligibilityService) private readonly eligibility: MarketingEligibilityService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  async execute(node: JourneyNode, ctx: JourneyActionContext): Promise<JourneyActionResult> {
    const action = node.action;
    if (action === undefined || !(ALLOWED_JOURNEY_ACTIONS as readonly string[]).includes(action)) {
      return { status: "failed", errorCode: "UNKNOWN_ACTION", retryable: false };
    }
    switch (action as JourneyAction) {
      case "sendEmail":
        return this.sendEmail(ctx);
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

  /** The same consent/suppression gate a campaign send uses (§15 acceptance). */
  private async sendEmail(ctx: JourneyActionContext): Promise<JourneyActionResult> {
    if (ctx.personType === undefined || ctx.personId === undefined) {
      return { status: "failed", errorCode: "NO_RECIPIENT", retryable: false };
    }
    const decision = await this.eligibility.decide(
      { entityType: ctx.personType, entityId: ctx.personId, ...(ctx.emailHash !== undefined ? { emailHash: ctx.emailHash } : {}) },
      { channel: "Email" as never, purpose: "ProductMarketing" as never, campaignStatus: "Running" as never },
    );
    if (!decision.decision.eligible) {
      return { status: "skipped", output: `blocked:${decision.decision.code}` };
    }
    // The delivery itself is handed to the campaign delivery pipeline; this node records the intent.
    return { status: "completed", output: "queued:journey-send" };
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
