import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { log } from '@carocrm/core/logger/index.js';

import { createPool, errorMessage, type Queryable } from '../db.js';
import { loadWorkerConfig, type WorkerConfig } from '../env.js';
import { closeRedisConnection, createRedisConnection } from '../queue/connection.js';
import { BullMqJobQueue } from '../queue/job-queue.js';

/**
 * Producer CLI — enqueue kernel/registered jobs or manage `scheduled_jobs` from the outside.
 * Used by `scripts/worker-smoke.sh` and handy for ops.
 *
 *   tsx apps/worker/src/tools/enqueue-cli.ts <job> [jsonObject]
 *   tsx apps/worker/src/tools/enqueue-cli.ts --schedule <id> <cron> <job> [jsonObject]
 *   tsx apps/worker/src/tools/enqueue-cli.ts --unschedule <id>
 *   tsx apps/worker/src/tools/enqueue-cli.ts --stats
 *
 * Exits non-zero on failure so shell scripts can assert on it.
 */
export async function run(args: readonly string[]): Promise<number> {
  const config = loadWorkerConfig();
  log.level = config.logLevel;

  const pool = createPool(config.databaseUrl, 1);
  const redis = createRedisConnection(config.redisUrl, log, 'cli');
  const queue = new BullMqJobQueue({
    queueName: config.queueName,
    connection: redis,
    db: pool,
    log,
    attempts: config.jobAttempts,
    backoffBaseMs: config.jobBackoffBaseMs,
    backoffMaxMs: config.jobBackoffMaxMs,
  });

  try {
    return await dispatch(queue, pool, args, config);
  } catch (error: unknown) {
    write(`enqueue-cli failed: ${errorMessage(error)}`);
    return 1;
  } finally {
    await closeStep(queue.close());
    await closeStep(closeRedisConnection(redis, log, 'cli'));
    await closeStep(pool.end());
  }
}

async function dispatch(
  queue: BullMqJobQueue,
  pool: Queryable,
  args: readonly string[],
  config: WorkerConfig,
): Promise<number> {
  const command = args[0];
  const rest = args.slice(1);
  if (command === undefined) return usage();

  if (command === '--stats') {
    write(`${config.queueName}: ${JSON.stringify(await queue.counts())}`);
    const schedules = await pool.query(`SELECT id, job, scheduling, enabled, last_run_at FROM scheduled_jobs ORDER BY id`);
    write(`scheduled_jobs: ${JSON.stringify(schedules.rows)}`);
    const jobs = await pool.query(`SELECT job, status, COUNT(*)::int AS total FROM jobs GROUP BY job, status ORDER BY job, status`);
    write(`jobs: ${JSON.stringify(jobs.rows)}`);
    const outbox = await pool.query(`SELECT status, COUNT(*)::int AS total FROM outbox_events GROUP BY status ORDER BY status`);
    write(`outbox_events: ${JSON.stringify(outbox.rows)}`);
    return 0;
  }

  if (command === '--schedule') {
    const id = rest[0];
    const cron = rest[1];
    const job = rest[2];
    if (id === undefined || cron === undefined || job === undefined) return usage();
    await queue.schedule(id, job, cron, parseData(rest[3]));
    write(`scheduled ${id}: ${job} (${cron})`);
    return 0;
  }

  if (command === '--unschedule') {
    const id = rest[0];
    if (id === undefined) return usage();
    await queue.unschedule(id);
    write(`unscheduled ${id}`);
    return 0;
  }

  const queueJobId = await queue.enqueue(command, parseData(rest[0]));
  write(`enqueued ${command} as ${queueJobId} on ${config.queueName}`);
  return 0;
}

function usage(): number {
  write(
    'usage: enqueue-cli <job> [jsonObject] | --schedule <id> <cron> <job> [jsonObject] | --unschedule <id> | --stats',
  );
  return 2;
}

async function closeStep(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
  } catch (error: unknown) {
    log.warn({ error: errorMessage(error) }, 'cli cleanup step failed');
  }
}

function parseData(raw: string | undefined): Record<string, unknown> {
  if (raw === undefined || raw === '') return {};
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Job data must be a JSON object.');
  }
  return parsed as Record<string, unknown>;
}

function write(line: string): void {
  process.stdout.write(`${line}\n`);
}

const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  run(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      write(`enqueue-cli crashed: ${errorMessage(error)}`);
      process.exitCode = 1;
    });
}
