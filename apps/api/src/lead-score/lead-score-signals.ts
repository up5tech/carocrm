import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { DatabaseService } from '../database/database.service.js';
import { METADATA_STORE, type MetadataStoreService } from '../metadata/metadata-store.service.js';
import { MAX_SIGNAL_EVENTS_PER_PLAN, type SignalPlan, type SignalSourceState } from './lead-score-vocabulary.js';

/**
 * Phase 19-LS.9 — the engagement signal read
 * (`PLAN_Phase_19_LeadScore.md` §6.3, §6.4, §10.1, §16 `19-LS.9`; audit §7.1, gap G6).
 *
 * Plan §10.1 allows only event sources that *truly exist*, and the audit settled what Marketing Automation
 * actually is for this module: engagement lives in the `marketing_events` table, and MA publishes no
 * open/click event at all. So this file is a **bounded table read**, not a subscription — and the difference
 * matters for the exit criterion. A subscription would make scoring depend on another module being installed,
 * running and configured; a table read that answers "unavailable" makes the engagement signal optional in the
 * only sense that is testable: the score still computes without it.
 *
 * Four rules hold this read in shape:
 *
 * 1. **Recipient identity, never an address.** Rows are selected by `recipient_entity_type = 'Lead'` and
 *    `recipient_entity_id = <this Lead>`. The audit's fallback (gap G6) is deliberately *not* implemented:
 *    `email_hash` is payload-supplied and an address is shared by people, so a hash join would let one
 *    mailbox lend another record's engagement. A row with no recipient is not this Lead's signal, full stop.
 * 2. **Explicit windows.** Every plan names a lookback in days, capped at `MAX_SIGNAL_LOOKBACK_DAYS`, and the
 *    read is capped at `MAX_SIGNAL_EVENTS_PER_PLAN` rows. There is no "all history" and no unbounded scan —
 *    the index `074_phase19_lead_score_signals.sql` exists so the window lookup is an index range scan.
 * 3. **The engine stays clock-free.** This reader returns *timestamps*, never an age or a count. What a signal
 *    is worth — decayed, counted, compared to `evaluatedAt` — is decided by the pure evaluator, so the same
 *    reading and the same instant always produce the same score (plan §16 `19-LS.4`'s criterion, kept true).
 * 4. **Consent is not a signal.** Nothing here reads `marketing_consent` or `MarketingSuppression`: an
 *    unsubscribe, a bounce or a complaint is a *delivery event* a rule may name explicitly, while the consent
 *    record itself is a legal state that must never become a scoring proxy (plan §0.1-6, audit §7.1).
 */

/**
 * What the engine is given: the plans, the timestamps each answered with, and why if none did.
 *
 * Timestamps only. The engine turns them into counts, ages and decayed values against the instant it is
 * told to score for, which is what keeps a re-run of one reading reproducible (plan §16 `19-LS.4`).
 */
export interface SignalReading {
  readonly evaluatedAt: string;
  readonly state: SignalSourceState;
  /** `planKey` → the matching events' `occurredAt` values, newest first, capped per plan. */
  readonly readings: Readonly<Record<string, readonly string[]>>;
}

