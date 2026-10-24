import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { DatabaseService } from '../database/database.service.js';
import { currentTx } from '../entity/tx-context.js';
import type { LeadScoreEntityType } from './lead-score-internal.js';

/**
 * The three row kinds this port reads, typed against `LEADSCORE_ENTITY_TYPES` so a rename anywhere in the
 * module stops this file compiling rather than silently querying for a kind nothing owns.
 */
const MODEL_ENTITY: LeadScoreEntityType = 'LeadScoreModel';
const RULE_ENTITY: LeadScoreEntityType = 'LeadScoreRule';
const EVALUATION_ENTITY: LeadScoreEntityType = 'LeadScoreEvaluation';

/**
 * Phase 19-LS.5 — the module's own structural reads
 * (`PLAN_Phase_19_LeadScore.md` §4.4, §5.3–§5.4, §8.2; audit §5.3, §11 `LS.5`).
 *
 * Two different questions are asked of Lead Score data, and they need two different doors:
 *
 * - *what may this user see?* is answered by `EntityCrudService` everywhere in this module — record ACL,
 *   field masking, serialisation and hooks stay in one place, and 19-LS.5's score and history reads go
 *   through it for the Lead;
 * - *what does this calculation need in order to be correct?* cannot go through a user's ACL. Recalculating
 *   a Lead requires the active model **and every rule attached to it**: an operator holding only
 *   `LeadScoreRecalculate` would otherwise score a Lead against a rule set truncated by a permission that
 *   governs *configuration*, and the resulting score would name a version it was not derived from. The
 *   history read has the same shape, because `LeadScoreEvaluation` is `read: 'no'` at the entity level by
 *   design — the record-level check on its Lead, made through the core path, is the door (see the note in
 *   `database/seed-metadata.ts` at the `LeadScoreEvaluation` entry).
 *
 * This file answers only the second question, for exactly the rows LS.5 needs, in the same shape
 * `customer-success-records.ts` established: entity types are module constants, attribute names appear as
 * literals in the SQL, and **every request-supplied value is a bind parameter** — no caller input can become
 * an identifier (AGENTS.md §5.2). The predicates are the ones `073_phase19_lead_score.sql` indexes.
 */

export interface LeadScoreRow {
  readonly id: string;
  readonly entityType: string;
  readonly version: number;
  readonly name: string | null;
  readonly data: Record<string, unknown>;
}

export interface LeadScoreEvaluationPage {
  readonly rows: readonly LeadScoreRow[];
  readonly total: number;
}

@Injectable()
export class LeadScoreRecords {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  /** Inside a domain command this service reads the command's own transaction. */
  private get db() {
    return currentTx() ?? this.database.db;
  }

  /** One model row by id, deleted rows excluded. ACL is deliberately not consulted: see the header. */
  async modelById(modelId: string): Promise<LeadScoreRow | undefined> {
    const rows = await sql<RowShape>`
      select id, entity_type, version, name, attrs from entity_records
      where entity_type = ${MODEL_ENTITY} and id = ${modelId} and deleted_at is null
      limit 1
    `.execute(this.db);
    return rows.rows[0] === undefined ? undefined : toRow(rows.rows[0]);
  }

  /**
   * Every rule of one model row, in the order the engine will apply them.
   *
   * The limit is one above the engine's own rule budget, and not the budget itself: a model with more rules
   * than the engine will score has to reach the engine *whole enough* to be refused with
   * `LS_EVALUATION_RULE_LIMIT_EXCEEDED` rather than be quietly scored against a truncated set (plan §6.3
   * reproducibility). Sorting here by `priority`, then `reasonCode`, then `id` is the read-side echo of the
   * evaluator's documented order; the evaluator re-sorts, so the two cannot disagree about the result.
   */
  async rulesOfModel(modelId: string, limit: number): Promise<LeadScoreRow[]> {
    const bounded = Math.max(1, Math.min(1_000, limit));
    const rows = await sql<RowShape>`
      select id, entity_type, version, name, attrs from entity_records
      where entity_type = ${RULE_ENTITY} and deleted_at is null and (attrs ->> 'modelId') = ${modelId}
      order by ((attrs ->> 'priority')::int) asc nulls last, (attrs ->> 'reasonCode') asc, id asc
      limit ${bounded}
    `.execute(this.db);
    return rows.rows.map(toRow);
  }

