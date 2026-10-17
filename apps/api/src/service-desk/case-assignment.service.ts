import {
  AuthorizationDeniedError,
  FeatureDisabledError,
  NotFoundError,
  ValidationError,
} from "@carocrm/core/errors/index.js";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";

import { AclApiService } from "../acl/acl-api.service.js";
import { REQUEST_SCOPE_TOKEN, type RequestScope } from "../common/request-scope.js";
import { DatabaseService } from "../database/database.service.js";
import { EntityCrudService } from "../entity/entity.service.js";
import { runInTransaction } from "../entity/tx-context.js";
import { EventBus } from "../events/event-bus.js";
import { runAsServiceDeskSystem } from "./service-desk-authority.js";
import {
  CASE_ENTITY,
  type CaseAssignmentStrategy,
  type CaseFallbackBehavior,
  isCaseAssignmentStrategy,
  isCaseFallbackBehavior,
  leastBusyMember,
  nextRoundRobinMember,
  type RoutingCondition,
  routingConditionsMatch,
} from "./service-desk-domain.js";
import { runAsServiceDeskInternal } from "./service-desk-internal.js";
import { ServiceDeskNotificationService } from "./service-desk-notification.service.js";
import { ServiceDeskRecords, type ServiceDeskRow } from "./service-desk-records.js";
import { ServiceDeskSettingsService } from "./service-desk-settings.service.js";

/**
 * Phase 19-SD.5 — assignment, queues, routing and workload
 * (PLAN_Phase_19_ServiceDesk.md §5.3, §7.1 `CaseAssignmentService`, §7.3).
 *
 * Ownership is a server decision: a case reaches an owner through this service, never by a client
 * writing `assignedUserId` directly (the write guard refuses that). Three paths converge here —
 * manual assignment, queue/team assignment with a strategy, and declarative routing — and all three
 * validate the same facts before writing: the target queue/team/user exists, the user is active, the
 * user is eligible under the target queue or team, and the actor may assign within their scope
 * (§5.3, §10.2).
 *
 * Nothing here evaluates stored code: a routing rule carries validated declarative conditions and is
 * matched in `sortOrder` order, first match wins. When no member is eligible the case is never
 * dropped — it is retained in its queue, or given the configured fallback owner — and the decision is
 * recorded on a `CaseAssignment` row (§5.3, §11.2).
 *
 * Round-robin uses a row-locked cursor on the queue (`SELECT … FOR UPDATE`), so two simultaneous
 * assignments cannot read and write the same "next" value; least-busy counts active cases and is
 * explicitly allowed to be imprecise under concurrency (§5.3, §7.3).
 */

export interface CaseAssignInput {
  readonly assignedUserId?: string | null | undefined;
  readonly teamId?: string | null | undefined;
  readonly queueId?: string | null | undefined;
  readonly strategy?: CaseAssignmentStrategy | undefined;
  readonly reason?: string | undefined;
  readonly idempotencyKey?: string | undefined;
  readonly version?: number | undefined;
}

export interface CaseAssignmentDecision {
  readonly routingRuleId: string | null;
  readonly routingRuleName: string | null;
  readonly queueId: string | null;
  readonly teamId: string | null;
  readonly assignedUserId: string | null;
  readonly strategy: CaseAssignmentStrategy;
  readonly fallbackReason: string | null;
}

export interface CaseAssignmentResult {
  readonly caseId: string;
  readonly assignedUserId: string | null;
  readonly teamId: string | null;
  readonly queueId: string | null;
  readonly strategy: CaseAssignmentStrategy;
  readonly changed: boolean;
  readonly idempotent: boolean;
  readonly warnings: readonly string[];
  readonly assignmentId: string | null;
}

export interface CaseRouteResult extends CaseAssignmentResult {
  readonly decision: CaseAssignmentDecision;
}

