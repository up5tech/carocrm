import { NotFoundError, ValidationError } from "@carocrm/core/errors/index.js";
import { Inject, Injectable } from "@nestjs/common";

import type { RequestScope } from "../common/request-scope.js";
import { REQUEST_SCOPE_TOKEN } from "../common/request-scope.js";
import { DatabaseService } from "../database/database.service.js";
import { EntityCrudService } from "../entity/entity.service.js";
import { runInTransaction } from "../entity/tx-context.js";
import { EventBus } from "../events/event-bus.js";
import type { MetadataStoreService } from "../metadata/metadata-store.service.js";
import { METADATA_STORE } from "../metadata/metadata-store.service.js";
import {
  computeHealthScore,
  dayValue,
  HEALTH_STATUSES,
  type HealthCalculation,
  type HealthStatus,
  type HealthThresholdBand,
  text,
} from "./customer-success-domain.js";
import {
  CustomerSuccessHealthSnapshotService,
  type SnapshotComponentView,
} from "./customer-success-health-snapshot.service.js";
import { runAsCustomerSuccessInternal } from "./customer-success-internal.js";
import { CustomerSuccessNotificationService } from "./customer-success-notification.service.js";
import { CustomerSuccessRecords, type CustomerSuccessRow } from "./customer-success-records.js";
import {
  type CustomerSuccessSettings,
  CustomerSuccessSettingsService,
} from "./customer-success-settings.service.js";
import type { HealthFacts, HealthSignalResult } from "./customer-success-signals.js";
import { HealthSignalRegistry } from "./customer-success-signals.js";

/**
 * Phase 19-CS.4 / 19-CS.5 — the health engine (PLAN_Phase_19_Customer_Success.md §5.4).
 *
 * The engine loads every fact it needs once, runs the configured signals, and delegates the actual
 * arithmetic to the pure `computeHealthScore` (§5.4.3). It then keeps the append-only snapshot
 * history and the read-optimised profile summary in step, and never scores missing data as zero.
 */

export const RECALCULATION_SOURCES = ["manual", "scheduled", "event", "rebuild"] as const;
export type RecalculationSource = (typeof RECALCULATION_SOURCES)[number];

export interface RecalculateOptions {
  readonly source: RecalculationSource;
  /** Persist a snapshot even when nothing material changed (an explicit history request). */
  readonly force?: boolean | undefined;
  readonly triggerReason?: string | null | undefined;
  readonly idempotencyKey?: string | null | undefined;
}

/** Counts one bounded batch reports (§11.1: processed / skipped / errors + duration). */
export interface RecalculateBatchScan {
  readonly processed: number;
  readonly skipped: number;
  readonly errors: number;
  readonly ids: readonly string[];
  readonly durationMs: number;
}

/** Counts one bounded override-expiry run reports (§11.1). */
export interface ExpireOverrideScan {
  readonly processed: number;
  readonly skipped: number;
  readonly expired: number;
  readonly errors: number;
  readonly durationMs: number;
}

export interface HealthComponentView {
  readonly key: string;
  readonly label: string;
  readonly weight: number;
  readonly score: number | null;
  readonly applicability: string;
  readonly contribution: number | null;
  readonly measuredAt: string | null;
  readonly explanationCode: string;
  readonly detail: string | null;
  readonly available: boolean;
  readonly source: { readonly entity: string; readonly id: string } | null;
}

export interface HealthView {
  readonly profileId: string;
  readonly accountId: string | null;
  readonly score: number | null;
  readonly status: HealthStatus;
  readonly effectiveStatus: HealthStatus;
  readonly override: {
    readonly status: string | null;
    readonly reason: string | null;
    readonly expiresAt: string | null;
    readonly active: boolean;
  };
  readonly coverage: number;
  readonly configurationVersion: number;
  readonly calculatedAt: string;
  readonly trend: string;
  readonly components: readonly HealthComponentView[];
  readonly snapshotWritten: boolean;
  readonly degraded: boolean;
}

/** Default freshness window when a signal has no configured value. */
const DEFAULT_FRESHNESS_DAYS = 90;

