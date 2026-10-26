import { Inject, Injectable, type OnApplicationBootstrap } from "@nestjs/common";
import { sql } from "kysely";

import { DatabaseService } from "../database/database.service.js";
import type { AfterSaveHook, AfterSaveHookArgs } from "../entity/hooks.js";
import { KERNEL_HOOKS_TOKEN } from "../entity/hooks.js";
import { currentTx, runInTransaction } from "../entity/tx-context.js";
import { EventBus } from "../events/event-bus.js";
import { KnowledgeBaseService } from "./knowledge-base.service.js";
import { CASE_ENTITY } from "./service-desk-domain.js";
import { ServiceDeskNotificationService } from "./service-desk-notification.service.js";
import { ServiceDeskRecords } from "./service-desk-records.js";
import { ServiceDeskSettingsService } from "./service-desk-settings.service.js";

export interface BusinessCalendar {
  readonly id: string;
  readonly timezone: string;
  readonly intervals: Record<string, Array<{ start: string; end: string }>>;
  readonly holidays: ReadonlySet<string>;
}

export interface SLAPolicy {
  readonly id: string;
  readonly version: number;
  readonly calendarId: string | null;
  readonly firstResponseMinutes: number;
  readonly nextResponseMinutes: number;
  readonly resolutionMinutes: number;
  readonly pauseOnCustomer: boolean;
  readonly pauseOnInternal: boolean;
  readonly warningThresholds: readonly number[];
  readonly conditions: readonly { field: string; operator: string; value: unknown }[];
  readonly priority: number;
}

/** Bounded scan size per run: a scheduler tick must never load the whole clock table (§12.2). */
export const SLA_SCAN_BATCH_SIZE = 500;
/** A corrupt calendar cannot make business-time arithmetic loop forever. */
const MAX_MINUTE_SCAN = 200_000;
const DEFAULT_WARNING_THRESHOLDS: readonly number[] = [75];
const TERMINAL_CASE_STATUSES: ReadonlySet<string> = new Set(["Resolved", "Closed", "Cancelled"]);

@Injectable()
export class SlaService implements OnApplicationBootstrap {
  constructor(
    @Inject(ServiceDeskSettingsService) private readonly settings: ServiceDeskSettingsService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(KERNEL_HOOKS_TOKEN) private readonly kernelHooks: AfterSaveHook[],
    @Inject(ServiceDeskNotificationService) private readonly notifications: ServiceDeskNotificationService,
    @Inject(ServiceDeskRecords) private readonly records: ServiceDeskRecords,
    @Inject(KnowledgeBaseService) private readonly knowledgeBase: KnowledgeBaseService,
    @Inject(EventBus) private readonly events: EventBus,
  ) {}

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private get db(): any {
    return currentTx() ?? this.database.db;
  }

  onApplicationBootstrap(): void {
    this.kernelHooks.push(async (args) => {
      if (args.entityType !== CASE_ENTITY) return;
      await this.onCaseSaved(args);
    });
  }

  private async onCaseSaved(args: AfterSaveHookArgs): Promise<void> {
    const settings = await this.settings.settings();
    if (!settings.features.sla) return;
    const data = (args.record.data ?? {}) as Record<string, unknown>;
    if (args.operation === "create") {
      await this.onCaseCreated(String(args.record.id), data);
      await this.events.dispatchMany(args.tx, [{ type: "serviceDesk.case.created", payload: { caseId: String(args.record.id), caseNumber: data["caseNumber"] ?? null } }]);
      return;
    }
    if (args.operation === "update" && args.previous) {
      const prevStatus = String(args.previous["status"] ?? "");
      const newStatus = String(data["status"] ?? "");
      if (prevStatus !== newStatus) {
        if (newStatus === "Resolved") await this.onResolved(String(args.record.id));
        else {
          await this.onStatusChanged(String(args.record.id), newStatus, data);
          if (newStatus === "Open" && (prevStatus === "Resolved" || prevStatus === "Closed")) {
            await this.onReopened(String(args.record.id), data);
          }
        }
      }
    }
  }

