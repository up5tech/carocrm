import { createHash } from 'node:crypto';

import { log } from '@carocrm/core/logger/index.js';
import { Inject, Injectable } from '@nestjs/common';

import { DatabaseService } from '../database/database.service.js';
import { type QuotaLimitState, quotaPeriodStart } from './ai-agent-quota-limits.js';

/**
 * Phase 25.10 — the soft-limit warning an operator receives **before** a hard quota stops work
 * (plans/PLAN_Phase_25_AI_Capability_Parity.md §16 task 2).
 *
 * The quota service already knows, from the ledger, whether a policy is near its soft threshold or
 * past its hard limit. This service is the delivery half: it turns that state into an in-app
 * notification, so the person who administers the installation learns about it without opening the
 * AI Agents page first.
 *
 * ## The pattern it follows
 *
 * The platform has **no shared notification service** — six modules hand-roll
 * `insertInto('notifications')` and `type` is free-form TEXT (`docs/omnichannel/repository-audit.md`
 * §F4). This module therefore writes the same table directly, the way Service Desk, Voice and
 * Customer Success do. It writes **in-app rows only**: no mail, no webhook, no SMS.
 *
 * ## Why a notification and not a refusal
 *
 * A soft limit never refuses work (§12.3). It is a *warning*, so it has to arrive while the
 * installation still works — otherwise "near the limit" and "the limit stopped everything" would be
 * the same event. The two states are therefore separate notifications with separate dedup keys.
 *
 * ## Why it cannot storm
 *
 * One notification per policy, per dimension, per period window. The dedup key carries the period
 * start, so a daily policy warns once a day and a monthly policy once a month, no matter how many
 * runs cross the threshold.
 */

export const AI_AGENTS_QUOTA_NOTIFICATION_TYPE = 'AIAgentsQuotaWarning';

export interface QuotaNotificationInput {
  readonly policyId: string;
  readonly scope: string;
  readonly scopeRef: string | null;
  readonly providerKey: string | null;
  readonly agentId: string | null;
  readonly period: string;
  readonly warnPercent: number | null;
  readonly state: QuotaLimitState;
}

@Injectable()
export class AIAgentQuotaNotificationService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  /**
   * Raise the notifications a policy's current state calls for: a soft-limit warning while the
   * work still runs, and a hard-limit notice when the limit has already stopped a run.
   *
   * A failure here is logged, never thrown: a notification that cannot be written must not fail a
   * run that the quota would have allowed.
   */
  async report(input: QuotaNotificationInput): Promise<void> {
    try {
      if (input.state.exhaustedDimension !== null) {
        await this.write(input, 'exhausted', input.state.exhaustedDimension, input.state.exhaustedUsed, input.state.exhaustedLimit);
        return;
      }
      if (input.state.warningDimension !== null) {
        await this.write(input, 'warning', input.state.warningDimension, input.state.warningUsed, input.state.warningLimit);
      }
    } catch (error) {
      log.error(
        {
          error: error instanceof Error ? error.message : 'unknown quota notification error',
          policyId: input.policyId,
          scope: input.scope,
          period: input.period,
        },
        'AI Agents quota notification could not be written.',
      );
    }
  }

  /**
   * One row per recipient. The recipient set is the installation's administrators — the people who
   * administer the quotas — plus the user a user-scoped policy belongs to.
   *
   * The row id is **derived from the dedup key**, so the primary key is the guarantee: a second
   * run that crosses the same threshold inserts nothing (`do nothing` answers with no row), and two
   * concurrent creations cannot both produce the same warning.
   */
  private async write(
    input: QuotaNotificationInput,
    kind: 'warning' | 'exhausted',
    dimension: string,
    used: number | null,
    limit: number | null,
  ): Promise<void> {
    const recipients = await this.recipients(input);
    if (recipients.length === 0) return;
    const periodStart = quotaPeriodStart(input.period as 'run' | 'day' | 'month', new Date());
    const dedupKey = `aiQuota:${kind}:${input.policyId}:${dimension}:${periodStart?.toISOString() ?? 'none'}`;
    const title =
      kind === 'exhausted'
        ? `AI usage limit reached (${input.scope} ${input.period})`
        : `AI usage near the limit (${input.scope} ${input.period})`;
    const body =
      kind === 'exhausted'
        ? `The ${input.scope} ${input.period} limit stopped a run: ${dimension} used ${describe(used)} of ${describe(limit)}.`
        : `The ${input.scope} ${input.period} limit is close: ${dimension} used ${describe(used)} of ${describe(limit)}.`;
    const data = {
      title,
      body,
      link: '/ai-agents',
      dedupKey,
      severity: kind === 'exhausted' ? 'critical' : 'warning',
      module: 'AIAgents',
      policyId: input.policyId,
      scope: input.scope,
      period: input.period,
      dimension,
      used,
      limit,
    };
    for (const userId of recipients) {
      await this.database.db
        .insertInto('notifications')
        .values({
          id: `aiq_${digest(`${dedupKey}|${userId}`)}`,
          type: AI_AGENTS_QUOTA_NOTIFICATION_TYPE,
          user_id: userId,
          data: JSON.stringify(data),
          is_read: false,
          created_at: new Date(),
        })
        .onConflict((oc) => oc.column('id').doNothing())
        .execute();
    }
  }

  /** The administrators of this installation, plus the subject of a user-scoped policy. */
  private async recipients(input: QuotaNotificationInput): Promise<string[]> {
    const admins = await this.database.db
      .selectFrom('users')
      .select(['id'])
      .where('is_admin', '=', true)
      .where('is_active', '=', true)
      .where('is_deleted', '=', false)
      .execute();
    const ids = new Set(admins.map((row) => row.id));
    if (input.scope === 'user' && input.scopeRef !== null && input.scopeRef !== '') {
      ids.add(input.scopeRef);
    }
    return [...ids];
  }
}

/** The deterministic row id: the same condition always maps to the same notification. */
function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** A limit number for a human sentence; money keeps four decimals, counters stay plain. */
function describe(value: number | null): string {
  if (value === null) return '—';
  return Number.isInteger(value) ? String(value) : value.toFixed(4);
}
