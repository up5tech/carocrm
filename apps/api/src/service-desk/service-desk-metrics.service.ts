import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";

import { AclApiService } from "../acl/acl-api.service.js";
import { DatabaseService } from "../database/database.service.js";
import { EntityCrudService } from "../entity/entity.service.js";
import { CASE_ENTITY, CASE_STATUSES } from "./service-desk-domain.js";
import { ServiceDeskSettingsService } from "./service-desk-settings.service.js";

/**
 * Phase 19-SD.15 — Service Desk metrics (PLAN_Phase_19_ServiceDesk.md §13).
 *
 * Every Case aggregate goes through `EntityCrudService.aggregate`, the same validated Query Engine
 * and record ACL predicate as the list API, so a count can never include a case the caller cannot
 * read. CSAT is returned only to a caller with read-all scope; otherwise it is marked restricted,
 * because survey rows are deliberately not exposed as an entity (PLAN §13 "reports cannot leak
 * counts from inaccessible records").
 */

export interface MetricBucket {
  readonly key: string;
  readonly count: number;
}

export interface ServiceDeskMetrics {
  readonly range: { readonly from: string; readonly to: string };
  readonly total: number;
  readonly active: number;
  readonly unassigned: number;
  readonly escalated: number;
  readonly breached: number;
  readonly resolved: number;
  readonly reopened: number;
  readonly reopenRate: number | null;
  readonly byStatus: readonly MetricBucket[];
  readonly byPriority: readonly MetricBucket[];
  readonly bySource: readonly MetricBucket[];
  readonly csat:
    | { readonly restricted: true }
    | {
        readonly restricted: false;
        readonly count: number;
        readonly average: number | null;
        readonly responseRate: number | null;
      };
  readonly definitions: Readonly<Record<string, string>>;
}

const TERMINAL = new Set(["Resolved", "Closed", "Cancelled"]);
const ACTIVE_STATUSES = CASE_STATUSES.filter((status) => !TERMINAL.has(status));