export interface CaseAssignmentView {
  readonly id: string;
  readonly caseId: string;
  readonly previousAssignedUserId: string | null;
  readonly assignedUserId: string | null;
  readonly previousTeamId: string | null;
  readonly teamId: string | null;
  readonly queueId: string | null;
  readonly strategy: string;
  readonly routingRuleId: string | null;
  readonly reason: string | null;
  readonly actorUserId: string | null;
  readonly actorType: string;
  readonly occurredAt: string | null;
}

export interface QueueView {
  readonly id: string;
  readonly name: string | null;
  readonly code: string | null;
  readonly strategy: CaseAssignmentStrategy;
  readonly fallbackBehavior: CaseFallbackBehavior;
  readonly defaultTeamId: string | null;
  readonly defaultAssignedUserId: string | null;
  readonly isActive: boolean;
}

export interface QueueWorkload {
  readonly queue: QueueView;
  readonly source: "members" | "team" | "none";
  readonly members: readonly { readonly userId: string; readonly activeCases: number }[];
  readonly unassigned: number;
}

interface Eligibility {
  readonly userIds: readonly string[];
  readonly source: "members" | "team" | "none";
}

interface Target {
  readonly assignedUserId: string | null;
  readonly teamId: string | null;
  readonly queueId: string | null;
}

interface RouteDecision {
  readonly target: Target;
  readonly strategy: CaseAssignmentStrategy;
  readonly routingRuleId: string | null;
  readonly routingRuleName: string | null;
  readonly fallbackReason: string | null;
  readonly summary: CaseAssignmentDecision;
}

