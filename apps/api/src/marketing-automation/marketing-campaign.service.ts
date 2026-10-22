import {
  FeatureDisabledError,
  NotFoundError,
  ValidationError,
} from "@carocrm/core/errors/index.js";
import { Inject, Injectable } from "@nestjs/common";

import { AclApiService } from "../acl/acl-api.service.js";
import { REQUEST_SCOPE_TOKEN, type RequestScope } from "../common/request-scope.js";
import { DatabaseService } from "../database/database.service.js";
import { EntityCrudService } from "../entity/entity.service.js";
import { runInTransaction } from "../entity/tx-context.js";
import { EventBus } from "../events/event-bus.js";
import { runAsMarketingSystem } from "./marketing-automation-authority.js";
import {
  allowedCampaignCommands,
  CAMPAIGN_COMMANDS,
  CAMPAIGN_ENTITY,
  CAMPAIGN_TRANSITION_ENTITY,
  type CampaignCommand,
  campaignCommandTarget,
  type CampaignStatus,
  type CampaignValidationReport,
  checkCampaignTransition,
  isCampaignStatus,
} from "./marketing-automation-domain.js";
import { CAMPAIGN_EVENT_BY_COMMAND, campaignEvent } from "./marketing-automation-events.js";
import { runAsMarketingInternal } from "./marketing-automation-internal.js";
import { MarketingAutomationRecords } from "./marketing-automation-records.js";
import { MarketingAutomationSettingsService } from "./marketing-automation-settings.service.js";
import { MarketingCampaignValidationService } from "./marketing-campaign-validation.service.js";

/**
 * Phase 19-MA.3 — the `Campaign` lifecycle
 * (PLAN_Phase_19_Marketing_Automation.md §5.1, §8.2, §15 `19-MA.3`).
 *
 * Every status move is a **named server-side command**, never a bare field write: §8.2 is explicit that a
 * client must not be able to move a campaign by patching `status`. One command validates the source state,
 * the actor's record permission, and — for `schedule`, `start` and `resume` — the send-readiness report
 * (§5.1), then writes the campaign, appends its `CampaignTransition` history row and dispatches the domain
 * event **in one transaction**. A refusal anywhere leaves no partial write, so an illegal transition cannot
 * half-apply (§15 acceptance: "illegal transitions are rejected server-side").
 *
 * History is its own record and not only an audit line because §5.1 asks for a campaign's *operational*
 * story: which command ran, who ran it, with which reason, under which validation report, and with which
 * idempotency key a retry was made safe. Generic field audit expresses none of that — the same reason
 * Service Desk keeps `CaseTransition`.
 */

export interface CampaignTransitionRequest {
  readonly command?: CampaignCommand | undefined;
  readonly to?: CampaignStatus | undefined;
  readonly reason?: string | undefined;
  readonly idempotencyKey?: string | undefined;
  readonly version?: number | undefined;
}

export interface CampaignTransitionResult {
  readonly campaignId: string;
  readonly from: CampaignStatus;
  readonly to: CampaignStatus;
  readonly command: CampaignCommand;
  readonly changed: boolean;
  readonly idempotent: boolean;
  readonly transitionId: string | null;
  readonly blockers?: readonly string[] | undefined;
}

export interface CampaignCapabilities {
  readonly campaignId: string;
  readonly status: CampaignStatus;
  readonly mayEdit: boolean;
  readonly allowedCommands: readonly CampaignCommand[];
  readonly lastValidatedAt: string | null;
  readonly validationHash: string | null;
  readonly report: CampaignValidationReport;
}

export interface CampaignTransitionView {
  readonly id: string;
  readonly campaignId: string;
  readonly fromStatus: string;
  readonly toStatus: string;
  readonly command: string;
  readonly reason: string | null;
  readonly actorUserId: string | null;
  readonly actorType: string;
  readonly validationHash: string | null;
  readonly idempotencyKey: string | null;
  readonly occurredAt: string | null;
  _linkLabels?: Record<string, Record<string, string>>;
}

/** The commands whose permission to proceed is the send-readiness report (§5.1). */
const GATED_COMMANDS: readonly CampaignCommand[] = ["schedule", "start", "resume"];