@Injectable()
export class ServiceDeskMetricsService {
  constructor(
    @Inject(EntityCrudService) private readonly entities: EntityCrudService,
    @Inject(AclApiService) private readonly acl: AclApiService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ServiceDeskSettingsService) private readonly settings: ServiceDeskSettingsService,
  ) {}

  async metrics(range: { from?: string | undefined; to?: string | undefined } = {}): Promise<ServiceDeskMetrics> {
    await this.acl.assertAccess(CASE_ENTITY, "read");
    const to = range.to !== undefined ? new Date(range.to) : new Date();
    const from =
      range.from !== undefined
        ? new Date(range.from)
        : new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
    const where = [
      { field: "createdAt", operator: "greaterThanOrEqual", value: from.toISOString() },
      { field: "createdAt", operator: "lessThanOrEqual", value: to.toISOString() },
    ];

    const [statusResult, priorityResult, sourceResult] = await Promise.all([
      this.entities.aggregate(CASE_ENTITY, {
        where,
        dimensions: [{ field: "status", fieldType: "enum" }],
        metrics: [],
        maxGroups: 50,
      }),
      this.entities.aggregate(CASE_ENTITY, {
        where,
        dimensions: [{ field: "priority", fieldType: "enum" }],
        metrics: [],
        maxGroups: 50,
      }),
      this.entities.aggregate(CASE_ENTITY, {
        where,
        dimensions: [{ field: "source", fieldType: "enum" }],
        metrics: [],
        maxGroups: 50,
      }),
    ]);

    const byStatus: MetricBucket[] = statusResult.groups.map((group) => ({
      key: group.keys[0] ?? "(empty)",
      count: group.count,
    }));
    const statusCount = (statuses: readonly string[]): number =>
      byStatus.filter((bucket) => statuses.includes(bucket.key)).reduce((sum, bucket) => sum + bucket.count, 0);
    const active = byStatus.filter((bucket) => !TERMINAL.has(bucket.key)).reduce((sum, bucket) => sum + bucket.count, 0);
    const resolved = statusCount(["Resolved", "Closed"]);

    const [unassigned, escalated, breached, reopened, reopenedResolved] = await Promise.all([
      this.count([
        ...where,
        { field: "status", operator: "in", value: [...ACTIVE_STATUSES] },
        { field: "assignedUserId", operator: "isNull", value: null },
      ]),
      this.count([
        ...where,
        { field: "status", operator: "in", value: [...ACTIVE_STATUSES] },
        { field: "isEscalated", operator: "equals", value: true },
      ]),
      this.count([
        ...where,
        { field: "status", operator: "in", value: [...ACTIVE_STATUSES] },
        { field: "slaState", operator: "equals", value: "Breached" },
      ]),
      this.count([...where, { field: "reopenedAt", operator: "isNotNull", value: null }]),
      this.count([...where, { field: "resolvedAt", operator: "isNotNull", value: null }]),
    ]);

    const settings = await this.settings.settings();
    const csat = settings.features.csat
      ? await this.csatMetrics(from, to, resolved)
      : { restricted: false as const, count: 0, average: null, responseRate: null };

    return {
      range: { from: from.toISOString(), to: to.toISOString() },
      total: statusResult.total,
      active,
      unassigned,
      escalated,
      breached,
      resolved,
      reopened,
      reopenRate: reopenedResolved > 0 ? Number((reopened / reopenedResolved).toFixed(4)) : null,
      byStatus,
      byPriority: priorityResult.groups.map((group) => ({ key: group.keys[0] ?? "(empty)", count: group.count })),
      bySource: sourceResult.groups.map((group) => ({ key: group.keys[0] ?? "(empty)", count: group.count })),
      csat,
      definitions: {
        total: "Cases created inside the selected range.",
        active: `Cases whose status is not one of: ${[...TERMINAL].join(", ")}.`,
        unassigned: "Active cases inside the range with no assignee.",
        breached: "Cases whose summarized SLA state is Breached.",
        reopened: "Cases with a reopen timestamp inside the cohort.",
        reopenRate: "Reopened cases divided by cases that were resolved at least once.",
        csat: "Mean rating of submitted, valid surveys for the cohort; only staff with read-all scope see it.",
      },
    };
  }

  private async count(where: readonly Record<string, unknown>[]): Promise<number> {
    const result = await this.entities.aggregate(CASE_ENTITY, {
      where: [...where],
      dimensions: [],
      metrics: [],
      maxGroups: 1,
    });
    return result.total;
  }

  private async csatMetrics(
    from: Date,
    to: Date,
    resolved: number,
  ): Promise<
    | { restricted: true }
    | { restricted: false; count: number; average: number | null; responseRate: number | null }
  > {
    const level = await this.acl.canUser(CASE_ENTITY, "read");
    if (level !== "all" && level !== "yes") {
      return { restricted: true };
    }
    const rows = await this.database.db
      .selectFrom("entity_records")
      .select("attrs")
      .where("entity_type", "=", "CsatSurvey")
      .where("deleted_at", "is", null)
      .where(sql`attrs ->> 'status'`, "=", "Submitted")
      .where(sql`attrs ->> 'submittedAt'`, ">=", from.toISOString())
      .where(sql`attrs ->> 'submittedAt'`, "<=", to.toISOString())
      .execute();
    const ratings = rows
      .map((row) => Number((row.attrs as Record<string, unknown>)["rating"]))
      .filter((rating) => Number.isFinite(rating));
    const count = ratings.length;
    return {
      restricted: false,
      count,
      average: count === 0 ? null : Number((ratings.reduce((sum, rating) => sum + rating, 0) / count).toFixed(2)),
      responseRate: resolved === 0 ? null : Number((count / resolved).toFixed(4)),
    };
  }
}
