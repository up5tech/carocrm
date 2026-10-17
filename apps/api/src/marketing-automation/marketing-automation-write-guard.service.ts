import { FeatureDisabledError, ValidationError } from "@carocrm/core/errors/index.js";
import type { HookContext } from "@carocrm/entity-engine/types/index.js";
import type { OnApplicationBootstrap } from "@nestjs/common";
import { Inject, Injectable } from "@nestjs/common";

import { REQUEST_SCOPE_TOKEN, type RequestScope } from "../common/request-scope.js";
import { HookRegistry } from "../hooks/hook.registry.js";
import {
  CAMPAIGN_CODE_MAX_LENGTH,
  CAMPAIGN_ENTITY,
  CAMPAIGN_TRANSITION_ENTITY,
  changedKeys,
  isCampaignStatus,
  isSupportedTimeZone,
  TARGET_LIST_ENTITY,
  TARGET_LIST_ENTRY_ENTITY,
} from "./marketing-automation-domain.js";
import {
  isMarketingInternalWrite,
  SERVER_OWNED_CAMPAIGN_FIELDS,
  SERVER_OWNED_TARGET_LIST_ENTRY_FIELDS,
  SERVER_OWNED_TARGET_LIST_FIELDS,
  SERVER_OWNED_TRANSITION_FIELDS,
} from "./marketing-automation-internal.js";
import { MarketingAutomationRecords } from "./marketing-automation-records.js";
import { MarketingAutomationSettingsService } from "./marketing-automation-settings.service.js";

/**
 * Phase 19-MA.3 — the campaign and audience write guard
 * (PLAN_Phase_19_Marketing_Automation.md §5.1, §8.2, §8.4, §15 `19-MA.3` acceptance).
 *
 * The generic record API reaches the very same rows the domain services write, so these `beforeValidate`
 * handlers are what make the module's invariants real rather than advisory:
 *
 *  1. **a client may not write a server-owned field.** `status`, the lifecycle stamps, the validation report
 *     and its hash, `failureReason` and `duplicatedFromId` are all set by the lifecycle commands, which
 *     validate the transition, the actor and the send-readiness gate first. A patch that could set `status`
 *     would be a way around all three — the thing §8.2 forbids in as many words.
 *  2. **a new campaign is a Draft, or it is nothing.** §1.2's "safe by default" rule is enforced at the write,
 *     not in the form: creating a record that already reads `Running` would advertise a campaign that has
 *     not passed a single check.
 *  3. **history and membership rows are written by the module, never by a caller.** A `CampaignTransition`
 *     row is the audit trail of a command that ran; a client-authored one would be a fabricated history.
 *     Same for `TargetListEntry`, which is evidence of who put a record in an audience.
 *  4. **a campaign code is unique among live campaigns** and shaped like a code, so `code` can be used as a
 *     stable external reference. Migration 037 also enforces it in the database — a pre-check here gives the
 *     caller a readable message instead of a constraint error.
 *
 * A feature being off refuses writes and leaves existing records readable, which is the documented
 * disabled-capability behaviour (§17 of the Service Desk plan, AGENTS.md §5.5). Portal principals are
 * refused outright: Marketing Automation has no portal-facing record in any delivered phase, so there is no
 * payload from that surface that should reach these tables at all (§9.2).
 */