  conditionsMatch(conditions: readonly { field: string; operator: string; value: unknown }[], data: Record<string, unknown>): boolean {
    if (conditions.length === 0) return true;
    return conditions.every((c) => {
      const actual = data[c.field];
      switch (c.operator) {
        case "equals":
          return actual === c.value;
        case "notEquals":
          return actual !== c.value;
        case "in":
          return Array.isArray(c.value) && (c.value as unknown[]).includes(actual);
        default:
          return false;
      }
    });
  }

  async resolvePolicy(data: Record<string, unknown>): Promise<SLAPolicy | null> {
    const settings = await this.settings.settings();
    if (!settings.features.sla) return null;
    const rows = await this.db
      .selectFrom("entity_records")
      .select(["id", "attrs"])
      .where("entity_type", "=", "SLAPolicy")
      .where("deleted_at", "is", null)
      .execute();
    const candidates: SLAPolicy[] = [];
    for (const r of rows) {
      const a = (r.attrs ?? {}) as Record<string, unknown>;
      if (a["isActive"] === false) continue;
      let conditions: { field: string; operator: string; value: unknown }[] = [];
      try {
        const parsed = JSON.parse(typeof a["conditions"] === "string" ? (a["conditions"] as string) : "[]");
        if (Array.isArray(parsed)) conditions = parsed as { field: string; operator: string; value: unknown }[];
      } catch {
        conditions = [];
      }
      if (!this.conditionsMatch(conditions, data)) continue;
      let thresholds: number[] = [];
      try {
        const parsed = JSON.parse(typeof a["warningThresholds"] === "string" ? (a["warningThresholds"] as string) : "[]");
        if (Array.isArray(parsed)) thresholds = parsed.map((n) => Number(n)).filter((n) => !Number.isNaN(n));
      } catch {
        thresholds = [];
      }
      candidates.push({
        id: String(r.id),
        version: typeof a["version"] === "number" ? (a["version"] as number) : 1,
        calendarId: typeof a["calendarId"] === "string" ? (a["calendarId"] as string) : null,
        firstResponseMinutes: typeof a["firstResponseMinutes"] === "number" ? (a["firstResponseMinutes"] as number) : 0,
        nextResponseMinutes: typeof a["nextResponseMinutes"] === "number" ? (a["nextResponseMinutes"] as number) : 0,
        resolutionMinutes: typeof a["resolutionMinutes"] === "number" ? (a["resolutionMinutes"] as number) : 0,
        pauseOnCustomer: a["pauseOnCustomer"] !== false,
        pauseOnInternal: a["pauseOnInternal"] !== false,
        warningThresholds: thresholds,
        conditions,
        priority: typeof a["priority"] === "number" ? (a["priority"] as number) : 0,
      });
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.priority - b.priority);
    return candidates[0] ?? null;
  }

  async loadCalendar(id: string | null): Promise<BusinessCalendar | null> {
    if (id === null) return null;
    const row = await this.db
      .selectFrom("entity_records")
      .select("attrs")
      .where("entity_type", "=", "BusinessCalendar")
      .where("id", "=", id)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (row === undefined) return null;
    const a = (row.attrs ?? {}) as Record<string, unknown>;
    let intervals: Record<string, Array<{ start: string; end: string }>> = {};
    try {
      const parsed = JSON.parse(typeof a["intervals"] === "string" ? (a["intervals"] as string) : "{}");
      if (parsed && typeof parsed === "object") intervals = parsed as Record<string, Array<{ start: string; end: string }>>;
    } catch {
      intervals = {};
    }
    let holidays = new Set<string>();
    try {
      const parsed = JSON.parse(typeof a["holidays"] === "string" ? (a["holidays"] as string) : "[]");
      if (Array.isArray(parsed)) holidays = new Set(parsed.map((h) => String(h)));
    } catch {
      holidays = new Set();
    }
    return {
      id,
      timezone: typeof a["timezone"] === "string" ? (a["timezone"] as string) : "UTC",
      intervals,
      holidays,
    };
  }

  /** Advance an instant by `minutes` of *business* time on the calendar (§5.6 time calculation). */
  addBusinessMinutes(start: Date, minutes: number, calendar: BusinessCalendar | null): Date {
    if (minutes <= 0) return new Date(start);
    if (calendar === null || Object.keys(calendar.intervals).length === 0) {
      return new Date(start.getTime() + minutes * 60_000);
    }
    let cursor = new Date(start);
    let remaining = minutes;
    let guard = 0;
    while (remaining > 0 && guard < MAX_MINUTE_SCAN) {
      guard += 1;
      if (this.isBusinessMinute(cursor, calendar)) {
        remaining -= 1;
      }
      cursor = new Date(cursor.getTime() + 60_000);
    }
    return cursor;
  }

