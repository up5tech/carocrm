import { NotFoundError, ValidationError } from "@carocrm/core/errors/index.js";
import { Inject, Injectable } from "@nestjs/common";

import { DatabaseService } from "../database/database.service.js";
import { EntityCrudService } from "../entity/entity.service.js";
import { runInTransaction } from "../entity/tx-context.js";
import { EventBus } from "../events/event-bus.js";
import {
  checkRiskTransition,
  RISK_SEVERITIES,
  RISK_TYPES,
  riskRequiresMitigation,
  text,
} from "./customer-success-domain.js";
import { runAsCustomerSuccessInternal } from "./customer-success-internal.js";
import { CustomerSuccessNotificationService } from "./customer-success-notification.service.js";
import { CustomerSuccessRecords, type CustomerSuccessRow } from "./customer-success-records.js";

/**
 * Phase 19-CS.7 — risks and churn prevention (PLAN_Phase_19_Customer_Success.md §5.8).
 *
 * A risk is *not* a health status: a customer may carry several risks that together contribute to
 * health, and a Critical risk never sets the lifecycle to `churned` on its own (§5.8, §13.7).
 * Transitions are validated, High/Critical risks need a mitigation or a documented reason, and
 * escalation is idempotent.
 */

export interface CreateRiskInput {
  readonly profileId?: string | undefined;
  readonly accountId?: string | undefined;
  readonly planId?: string | undefined;
  readonly title: string;
  readonly description?: string | undefined;
  readonly riskType?: string | undefined;
  readonly severity: string;
  readonly ownerUserId?: string | undefined;
  readonly escalationTeamId?: string | undefined;
  readonly detectedDate?: string | undefined;
  readonly nextReviewDate?: string | undefined;
  readonly targetResolutionDate?: string | undefined;
  readonly evidenceSummary?: string | undefined;
  readonly mitigationPlan?: string | undefined;
  readonly nextAction?: string | undefined;
  readonly contributesToHealth?: boolean | undefined;
  readonly contactId?: string | undefined;
  readonly opportunityId?: string | undefined;
  readonly subscriptionId?: string | undefined;
  readonly probability?: number | undefined;
  readonly impact?: number | undefined;
}

export interface EscalateRiskInput {
  readonly escalationTeamId?: string | undefined;
  readonly reason?: string | undefined;
}

/** Outcome of one bounded escalation scan (§11.1 — the counts a job run reports). */
export interface RiskEscalationScan {
  readonly processed: number;
  readonly candidates: number;
  readonly notified: number;
  readonly skipped: number;
  readonly errors: number;
  readonly durationMs: number;
}