@Injectable()
export class MarketingAutomationWriteGuardService implements OnApplicationBootstrap {
  constructor(
    @Inject(HookRegistry) private readonly hooks: HookRegistry,
    @Inject(MarketingAutomationSettingsService) private readonly settings: MarketingAutomationSettingsService,
    @Inject(MarketingAutomationRecords) private readonly records: MarketingAutomationRecords,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  onApplicationBootstrap(): void {
    this.register();
  }

  register(): void {
    this.hooks.register({
      name: "marketingAutomation.campaignWriteGuard",
      phase: "beforeValidate",
      entity: CAMPAIGN_ENTITY,
      handler: (context) => this.handleCampaign(context),
    });
    this.hooks.register({
      name: "marketingAutomation.targetListGuard",
      phase: "beforeValidate",
      entity: TARGET_LIST_ENTITY,
      handler: (context) => this.handleTargetList(context),
    });
    for (const [entity, fields] of [
      [TARGET_LIST_ENTRY_ENTITY, SERVER_OWNED_TARGET_LIST_ENTRY_FIELDS],
      [CAMPAIGN_TRANSITION_ENTITY, SERVER_OWNED_TRANSITION_FIELDS],
    ] as const) {
      this.hooks.register({
        name: `marketingAutomation.${entity}Guard`,
        phase: "beforeValidate",
        entity,
        handler: (context) => this.handleInternalOnly(entity, fields, context),
      });
    }
  }

  private async handleCampaign(context: HookContext): Promise<void> {
    const data = context.data;
    if (data === undefined) return;
    this.assertNotPortal(CAMPAIGN_ENTITY);
    const internal = isMarketingInternalWrite();

    if (!internal) {
      const settings = await this.settings.settings();
      if (!settings.features.campaigns) throw new FeatureDisabledError("campaigns");

      const changed =
        context.operation === "create" ? Object.keys(data) : changedKeys(data, context.previous ?? {});
      const offending = changed.filter((key) => SERVER_OWNED_CAMPAIGN_FIELDS.includes(key));
      if (offending.length > 0) {
        throw new ValidationError(
          `These fields on ${CAMPAIGN_ENTITY} are set by Marketing Automation commands and cannot be written through the record API: ${offending.join(", ")}.`,
          { entity: CAMPAIGN_ENTITY, fields: offending },
        );
      }

      if (context.operation === "create") {
        const requested = data["status"];
        // Absent is fine — the metadata default is Draft. Anything else is a claim the server has not earned.
        if (requested !== undefined && requested !== null && requested !== "Draft") {
          throw new ValidationError(
            "A new campaign is created as a Draft; the schedule and start commands decide when it becomes live (§1.2).",
            { entity: CAMPAIGN_ENTITY, code: "CAMPAIGN_STATUS_COMMAND_ONLY" },
          );
        }
      }

      const status = data["status"];
      if (status !== undefined && status !== null && !isCampaignStatus(status)) {
        throw new ValidationError(`"${String(status)}" is not a campaign status.`, { entity: CAMPAIGN_ENTITY });
      }
    }

    const code = readCode(data["code"]);
    if (code !== undefined) {
      if (code.length > CAMPAIGN_CODE_MAX_LENGTH) {
        throw new ValidationError(
          `A campaign code is at most ${String(CAMPAIGN_CODE_MAX_LENGTH)} characters.`,
          { entity: CAMPAIGN_ENTITY, field: "code" },
        );
      }
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(code)) {
        throw new ValidationError(
          "A campaign code starts with a letter or digit and contains only letters, digits, dot, dash or underscore.",
          { entity: CAMPAIGN_ENTITY, field: "code" },
        );
      }
      const ownId = context.record?.id;
      if (await this.records.campaignCodeTaken(code, context.operation === "update" ? ownId : undefined)) {
        throw new ValidationError(`Campaign code "${code}" is already used by another campaign.`, {
          entity: CAMPAIGN_ENTITY,
          field: "code",
          code: "CAMPAIGN_CODE_TAKEN",
        });
      }
    }

    const timezone = data["timezone"];
    if (typeof timezone === "string" && timezone.trim() !== "" && !isSupportedTimeZone(timezone.trim())) {
      throw new ValidationError(`"${timezone}" is not a time zone this runtime understands.`, {
        entity: CAMPAIGN_ENTITY,
        field: "timezone",
      });
    }
  }

  private async handleTargetList(context: HookContext): Promise<void> {
    const data = context.data;
    if (data === undefined) return;
    this.assertNotPortal(TARGET_LIST_ENTITY);
    if (isMarketingInternalWrite()) return;

    const settings = await this.settings.settings();
    if (!settings.features.audience) throw new FeatureDisabledError("audience");
    const changed =
      context.operation === "create" ? Object.keys(data) : changedKeys(data, context.previous ?? {});
    const offending = changed.filter((key) => SERVER_OWNED_TARGET_LIST_FIELDS.includes(key));
    if (offending.length > 0) {
      throw new ValidationError(
        `These fields on ${TARGET_LIST_ENTITY} are produced by audience resolution (phase 19-MA.4) and cannot be written through the record API: ${offending.join(", ")}.`,
        { entity: TARGET_LIST_ENTITY, fields: offending },
      );
    }
  }

  /**
   * Membership and history rows exist only because the module wrote them: a `CampaignTransition` is the
   * record of a command that ran, and a `TargetListEntry` is evidence of who added a record to an audience.
   * Neither is writable by a caller in any delivered phase — MA.4 exposes audience membership as a command
   * that writes them internally, exactly as the lifecycle commands write history here.
   */
  private handleInternalOnly(
    entity: typeof TARGET_LIST_ENTRY_ENTITY | typeof CAMPAIGN_TRANSITION_ENTITY,
    fields: readonly string[],
    context: HookContext,
  ): void {
    this.assertNotPortal(entity);
    if (isMarketingInternalWrite()) return;
    const data = context.data ?? {};
    const changed =
      context.operation === "create" ? Object.keys(data) : changedKeys(data, context.previous ?? {});
    const offending = changed.filter((key) => fields.includes(key));
    if (offending.length > 0 || context.operation === "create") {
      throw new ValidationError(
        `${entity} rows are written by Marketing Automation commands, never through the record API.`,
        { entity, fields: offending, code: "MARKETING_INTERNAL_WRITE_ONLY" },
      );
    }
  }

  private assertNotPortal(entity: string): void {
    if (this.scope.userType === "portal") {
      throw new ValidationError(`Portal users may not write ${entity} records.`, {
        entity,
        code: "PORTAL_WRITE_NOT_SUPPORTED",
      });
    }
  }
}

function readCode(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed.slice(0, CAMPAIGN_CODE_MAX_LENGTH + 1);
}
