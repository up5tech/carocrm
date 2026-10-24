import { Inject, Injectable } from '@nestjs/common';

import { AclApiService } from '../acl/acl-api.service.js';
import { REQUEST_SCOPE_TOKEN, type RequestScope } from '../common/request-scope.js';
import { EntityCrudService } from '../entity/entity.service.js';
import { I18nService } from '../i18n/i18n.service.js';
import { MAX_EVALUATED_RULES, requiredInputFields, scoringInputsHash } from './lead-score-evaluator.js';
import { LeadScoreFeatureGate } from './lead-score-feature-gate.service.js';
import { LeadScoreModelService, toModelAttributes, toRuleAttributes } from './lead-score-model.service.js';
import type { LeadScoreRow } from './lead-score-records.js';
import { LeadScoreRecords } from './lead-score-records.js';
import { LeadScoreSettingsService } from './lead-score-settings.service.js';

/**
 * Phase 19-LS.5 — explaining a score and saying whether it is current
 * (`PLAN_Phase_19_LeadScore.md` §3.1, §5.3–§5.4, §6.5, §8.2, §9.1–§9.2, §16 `19-LS.5`; audit §5.3).
 *
 * The phase's acceptance is a sentence a salesperson can act on: *"users can explain the score and know
 * whether it is current."* Two things therefore have to be answered together and cannot be inferred from the
 * number alone:
 *
 * - **why** — the model version, the rules that contributed and the rules that did not, each with the stable
 *   reason code an interface localizes. The breakdown names **rules, not Lead values**: a reason that quotes
 *   `industry = Software` would turn an explanation endpoint into a way to read a field the caller may not
 *   see, which is the boundary LS.4 found the engine had to respect (plan §6.5, §9.2). What a rule *matched
 *   against* is configuration the caller can already read in the model; the value it matched is the Lead's.
 * - **whether it still describes the record** — the projection was computed from an input revision of the
 *   Lead under a model version that may no longer be the active one, so freshness is derived from those two
 *   facts rather than trusted from a stored label. A score of 80 that predates three edits and a model
 *   republish is not an 80; showing it without saying so is the failure mode plan §1.2 names "explainability
 *   over mystery".
 *
 * Both reads start with `records.get('Lead', …)`: the core record ACL is the door, which is what the LS.2
 * `read: 'no'` on `LeadScoreEvaluation` was designed to make true — history is served by a Lead-scoped
 * command, never by a general entity read the module could not gate (plan §5.4, §8.2).
 */

/** Largest page a history caller may ask for; the plan asks for paging, not for unbounded scans (§8.2). */
export const MAX_HISTORY_PAGE = 50;

export interface ScoreBreakdownEntry {
  readonly reasonCode: string;
  readonly ruleName: string;
  readonly dimension: string;
  readonly dimensionLabel: string;
  readonly outcome: string;
  readonly outcomeLabel: string;
  readonly points: number;
  readonly assignedBand?: string | undefined;
  readonly code?: string | undefined;
  readonly field?: string | undefined;
}

/** One affordance the server is willing to honour, and the stable code explaining a refusal. */
export interface ScoreActionAnswer {
  readonly allowed: boolean;
  readonly reason: string | null;
}

export interface ScoreActions {
  readonly recalculate: ScoreActionAnswer;
  readonly history: ScoreActionAnswer;
}

export interface ScoreReadView {
  readonly leadId: string;
  readonly scored: boolean;
  readonly score: {
    readonly value: number | null;
    readonly band: string;
    readonly previousValue: number | null;
    readonly coverage: number | null;
    readonly modelId: string | null;
    readonly modelVersion: number | null;
    readonly calculatedAt: string | null;
    readonly inputsAsOf: string | null;
    readonly signature: string | null;
    readonly evaluationId: string | null;
    /** The compact codes the projection carries — what a badge or a list column renders. */
    readonly reasonCodes: readonly string[];
  };
  readonly freshness: {
    readonly status: string;
    readonly label: string;
    readonly reasons: readonly string[];
    readonly reasonLabels: readonly string[];
    readonly currentRevision: number;
    readonly scoredRevision: number | null;
    readonly activeModelId: string | null;
  };
  readonly explanation: {
    readonly reasonCodes: {
      readonly positive: readonly string[];
      readonly negative: readonly string[];
      readonly unknown: readonly string[];
      readonly skipped: readonly string[];
    };
    readonly breakdown: readonly ScoreBreakdownEntry[];
    readonly errorCodes: readonly string[];
  };
  readonly actions: ScoreActions;
}