@Injectable()
export class CaseAssignmentService {
  constructor(
    @Inject(ServiceDeskRecords) private readonly records: ServiceDeskRecords,
    @Inject(EntityCrudService) private readonly entities: EntityCrudService,
    @Inject(ServiceDeskSettingsService) private readonly settings: ServiceDeskSettingsService,
    @Inject(ServiceDeskNotificationService) private readonly notifications: ServiceDeskNotificationService,
    @Inject(AclApiService) private readonly acl: AclApiService,
    @Inject(EventBus) private readonly events: EventBus,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  /** Whether the current actor may (re)assign this case at all — a hint for the SPA, never the check. */
  async capabilities(caseId: string): Promise<{ readonly caseId: string; readonly canAssign: boolean }> {
    const record = await this.entities.get(CASE_ENTITY, caseId);
    if (await this.isUnrestrictedEdit()) return { caseId, canAssign: true };
    const actorId = this.scope.userId;
    if (actorId === undefined) return { caseId, canAssign: false };
    const actorScope = await this.actorScope(actorId);
    const assignedUserId = text(record["assignedUserId"]);
    return {
      caseId,
      canAssign: actorScope.teamIds.size > 0 || actorScope.queueIds.size > 0 || assignedUserId === actorId,
    };
  }

  /** The assignment history of a case, oldest first. */
  async history(caseId: string): Promise<{ list: CaseAssignmentView[] }> {
    await this.entities.get(CASE_ENTITY, caseId);
    const rows = await this.records.find("CaseAssignment", { caseId });
    const list = rows
      .map((row) => toAssignmentView(row.id, row.data))
      .sort((left, right) => (left.occurredAt ?? "").localeCompare(right.occurredAt ?? ""));
    return { list };
  }

  /** Manual or team assignment (§8.2 `POST /cases/:id/assign`). */
  async assign(caseId: string, input: CaseAssignInput): Promise<CaseAssignmentResult> {
    const settings = await this.settings.settings();
    if (!settings.features.caseManagement) throw new FeatureDisabledError("caseManagement");

    const row = await this.requireCase(caseId);
    const strategy = input.strategy ?? "manual";
    if (!isCaseAssignmentStrategy(strategy)) {
      throw new ValidationError(`Unknown assignment strategy "${String(strategy)}".`, { strategy });
    }

    const queue = await this.resolveQueue(input.queueId);
    let teamId: string | null = input.teamId === undefined ? text(row.data["teamId"]) ?? null : input.teamId;
    if (teamId === null && queue !== undefined) teamId = queue.defaultTeamId;
    await this.validateTeam(teamId);

    let assignedUserId: string | null = input.assignedUserId ?? null;
    if (assignedUserId !== null) {
      await this.validateAgent(assignedUserId, { queueId: queue?.id ?? null, teamId });
    } else if (queue !== undefined && strategy !== "manual") {
      const eligibility = await this.eligibleAgents(queue);
      assignedUserId = (await this.pickByStrategy(queue, eligibility, strategy)) ?? queue.defaultAssignedUserId;
    }

    if (
      input.assignedUserId === undefined &&
      input.queueId === undefined &&
      input.teamId === undefined &&
      assignedUserId === null
    ) {
      throw new ValidationError("An assignment needs a queue, a team or a user.", { caseId });
    }

    const target: Target = {
      assignedUserId,
      teamId,
      queueId: queue?.id ?? (input.queueId === null ? null : text(row.data["queueId"]) ?? null),
    };

    return this.apply(caseId, row, target, {
      strategy,
      routingRuleId: null,
      routingRuleName: null,
      fallbackReason: null,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
      version: input.version,
      routing: false,
    });
  }

  /** Evaluate routing rules for a case and apply the first matching decision, with safe fallback. */
  async route(caseId: string, input: { readonly idempotencyKey?: string | undefined } = {}): Promise<CaseRouteResult> {
    const settings = await this.settings.settings();
    if (!settings.features.caseManagement) throw new FeatureDisabledError("caseManagement");
    if (!settings.features.queues) throw new FeatureDisabledError("queues");

    const row = await this.requireCase(caseId);
    const decision = await this.decideRoute(row, settings.assignment.defaultQueueId);

    const result = await this.apply(caseId, row, decision.target, {
      strategy: decision.strategy,
      routingRuleId: decision.routingRuleId,
      routingRuleName: decision.routingRuleName,
      fallbackReason: decision.fallbackReason,
      reason: decision.fallbackReason === null ? "routing rule matched" : decision.fallbackReason,
      idempotencyKey: input.idempotencyKey,
      version: undefined,
      routing: true,
      decision: decision.summary,
    });
    return { ...result, decision: decision.summary };
  }

  /** Per-agent workload for one queue, for the team-lead workload view (§13.2). */
  async workload(queueId: string): Promise<QueueWorkload> {
    const queueRow = await this.records.byId("CaseQueue", queueId);
    if (queueRow === undefined) throw new NotFoundError(`Queue "${queueId}" does not exist.`);
    const queue = toQueue(queueRow);
    await this.assertWorkloadAccess(queue);
    const eligibility = await this.eligibleAgents(queue);
    const counts = await this.records.activeCaseCounts(eligibility.userIds);
    return {
      queue,
      source: eligibility.source,
      members: eligibility.userIds.map((userId) => ({ userId, activeCases: counts.get(userId) ?? 0 })),
      unassigned: await this.records.countUnassignedInQueue(queueId),
    };
  }

  /** All queues with their member and unassigned counts (administrator/team-lead navigation). */
  async queues(): Promise<{ list: (QueueView & { memberCount: number; unassigned: number })[] }> {
    await this.assertAdminOrReadAll("viewing queues");
    const rows = await this.records.findOrdered("CaseQueue", {}, "sortOrder");
    const list: (QueueView & { memberCount: number; unassigned: number })[] = [];
    for (const row of rows) {
      const queue = toQueue(row);
      const eligibility = await this.eligibleAgents(queue);
      list.push({
        ...queue,
        memberCount: eligibility.userIds.length,
        unassigned: await this.records.countUnassignedInQueue(queue.id),
      });
    }
    return { list };
  }

  // -------------------------------------------------------------------------
  // routing
  // -------------------------------------------------------------------------

  private async decideRoute(row: ServiceDeskRow, defaultQueueId: string | null): Promise<RouteDecision> {
    const rules = await this.records.findOrdered("RoutingRule", { isActive: "true" }, "sortOrder");
    for (const rule of rules) {
      const conditions = parseConditions(rule.data["conditions"]);
      if (conditions === undefined) continue; // An unparseable rule is skipped, never executed.
      if (!routingConditionsMatch(conditions, row.data)) continue;
      return this.decisionForRule(rule, defaultQueueId);
    }
    // No rule matched: fall back to the configured default queue, or retain the case unowned.
    if (defaultQueueId !== null) {
      const queue = await this.records.byId("CaseQueue", defaultQueueId);
      if (queue !== undefined && queue.data["isActive"] !== false) {
        return this.decisionForQueue(queue, {
          routingRuleId: null,
          routingRuleName: null,
          fallbackReason: "no-rule-matched",
        });
      }
    }
    const target: Target = {
      assignedUserId: null,
      teamId: text(row.data["teamId"]) ?? null,
      queueId: text(row.data["queueId"]) ?? null,
    };
    return {
      target,
      strategy: "manual",
      routingRuleId: null,
      routingRuleName: null,
      fallbackReason: "no-rule-matched",
      summary: {
        routingRuleId: null,
        routingRuleName: null,
        queueId: target.queueId,
        teamId: target.teamId,
        assignedUserId: null,
        strategy: "manual",
        fallbackReason: "no-rule-matched",
      },
    };
  }

  private async decisionForRule(rule: ServiceDeskRow, defaultQueueId: string | null): Promise<RouteDecision> {
    const ruleQueueId = text(rule.data["queueId"]) ?? defaultQueueId;
    const ruleTeamId = text(rule.data["teamId"]) ?? null;
    const ruleUserId = text(rule.data["userId"]) ?? null;
    const queue = ruleQueueId === null ? undefined : await this.records.byId("CaseQueue", ruleQueueId);

    // A specific user on the rule wins; else a queue's strategy picks one; else a team holds it.
    if (ruleUserId !== null) {
      const active = await this.records.activeUserIds([ruleUserId]);
      if (active.has(ruleUserId)) {
        const target: Target = {
          assignedUserId: ruleUserId,
          teamId: ruleTeamId ?? (queue === undefined ? null : text(queue.data["defaultTeamId"]) ?? null),
          queueId: ruleQueueId,
        };
        return this.wrapDecision(rule, target, "manual", null);
      }
    }
    if (queue !== undefined && queue.data["isActive"] !== false) {
      return this.decisionForQueue(queue, {
        routingRuleId: rule.id,
        routingRuleName: text(rule.data["name"]) ?? null,
        fallbackReason: null,
      });
    }
    const target: Target = { assignedUserId: null, teamId: ruleTeamId, queueId: ruleQueueId };
    return this.wrapDecision(rule, target, "manual", null);
  }

  private async decisionForQueue(
    queue: ServiceDeskRow,
    meta: { routingRuleId: string | null; routingRuleName: string | null; fallbackReason: string | null },
  ): Promise<RouteDecision> {
    const view = toQueue(queue);
    const eligibility = await this.eligibleAgents(view);
    let assignedUserId = await this.pickByStrategy(view, eligibility, view.strategy);
    let fallbackReason = meta.fallbackReason;
    if (assignedUserId === null && view.strategy !== "manual") {
      // Never drop the case: use the configured fallback owner, else retain it in the queue (§5.3).
      if (view.fallbackBehavior === "fallbackOwner" && view.defaultAssignedUserId !== null) {
        if ((await this.records.activeUserIds([view.defaultAssignedUserId])).has(view.defaultAssignedUserId)) {
          assignedUserId = view.defaultAssignedUserId;
        }
      }
      fallbackReason = "queue-has-no-eligible-agent";
    }
    const target: Target = { assignedUserId, teamId: view.defaultTeamId, queueId: view.id };
    return {
      target,
      strategy: view.strategy,
      routingRuleId: meta.routingRuleId,
      routingRuleName: meta.routingRuleName,
      fallbackReason,
      summary: {
        routingRuleId: meta.routingRuleId,
        routingRuleName: meta.routingRuleName,
        queueId: view.id,
        teamId: view.defaultTeamId,
        assignedUserId,
        strategy: view.strategy,
        fallbackReason,
      },
    };
  }

  private wrapDecision(
    rule: ServiceDeskRow,
    target: Target,
    strategy: CaseAssignmentStrategy,
    fallbackReason: string | null,
  ): RouteDecision {
    const routingRuleId = rule.id;
    const routingRuleName = text(rule.data["name"]) ?? null;
    return {
      target,
      strategy,
      routingRuleId,
      routingRuleName,
      fallbackReason,
      summary: {
        routingRuleId,
        routingRuleName,
        queueId: target.queueId,
        teamId: target.teamId,
        assignedUserId: target.assignedUserId,
        strategy,
        fallbackReason,
      },
    };
  }

  // -------------------------------------------------------------------------
  // strategies
  // -------------------------------------------------------------------------

  private async pickByStrategy(
    queue: QueueView,
    eligibility: Eligibility,
    strategy: CaseAssignmentStrategy,
  ): Promise<string | null> {
    if (strategy === "manual") return null;
    if (eligibility.userIds.length === 0) return null;
    if (strategy === "leastBusy") {
      const counts = await this.records.activeCaseCounts(eligibility.userIds);
      return leastBusyMember(eligibility.userIds, counts) ?? null;
    }
    // Round-robin: the cursor lives on the queue and is advanced under a row lock (§7.3). The lock
    // serialises concurrent claims on the same queue, so no two assignments read the same "next".
    return runInTransaction(this.database.db, async (tx) => {
      const locked = await sql<{ last: string | null; version: number }>`
        select (attrs ->> 'lastAssignedUserId') as last, version
        from entity_records
        where entity_type = 'CaseQueue' and id = ${queue.id} and deleted_at is null
        for update
      `.execute(tx);
      const current = locked.rows[0];
      const next = nextRoundRobinMember(eligibility.userIds, current?.last ?? undefined) ?? null;
      if (current !== undefined) {
        await runAsServiceDeskSystem(this.scope, "roundRobinCursor", () =>
          this.entities.update("CaseQueue", queue.id, {
            lastAssignedUserId: next,
            lastAssignedAt: new Date().toISOString(),
            version: current.version,
          }),
        );
      }
      return next;
    });
  }

  // -------------------------------------------------------------------------
  // apply + history
  // -------------------------------------------------------------------------

  private async apply(
    caseId: string,
    row: ServiceDeskRow,
    target: Target,
    meta: {
      strategy: CaseAssignmentStrategy;
      routingRuleId: string | null;
      routingRuleName: string | null;
      fallbackReason: string | null;
      reason: string | undefined;
      idempotencyKey: string | undefined;
      version: number | undefined;
      routing: boolean;
      decision?: CaseAssignmentDecision | undefined;
    },
  ): Promise<CaseAssignmentResult> {
    const actor = this.scope.requirePrincipal();
    const previousAssignedUserId = text(row.data["assignedUserId"]) ?? null;
    const previousTeamId = text(row.data["teamId"]) ?? null;

    const idempotencyKey = meta.idempotencyKey?.trim();
    if (idempotencyKey !== undefined && idempotencyKey !== "") {
      const prior = await this.records.find("CaseAssignment", { caseId, idempotencyKey }, { limit: 1 });
      const existing = prior[0];
      if (existing !== undefined) {
        return {
          caseId,
          assignedUserId: text(existing.data["assignedUserId"]) ?? null,
          teamId: text(existing.data["teamId"]) ?? null,
          queueId: text(existing.data["queueId"]) ?? null,
          strategy: isCaseAssignmentStrategy(existing.data["strategy"]) ? existing.data["strategy"] : meta.strategy,
          changed: false,
          idempotent: true,
          warnings: [],
          assignmentId: existing.id,
        };
      }
    }

    await this.assertAssignmentPermission(caseId, target);

    const previousQueueId = text(row.data["queueId"]) ?? null;
    const changed =
      target.assignedUserId !== previousAssignedUserId ||
      target.teamId !== previousTeamId ||
      target.queueId !== previousQueueId;
    if (!changed) {
      return {
        caseId,
        assignedUserId: target.assignedUserId,
        teamId: target.teamId,
        queueId: target.queueId,
        strategy: meta.strategy,
        changed: false,
        idempotent: false,
        warnings: [],
        assignmentId: null,
      };
    }

    const now = new Date();
    const warnings: string[] = [];
    if (meta.fallbackReason === "queue-has-no-eligible-agent") warnings.push("QUEUE_HAS_NO_ELIGIBLE_AGENT");

    const assignmentId = await runInTransaction(this.database.db, async (tx) => {
      await runAsServiceDeskInternal(() =>
        this.entities.update(CASE_ENTITY, caseId, {
          assignedUserId: target.assignedUserId,
          teamId: target.teamId,
          queueId: target.queueId,
          lastActivityAt: now.toISOString(),
          ...(meta.version !== undefined ? { version: meta.version } : {}),
        }),
      );
      const history = await runAsServiceDeskSystem(this.scope, "caseAssignmentHistory", () =>
        this.entities.create("CaseAssignment", {
          caseId,
          caseNumber: text(row.data["caseNumber"]) ?? null,
          previousAssignedUserId,
          assignedUserId: target.assignedUserId,
          previousTeamId,
          teamId: target.teamId,
          queueId: target.queueId,
          strategy: meta.strategy,
          routingRuleId: meta.routingRuleId,
          decision: meta.decision === undefined ? null : JSON.stringify(meta.decision),
          reason: meta.reason?.trim() || null,
          actorUserId: actor.userId,
          actorType: actor.userType,
          occurredAt: now.toISOString(),
          idempotencyKey: idempotencyKey ?? null,
        }),
      );
      await this.events.dispatchMany(tx, [
        {
          type: "serviceDesk.case.assigned",
          payload: {
            caseId,
            caseNumber: text(row.data["caseNumber"]) ?? null,
            previousAssignedUserId,
            assignedUserId: target.assignedUserId,
            teamId: target.teamId,
            queueId: target.queueId,
            strategy: meta.strategy,
            routingRuleId: meta.routingRuleId,
            actorUserId: actor.userId,
            actorType: actor.userType,
            source: meta.routing ? "routing" : "manual",
          },
        },
      ]);
      return String(history["id"]);
    });

    // Notification is best-effort and deliberately outside the transaction: a delivery problem must
    // never undo a committed assignment (§12.3 separates generation from delivery).
    if (target.assignedUserId !== null) {
      try {
        await this.notifications.assignment({
          userId: target.assignedUserId,
          caseId,
          caseNumber: text(row.data["caseNumber"]) ?? null,
          subject: text(row.data["name"]) ?? null,
          actorUserId: actor.userId,
          dedupKey: assignmentId,
        });
      } catch {
        // A failed notification is observable through module health, not fatal to the assignment.
      }
    }

    return {
      caseId,
      assignedUserId: target.assignedUserId,
      teamId: target.teamId,
      queueId: target.queueId,
      strategy: meta.strategy,
      changed: true,
      idempotent: false,
      warnings,
      assignmentId,
    };
  }

  // -------------------------------------------------------------------------
  // eligibility and authorisation
  // -------------------------------------------------------------------------

  private async eligibleAgents(queue: { id: string; defaultTeamId: string | null }): Promise<Eligibility> {
    const members = await this.records.find("QueueMember", { queueId: queue.id });
    const activeMembers = members
      .filter((member) => member.data["isActive"] !== false)
      .map((member) => ({ userId: text(member.data["userId"]) ?? "", priority: numeric(member.data["priority"]) }))
      .filter((member) => member.userId !== "")
      .sort((left, right) => right.priority - left.priority || left.userId.localeCompare(right.userId));
    const order = [...new Set(activeMembers.map((member) => member.userId))];
    if (order.length > 0) {
      const active = await this.records.activeUserIds(order);
      return { userIds: order.filter((id) => active.has(id)), source: "members" };
    }
    if (queue.defaultTeamId !== null) {
      const teamMembers = (await this.records.teamMemberIds(queue.defaultTeamId)).sort();
      const active = await this.records.activeUserIds(teamMembers);
      return { userIds: teamMembers.filter((id) => active.has(id)), source: "team" };
    }
    return { userIds: [], source: "none" };
  }

  private async resolveQueue(queueId: string | null | undefined): Promise<QueueView | undefined> {
    if (queueId === undefined || queueId === null) return undefined;
    const row = await this.records.byId("CaseQueue", queueId);
    if (row === undefined) throw new ValidationError(`Queue "${queueId}" does not exist.`, { queueId });
    if (row.data["isActive"] === false) throw new ValidationError(`Queue "${queueId}" is inactive.`, { queueId });
    return toQueue(row);
  }

  private async validateTeam(teamId: string | null): Promise<void> {
    if (teamId === null) return;
    const row = await this.database.db
      .selectFrom("teams")
      .select("id")
      .where("id", "=", teamId)
      .where("is_deleted", "=", false)
      .executeTakeFirst();
    if (row === undefined) throw new ValidationError(`Team "${teamId}" does not exist.`, { teamId });
  }

  private async validateAgent(userId: string, target: { queueId: string | null; teamId: string | null }): Promise<void> {
    const active = await this.records.activeUserIds([userId]);
    if (!active.has(userId)) {
      throw new ValidationError(`User "${userId}" is not an active internal user.`, {
        code: "CASE_ASSIGNMENT_FORBIDDEN",
        userId,
      });
    }
    if (target.queueId !== null) {
      const queueRow = await this.records.byId("CaseQueue", target.queueId);
      if (queueRow !== undefined) {
        const eligibility = await this.eligibleAgents(toQueue(queueRow));
        if (eligibility.userIds.length > 0 && !eligibility.userIds.includes(userId)) {
          throw new ValidationError(`User "${userId}" is not an eligible member of queue "${target.queueId}".`, {
            code: "CASE_ASSIGNMENT_FORBIDDEN",
            userId,
            queueId: target.queueId,
          });
        }
      }
      return;
    }
    if (target.teamId !== null) {
      const members = await this.records.teamMemberIds(target.teamId);
      if (!members.includes(userId)) {
        throw new ValidationError(`User "${userId}" is not a member of team "${target.teamId}".`, {
          code: "CASE_ASSIGNMENT_FORBIDDEN",
          userId,
          teamId: target.teamId,
        });
      }
    }
  }

  /** The scope check for a manual override (§5.3, §10.2). A domain command must call this before writing. */
  private async assertAssignmentPermission(caseId: string, target: Target): Promise<void> {
    if (await this.isUnrestrictedEdit()) return;
    const actorId = this.scope.userId;
    if (actorId === undefined) {
      throw new AuthorizationDeniedError("You do not have permission to assign this case.", {
        code: "CASE_ASSIGNMENT_FORBIDDEN",
        caseId,
      });
    }
    // Self-assignment (claiming) is always allowed on a case the actor may edit.
    if (target.assignedUserId === actorId) return;
    const actor = await this.actorScope(actorId);
    if (target.teamId !== null && actor.teamIds.has(target.teamId)) return;
    if (target.queueId !== null && actor.queueIds.has(target.queueId)) return;
    if (target.assignedUserId !== null) {
      const shared = await this.actorScope(target.assignedUserId);
      if (intersects(actor.teamIds, shared.teamIds) || intersects(actor.queueIds, shared.queueIds)) return;
    }
    // A queue-only placement is allowed when the actor belongs to the queue or its default team.
    if (target.queueId !== null) {
      const queueRow = await this.records.byId("CaseQueue", target.queueId);
      if (queueRow !== undefined) {
        const view = toQueue(queueRow);
        if (view.defaultTeamId !== null && actor.teamIds.has(view.defaultTeamId)) return;
      }
    }
    throw new AuthorizationDeniedError("Assigning this case is outside your allowed scope.", {
      code: "CASE_ASSIGNMENT_FORBIDDEN",
      caseId,
    });
  }

  private async actorScope(userId: string): Promise<{ teamIds: Set<string>; queueIds: Set<string> }> {
    const teamIds = new Set(await this.records.userTeamIds(userId));
    const memberships = await this.records.find("QueueMember", { userId });
    const queueIds = new Set(
      memberships
        .filter((member) => member.data["isActive"] !== false)
        .map((member) => text(member.data["queueId"]) ?? ""),
    );
    queueIds.delete("");
    return { teamIds, queueIds };
  }

  private async isUnrestrictedEdit(): Promise<boolean> {
    if (this.scope.isAdmin) return true;
    const level = await this.acl.canUser(CASE_ENTITY, "edit");
    return level === "all" || level === "yes";
  }

  private async assertWorkloadAccess(queue: QueueView): Promise<void> {
    if (this.scope.isAdmin) return;
    const level = await this.acl.canUser(CASE_ENTITY, "read");
    if (level === "all" || level === "yes") return;
    const actorId = this.scope.userId;
    if (actorId !== undefined) {
      const actorScope = await this.actorScope(actorId);
      if (actorScope.queueIds.has(queue.id) || (queue.defaultTeamId !== null && actorScope.teamIds.has(queue.defaultTeamId))) {
        return;
      }
    }
    throw new AuthorizationDeniedError("Viewing a queue's workload requires queue or team access.", { queueId: queue.id });
  }

  private async assertAdminOrReadAll(action: string): Promise<void> {
    if (this.scope.isAdmin) return;
    const level = await this.acl.canUser(CASE_ENTITY, "read");
    if (level === "all" || level === "yes") return;
    throw new AuthorizationDeniedError(`Administrator access is required for ${action}.`);
  }

  private async requireCase(caseId: string): Promise<ServiceDeskRow> {
    const row = await this.records.byId(CASE_ENTITY, caseId);
    if (row === undefined) throw new NotFoundError(`Case "${caseId}" does not exist.`);
    return row;
  }
}

export function toQueue(row: ServiceDeskRow): QueueView {
  const strategy = row.data["strategy"];
  const fallback = row.data["fallbackBehavior"];
  return {
    id: row.id,
    name: text(row.data["name"]) ?? null,
    code: text(row.data["code"]) ?? null,
    strategy: isCaseAssignmentStrategy(strategy) ? strategy : "manual",
    fallbackBehavior: isCaseFallbackBehavior(fallback) ? fallback : "unassigned",
    defaultTeamId: text(row.data["defaultTeamId"]) ?? null,
    defaultAssignedUserId: text(row.data["defaultAssignedUserId"]) ?? null,
    isActive: row.data["isActive"] !== false,
  };
}

function parseConditions(value: unknown): RoutingCondition[] | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return undefined;
    if (!parsed.every((item) => typeof item === "object" && item !== null)) return undefined;
    return parsed as RoutingCondition[];
  } catch {
    return undefined;
  }
}

function toAssignmentView(id: string, data: Record<string, unknown>): CaseAssignmentView {
  return {
    id,
    caseId: text(data["caseId"]) ?? "",
    previousAssignedUserId: text(data["previousAssignedUserId"]) ?? null,
    assignedUserId: text(data["assignedUserId"]) ?? null,
    previousTeamId: text(data["previousTeamId"]) ?? null,
    teamId: text(data["teamId"]) ?? null,
    queueId: text(data["queueId"]) ?? null,
    strategy: text(data["strategy"]) ?? "manual",
    routingRuleId: text(data["routingRuleId"]) ?? null,
    reason: text(data["reason"]) ?? null,
    actorUserId: text(data["actorUserId"]) ?? null,
    actorType: text(data["actorType"]) ?? "user",
    occurredAt: text(data["occurredAt"]) ?? null,
  };
}

function intersects(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  for (const value of left) if (right.has(value)) return true;
  return false;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function numeric(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
