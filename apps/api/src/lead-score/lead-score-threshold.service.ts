import { createHash } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import type { DbTx } from '../database/database.service.js';
import { EventBus } from '../events/event-bus.js';
import type { ScoreEvaluation } from './lead-score-evaluator.js';
import type { ModelAttributes } from './lead-score-validator.js';
import type { EvaluationTrigger } from './lead-score-vocabulary.js';

/**
 * Phase 19-LS.9 — what a score change is allowed to cause
 * (`PLAN_Phase_19_LeadScore.md` §6.6, §10.3, §10.4, §16 `19-LS.9`; audit §11 `LS.9`).
 *
 * Plan §6.6 sets the boundary this file lives inside: a threshold crossing **may** emit an event and **may**
 * notify somebody, and it must **not** convert the Lead or touch an unrelated lifecycle field. So the whole
 * vocabulary of actions here is: publish a versioned event, create one in-app notification, and record one
 * audit row. There is no field write, no job fork and no second workflow engine — the platform's Workflow
 * already sees the band move, because the projection write is an `entity.updated` on `Lead` with `changed`
 * naming `scoreBand`, and that is the supported way for an administrator to react (§10.4, audit §1 row).
 *
 * Three properties make "auditable" mean something rather than "we wrote a log line":
 *
 *  - **one crossing, one action.** The notification id and the audit id are both derived from the crossing
 *    key (`sha256(lead|from→to|modelVersion|evaluation)`), so the primary key is the dedup: a duplicate
 *    delivery of the same recalculation cannot interrupt anybody twice, and it does not need a check that a
 *    second writer can race past;
 *  - **inside the score transaction.** The caller passes its transaction, so a score that rolled back leaves
 *    no event, no notification and no audit row behind — the trail cannot describe work that did not happen;
 *  - **the event describes, the notification interrupts.** Publishing what happened is part of recording it,
 *    so an event is dispatched for a stored score whatever the switches say; only the notification — the one
 *    thing that reaches a person — sits behind `features.thresholdNotifications`, and its recipient is the
 *    Lead's own owner. A module switched on for scoring is not thereby switched on for interrupting people.
 */

/** The stable event names this module publishes (plan §10.3). Version lives in the payload's `schemaVersion`. */
export const LEADSCORE_EVENT_TYPES = {
  updated: 'leadScore.updated.v1',
  bandChanged: 'leadScore.bandChanged.v1',
} as const;

/** The audit action name written for a threshold action, so the Audit Log can be filtered by it. */
export const THRESHOLD_AUDIT_ACTION = 'leadScore.thresholdAction';

export interface ThresholdInput {
  readonly tx: DbTx;
  readonly leadId: string;
  /** The Lead's display name, for the notification body only. Never in an event payload. */
  readonly leadName: string;
  readonly ownerUserId: string | null;
  readonly model: ModelAttributes;
  readonly evaluation: ScoreEvaluation;
  readonly evaluationId: string;
  readonly previousBand: string | null;
  readonly previousScore: number | null;
  readonly trigger: EvaluationTrigger;
  readonly calculatedAt: string;
  readonly correlationId: string | null;
  /** `features.thresholdNotifications`, decided by the caller's gate. */
  readonly notify: boolean;
}

export interface ThresholdOutcome {
  /** The outbox row ids, newest last. Empty when nothing was published. */
  readonly events: readonly string[];
  readonly bandChanged: boolean;
  readonly notificationId: string | null;
  readonly auditId: string | null;
  /** Why nothing was notified, so health and the UI can say it instead of guessing. */
  readonly suppressed: 'not_band_change' | 'disabled' | 'no_owner' | 'duplicate' | null;
}

@Injectable()
export class LeadScoreThresholdService {
  constructor(@Inject(EventBus) private readonly events: EventBus) {}

