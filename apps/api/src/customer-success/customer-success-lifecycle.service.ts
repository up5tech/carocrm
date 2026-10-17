import { NotFoundError, ValidationError } from "@carocrm/core/errors/index.js";
import { Inject, Injectable } from "@nestjs/common";

import { DatabaseService } from "../database/database.service.js";
import { EntityCrudService } from "../entity/entity.service.js";
import { runInTransaction } from "../entity/tx-context.js";
import { EventBus } from "../events/event-bus.js";
import { checkLifecycleTransition, text } from "./customer-success-domain.js";
import { runAsCustomerSuccessInternal } from "./customer-success-internal.js";
import { CustomerSuccessRecords } from "./customer-success-records.js";
import { CustomerSuccessSettingsService } from "./customer-success-settings.service.js";

/**
 * Phase 19-CS.3 — lifecycle management (PLAN_Phase_19_Customer_Success.md §5.3).
 *
 * Transitions are validated server-side against the configured edge set, and a move to an important
 * stage (`churned`, `atRisk`) requires a reason. A client-side dropdown is not access control, so the
 * same rules apply to the domain command, the bulk command and any automation.
 */

export interface TransitionInput {
  readonly to: string;
  readonly reason?: string | undefined;
  readonly version?: number | undefined;
}

export interface BulkTransitionResult {
  readonly id: string;
  readonly ok: boolean;
  readonly from?: string;
  readonly to?: string;
  readonly error?: string;
}

@Injectable()
export class CustomerSuccessLifecycleService {
  constructor(
    @Inject(CustomerSuccessRecords) private readonly records: CustomerSuccessRecords,
    @Inject(EntityCrudService) private readonly entities: EntityCrudService,
    @Inject(CustomerSuccessSettingsService) private readonly settings: CustomerSuccessSettingsService,
    @Inject(EventBus) private readonly events: EventBus,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  /** Move one profile to a new lifecycle stage (§8.2 `transitionLifecycle`). */
  async transition(profileId: string, input: TransitionInput): Promise<Record<string, unknown>> {
    const profile = await this.records.byId("CustomerSuccessProfile", profileId);
    if (profile === undefined) throw new NotFoundError(`CustomerSuccessProfile "${profileId}" does not exist.`);
    const settings = await this.settings.settings();
    const from = text(profile.data["lifecycleStage"]) ?? "onboarding";
    const check = checkLifecycleTransition({
      from,
      to: input.to,
      reason: input.reason,
      transitions: settings.lifecycle.transitions,
      reasonRequired: settings.lifecycle.reasonRequired,
    });
    if (!check.allowed) {
      throw new ValidationError(check.message ?? "Invalid lifecycle transition.", {
        profileId,
        from,
        to: input.to,
        code: check.code ?? "invalidTransition",
      });
    }
    if (from === input.to) return { profileId, from, to: input.to, changed: false };

    const now = new Date();
    await runInTransaction(this.database.db, async () => {
      await runAsCustomerSuccessInternal(() =>
        this.entities.update(
          "CustomerSuccessProfile",
          profileId,
          {
            lifecycleStage: input.to,
            lifecycleStageReason: input.reason ?? null,
            lifecycleStageChangedAt: now.toISOString(),
            ...(input.version !== undefined ? { version: input.version } : {}),
          },
        ),
      );
      await this.events.dispatch(this.database.db, {
        type: "customerSuccess.lifecycle.changed",
        payload: { profileId, from, to: input.to, reason: input.reason ?? null },
      });
    });
    return { profileId, from, to: input.to, changed: true };
  }

  /**
   * Bulk transition with per-record results (§5.2). One invalid record does not fail the rest, and
   * every result is reported rather than swallowed.
   */
  async transitionBulk(ids: readonly string[], input: TransitionInput): Promise<{ results: BulkTransitionResult[] }> {
    const results: BulkTransitionResult[] = [];
    for (const id of ids) {
      try {
        const outcome = await this.transition(id, input);
        results.push({
          id,
          ok: true,
          from: text(outcome["from"]) ?? "",
          to: text(outcome["to"]) ?? input.to,
        });
      } catch (error: unknown) {
        results.push({ id, ok: false, error: error instanceof Error ? error.message : "Transition failed." });
      }
    }
    return { results };
  }

  /** A preview of a bulk transition: which records would move and which would be refused (§5.3). */
  async transitionPreview(ids: readonly string[], to: string): Promise<{
    readonly movable: readonly string[];
    readonly blocked: readonly { readonly id: string; readonly reason: string }[];
  }> {
    const settings = await this.settings.settings();
    const movable: string[] = [];
    const blocked: { id: string; reason: string }[] = [];
    for (const id of ids) {
      const profile = await this.records.byId("CustomerSuccessProfile", id);
      if (profile === undefined) {
        blocked.push({ id, reason: "Profile not found." });
        continue;
      }
      const from = text(profile.data["lifecycleStage"]) ?? "onboarding";
      const check = checkLifecycleTransition({
        from,
        to,
        transitions: settings.lifecycle.transitions,
        reasonRequired: [],
      });
      if (check.allowed) movable.push(id);
      else blocked.push({ id, reason: check.message ?? "Transition not allowed." });
    }
    return { movable, blocked };
  }
}