@Injectable()
export class CustomerSuccessRiskService {
  constructor(
    @Inject(CustomerSuccessRecords) private readonly records: CustomerSuccessRecords,
    @Inject(EntityCrudService) private readonly entities: EntityCrudService,
    @Inject(CustomerSuccessNotificationService) private readonly notifications: CustomerSuccessNotificationService,
    @Inject(EventBus) private readonly events: EventBus,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  async create(input: CreateRiskInput): Promise<Record<string, unknown>> {
    if (!(RISK_SEVERITIES as readonly string[]).includes(input.severity)) {
      throw new ValidationError(`"${input.severity}" is not a valid risk severity.`, { severity: input.severity });
    }
    if (input.riskType !== undefined && !(RISK_TYPES as readonly string[]).includes(input.riskType)) {
      throw new ValidationError(`"${input.riskType}" is not a known risk type.`, { riskType: input.riskType });
    }
    const profile = await this.resolveProfile(input.profileId, input.accountId);
    if (
      riskRequiresMitigation(input.severity, {
        mitigationPlan: input.mitigationPlan ?? null,
        nextAction: input.nextAction ?? null,
      })
    ) {
      throw new ValidationError(
        "A High or Critical risk needs a mitigation plan or a documented next action.",
        { severity: input.severity },
      );
    }
    const now = new Date().toISOString().slice(0, 10);
    const created = await runInTransaction(this.database.db, async () => {
      const record = await runAsCustomerSuccessInternal(() =>
        this.entities.create("CustomerSuccessRisk", {
          name: input.title,
          profileId: profile.id,
          accountId: text(profile.data["accountId"]) ?? null,
          status: "open",
          severity: input.severity,
          riskType: input.riskType ?? "unknown",
          detectedDate: input.detectedDate ?? now,
          contributesToHealth: input.contributesToHealth ?? true,
          ...(input.planId !== undefined ? { planId: input.planId } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.ownerUserId !== undefined ? { ownerUserId: input.ownerUserId } : {}),
          ...(input.escalationTeamId !== undefined ? { escalationTeamId: input.escalationTeamId } : {}),
          ...(input.nextReviewDate !== undefined ? { nextReviewDate: input.nextReviewDate } : {}),
          ...(input.targetResolutionDate !== undefined
            ? { targetResolutionDate: input.targetResolutionDate }
            : {}),
          ...(input.evidenceSummary !== undefined ? { evidenceSummary: input.evidenceSummary } : {}),
          ...(input.mitigationPlan !== undefined ? { mitigationPlan: input.mitigationPlan } : {}),
          ...(input.nextAction !== undefined ? { nextAction: input.nextAction } : {}),
          ...(input.contactId !== undefined ? { contactId: input.contactId } : {}),
          ...(input.opportunityId !== undefined ? { opportunityId: input.opportunityId } : {}),
          ...(input.subscriptionId !== undefined ? { subscriptionId: input.subscriptionId } : {}),
          ...(input.probability !== undefined ? { probability: input.probability } : {}),
          ...(input.impact !== undefined ? { impact: input.impact } : {}),
        }),
      );
      const id = String(record["id"]);
      await this.events.dispatch(this.database.db, {
        type: "customerSuccess.risk.created",
        payload: { riskId: id, profileId: profile.id, severity: input.severity, riskType: input.riskType ?? "unknown" },
      });
      return { id, record };
    });
    // §11.2: a Critical risk is the signal that matters most to the owner — tell them once.
    if (input.severity === "critical") {
      const riskRow = await this.records.byId("CustomerSuccessRisk", String(created.id));
      if (riskRow !== undefined) {
        await this.notifyRisk(riskRow, profile, {
          type: "CustomerSuccessRisk",
          dedupKey: `riskCritical:${riskRow.id}`,
          title: "Critical risk opened",
          body: `${riskRow.name ?? "A risk"} was opened as Critical severity.`,
          severity: "critical",
        });
      }
    }
    return created.record;
  }

  /** Move a risk through its lifecycle (§5.8). */
  async transition(riskId: string, to: string): Promise<Record<string, unknown>> {
    const risk = await this.mustLoad(riskId);
    const from = text(risk.data["status"]) ?? "open";
    const check = checkRiskTransition(from, to);
    if (!check.allowed) throw new ValidationError(check.message ?? "Invalid risk transition.", { riskId, from, to });
    if (from === to) return { riskId, status: to, changed: false };
    await runAsCustomerSuccessInternal(() =>
      this.entities.update("CustomerSuccessRisk", riskId, {
        status: to,
        ...(to === "resolved" ? { resolvedDate: new Date().toISOString().slice(0, 10) } : {}),
      }),
    );
    return { riskId, from, to, changed: true };
  }

  /** Escalate a risk. Idempotent: escalating an escalated risk changes only the team/reason (§5.8). */
  async escalate(riskId: string, input: EscalateRiskInput): Promise<Record<string, unknown>> {
    const risk = await this.mustLoad(riskId);
    const from = text(risk.data["status"]) ?? "open";
    if (from === "resolved" || from === "closed") {
      throw new ValidationError(`A ${from} risk cannot be escalated; reopen it first.`, { riskId, status: from });
    }
    const patch: Record<string, unknown> = { status: "escalated" };
    if (input.escalationTeamId !== undefined) patch["escalationTeamId"] = input.escalationTeamId;
    await runInTransaction(this.database.db, async () => {
      await runAsCustomerSuccessInternal(() => this.entities.update("CustomerSuccessRisk", riskId, patch));
      await this.events.dispatch(this.database.db, {
        type: "customerSuccess.risk.escalated",
        payload: { riskId, profileId: text(risk.data["profileId"]) ?? null, from, reason: input.reason ?? null },
      });
    });
    // Escalation is an action someone must react to; the dedup key keeps a repeated escalation quiet.
    await this.notifyRisk(risk, null, {
      type: "CustomerSuccessRisk",
      dedupKey: `riskEscalated:${risk.id}`,
      title: "Risk escalated",
      body: `${risk.name ?? "A risk"} has been escalated and needs a response.`,
      severity: "warning",
    });
    return { riskId, status: "escalated" };
  }

  /** Resolve a risk with an outcome reason; reopening preserves the earlier resolution (§5.8). */
  async resolve(riskId: string, outcome: string): Promise<Record<string, unknown>> {
    if (outcome.trim() === "") {
      throw new ValidationError("Resolving a risk requires an outcome reason.", { riskId });
    }
    const risk = await this.mustLoad(riskId);
    const from = text(risk.data["status"]) ?? "open";
    const check = checkRiskTransition(from, "resolved");
    if (!check.allowed) throw new ValidationError(check.message ?? "Invalid risk transition.", { riskId, from });
    await runInTransaction(this.database.db, async () => {
      await runAsCustomerSuccessInternal(() =>
        this.entities.update("CustomerSuccessRisk", riskId, {
          status: "resolved",
          resolutionReason: outcome,
          resolvedDate: new Date().toISOString().slice(0, 10),
        }),
      );
      await this.events.dispatch(this.database.db, {
        type: "customerSuccess.risk.resolved",
        payload: { riskId, profileId: text(risk.data["profileId"]) ?? null, outcome },
      });
    });
    return { riskId, status: "resolved" };
  }

  /** Reopen a resolved/closed risk, preserving the previous resolution in a history note. */
  async reopen(riskId: string, reason: string): Promise<Record<string, unknown>> {
    const risk = await this.mustLoad(riskId);
    const from = text(risk.data["status"]) ?? "open";
    const check = checkRiskTransition(from, "open");
    if (!check.allowed) throw new ValidationError(check.message ?? "This risk cannot be reopened.", { riskId, from });
    const history = text(risk.data["resolutionHistory"]);
    const line = `[${new Date().toISOString()}] reopened (${from}): ${reason.trim() === "" ? "no reason given" : reason.trim()}`;
    await runAsCustomerSuccessInternal(() =>
      this.entities.update("CustomerSuccessRisk", riskId, {
        status: "open",
        resolvedDate: null,
        resolutionHistory: history === undefined ? line : `${history}\n${line}`,
      }),
    );
    return { riskId, status: "open" };
  }

  /** Ids of overdue or High/Critical risks needing review (§11.1 `evaluateRiskEscalations`). */
  async risksNeedingReview(today: string, limit: number): Promise<{ riskId: string; profileId: string | null; reason: string }[]> {
    const rows = await this.records.find("CustomerSuccessRisk", {}, { limit: 5_000 });
    const out: { riskId: string; profileId: string | null; reason: string }[] = [];
    for (const row of rows) {
      const status = text(row.data["status"]) ?? "open";
      if (status === "resolved" || status === "closed" || status === "accepted") continue;
      const due = text(row.data["targetResolutionDate"]);
      const severity = text(row.data["severity"]) ?? "medium";
      const overdue = due !== undefined && due < today;
      if (overdue || severity === "critical") {
        out.push({
          riskId: row.id,
          profileId: text(row.data["profileId"]) ?? null,
          reason: overdue ? "overdue" : "criticalSeverity",
        });
      }
      if (out.length >= limit) break;
    }
    return out;
  }

  /**
   * One bounded scan for §11.1 `evaluateRiskEscalations`.
   *
   * It *detects and notifies*, it does not move a risk to `escalated` by itself: escalation is a
   * human decision (§5.8) and a scheduled job silently changing a risk's status would destroy the
   * audit trail of who escalated it. The counts it returns are what the job row records (§11.1).
   */
  async evaluateEscalations(today: string, limit: number): Promise<RiskEscalationScan> {
    const started = Date.now();
    const candidates = await this.risksNeedingReview(today, limit);
    const result = { processed: 0, candidates: candidates.length, notified: 0, skipped: 0, errors: 0 };
    const profileCache = new Map<string, CustomerSuccessRow | null>();
    for (const candidate of candidates) {
      result.processed += 1;
      try {
        const risk = await this.records.byId("CustomerSuccessRisk", candidate.riskId);
        if (risk === undefined) {
          result.skipped += 1;
          continue;
        }
        const profile = await this.cachedProfile(candidate.profileId, profileCache);
        const title = candidate.reason === "overdue" ? "Risk is past its target date" : "Critical risk needs review";
        const created = await this.notifyRisk(risk, profile, {
          type: "CustomerSuccessRisk",
          dedupKey: `riskReview:${risk.id}:${candidate.reason}`,
          title,
          body: `${risk.name ?? "A risk"} needs review: ${candidate.reason === "overdue" ? "its target resolution date has passed" : "it is Critical severity"}.`,
          severity: candidate.reason === "overdue" ? "warning" : "critical",
        });
        if (created) result.notified += 1;
        else result.skipped += 1;
      } catch {
        // One unreadable risk must not abort the scan; count it and continue (§11.1).
        result.errors += 1;
      }
    }
    return { ...result, durationMs: Date.now() - started };
  }

  /** Notify the risk's owner, or the profile's CSM when the risk has no owner of its own. */
  private async notifyRisk(
    risk: CustomerSuccessRow,
    profile: CustomerSuccessRow | null,
    input: {
      readonly type: string;
      readonly dedupKey: string;
      readonly title: string;
      readonly body: string;
      readonly severity: "info" | "warning" | "critical";
    },
  ): Promise<boolean> {
    const profileId = text(risk.data["profileId"]) ?? null;
    let recipient = text(risk.data["ownerUserId"]);
    if (recipient === undefined) {
      const row = profile ?? (profileId === null ? undefined : await this.records.byId("CustomerSuccessProfile", profileId));
      recipient = row === undefined ? undefined : text(row.data["csmUserId"]);
    }
    if (recipient === undefined) return false;
    const notified = await this.notifications.notify({
      userId: recipient,
      type: input.type,
      title: input.title,
      body: input.body,
      dedupKey: input.dedupKey,
      link: profileId === null ? null : `/CustomerSuccessProfile/view/${profileId}`,
      severity: input.severity,
    });
    return notified.created;
  }

  private async cachedProfile(
    profileId: string | null,
    cache: Map<string, CustomerSuccessRow | null>,
  ): Promise<CustomerSuccessRow | null> {
    if (profileId === null) return null;
    const cached = cache.get(profileId);
    if (cached !== undefined) return cached;
    const row = await this.records.byId("CustomerSuccessProfile", profileId) ?? null;
    cache.set(profileId, row);
    return row;
  }

  private async mustLoad(riskId: string) {
    const risk = await this.records.byId("CustomerSuccessRisk", riskId);
    if (risk === undefined) throw new NotFoundError(`CustomerSuccessRisk "${riskId}" does not exist.`);
    return risk;
  }

  private async resolveProfile(profileId: string | undefined, accountId: string | undefined) {
    if (profileId !== undefined) {
      const profile = await this.records.byId("CustomerSuccessProfile", profileId);
      if (profile === undefined) throw new NotFoundError(`CustomerSuccessProfile "${profileId}" does not exist.`);
      return profile;
    }
    if (accountId === undefined) {
      throw new ValidationError("A risk needs a profile or an account.", {});
    }
    const ids = await this.records.idsMatching("CustomerSuccessProfile", "accountId", accountId);
    const id = ids[0];
    if (id === undefined) {
      throw new ValidationError(`Account "${accountId}" has no Customer Success profile yet.`, { accountId });
    }
    const profile = await this.records.byId("CustomerSuccessProfile", id);
    if (profile === undefined) throw new NotFoundError(`CustomerSuccessProfile "${id}" does not exist.`);
    return profile;
  }
}
