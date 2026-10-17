import {
  AuthorizationDeniedError,
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
import { runAsServiceDeskSystem } from "./service-desk-authority.js";
import {
  allowedCaseCommands,
  CASE_ENTITY,
  type CaseStatus,
  type CaseTransitionCommand,
  checkCaseTransition,
  checkResolutionRequirement,
  commandTargetStatus,
} from "./service-desk-domain.js";
import { runAsServiceDeskInternal } from "./service-desk-internal.js";
import { ServiceDeskRecords } from "./service-desk-records.js";
import { ServiceDeskSettingsService } from "./service-desk-settings.service.js";

/**
 * Phase 19-SD.4 — the `Case` state machine and resolution workflow
 * (PLAN_Phase_19_ServiceDesk.md §5.2, §7.1 `CaseCommandService`, §7.2–§7.5).
 *
 * Every status move is a server-side command, never a bare field write: `status` is editable through
 * the record API only as far as the write guard allows, and the transitions an agent may run are the
 * ones this service declares. A command validates the source state, the target, the actor's record
 * permission, the resolution requirement and the reopen policy, then in one transaction writes the
 * case, appends a `CaseTransition` history row (reason and command, which generic audit cannot
 * express) and enqueues the domain events. A failure anywhere rolls the whole thing back, so an
 * invalid transition can never partially update a record (§5.2, acceptance criteria).
 *
 * Reopening never erases a prior resolution: `resolvedAt`/`closedAt` are historical facts, kept
 * intact, and the closed cycle remains in `CaseTransition`; `status` is what says the case is live
 * again. That is what makes prior resolution/reopen cycles auditable (§5.2).
 */

export interface CaseTransitionRequest {
  readonly command?: CaseTransitionCommand | undefined;
  readonly to?: CaseStatus | undefined;
  readonly reason?: string | undefined;
  readonly resolutionCode?: string | undefined;
  readonly resolutionSummary?: string | undefined;
  readonly idempotencyKey?: string | undefined;
  readonly version?: number | undefined;
}

export interface CaseTransitionResult {
  readonly caseId: string;
  readonly from: CaseStatus;
  readonly to: CaseStatus;
  readonly command: CaseTransitionCommand | "setStatus";
  readonly changed: boolean;
  readonly idempotent: boolean;
  readonly transitionId: string | null;
}

export interface CaseCapabilities {
  readonly caseId: string;
  readonly status: CaseStatus;
  readonly allowedCommands: readonly CaseTransitionCommand[];
  readonly resolution: {
    readonly requireCode: boolean;
    readonly requireSummary: boolean;
    readonly codes: readonly string[];
  };
}

export interface CaseTransitionView {
  readonly id: string;
  readonly caseId: string;
  readonly fromStatus: string;
  readonly toStatus: string;
  readonly command: string;
  readonly reason: string | null;
  readonly resolutionCode: string | null;
  readonly actorUserId: string | null;
  readonly actorType: string;
  readonly occurredAt: string | null;
}

@Injectable()
export class CaseLifecycleService {
  constructor(
    @Inject(ServiceDeskRecords) private readonly records: ServiceDeskRecords,
    @Inject(EntityCrudService) private readonly entities: EntityCrudService,
    @Inject(ServiceDeskSettingsService) private readonly settings: ServiceDeskSettingsService,
    @Inject(AclApiService) private readonly acl: AclApiService,
    @Inject(EventBus) private readonly events: EventBus,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  /** The status moves the current actor may run on this case — the server's answer the SPA renders. */
  async capabilities(caseId: string): Promise<CaseCapabilities> {
    const record = await this.entities.get(CASE_ENTITY, caseId);
    const status = isStatus(record["status"]) ? record["status"] : "New";
    const settings = await this.settings.settings();
    const decision = await this.acl.canAccessRecord(CASE_ENTITY, "edit", {
      id: caseId,
      assignedUserId: typeof record["assignedUserId"] === "string" ? (record["assignedUserId"] as string) : undefined,
      createdById: typeof record["createdById"] === "string" ? (record["createdById"] as string) : undefined,
      teams: Array.isArray(record["teams"]) ? (record["teams"] as string[]) : [],
      data: record,
    });
    return {
      caseId,
      status,
      allowedCommands: decision.allowed === true ? allowedCaseCommands(status) : [],
      resolution: {
        requireCode: settings.resolution.requireCode,
        requireSummary: settings.resolution.requireSummary,
        codes: settings.resolution.codes,
      },
    };
  }

  /** The status-transition history of a case, oldest first, for the audit/history panel. */
  async history(caseId: string): Promise<{ list: CaseTransitionView[] }> {
    // Read access is enforced by loading the case through the ACL-aware entity service.
    await this.entities.get(CASE_ENTITY, caseId);
    const rows = await this.records.find("CaseTransition", { caseId });
    const list = rows
      .map((row) => toTransitionView(row.id, row.data))
      .sort((left, right) => (left.occurredAt ?? "").localeCompare(right.occurredAt ?? ""));
    return { list };
  }

  /** Run one named transition command (`resolve`, `close`, `reopen`, …). */
  async run(
    caseId: string,
    command: CaseTransitionCommand,
    request: Omit<CaseTransitionRequest, "command" | "to"> = {},
  ): Promise<CaseTransitionResult> {
    return this.transition(caseId, { ...request, command });
  }

  async transition(caseId: string, request: CaseTransitionRequest): Promise<CaseTransitionResult> {
    const actor = this.scope.requirePrincipal();
    const settings = await this.settings.settings();
    if (!settings.features.caseManagement) throw new FeatureDisabledError("caseManagement");

    const row = await this.records.byId(CASE_ENTITY, caseId);
    if (row === undefined) throw new NotFoundError(`Case "${caseId}" does not exist.`);
    // A transition is a write on this record. Entity-level edit alone is not enough: the actor's
    // record scope (own/team/project) and principal type must allow it (§5.2, §10.2).
    await this.acl.assertRecordAccess(CASE_ENTITY, "edit", {
      id: caseId,
      assignedUserId: text(row.data["assignedUserId"]) ?? undefined,
      createdById: text(row.data["createdById"]) ?? undefined,
      teams: Array.isArray(row.data["teams"]) ? (row.data["teams"] as string[]) : [],
      data: row.data,
    });

    const from: CaseStatus = isStatus(row.data["status"]) ? row.data["status"] : "New";
    const command = request.command;
    const to = command !== undefined ? commandTargetStatus(command) : request.to;
    if (to === undefined) {
      throw new ValidationError("A transition needs a command or a target status.", { caseId });
    }
    if (command !== undefined && request.to !== undefined && request.to !== to) {
      throw new ValidationError(
        `Command "${command}" moves a case to "${to}", not "${request.to}".`,
        { code: "CASE_TRANSITION_NOT_ALLOWED", caseId, from, to: request.to },
      );
    }
    const check = checkCaseTransition({ from, to, ...(command !== undefined ? { command } : {}) });
    if (!check.allowed) {
      throw new ValidationError(check.message ?? "Invalid case transition.", {
        code: check.code ?? "CASE_TRANSITION_NOT_ALLOWED",
        caseId,
        from,
        to,
      });
    }

    const idempotencyKey = request.idempotencyKey?.trim();
    if (idempotencyKey !== undefined && idempotencyKey !== "") {
      const prior = await this.records.find("CaseTransition", { caseId, idempotencyKey }, { limit: 1 });
      const existing = prior[0];
      if (existing !== undefined) {
        return {
          caseId,
          from,
          to: isStatus(existing.data["toStatus"]) ? existing.data["toStatus"] : to,
          command: command ?? "setStatus",
          changed: false,
          idempotent: true,
          transitionId: existing.id,
        };
      }
    }

    // A no-op transition is allowed and changes nothing (§5.2 "a state change ... committed atomically").
    if (from === to) {
      return { caseId, from, to, command: command ?? "setStatus", changed: false, idempotent: false, transitionId: null };
    }

    await this.assertReopenAllowed(caseId, from, to, settings.resolution.reopenWindowDays, row.data["resolvedAt"]);

    const resolutionCode = request.resolutionCode ?? text(row.data["resolutionCode"]);
    const resolutionSummary = request.resolutionSummary ?? text(row.data["resolutionSummary"]);
    if (to === "Resolved") {
      const problem = checkResolutionRequirement({
        resolutionCode,
        resolutionSummary,
        requireCode: settings.resolution.requireCode,
        requireSummary: settings.resolution.requireSummary,
        codes: settings.resolution.codes,
      });
      if (problem !== undefined) {
        throw new ValidationError(problem, { code: "CASE_RESOLUTION_REQUIRED", caseId });
      }
    }

    const now = new Date();
    const patch = buildPatch({ from, to, command, now, resolutionCode, resolutionSummary, actorUserId: actor.userId, existingLevel: numeric(row.data["escalationLevel"]) });
    const events = transitionEvents({
      caseId,
      caseNumber: text(row.data["caseNumber"]) ?? null,
      from,
      to,
      command: command ?? "setStatus",
      actorUserId: actor.userId,
      actorType: actor.userType,
    });

    const transitionId = await runInTransaction(this.database.db, async (tx) => {
      await runAsServiceDeskInternal(() =>
        this.entities.update(CASE_ENTITY, caseId, {
          ...patch,
          ...(request.version !== undefined ? { version: request.version } : {}),
        }),
      );
      const history = await runAsServiceDeskSystem(this.scope, "caseTransitionHistory", () =>
        this.entities.create("CaseTransition", {
          caseId,
          caseNumber: text(row.data["caseNumber"]) ?? null,
          fromStatus: from,
          toStatus: to,
          command: command ?? "setStatus",
          reason: request.reason?.trim() || null,
          resolutionCode: to === "Resolved" ? resolutionCode ?? null : null,
          resolutionSummary: to === "Resolved" ? resolutionSummary ?? null : null,
          actorUserId: actor.userId,
          actorType: actor.userType,
          occurredAt: now.toISOString(),
          idempotencyKey: idempotencyKey ?? null,
        }),
      );
      await this.events.dispatchMany(tx, events);
      return String(history["id"]);
    });

    return { caseId, from, to, command: command ?? "setStatus", changed: true, idempotent: false, transitionId };
  }

  private async assertReopenAllowed(
    caseId: string,
    from: CaseStatus,
    to: CaseStatus,
    reopenWindowDays: number,
    resolvedAtValue: unknown,
  ): Promise<void> {
    if (to !== "Open" || (from !== "Resolved" && from !== "Closed" && from !== "Cancelled")) return;
    if (from === "Closed" || from === "Cancelled") {
      // A terminal case reopens only under a broader permission (§5.2 "controlled administrative reopening").
      const level = this.scope.isAdmin ? "all" : await this.acl.canUser(CASE_ENTITY, "edit");
      if (level !== "all" && level !== "yes") {
        throw new AuthorizationDeniedError("Reopening a closed or cancelled case requires a broader permission.", {
          code: "CASE_TRANSITION_NOT_ALLOWED",
          caseId,
        });
      }
    }
    if (reopenWindowDays <= 0) return;
    const resolvedAt = parseDate(resolvedAtValue);
    if (resolvedAt === undefined) return;
    if (Date.now() - resolvedAt.getTime() > reopenWindowDays * 86_400_000) {
      throw new ValidationError(`The reopen window of ${reopenWindowDays} day(s) has passed.`, {
        code: "CASE_TRANSITION_NOT_ALLOWED",
        caseId,
      });
    }
  }
}

function buildPatch(input: {
  from: CaseStatus;
  to: CaseStatus;
  command: CaseTransitionCommand | undefined;
  now: Date;
  resolutionCode: string | undefined;
  resolutionSummary: string | undefined;
  actorUserId: string;
  existingLevel: number;
}): Record<string, unknown> {
  const { from, to, command, now } = input;
  const patch: Record<string, unknown> = { status: to, lastActivityAt: now.toISOString() };
  if (to === "Resolved") {
    patch["resolvedAt"] = now.toISOString();
    patch["resolvedById"] = input.actorUserId;
    if (input.resolutionCode !== undefined) patch["resolutionCode"] = input.resolutionCode;
    if (input.resolutionSummary !== undefined) patch["resolutionSummary"] = input.resolutionSummary;
  }
  if (to === "Closed") patch["closedAt"] = now.toISOString();
  if (command === "reopen") patch["reopenedAt"] = now.toISOString();
  if (command === "escalate") {
    patch["isEscalated"] = true;
    patch["escalatedAt"] = now.toISOString();
    patch["escalationLevel"] = input.existingLevel > 0 ? input.existingLevel : 1;
  }
  if (command === "deEscalate") patch["isEscalated"] = false;
  // Leaving the Escalated state by any other move means the case is no longer escalated.
  if (from === "Escalated" && command !== "escalate") patch["isEscalated"] = false;
  return patch;
}

function transitionEvents(input: {
  caseId: string;
  caseNumber: string | null;
  from: CaseStatus;
  to: CaseStatus;
  command: string;
  actorUserId: string;
  actorType: string;
}): { type: string; payload: Record<string, unknown> }[] {
  const payload = {
    caseId: input.caseId,
    caseNumber: input.caseNumber,
    from: input.from,
    to: input.to,
    command: input.command,
    actorUserId: input.actorUserId,
    actorType: input.actorType,
    source: "command",
  };
  const events = [{ type: "serviceDesk.case.statusChanged", payload }];
  if (input.to === "Resolved") events.push({ type: "serviceDesk.case.resolved", payload });
  if (input.to === "Closed") events.push({ type: "serviceDesk.case.closed", payload });
  if (input.command === "reopen") events.push({ type: "serviceDesk.case.reopened", payload });
  if (input.command === "escalate") events.push({ type: "serviceDesk.case.escalated", payload });
  return events;
}

function toTransitionView(id: string, data: Record<string, unknown>): CaseTransitionView {
  return {
    id,
    caseId: text(data["caseId"]) ?? "",
    fromStatus: text(data["fromStatus"]) ?? "",
    toStatus: text(data["toStatus"]) ?? "",
    command: text(data["command"]) ?? "",
    reason: text(data["reason"]) ?? null,
    resolutionCode: text(data["resolutionCode"]) ?? null,
    actorUserId: text(data["actorUserId"]) ?? null,
    actorType: text(data["actorType"]) ?? "user",
    occurredAt: text(data["occurredAt"]) ?? null,
  };
}

function isStatus(value: unknown): value is CaseStatus {
  return (
    typeof value === "string" &&
    ["New", "Open", "Pending Customer", "Pending Internal", "Escalated", "Resolved", "Closed", "Cancelled"].includes(value)
  );
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function numeric(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseDate(value: unknown): Date | undefined {
  if (value instanceof Date) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  return undefined;
}