@Injectable()
export class LeadScoreSignalsService {
  /** The marker check is a schema question that does not change while the process runs. */
  private tablePresent: boolean | undefined;

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(METADATA_STORE) private readonly metadata: MetadataStoreService,
  ) {}

  /**
   * Whether Marketing Automation's engagement table exists in *this* installation.
   *
   * Detection is the metadata/schema marker the audit settled on (§7.1: "If MA is absent or disabled,
   * scoring still works — detection is the metadata-marker pattern, not an import"), so Lead Score never
   * imports an MA service and never assumes an integration exists.
   */
  async isSourcePresent(): Promise<boolean> {
    if (this.tablePresent !== undefined) return this.tablePresent;
    try {
      const found = await sql<{ count: number }>`
        select count(*)::int as count
          from information_schema.columns
         where table_name = 'marketing_events'
           and column_name = 'recipient_entity_id'
      `.execute(this.database.db);
      this.tablePresent = Number(found.rows[0]?.count ?? 0) > 0;
    } catch {
      this.tablePresent = false;
    }
    return this.tablePresent;
  }

  /** Marketing Automation's own entity marker, reported for health only — never a scoring precondition. */
  isModuleRegistered(): boolean {
    return this.metadata.registry.getEntity('Campaign') !== undefined;
  }

  /**
   * Read the engagement this Lead received, for the plans one model asks about.
   *
   * One query per *source*, not per rule: the window filter and the event-type filter happen in memory over
   * the capped, newest-first rows, so a model with eight engagement rules costs one index range scan.
   */
  async read(input: {
    leadId: string;
    plans: readonly SignalPlan[];
    evaluatedAt: string;
    enabled: boolean;
  }): Promise<SignalReading> {
    const { leadId, plans, evaluatedAt, enabled } = input;
    if (!enabled) return { evaluatedAt, state: 'disabled', readings: {} };
    if (plans.length === 0) return { evaluatedAt, state: 'available', readings: {} };
    if (!(await this.isSourcePresent())) return { evaluatedAt, state: 'absent', readings: {} };

    const bySource = new Map<string, SignalPlan[]>();
    for (const plan of plans) bySource.set(plan.source, [...(bySource.get(plan.source) ?? []), plan]);

    const readings: Record<string, readonly string[]> = {};
    for (const [source, sourcePlans] of bySource) {
      const widest = Math.max(...sourcePlans.map((plan) => plan.lookbackDays));
      const limit = MAX_SIGNAL_EVENTS_PER_PLAN * sourcePlans.length;
      const rows = await this.selectEvents({ leadId, source, widest, limit, evaluatedAt });
      for (const plan of sourcePlans) {
        const cutoff = Date.parse(evaluatedAt) - plan.lookbackDays * 86_400_000;
        const wanted = new Set(plan.eventTypes);
        readings[plan.key] = rows
          .filter((row) => wanted.has(row.type))
          .filter((row) => row.occurredAt !== null && Date.parse(row.occurredAt) >= cutoff)
          .slice(0, MAX_SIGNAL_EVENTS_PER_PLAN)
          .map((row) => row.occurredAt as string);
      }
    }

    const anyEvent = Object.values(readings).some((list) => list.length > 0);
    return { evaluatedAt, state: anyEvent ? 'available' : 'no_events', readings };
  }

  /**
   * The recipient-scoped read, in SQL so the index is the plan.
   *
   * `emailLinks` is the clicked-with-a-url slice of the same table (audit §7.1: the `url` column is what a
   * link click carries), which is why the row carries `urlRequired` rather than a second query shape.
   */
  private async selectEvents(input: { leadId: string; source: string; widest: number; limit: number; evaluatedAt: string }): Promise<{ type: string; occurredAt: string | null }[]> {
    const { leadId, source, widest, limit, evaluatedAt } = input;
    // The window is measured back from the instant the score is computed for, not from the wall clock: that
    // is what lets a re-run of the same reading at the same instant answer identically.
    const since = new Date((Date.parse(evaluatedAt) || Date.now()) - widest * 86_400_000);
    const result = await sql<{ normalized_type: string | null; occurred_at: Date | string | null; url: string | null }>`
      select normalized_type, occurred_at, url
        from marketing_events
       where recipient_entity_type = 'Lead'
         and recipient_entity_id = ${leadId}
         and occurred_at is not null
         and occurred_at >= ${since}
         ${sql.raw(source === 'emailLinks' ? "and normalized_type = 'clicked' and coalesce(url, '') <> ''" : '')}
       order by occurred_at desc
       limit ${limit}
    `.execute(this.database.db);

    return result.rows.map((row) => ({ type: String(row.normalized_type ?? ''), occurredAt: instantOf(row.occurred_at) }));
  }
}

function instantOf(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
  }
  return null;
}