export interface ScoreHistoryView {
  readonly leadId: string;
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
  readonly items: readonly {
    readonly evaluationId: string;
    readonly modelId: string;
    readonly modelVersion: number;
    readonly scoreValue: number | null;
    readonly band: string;
    readonly evaluationStatus: string;
    readonly evaluationStatusLabel: string;
    readonly resultState: string;
    readonly coverage: number | null;
    readonly trigger: string;
    readonly calculatedAt: string | null;
    readonly inputsAsOf: string | null;
    readonly sourceRevision: number | null;
    readonly signature: string;
    readonly durationMs: number | null;
    readonly correlationId: string | null;
    readonly jobId: string | null;
    readonly errorSummary: string | null;
    readonly breakdown: readonly ScoreBreakdownEntry[];
  }[];
}

@Injectable()
export class LeadScoreExplanationService {
  constructor(
    @Inject(EntityCrudService) private readonly records: EntityCrudService,
    @Inject(AclApiService) private readonly acl: AclApiService,
    @Inject(LeadScoreRecords) private readonly store: LeadScoreRecords,
    @Inject(LeadScoreModelService) private readonly models: LeadScoreModelService,
    @Inject(LeadScoreFeatureGate) private readonly gate: LeadScoreFeatureGate,
    @Inject(LeadScoreSettingsService) private readonly settings: LeadScoreSettingsService,
    @Inject(I18nService) private readonly i18n: I18nService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  /**
   * The current score of one Lead, with its explanation, its freshness and what this caller may do about it.
   *
   * `viewScore` is the right; the history and the per-rule breakdown are a wider right and stay in
   * `history()` (plan §9.1 separates "view badge" from "read explanation").
   *
   * The `actions` block is the same gate answer the button would meet, computed here instead of guessed by
   * the SPA (19-LS.7, AGENTS.md §5.3): a client that re-derived "can I recalculate" from a role name would
   * drift the moment a switch moved, and a button that can only end in a 403 is worse than one that is not
   * there. `reason` is the stable code, so the interface can say *why* rather than hiding the affordance in
   * silence. Note what it is not: the record-level scope of `Lead:edit` for this one Lead is only known when
   * the write is attempted, which is why the recalculate command still refuses on its own.
   */
  async score(leadId: string): Promise<ScoreReadView> {
    await this.gate.assertOperation('readScore');
    const lead = await this.records.get('Lead', leadId);
    const active = (await this.settings.settings()).scoring.activeModelId;

    const modelId = stringOf(lead['scoreModelId']);
    const modelVersion = nullableNumber(lead['scoreModelVersion']);
    const status = stringOf(lead['scoreStatus']) ?? 'not_scored';
    const value = nullableNumber(lead['scoreValue']);

    // The evaluation that produced the projection, when it can still be found: it carries the input watermark
    // the score describes and the per-rule breakdown, neither of which is duplicated onto the Lead.
    const row = modelId !== null && modelVersion !== null ? await this.store.latestEvaluation(leadId, modelId, modelVersion) : undefined;
    const freshness = freshnessOf({ status, modelId, modelVersion, active }, row, await this.dataMoved(lead, modelId, row));

    const locale = await this.locale();
    const breakdown = row === undefined ? [] : breakdownOf(row, this.i18n, locale);
    const actions = await this.actions();

    return {
      leadId,
      scored: value !== null || status === 'failed',
      score: {
        value,
        band: stringOf(lead['scoreBand']) ?? 'Unknown',
        previousValue: nullableNumber(lead['scorePreviousValue']),
        coverage: nullableNumber(lead['scoreCoverage']),
        // The compact code list the projection carries (plan §5.3) — the chips a list row or a badge shows
        // without paging an evaluation.
        reasonCodes: codesFrom(lead['scoreReasonCodes']),
        modelId,
        modelVersion,
        calculatedAt: instantOf(lead['scoreCalculatedAt']),
        inputsAsOf: instantOf(lead['scoreInputsAsOf']),
        signature: stringOf(row?.data['signature']),
        evaluationId: row?.id ?? null,
      },
      freshness: {
        status: freshness.status,
        label: this.i18n.translate(locale, `leadscore.score.freshness.${freshness.status}`) ?? freshness.status,
        reasons: freshness.reasons,
        reasonLabels: freshness.reasons.map((reason) => this.i18n.translate(locale, `leadscore.score.staleBecause.${reason}`) ?? reason),
        currentRevision: numberOf(lead['version'], 0),
        scoredRevision: nullableNumber(row?.data['sourceRevision']),
        activeModelId: active ?? null,
      },
      explanation: {
        reasonCodes: {
          positive: stringArray(row?.data['positiveReasonCodes']) ?? [],
          negative: stringArray(row?.data['negativeReasonCodes']) ?? [],
          unknown: breakdown.filter((entry) => entry.outcome === 'unknown').map((entry) => entry.reasonCode),
          skipped: stringArray(row?.data['skippedReasonCodes']) ?? [],
        },
        breakdown,
        errorCodes: splitCodes(stringOf(row?.data['errorSummary'])),
      },
      actions,
    };
  }

  /**
   * What this caller may do with a score, straight from the gate.
   *
   * Recalculating is a *write onto a Lead*, so the score right is not enough by itself: the caller also needs
   * the core `Lead:edit` right, which is exactly what `recalculate()` requires before it stores anything
   * (plan §9.1). Reporting one without the other would put a button on the screen that the server refuses.
   */
  private async actions(): Promise<ScoreActions> {
    const [recalculate, history, canEditLead] = await Promise.all([
      this.gate.assess('recalculateLead'),
      this.gate.assess('readScoreHistory'),
      this.acl.canUser('Lead', 'edit'),
    ]);
    const leadNotEditable = canEditLead === 'no' ? 'LEAD_NOT_EDITABLE' : null;
    return {
      recalculate: {
        allowed: recalculate.admitted && leadNotEditable === null,
        reason: recalculate.admitted ? leadNotEditable : recalculate.code,
      },
      history: { allowed: history.admitted, reason: history.admitted ? null : history.code },
    };
  }

  /**
   * Paged evaluation history of one Lead, newest first.
   *
   * `explainScore` is required *and* the Lead must be readable by this caller — the latter is what makes the
   * entity-level `read: 'no'` on `LeadScoreEvaluation` a real boundary rather than an inconvenience, because
   * there is no other way to reach these rows (plan §5.4, §9.2).
   */
  async history(leadId: string, limit = 20, offset = 0): Promise<ScoreHistoryView> {
    await this.gate.assertOperation('readScoreHistory');
    await this.records.get('Lead', leadId);

    const bounded = Math.max(1, Math.min(MAX_HISTORY_PAGE, Math.floor(limit)));
    const skip = Math.max(0, Math.floor(offset));
    const page = await this.store.evaluationsOfLead(leadId, bounded, skip);
    const locale = await this.locale();

    return {
      leadId,
      total: page.total,
      limit: bounded,
      offset: skip,
      items: page.rows.map((row) => ({
        evaluationId: row.id,
        modelId: stringOf(row.data['modelId']) ?? '',
        modelVersion: numberOf(row.data['modelVersion'], 0),
        scoreValue: nullableNumber(row.data['scoreValue']),
        band: stringOf(row.data['qualificationBand']) ?? 'Unknown',
        evaluationStatus: stringOf(row.data['evaluationStatus']) ?? 'current',
        evaluationStatusLabel: this.i18n.translate(locale, `leadscore.score.freshness.${stringOf(row.data['evaluationStatus']) ?? 'current'}`) ?? 'current',
        resultState: stringOf(row.data['resultState']) ?? 'success',
        coverage: nullableNumber(row.data['coverage']),
        trigger: stringOf(row.data['trigger']) ?? '',
        calculatedAt: instantOf(row.data['calculatedAt']),
        inputsAsOf: instantOf(row.data['inputsAsOf']),
        sourceRevision: nullableNumber(row.data['sourceRevision']),
        signature: stringOf(row.data['signature']) ?? '',
        durationMs: nullableNumber(row.data['durationMs']),
        correlationId: stringOf(row.data['correlationId']),
        jobId: stringOf(row.data['jobId']),
        errorSummary: stringOf(row.data['errorSummary']),
        breakdown: breakdownOf(row, this.i18n, locale),
      })),
    };
  }

  /**
   * Have the inputs this score was computed from changed?
   *
   * The Lead's own `version` cannot answer this, because storing a score moves it: the only honest comparison
   * is against the watermark the evaluation carried, over the same narrow field set the engine read. So this
   * reads the model's *configuration* internally (a bounded, cached-shape read of two record kinds — not a
   * scoring pass, and not the thing plan §4.2 forbids inside a read) and hashes what the Lead holds now.
   *
   * `null` means "this reader cannot tell": a granted field their own field ACL hides makes their view of the
   * inputs a different set from the one the score was computed from, and answering `current` or `stale` from
   * that would be a statement about permissions rather than about the record.
   */
  private async dataMoved(lead: Record<string, unknown>, modelId: string | null, row: LeadScoreRow | undefined): Promise<boolean | null> {
    if (modelId === null || row === undefined) return null;
    const storedHash = stringOf(row.data['inputsHash']);
    if (storedHash === null) return null;

    const modelRow = await this.store.modelById(modelId);
    if (modelRow === undefined) return null;
    const model = toModelAttributes(modelRow.id, modelRow.data);
    const rules = (await this.store.rulesOfModel(modelRow.id, MAX_EVALUATED_RULES + 1)).map((entry) => toRuleAttributes(modelRow.id, entry.data));
    const wanted = requiredInputFields(model, rules, this.models.scoredFields());

    const visible = new Set(await this.acl.visibleFields('Lead'));
    if (!wanted.every((field) => visible.has(field))) return null;

    const values: Record<string, unknown> = {};
    for (const field of wanted) values[field] = lead[field] ?? null;
    return scoringInputsHash(wanted, values) !== storedHash;
  }

  /** The reader's own locale, the way the platform's other localized reads resolve it. */
  private async locale(): Promise<string> {
    return this.scope.locale ?? (await this.i18n.settings()).defaultLocale;
  }
}

// ---------------------------------------------------------------------------
// freshness
// ---------------------------------------------------------------------------

interface Freshness {
  readonly status: string;
  readonly reasons: readonly string[];
}

/**
 * Does this projection still describe this Lead?
 *
 * Four things can make the answer no, and each is named because the remedy differs: the inputs moved
 * (`leadChanged` — recalculate), a different model is active now (`modelChanged` — recalculate under it and
 * know this number came from elsewhere), no model is active (`modelMissing` — the instance is
 * misconfigured), or the evaluation row that produced the projection is gone (`historyMissing` — there is no
 * watermark to compare against at all). A stored `stale` label is carried through, because 19-LS.6's job path
 * is allowed to mark a projection before a newer evaluation exists.
 *
 * `dataMoved` is `null` when this reader cannot tell — their field ACL hides one of the fields the model
 * reads, so their view of the inputs is not the input set the score was computed from. Silence is the honest
 * answer there: reporting `current` would claim more than they can see, and reporting `stale` would be an
 * artefact of their own permissions rather than a fact about the record.
 */
function freshnessOf(
  stored: { status: string; modelId: string | null; modelVersion: number | null; active: string | null },
  row: LeadScoreRow | undefined,
  dataMoved: boolean | null,
): Freshness {
  if (stored.status === 'failed') return { status: 'failed', reasons: [] };
  if (stored.status === 'pending') return { status: 'pending', reasons: [] };
  if (stored.modelId === null || stored.modelVersion === null) return { status: 'not_scored', reasons: [] };

  const reasons: string[] = [];
  if (stored.status === 'stale') reasons.push('reportedStale');
  if (row === undefined) reasons.push('historyMissing');
  else if (dataMoved === true) reasons.push('leadChanged');
  if (stored.active === null) reasons.push('modelMissing');
  else if (stored.active !== stored.modelId) reasons.push('modelChanged');

  if (reasons.length === 0) return { status: 'current', reasons: [] };
  return { status: 'stale', reasons };
}

// ---------------------------------------------------------------------------
// breakdown
// ---------------------------------------------------------------------------

/**
 * The stored per-rule outcomes, labeled.
 *
 * `ruleResults` is written by LS.5 from the engine's own result list, so this is a read of data the engine
 * produced — an entry that is not JSON, or not an array, yields no breakdown rather than a guess. Rule names
 * come from the model (configuration the caller already needed rights to read) and **no Lead value is
 * included anywhere**, which is what keeps the breakdown safe for a reader whose field ACL hides a signal:
 * they see that the rule could not answer, not what it would have answered about.
 */
function breakdownOf(row: LeadScoreRow, i18n: I18nService, locale: string): ScoreBreakdownEntry[] {
  const entries = parseRuleResults(row.data['ruleResults']);
  return entries.map((entry) => ({
    reasonCode: entry.reasonCode,
    ruleName: entry.ruleName,
    dimension: entry.dimension,
    dimensionLabel: i18n.translate(locale, `leadscore.score.dimension.${entry.dimension}`) ?? entry.dimension,
    outcome: entry.outcome,
    outcomeLabel: i18n.translate(locale, `leadscore.score.outcome.${entry.outcome}`) ?? entry.outcome,
    points: entry.points,
    ...(entry.assignedBand !== undefined ? { assignedBand: entry.assignedBand } : {}),
    ...(entry.code !== undefined ? { code: entry.code } : {}),
    ...(entry.field !== undefined ? { field: entry.field } : {}),
  }));
}

/**
 * One stored rule outcome. Read as data rather than as the engine's type, because a row written by an older
 * build may carry an outcome or dimension the current vocabulary no longer names — and an unknown label is a
 * display question, not a reason to drop the entry a reader is entitled to see.
 */
interface StoredRuleOutcome {
  readonly reasonCode: string;
  readonly ruleName: string;
  readonly dimension: string;
  readonly outcome: string;
  readonly points: number;
  readonly assignedBand?: string | undefined;
  readonly code?: string | undefined;
  readonly field?: string | undefined;
}

function parseRuleResults(raw: unknown): StoredRuleOutcome[] {
  if (typeof raw !== 'string') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const record = entry as Record<string, unknown>;
    const reasonCode = typeof record.reasonCode === 'string' ? record.reasonCode : '';
    if (reasonCode === '') return [];
    return [
      {
        reasonCode,
        ruleName: typeof record.ruleName === 'string' ? record.ruleName : reasonCode,
        dimension: typeof record.dimension === 'string' ? record.dimension : '',
        outcome: typeof record.outcome === 'string' ? record.outcome : '',
        points: typeof record.points === 'number' && Number.isFinite(record.points) ? record.points : 0,
        ...(typeof record.assignedBand === 'string' ? { assignedBand: record.assignedBand } : {}),
        ...(typeof record.code === 'string' ? { code: record.code } : {}),
        ...(typeof record.field === 'string' ? { field: record.field } : {}),
      },
    ];
  });
}

function codesFrom(raw: unknown): string[] {
  return stringArray(raw) ?? [];
}

/** A stored comma-joined code list, empty when nothing was recorded. */
function splitCodes(value: string | null): string[] {
  return value === null ? [] : value.split(',').filter((entry) => entry !== '');
}

function stringArray(value: unknown): string[] | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A datetime attribute as text. The entity service hands hydrated `Date` objects back for datetime fields
 * while the module's own reads return the ISO string that was stored, and a reader that only accepts one of
 * the two reports a real timestamp as missing.
 */
function instantOf(value: unknown): string | null {
  if (typeof value === 'string' && value !== '') return value;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  return null;
}

function stringOf(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function numberOf(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function nullableNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
