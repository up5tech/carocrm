import type { Logger } from '@carocrm/core/logger/index.js';
import type { JobRegistry } from '@carocrm/jobs';
import type { Job } from 'bullmq';
import { Worker } from 'bullmq';
import type { Redis } from 'ioredis';

import { errorMessage } from '../db.js';
import { type JobPayload,parseJobPayload } from './job-payload.js';
import type { JobRepository } from './job-repository.js';
import { runJob } from './job-runner.js';

/**
 * BullMQ consumer for the `crm-jobs` queue.
 *
 * Retries: BullMQ is configured with `attempts` (default 3) and an exponential backoff
 * strategy capped at `backoffMaxMs`. Every attempt gets its own `jobs` row so the history
 * (and the last error) stays queryable — that is the dead-letter trail.
 */
export interface JobConsumerOptions {
  queueName: string;
  connection: Redis;
  registry: JobRegistry;
  repo: JobRepository;
  log: Logger;
  concurrency: number;
  attempts: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
}

export class JobConsumer {
  readonly worker: Worker<JobPayload>;

  constructor(private readonly options: JobConsumerOptions) {
    this.worker = new Worker<JobPayload>(
      options.queueName,
      (job: Job<JobPayload>) => this.process(job),
      {
        connection: options.connection,
        concurrency: options.concurrency,
        name: `worker-${String(process.pid)}`,
        settings: {
          backoffStrategy: (attemptsMade: number): number =>
            Math.min(2 ** Math.max(0, attemptsMade) * options.backoffBaseMs, options.backoffMaxMs),
        },
      },
    );

    this.worker.on('ready', () => {
      this.options.log.info(
        {
          queue: this.options.queueName,
          concurrency: this.options.concurrency,
          jobs: this.options.registry.list(),
        },
        'job consumer ready',
      );
    });

    // BullMQ types this listener as (job, error, previousState); the final-attempt flag is
    // derived from the job's own attempt counters.
    this.worker.on('failed', (job: Job<JobPayload> | undefined, error: Error) => {
      const allowed = job?.opts.attempts;
      const attemptsMade = job?.attemptsMade ?? 0;
      const finalFailed = allowed === undefined ? true : attemptsMade >= allowed;
      this.options.log.error(
        {
          queueJobId: job?.id ?? null,
          jobName: job?.name ?? null,
          attemptsMade,
          allowedAttempts: allowed ?? this.options.attempts,
          finalFailed,
          error: error.message,
        },
        finalFailed ? 'bullmq job permanently failed (dead letter)' : 'bullmq job failed, retrying',
      );
    });

    this.worker.on('error', (error: Error) => {
      this.options.log.error({ error: errorMessage(error) }, 'bullmq worker error');
    });
  }

  start(): void {
    this.options.log.info({ queue: this.options.queueName }, 'job consumer started');
  }

  async stop(): Promise<void> {
    await this.worker.close();
    this.options.log.info('job consumer stopped');
  }

  private async process(job: Job<JobPayload>): Promise<Record<string, unknown>> {
    const payload = parseJobPayload(job.data);
    if (payload === undefined) {
      // A payload that does not match `{ job, data }` will never become valid on retry.
      this.options.log.error(
        { queueJobId: job.id, data: job.data },
        'malformed job payload, expected { job: string, data: object }',
      );
      return { skipped: 'malformed_payload' };
    }

    const attempt = Math.max(1, job.attemptsMade + 1);
    const maxAttempts = typeof job.opts.attempts === 'number' ? job.opts.attempts : this.options.attempts;
    const outcome = await runJob(
      { registry: this.options.registry, repo: this.options.repo, log: this.options.log },
      { payload, queueJobId: String(job.id ?? ''), attempt, maxAttempts },
    );

    if (outcome.status === 'completed') return outcome.result;
    if (!outcome.retry) return { failed: true, message: outcome.message };
    throw new Error(outcome.message);
  }
}