  /**
   * Business minutes actually elapsed between two instants. Used for warning thresholds, elapsed
   * time and pause accounting; bounded so a corrupt calendar can never scan indefinitely.
   */
  businessMinutesBetween(start: Date, end: Date, calendar: BusinessCalendar | null): number {
    if (end.getTime() <= start.getTime()) return 0;
    if (calendar === null || Object.keys(calendar.intervals).length === 0) {
      return Math.floor((end.getTime() - start.getTime()) / 60_000);
    }
    let count = 0;
    let guard = 0;
    let cursor = new Date(start);
    while (cursor.getTime() < end.getTime() && guard < MAX_MINUTE_SCAN) {
      if (this.isBusinessMinute(cursor, calendar)) count += 1;
      cursor = new Date(cursor.getTime() + 60_000);
      guard += 1;
    }
    return count;
  }

  /**
   * The calendar is evaluated in its own IANA time zone, so weekly intervals and holidays follow
   * local wall time and daylight-saving transitions instead of server UTC (PLAN §5.6).
   */
  /**
   * 19-OM.11 — is the calendar open at `at`? Routing uses the same wall-clock rules as the SLA clock
   * (weekly intervals + holidays in the calendar's own timezone), so "after hours" means one thing.
   */
  isOpenAt(at: Date, calendar: BusinessCalendar | null): boolean {
    if (calendar === null) return true;
    return this.isBusinessMinute(at, calendar);
  }

  private isBusinessMinute(d: Date, calendar: BusinessCalendar): boolean {
    const local = zonedParts(d, calendar.timezone);
    if (calendar.holidays.has(local.dateKey)) return false;
    const slots = calendar.intervals[String(local.weekday)];
    if (!slots || slots.length === 0) return false;
    const mins = local.hour * 60 + local.minute;
    return slots.some((s) => {
      const sp = s.start.split(":").map((n) => Number(n));
      const ep = s.end.split(":").map((n) => Number(n));
      const sh = sp[0] ?? 0;
      const sm = sp[1] ?? 0;
      const eh = ep[0] ?? 0;
      const em = ep[1] ?? 0;
      const startM = sh * 60 + sm;
      const endM = eh * 60 + em;
      return mins >= startM && mins < endM;
    });
  }

  async onCaseCreated(caseId: string, data: Record<string, unknown>): Promise<void> {
    const settings = await this.settings.settings();
    if (!settings.features.sla) return;
    const policy = await this.resolvePolicy(data);
    if (policy === null) {
      await this.setCaseSlaState(caseId, "notApplicable", null, null);
      return;
    }
    const calendar = await this.loadCalendar(policy.calendarId);
    const now = new Date();
    await this.setCaseSlaState(caseId, "onTrack", policy.id, policy.version);
    await this.createClock(caseId, "firstResponse", policy, policy.firstResponseMinutes, now, calendar);
    if (policy.nextResponseMinutes > 0) await this.createClock(caseId, "nextResponse", policy, policy.nextResponseMinutes, now, calendar);
    if (policy.resolutionMinutes > 0) await this.createClock(caseId, "resolution", policy, policy.resolutionMinutes, now, calendar);
  }

  /**
   * A reopened case starts a new resolution cycle with a fresh clock. Prior cycles keep their
   * `met` clock and history, so the earlier resolution remains auditable (§5.6 reopen semantics).
   */
  private async onReopened(caseId: string, data: Record<string, unknown>): Promise<void> {
    const policy = await this.resolvePolicy(data);
    if (policy === null || policy.resolutionMinutes <= 0) return;
    const calendar = await this.loadCalendar(policy.calendarId);
    const rows = await this.db
      .selectFrom("entity_records")
      .select("attrs")
      .where("entity_type", "=", "CaseSLAClock")
      .where("deleted_at", "is", null)
      .where(sql`attrs ->> 'caseId'`, "=", caseId)
      .where(sql`attrs ->> 'targetType'`, "=", "resolution")
      .execute();
    let cycle = 1;
    for (const row of rows) {
      const a = (row.attrs ?? {}) as Record<string, unknown>;
      const value = typeof a["cycle"] === "number" ? (a["cycle"] as number) : 1;
      if (value >= cycle) cycle = value + 1;
    }
    await this.createClock(caseId, "resolution", policy, policy.resolutionMinutes, new Date(), calendar, cycle);
    await this.recomputeCaseState(caseId);
  }

