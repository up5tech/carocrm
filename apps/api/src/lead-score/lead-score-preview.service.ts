import { InvalidQueryError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';

import { AclApiService } from '../acl/acl-api.service.js';
import { EntityCrudService } from '../entity/entity.service.js';
import type { ScoreEvaluation } from './lead-score-evaluator.js';
import { requiredInputFields, scoreLead } from './lead-score-evaluator.js';
import { LeadScoreFeatureGate } from './lead-score-feature-gate.service.js';
import { LeadScoreModelService } from './lead-score-model.service.js';
import { LeadScoreSignalsService } from './lead-score-signals.js';
import { signalPlans } from './lead-score-vocabulary.js';

/**
 * Phase 19-LS.4 — preview a score model against a bounded, authorized sample of Leads
 * (`PLAN_Phase_19_LeadScore.md` §6.1, §8.1, §9.4, §15.2 stage 3; audit §5, §11).
 *
 * This is the door the deterministic engine is admitted through, and it is deliberately the *only* one at
 * this phase. Plan §15.2 stages the rollout as: model administration, then **"preview scoring on a limited
 * authorized sample; compare outputs with expected rules"**, then publish and recalculate. So a preview runs
 * the real evaluator over the real records and writes nothing: no score projection on the Lead, no
 * evaluation row, no audit entry, no event. §6.1 asks for exactly that guarantee, and §9.4 asks that a
 * preview never become a way to make the server do unbounded work or read records nobody granted.
 *
 * Three properties make it safe to hand an administrator:
 *
 * 1. **the sample is the caller's own.** Leads come from `EntityCrudService`, so the record ACL predicate and
 *    field stripping are the core ones. A Lead the caller may not read is not scored and not named; a Lead
 *    whose *field* the caller may not read becomes an `unknown` signal, which is the honest answer rather
 *    than a score the reader could not have derived (plan §6.5).
 * 2. **the response carries no Lead values.** Scores, bands, reason codes, coverage and the signature — a
 *    preview must not turn into an export path around Lead ACL (plan §9.2).
 * 3. **it is bounded.** At most `MAX_PREVIEW_SAMPLE` Leads per call, and a requested id list cannot widen
 *    that bound.
 */

/** Plan §9.4: a preview evaluates a small authorized sample, not the Lead table. */
export const MAX_PREVIEW_SAMPLE = 25;

/** Lead Score qualifies Leads; it is not a general scoring engine (plan §1). */
const SCORED_ENTITY = 'Lead';

/**
 * One scored Lead. The engine's own result names the version that produced it, so a row carries its
 * provenance and two runs of one preview can be compared line by line.
 */
type PreviewResultItem = ScoreEvaluation & {
  readonly leadId: string;
  readonly sourceRevision: number;
  readonly inputsAsOf: string | null;
};

export interface LeadScorePreviewView {
  readonly model: {
    readonly id: string;
    readonly name: string;
    readonly status: string;
    readonly modelVersion: number;
    readonly scaleMin: number;
    readonly scaleMax: number;
    readonly baseScore: number;
    readonly scoreFloor: number;
    readonly scoreCeiling: number;
  };
  /** What the model reads, so an editor can see whether the grant is the one they meant. */
  readonly inputFields: readonly string[];
  readonly sample: {
    /** The ceiling this call was allowed to evaluate. */
    readonly bound: number;
    /** How many Lead ids the caller named; 0 when the module took the bounded sample itself. */
    readonly selected: number;
    readonly scored: number;
    /** Named ids this caller could not read, so a preview never confirms that an id exists (plan §9.2). */
    readonly notReadable: number;
  };
  readonly distribution: {
    readonly bands: Readonly<Record<string, number>>;
    readonly min: number | null;
    readonly max: number | null;
    readonly average: number | null;
  };
  readonly results: readonly PreviewResultItem[];
  /** Whether the engagement rules were read, and what they were read over (19-LS.9). */
  readonly signals: {
    readonly state: string;
    readonly plans: readonly { readonly key: string; readonly source: string; readonly eventTypes: readonly string[]; readonly lookbackDays: number }[];
  };
  /** Always false, and asserted by the test: a preview cannot move a stored score (plan §6.1, §8.3). */
  readonly writes: false;
}

@Injectable()
export class LeadScorePreviewService {
  constructor(
    @Inject(EntityCrudService) private readonly records: EntityCrudService,
    @Inject(AclApiService) private readonly acl: AclApiService,
    @Inject(LeadScoreModelService) private readonly models: LeadScoreModelService,
    @Inject(LeadScoreFeatureGate) private readonly gate: LeadScoreFeatureGate,
    @Inject(LeadScoreSignalsService) private readonly signals: LeadScoreSignalsService,
  ) {}

  async preview(modelId: string, leadIds?: readonly string[], maxSize?: number): Promise<LeadScorePreviewView> {
    // The gate first: a caller without `modelManage` learns nothing about this installation's models, and
    // `previewModel` is the operation whose feature 19-LS.4 delivered.
    await this.gate.assertOperation('previewModel');
    const { model, rules } = await this.models.readModel(modelId);
    const fields = this.models.scoredFields();

    const bound = Math.min(maxSize ?? MAX_PREVIEW_SAMPLE, MAX_PREVIEW_SAMPLE);
    const requested = leadIds ?? [];
    if (requested.length > bound) {
      throw new InvalidQueryError(`A score preview asks for at most ${bound} Leads.`);
    }
    const sample = await this.readSample(requested, bound);
    const inputFields = requiredInputFields(model, rules, fields);
    // Which signals this reader may see is the ACL's answer, not the store's. A field missing from it is left
    // out of the snapshot entirely, so the engine reports an unknown instead of mistaking a withheld value
    // for an empty one (plan §6.5, §9.2).
    const visible = new Set(await this.acl.visibleFields(SCORED_ENTITY));

    // The engagement plans are decided once for the whole sample, and read per Lead: a preview of 25 Leads
    // costs at most 25 bounded index reads of another module's table, which is the same bound a stored score
    // pays. The state is reported on the answer, so an administrator sees whether a draft was scored with
    // engagement or without it — the difference between a preview that says "this rule does nothing" and one
    // that says "this rule could not be read".
    const plans = signalPlans(rules);
    const engagement = plans.length === 0 ? null : await this.gate.assess('engagementSignals');
    const evaluatedAt = new Date().toISOString();
    let signalState = 'available';

    const results: PreviewResultItem[] = [];
    const bands: Record<string, number> = {};
    const scoredValues: number[] = [];
    for (const row of sample) {
      const leadId = String(row['id'] ?? '');
      if (leadId === '') continue;
      const values: Record<string, unknown> = {};
      for (const field of inputFields) {
        if (!visible.has(field)) continue;
        // A field the Lead never carried arrives as an explicit null: that is "empty", which an existence
        // rule may answer, and it is different from "this caller was not shown the field".
        values[field] = row[field] ?? null;
      }
      const sourceRevision = numberOr(row['version'], 0);
      // Provenance travels with the row: `modifiedAt` and `version` say *which* data the score describes,
      // and the evaluator never reads either — that is what makes a re-run produce the same signature.
      const inputsAsOf = typeof row['modifiedAt'] === 'string' ? row['modifiedAt'] : null;
      const reading = plans.length === 0
        ? undefined
        : await this.signals.read({ leadId, plans, evaluatedAt, enabled: engagement?.admitted === true });
      if (reading !== undefined) signalState = reading.state;
      const evaluation = scoreLead({ model, rules, fields, snapshot: { recordId: leadId, sourceRevision, inputsAsOf, values, ...(reading === undefined ? {} : { signals: reading }) } });
      bands[evaluation.band] = (bands[evaluation.band] ?? 0) + 1;
      if (evaluation.scoreValue !== null) scoredValues.push(evaluation.scoreValue);
      results.push({ ...evaluation, leadId, sourceRevision, inputsAsOf });
    }

    return {
      model: {
        id: model.id,
        name: model.name,
        status: model.status,
        modelVersion: model.modelVersion,
        scaleMin: model.scaleMin,
        scaleMax: model.scaleMax,
        baseScore: model.baseScore,
        scoreFloor: model.scoreFloor,
        scoreCeiling: model.scoreCeiling,
      },
      inputFields,
      sample: {
        bound,
        selected: requested.length,
        scored: results.length,
        notReadable: Math.max(0, requested.length - results.length),
      },
      distribution: {
        bands,
        min: scoredValues.length > 0 ? Math.min(...scoredValues) : null,
        max: scoredValues.length > 0 ? Math.max(...scoredValues) : null,
        average: scoredValues.length > 0 ? Number((scoredValues.reduce((left, right) => left + right, 0) / scoredValues.length).toFixed(2)) : null,
      },
      results,
      signals: {
        state: plans.length === 0 ? 'not_used' : engagement?.admitted === false ? String(engagement.code ?? 'disabled') : signalState,
        plans: plans.map((plan) => ({ key: plan.key, source: plan.source, eventTypes: plan.eventTypes, lookbackDays: plan.lookbackDays })),
      },
      writes: false,
    };
  }

  /**
   * The Leads this caller may score, through the core list path.
   *
   * An id the caller cannot read is dropped by the record ACL predicate rather than reported, so a preview
   * cannot be used to test whether an id exists (plan §9.2). Order is by `modifiedAt` descending when no ids
   * are given, which makes the sample stable enough to compare between two calls.
   */
  private async readSample(leadIds: readonly string[], bound: number): Promise<Record<string, unknown>[]> {
    const listed = await this.records.list(SCORED_ENTITY, {
      ...(leadIds.length > 0 ? { where: [{ field: 'id', operator: 'in', value: [...leadIds] }] } : {}),
      orderBy: 'modifiedAt',
      order: 'desc',
      maxSize: bound,
      total: false,
    });
    return listed.list;
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
