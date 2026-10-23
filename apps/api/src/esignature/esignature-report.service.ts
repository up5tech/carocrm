import { NotFoundError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';

import { REQUEST_SCOPE_TOKEN, type RequestScope } from '../common/request-scope.js';
import type { ESignatureReportKey } from './dto/esignature-shapes.js';
import { ESIGNATURE_REPORT_KEYS } from './dto/esignature-shapes.js';
import { REQUEST_STATUSES } from './esignature-domain.js';
import { signatureModuleDisabledError } from './esignature-errors.js';
import { ESignaturePermissionService } from './esignature-permission.service.js';
import { ESignatureSettingsService } from './esignature-settings.service.js';
import {
  SignatureReportRepository,
  type SignatureReportScope,
} from './signature-report.repository.js';
import type { RequestAccessScope } from './signature-request.repository.js';

/**
 * Phase 19-ES.19 — the curated operational reports (§14) and the ESignature dashlet.
 *
 * The definition of each date and status is part of the contract, because a report whose window is
 * ambiguous is not a report:
 *
 *  - **status** — the *current* status of requests **created** in the window. A request created
 *    before the window and completed inside it is not in this snapshot; use `rates` for outcomes.
 *  - **rates** — the cohort of requests **sent** in the window, whatever their status now. The
 *    denominator is that cohort; a request still in flight is counted in `inFlight` and in no
 *    numerator, so the rates do not pretend to sum to 100%.
 *  - **approvals** — the *current* queue (status `pending_approval` and approval `pending`), aged
 *    from `approval_requested_at`. Window-independent.
 *  - **waiting** — the *current* set of outstanding recipients on requests that are in flight
 *    (`sent`, `delivered`, `partially_signed`), with recipient statuses `pending`, `sent`,
 *    `delivered` or `viewed`. Window-independent.
 *  - **completionTime** — requests **completed** in the window with both `sent_at` and
 *    `completed_at`. Duration is `completed_at − sent_at` in hours; median and p90 use
 *    `percentile_cont`, the average is the arithmetic mean.
 *  - **exceptions** — the *current* queue in `send_unknown`, `provider_error` or
 *    `reconciliation_required`, split by failure category. Window-independent.
 *  - **volume** — requests **created** in the window, grouped by CRM source entity and owner.
 *
 * Every number is computed by `SignatureReportRepository` under the caller's record scope. The
 * capability is checked here, once, before any aggregate is read; an administrator's `all` scope is
 * the platform's own answer, not this module's inference.
 */
export interface ESignatureReportQuery {
  readonly days: number;
  readonly recipient?: string | undefined;
}

export interface ESignatureReportWindow {
  readonly days: number;
  /** `null` when `days = 0` (all time). */
  readonly from: string | null;
  readonly to: string;
}

export interface ESignatureReportSection {
  readonly key: ESignatureReportKey;
  readonly label: string;
  readonly description: string;
  readonly generatedAt: string;
  readonly window: ESignatureReportWindow;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface ESignatureReportOverview {
  readonly generatedAt: string;
  readonly window: ESignatureReportWindow;
  readonly sections: readonly ESignatureReportSection[];
}

interface ReportDefinition {
  readonly key: ESignatureReportKey;
  readonly label: string;
  readonly description: string;
}

export const ESIGNATURE_REPORT_DEFINITIONS: readonly ReportDefinition[] = [
  {
    key: 'status',
    label: 'Requests by status',
    description: 'Current status of requests created in the window. Drafts are included; they have no sent timestamp.',
  },
  {
    key: 'rates',
    label: 'Completion, decline, void and expiry rates',
    description: 'The cohort of requests sent in the window. In-flight requests count in neither the numerator nor the completion rate.',
  },
  {
    key: 'approvals',
    label: 'Pending approvals',
    description: 'Requests waiting for an approval decision right now, aged from the moment the decision was requested.',
  },
  {
    key: 'waiting',
    label: 'Waiting recipients',
    description: 'Recipients still expected to act on an envelope that is in flight. Optionally narrowed to one person by name or email.',
  },
  {
    key: 'completionTime',
    label: 'Time to completion',
    description: 'Median, average and 90th-percentile hours from sent to completed, for requests completed in the window.',
  },
  {
    key: 'exceptions',
    label: 'Provider errors and reconciliation',
    description: 'Requests whose send outcome is unknown, whose provider call failed, or whose local state needs reconciliation.',
  },
  {
    key: 'volume',
    label: 'Volume by source and owner',
    description: 'Requests created in the window, grouped by the CRM module they came from and by their assigned owner.',
  },
];

const BY_KEY = new Map(ESIGNATURE_REPORT_DEFINITIONS.map((definition) => [definition.key, definition]));

@Injectable()
export class ESignatureReportService {
  constructor(
    @Inject(ESignaturePermissionService) private readonly permissions: ESignaturePermissionService,
    @Inject(ESignatureSettingsService) private readonly settings: ESignatureSettingsService,
    @Inject(SignatureReportRepository) private readonly reports: SignatureReportRepository,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
  ) {}

  async overview(query: ESignatureReportQuery): Promise<ESignatureReportOverview> {
    const context = await this.context(query);
    const generatedAt = context.windowView.to;
    const sections: ESignatureReportSection[] = [];
    for (const definition of ESIGNATURE_REPORT_DEFINITIONS) {
      sections.push({
        ...definition,
        generatedAt,
        window: context.windowView,
        data: await this.build(definition.key, context.scope),
      });
    }
    return { generatedAt, window: context.windowView, sections };
  }

  async section(key: string, query: ESignatureReportQuery): Promise<ESignatureReportSection> {
    const definition = BY_KEY.get(key as ESignatureReportKey);
    if (definition === undefined) throw new NotFoundError(`ESignature report "${key}" does not exist.`);
    const context = await this.context(query);
    return {
      ...definition,
      generatedAt: context.windowView.to,
      window: context.windowView,
      data: await this.build(definition.key, context.scope),
    };
  }

  /** The keys the dashlet and the catalogue advertise; ES.19's static list. */
  keys(): readonly ESignatureReportKey[] {
    return ESIGNATURE_REPORT_KEYS;
  }

  private async build(key: ESignatureReportKey, scope: SignatureReportScope): Promise<Record<string, unknown>> {
    switch (key) {
      case 'status': {
        const byStatus = await this.reports.statusCounts(scope);
        const counts = new Map(byStatus.map((row) => [row.status, row.count]));
        return {
          total: byStatus.reduce((sum, row) => sum + row.count, 0),
          byStatus: REQUEST_STATUSES.map((status) => ({ status, count: counts.get(status) ?? 0 })),
        };
      }
      case 'rates': {
        const cohort = await this.reports.sentCohort(scope);
        const counts = new Map(cohort.map((row) => [row.status, row.count]));
        const total = cohort.reduce((sum, row) => sum + row.count, 0);
        const completed = counts.get('completed') ?? 0;
        const declined = counts.get('declined') ?? 0;
        const voided = counts.get('voided') ?? 0;
        const expired = counts.get('expired') ?? 0;
        const terminal = completed + declined + voided + expired;
        return {
          cohort: total,
          completed,
          declined,
          voided,
          expired,
          inFlight: Math.max(0, total - terminal),
          completionRate: total === 0 ? null : completed / total,
          declineRate: total === 0 ? null : declined / total,
          voidRate: total === 0 ? null : voided / total,
          expiryRate: total === 0 ? null : expired / total,
        };
      }
      case 'approvals': {
        const queue = await this.reports.approvalQueue(scope);
        return {
          pending: queue.pending,
          olderThan24Hours: queue.olderThan24Hours,
          olderThan3Days: queue.olderThan3Days,
          oldestRequestedAt: queue.oldestRequestedAt,
          oldestAgeHours: hoursSince(queue.oldestRequestedAt, scope.to),
        };
      }
      case 'waiting': {
        const waiting = await this.reports.waitingRecipients(scope);
        return {
          requestsWaiting: waiting.requestsWaiting,
          recipientsWaiting: waiting.recipientsWaiting,
          byRecipientStatus: waiting.byStatus,
          oldestSentAt: waiting.oldestSentAt,
          oldestAgeHours: hoursSince(waiting.oldestSentAt, scope.to),
        };
      }
      case 'completionTime': {
        const stats = await this.reports.completionStats(scope);
        return {
          completed: stats.completed,
          averageHours: round(stats.averageHours),
          medianHours: round(stats.medianHours),
          p90Hours: round(stats.p90Hours),
        };
      }
      case 'exceptions': {
        const exceptions = await this.reports.exceptionStats(scope);
        return {
          total: exceptions.total,
          byStatus: exceptions.byStatus,
          byFailureCategory: exceptions.byFailureCategory,
          oldestModifiedAt: exceptions.oldestModifiedAt,
          oldestAgeHours: hoursSince(exceptions.oldestModifiedAt, scope.to),
        };
      }
      case 'volume': {
        const volume = await this.reports.volume(scope);
        return {
          total: volume.total,
          bySource: volume.bySource,
          byOwner: volume.byOwner,
        };
      }
    }
  }

  private async context(query: ESignatureReportQuery): Promise<{
    readonly scope: SignatureReportScope;
    readonly windowView: ESignatureReportWindow;
  }> {
    await this.permissions.assert('use');
    const settings = await this.settings.read();
    if (settings.settings.enabled !== true) throw signatureModuleDisabledError('ESignature');
    if (settings.effective.requests !== true) throw signatureModuleDisabledError('ESignature.requests');

    const level = await this.permissions.level('use');
    const userId = this.scope.userId ?? '';
    const access: RequestAccessScope =
      level === 'all' || level === 'yes'
        ? { kind: 'all', userId, teamIds: [] }
        : { kind: level === 'team' ? 'team' : 'own', userId, teamIds: this.scope.teamIds() };

    const to = new Date();
    const from = query.days === 0 ? null : new Date(to.getTime() - query.days * 86_400_000);
    return {
      scope: { access, from, to, ...(query.recipient === undefined ? {} : { recipient: query.recipient }) },
      windowView: { days: query.days, from: from?.toISOString() ?? null, to: to.toISOString() },
    };
  }
}

/** A duration in hours from an ISO instant to the report's own clock, or `null` when absent. */
function hoursSince(value: string | null, to: Date): number | null {
  if (value === null) return null;
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return null;
  return round(Math.max(0, (to.getTime() - at.getTime()) / 3_600_000));
}

function round(value: number | null): number | null {
  return value === null || !Number.isFinite(value) ? null : Math.round(value * 10) / 10;
}
