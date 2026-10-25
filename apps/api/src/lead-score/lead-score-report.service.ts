import { NotFoundError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';

import { EntityCrudService } from '../entity/entity.service.js';
import { METADATA_STORE, type MetadataStoreService } from '../metadata/metadata-store.service.js';
import { leadScoreModuleDisabledError } from './lead-score-errors.js';
import { LeadScorePermissionService } from './lead-score-permission.service.js';
import { LeadScoreSettingsService } from './lead-score-settings.service.js';

/**
 * Phase 19-LS.18 — the operational report of the score and the conversion
 * (`PLAN_Phase_19_LeadScore.md` §16 `19-LS.18`; audit §11 `LS.18`; compatibility §2/§8).
 *
 * The plan asks for "suitable score/conversion metrics" in the **existing** reporting and dashboard surfaces.
 * This service is that surface for Lead Score, and it is deliberately small: four views over the numbers the
 * module already stores, computed with the platform's own aggregate so that **the reader's record scope decides
 * what is counted** — an `own` reader sees their own Leads' scores and nobody else's, because
 * `EntityCrudService.aggregate` applies the same ACL predicate the list and the record read apply.
 *
 * The definitions are part of the contract, because a metric whose population is ambiguous is not a metric:
 *
 *  - **scores** — every Lead the reader may see, split into *scored* (a projection exists) and *unscored*, with
 *    the average, the lowest and the highest score and the average coverage. The score is the projection on
 *    the Lead, so the population is the Lead set, not the evaluation history.
 *  - **bands** — the same population grouped by qualification band, with the average score in each band. The
 *    band is the projection's own `scoreBand`, so the two numbers cannot disagree.
 *  - **freshness** — the same population grouped by `scoreStatus` (`current`, `stale`, `pending`, `failed`,
 *    `not_scored`), which is the operator's answer to "how much of my queue is out of date".
 *  - **conversions** — the Leads the reader may see whose status is `Converted`, split by what the conversion
 *    produced (an Account, a Contact, an Opportunity) and by how many were converted in the last 30 days. It
 *    counts **Leads**, not operation rows: the operation history is a module-internal audit trail
 *    (`read: 'no'` on the entity), while the Lead's own `status` and `converted*` references are what the
 *    reader is allowed to see.
 *
 * Every number is a **current snapshot**, except the one slice the definition names as a window (the
 * conversions of the last 30 days). Nothing here is filtered by a date the reader did not ask for, and the
 * section data says which window it used.
 */

export const LEADSCORE_REPORT_VIEWS = ['scores', 'bands', 'freshness', 'conversions'] as const;
export type LeadScoreReportView = (typeof LEADSCORE_REPORT_VIEWS)[number];

/** The one windowed slice in the report, in days. */
export const LEADSCORE_REPORT_WINDOW_DAYS = 30;

/** Groups one view may return; the aggregate engine caps its own scan and group count as well. */
export const LEADSCORE_REPORT_MAX_GROUPS = 50;

export interface LeadScoreReportDefinition {
  readonly key: LeadScoreReportView;
  readonly label: string;
  readonly description: string;
}

export const LEADSCORE_REPORT_DEFINITIONS: readonly LeadScoreReportDefinition[] = [
  {
    key: 'scores',
    label: 'Scored Leads',
    description: 'Every Lead the reader may see, split into scored and unscored, with the average, lowest and highest score and the average coverage.',
  },
  {
    key: 'bands',
    label: 'Leads by qualification band',
    description: 'The same population grouped by the band the stored projection carries, with the average score in each band.',
  },
  {
    key: 'freshness',
    label: 'Score freshness',
    description: 'The same population grouped by score status: current, stale, pending, failed or not scored.',
  },
  {
    key: 'conversions',
    label: 'Conversions',
    description: 'Leads with the Converted status, split by what the conversion produced, plus how many were converted in the last 30 days.',
  },
];

const BY_VIEW = new Map(LEADSCORE_REPORT_DEFINITIONS.map((definition) => [definition.key, definition]));

/**
 * The options a Lead Score dashlet carries (19-LS.18).
 *
 * One dashlet shows one view, named by the module's own vocabulary — not a free-form entity/measure pair, so a
 * dashlet can never become a second query surface the module has not bounded.
 */
export const LeadScoreDashletConfigSchema = z
  .object({
    view: z.enum(LEADSCORE_REPORT_VIEWS),
  })
  .strict();

export interface LeadScoreReportSection {
  readonly key: LeadScoreReportView;
  readonly label: string;
  readonly description: string;
  readonly generatedAt: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface LeadScoreReportOverview {
  readonly generatedAt: string;
  readonly windowDays: number;
  readonly sections: readonly LeadScoreReportSection[];
}

interface MetricSpec {
  readonly name: string;
  readonly operation: 'count' | 'sum' | 'avg' | 'min' | 'max';
  readonly field?: string;
}

interface AggregateResult {
  readonly total: number;
  readonly groups: readonly { readonly keys: readonly string[]; readonly count: number; readonly metrics: Readonly<Record<string, number | null>> }[];
}

@Injectable()
export class LeadScoreReportService {
  constructor(
    @Inject(LeadScorePermissionService) private readonly permissions: LeadScorePermissionService,
    @Inject(LeadScoreSettingsService) private readonly settings: LeadScoreSettingsService,
    @Inject(EntityCrudService) private readonly entities: EntityCrudService,
    @Inject(METADATA_STORE) private readonly metadata: MetadataStoreService,
  ) {}

  /**
   * The report needs the module on and the `viewScore` right — but **not** the `scoring` switch.
   *
   * The `scoring` switch decides whether scores are *computed*; a deployment that has stopped scoring still
   * has Leads to convert and a history to read, and the conversion half of this report would be empty for a
   * reason the reader cannot act on. The module switch and the right are the two doors that matter.
   */
  private async assertReadable(): Promise<void> {
    if ((await this.settings.enabled()) !== true) throw leadScoreModuleDisabledError('enabled');
    await this.permissions.assert('viewScore');
  }

  /** Every view, in the order the definitions name them. */
  async overview(): Promise<LeadScoreReportOverview> {
    await this.assertReadable();
    const generatedAt = new Date().toISOString();
    const sections: LeadScoreReportSection[] = [];
    for (const definition of LEADSCORE_REPORT_DEFINITIONS) {
      sections.push({ ...definition, generatedAt, data: await this.build(definition.key) });
    }
    return { generatedAt, windowDays: LEADSCORE_REPORT_WINDOW_DAYS, sections };
  }

  /** One view, for a dashlet that shows a single number set. */
  async section(key: string): Promise<LeadScoreReportSection> {
    await this.assertReadable();
    const definition = BY_VIEW.get(key as LeadScoreReportView);
    if (definition === undefined) throw new NotFoundError(`Lead Score has no report view "${key}".`);
    return { ...definition, generatedAt: new Date().toISOString(), data: await this.build(definition.key) };
  }

  /**
   * The numbers of one view.
   *
   * Every read goes through `EntityCrudService.aggregate`, so the record predicate of the caller is part of
   * the statement: an `own` reader's counts are their own Leads' and an administrator's are the whole
   * instance's. The aggregate is bounded twice over — the engine caps the scan and the group count, and this
   * service caps the groups it asks for.
   */
  private async build(view: LeadScoreReportView): Promise<Record<string, unknown>> {
    switch (view) {
      case 'scores':
        return this.scores();
      case 'bands':
        return this.bands();
      case 'freshness':
        return this.freshness();
      case 'conversions':
        return this.conversions();
      default:
        return {};
    }
  }

  private async scores(): Promise<Record<string, unknown>> {
    const [all, scored, unscored] = await Promise.all([
      this.aggregate([], [{ name: 'count', operation: 'count' }]),
      this.aggregate([criterion('scoreStatus', 'notEquals', 'not_scored')], [
        { name: 'count', operation: 'count' },
        { name: 'averageScore', operation: 'avg', field: 'scoreValue' },
        { name: 'lowestScore', operation: 'min', field: 'scoreValue' },
        { name: 'highestScore', operation: 'max', field: 'scoreValue' },
        { name: 'averageCoverage', operation: 'avg', field: 'scoreCoverage' },
      ]),
      this.aggregate([criterion('scoreStatus', 'equals', 'not_scored')], [{ name: 'count', operation: 'count' }]),
    ]);
    return {
      totalLeads: all.total,
      scoredLeads: scored.total,
      unscoredLeads: unscored.total,
      averageScore: metricOf(scored, 'averageScore'),
      lowestScore: metricOf(scored, 'lowestScore'),
      highestScore: metricOf(scored, 'highestScore'),
      averageCoverage: metricOf(scored, 'averageCoverage'),
    };
  }

  private async bands(): Promise<Record<string, unknown>> {
    const result = await this.aggregate(
      [],
      [
        { name: 'count', operation: 'count' },
        { name: 'averageScore', operation: 'avg', field: 'scoreValue' },
      ],
      ['scoreBand'],
    );
    return {
      bands: result.groups.map((group) => ({
        band: group.keys[0] ?? 'Unknown',
        count: group.count,
        averageScore: metricValue(group.metrics['averageScore']),
      })),
    };
  }

  private async freshness(): Promise<Record<string, unknown>> {
    const result = await this.aggregate([], [{ name: 'count', operation: 'count' }], ['scoreStatus']);
    return {
      statuses: result.groups.map((group) => ({ status: group.keys[0] ?? 'not_scored', count: group.count })),
    };
  }

  private async conversions(): Promise<Record<string, unknown>> {
    const converted = criterion('status', 'equals', 'Converted');
    const from = new Date(Date.now() - LEADSCORE_REPORT_WINDOW_DAYS * 24 * 60 * 60 * 1_000).toISOString();
    const [total, withAccount, withContact, withOpportunity, inWindow] = await Promise.all([
      this.aggregate([converted], [{ name: 'count', operation: 'count' }]),
      this.aggregate([converted, criterion('convertedAccountId', 'isNotNull', null)], [{ name: 'count', operation: 'count' }]),
      this.aggregate([converted, criterion('convertedContactId', 'isNotNull', null)], [{ name: 'count', operation: 'count' }]),
      this.aggregate([converted, criterion('convertedOpportunityId', 'isNotNull', null)], [{ name: 'count', operation: 'count' }]),
      this.aggregate([converted, criterion('convertedAt', 'greaterThanOrEqual', from)], [{ name: 'count', operation: 'count' }]),
    ]);
    return {
      windowDays: LEADSCORE_REPORT_WINDOW_DAYS,
      convertedLeads: total.total,
      withAccount: withAccount.total,
      withContact: withContact.total,
      withOpportunity: withOpportunity.total,
      convertedInWindow: inWindow.total,
    };
  }

  /** One aggregate, with the reader's record scope applied by the entity service. */
  private async aggregate(
    where: readonly Record<string, unknown>[],
    metrics: readonly MetricSpec[],
    dimensions: readonly string[] = [],
  ): Promise<AggregateResult> {
    const result = await this.entities.aggregate('Lead', {
      where: [...where],
      dimensions: dimensions.map((field) => ({ field, fieldType: this.fieldType(field) })),
      metrics: metrics.map((metric) => ({
        name: metric.name,
        operation: metric.operation,
        ...(metric.field === undefined ? {} : { field: metric.field, fieldType: this.fieldType(metric.field) }),
      })),
      maxGroups: LEADSCORE_REPORT_MAX_GROUPS,
    });
    return {
      total: result.total,
      groups: result.groups.map((group) => ({ keys: [...group.keys], count: group.count, metrics: group.metrics })),
    };
  }

  /**
   * The field type the aggregate casts by.
   *
   * It is read from the metadata rather than written down here, so a renamed or re-typed Lead field cannot
   * leave this service casting the wrong way; a field the Lead no longer has is a schema drift, and it fails
   * loudly instead of quietly aggregating nothing.
   */
  private fieldType(field: string): string {
    const type = this.metadata.registry.getEntity('Lead')?.fields[field]?.type;
    if (type === undefined) throw new NotFoundError(`Lead has no field "${field}" for the Lead Score report.`);
    return type;
  }
}

/** A criterion in the query engine's own shape; the field and operator are the module's constants, never input. */
function criterion(field: string, operator: string, value: unknown): Record<string, unknown> {
  return { field, operator, value };
}

function metricOf(result: AggregateResult, name: string): number | null {
  const first = result.groups[0];
  return first === undefined ? null : metricValue(first.metrics[name]);
}

function metricValue(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}
