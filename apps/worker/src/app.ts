import type { Logger } from '@carocrm/core/logger/index.js';
import { JobRegistry } from '@carocrm/jobs';

import { createPool, errorMessage, type Queryable } from './db.js';
import type { WorkerConfig } from './env.js';
import { registerSystemJobs } from './handlers/job-handlers.js';
import { createKernelOutboxRegistry } from './handlers/outbox-handlers.js';
import { OutboxPoller } from './outbox/outbox-poller.js';
import { OutboxHandlerRegistry } from './outbox/outbox-registry.js';
import { closeRedisConnection, createRedisConnection } from './queue/connection.js';
import { JobConsumer } from './queue/job-consumer.js';
import { BullMqJobQueue } from './queue/job-queue.js';
import { JobRepository } from './queue/job-repository.js';
import { Scheduler } from './schedule/scheduler.js';

/**
 * Composition root of the worker process.
 *
 * Deliberately plain classes (no NestJS): the worker has no HTTP layer, so dependency
 * injection happens here with constructors, which keeps startup fast and testable.
 *
 * Three loops run side by side:
 *   1. `OutboxPoller`  — Postgres transactional outbox (every ~2s, 10 rows per claim).
 *   2. `JobConsumer`   — BullMQ worker for the `crm-jobs` queue (3 attempts, backoff).
 *   3. `Scheduler`     — `scheduled_jobs` cron reload (every 30s) -> BullMQ enqueue.
 *
 * Modules plug in through `jobRegistry` / `outboxRegistry` before `start()` is called.
 */
export class WorkerApplication {
  readonly jobRegistry: JobRegistry;
  readonly outboxRegistry: OutboxHandlerRegistry;

  private readonly pool = createPool(this.config.databaseUrl, Math.max(5, this.config.jobConcurrency + 2));
  private readonly db: Queryable = this.pool;
  private readonly repo = new JobRepository(this.db);
  private readonly queueRedis = createRedisConnection(this.config.redisUrl, this.log, 'queue');
  private readonly workerRedis = createRedisConnection(this.config.redisUrl, this.log, 'worker');
  private readonly jobQueue: BullMqJobQueue;
  private readonly jobConsumer: JobConsumer;
  private readonly scheduler: Scheduler;
  private readonly outboxPoller: OutboxPoller;
  private started = false;
  private stopped = false;

  constructor(
    private readonly config: WorkerConfig,
    private readonly log: Logger,
  ) {
    this.jobRegistry = new JobRegistry();
    registerSystemJobs(this.jobRegistry, { db: this.db, log: this.log });

    this.outboxRegistry = createKernelOutboxRegistry(this.log);

    this.jobQueue = new BullMqJobQueue({
      queueName: this.config.queueName,
      connection: this.queueRedis,
      db: this.db,
      log: this.log,
      attempts: this.config.jobAttempts,
      backoffBaseMs: this.config.jobBackoffBaseMs,
      backoffMaxMs: this.config.jobBackoffMaxMs,
    });

    this.jobConsumer = new JobConsumer({
      queueName: this.config.queueName,
      connection: this.workerRedis,
      registry: this.jobRegistry,
      repo: this.repo,
      log: this.log,
      concurrency: this.config.jobConcurrency,
      attempts: this.config.jobAttempts,
      backoffBaseMs: this.config.jobBackoffBaseMs,
      backoffMaxMs: this.config.jobBackoffMaxMs,
    });

    this.scheduler = new Scheduler({
      db: this.db,
      enqueue: this.jobQueue,
      log: this.log,
      intervalMs: this.config.schedulerIntervalMs,
    });

    this.outboxPoller = new OutboxPoller({
      db: this.db,
      registry: this.outboxRegistry,
      log: this.log,
      intervalMs: this.config.outboxPollIntervalMs,
      batchSize: this.config.outboxBatchSize,
      maxAttempts: this.config.outboxMaxAttempts,
      backoffBaseMs: this.config.outboxBackoffBaseMs,
      backoffMaxMs: this.config.outboxBackoffMaxMs,
    });
  }

  get queue(): BullMqJobQueue {
    return this.jobQueue;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.log.info(
      {
        queue: this.config.queueName,
        redis: redactUrl(this.config.redisUrl),
        database: redactUrl(this.config.databaseUrl),
        outboxHandlers: this.outboxRegistry.list(),
        jobHandlers: this.jobRegistry.list(),
        outboxPollIntervalMs: this.config.outboxPollIntervalMs,
        outboxBatchSize: this.config.outboxBatchSize,
        schedulerIntervalMs: this.config.schedulerIntervalMs,
        jobAttempts: this.config.jobAttempts,
        jobConcurrency: this.config.jobConcurrency,
      },
      'worker starting',
    );

    // Fail fast when Postgres or Redis is unreachable.
    await this.pool.query('SELECT 1');
    await this.queueRedis.ping();

    this.outboxPoller.start();
    this.jobConsumer.start();
    this.scheduler.start();
    this.log.info('worker ready');
  }

  /** Graceful shutdown: stop taking new work, let in-flight handlers finish, then release handles. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const step = async (name: string, action: () => Promise<void>): Promise<void> => {
      try {
        await action();
      } catch (error: unknown) {
        this.log.warn({ step: name, error: errorMessage(error) }, 'shutdown step failed');
      }
    };

    await step('outbox', async () => this.outboxPoller.stop());
    await step('scheduler', async () => this.scheduler.stop());
    await step('jobConsumer', async () => this.jobConsumer.stop());
    await step('jobQueue', async () => this.jobQueue.close());
    await step('workerRedis', async () => closeRedisConnection(this.workerRedis, this.log, 'worker'));
    await step('queueRedis', async () => closeRedisConnection(this.queueRedis, this.log, 'queue'));
    await step('pgPool', async () => this.pool.end());
    this.log.info('worker stopped');
  }
}

/** Removes credentials from a connection URL before it reaches the log. */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password !== '') parsed.password = '***';
    return parsed.toString();
  } catch {
    return url;
  }
}
