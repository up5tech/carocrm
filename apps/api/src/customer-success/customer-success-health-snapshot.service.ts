import { Inject, Injectable } from "@nestjs/common";

import { EntityCrudService } from "../entity/entity.service.js";
import { type HealthTrend,healthTrend } from "./customer-success-domain.js";
import { runAsCustomerSuccessInternal } from "./customer-success-internal.js";
import { CustomerSuccessRecords, type CustomerSuccessRow } from "./customer-success-records.js";

/**
 * Phase 19-CS.5 — append-only health snapshots (PLAN_Phase_19_Customer_Success.md §5.4.4).
 *
 * A snapshot is the source of truth for *why* a profile currently looks the way it does: it records
 * the score, the calculated status, the effective status, the component scores, the configuration
 * version and the calculation source. A new calculation never overwrites history, and the record API
 * can neither create nor edit a snapshot (the write guard refuses it; the record is created here
 * under the internal marker).
 */

export interface SnapshotComponentView {
  readonly key: string;
  readonly weight: number;
  readonly score: number | null;
  readonly applicability: string;
  readonly contribution: number | null;
  readonly measuredAt: string | null;
}

export interface SnapshotInput {
  readonly profileId: string;
  readonly accountId: string | null;
  readonly score: number | null;
  readonly calculatedStatus: string;
  readonly effectiveStatus: string;
  readonly coverage: number;
  readonly configurationVersion: number;
  readonly source: "manual" | "scheduled" | "event" | "rebuild";
  readonly resultState: "success" | "partial" | "failed";
  readonly errorSummary: string | null;
  readonly durationMs: number;
  readonly components: readonly SnapshotComponentView[];
  readonly signature: string;
  readonly triggerReason: string | null;
  readonly idempotencyKey: string | null;
  readonly calculatedAt: Date;
}

export interface HealthTrendView {
  readonly current: number | null;
  readonly previous: number | null;
  readonly trend: HealthTrend;
}

@Injectable()
export class CustomerSuccessHealthSnapshotService {
  constructor(
    @Inject(CustomerSuccessRecords) private readonly records: CustomerSuccessRecords,
    @Inject(EntityCrudService) private readonly entities: EntityCrudService,
  ) {}

  /** Newest snapshot of a profile, or undefined when none exists. */
  async latest(profileId: string): Promise<CustomerSuccessRow | undefined> {
    const rows = await this.records.find("CustomerSuccessHealthSnapshot", { profileId }, { limit: 5_000 });
    return rows.sort(byCalculatedAtDesc)[0];
  }

  /** Score history, newest first (§5.4.4 trend view). */
  async history(profileId: string, limit = 50): Promise<CustomerSuccessRow[]> {
    const bounded = Math.max(1, Math.min(500, limit));
    const rows = await this.records.find("CustomerSuccessHealthSnapshot", { profileId }, { limit: 5_000 });
    return rows.sort(byCalculatedAtDesc).slice(0, bounded);
  }

  async trend(profileId: string): Promise<HealthTrendView> {
    const rows = await this.history(profileId, 2);
    const current = scoreOf(rows[0]);
    const previous = scoreOf(rows[1]);
    return { current, previous, trend: healthTrend(previous, current) };
  }

  /** Persist one snapshot. Callers wrap this in `runAsCustomerSuccessInternal`. */
  async append(input: SnapshotInput): Promise<CustomerSuccessRow> {
    const data: Record<string, unknown> = {
      profileId: input.profileId,
      accountId: input.accountId,
      score: input.score,
      status: input.calculatedStatus,
      effectiveStatus: input.effectiveStatus,
      coverage: input.coverage,
      configurationVersion: input.configurationVersion,
      source: input.source,
      resultState: input.resultState,
      errorSummary: input.errorSummary,
      durationMs: input.durationMs,
      components: JSON.stringify(input.components),
      signature: input.signature,
      triggerReason: input.triggerReason,
      idempotencyKey: input.idempotencyKey,
      calculatedAt: input.calculatedAt.toISOString(),
      name: `Health ${String(input.score ?? "unknown")} (${input.effectiveStatus})`,
    };
    const created = await runAsCustomerSuccessInternal(() =>
      this.entities.create("CustomerSuccessHealthSnapshot", data),
    );
    return {
      id: String(created["id"]),
      entityType: "CustomerSuccessHealthSnapshot",
      version: typeof created["version"] === "number" ? created["version"] : 0,
      name: typeof created["name"] === "string" ? created["name"] : null,
      data,
    };
  }
}

function scoreOf(row: CustomerSuccessRow | undefined): number | null {
  if (row === undefined) return null;
  const value = row.data["score"];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function byCalculatedAtDesc(a: CustomerSuccessRow, b: CustomerSuccessRow): number {
  const left = String(a.data["calculatedAt"] ?? "");
  const right = String(b.data["calculatedAt"] ?? "");
  if (left === right) return String(b.id).localeCompare(String(a.id));
  return right.localeCompare(left);
}
