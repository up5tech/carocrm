import { createHash } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { AclApiService } from '../acl/acl-api.service.js';
import { REQUEST_SCOPE_TOKEN, type RequestScope } from '../common/request-scope.js';
import { DatabaseService } from '../database/database.service.js';
import { EntityCrudService } from '../entity/entity.service.js';
import { runInTransaction } from '../entity/tx-context.js';
import type { ScoreableField } from './lead-score-condition.js';
import { leadScoreNoActiveModelError } from './lead-score-errors.js';
import type { ScoreEvaluation } from './lead-score-evaluator.js';
import { MAX_EVALUATED_RULES, requiredInputFields, scoreLead } from './lead-score-evaluator.js';
import type { LeadScoreOperation } from './lead-score-feature-gate.service.js';
import { LeadScoreFeatureGate } from './lead-score-feature-gate.service.js';
import { MODEL_DRAFT_STATUS, runAsLeadScoreInternal } from './lead-score-internal.js';
import { LeadScoreModelService, toModelAttributes, toRuleAttributes } from './lead-score-model.service.js';
import { LeadScoreRecords } from './lead-score-records.js';
import { LeadScoreSettingsService } from './lead-score-settings.service.js';
import { LeadScoreSignalsService } from './lead-score-signals.js';
import { LeadScoreThresholdService } from './lead-score-threshold.service.js';
import type { ModelAttributes, RuleAttributes } from './lead-score-validator.js';
import type { EvaluationTrigger } from './lead-score-vocabulary.js';
import { signalPlans } from './lead-score-vocabulary.js';

/**
 * Phase 19-LS.5 — computing a score and *keeping* it
 * (`PLAN_Phase_19_LeadScore.md` §3.1, §5.3–§5.4, §6.3, §8.2, §9.1–§9.2, §10.2, §16 `19-LS.5`; audit §5.3, §11).
 *
 * LS.4 proved that a model and a snapshot answer the same question the same way. This service is what makes
 * that answer visible without recomputing it on every list read, which plan §4.2 forbids. It writes two
 * things and nothing else:
 *
 * - one **immutable `LeadScoreEvaluation`** row — history naming the model version, the input revision, the
 *   per-rule outcomes, the coverage and the signature (plan §5.4);
 * - the **current projection** on the Lead itself — number, band, freshness state, coverage and reason codes
 *   (plan §5.3).
 *
 * Both are written in one transaction under `runAsLeadScoreInternal`, through `EntityCrudService`, so a score
 * never exists in history without a projection that matches it, the LS.2 write guard stays the thing that
 * decides those fields are server-owned rather than the caller's, and validation, hooks and audit remain in
 * the one path every other record write takes (AGENTS.md §5.2).
 *
 * Three decisions are worth naming, because none of them is obvious from the code:
 *
 * 1. **the model is the one an administrator chose**, not "the newest published version" (plan §5.1, audit
 *    §5.1: one active published model). Publishing a version must not silently change what every future
 *    score means while somebody is mid-revision, so a recalculation refuses with
 *    `LEADSCORE_NO_ACTIVE_MODEL` and says which of its three states it found.
 * 2. **the rule set is read internally, the Lead is not.** An operator holding `LeadScoreRecalculate` but not
 *    model-edit rights must still get the score the published version produces — reading the rules through
 *    that operator's ACL would score against a truncated rule set and then name a version that did not
 *    produce it. The Lead goes through the core path, so its record ACL and field masking decide what is
 *    visible and which signals are not supplied at all (the LS.4 finding), and writing the projection
 *    requires `Lead:edit`: a score is written onto a Lead, so editing Leads is part of what the
 *    recalculate right means (plan §9.1 grants it to people who do edit Leads).
 * 3. **recomputing an unchanged Lead is a provable no-op.** The evaluation's idempotency key is derived from
 *    the Lead, the model version, the input revision and the hash of exactly the inputs read, so a second
 *    call with nothing changed hits the LS.2 unique index, reuses the existing row, and — when the
 *    projection already says this — leaves the Lead row alone. Plan §5.4 and §10.2 ask for duplicate
 *    delivery to be absorbed; the alternative is a history that claims "recalculated" a thousand times about
 *    a record nobody touched, and a `version` that churns under the reader's feet.
 */

