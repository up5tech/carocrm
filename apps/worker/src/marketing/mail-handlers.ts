import type { Logger } from '@carocrm/core/logger/index.js';
import type { JobContext, JobHandler } from '@carocrm/jobs';
import { sql } from 'kysely';

/** 19-MA.9 task 2 — pause a send's in-flight recipients. */
export const PAUSE_SEND_JOB = 'marketing.pauseSend';

interface PauseSendInput {
  readonly sendId: string;
  readonly slot: number;
}

export function pauseSendJob(deps: {
  readonly db: any; // DatabaseService
  readonly log: Logger;
}): JobHandler {
  return async (context: JobContext) => {
    const { sendId, slot } = context.job.data as PauseSendInput;

    if (!sendId || !slot) {
      return { status: 'failed', message: 'Invalid job data: missing sendId or slot' };
    }

    const now = new Date().toISOString();

    // Change Eligible and Queued rows to Paused
    const paused = await deps.db.$executeQuery(`
      update marketing_recipient_deliveries
      set state = 'Paused',
          updated_at = ${now}
      where send_id = ${sendId}
        and slot = ${slot}
        and state in ('Eligible', 'Queued')
    `);

    const pausedCount = Number(paused.rowCount ?? 0);

    deps.log.info(
      { sendId, slot, pausedCount },
      'marketing pause send finished'
    );

    return { status: 'completed', message: `Paused ${String(pausedCount)} recipient(s)` };
  };
}

/** 19-MA.9 task 3 — resume a send (re-queue Paused rows back to Queued). */
export const RESUME_SEND_JOB = 'marketing.resumeSend';

interface ResumeSendInput {
  readonly sendId: string;
  readonly slot: number;
}

export function resumeSendJob(deps: {
  readonly db: any; // DatabaseService
  readonly log: Logger;
}): JobHandler {
  return async (context: JobContext) => {
    const { sendId, slot } = context.job.data as ResumeSendInput;

    if (!sendId || !slot) {
      return { status: 'failed', message: 'Invalid job data: missing sendId or slot' };
    }

    const now = new Date().toISOString();

    // Change Paused rows back to Queued
    const requeued = await deps.db.$executeQuery(`
      update marketing_recipient_deliveries
      set state = 'Queued',
          error_code = null,
          failed_at = null,
          updated_at = ${now}
      where send_id = ${sendId}
        and slot = ${slot}
        and state = 'Paused'
    `);

    const requeuedCount = Number(requeued.rowCount ?? 0);

    deps.log.info(
      { sendId, slot, requeuedCount },
      'marketing resume send finished'
    );

    return { status: 'completed', message: `Resumed ${String(requeuedCount)} recipient(s)` };
  };
}

/** 19-MA.9 task 4 — recover stale claims on deploy/restart. */
export const RECOVER_CLAIMS_JOB = 'marketing.recoverClaims';

interface RecoverClaimsInput {
  readonly sendId: string | null;
  readonly olderThan: string;
  readonly maxAttempts: number;
}

export function recoverClaimsJob(deps: {
  readonly db: any; // DatabaseService
  readonly log: Logger;
}): JobHandler {
  return async (context: JobContext) => {
    const { sendId, olderThan, maxAttempts } = context.job.data as RecoverClaimsInput;

    const now = new Date().toISOString();

    // Find claims older than the threshold
    const expired = await deps.db.$executeQuery(`
      update marketing_recipient_deliveries
      set state = 'Failed',
          error_code = 'CLAIM_EXPIRED',
          failed_at = ${now},
          reasons = reasons || ['CLAIM_EXPIRED']::jsonb,
          updated_at = ${now}
      where state = 'Sending'
        and error_code is null
        and claimed_at is not null
        and claimed_at < ${olderThan}
        ${sendId === null ? '' : `and send_id = ${sendId}`}
      returning send_id, slot, entity_type, entity_id, attempts
      limit 100
    `);

    const expiredRows = expired.rows;

    if (expiredRows.length === 0) {
      return { status: 'completed', message: 'No stale claims to recover' };
    }

    // Requeue those that haven't exhausted their retry budget
    const keys = sql.join(
      expiredRows.map((row) => sql`(${row.send_id}, ${row.slot}, ${row.entity_type}, ${row.entity_id})`)
    );

    const requeued = await deps.db.$executeQuery(`
      update marketing_recipient_deliveries
      set state = 'Queued',
          reasons = reasons || ['CLAIM_REQUEUED']::jsonb,
          failed_at = null,
          updated_at = ${now}
      where (send_id, slot, entity_type, entity_id) in (${keys})
        and state = 'Failed'
        and error_code = 'CLAIM_EXPIRED'
        and attempts < ${maxAttempts}
    `);

    const requeuedCount = Number(requeued.rowCount ?? 0);

    // Mark the rest as budget exhausted
    await deps.db.$executeQuery(`
      update marketing_recipient_deliveries
      set error_code = 'RETRY_BUDGET_EXHAUSTED',
          reasons = reasons || ['RETRY_BUDGET_EXHAUSTED']::jsonb,
          updated_at = ${now}
      where (send_id, slot, entity_type, entity_id) in (${keys})
        and state = 'Failed'
        and error_code = 'CLAIM_EXPIRED'
    `);

    deps.log.info(
      { sendId, olderThan, expired: expiredRows.length, requeued: requeuedCount, exhausted: expiredRows.length - requeuedCount },
      'marketing recover claims finished'
    );

    return { status: 'completed', message: `Recovered ${String(requeuedCount)} of ${String(expiredRows.length)} stale claims` };
  };
}