  private async createClock(
    caseId: string,
    targetType: string,
    policy: SLAPolicy,
    minutes: number,
    start: Date,
    calendar: BusinessCalendar | null,
    cycle = 1,
  ): Promise<void> {
    if (minutes <= 0) return;
    const due = this.addBusinessMinutes(start, minutes, calendar);
    const id = `slc_${caseId}_${targetType}_${Date.now().toString(36)}_${cycle}`;
    await sql`INSERT INTO entity_records (id, entity_type, attrs, version, created_at, modified_at)
      VALUES (${id}, 'CaseSLAClock', ${JSON.stringify({
        name: `${targetType} clock (cycle ${String(cycle)})`,
        caseId,
        targetType,
        policyId: policy.id,
        policyVersion: policy.version,
        calendarId: policy.calendarId,
        warningThresholds: policy.warningThresholds,
        startAt: start.toISOString(),
        dueAt: due.toISOString(),
        elapsedMinutes: 0,
        totalPausedBusinessMinutes: 0,
        status: "onTrack",
        cycle,
      })}::jsonb, 1, now(), now())`.execute(this.db);
  }

  async markMet(caseId: string, targetType: string): Promise<void> {
    const settings = await this.settings.settings();
    if (!settings.features.sla) return;
    const rows = await this.db
      .selectFrom("entity_records")
      .select("id")
      .select("attrs")
      .where("entity_type", "=", "CaseSLAClock")
      .where("deleted_at", "is", null)
      .where(sql`attrs ->> 'caseId'`, "=", caseId)
      .where(sql`attrs ->> 'targetType'`, "=", targetType)
      .execute();
    const calendars = new Map<string, BusinessCalendar | null>();
    const now = new Date();
    for (const r of rows) {
      const a = (r.attrs ?? {}) as Record<string, unknown>;
      const st = String(a["status"] ?? "");
      if (st !== "onTrack" && st !== "warning" && st !== "paused") continue;
      const calendar = await this.calendarFor(a, calendars);
      const start = a["startAt"] ? new Date(String(a["startAt"])) : now;
      const elapsed = this.businessMinutesBetween(start, now, calendar);
      await sql`UPDATE entity_records SET attrs = attrs || ${JSON.stringify({
        status: "met",
        metAt: now.toISOString(),
        elapsedMinutes: elapsed,
      })}::jsonb, modified_at = now() WHERE id = ${String(r.id)}`.execute(this.db);
    }
    await this.recomputeCaseState(caseId);
  }

  async onPublicReply(caseId: string): Promise<void> {
    const settings = await this.settings.settings();
    if (!settings.features.sla) return;
    await this.markMet(caseId, "firstResponse");
    await this.markMet(caseId, "nextResponse");
  }

  async onResolved(caseId: string): Promise<void> {
    const settings = await this.settings.settings();
    if (!settings.features.sla) return;
    await this.markMet(caseId, "resolution");
  }

  private async setCaseSlaState(caseId: string, state: string, policyId: string | null, _policyVersion: number | null): Promise<void> {
    const slaState = state === "notApplicable" ? "NotApplicable" : state === "onTrack" ? "OnTrack" : state === "warning" ? "Warning" : state === "breached" ? "Breached" : state === "paused" ? "Paused" : state === "met" ? "Met" : "NotApplicable";
    const patch: Record<string, unknown> = { slaState };
    if (policyId !== null) patch["slaPolicyId"] = policyId;
    await sql`UPDATE entity_records SET attrs = attrs || ${JSON.stringify(patch)}::jsonb, modified_at = now() WHERE id = ${caseId}`.execute(this.db);
  }