/**
 * The trigger of a call nobody asked for by name.
 *
 * `trigger` is stored provenance, so the recalculation paths 19-LS.6 added say which one ran: a job released
 * by a committed Lead change passes `lead_change`, a Lead inside a rebuild passes `batch_rebuild`, and a
 * reader of the history can tell "someone pressed recalculate" from "this record was edited". `decay_sweep`
 * still belongs to 19-LS.9.
 */
const DEFAULT_EVALUATION_TRIGGER: EvaluationTrigger = 'manual_recalculate';

/** The Lead attributes this service owns — plan §5.3 in full, all of them server-written. */
const PROJECTION_FIELDS = [
  'scoreValue',
  'scoreBand',
  'scoreStatus',
  'scoreModelId',
  'scoreModelVersion',
  'scoreCalculatedAt',
  'scoreInputsAsOf',
  'scorePreviousValue',
  'scoreCoverage',
  'scoreReasonCodes',
] as const;

export interface ScoreWriteView {
  readonly leadId: string;
  readonly evaluationId: string;
  /** `false` when an identical evaluation already existed, so this call recorded nothing new. */
  readonly recorded: boolean;
  /** `false` when the projection already said exactly this, so the Lead row was not touched. */
  readonly projectionWritten: boolean;
  readonly model: { readonly id: string; readonly name: string; readonly modelVersion: number };
  readonly evaluation: {
    readonly idempotencyKey: string;
    readonly trigger: string;
    readonly sourceRevision: number;
    readonly inputsAsOf: string | null;
    readonly calculatedAt: string;
    readonly scoreValue: number | null;
    readonly band: string;
    readonly bandSource: string;
    readonly coverage: number;
    readonly resultState: string;
    readonly signature: string;
    readonly positiveReasonCodes: readonly string[];
    readonly negativeReasonCodes: readonly string[];
    readonly unknownReasonCodes: readonly string[];
    readonly skippedReasonCodes: readonly string[];
    readonly errorCodes: readonly string[];
    /** Why an engagement rule could not be read, or `null` when the model asks for none. */
    readonly signalState: string | null;
  };
  /**
   * What the threshold story did for this score (19-LS.9). Absent when nothing was recorded, because a call
   * that changed nothing must not claim to have announced something.
   */
  readonly threshold?: {
    readonly bandChanged: boolean;
    readonly previousBand: string | null;
    readonly events: readonly string[];
    readonly notificationId: string | null;
    readonly auditId: string | null;
    readonly suppressed: string | null;
  } | undefined;
}

