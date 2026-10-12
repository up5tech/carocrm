import type { Logger } from '@carocrm/core/logger/index.js';
import type { ExtensionHost } from '@carocrm/extension-sdk';
import { ExtensionHost as EmptyHost } from '@carocrm/extension-sdk';
import { JobRegistry } from '@carocrm/jobs';

import { registerBpm } from './bpm/index.js';
import { createPool, errorMessage, type Queryable } from './db.js';
import type { WorkerConfig } from './env.js';
import { DomainEventBus } from './events/domain-event-bus.js';
import { loadExtensionConfig } from './extensions.js';
import { registerSystemJobs } from './handlers/job-handlers.js';
import { registerMailJobs } from './handlers/mail-handlers.js';
import { createKernelOutboxSetup } from './handlers/outbox-handlers.js';
import { registerReportJobs } from './handlers/report-handlers.js';
import { createMailTransportForWorker } from './mail.js';
import { OutboxPoller } from './outbox/outbox-poller.js';
import { OutboxHandlerRegistry } from './outbox/outbox-registry.js';
import { closeRedisConnection, createRedisConnection } from './queue/connection.js';
import { JobConsumer } from './queue/job-consumer.js';
import { BullMqJobQueue } from './queue/job-queue.js';
import { JobRepository } from './queue/job-repository.js';
import { Scheduler } from './schedule/scheduler.js';
import { createStorage } from './storage.js';
import { registerWorkflows } from './workflows/index.js';

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
  /** Subscribe automation here before `start()`; `entity.*` outbox events fan out through it. */
  readonly domainEvents: DomainEventBus;

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
    /** Packages loaded by `loadWorkerExtensions()` before start (PLAN §38.3). */
    private readonly extensions: ExtensionHost = EmptyHost.empty(),
  ) {
    this.jobRegistry = new JobRegistry();
    const storage = createStorage(this.config);
    registerSystemJobs(this.jobRegistry, {
      db: this.db,
      log: this.log,
      storage,
      uploadExpiryHours: this.config.uploadExpiryHours,
    });
    // Email is delivered here, never in the API process; `none` keeps it inert until SMTP exists.
    const mailTransport = createMailTransportForWorker(this.config);
    registerMailJobs(this.jobRegistry, {
      db: this.db,
      log: this.log,
      transport: mailTransport,
      storage,
      // Per-account sends decrypt stored credentials with this key (PLAN §28.3).
      encryptionKey: this.config.encryptionKey,
    });
    registerReportJobs(this.jobRegistry, {
      db: this.db,
      apiBaseUrl: this.config.apiBaseUrl,
      secret: this.config.reportWorkerSecret,
      transport: mailTransport,
      log: this.log,
    });
    this.registerExtensionJobs();

    const outbox = createKernelOutboxSetup(this.log);
    this.outboxRegistry = outbox.registry;
    this.domainEvents = outbox.events;
    this.registerExtensionDomainEvents();

    this.jobQueue = new BullMqJobQueue({
      queueName: this.config.queueName,
      connection: this.queueRedis,
      db: this.db,
      log: this.log,
      attempts: this.config.jobAttempts,
      backoffBaseMs: this.config.jobBackoffBaseMs,
      backoffMaxMs: this.config.jobBackoffMaxMs,
    });

    // After the queue exists: a workflow run is enqueued through it, like every other job.
    this.registerWorkflows();
    this.registerBpm();

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

  /**
   * Registers each extension's job handlers and domain-event subscribers (PLAN §24, §38.3).
   *
   * Registration happens in the constructor, before any loop starts, so a package can never receive
   * a job after `start()` but register its handler afterwards. Namespaced subscriber names keep
   * `GET /api/v1/DomainEvent`-style introspection readable.
   */
  private registerExtensionJobs(): void {
    for (const { extension, job } of this.extensions.jobs()) {
      if (this.jobRegistry.has(job.name)) {
        this.log.error({ extension, job: job.name }, 'extension job name is already registered; skipping');
        continue;
      }
      this.jobRegistry.register(job.name, job.handler);
    }
  }

  /**
   * Wires the workflow engine (PLAN §35).
   *
   * It subscribes to domain events and registers `workflow.run`, `workflow.resume` and
   * `system.cleanupWorkflowRuns`, and it enqueues through this worker's own queue — so an automation
   * is ordinary background work: retryable, cancellable and visible in the Jobs admin page.
   */
  private registerWorkflows(): void {
    registerWorkflows({
      db: this.db,
      log: this.log,
      registry: this.jobRegistry,
      domainEvents: this.domainEvents,
      enqueue: async (job, data) => this.jobQueue.enqueue(job, data),
    });
  }

  /**
   * Wires the BPM jobs (PLAN §36).
   *
   * Registers `bpm.serviceTask` and `bpm.taskTimer` — the two things the API arms when a process
   * moves: running a dispatched action, and firing a task's due/escalation timer. Both reuse the
   * workflow action catalog and the ordinary §24 queue, so process work is background work too.
   */
  private registerBpm(): void {
    registerBpm({
      db: this.db,
      log: this.log,
      registry: this.jobRegistry,
      enqueue: async (job, data) => this.jobQueue.enqueue(job, data),
    });
  }

  /** Subscribes each extension's domain-event handlers (PLAN §23.2), namespaced by package id. */
  private registerExtensionDomainEvents(): void {
    for (const { extension, subscription } of this.extensions.domainEvents()) {
      this.domainEvents.subscribe({
        eventType: subscription.eventType,
        name: `${extension}:${subscription.name}`,
        handler: subscription.handler,
      });
    }
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
        domainSubscribers: this.domainEvents.list().map((subscriber) => subscriber.eventType),
        jobHandlers: this.jobRegistry.list(),
        outboxPollIntervalMs: this.config.outboxPollIntervalMs,
        outboxBatchSize: this.config.outboxBatchSize,
        schedulerIntervalMs: this.config.schedulerIntervalMs,
        jobAttempts: this.config.jobAttempts,
        jobConcurrency: this.config.jobConcurrency,
        extensions: this.extensions.extensions.map((extension) => `${extension.id}@${extension.version}`),
      },
      'worker starting',
    );

    // Fail fast when Postgres or Redis is unreachable.
    await this.pool.query('SELECT 1');
    await this.queueRedis.ping();

    await this.runExtensionSetups();

    this.outboxPoller.start();
    this.jobConsumer.start();
    this.scheduler.start();
    this.log.info('worker ready');
  }

  /**
   * Hands each package its {@link ExtensionApi} facade, in load order (PLAN §38.3). A failing
   * `setup()` stops the worker: a package that cannot initialise must not look installed.
   */
  private async runExtensionSetups(): Promise<void> {
    for (const { id, setup } of this.extensions.setups()) {
      const extension = this.extensions.get(id);
      if (extension === undefined) continue;
      const config = await loadExtensionConfig(this.db, id);
      await setup({
        id: extension.id,
        name: extension.name,
        version: extension.version,
        dir: extension.dir,
        log: this.log,
        db: { query: async (sql, params) => (await this.pool.query(sql, params as unknown[])).rows },
        enqueue: async (job, data) => this.jobQueue.enqueue(job, data ?? {}),
        getConfig: <T>(key: string, fallback: T) => (config[key] === undefined ? fallback : (config[key] as T)),
        setConfig: async (key, value) => {
          config[key] = value;
          await this.pool.query(
            `INSERT INTO app_settings (name, data) VALUES ($1, $2::jsonb)
             ON CONFLICT (name) DO UPDATE SET data = EXCLUDED.data, modified_at = now()`,
            [`extension:${extension.id}`, JSON.stringify(config)],
          );
        },
        // The worker does not serve metadata; packages that need it use the API's metadata service.
        metadata: () => this.extensions.mergedMetadata() as unknown as Record<string, unknown>,
      });
    }
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