  private async onStatusChanged(caseId: string, newStatus: string, data: Record<string, unknown>): Promise<void> {
    const settings = await this.settings.settings();
    if (!settings.features.sla) return;
    const policy = await this.resolvePolicy(data);
    if (policy === null) return;
    const pause =
      (newStatus === "Pending Customer" && policy.pauseOnCustomer) ||
      (newStatus === "Pending Internal" && policy.pauseOnInternal);
    if (pause) await this.pauseClocks(caseId);
    else await this.resumeClocks(caseId);
    await this.recomputeCaseState(caseId);
  }

  private async pauseClocks(caseId: string): Promise<void> {
    const pausedAt = new Date().toISOString();
    await sql`UPDATE entity_records SET attrs = attrs || ${JSON.stringify({ status: "paused", pausedAt })}::jsonb, modified_at = now()
      WHERE entity_type = 'CaseSLAClock' AND deleted_at IS NULL AND (attrs ->> 'caseId') = ${caseId}
        AND (attrs ->> 'status') IN ('onTrack','warning')
        AND (attrs ->> 'pausedAt') IS NULL`.execute(this.db);
  }

  /**
   * Resume each paused clock by *shifting its deadline* by the business minutes spent paused, and
   * keep that duration on the clock. The pause interval therefore stays inspectable and the
   * original target is not silently shortened (§5.6 "pause intervals/state").
   */
  private async resumeClocks(caseId: string): Promise<void> {
    const rows = await this.db
      .selectFrom("entity_records")
      .select(["id", "attrs"])
      .where("entity_type", "=", "CaseSLAClock")
      .where("deleted_at", "is", null)
      .where(sql`attrs ->> 'caseId'`, "=", caseId)
      .where(sql`attrs ->> 'status'`, "=", "paused")
      .execute();
    if (rows.length === 0) return;
    const calendars = new Map<string, BusinessCalendar | null>();
    const now = new Date();
    for (const row of rows) {
      const a = (row.attrs ?? {}) as Record<string, unknown>;
      const pausedAt = a["pausedAt"] ? new Date(String(a["pausedAt"])) : null;
      const dueAt = a["dueAt"] ? new Date(String(a["dueAt"])) : null;
      const calendar = await this.calendarFor(a, calendars);
      const pausedBusiness = pausedAt === null ? 0 : this.businessMinutesBetween(pausedAt, now, calendar);
      const prior = typeof a["totalPausedBusinessMinutes"] === "number" ? (a["totalPausedBusinessMinutes"] as number) : 0;
      const nextDue = dueAt === null ? null : this.addBusinessMinutes(dueAt, pausedBusiness, calendar);
      await sql`UPDATE entity_records SET attrs = attrs || ${JSON.stringify({
        status: "onTrack",
        pausedAt: null,
        resumedAt: now.toISOString(),
        totalPausedBusinessMinutes: prior + pausedBusiness,
        ...(nextDue !== null ? { dueAt: nextDue.toISOString() } : {}),
      })}::jsonb, modified_at = now() WHERE id = ${String(row.id)}`.execute(this.db);
    }
  }

  private async calendarFor(
    attrs: Record<string, unknown>,
    cache: Map<string, BusinessCalendar | null>,
  ): Promise<BusinessCalendar | null> {
    const calendarId = typeof attrs["calendarId"] === "string" ? (attrs["calendarId"] as string) : null;
    const key = calendarId ?? "";
    if (cache.has(key)) return cache.get(key) ?? null;
    const calendar = await this.loadCalendar(calendarId);
    cache.set(key, calendar);
    return calendar;
  }

  private async recomputeCaseState(caseId: string): Promise<void> {
    const rows = await this.db
      .selectFrom("entity_records")
      .select("attrs")
      .where("entity_type", "=", "CaseSLAClock")
      .where("deleted_at", "is", null)
      .where(sql`attrs ->> 'caseId'`, "=", caseId)
      .execute();
    let state: "onTrack" | "warning" | "breached" | "paused" | "met" | "notApplicable" = "met";
    for (const r of rows) {
      const a = (r.attrs ?? {}) as Record<string, unknown>;
      const s = String(a["status"] ?? "onTrack");
      if (s === "breached") { state = "breached"; break; }
      if (s === "warning") state = "warning";
      if (s === "paused" && state === "met") state = "paused";
      if (s === "onTrack" && state === "met") state = "onTrack";
    }
    if (rows.length === 0) state = "notApplicable";
    await this.setCaseSlaState(caseId, state, null, null);
  }

