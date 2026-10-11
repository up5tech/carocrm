import { randomUUID } from 'node:crypto';

import { InternalServerError } from '@carocrm/core/errors/index.js';
import { Inject, Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

import type { AppConfig } from '../config.js';
import { CONFIG_TOKEN } from '../config.js';

export const JOB_QUEUE_NAME = 'crm-jobs';

interface Producer {
  add(name: string, data: Record<string, unknown>, jobId?: string): Promise<{ id?: string | number }>;
  removeJob(id: string): Promise<boolean>;
  counts(): Promise<Record<string, number>>;
  close(): Promise<void>;
}

/**
 * BullMQ producer for the API process (PLAN §24): Nest enqueues, the worker consumes. The `jobs`
 * table stays the durable record — Redis only carries the queue — so a Redis outage is reported as
 * a clear 500 instead of taking the API down (the connection is lazy).
 *
 * `BullMqProducer` is the real implementation; `JobQueueService` keeps the port injectable, so a
 * test can observe enqueues without a Redis server.
 */
export interface JobQueuePort {
  readonly queueName: string;
  enqueue(input: { job: string; data: Record<string, unknown>; jobRowId?: string | undefined; jobId?: string | undefined }): Promise<string>;
  remove(queueJobId: string | null): Promise<boolean>;
  counts(): Promise<Record<string, number>>;
}

class BullMqProducer implements Producer {
  private readonly queue: Queue;
  private readonly connection: Redis;

  constructor(queueName: string, redisUrl: string, attempts: number, backoffBaseMs: number) {
    // BullMQ requires maxRetriesPerRequest: null; lazyConnect keeps the API up when Redis is down.
    this.connection = new Redis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: false, lazyConnect: true });
    this.queue = new Queue(queueName, {
      connection: this.connection,
      defaultJobOptions: {
        attempts,
        backoff: { type: 'exponential', delay: backoffBaseMs },
        removeOnComplete: { age: 600, count: 50 },
        removeOnFail: { age: 7 * 24 * 3600 },
      },
    });
  }

  async add(name: string, data: Record<string, unknown>, jobId?: string): Promise<{ id?: string | number }> {
    return this.queue.add(name, data, jobId === undefined ? {} : { jobId });
  }

  async removeJob(id: string): Promise<boolean> {
    const job = await this.queue.getJob(id);
    if (job === null || job === undefined) return false;
    // BullMQ refuses to remove an active job; the runner's cancel flag covers that case.
    await job.remove();
    return true;
  }

  async counts(): Promise<Record<string, number>> {
    return (await this.queue.getJobCounts()) as unknown as Record<string, number>;
  }

  async close(): Promise<void> {
    await this.queue.close();
    if (this.connection.status !== 'end') await this.connection.quit();
  }
}

@Injectable()
export class JobQueueService implements JobQueuePort {
  readonly queueName: string;
  private readonly producer: Producer;

  constructor(@Inject(CONFIG_TOKEN) config: AppConfig) {
    this.queueName = config.jobQueueName;
    this.producer = new BullMqProducer(this.queueName, config.redisUrl, config.jobAttempts, config.jobBackoffBaseMs);
  }

  async enqueue(input: {
    job: string;
    data: Record<string, unknown>;
    jobRowId?: string | undefined;
    jobId?: string | undefined;
  }): Promise<string> {
    const payload: Record<string, unknown> = {
      job: input.job,
      data: input.data,
      ...(input.jobRowId === undefined ? {} : { jobRowId: input.jobRowId }),
    };
    let added: { id?: string | number };
    try {
      added = await this.producer.add(input.job, payload, input.jobId);
    } catch (error: unknown) {
      throw new InternalServerError(`Could not enqueue "${input.job}": the job queue is unreachable.`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (added.id === undefined) throw new InternalServerError(`The queue did not return a job id for "${input.job}".`);
    return String(added.id);
  }

  /** Only a waiting job can be removed; an active one is cancelled cooperatively by the runner. */
  async remove(queueJobId: string | null): Promise<boolean> {
    if (queueJobId === null) return false;
    try {
      return await this.producer.removeJob(queueJobId);
    } catch {
      return false;
    }
  }

  async counts(): Promise<Record<string, number>> {
    try {
      return await this.producer.counts();
    } catch {
      return {};
    }
  }
}

/** Deterministic queue id for a "run now" of a schedule, so a double click cannot queue twice. */
export function manualScheduleJobId(scheduleId: string): string {
  return `manual_${scheduleId}_${randomUUID().slice(0, 8)}`;
}