@Injectable()
export class MarketingCampaignService {
  constructor(
    @Inject(MarketingAutomationRecords) private readonly records: MarketingAutomationRecords,
    @Inject(MarketingCampaignValidationService) private readonly validation: MarketingCampaignValidationService,
    @Inject(MarketingAutomationSettingsService) private readonly settings: MarketingAutomationSettingsService,
    @Inject(EntityCrudService) private readonly entities: EntityCrudService,
    @Inject(AclApiService) private readonly acl: AclApiService,
    @Inject(EventBus) private readonly events: EventBus,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  /** What this actor may do on this campaign, in the state it is actually in — the SPA renders this verbatim. */
  async capabilities(campaignId: string): Promise<CampaignCapabilities> {
    const record = await this.entities.get(CAMPAIGN_ENTITY, campaignId);
    const status = isCampaignStatus(record["status"]) ? record["status"] : "Draft";
    const decision = await this.acl.canAccessRecord(CAMPAIGN_ENTITY, "edit", recordShape(campaignId, record));
    const report = await this.validation.report(campaignId);
    return {
      campaignId,
      status,
      mayEdit: decision.allowed === true,
      allowedCommands: decision.allowed === true ? allowedCampaignCommands(status) : [],
      lastValidatedAt: text(record["lastValidatedAt"]) ?? null,
      validationHash: text(record["validationHash"]) ?? null,
      report,
    };
  }

  /** The command history of a campaign, oldest first. Read access to the campaign is required. */
  async history(campaignId: string): Promise<{ list: CampaignTransitionView[] }> {
    await this.entities.get(CAMPAIGN_ENTITY, campaignId);
    const rows = await this.records.findByAttr(CAMPAIGN_TRANSITION_ENTITY, "campaignId", campaignId);
    const list = rows
      .map((row) => toTransitionView(row.id, row.data))
      .sort((left, right) => (left.occurredAt ?? "").localeCompare(right.occurredAt ?? ""));
    await this.entities.attachLinkLabels(list, { actorUserId: "User" });
    return { list };
  }

  /** Run one named lifecycle command (`schedule`, `start`, `pause`, …). */
  async run(
    campaignId: string,
    command: CampaignCommand,
    request: Omit<CampaignTransitionRequest, "command" | "to"> = {},
  ): Promise<CampaignTransitionResult> {
    return this.transition(campaignId, { ...request, command });
  }

  async transition(campaignId: string, request: CampaignTransitionRequest): Promise<CampaignTransitionResult> {
    const actor = this.scope.requirePrincipal();
    const settings = await this.settings.settings();
    if (!settings.features.campaigns) throw new FeatureDisabledError("campaigns");

    const row = await this.records.byId(CAMPAIGN_ENTITY, campaignId);
    if (row === undefined) throw new NotFoundError(`Campaign "${campaignId}" does not exist.`);
    // A transition is a write on this record. Entity-level edit is not enough: the actor's record scope
    // (own/team) and principal type must allow it (§9.2).
    await this.acl.assertRecordAccess(CAMPAIGN_ENTITY, "edit", recordShape(campaignId, row.data));

    const from = isCampaignStatus(row.data["status"]) ? row.data["status"] : "Draft";
    const command = resolveCommand(request, from);
    const to = campaignCommandTarget(command);

    const check = checkCampaignTransition({
      from,
      command,
      ...(request.to !== undefined ? { to: request.to } : {}),
    });
    if (!check.allowed) {
      throw new ValidationError(check.message ?? "Invalid campaign transition.", {
        code: check.code ?? "CAMPAIGN_TRANSITION_NOT_ALLOWED",
        campaignId,
        from,
        to,
      });
    }

    const idempotencyKey = request.idempotencyKey?.trim();
    if (idempotencyKey !== undefined && idempotencyKey !== "") {
      const prior = (await this.records
        .findByAttr(CAMPAIGN_TRANSITION_ENTITY, "idempotencyKey", idempotencyKey, { limit: 5 }))
        .find((candidate) => candidate.data["campaignId"] === campaignId);
      if (prior !== undefined) {
        // A replayed command is a no-op carrying the original answer, never a second event (§0.1 rule 10).
        return {
          campaignId,
          from,
          to: isCampaignStatus(prior.data["toStatus"]) ? prior.data["toStatus"] : to,
          command,
          changed: false,
          idempotent: true,
          transitionId: prior.id,
        };
      }
    }

    if (from === to) {
      return { campaignId, from, to, command, changed: false, idempotent: false, transitionId: null };
    }

    // The §5.1 gate, computed against the row as it stands *now* — not the report stored earlier.
    const report = await this.validation.build(campaignId, row.data, { as: to });
    if (GATED_COMMANDS.includes(command) && !report.valid) {
      throw new ValidationError(
        `This campaign cannot be ${pastTense(command)} yet. ${report.blockers.map((finding) => finding.message).join(" ")}`,
        {
          code: "CAMPAIGN_VALIDATION_BLOCKED",
          campaignId,
          blockers: report.blockers,
          warnings: report.warnings,
        },
      );
    }

    // `cancel` is the command that stops production messages, so §10.2's explicit confirmation is a
    // server-side requirement, not a UI convention.
    if (command === "cancel" && (request.reason ?? "").trim() === "") {
      throw new ValidationError(
        "Cancelling a campaign stops its messages, so it needs a reason the audit trail can show later (§10.2).",
        { code: "CAMPAIGN_CANCEL_REASON_REQUIRED", campaignId },
      );
    }

    const now = new Date();
    const patch = buildPatch({
      command,
      to,
      now,
      defaultTimeZone: settings.defaults.timezone,
      hasTimeZone: text(row.data["timezone"]) !== undefined,
    });

    const transitionId = await runInTransaction(this.database.db, async (tx) => {
      await runAsMarketingInternal(() =>
        this.entities.update(CAMPAIGN_ENTITY, campaignId, {
          ...patch,
          ...(request.version !== undefined ? { version: request.version } : {}),
        }),
      );
      const history = await runAsMarketingSystem(this.scope, "campaignTransitionHistory", () =>
        this.entities.create(CAMPAIGN_TRANSITION_ENTITY, {
          campaignId,
          campaignCode: text(row.data["code"]) ?? null,
          fromStatus: from,
          toStatus: to,
          command,
          reason: request.reason?.trim() || null,
          actorUserId: actor.userId,
          actorType: actor.userType,
          validationHash: report.validationHash,
          idempotencyKey: idempotencyKey ?? null,
          occurredAt: now.toISOString(),
        }),
      );
      await this.events.dispatch(tx, campaignEvent({
        type: CAMPAIGN_EVENT_BY_COMMAND[command],
        campaignId,
        campaignCode: text(row.data["code"]) ?? null,
        from,
        to,
        actorUserId: actor.userId,
        actorType: actor.userType,
        ...(idempotencyKey !== undefined ? { correlationId: idempotencyKey } : {}),
      }));
      return String(history["id"]);
    });

    return { campaignId, from, to, command, changed: true, idempotent: false, transitionId };
  }

  /**
   * Produce, and store when the actor may edit, the send-readiness report. A user who can only read the
   * campaign still gets the answer — §8.4 asks for a report listing blocking errors and warnings — but
   * cannot leave a write behind them.
   */
  async validate(
    campaignId: string,
    options: { readonly as?: CampaignStatus | undefined } = {},
  ): Promise<CampaignValidationReport> {
    const settings = await this.settings.settings();
    if (!settings.features.campaigns) throw new FeatureDisabledError("campaigns");
    const row = await this.records.byId(CAMPAIGN_ENTITY, campaignId);
    if (row === undefined) throw new NotFoundError(`Campaign "${campaignId}" does not exist.`);
    await this.acl.assertRecordAccess(CAMPAIGN_ENTITY, "read", recordShape(campaignId, row.data));

    const report = await this.validation.build(campaignId, row.data, options);
    const decision = await this.acl.canAccessRecord(CAMPAIGN_ENTITY, "edit", recordShape(campaignId, row.data));
    if (decision.allowed === true) {
      await runAsMarketingInternal(() =>
        this.entities.update(CAMPAIGN_ENTITY, campaignId, {
          validationReport: JSON.stringify(report),
          validationHash: report.validationHash,
          lastValidatedAt: report.checkedAt,
        }),
      );
    }
    return report;
  }

  /**
   * Duplicate as a fresh Draft (§5.1: "without copying delivery history, sent recipient state, live
   * enrollments, signed links or provider identifiers").
   *
   * The copy is assembled from an allowlist of *configuration* fields rather than by subtracting runtime
   * fields, so a status stamp, a validation report, or a provider/recipient reference added by MA.8–MA.10
   * cannot leak into a new draft just because nobody remembered to exclude it.
   */
  async duplicateAsDraft(
    campaignId: string,
    input: {
      readonly name?: string | undefined;
      readonly code?: string | undefined;
      readonly includeAudience?: boolean | undefined;
      readonly includeContent?: boolean | undefined;
      readonly idempotencyKey?: string | undefined;
    },
  ): Promise<Record<string, unknown>> {
    const settings = await this.settings.settings();
    if (!settings.features.campaigns) throw new FeatureDisabledError("campaigns");
    const actor = this.scope.requirePrincipal();
    const source = await this.entities.get(CAMPAIGN_ENTITY, campaignId);
    const from = isCampaignStatus(source["status"]) ? source["status"] : "Draft";
    const name = input.name?.trim() || `${String(source["name"] ?? "Campaign")} (copy)`;
    const now = new Date();

    const data: Record<string, unknown> = {
      name,
      status: "Draft",
      type: source["type"] ?? null,
      purpose: source["purpose"] ?? null,
      serviceNoticeAcknowledged: source["serviceNoticeAcknowledged"] === true,
      description: source["description"] ?? null,
      objective: source["objective"] ?? null,
      source: source["source"] ?? null,
      timezone: source["timezone"] ?? null,
      budgetAmount: source["budgetAmount"] ?? null,
      budgetCurrency: source["budgetCurrency"] ?? null,
      trackingOpen: source["trackingOpen"] ?? null,
      trackingClick: source["trackingClick"] ?? null,
      duplicatedFromId: campaignId,
      // Never copied: every lifecycle stamp, the validation report and hash, `failureReason`, and — by
      // construction — any recipient, delivery, enrollment or provider reference a later phase adds.
    };
    if (input.code !== undefined && input.code.trim() !== "") data["code"] = input.code.trim();
    const copyAudience = input.includeAudience === true;
    if (input.includeContent === true) {
      data["templateId"] = source["templateId"] ?? null;
      data["emailAccountId"] = source["emailAccountId"] ?? null;
    }

    return runInTransaction(this.database.db, async (tx) => {
      const created = await runAsMarketingInternal(() => this.entities.create(CAMPAIGN_ENTITY, data));
      const createdId = String(created["id"]);
      await runAsMarketingSystem(this.scope, "campaignDuplicated", () =>
        this.entities.create(CAMPAIGN_TRANSITION_ENTITY, {
          campaignId: createdId,
          campaignCode: text(created["code"]) ?? null,
          fromStatus: from,
          toStatus: "Draft",
          command: "duplicate",
          reason: `Duplicated as a draft from campaign ${campaignId}.`,
          actorUserId: actor.userId,
          actorType: actor.userType,
          validationHash: null,
          idempotencyKey: input.idempotencyKey ?? null,
          occurredAt: now.toISOString(),
        }),
      );
      if (copyAudience) {
        // Audience composition is relation links, not attributes, so it is copied here rather than in the
        // field allowlist — and only the configuration: no history, no snapshot, no recipient reference.
        for (const relation of ["includedTargetLists", "excludedTargetLists"] as const) {
          for (const listId of await this.records.linkedRecordIds(CAMPAIGN_ENTITY, campaignId, relation)) {
            await runAsMarketingInternal(() => this.entities.link(CAMPAIGN_ENTITY, createdId, relation, listId));
          }
        }
      }
      await this.events.dispatch(tx, campaignEvent({
        type: "marketingAutomation.campaign.duplicated",
        campaignId: createdId,
        campaignCode: text(created["code"]) ?? null,
        from,
        to: "Draft",
        actorUserId: actor.userId,
        actorType: actor.userType,
        ...(input.idempotencyKey !== undefined ? { correlationId: input.idempotencyKey } : {}),
      }));
      return created;
    });
  }
}

/**
 * A command is the contract. A bare `to` is accepted only where exactly one command owns that move, and then
 * it runs *that* command — so a client cannot reach `Running` by asserting a status and skipping `start`
 * with its send-readiness gate (§8.2). `Running` and `Archived` have two owning commands each and are
 * therefore refused: the caller must say which it means.
 */
function resolveCommand(request: CampaignTransitionRequest, from: CampaignStatus): CampaignCommand {
  if (request.command !== undefined) return request.command;
  if (request.to === undefined) {
    throw new ValidationError("A campaign transition needs a command.", {
      code: "CAMPAIGN_TRANSITION_UNDECLARED",
      campaignId: undefined,
      from,
    });
  }
  const owners = CAMPAIGN_COMMANDS.filter((command) => campaignCommandTarget(command) === request.to);
  if (owners.length !== 1) {
    throw new ValidationError(
      owners.length === 0
        ? `"${request.to}" is not a campaign status a command can reach.`
        : `Moving a campaign to "${request.to}" requires naming the command that owns that move (${owners.join(" or ")}), so its checks cannot be skipped (§8.2).`,
      { code: "CAMPAIGN_COMMAND_REQUIRED", from, to: request.to },
    );
  }
  return owners[0] as CampaignCommand;
}

function buildPatch(input: {
  command: CampaignCommand;
  to: CampaignStatus;
  now: Date;
  defaultTimeZone: string;
  hasTimeZone: boolean;
}): Record<string, unknown> {
  const at = input.now.toISOString();
  // The status itself is always written: this patch is the only place a campaign's state changes, and it is
  // produced by a command that has already validated the edge.
  const patch: Record<string, unknown> = { status: input.to };
  switch (input.command) {
    case "schedule":
      patch["scheduledAt"] = at;
      // The deployment default is consumed here, and only for a campaign that never named a zone; an
      // explicit choice is never overwritten (§13).
      if (!input.hasTimeZone) patch["timezone"] = input.defaultTimeZone;
      break;
    case "unschedule":
      patch["scheduledAt"] = null;
      break;
    case "start":
      patch["startedAt"] = at;
      break;
    case "pause":
      patch["pausedAt"] = at;
      break;
    case "resume":
      patch["resumedAt"] = at;
      break;
    case "complete":
      patch["completedAt"] = at;
      break;
    case "cancel":
      patch["cancelledAt"] = at;
      patch["archivedAt"] = at;
      break;
    case "archive":
      patch["archivedAt"] = at;
      break;
  }
  return patch;
}

function pastTense(command: CampaignCommand): string {
  switch (command) {
    case "schedule":
      return "scheduled";
    case "start":
      return "started";
    case "resume":
      return "resumed";
    default:
      return command;
  }
}

function toTransitionView(id: string, data: Record<string, unknown>): CampaignTransitionView {
  return {
    id,
    campaignId: text(data["campaignId"]) ?? "",
    fromStatus: text(data["fromStatus"]) ?? "",
    toStatus: text(data["toStatus"]) ?? "",
    command: text(data["command"]) ?? "",
    reason: text(data["reason"]) ?? null,
    actorUserId: text(data["actorUserId"]) ?? null,
    actorType: text(data["actorType"]) ?? "user",
    validationHash: text(data["validationHash"]) ?? null,
    idempotencyKey: text(data["idempotencyKey"]) ?? null,
    occurredAt: text(data["occurredAt"]) ?? null,
  };
}

/** The shape the record-level ACL evaluator needs, from a stored row or a serialised record alike. */
function recordShape(id: string, data: Record<string, unknown>) {
  return {
    id,
    assignedUserId: text(data["assignedUserId"]) ?? undefined,
    createdById: text(data["createdById"]) ?? undefined,
    teams: Array.isArray(data["teams"]) ? (data["teams"] as string[]) : [],
    data,
  };
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}