  /**
   * Mark clocks that reached a configured warning threshold or passed their business-time
   * deadline. Paused clocks are skipped: a pause must never breach a target (§5.6). The scan is
   * bounded and returns `truncated` when more clocks remain for the next tick.
   */
  async checkBreaches(): Promise<{ checked: number; breached: number; warned: number; truncated: boolean }> {
    const settings = await this.settings.settings();
    if (!settings.features.sla) return { checked: 0, breached: 0, warned: 0, truncated: false };
    const now = new Date();
    const rows = await this.db
      .selectFrom("entity_records")
      .select(["id", "attrs"])
      .where("entity_type", "=", "CaseSLAClock")
      .where("deleted_at", "is", null)
      .limit(SLA_SCAN_BATCH_SIZE + 1)
      .execute();
    const truncated = rows.length > SLA_SCAN_BATCH_SIZE;
    const clocks = truncated ? rows.slice(0, SLA_SCAN_BATCH_SIZE) : rows;
    const calendars = new Map<string, BusinessCalendar | null>();
    let checked = 0;
    let breached = 0;
    let warned = 0;
    for (const r of clocks) {
      const a = (r.attrs ?? {}) as Record<string, unknown>;
      const status = String(a["status"] ?? "");
      if (status === "met" || status === "breached" || status === "paused") continue;
      const due = a["dueAt"] ? new Date(String(a["dueAt"])) : null;
      if (due === null) continue;
      checked += 1;
      const calendar = await this.calendarFor(a, calendars);
      const progress = this.clockProgress(a, calendar, now);
      if (now.getTime() >= due.getTime()) {
        await sql`UPDATE entity_records SET attrs = attrs || ${JSON.stringify({
          status: "breached",
          breachedAt: now.toISOString(),
          elapsedMinutes: progress.elapsedBusinessMinutes,
        })}::jsonb, modified_at = now() WHERE id = ${String(r.id)}`.execute(this.db);
        breached += 1;
        const caseId = String(a["caseId"] ?? "");
        if (caseId) {
          await this.setCaseSlaState(caseId, "breached", null, null);
          await runInTransaction(this.database.db, async (tx) => {
            await this.events.dispatchMany(tx, [{ type: "serviceDesk.case.slaBreached", payload: { caseId, clockId: String(r.id) } }]);
          });
        }
        continue;
      }
      const thresholds = this.warningThresholdsOf(a);
      if (thresholds.some((threshold) => progress.percent * 100 >= threshold) && status !== "warning") {
        await sql`UPDATE entity_records SET attrs = attrs || ${JSON.stringify({
          status: "warning",
          elapsedMinutes: progress.elapsedBusinessMinutes,
        })}::jsonb, modified_at = now() WHERE id = ${String(r.id)}`.execute(this.db);
        warned += 1;
        const caseId = String(a["caseId"] ?? "");
        if (caseId) await this.setCaseSlaState(caseId, "warning", null, null);
      }
    }
    return { checked, breached, warned, truncated };
  }

