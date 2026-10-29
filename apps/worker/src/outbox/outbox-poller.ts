import type { Logger } from '@carocrm/core/logger/index.js';
import type { OutboxEvent } from '@carocrm/jobs';

import { equalJitterDelayMs, exponentialDelayMs } from '../backoff.js';
import {
  asRecord,
  errorMessage,
  type Queryable,
  type Row,
  rowNumber,
  rowString,
  truncate,
} from '../db.js';
import type { OutboxHandlerRegistry } from './outbox-registry.js';

/**
 * Transactional-outbox consumer (PLAN §23.2).
 *
 * Claims a batch of `pending` events with `FOR UPDATE SKIP LOCKED` so several worker
 * instances can poll the same table safely, flips them to `running`, dispatches to the
 * registered handler, then writes the terminal state:
 *
 * - success            -> `processed` + `processed_at`
 * - handler throw       -> `pending` + `available_at = now() + backoff`, `attempts + 1`
 * - attempts exhausted  -> `failed` (dead letter, `last_error` kept)
 * - unknown event type  -> `processed` (warning logged, never clogs the queue)
 */

/**
 * Claim a batch, and re-claim a `running` row whose lease expired.
 *
 * A claim is committed before the handler runs, so a worker that dies mid-handler leaves the row
 * `running` forever unless something takes it back. The lease is written into `available_at` when
 * the row is claimed; once it passes, any worker may claim the row again. That makes dispatch
 * **at-least-once** across a crash (handlers are idempotent by contract), instead of silently
 * losing the event.
 */
export const CLAIM_SQL = `
  UPDATE outbox_events
     SET status = 'running',
         available_at = now() + make_interval(secs => $2::double precision)
   WHERE id IN (
           SELECT id
             FROM outbox_events
            WHERE status IN ('pending', 'running')
              AND available_at <= now()
            ORDER BY available_at, created_at
               FOR UPDATE SKIP LOCKED
              LIMIT $1
         )
     AND status IN ('pending', 'running')
  RETURNING id, event_type, payload, attempts
`;

export const MARK_PROCESSED_SQL = `
  UPDATE outbox_events
     SET status = 'processed',
         processed_at = now(),
         last_error = NULL
   WHERE id = $1
`;

/**
 * One statement for the failure path: bump attempts, schedule the retry with backoff, and
 * promote to `failed` once `maxAttempts` is reached.
 */
export const MARK_RETRY_SQL = `
  UPDATE outbox_events
     SET status = CASE WHEN attempts + 1 >= $2::int THEN 'failed' ELSE 'pending' END,
         attempts = attempts + 1,
         available_at = now() + make_interval(secs => $3::double precision),
         last_error = $4
   WHERE id = $1
  RETURNING status, attempts
`;

export interface ClaimedEvent {
  id: string;
  eventType: string;
  payload: Record<string, unknown>;
  attempts: number;
}

export type EventOutcome = 'processed' | 'retried' | 'failed' | 'unknown';

export function retryDelayMs(attempts: number, baseMs: number, maxMs: number, random: () => number = Math.random): number {
  // Exponential and capped, then equal-jittered — attempts is the count *before* this failure, so the
  // very first retry waits somewhere between baseMs/2 and baseMs. The jitter (G15) keeps a fleet of
  // workers that failed together from retrying together, and the `random` parameter keeps the delay
  // testable.
  return equalJitterDelayMs(exponentialDelayMs(attempts, baseMs, maxMs), random);
}

export function mapClaimedEvent(row: Row): ClaimedEvent {
  return {
    id: rowString(row, 'id'),
    eventType: rowString(row, 'event_type'),
    payload: asRecord(row['payload']),
    attempts: rowNumber(row, 'attempts'),
  };
}

export interface OutboxPollerOptions {
  db: Queryable;
  registry: OutboxHandlerRegistry;
  log: Logger;
  intervalMs: number;
  batchSize: number;
  maxAttempts: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  /** How long a claim may stay `running` before another worker may take it back (22.18). */
  leaseMs: number;
  /** Injectable random for the retry jitter (G15), so the delay is testable. */
  random?: () => number;
}

