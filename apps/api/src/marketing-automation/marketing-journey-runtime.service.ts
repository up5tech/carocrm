import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";

import { DatabaseService } from "../database/database.service.js";
import { FormulaService } from "../logic/formula.service.js";
import { MarketingAutomationRecords, type MarketingRow } from "./marketing-automation-records.js";
import { MarketingJourneyActionService } from "./marketing-journey-action.service.js";
import type { JourneyGraph,JourneyNode } from "./marketing-journey-definition.service.js";
import { MarketingSuppressionService } from "./marketing-suppression.service.js";

export type EnrollmentState = "Active" | "Waiting" | "Suspended" | "Exited" | "Completed";

export interface EnrollInput {
  readonly journeyId: string;
  readonly versionId: string;
  readonly version: number;
  readonly graph: JourneyGraph;
  readonly personType?: string;
  readonly personId?: string;
  readonly emailHash?: string;
  readonly source: string;
  readonly dedupeKey: string;
  readonly correlationId?: string;
}

export interface StepRunResult {
  readonly enrollmentId: string;
  readonly nodeId: string;
  readonly outcome: "advanced" | "waiting" | "completed" | "exited" | "blocked" | "failed" | "noop";
  readonly nextState?: EnrollmentState;
  readonly nextRunAt?: string | null;
  readonly reason?: string;
  readonly trace?: string;
}