  /**
   * Evaluations of one Lead, newest first, paged.
   *
   * `calculatedAt` is stored as an ISO string, so text order is time order; `id` breaks a tie so a page is
   * stable across two calls. The count is the same predicate minus the page, which is what a history
   * pager needs and nothing more — no aggregate endpoint, no unbounded scan.
   */
  async evaluationsOfLead(leadId: string, limit: number, offset: number): Promise<LeadScoreEvaluationPage> {
    const bounded = Math.max(1, Math.min(200, limit));
    const skip = Math.max(0, Math.floor(offset));
    const rows = await sql<RowShape>`
      select id, entity_type, version, name, attrs from entity_records
      where entity_type = ${EVALUATION_ENTITY} and deleted_at is null and (attrs ->> 'leadId') = ${leadId}
      order by (attrs ->> 'calculatedAt') desc, id desc
      limit ${bounded} offset ${skip}
    `.execute(this.db);
    const counted = await sql<{ n: number }>`
      select count(*)::int as n from entity_records
      where entity_type = ${EVALUATION_ENTITY} and deleted_at is null and (attrs ->> 'leadId') = ${leadId}
    `.execute(this.db);
    return { rows: rows.rows.map(toRow), total: counted.rows[0]?.n ?? 0 };
  }

  /** The newest evaluation of one Lead for one model version: what the projection describes. */
  async latestEvaluation(leadId: string, modelId: string, modelVersion: number): Promise<LeadScoreRow | undefined> {
    const rows = await sql<RowShape>`
      select id, entity_type, version, name, attrs from entity_records
      where entity_type = ${EVALUATION_ENTITY}
        and deleted_at is null
        and (attrs ->> 'leadId') = ${leadId}
        and (attrs ->> 'modelId') = ${modelId}
        and (attrs ->> 'modelVersion') = ${String(modelVersion)}
      order by (attrs ->> 'calculatedAt') desc, id desc
      limit 1
    `.execute(this.db);
    return rows.rows[0] === undefined ? undefined : toRow(rows.rows[0]);
  }

  /**
   * The evaluation a deterministic key already produced.
   *
   * LS.5 derives the key from the Lead, the version, the input revision and a hash of the inputs read, so
   * "recompute a Lead that has not changed" resolves to an existing row instead of a second history entry
   * (plan §5.4: recalculation must never erase history, and §10.2 asks that duplicate delivery be absorbed).
   */
  async evaluationByKey(idempotencyKey: string): Promise<LeadScoreRow | undefined> {
    const rows = await sql<RowShape>`
      select id, entity_type, version, name, attrs from entity_records
      where entity_type = ${EVALUATION_ENTITY} and deleted_at is null and (attrs ->> 'idempotencyKey') = ${idempotencyKey}
      limit 1
    `.execute(this.db);
    return rows.rows[0] === undefined ? undefined : toRow(rows.rows[0]);
  }
}

interface RowShape {
  id: string;
  entity_type: string;
  version: number;
  name: string | null;
  attrs: unknown;
}

function toRow(row: RowShape): LeadScoreRow {
  const data = isRecord(row.attrs) ? { ...row.attrs } : {};
  // `name` is a physical column, never an attribute (the LS.2 finding), and the converters downstream read
  // one map — so it is placed here once, at the boundary.
  if (data['name'] === undefined) data['name'] = row.name;
  return { id: row.id, entityType: row.entity_type, version: row.version, name: row.name, data };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
