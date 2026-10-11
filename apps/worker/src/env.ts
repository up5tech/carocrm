import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { z } from 'zod';

/**
 * Worker configuration.
 *
 * Env loading mirrors `apps/api/src/config.ts`: a `.env` file is looked up by walking
 * up from `process.cwd()` (so running the worker from `apps/worker`, the repo root or
 * anywhere inside the monorepo works). The loader is intentionally a copy instead of an
 * import from the API package: the worker must not depend on the API application.
 */
const WorkerConfigSchema = z.object({
  databaseUrl: z.string().min(1).default('postgres://postgres:postgres@127.0.0.1:5432/carocrm_dev'),
  redisUrl: z.string().min(1).default('redis://127.0.0.1:6379'),
  queueName: z.string().min(1).default('crm-jobs'),
  logLevel: z.string().default('info'),
  /** Outbox poll cadence (spec: every ~2s). */
  outboxPollIntervalMs: z.coerce.number().int().min(50).max(600000).default(2000),
  /** Max `pending` outbox rows claimed per tick (spec: 10). */
  outboxBatchSize: z.coerce.number().int().min(1).max(100).default(10),
  /** Attempts after which an event becomes permanently `failed` (spec: 8). */
  outboxMaxAttempts: z.coerce.number().int().min(1).max(100).default(8),
  outboxBackoffBaseMs: z.coerce.number().int().min(100).max(60000).default(5000),
  /** Backoff ceiling (spec: 15 minutes). */
  outboxBackoffMaxMs: z.coerce.number().int().min(1000).max(86400000).default(900000),
  jobConcurrency: z.coerce.number().int().min(1).max(100).default(5),
  /** BullMQ attempts per job (spec: 3 with backoff). */
  jobAttempts: z.coerce.number().int().min(1).max(20).default(3),
  jobBackoffBaseMs: z.coerce.number().int().min(100).max(60000).default(5000),
  jobBackoffMaxMs: z.coerce.number().int().min(1000).max(86400000).default(900000),
  /** Scheduler reload cadence (spec: every 30s). */
  schedulerIntervalMs: z.coerce.number().int().min(250).max(600000).default(30000),
  /** Seconds an idle BullMQ worker waits for a job before its blocking connection loops. */
  jobBlockingTimeoutMs: z.coerce.number().int().min(1000).max(120000).default(5000),
  /** Attachment storage for `system.cleanupUploads` (same env keys as the API). */
  storageDriver: z.enum(['local', 's3', 'minio']).default('local'),
  storageRoot: z.string().default('.data/files'),
  s3Bucket: z.string().default(''),
  s3Region: z.string().default(''),
  s3Endpoint: z.string().default(''),
  s3AccessKeyId: z.string().default(''),
  s3SecretAccessKey: z.string().default(''),
  s3ForcePathStyle: z.string().default(''),
  /** Open uploads older than this are abandoned by the cleanup job. */
  uploadExpiryHours: z.coerce.number().int().min(1).max(24 * 30).default(24),
  /**
   * Outbound mail transport (PLAN §28.1), same env key as the API so a queued email is delivered by
   * whatever the front end was configured with. The `SMTP_*` settings themselves are parsed by
   * `@carocrm/mail` from the environment.
   */
  mailTransport: z.enum(['none', 'memory', 'smtp', 'relay']).default('none'),
  /**
   * Auto-stop after N ms (0 = run forever). Lets smoke tests and one-shot container runs get
   * a full graceful shutdown without sending signals.
   */
  runForMs: z.coerce.number().int().min(0).max(86400000).default(0),
});

export type WorkerConfig = z.infer<typeof WorkerConfigSchema>;

/**
 * Load `KEY=value` pairs from the first `.env` found while walking up from `startDir`.
 * Existing process.env values always win (same rule as the API config loader).
 */
export function loadEnv(startDir: string = process.cwd()): string | undefined {
  let dir = startDir;
  for (let depth = 0; depth < 5; depth++) {
    const candidate = resolve(dir, '.env');
    if (existsSync(candidate)) {
      applyDotEnv(readFileSync(candidate, 'utf8'));
      return candidate;
    }
    const parent = resolve(dir, '..');
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

function applyDotEnv(content: string): void {
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function buildWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  return WorkerConfigSchema.parse({
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    queueName: env.WORKER_QUEUE_NAME,
    logLevel: env.LOG_LEVEL,
    outboxPollIntervalMs: env.WORKER_OUTBOX_POLL_INTERVAL_MS,
    outboxBatchSize: env.WORKER_OUTBOX_BATCH_SIZE,
    outboxMaxAttempts: env.WORKER_MAX_ATTEMPTS,
    outboxBackoffBaseMs: env.WORKER_OUTBOX_BACKOFF_BASE_MS,
    outboxBackoffMaxMs: env.WORKER_OUTBOX_BACKOFF_MAX_MS,
    jobConcurrency: env.WORKER_JOB_CONCURRENCY,
    jobAttempts: env.WORKER_JOB_ATTEMPTS,
    jobBackoffBaseMs: env.WORKER_JOB_BACKOFF_BASE_MS,
    jobBackoffMaxMs: env.WORKER_JOB_BACKOFF_MAX_MS,
    schedulerIntervalMs: env.WORKER_SCHEDULER_INTERVAL_MS,
    jobBlockingTimeoutMs: env.WORKER_JOB_BLOCKING_TIMEOUT_MS,
    storageDriver: env.STORAGE_DRIVER,
    storageRoot: env.STORAGE_ROOT,
    s3Bucket: env.S3_BUCKET,
    s3Region: env.S3_REGION,
    s3Endpoint: env.S3_ENDPOINT,
    s3AccessKeyId: env.S3_ACCESS_KEY_ID,
    s3SecretAccessKey: env.S3_SECRET_ACCESS_KEY,
    s3ForcePathStyle: env.S3_FORCE_PATH_STYLE,
    uploadExpiryHours: env.WORKER_UPLOAD_EXPIRY_HOURS,
    mailTransport: env.MAIL_TRANSPORT,
    runForMs: env.WORKER_RUN_MS,
  });
}

/** Loads `.env` (walking up) and then builds the config — the entrypoint helper. */
export function loadWorkerConfig(): WorkerConfig {
  loadEnv();
  return buildWorkerConfig(process.env);
}