  /**
   * The scheduled SLA pass (§5.7, §12.1): warning/breach state, deduplicated notifications,
   * escalation for active cases only, and Knowledge Base expiry. A retry creates no duplicate
   * notification because a clock records the thresholds it fired and its breach notification flag.
   */
  async runScheduledCheck(): Promise<{
    checked: number;
    breached: number;
    warned: number;
    notified: number;
    escalated: number;
    expiredArticles: number;
    truncated: boolean;
  }> {
    const settings = await this.settings.settings();
    if (!settings.features.sla) {
      const expiredArticles = await this.knowledgeBase.expireDueArticles().catch(() => 0);
      return { checked: 0, breached: 0, warned: 0, notified: 0, escalated: 0, expiredArticles, truncated: false };
    }
    const breachResult = await this.checkBreaches();
    const now = new Date();
    const rows = await this.db
      .selectFrom("entity_records")
      .select(["id", "attrs"])
      .where("entity_type", "=", "CaseSLAClock")
      .where("deleted_at", "is", null)
      .limit(SLA_SCAN_BATCH_SIZE + 1)
      .execute();
    const clocks = rows.length > SLA_SCAN_BATCH_SIZE ? rows.slice(0, SLA_SCAN_BATCH_SIZE) : rows;
    const calendars = new Map<string, BusinessCalendar | null>();
    const caseCache = new Map<string, Awaited<ReturnType<SlaService["loadCase"]>>>();
    const watcherCache = new Map<string, readonly string[]>();
    let notified = 0;
    let escalated = 0;

    for (const r of clocks) {
      const a = (r.attrs ?? {}) as Record<string, unknown>;
      const caseId = String(a["caseId"] ?? "");
      if (caseId === "") continue;
      const clockId = String(r.id);
      const status = String(a["status"] ?? "");
      if (status !== "warning" && status !== "breached") continue;

      if (!caseCache.has(caseId)) caseCache.set(caseId, await this.loadCase(caseId));
      const caseRow = caseCache.get(caseId) ?? null;
      const caseActive =
        caseRow !== null &&
        !TERMINAL_CASE_STATUSES.has(caseRow.status) &&
        (caseRow.mergedIntoCaseId === null || caseRow.mergedIntoCaseId === "");
      const calendar = await this.calendarFor(a, calendars);
      const progress = this.clockProgress(a, calendar, now);
      const fired = Array.isArray(a["firedWarnings"]) ? (a["firedWarnings"] as number[]) : [];

      if (status === "warning" && caseActive) {
        const pending = this.warningThresholdsOf(a).filter(
          (threshold) => !fired.includes(threshold) && progress.percent * 100 >= threshold,
        );
        if (pending.length > 0) {
          if (!watcherCache.has(caseId)) watcherCache.set(caseId, await this.caseWatchers(caseId));
          for (const threshold of pending) {
            for (const userId of watcherCache.get(caseId) ?? []) {
              notified += await this.notifications
                .slaWarning({
                  userId,
                  caseId,
                  caseNumber: caseRow?.caseNumber ?? null,
                  subject: caseRow?.name ?? null,
                  clockId,
                  targetType: String(a["targetType"] ?? ""),
                  kind: "warning",
                  dedupKey: `sla-warning:${clockId}:${String(threshold)}`,
                })
                .then(() => 1)
                .catch(() => 0);
            }
          }
          await sql`UPDATE entity_records SET attrs = attrs || ${JSON.stringify({
            firedWarnings: [...new Set([...fired, ...pending])],
          })}::jsonb, modified_at = now() WHERE id = ${clockId}`.execute(this.db);
        }
      }

      if (status === "breached" && a["breachNotified"] !== true) {
        if (caseActive) {
          if (!watcherCache.has(caseId)) watcherCache.set(caseId, await this.caseWatchers(caseId));
          for (const userId of watcherCache.get(caseId) ?? []) {
            notified += await this.notifications
              .slaBreach({
                userId,
                caseId,
                caseNumber: caseRow?.caseNumber ?? null,
                subject: caseRow?.name ?? null,
                clockId,
                targetType: String(a["targetType"] ?? ""),
                kind: "breach",
                dedupKey: `sla-breach:${clockId}`,
              })
              .then(() => 1)
              .catch(() => 0);
          }
          if (a["escalated"] !== true) {
            await sql`UPDATE entity_records SET attrs = attrs || ${JSON.stringify({ isEscalated: true, escalationLevel: 1, escalatedAt: now.toISOString() })}::jsonb, modified_at = now() WHERE id = ${caseId}`.execute(this.db);
            escalated += 1;
          }
        }
        // Mark the clock whether or not the case was still active: a closed or merged case must not
        // be re-notified on every tick (§5.7 "avoid escalating a resolved/closed/merged case").
        await sql`UPDATE entity_records SET attrs = attrs || '{"breachNotified":true,"escalated":true}'::jsonb, modified_at = now() WHERE id = ${clockId}`.execute(this.db);
      }
    }

    await this.settings.recordScanAt(now.toISOString()).catch(() => undefined);
    const expiredArticles = await this.knowledgeBase.expireDueArticles().catch(() => 0);
    return {
      checked: breachResult.checked,
      breached: breachResult.breached,
      warned: breachResult.warned,
      notified,
      escalated,
      expiredArticles,
      truncated: breachResult.truncated || rows.length > SLA_SCAN_BATCH_SIZE,
    };
  }

