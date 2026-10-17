import { Inject, Injectable } from "@nestjs/common";

import type { RequestScope } from "../common/request-scope.js";
import { REQUEST_SCOPE_TOKEN } from "../common/request-scope.js";
import { EntityCrudService } from "../entity/entity.service.js";
import {
  dayValue,
  type PortfolioQueue,
  renewalWindow,
  text,
} from "./customer-success-domain.js";
import { CustomerSuccessSettingsService } from "./customer-success-settings.service.js";

/**
 * Phase 19-CS.3 — the portfolio and its queues (PLAN_Phase_19_Customer_Success.md §5.2).
 *
 * Every read goes through `EntityCrudService`, which applies the global record scope and the
 * record-level ACL predicate **before** any row is returned, so an aggregate can never leak a count
 * or a name of an Account the reader may not open (§9.2). Complex predicates (dates, null checks)
 * narrow an already-authorised, bounded page in memory — never the other way round.
 */

const SCAN_LIMIT = 500;

export interface PortfolioRow {
  readonly id: string;
  readonly accountId: string | null;
  readonly name: string | null;
  readonly csmUserId: string | null;
  readonly csmTeamId: string | null;
  readonly lifecycleStage: string | null;
  readonly segment: string | null;
  readonly healthStatus: string | null;
  readonly effectiveHealthStatus: string | null;
  readonly healthScore: number | null;
  readonly scoreTrend: string | null;
  readonly onboardingStatus: string | null;
  readonly renewalDate: string | null;
  readonly daysToRenewal: number | null;
  readonly renewalWindowDays: number | null;
  readonly openRiskCount: number | null;
  readonly nextSuccessReviewAt: string | null;
  readonly lastMeaningfulTouchAt: string | null;
}

export interface QueueResult {
  readonly queue: PortfolioQueue;
  readonly list: readonly PortfolioRow[];
  readonly count: number;
  readonly truncated: boolean;
}