  async afterScore(input: ThresholdInput): Promise<ThresholdOutcome> {
    const { tx, evaluation, model } = input;
    const band = evaluation.band;
    const previousBand = input.previousBand;
    const bandChanged = previousBand !== null && previousBand !== '' && previousBand !== band;

    const events: string[] = [];
    // `updated` is published for every *recorded* score — it says a score exists now, which is true whether or
    // not anything moved. `bandChanged` is the narrower claim, and a never-scored Lead does satisfy it: the
    // band it was showing is `Unknown`, and a first score that lands on `Hot` is exactly the change a rep
    // would notice. A rebuild that lands on the band the Lead already carries publishes one event and nothing
    // else, which is what keeps a 2 000-Lead sweep from interrupting anybody 2 000 times.
    const updatedId = await this.events.dispatch(tx, {
      type: LEADSCORE_EVENT_TYPES.updated,
      payload: this.payload(input, band, previousBand),
    });
    events.push(updatedId);
    if (bandChanged) {
      events.push(await this.events.dispatch(tx, { type: LEADSCORE_EVENT_TYPES.bandChanged, payload: this.payload(input, band, previousBand) }));
    }

    if (!bandChanged) return { events, bandChanged: false, notificationId: null, auditId: null, suppressed: 'not_band_change' };
    if (!input.notify) return { events, bandChanged: true, notificationId: null, auditId: null, suppressed: 'disabled' };
    if (input.ownerUserId === null) return { events, bandChanged: true, notificationId: null, auditId: null, suppressed: 'no_owner' };

    const key = crossingKey(input);
    const notificationId = `lsn_${digest(key)}`;
    // `returning` is how a no-op insert is told apart from a real one: `do nothing` answers with no row.
    const inserted = await tx
      .insertInto('notifications')
      .values({
        id: notificationId,
        type: 'LeadScoreBandChanged',
        user_id: input.ownerUserId,
        data: JSON.stringify({
          title: `Lead moved to ${band}`,
          body: `${input.leadName === '' ? 'A Lead' : input.leadName} moved from ${previousBand} to ${band} under ${model.name} v${String(model.modelVersion)}.`,
          link: `/Lead/${input.leadId}`,
          dedupKey: key,
          severity: 'info',
          module: 'LeadScore',
          leadId: input.leadId,
          fromBand: previousBand,
          toBand: band,
          score: evaluation.scoreValue,
          modelVersion: model.modelVersion,
          evaluationId: input.evaluationId,
        }),
        is_read: false,
        created_at: new Date(),
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .returning('id')
      .execute();

    if (inserted.length === 0) {
      // The crossing was already announced — the same evaluation delivered twice, or a retried job.
      return { events, bandChanged: true, notificationId: null, auditId: null, suppressed: 'duplicate' };
    }

    // The audit row is the answer to "who was told what, and why", and it is keyed by the same crossing so a
    // replay cannot inflate the trail either.
    const auditId = `audit_${digest(`${key}|audit`)}`;
    await tx
      .insertInto('audit_log')
      .values({
        id: auditId,
        entity_type: 'Lead',
        record_id: input.leadId,
        username: null,
        user_id: input.ownerUserId,
        action: THRESHOLD_AUDIT_ACTION,
        order: 0,
        data: JSON.stringify({
          thresholdAction: {
            dedupKey: key,
            fromBand: previousBand,
            toBand: band,
            score: evaluation.scoreValue,
            previousScore: input.previousScore,
            modelId: model.id,
            modelVersion: model.modelVersion,
            evaluationId: input.evaluationId,
            trigger: input.trigger,
            notificationId,
            events,
            correlationId: input.correlationId,
            calculatedAt: input.calculatedAt,
          },
        }),
        archived: false,
        created_at: new Date(),
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();

    return { events, bandChanged: true, notificationId, auditId, suppressed: null };
  }

  /**
   * The event payload (plan §10.3: ids, version, score/band, timestamps, correlation — no record body).
   *
   * A Lead's name is deliberately absent: an outbox row is readable by anything that can subscribe, and the
   * consumer can fetch the record through its own ACL if it needs the label.
   */
  private payload(input: ThresholdInput, band: string, previousBand: string | null): Record<string, unknown> {
    return {
      schemaVersion: 1,
      leadId: input.leadId,
      modelId: input.model.id,
      modelVersion: input.model.modelVersion,
      evaluationId: input.evaluationId,
      score: input.evaluation.scoreValue,
      previousScore: input.previousScore,
      band,
      previousBand,
      bandChanged: previousBand !== null && previousBand !== '' && previousBand !== band,
      coverage: input.evaluation.coverage,
      resultState: input.evaluation.resultState,
      trigger: input.trigger,
      calculatedAt: input.calculatedAt,
      correlationId: input.correlationId,
    };
  }
}

/** One crossing of one Lead by one model version, as a stable string. */
function crossingKey(input: ThresholdInput): string {
  return `leadScore:band:${input.leadId}:${input.previousBand ?? 'none'}->${input.evaluation.band}:v${String(input.model.modelVersion)}:${input.evaluationId}`;
}

/** The same SHA-256 recipe the evaluation signature uses, so one module owns one digest convention. */
function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