  /** Business minutes elapsed and the fraction of the target used, honouring pause bookkeeping. */
  private clockProgress(
    attrs: Record<string, unknown>,
    calendar: BusinessCalendar | null,
    now: Date,
  ): { totalBusinessMinutes: number; elapsedBusinessMinutes: number; percent: number } {
    const start = attrs["startAt"] ? new Date(String(attrs["startAt"])) : null;
    const due = attrs["dueAt"] ? new Date(String(attrs["dueAt"])) : null;
    if (start === null || due === null) return { totalBusinessMinutes: 0, elapsedBusinessMinutes: 0, percent: 0 };
    const total = Math.max(0, this.businessMinutesBetween(start, due, calendar));
    const paused =
      typeof attrs["totalPausedBusinessMinutes"] === "number" ? (attrs["totalPausedBusinessMinutes"] as number) : 0;
    const elapsed = Math.max(0, this.businessMinutesBetween(start, now, calendar) - paused);
    const percent =
      total > 0 ? elapsed / total : now.getTime() >= due.getTime() ? 1 : 0;
    return { totalBusinessMinutes: total, elapsedBusinessMinutes: elapsed, percent };
  }

  private warningThresholdsOf(attrs: Record<string, unknown>): number[] {
    const raw = attrs["warningThresholds"];
    if (Array.isArray(raw)) {
      const values = raw.map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0);
      if (values.length > 0) return values;
    }
    return [...DEFAULT_WARNING_THRESHOLDS];
  }

  private async caseWatchers(caseId: string): Promise<string[]> {
    const caseRow = await this.loadCase(caseId);
    const set = new Set<string>();
    if (caseRow?.assignedUserId) set.add(caseRow.assignedUserId);
    const followers = await this.records.followerIds("Case", caseId);
    for (const f of followers) set.add(f);
    if (set.size === 0) return [];
    const active = await this.records.activeUserIds([...set]);
    return [...active];
  }

  private async loadCase(caseId: string): Promise<{
    caseNumber: string | null;
    name: string | null;
    assignedUserId: string | null;
    status: string;
    mergedIntoCaseId: string | null;
  } | null> {
    const row = await this.db
      .selectFrom("entity_records")
      .select("attrs")
      .where("entity_type", "=", CASE_ENTITY)
      .where("id", "=", caseId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (row === undefined) return null;
    const a = (row.attrs ?? {}) as Record<string, unknown>;
    return {
      caseNumber: typeof a["caseNumber"] === "string" ? (a["caseNumber"] as string) : null,
      name: typeof a["name"] === "string" ? (a["name"] as string) : null,
      assignedUserId: typeof a["assignedUserId"] === "string" ? (a["assignedUserId"] as string) : null,
      status: typeof a["status"] === "string" ? (a["status"] as string) : "New",
      mergedIntoCaseId: typeof a["mergedIntoCaseId"] === "string" ? (a["mergedIntoCaseId"] as string) : null,
    };
  }
}

/** Weekday names `Intl` returns for `weekday: 'short'`, mapped to the calendar's `0..6` keys. */
const WEEKDAY_INDEX: Readonly<Record<string, number>> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const ZONED_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

/**
 * Local calendar fields for an instant in an IANA time zone. `Intl` accounts for daylight-saving
 * transitions, which is why the SLA calculator evaluates calendars through it rather than reading
 * UTC getters (§5.6). An invalid time zone falls back to UTC instead of breaking the scan.
 */
function zonedParts(date: Date, timeZone: string): { weekday: number; hour: number; minute: number; dateKey: string } {
  let formatter = ZONED_FORMATTERS.get(timeZone);
  if (formatter === undefined) {
    try {
      formatter = new Intl.DateTimeFormat("en-US", {
        timeZone,
        weekday: "short",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      });
    } catch {
      formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: "UTC",
        weekday: "short",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      });
    }
    ZONED_FORMATTERS.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(date);
  const lookup = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? "";
  const year = lookup("year");
  const month = lookup("month");
  const day = lookup("day");
  const rawHour = Number(lookup("hour"));
  return {
    weekday: WEEKDAY_INDEX[lookup("weekday")] ?? 0,
    hour: rawHour === 24 ? 0 : rawHour,
    minute: Number(lookup("minute")),
    dateKey: `${year}-${month}-${day}`,
  };
}