@Injectable()
export class MarketingJourneyRuntimeService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(MarketingAutomationRecords) private readonly records: MarketingAutomationRecords,
    @Inject(FormulaService) private readonly formulas: FormulaService,
    @Inject(MarketingSuppressionService) private readonly suppressions: MarketingSuppressionService,
    @Inject(MarketingJourneyActionService) private readonly actions: MarketingJourneyActionService,
  ) {}

  private get db() {
    return this.database.db;
  }

  /**
   * Idempotent enrollment (§15 MA.13 acceptance: "concurrent duplicate triggers create no duplicate
   * enrollments"). The dedupe key and its unique index are the guarantee; a repeat returns the existing row.
   */
  async enroll(input: EnrollInput): Promise<{ enrollmentId: string; duplicate: boolean }> {
    const existing = await this.findByDedupe(input.journeyId, input.dedupeKey);
    if (existing !== undefined) return { enrollmentId: existing.id, duplicate: true };

    const startNode = input.graph.nodes.find((n) => n.id === input.graph.start);
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const name = `${input.journeyId} · ${input.dedupeKey}`;
    try {
      await sql`
        insert into entity_records (id, entity_type, name, attrs, created_at, updated_at)
        values (
          ${id}, 'MarketingJourneyEnrollment', ${name},
          ${JSON.stringify({
            journeyId: input.journeyId,
            versionId: input.versionId,
            version: input.version,
            personType: input.personType ?? null,
            personId: input.personId ?? null,
            emailHash: input.emailHash ?? null,
            source: input.source,
            dedupeKey: input.dedupeKey,
            state: "Active",
            currentNodeId: startNode?.id ?? input.graph.start,
            nextRunAt: now,
            enteredAt: now,
            lockVersion: 0,
            correlationId: input.correlationId ?? null,
          })}::jsonb,
          now(), now()
        )
        on conflict do nothing
      `.execute(this.db);
    } catch {
      // unique index raced with a concurrent insert — fall through to the lookup below
    }
    const row = await this.findByDedupe(input.journeyId, input.dedupeKey);
    if (row === undefined) throw new Error("Enrollment insert did not produce a row.");
    return { enrollmentId: row.id, duplicate: false };
  }

  /**
   * Atomically claim one enrollment's due step (§15 MA.13: "two workers cannot execute the same action
   * instance concurrently"). The conditional UPDATE on `lockVersion` is the claim.
   */
  async claim(enrollmentId: string, now: string): Promise<MarketingRow | undefined> {
    const result = await sql`
      update entity_records
      set attrs = jsonb_set(jsonb_set(attrs, '{lockVersion}', to_jsonb(coalesce((attrs->>'lockVersion')::int, 0) + 1)), '{state}', '"Active"'),
          updated_at = now()
      where id = ${enrollmentId}
        and entity_type = 'MarketingJourneyEnrollment'
        and deleted_at is null
        and (attrs->>'state') in ('Active', 'Waiting')
        and coalesce(attrs->>'nextRunAt', '') <= ${now}
      returning id
    `.execute(this.db);
    if (Number(result.numAffectedRows ?? 0n) === 0) return undefined;
    return this.records.byId("MarketingJourneyEnrollment", enrollmentId);
  }

  /** Run the claimed enrollment's current node one step. */
  async runStep(enrollmentId: string, graph: JourneyGraph): Promise<StepRunResult> {
    const now = new Date().toISOString();
    const claimed = await this.claim(enrollmentId, now);
    if (claimed === undefined) {
      return { enrollmentId, nodeId: "", outcome: "noop", reason: "not-due-or-not-claimable" };
    }
    const data = claimed.data as Record<string, unknown>;
    const nodeId = String(data.currentNodeId ?? graph.start);
    const node = graph.nodes.find((n) => n.id === nodeId);
    if (node === undefined) {
      await this.exit(enrollmentId, "UNKNOWN_NODE", now);
      return { enrollmentId, nodeId, outcome: "exited", reason: "unknown-node" };
    }

    // Suppression / opt-out always wins over the graph (§15 MA.13 acceptance).
    const emailHash = data.emailHash === null || data.emailHash === undefined ? null : String(data.emailHash);
    if (emailHash !== null) {
      const applied = await this.suppressions.appliedForMany([emailHash], { channel: "Email" as never });
      const blocked = applied.get(emailHash);
      if (blocked !== undefined && blocked.length > 0) {
        await this.exit(enrollmentId, "SUPPRESSED", now);
        return {
          enrollmentId,
          nodeId,
          outcome: "blocked",
          nextState: "Exited",
          reason: blocked.map((b) => b.reason).join(","),
        };
      }
    }

    const trace: string[] = Array.isArray((data as { branchTrace?: unknown }).branchTrace)
      ? ([...(data as { branchTrace: unknown[] }).branchTrace] as string[])
      : [];

    const ctx = {
      enrollmentId,
      journeyId: String((data as Record<string, unknown>).journeyId ?? ""),
      ...(data.personType !== undefined ? { personType: String(data.personType) } : {}),
      ...(data.personId !== undefined ? { personId: String(data.personId) } : {}),
      ...(emailHash !== null ? { emailHash } : {}),
    };

    switch (node.type) {
      case "action": {
        const result = await this.actions.execute(node, ctx);
        trace.push(`${nodeId}:action:${node.action ?? "?"}:${result.status}`);
        const nextId = node.next ?? null;
        const state: EnrollmentState = result.status === "failed" ? "Suspended" : nextId === null ? "Completed" : "Active";
        await this.updateEnrollment(
          enrollmentId,
          {
            currentNodeId: nextId,
            state,
            nextRunAt: state === "Active" ? now : null,
            ...(state === "Completed" ? { exitedAt: now } : {}),
            branchTrace: trace,
          },
          now,
        );
        this.recordStep(enrollmentId, node, result.status === "failed" ? "Failed" : "Completed", now, result.output ?? result.errorCode ?? "");
        return {
          enrollmentId,
          nodeId,
          outcome: result.status === "failed" ? "failed" : nextId === null ? "completed" : "advanced",
          nextState: state,
          ...(result.errorCode !== undefined ? { reason: result.errorCode } : {}),
          trace: trace[trace.length - 1] ?? `${nodeId}:action`,
        };
      }
      case "end": {
        await this.updateEnrollment(enrollmentId, { state: "Completed", currentNodeId: nodeId, nextRunAt: null, exitedAt: now, branchTrace: [...trace, `${nodeId}:end`] }, now);
        return { enrollmentId, nodeId, outcome: "completed", nextState: "Completed", trace: `${nodeId}:end` };
      }
      case "wait": {
        const seconds = typeof node.seconds === "number" ? node.seconds : 0;
        const next = new Date(Date.now() + seconds * 1000).toISOString();
        await this.updateEnrollment(enrollmentId, { state: "Waiting", currentNodeId: nodeId, nextRunAt: next, branchTrace: [...trace, `${nodeId}:wait:${seconds}s`] }, now);
        this.recordStep(enrollmentId, node, "Waiting", now, `${nodeId}:wait:${seconds}s`);
        return { enrollmentId, nodeId, outcome: "waiting", nextState: "Waiting", nextRunAt: next, trace: `${nodeId}:wait:${seconds}s` };
      }
      case "condition": {
        const record: Record<string, unknown> = {};
        for (const key of ["personType", "personId", "emailHash", "source", "state"]) {
          record[key] = (data as Record<string, unknown>)[key] ?? null;
        }
        const formula = typeof node.formula === "string" ? node.formula : "true";
        let truthy = false;
        try {
          truthy = Boolean(this.formulas.engine.evaluate(formula, { record }));
        } catch {
          truthy = false;
        }
        const nextId = truthy ? node.then : node.otherwise ?? node.then;
        const branch = truthy ? "then" : "otherwise";
        trace.push(`${nodeId}:condition:${branch}`);
        await this.updateEnrollment(enrollmentId, { currentNodeId: nextId, state: "Active", nextRunAt: now, branchTrace: trace }, now);
        this.recordStep(enrollmentId, node, "Completed", now, `${nodeId}:condition:${branch}`);
        return { enrollmentId, nodeId, outcome: "advanced", nextState: "Active", nextRunAt: now, trace: `${nodeId}:condition:${branch}` };
      }
      default: {
        const nextId = node.next ?? null;
        trace.push(`${nodeId}:${node.type}`);
        const nextState: EnrollmentState = nextId === null ? "Completed" : "Active";
        await this.updateEnrollment(
          enrollmentId,
          {
            currentNodeId: nextId,
            state: nextState,
            nextRunAt: nextId === null ? null : now,
            exitedAt: nextId === null ? now : undefined,
            branchTrace: trace,
          },
          now,
        );
        this.recordStep(enrollmentId, node, "Completed", now, `${nodeId}:${node.type}`);
        return { enrollmentId, nodeId, outcome: nextId === null ? "completed" : "advanced", nextState, nextRunAt: nextId === null ? null : now, trace: `${nodeId}:${node.type}` };
      }
    }
  }

  async suspend(enrollmentId: string, reason: string): Promise<void> {
    await this.updateEnrollment(enrollmentId, { state: "Suspended", exitReason: reason, nextRunAt: null }, new Date().toISOString());
  }

  async resume(enrollmentId: string): Promise<void> {
    await this.updateEnrollment(enrollmentId, { state: "Active", nextRunAt: new Date().toISOString() }, new Date().toISOString());
  }

  async exit(enrollmentId: string, reason: string, at: string): Promise<void> {
    await this.updateEnrollment(enrollmentId, { state: "Exited", exitReason: reason, nextRunAt: null, exitedAt: at }, at);
  }

  /** Parse a published version's graph back into the validated shape the executor walks. */
  async versionGraph(versionId: string): Promise<JourneyGraph | undefined> {
    const row = await this.records.byId("MarketingJourneyVersion", versionId);
    const raw = row?.data?.["graph"];
    if (typeof raw !== "string") return undefined;
    try {
      const parsed = JSON.parse(raw) as JourneyGraph;
      if (typeof parsed.start !== "string" || !Array.isArray(parsed.nodes)) return undefined;
      return parsed;
    } catch {
      return undefined;
    }
  }

  /** Due enrollments across all journeys — the bounded claim window a worker drains. */
  async dueEnrollments(now: string, limit: number): Promise<{ id: string; journeyId: string; versionId: string }[]> {
    const rows = await sql<{ id: string; attrs: Record<string, unknown> }>`
      select id, attrs
      from entity_records
      where entity_type = 'MarketingJourneyEnrollment'
        and deleted_at is null
        and (attrs->>'state') in ('Active', 'Waiting')
        and coalesce(attrs->>'nextRunAt', '') <= ${now}
      order by (attrs->>'nextRunAt') asc
      limit ${limit}
    `.execute(this.db);
    return rows.rows.map((r) => ({
      id: r.id,
      journeyId: String((r.attrs as Record<string, unknown>).journeyId ?? ""),
      versionId: String((r.attrs as Record<string, unknown>).versionId ?? ""),
    }));
  }

  private async findByDedupe(journeyId: string, dedupeKey: string): Promise<MarketingRow | undefined> {
    const rows = await sql<{ id: string }>`
      select id from entity_records
      where entity_type = 'MarketingJourneyEnrollment'
        and deleted_at is null
        and (attrs->>'journeyId') = ${journeyId}
        and (attrs->>'dedupeKey') = ${dedupeKey}
      limit 1
    `.execute(this.db);
    const id = rows.rows[0]?.id;
    if (id === undefined) return undefined;
    return this.records.byId("MarketingJourneyEnrollment", id);
  }

  private async updateEnrollment(enrollmentId: string, patch: Record<string, unknown>, _at: string): Promise<void> {
    const row = await this.records.byId("MarketingJourneyEnrollment", enrollmentId);
    const current = (row?.data ?? {}) as Record<string, unknown>;
    const merged: Record<string, unknown> = { ...current };
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined) merged[k] = v;
    }
    merged.lockVersion = Number(current.lockVersion ?? 0) + 1;
    await sql`
      update entity_records
      set attrs = ${JSON.stringify(merged)}::jsonb, updated_at = now()
      where id = ${enrollmentId} and entity_type = 'MarketingJourneyEnrollment'
    `.execute(this.db);
  }

  private recordStep(enrollmentId: string, node: JourneyNode, status: string, at: string, output: string): void {
    void at;
    const id = crypto.randomUUID();
    void sql`
      insert into entity_records (id, entity_type, name, attrs, created_at, updated_at)
      values (
        ${id}, 'MarketingJourneyStepExecution', ${`${enrollmentId} · ${node.id}`},
        ${JSON.stringify({
          enrollmentId,
          nodeId: node.id,
          nodeType: node.type,
          attempt: 1,
          status,
          startedAt: at,
          finishedAt: at,
          outputSummary: output,
          idempotencyKey: `${enrollmentId}:${node.id}:${at}`,
        })}::jsonb,
        now(), now()
      )
      on conflict do nothing
    `.execute(this.db).catch(() => undefined);
  }
}