@Injectable()
export class CustomerSuccessHealthService {
  constructor(
    @Inject(CustomerSuccessSettingsService) private readonly settings: CustomerSuccessSettingsService,
    @Inject(HealthSignalRegistry) private readonly signals: HealthSignalRegistry,
    @Inject(CustomerSuccessRecords) private readonly records: CustomerSuccessRecords,
    @Inject(CustomerSuccessHealthSnapshotService) private readonly snapshots: CustomerSuccessHealthSnapshotService,
    @Inject(EntityCrudService) private readonly entities: EntityCrudService,
    @Inject(CustomerSuccessNotificationService) private readonly notifications: CustomerSuccessNotificationService,
    @Inject(EventBus) private readonly events: EventBus,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(METADATA_STORE) private readonly metadata: MetadataStoreService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  /**
   * Recalculate one profile's health (§5.4.5 on-demand). Permission is the caller's record ACL on
   * `CustomerSuccessProfile`; the profile is loaded through the structural reader so the summary
   * fields can be updated by name.
   */
  async recalculate(profileId: string, options: RecalculateOptions): Promise<HealthView> {
    const started = Date.now();
    const profile = await this.records.byId("CustomerSuccessProfile", profileId);
    if (profile === undefined) throw new NotFoundError(`CustomerSuccessProfile "${profileId}" does not exist.`);

    const settingsView = await this.settings.read();
    const settings = settingsView.settings;
    const now = new Date();

    if (!settings.features.healthScoring) {
      throw new ValidationError(
        "Health scoring is disabled; enable features.healthScoring before recalculating.",
        { module: "CustomerSuccess" },
      );
    }

    const profileData = profile.data;
    const accountId = text(profileData["accountId"]) ?? null;
    const facts = await this.loadFacts(profile, accountId);

    const signalResults: HealthSignalResult[] = [];
    const configured = settings.health.signals.filter(
      (signal) => signal.enabled || signal.key === "support" || signal.key === "adoption",
    );
    for (const config of configured) {
      signalResults.push(this.signals.collect(config.key, facts, settings, now));
    }
    // Always report the unavailable families so health configuration can show them (§12.6).
    for (const key of ["support", "adoption"]) {
      if (!signalResults.some((result) => result.key === key)) {
        signalResults.push(this.signals.collect(key, facts, settings, now));
      }
    }

    const weightByKey = new Map(settings.health.signals.map((signal) => [signal.key, signal]));
    const calculation = computeHealthScore({
      signals: signalResults.map((result) => {
        const config = weightByKey.get(result.key);
        return {
          key: result.key,
          weight: config?.weight ?? 0,
          applicability: result.applicability,
          score: result.score,
          measuredAt: result.measuredAt,
          freshnessWindowMs:
            (config?.freshnessDays ?? DEFAULT_FRESHNESS_DAYS) * 86_400_000,
        };
      }),
      bands: settings.health.thresholds as HealthThresholdBand[],
      minimumCoverage: settings.health.minimumCoverage,
      missingDataPolicy: settings.health.missingDataPolicy,
      rounding: settings.health.rounding,
      now,
    });

    const overrideState = await this.resolveOverride(profile, settings, now);
    const calculatedStatus = calculation.status;
    const effectiveStatus: HealthStatus =
      overrideState.active && overrideState.status !== null
        ? (overrideState.status as HealthStatus)
        : calculatedStatus;

    const signature = signatureOf(settingsView.version, calculation);
    const previous = await this.snapshots.latest(profileId);
    const materialChange = previous === undefined || String(previous.data["signature"] ?? "") !== signature;
    const shouldWrite = options.force === true || materialChange;

    const components = this.viewComponents(calculation, signalResults);
    const durationMs = Date.now() - started;
    const resultState = calculation.score === null ? "partial" : "success";

    const outcome = await runInTransaction(this.database.db, async () => {
      let snapshotWritten = false;
      if (shouldWrite) {
        await this.snapshots.append({
          profileId,
          accountId,
          score: calculation.score,
          calculatedStatus,
          effectiveStatus,
          coverage: calculation.coverage,
          configurationVersion: settingsView.version,
          source: options.source,
          resultState,
          errorSummary: null,
          durationMs,
          components: snapshotComponents(calculation),
          signature,
          triggerReason: options.triggerReason ?? null,
          idempotencyKey: options.idempotencyKey ?? null,
          calculatedAt: now,
        });
        snapshotWritten = true;
      }

      const previousStatus = text(profileData["calculatedHealthStatus"]) ?? null;
      const trend = await this.snapshots.trend(profileId);
      await runAsCustomerSuccessInternal(() =>
        this.entities.update("CustomerSuccessProfile", profileId, {
          healthScore: calculation.score,
          healthScoreAt: now.toISOString(),
          calculatedHealthStatus: calculatedStatus,
          healthStatus: effectiveStatus,
          scoreTrend: trend.trend,
          openRiskCount: facts.risks.filter((risk) => {
            const status = text(risk.data["status"]) ?? "open";
            return status !== "resolved" && status !== "closed" && status !== "accepted";
          }).length,
          activePlanProgress: activePlanProgress(facts),
          lastMeaningfulTouchAt: facts.activities.length > 0 ? maxTouch(facts) : null,
        }),
      );

      await this.events.dispatch(this.database.db, {
        type: "customerSuccess.health.calculated",
        payload: {
          profileId,
          accountId,
          score: calculation.score,
          status: calculatedStatus,
          effectiveStatus,
          coverage: Number(calculation.coverage.toFixed(4)),
          configurationVersion: settingsView.version,
          source: options.source,
        },
      });
      if (previousStatus !== null && previousStatus !== calculatedStatus) {
        await this.events.dispatch(this.database.db, {
          type: "customerSuccess.health.statusChanged",
          payload: { profileId, accountId, from: previousStatus, to: calculatedStatus },
        });
      }
      return { snapshotWritten };
    });

    // §11.2 — a drop into `atRisk` or `critical` is the one health event worth interrupting someone
    // for. The dedup key is per profile and status, so a re-run of the same calculation stays quiet.
    const previousCalculated = text(profileData["calculatedHealthStatus"]) ?? null;
    if (previousCalculated !== calculatedStatus && (calculatedStatus === "atRisk" || calculatedStatus === "critical")) {
      const csmUserId = text(profileData["csmUserId"]);
      if (csmUserId !== undefined) {
        await this.notifications.notify({
          userId: csmUserId,
          type: "CustomerSuccessHealth",
          title: calculatedStatus === "critical" ? "Customer health is critical" : "Customer health is at risk",
          body: `${text(profileData["name"]) ?? "A customer"} moved from ${previousCalculated ?? "unknown"} to ${calculatedStatus}.`,
          dedupKey: `health:${profileId}:${calculatedStatus}`,
          link: `/CustomerSuccessProfile/view/${profileId}`,
          severity: "critical",
        });
      }
    }

    return {
      profileId,
      accountId,
      score: calculation.score,
      status: calculatedStatus,
      effectiveStatus,
      override: {
        status: overrideState.status,
        reason: text(profileData["healthOverrideReason"]) ?? null,
        expiresAt: dayValue(profileData["healthOverrideExpiresAt"]) ?? null,
        active: overrideState.active,
      },
      coverage: calculation.coverage,
      configurationVersion: settingsView.version,
      calculatedAt: now.toISOString(),
      trend: (await this.snapshots.trend(profileId)).trend,
      components,
      snapshotWritten: outcome.snapshotWritten,
      degraded: resultState !== "success",
    };
  }

  /** Component-level explanation of the latest calculation (§8.2 `healthExplanation`). */
  async explanation(profileId: string): Promise<HealthView> {
    const snapshot = await this.snapshots.latest(profileId);
    if (snapshot === undefined) {
      // No history yet: calculate once so the user gets an explainable answer.
      return this.recalculate(profileId, { source: "manual", force: true, triggerReason: "explanation" });
    }
    const profile = await this.records.byId("CustomerSuccessProfile", profileId);
    if (profile === undefined) throw new NotFoundError(`CustomerSuccessProfile "${profileId}" does not exist.`);
    const settingsView = await this.settings.read();
    const settings = settingsView.settings;
    const now = new Date();
    const overrideState = await this.resolveOverride(profile, settings, now);
    const components = parseComponents(snapshot.data["components"]);
    // The effective status is resolved *now*, not read from the snapshot: an override set after the
    // last calculation has not been through `recalculate()`, and the snapshot's `effectiveStatus`
    // would still show the pre-override answer (§5.4.1 — the override is in force until it expires).
    const status = (text(snapshot.data["status"]) ?? "unknown") as HealthStatus;
    const effectiveStatus: HealthStatus =
      overrideState.active && overrideState.status !== null
        ? (overrideState.status as HealthStatus)
        : status;
    return {
      profileId,
      accountId: text(profile.data["accountId"]) ?? null,
      score: numberOrNull(snapshot.data["score"]),
      status,
      effectiveStatus,
      override: {
        status: overrideState.status,
        reason: text(profile.data["healthOverrideReason"]) ?? null,
        expiresAt: dayValue(profile.data["healthOverrideExpiresAt"]) ?? null,
        active: overrideState.active,
      },
      coverage: numberOrNull(snapshot.data["coverage"]) ?? 0,
      configurationVersion: numberOrNull(snapshot.data["configurationVersion"]) ?? 0,
      calculatedAt: text(snapshot.data["calculatedAt"]) ?? new Date().toISOString(),
      trend: (await this.snapshots.trend(profileId)).trend,
      components: components.map((component) => this.decorateComponent(component)),
      snapshotWritten: false,
      degraded: text(snapshot.data["resultState"]) !== "success",
    };
  }

  /** Score history, newest first. */
  async history(profileId: string, limit: number): Promise<Record<string, unknown>[]> {
    const rows = await this.snapshots.history(profileId, limit);
    return rows.map((row) => ({
      id: row.id,
      score: numberOrNull(row.data["score"]),
      status: text(row.data["status"]) ?? "unknown",
      effectiveStatus: text(row.data["effectiveStatus"]) ?? "unknown",
      coverage: numberOrNull(row.data["coverage"]) ?? 0,
      configurationVersion: numberOrNull(row.data["configurationVersion"]) ?? 0,
      source: text(row.data["source"]) ?? "manual",
      resultState: text(row.data["resultState"]) ?? "success",
      durationMs: numberOrNull(row.data["durationMs"]),
      calculatedAt: text(row.data["calculatedAt"]) ?? null,
      components: parseComponents(row.data["components"]),
    }));
  }

  /**
   * Set a manual override (§5.4.1). The calculated score is untouched; the effective status is the
   * override until it expires. A non-empty reason is mandatory.
   */
  async setOverride(
    profileId: string,
    input: { readonly status: string; readonly reason: string; readonly expiresAt?: string | null | undefined },
  ): Promise<Record<string, unknown>> {
    if (!(HEALTH_STATUSES as readonly string[]).includes(input.status) || input.status === "unknown") {
      throw new ValidationError(`"${input.status}" is not a valid override status.`, { status: input.status });
    }
    if (input.reason.trim() === "") {
      throw new ValidationError("A health override requires a reason.", { profileId });
    }
    const profile = await this.records.byId("CustomerSuccessProfile", profileId);
    if (profile === undefined) throw new NotFoundError(`CustomerSuccessProfile "${profileId}" does not exist.`);
    const now = new Date();
    const calculated = text(profile.data["calculatedHealthStatus"]) ?? "unknown";
    await runInTransaction(this.database.db, async () => {
      await runAsCustomerSuccessInternal(() =>
        this.entities.update("CustomerSuccessProfile", profileId, {
          healthOverride: input.status,
          healthOverrideReason: input.reason,
          healthOverrideByUserId: this.scope.userId ?? null,
          healthOverrideAt: now.toISOString(),
          healthOverrideExpiresAt: input.expiresAt ?? null,
          healthStatus: input.status,
          calculatedHealthStatus: calculated,
        }),
      );
      await this.events.dispatch(this.database.db, {
        type: "customerSuccess.health.overrideSet",
        payload: { profileId, status: input.status, expiresAt: input.expiresAt ?? null },
      });
    });
    return { profileId, override: input.status, calculatedStatus: calculated };
  }

  /** Clear an override, returning the effective status to the calculated one (§8.2). */
  async clearOverride(profileId: string, reason: string): Promise<Record<string, unknown>> {
    const profile = await this.records.byId("CustomerSuccessProfile", profileId);
    if (profile === undefined) throw new NotFoundError(`CustomerSuccessProfile "${profileId}" does not exist.`);
    const calculated = text(profile.data["calculatedHealthStatus"]) ?? "unknown";
    await runInTransaction(this.database.db, async () => {
      await runAsCustomerSuccessInternal(() =>
        this.entities.update("CustomerSuccessProfile", profileId, {
          healthOverride: null,
          healthOverrideReason: null,
          healthOverrideByUserId: null,
          healthOverrideAt: null,
          healthOverrideExpiresAt: null,
          healthStatus: calculated,
        }),
      );
      await this.events.dispatch(this.database.db, {
        type: "customerSuccess.health.overrideExpired",
        payload: { profileId, reason: reason.trim() === "" ? "cleared" : reason },
      });
    });
    return { profileId, cleared: true, calculatedStatus: calculated };
  }

  /** Expire every override whose date has passed (§11.1 `expireHealthOverrides`). */
  async expireOverrides(today: string, limit: number): Promise<ExpireOverrideScan> {
    const started = Date.now();
    const rows = await this.records.find("CustomerSuccessProfile", {}, { limit: 5_000 });
    const result = { processed: 0, skipped: 0, expired: 0, errors: 0 };
    for (const row of rows) {
      if (result.processed >= limit) break;
      result.processed += 1;
      const expiresAt = dayValue(row.data["healthOverrideExpiresAt"]);
      if (expiresAt === undefined || expiresAt >= today) {
        result.skipped += 1;
        continue;
      }
      try {
        const calculated = text(row.data["calculatedHealthStatus"]) ?? "unknown";
        await runInTransaction(this.database.db, async () => {
          await runAsCustomerSuccessInternal(() =>
            this.entities.update("CustomerSuccessProfile", row.id, {
              healthOverride: null,
              healthOverrideReason: null,
              healthStatus: calculated,
            }),
          );
          await this.events.dispatch(this.database.db, {
            type: "customerSuccess.health.overrideExpired",
            payload: { profileId: row.id, reason: "expired" },
          });
        });
        result.expired += 1;
      } catch {
        // One profile that cannot be written must not stop the batch (§11.1).
        result.errors += 1;
      }
    }
    return { ...result, durationMs: Date.now() - started };
  }

  /** Profiles due for a refresh: no score, or a score older than the configured interval (§11.1). */
  async profilesDueForRefresh(today: string, atMost: number): Promise<string[]> {
    const settings = await this.settings.settings();
    const rows = await this.records.find("CustomerSuccessProfile", {}, { limit: 5_000 });
    const due: string[] = [];
    for (const row of rows) {
      const at = text(row.data["healthScoreAt"]);
      const stale = at === undefined || expiredSince(at, today, settings.jobs.refreshIntervalDays);
      if (stale) due.push(row.id);
      if (due.length >= atMost) break;
    }
    return due;
  }

  /** Batch recalculation (§5.4.5). Bounded and ordered; each profile is independent. */
  async recalculateBatch(input: { readonly limit: number; readonly source: RecalculationSource }): Promise<RecalculateBatchScan> {
    const started = Date.now();
    const settings = await this.settings.settings();
    const limit = Math.max(1, Math.min(settings.jobs.batchSize, input.limit));
    const today = new Date().toISOString().slice(0, 10);
    const ids = await this.profilesDueForRefresh(today, limit);
    const result = { processed: 0, skipped: 0, errors: 0, ids: [] as string[] };
    for (const id of ids) {
      try {
        await this.recalculate(id, { source: input.source });
        result.processed += 1;
        result.ids.push(id);
      } catch {
        result.errors += 1;
      }
    }
    result.skipped = ids.length - result.processed - result.errors;
    return { ...result, durationMs: Date.now() - started };
  }

  // -------------------------------------------------------------------------

  private async loadFacts(profile: CustomerSuccessRow, accountId: string | null): Promise<HealthFacts> {
    const contacts = accountId === null ? [] : await this.records.find("Contact", { accountId }, { limit: 500 });
    const activities =
      accountId === null
        ? []
        : await this.records.linkedActivitiesForAccount(
            accountId,
            contacts.map((contact) => contact.id),
          );
    const plans = await this.records.find("CustomerSuccessPlan", { profileId: profile.id }, { limit: 500 });
    const goals = await this.records.find("CustomerSuccessGoal", { profileId: profile.id }, { limit: 2_000 });
    const risks = await this.records.find("CustomerSuccessRisk", { profileId: profile.id }, { limit: 1_000 });
    const activeRunId = text(profile.data["activePlaybookRunId"]);
    const onboardingSteps =
      activeRunId === undefined
        ? []
        : await this.records.find("CustomerSuccessPlaybookStepRun", { runId: activeRunId }, { limit: 500 });
    const supportSourceAvailable = this.metadata.registry.hasEntity("Case");
    const cases =
      accountId === null || !supportSourceAvailable
        ? []
        : await this.records.find("Case", { accountId }, { limit: 1_000 });
    return {
      accountId: accountId ?? "",
      profile,
      contacts,
      activities,
      plans,
      goals,
      risks,
      onboardingSteps,
      cases,
      subscriptionSourceAvailable: this.metadata.registry.hasEntity("Subscription"),
      supportSourceAvailable,
    };
  }

  private async resolveOverride(
    profile: CustomerSuccessRow,
    _settings: CustomerSuccessSettings,
    now: Date,
  ): Promise<{ active: boolean; status: string | null }> {
    const status = text(profile.data["healthOverride"]) ?? null;
    if (status === null) return { active: false, status: null };
    const expiresAt = dayValue(profile.data["healthOverrideExpiresAt"]);
    if (expiresAt === undefined) return { active: true, status };
    const today = dayValue(now) ?? now.toISOString().slice(0, 10);
    return { active: expiresAt >= today, status };
  }

  private viewComponents(
    calculation: HealthCalculation,
    results: readonly HealthSignalResult[],
  ): HealthComponentView[] {
    const byKey = new Map(results.map((result) => [result.key, result]));
    return calculation.components.map((component) => {
      const result = byKey.get(component.key);
      return this.decorateComponent({
        key: component.key,
        weight: component.weight,
        score: component.score,
        applicability: component.applicability,
        contribution: component.contribution,
        measuredAt: component.measuredAt,
        explanationCode: result?.explanationCode ?? "unknown",
        detail: result?.detail ?? null,
        source: result?.source ?? null,
      });
    });
  }

  private decorateComponent(component: {
    readonly key: string;
    readonly weight: number;
    readonly score: number | null;
    readonly applicability: string;
    readonly contribution: number | null;
    readonly measuredAt: string | null;
    readonly explanationCode: string;
    readonly detail: string | null;
    readonly source: { readonly entity: string; readonly id: string } | null;
  }): HealthComponentView {
    const provider = this.signals.get(component.key);
    return {
      ...component,
      label: provider?.label ?? component.key,
      available: provider?.available ?? false,
    };
  }
}

function activePlanProgress(facts: HealthFacts): number | null {
  const active = facts.plans.filter((plan) => text(plan.data["status"]) === "active");
  if (active.length === 0) return null;
  const planIds = new Set(active.map((plan) => plan.id));
  const goals = facts.goals.filter((goal) => planIds.has(text(goal.data["planId"]) ?? ""));
  if (goals.length === 0) return null;
  const total = goals.reduce((sum, goal) => {
    const progress = goal.data["progress"];
    return sum + (typeof progress === "number" && Number.isFinite(progress) ? progress : 0);
  }, 0);
  return Math.round(total / goals.length);
}

function maxTouch(facts: HealthFacts): string | null {
  let latest: number | null = null;
  for (const activity of facts.activities) {
    const instant = text(activity.data["completedAt"]) ?? text(activity.data["dateStart"]) ?? text(activity.data["createdAt"]);
    if (instant === undefined) continue;
    const parsed = Date.parse(instant);
    if (Number.isNaN(parsed)) continue;
    if (latest === null || parsed > latest) latest = parsed;
  }
  return latest === null ? null : new Date(latest).toISOString();
}

function signatureOf(version: number, calculation: HealthCalculation): string {
  const parts = calculation.components.map(
    (component) => `${component.key}:${component.applicability}:${String(component.score)}:${String(component.weight)}`,
  );
  return JSON.stringify({
    v: version,
    score: calculation.score,
    status: calculation.status,
    coverage: Number(calculation.coverage.toFixed(4)),
    parts,
  });
}

function snapshotComponents(calculation: HealthCalculation): SnapshotComponentView[] {
  return calculation.components.map((component) => ({
    key: component.key,
    weight: component.weight,
    score: component.score,
    applicability: component.applicability,
    contribution: component.contribution,
    measuredAt: component.measuredAt,
  }));
}

function parseComponents(raw: unknown): HealthComponentView[] {
  const value = typeof raw === "string" ? safeParse(raw) : raw;
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item) => ({
      key: String(item["key"] ?? ""),
      label: String(item["label"] ?? item["key"] ?? ""),
      weight: numberOrNull(item["weight"]) ?? 0,
      score: numberOrNull(item["score"]),
      applicability: String(item["applicability"] ?? "missing"),
      contribution: numberOrNull(item["contribution"]),
      measuredAt: typeof item["measuredAt"] === "string" ? item["measuredAt"] : null,
      explanationCode: String(item["explanationCode"] ?? "unknown"),
      detail: typeof item["detail"] === "string" ? item["detail"] : null,
      available: item["available"] !== false,
      source: null,
    }));
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function expiredSince(at: string, today: string, days: number): boolean {
  const parsed = Date.parse(at);
  if (Number.isNaN(parsed)) return true;
  const todayMs = Date.parse(`${today}T00:00:00.000Z`);
  return todayMs - parsed > days * 86_400_000;
}