@Injectable()
export class LeadScoreCalculationService {
  constructor(
    @Inject(EntityCrudService) private readonly records: EntityCrudService,
    @Inject(AclApiService) private readonly acl: AclApiService,
    @Inject(LeadScoreRecords) private readonly store: LeadScoreRecords,
    @Inject(LeadScoreModelService) private readonly models: LeadScoreModelService,
    @Inject(LeadScoreSettingsService) private readonly settings: LeadScoreSettingsService,
    @Inject(LeadScoreFeatureGate) private readonly gate: LeadScoreFeatureGate,
    @Inject(LeadScoreSignalsService) private readonly signals: LeadScoreSignalsService,
    @Inject(LeadScoreThresholdService) private readonly thresholds: LeadScoreThresholdService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  /**
   * Score one Lead under the active published model and keep the result.
   *
   * One Lead per call on purpose: that is what makes the unit bounded and the answer explicit. 19-LS.6's
   * rebuild is a loop *around* this method, in a chunk of at most `MAX_BATCH_CHUNK` Leads with its own gate
   * operation and its own stored trigger — not a loop added here (plan §8.2's two endpoints differ for the
   * same reason).
   *
   * `operation` names which switch governs the call, and `trigger` is what history will say produced the row.
   * An explicit single-Lead request is gated by `manualRecalculation` and recorded as `manual_recalculate`;
   * a job released by a Lead change is gated by `eventRecalculation` and recorded as `lead_change`; a Lead
   * inside a rebuild chunk is gated by `batchRecalculation` and recorded as `batch_rebuild`. One rebuild must
   * not be blocked by an operator choosing not to enable the interactive button, and turning a switch off must
   * stop the work already queued behind it.
   */
  async recalculate(
    leadId: string,
    options: { operation?: LeadScoreOperation; trigger?: EvaluationTrigger } = {},
  ): Promise<ScoreWriteView> {
    const startedAt = Date.now();
    const trigger = options.trigger ?? DEFAULT_EVALUATION_TRIGGER;
    await this.gate.assertOperation(options.operation ?? 'recalculateLead');

    const lead = await this.records.get('Lead', leadId);
    const model = await this.activeModel();
    const rules = (await this.store.rulesOfModel(model.id, MAX_EVALUATED_RULES + 1)).map((row) => toRuleAttributes(model.id, row.data));
    const fields = this.models.scoredFields();
    const values = await this.snapshotValues(lead, model, rules, fields);
    const sourceRevision = numberOf(lead['version'], 0);
    const inputsAsOf = instantOf(lead['modifiedAt']);

    // The engagement read, when the model asks for one. Two switches decide it, and neither of them can
    // break the score: the gate answers whether this build may read the table at all, and the reader answers
    // whether the table is here. Both are reported on the result so an operator sees why a rule skipped.
    const plans = signalPlans(rules);
    const engagement = plans.length === 0 ? null : await this.gate.assess('engagementSignals');
    const calculatedAt = new Date().toISOString();
    const reading = plans.length === 0
      ? undefined
      : await this.signals.read({ leadId, plans, evaluatedAt: calculatedAt, enabled: engagement?.admitted === true });

    const evaluation = scoreLead({ model, rules, fields, snapshot: { recordId: leadId, sourceRevision, inputsAsOf, values, ...(reading === undefined ? {} : { signals: reading }) } });
    const idempotencyKey = evaluationKeyWithSignals(leadId, model, evaluation);

    // Whether a band crossing may interrupt anybody. Assessed once, before any write, so a switch flipped
    // mid-run cannot make half a batch noisy.
    const notifyGate = await this.gate.assess('thresholdAction');
    const notify = notifyGate.admitted;

    return runAsLeadScoreInternal(() =>
      runInTransaction(this.database.db, async (tx) => {
        // The key spans the Lead, the model version and a hash of the inputs the engine read, so a row found by
        // it means *this score over this data* is already recorded. That fact decides both halves of the no-op:
        // nothing new is appended, and the projection's own history fields (`scorePreviousValue`,
        // `scoreInputsAsOf`) keep describing the recording that happened rather than being rewritten to say
        // "the value before this one was this one".
        const prior = await this.store.evaluationByKey(idempotencyKey);
        const evaluationId = prior?.id ?? (await this.insertEvaluation(leadId, model, evaluation, {
          trigger,
          idempotencyKey,
          sourceRevision,
          inputsAsOf,
          calculatedAt,
          durationMs: Math.max(0, Date.now() - startedAt),
          signalState: reading?.state ?? null,
        }));

        const projection = projectionPatch(lead, evaluation, model.id, model.modelVersion, {
          calculatedAt,
          inputsAsOf,
          preserveWatermark: prior !== undefined,
        });

        if (prior !== undefined && projectionMatches(lead, projection)) {
          return view(leadId, evaluationId, false, false, model, evaluation, { trigger, idempotencyKey, sourceRevision, inputsAsOf, calculatedAt }, reading);
        }

        await this.records.update('Lead', leadId, projection);

        // The threshold story runs in this transaction, so a score that rolls back leaves no event, no
        // notification and no audit row behind. It is reached only when something was actually recorded or
        // the projection moved, which is what keeps a duplicate delivery quiet.
        const threshold = await this.thresholds.afterScore({
          tx,
          leadId,
          leadName: typeof lead['name'] === 'string' ? lead['name'] : '',
          ownerUserId: typeof lead['assignedUserId'] === 'string' ? lead['assignedUserId'] : null,
          model,
          evaluation,
          evaluationId,
          previousBand: typeof lead['scoreBand'] === 'string' ? lead['scoreBand'] : null,
          previousScore: typeof lead['scoreValue'] === 'number' ? lead['scoreValue'] : null,
          trigger,
          calculatedAt,
          correlationId: this.scope.requestId ?? null,
          notify: notify,
        });

        return {
          ...view(leadId, evaluationId, prior === undefined, true, model, evaluation, { trigger, idempotencyKey, sourceRevision, inputsAsOf, calculatedAt }, reading),
          threshold: { ...threshold, previousBand: typeof lead['scoreBand'] === 'string' ? lead['scoreBand'] : null },
        };
      }),
    );
  }

  /**
   * The published model this instance scores under (plan §5.1).
   *
   * The three refusals are separate because their fixes are separate, and the id of a row that no longer
   * exists is not echoed at all (plan §8.4, §9.2).
   */
  private async activeModel(): Promise<ModelAttributes> {
    const configured = (await this.settings.settings()).scoring.activeModelId;
    if (configured === null || configured === undefined) throw leadScoreNoActiveModelError('unset');

    const row = await this.store.modelById(configured);
    if (row === undefined) throw leadScoreNoActiveModelError('missing');

    const status = typeof row.data['status'] === 'string' ? row.data['status'] : MODEL_DRAFT_STATUS;
    if (status !== 'published') throw leadScoreNoActiveModelError('notPublished', row.id, status);
    return toModelAttributes(row.id, row.data);
  }

  /**
   * The narrow projection the model reads, filtered to what *this* caller may see.
   *
   * A granted field the caller cannot read is left out of the map rather than substituted with `null`,
   * because LS.4 established that a withheld signal is not an empty one. A granted field the Lead never
   * carried is supplied as an explicit `null`, which is what lets an existence rule answer definitely about
   * a record that really is blank.
   */
  private async snapshotValues(
    lead: Record<string, unknown>,
    model: ModelAttributes,
    rules: readonly RuleAttributes[],
    fields: ReadonlyMap<string, ScoreableField>,
  ): Promise<Record<string, unknown>> {
    const visible = new Set(await this.acl.visibleFields('Lead'));
    const values: Record<string, unknown> = {};
    for (const field of requiredInputFields(model, rules, fields)) {
      if (!visible.has(field)) continue;
      values[field] = lead[field] ?? null;
    }
    return values;
  }

  /**
   * Append one evaluation row.
   *
   * `read: 'no'` at the entity level means the generic API cannot serve these rows to a reader; it does not
   * mean the module may not write them — the caller's role still has to permit creating them, which is what
   * makes "recalculate" one grant rather than a silent bypass, and the whole command rolls back if it does not.
   * The caller looked up the idempotency key first, so reaching here means nothing identical exists yet; the
   * LS.2 unique index is what makes a genuine race lose cleanly instead of writing a second row.
   */
  private async insertEvaluation(
    leadId: string,
    model: ModelAttributes,
    evaluation: ScoreEvaluation,
    provenance: { trigger: EvaluationTrigger; idempotencyKey: string; sourceRevision: number; inputsAsOf: string | null; calculatedAt: string; durationMs: number; signalState: string | null },
  ): Promise<string> {
    const failed = evaluation.resultState === 'failed';
    const data: Record<string, unknown> = {
      name: `Score ${String(evaluation.scoreValue ?? 'n/a')} · v${model.modelVersion}`,
      leadId,
      modelId: model.id,
      modelVersion: model.modelVersion,
      scoreValue: evaluation.scoreValue,
      qualificationBand: evaluation.band,
      // An evaluation is `current` for the inputs it names — whether the *projection* still describes the Lead
      // is the read side's question, answered by comparing `inputsHash` with the inputs as they now stand
      // (plan §5.3, §5.4). A run that could not compute is stored as `failed`, not hidden.
      evaluationStatus: failed ? 'failed' : 'current',
      calculatedAt: provenance.calculatedAt,
      inputsAsOf: provenance.inputsAsOf,
      sourceRevision: provenance.sourceRevision,
      trigger: provenance.trigger,
      resultState: evaluation.resultState,
      coverage: evaluation.coverage,
      // The whole per-rule outcome list: reason code, rule name, dimension, effect, outcome, points and the
      // stable code for anything that did not contribute. `unknown` reasons live here rather than in a
      // column of their own, so the breakdown and the history can never disagree.
      ruleResults: JSON.stringify(evaluation.ruleEvaluations),
      positiveReasonCodes: JSON.stringify(evaluation.positiveReasonCodes),
      negativeReasonCodes: JSON.stringify(evaluation.negativeReasonCodes),
      skippedReasonCodes: JSON.stringify(evaluation.skippedReasonCodes),
      // Which engagement state produced this answer (19-LS.9), or null when the model asked for none. A skip
      // code tells a reader that a rule could not be answered; only this says whether the switch was off, the
      // table is not in this installation, or the Lead genuinely has no events.
      signalState: provenance.signalState,
      errorSummary: evaluation.errorCodes.length > 0 ? evaluation.errorCodes.join(',') : null,
      signature: evaluation.signature,
      // Plan §5.3's input watermark, kept on the row rather than inferred from the Lead's `version`: storing a
      // score moves that version, so `version` can never answer "has this record changed since it was scored".
      inputsHash: evaluation.inputsHash,
      correlationId: this.scope.requestId ?? null,
      jobId: null,
      idempotencyKey: provenance.idempotencyKey,
      durationMs: provenance.durationMs,
    };

    const created = await this.records.create('LeadScoreEvaluation', data);
    return String(created['id'] ?? '');
  }
}

// ---------------------------------------------------------------------------
// the projection
// ---------------------------------------------------------------------------

/**
 * The attributes the projection carries after this evaluation (plan §5.3).
 *
 * `scorePreviousValue` is the number the Lead was showing before, which is what lets the panel talk about
 * movement without paging the history. A failed evaluation still writes a projection — `failed`, with no
 * number — because a state a reader can see beats a stale number presented as current (plan §5.4).
 */
function projectionPatch(
  lead: Record<string, unknown>,
  evaluation: ScoreEvaluation,
  modelId: string,
  modelVersion: number,
  provenance: { calculatedAt: string; inputsAsOf: string | null; preserveWatermark: boolean },
): Record<string, unknown> {
  const codes = [...evaluation.positiveReasonCodes, ...evaluation.negativeReasonCodes, ...evaluation.unknownReasonCodes].sort();
  const storedPrevious = typeof lead['scorePreviousValue'] === 'number' ? lead['scorePreviousValue'] : null;
  const currentNumber = typeof lead['scoreValue'] === 'number' ? lead['scoreValue'] : null;
  // A datetime attribute comes back from the entity service as a `Date`, not as the ISO string it was written
  // as. Reading it with `typeof === 'string'` would see "no watermark" on every second call and rewrite the
  // projection forever, so every timestamp here goes through one coercing reader.
  const storedAsOf = instantOf(lead['scoreInputsAsOf']);
  return {
    scoreValue: evaluation.scoreValue,
    scoreBand: evaluation.band,
    scoreStatus: evaluation.resultState === 'failed' ? 'failed' : 'current',
    scoreModelId: modelId,
    scoreModelVersion: modelVersion,
    scoreCalculatedAt: provenance.calculatedAt,
    // When an identical evaluation is already on record, these two keep describing *that* recording: the number
    // this score displaced is the one it displaced then, and the inputs have not moved since. Rewriting them on
    // every repeat would mean the projection could never match itself, and a re-run of unchanged data would
    // look like movement (plan §5.3–§5.4).
    scoreInputsAsOf: evaluation.resultState === 'failed' ? null : provenance.preserveWatermark ? storedAsOf : provenance.inputsAsOf,
    scorePreviousValue: provenance.preserveWatermark ? storedPrevious : currentNumber,
    scoreCoverage: evaluation.coverage,
    scoreReasonCodes: JSON.stringify(codes),
  };
}

/** Whether the stored projection already says exactly this, so the Lead row can be left alone. */
function projectionMatches(lead: Record<string, unknown>, next: Record<string, unknown>): boolean {
  for (const field of PROJECTION_FIELDS) {
    // The timestamp is the one thing allowed to differ without meaning anything changed — and a no-op call
    // does not rewrite it either, so "last calculated" keeps describing the calculation that produced this.
    if (field === 'scoreCalculatedAt') continue;
    if (!sameStored(lead[field], next[field])) return false;
  }
  return true;
}

/**
 * Attributes come back with the type they were written with, and a link may carry a label object beside its
 * id, so "the same value" is decided on the scalar a reader would actually compare.
 */
function sameStored(stored: unknown, next: unknown): boolean {
  const left = scalarOf(stored);
  const right = scalarOf(next);
  if (typeof left === 'number' || typeof right === 'number') {
    return numberOf(left, Number.NaN) === numberOf(right, Number.NaN);
  }
  return left === right;
}

function scalarOf(value: unknown): unknown {
  if (value === undefined) return null;
  // Datetimes arrive as `Date` objects from the entity service and as ISO text from the attribute store; the
  // comparison must see one thing, or a projection that *is* unchanged looks changed on every call.
  if (value instanceof Date) return instantOf(value);
  if (value !== null && typeof value === 'object' && 'id' in (value as Record<string, unknown>)) return (value as Record<string, unknown>)['id'];
  return value;
}

// ---------------------------------------------------------------------------
// response and helpers
// ---------------------------------------------------------------------------

function view(
  leadId: string,
  evaluationId: string,
  recorded: boolean,
  projectionWritten: boolean,
  model: ModelAttributes,
  evaluation: ScoreEvaluation,
  provenance: { trigger: EvaluationTrigger; idempotencyKey: string; sourceRevision: number; inputsAsOf: string | null; calculatedAt: string },
  reading?: { readonly state: string } | undefined,
): ScoreWriteView {
  return {
    leadId,
    evaluationId,
    recorded,
    projectionWritten,
    model: { id: model.id, name: model.name, modelVersion: model.modelVersion },
    evaluation: {
      idempotencyKey: provenance.idempotencyKey,
      trigger: provenance.trigger,
      sourceRevision: provenance.sourceRevision,
      inputsAsOf: provenance.inputsAsOf,
      calculatedAt: provenance.calculatedAt,
      scoreValue: evaluation.scoreValue,
      band: evaluation.band,
      bandSource: evaluation.bandSource,
      coverage: evaluation.coverage,
      resultState: evaluation.resultState,
      signature: evaluation.signature,
      positiveReasonCodes: evaluation.positiveReasonCodes,
      negativeReasonCodes: evaluation.negativeReasonCodes,
      unknownReasonCodes: evaluation.unknownReasonCodes,
      skippedReasonCodes: evaluation.skippedReasonCodes,
      errorCodes: evaluation.errorCodes,
      signalState: reading?.state ?? null,
    },
  };
}

/**
 * The identity of one evaluation: this Lead, this model version, this data, and — since 19-LS.9 — this
 * engagement reading.
 *
 * The signal half is appended only when a rule read a signal, so every key computed before this phase still
 * means the same thing and a re-score of a Lead-field-only model stays the no-op it was. A decayed score is
 * a *different* score, so it must not be swallowed as a duplicate of yesterday's; that is what the signal
 * half is for, and why it is not folded into `inputsHash`, which answers a different question (freshness of
 * the record, not of the calendar).
 */
function evaluationKeyWithSignals(leadId: string, model: ModelAttributes, evaluation: ScoreEvaluation): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        leadId,
        modelId: model.id,
        modelVersion: model.modelVersion,
        inputsHash: evaluation.inputsHash,
        // Absent, not empty, when no rule read a signal: the pre-19-LS.9 key stays byte-identical.
        ...(evaluation.signalsHash === '' ? {} : { signalsHash: evaluation.signalsHash }),
      }),
    )
    .digest('hex');
}

/** A datetime attribute as the ISO text the projection and the history rows store. */
function instantOf(value: unknown): string | null {
  if (typeof value === 'string' && value !== '') return value;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  return null;
}

function numberOf(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}