export class OutboxPoller {
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> | undefined;
  private running = false;

  constructor(private readonly options: OutboxPollerOptions) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.options.log.info(
      {
        intervalMs: this.options.intervalMs,
        batchSize: this.options.batchSize,
        handlers: this.options.registry.list(),
      },
      'outbox poller started',
    );
    this.scheduleNext(0);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const inFlight = this.inFlight;
    if (inFlight !== undefined) await inFlight;
    this.inFlight = undefined;
    this.options.log.info('outbox poller stopped');
  }

  /** Runs a single claim + dispatch cycle and returns the claimed events. */
  async tick(): Promise<ClaimedEvent[]> {
    const claimed = await this.claim();
    if (claimed.length === 0) return claimed;
    for (const event of claimed) {
      const outcome = await this.dispatch(event);
      this.options.log.info({ eventId: event.id, eventType: event.eventType, outcome }, 'outbox event handled');
    }
    return claimed;
  }

  private scheduleNext(delayMs: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.inFlight = this.runCycle();
    }, delayMs);
    this.timer.unref?.();
  }

  private async runCycle(): Promise<void> {
    if (!this.running) return;
    const startedAt = Date.now();
    try {
      await this.tick();
    } catch (error: unknown) {
      // A claim/write failure is always retryable: the rows stay `pending` in the DB.
      this.options.log.error({ error: errorMessage(error) }, 'outbox poll cycle failed');
    }
    const wait = Math.max(0, this.options.intervalMs - (Date.now() - startedAt));
    this.scheduleNext(wait);
  }

  private async claim(): Promise<ClaimedEvent[]> {
    const result = await this.options.db.query(CLAIM_SQL, [this.options.batchSize, this.options.leaseMs / 1000]);
    return result.rows.map((row) => mapClaimedEvent(row));
  }

  private async dispatch(event: ClaimedEvent): Promise<EventOutcome> {
    const handler = this.options.registry.get(event.eventType);
    if (handler === undefined) {
      this.options.log.warn(
        { eventId: event.id, eventType: event.eventType },
        'no outbox handler registered for event type, marking processed',
      );
      await this.markProcessed(event.id);
      return 'unknown';
    }

    try {
      await handler(toOutboxEvent(event));
    } catch (error: unknown) {
      return await this.markFailure(event, error);
    }
    await this.markProcessed(event.id);
    return 'processed';
  }

  private async markProcessed(id: string): Promise<void> {
    await this.options.db.query(MARK_PROCESSED_SQL, [id]);
  }

  private async markFailure(event: ClaimedEvent, error: unknown): Promise<EventOutcome> {
    const message = truncate(errorMessage(error));
    const delayMs = retryDelayMs(event.attempts, this.options.backoffBaseMs, this.options.backoffMaxMs, this.options.random);
    let outcome: EventOutcome = 'retried';
    try {
      const result = await this.options.db.query(MARK_RETRY_SQL, [
        event.id,
        this.options.maxAttempts,
        delayMs / 1000,
        message,
      ]);
      const row = result.rows[0];
      if (row !== undefined && rowString(row, 'status') === 'failed') outcome = 'failed';
    } catch (dbError: unknown) {
      this.options.log.error(
        { eventId: event.id, error: errorMessage(dbError) },
        'failed to record outbox retry',
      );
      return 'retried';
    }
    this.options.log.error(
      {
        eventId: event.id,
        eventType: event.eventType,
        error: message,
        nextOutcome: outcome,
        retryInMs: outcome === 'failed' ? null : delayMs,
      },
      'outbox handler failed',
    );
    return outcome;
  }
}

export function toOutboxEvent(event: ClaimedEvent): OutboxEvent {
  return { id: event.id, eventType: event.eventType, payload: event.payload };
}
