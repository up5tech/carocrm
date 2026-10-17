import { Inject, Injectable, type OnApplicationBootstrap } from "@nestjs/common";
import { sql } from "kysely";

import { DatabaseService } from "../database/database.service.js";
import type { AfterSaveHook, AfterSaveHookArgs } from "../entity/hooks.js";
import { KERNEL_HOOKS_TOKEN } from "../entity/hooks.js";
import { currentTx, runInTransaction } from "../entity/tx-context.js";
import { EventBus } from "../events/event-bus.js";
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

@Injectable()
export class SlaService implements OnApplicationBootstrap {
  constructor(
    @Inject(ServiceDeskSettingsService) private readonly settings: ServiceDeskSettingsService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(KERNEL_HOOKS_TOKEN) private readonly kernelHooks: AfterSaveHook[],
    @Inject(ServiceDeskNotificationService) private readonly notifications: ServiceDeskNotificationService,
    @Inject(ServiceDeskRecords) private readonly records: ServiceDeskRecords,
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
        else await this.onStatusChanged(String(args.record.id), newStatus, data);
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

  addBusinessMinutes(start: Date, minutes: number, calendar: BusinessCalendar | null): Date {
    if (minutes <= 0) return new Date(start);
    if (calendar === null || Object.keys(calendar.intervals).length === 0) {
      return new Date(start.getTime() + minutes * 60_000);
    }
    let cursor = new Date(start);
    let remaining = minutes;
    let guard = 0;
    while (remaining > 0 && guard < 200_000) {
      guard += 1;
      if (this.isBusinessMinute(cursor, calendar)) {
        remaining -= 1;
      }
      cursor = new Date(cursor.getTime() + 60_000);
    }
    return cursor;
  }

  private isBusinessMinute(d: Date, calendar: BusinessCalendar): boolean {
    const dateKey = d.toISOString().slice(0, 10);
    if (calendar.holidays.has(dateKey)) return false;
    const slots = calendar.intervals[String(d.getUTCDay())];
    if (!slots || slots.length === 0) return false;
    const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
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

  private async createClock(caseId: string, targetType: string, policy: SLAPolicy, minutes: number, start: Date, calendar: BusinessCalendar | null): Promise<void> {
    if (minutes <= 0) return;
    const due = this.addBusinessMinutes(start, minutes, calendar);
    const id = `slc_${caseId}_${targetType}_${Date.now().toString(36)}`;
    await sql`INSERT INTO entity_records (id, entity_type, attrs, version, created_at, modified_at)
      VALUES (${id}, 'CaseSLAClock', ${JSON.stringify({
        name: `${targetType} clock`,
        caseId,
        targetType,
        policyId: policy.id,
        policyVersion: policy.version,
        startAt: start.toISOString(),
        dueAt: due.toISOString(),
        elapsedMinutes: 0,
        status: "onTrack",
        cycle: 1,
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
    for (const r of rows) {
      const a = (r.attrs ?? {}) as Record<string, unknown>;
      const st = String(a["status"] ?? "");
      if (st !== "onTrack" && st !== "warning" && st !== "paused") continue;
      await sql`UPDATE entity_records SET attrs = attrs || '{"status":"met"}'::jsonb, modified_at = now() WHERE id = ${String(r.id)}`.execute(this.db);
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
    if (newStatus === "Pending Customer" && policy.pauseOnCustomer) {
      await sql`UPDATE entity_records SET attrs = attrs || '{"status":"paused"}'::jsonb, modified_at = now()
        WHERE entity_type = 'CaseSLAClock' AND deleted_at IS NULL AND (attrs ->> 'caseId') = ${caseId}
          AND (attrs ->> 'status') IN ('onTrack','warning')`.execute(this.db);
    } else if (newStatus === "Pending Internal" && policy.pauseOnInternal) {
      await sql`UPDATE entity_records SET attrs = attrs || '{"status":"paused"}'::jsonb, modified_at = now()
        WHERE entity_type = 'CaseSLAClock' AND deleted_at IS NULL AND (attrs ->> 'caseId') = ${caseId}
          AND (attrs ->> 'status') IN ('onTrack','warning')`.execute(this.db);
    } else {
      await sql`UPDATE entity_records SET attrs = attrs || '{"status":"onTrack"}'::jsonb, modified_at = now()
        WHERE entity_type = 'CaseSLAClock' AND deleted_at IS NULL AND (attrs ->> 'caseId') = ${caseId}
          AND (attrs ->> 'status') = 'paused'`.execute(this.db);
    }
    await this.recomputeCaseState(caseId);
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

  async checkBreaches(): Promise<{ checked: number; breached: number; warned: number }> {
    const settings = await this.settings.settings();
    if (!settings.features.sla) return { checked: 0, breached: 0, warned: 0 };
    const now = new Date();
    const rows = await this.db
      .selectFrom("entity_records")
      .select(["id", "attrs"])
      .where("entity_type", "=", "CaseSLAClock")
      .where("deleted_at", "is", null)
      .execute();
    let checked = 0;
    let breached = 0;
    let warned = 0;
    for (const r of rows) {
      const a = (r.attrs ?? {}) as Record<string, unknown>;
      const status = String(a["status"] ?? "");
      if (status === "met" || status === "breached") continue;
      checked += 1;
      const due = a["dueAt"] ? new Date(String(a["dueAt"])) : null;
      if (due === null) continue;
      if (now.getTime() > due.getTime()) {
        await sql`UPDATE entity_records SET attrs = attrs || '{"status":"breached"}'::jsonb, modified_at = now() WHERE id = ${String(r.id)}`.execute(this.db);
        breached += 1;
        const caseId = String(a["caseId"] ?? "");
        if (caseId) {
          await this.setCaseSlaState(caseId, "breached", null, null);
          await runInTransaction(this.database.db, async (tx) => {
            await this.events.dispatchMany(tx, [{ type: "serviceDesk.case.slaBreached", payload: { caseId, clockId: String(r.id) } }]);
          });
        }
      } else {
        const start = a["startAt"] ? new Date(String(a["startAt"])) : null;
        if (start !== null) {
          const total = due.getTime() - start.getTime();
          const elapsed = now.getTime() - start.getTime();
          const pct = total > 0 ? elapsed / total : 0;
          if (pct >= 0.75) {
            await sql`UPDATE entity_records SET attrs = attrs || '{"status":"warning"}'::jsonb, modified_at = now() WHERE id = ${String(r.id)}`.execute(this.db);
            warned += 1;
            const caseId = String(a["caseId"] ?? "");
            if (caseId) await this.setCaseSlaState(caseId, "warning", null, null);
          }
        }
      }
    }
    return { checked, breached, warned };
  }

  async runScheduledCheck(): Promise<{ checked: number; breached: number; warned: number; notified: number; escalated: number }> {
    const settings = await this.settings.settings();
    if (!settings.features.sla) return { checked: 0, breached: 0, warned: 0, notified: 0, escalated: 0 };
    const breachResult = await this.checkBreaches();
    let notified = 0;
    let escalated = 0;
    const rows = await this.db
      .selectFrom("entity_records")
      .select(["id", "attrs"])
      .where("entity_type", "=", "CaseSLAClock")
      .where("deleted_at", "is", null)
      .execute();
    for (const r of rows) {
      const a = (r.attrs ?? {}) as Record<string, unknown>;
      const caseId = String(a["caseId"] ?? "");
      if (caseId === "") continue;
      const clockId = String(r.id);
      const status = String(a["status"] ?? "");
      const fired = Array.isArray(a["firedWarnings"]) ? (a["firedWarnings"] as number[]) : [];
      const breachNotified = a["breachNotified"] === true;
      const escalatedFlag = a["escalated"] === true;

      if (status === "warning" && !fired.includes(75)) {
        const recipients = await this.caseWatchers(caseId);
        const caseRow = await this.loadCase(caseId);
        for (const userId of recipients) {
          await this.notifications.slaWarning({
            userId,
            caseId,
            caseNumber: caseRow?.caseNumber ?? null,
            subject: caseRow?.name ?? null,
            clockId,
            targetType: String(a["targetType"] ?? ""),
            kind: "warning",
            dedupKey: `sla-warning:${clockId}:75`,
          }).catch(() => undefined);
          notified += 1;
        }
        await sql`UPDATE entity_records SET attrs = attrs || '{"firedWarnings":[75]}'::jsonb, modified_at = now() WHERE id = ${clockId}`.execute(this.db);
      }

      if (status === "breached" && !breachNotified) {
        const recipients = await this.caseWatchers(caseId);
        const caseRow = await this.loadCase(caseId);
        for (const userId of recipients) {
          await this.notifications.slaBreach({
            userId,
            caseId,
            caseNumber: caseRow?.caseNumber ?? null,
            subject: caseRow?.name ?? null,
            clockId,
            targetType: String(a["targetType"] ?? ""),
            kind: "breach",
            dedupKey: `sla-breach:${clockId}`,
          }).catch(() => undefined);
          notified += 1;
        }
        if (!escalatedFlag) {
          await sql`UPDATE entity_records SET attrs = attrs || ${JSON.stringify({ isEscalated: true, escalationLevel: 1, escalatedAt: new Date().toISOString() })}::jsonb, modified_at = now() WHERE id = ${caseId}`.execute(this.db);
          escalated += 1;
        }
        await sql`UPDATE entity_records SET attrs = attrs || '{"breachNotified":true,"escalated":true}'::jsonb, modified_at = now() WHERE id = ${clockId}`.execute(this.db);
      }
    }

    try {
      const current = await this.settings.settings();
      await this.settings.update({ sla: { ...current.sla, lastScanAt: new Date().toISOString() } });
    } catch {
      // best effort
    }
    return { checked: breachResult.checked, breached: breachResult.breached, warned: breachResult.warned, notified, escalated };
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

  private async loadCase(caseId: string): Promise<{ caseNumber: string | null; name: string | null; assignedUserId: string | null } | null> {
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
    };
  }
}