@Injectable()
export class CustomerSuccessPortfolioService {
  constructor(
    @Inject(EntityCrudService) private readonly entities: EntityCrudService,
    @Inject(CustomerSuccessSettingsService) private readonly settings: CustomerSuccessSettingsService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  /** One configured portfolio queue, ACL-scoped and bounded (§5.2). */
  async queue(queue: PortfolioQueue, options: { readonly limit: number; readonly offset: number }): Promise<QueueResult> {
    const limit = Math.max(1, Math.min(200, options.limit));
    const settings = await this.settings.settings();
    const today = new Date().toISOString().slice(0, 10);
    const maxWindow = Math.max(...settings.renewal.windows, 90);

    const where = this.queueWhere(queue, today, maxWindow);
    const result = await this.entities.list("CustomerSuccessProfile", {
      ...(where.length > 0 ? { where } : {}),
      orderBy: "healthScore",
      order: "asc",
      maxSize: SCAN_LIMIT,
      total: true,
    });
    const narrowed = result.list.filter((row) => this.matchesQueue(row, queue, today));
    const list = narrowed.slice(options.offset, options.offset + limit).map((row) => this.toRow(row, today, settings.renewal.windows));
    return {
      queue,
      list,
      count: narrowed.length,
      truncated: (result.total ?? narrowed.length) > narrowed.length,
    };
  }

  /** ACL-filtered portfolio aggregate for the portfolio overview (§5.12, §8.2). */
  async summary(): Promise<Record<string, unknown>> {
    const settings = await this.settings.settings();
    const today = new Date().toISOString().slice(0, 10);
    const result = await this.entities.list("CustomerSuccessProfile", {
      maxSize: SCAN_LIMIT,
      total: true,
    });
    const byHealth: Record<string, number> = { healthy: 0, monitor: 0, atRisk: 0, critical: 0, unknown: 0 };
    const byLifecycle: Record<string, number> = {};
    const bySegment: Record<string, number> = {};
    let unassigned = 0;
    let onboardingInProgress = 0;
    let onboardingOverdue = 0;
    let openRiskTotal = 0;
    const renewalsByWindow: Record<string, number> = {};
    for (const window of settings.renewal.windows) renewalsByWindow[String(window)] = 0;

    for (const row of result.list) {
      const health = text(row["healthStatus"]) ?? "unknown";
      byHealth[health] = (byHealth[health] ?? 0) + 1;
      const lifecycle = text(row["lifecycleStage"]) ?? "onboarding";
      byLifecycle[lifecycle] = (byLifecycle[lifecycle] ?? 0) + 1;
      const segment = text(row["segment"]) ?? "(none)";
      bySegment[segment] = (bySegment[segment] ?? 0) + 1;
      if (text(row["csmUserId"]) === undefined) unassigned += 1;
      const onboarding = text(row["onboardingStatus"]) ?? "notStarted";
      if (onboarding === "inProgress" || onboarding === "blocked") {
        onboardingInProgress += 1;
        const target = dayValue(row["onboardingTargetDate"]);
        if (target !== undefined && target < today) onboardingOverdue += 1;
      }
      const risks = row["openRiskCount"];
      if (typeof risks === "number") openRiskTotal += risks;
      const renewalDate = dayValue(row["renewalDate"]);
      if (renewalDate !== undefined) {
        const window = renewalWindow(renewalDate, today, settings.renewal.windows);
        if (window?.windowDays !== null && window?.windowDays !== undefined) {
          const key = String(window.windowDays);
          renewalsByWindow[key] = (renewalsByWindow[key] ?? 0) + 1;
        }
      }
    }

    return {
      total: result.total ?? result.count,
      scanned: result.count,
      truncated: (result.total ?? result.count) > result.count,
      byHealth,
      byLifecycle,
      bySegment,
      unassigned,
      onboarding: { inProgress: onboardingInProgress, overdue: onboardingOverdue },
      openRiskTotal,
      renewalsByWindow,
      generatedAt: new Date().toISOString(),
    };
  }

  // -------------------------------------------------------------------------

  private queueWhere(queue: PortfolioQueue, today: string, maxWindow: number): Record<string, unknown>[] {
    switch (queue) {
      case "myPortfolio":
        return this.scope.userId !== undefined
          ? [{ field: "csmUserId", operator: "equals", value: this.scope.userId }]
          : [{ field: "id", operator: "in", value: ["__none__"] }];
      case "teamPortfolio": {
        const teams = this.scope.teamIds();
        return teams.length > 0 ? [{ field: "csmTeamId", operator: "in", value: teams }] : [{ field: "id", operator: "in", value: ["__none__"] }];
      }
      case "unknownHealth":
        return [{ field: "healthStatus", operator: "equals", value: "unknown" }];
      case "monitorHealth":
        return [{ field: "healthStatus", operator: "equals", value: "monitor" }];
      case "atRiskHealth":
        return [{ field: "healthStatus", operator: "equals", value: "atRisk" }];
      case "criticalHealth":
        return [{ field: "healthStatus", operator: "equals", value: "critical" }];
      case "onboardingNow":
        return [{ field: "onboardingStatus", operator: "in", value: ["inProgress", "blocked"] }];
      case "onboardingOverdue":
        return [
          { field: "onboardingStatus", operator: "in", value: ["inProgress", "blocked"] },
          { field: "onboardingTargetDate", operator: "lessThan", value: `${today}T23:59:59.999Z` },
        ];
      case "upcomingRenewals":
        return [
          { field: "renewalDate", operator: "greaterThanOrEqual", value: today },
          { field: "renewalDate", operator: "lessThan", value: `${addDays(today, maxWindow)}T23:59:59.999Z` },
        ];
      case "unassigned":
      case "missingPlan":
      case "missingNextReview":
        return [];
      default:
        return [];
    }
  }

  private matchesQueue(row: Record<string, unknown>, queue: PortfolioQueue, today: string): boolean {
    switch (queue) {
      case "unassigned":
        return text(row["csmUserId"]) === undefined;
      case "missingPlan":
        return text(row["primaryPlanId"]) === undefined;
      case "missingNextReview":
        return text(row["nextSuccessReviewAt"]) === undefined;
      case "onboardingOverdue": {
        const target = dayValue(row["onboardingTargetDate"]);
        const status = text(row["onboardingStatus"]) ?? "";
        return target !== undefined && target < today && (status === "inProgress" || status === "blocked");
      }
      default:
        return true;
    }
  }

  private toRow(row: Record<string, unknown>, today: string, windows: readonly number[]): PortfolioRow {
    const renewalDate = dayValue(row["renewalDate"]) ?? null;
    const window = renewalDate === null ? null : renewalWindow(renewalDate, today, windows);
    return {
      id: String(row["id"] ?? ""),
      accountId: text(row["accountId"]) ?? null,
      name: text(row["name"]) ?? null,
      csmUserId: text(row["csmUserId"]) ?? null,
      csmTeamId: text(row["csmTeamId"]) ?? null,
      lifecycleStage: text(row["lifecycleStage"]) ?? null,
      segment: text(row["segment"]) ?? null,
      healthStatus: text(row["calculatedHealthStatus"]) ?? null,
      effectiveHealthStatus: text(row["healthStatus"]) ?? null,
      healthScore: numberOrNull(row["healthScore"]),
      scoreTrend: text(row["scoreTrend"]) ?? null,
      onboardingStatus: text(row["onboardingStatus"]) ?? null,
      renewalDate,
      daysToRenewal: window?.daysToRenewal ?? null,
      renewalWindowDays: window?.windowDays ?? null,
      openRiskCount: numberOrNull(row["openRiskCount"]),
      nextSuccessReviewAt: text(row["nextSuccessReviewAt"]) ?? null,
      lastMeaningfulTouchAt: text(row["lastMeaningfulTouchAt"]) ?? null,
    };
  }
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function addDays(day: string, days: number): string {
  const parsed = Date.parse(`${day}T00:00:00.000Z`);
  if (Number.isNaN(parsed)) return day;
  return new Date(parsed + days * 86_400_000).toISOString().slice(0, 10);
}
