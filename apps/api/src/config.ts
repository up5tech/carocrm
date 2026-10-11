import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { z } from 'zod';

const ConfigSchema = z.object({
  port: z.coerce.number().int().default(3030),
  host: z.string().default('127.0.0.1'),
  databaseUrl: z.string().default('postgres://postgres:postgres@127.0.0.1:5432/carocrm_dev'),
  databaseAdminUrl: z.string().default('postgres://postgres:postgres@127.0.0.1:5432/postgres'),
  redisUrl: z.string().default('redis://127.0.0.1:6379'),
  jwtSecret: z.string().min(8).default('dev-only-secret-change-me'),
  accessTokenTtlSeconds: z.coerce.number().int().default(900),
  refreshTokenTtlSeconds: z.coerce.number().int().default(60 * 60 * 24 * 14),
  storageRoot: z.string().default('.data/files'),
  logLevel: z.string().default('info'),
  corsOrigins: z.string().default(''),
  /** Storage driver for attachments: local disk, AWS S3 or a MinIO-compatible endpoint. */
  storageDriver: z.enum(['local', 's3', 'minio']).default('local'),
  s3Bucket: z.string().default(''),
  s3Region: z.string().default(''),
  /** Only used by the s3/minio drivers; empty means the SDK default endpoint. */
  s3Endpoint: z.string().default(''),
  s3AccessKeyId: z.string().default(''),
  s3SecretAccessKey: z.string().default(''),
  /** "" = derive (MinIO uses path style), otherwise an explicit true/false. */
  s3ForcePathStyle: z.string().default(''),
  /** Upload ceiling in megabytes, enforced while streaming (PLAN §25 file size limits). */
  uploadMaxMb: z.coerce.number().int().min(1).max(2000).default(25),
  /** Chunk size accepted by the chunked upload API. */
  uploadChunkMaxMb: z.coerce.number().int().min(1).max(128).default(8),
  /** Lifetime of a pre-signed download URL for object storage. */
  signedUrlTtlSeconds: z.coerce.number().int().min(30).max(86_400).default(900),
  /** 'none' turns the malware hook off; 'signature' runs the built-in scanner (PLAN §25). */
  malwareScanMode: z.enum(['signature', 'none']).default('signature'),
  /**
   * Outbound mail transport (PLAN §28.1). `none` is the default so an installation that has not
   * configured SMTP cannot send mail by accident. The `SMTP_*` settings themselves are parsed by
   * `@carocrm/mail` from the environment, and a broken `smtp` configuration fails at boot.
   */
  mailTransport: z.enum(['none', 'memory', 'smtp', 'relay']).default('none'),
  /** Global API rate limit per minute; the SPA spends many small calls per screen. */
  rateLimitMax: z.coerce.number().int().positive().default(300),
  /** BullMQ queue the API produces into; must match the worker's WORKER_QUEUE_NAME. */
  jobQueueName: z.string().min(1).default('crm-jobs'),
  jobAttempts: z.coerce.number().int().min(1).max(10).default(3),
  jobBackoffBaseMs: z.coerce.number().int().min(100).default(2_000),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

/** True/False from an env string; undefined when unset so a caller can apply its own default. */
export function parseBooleanSetting(value: string): boolean | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === '') return undefined;
  return ['1', 'true', 'yes', 'on'].includes(normalized);
}

function loadDotEnv(): void {
  let dir = process.cwd();
  for (let depth = 0; depth < 4; depth++) {
    const candidate = resolve(dir, '.env');
    if (existsSync(candidate)) {
      const content = readFileSync(candidate, 'utf8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (trimmed === '' || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq < 0) continue;
        const key = trimmed.slice(0, eq).trim();
        let value = trimmed.slice(eq + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        if (process.env[key] === undefined) process.env[key] = value;
      }
      return;
    }
    const parent = resolve(dir, '..');
    if (parent === dir) return;
    dir = parent;
  }
}

export function buildConfig(): AppConfig {
  loadDotEnv();
  return ConfigSchema.parse({
    port: process.env.APP_PORT,
    host: process.env.APP_HOST,
    databaseUrl: process.env.DATABASE_URL,
    databaseAdminUrl: process.env.DATABASE_ADMIN_URL,
    redisUrl: process.env.REDIS_URL,
    jwtSecret: process.env.JWT_SECRET,
    accessTokenTtlSeconds: process.env.ACCESS_TOKEN_TTL,
    refreshTokenTtlSeconds: process.env.REFRESH_TOKEN_TTL,
    storageRoot: process.env.STORAGE_ROOT,
    logLevel: process.env.LOG_LEVEL,
    corsOrigins: process.env.CORS_ORIGINS,
    rateLimitMax: process.env.RATE_LIMIT_MAX,
    storageDriver: process.env.STORAGE_DRIVER,
    s3Bucket: process.env.S3_BUCKET,
    s3Region: process.env.S3_REGION,
    s3Endpoint: process.env.S3_ENDPOINT,
    s3AccessKeyId: process.env.S3_ACCESS_KEY_ID,
    s3SecretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    s3ForcePathStyle: process.env.S3_FORCE_PATH_STYLE,
    uploadMaxMb: process.env.UPLOAD_MAX_MB,
    uploadChunkMaxMb: process.env.UPLOAD_CHUNK_MAX_MB,
    signedUrlTtlSeconds: process.env.SIGNED_URL_TTL_SECONDS,
    malwareScanMode: process.env.MALWARE_SCAN_MODE,
    mailTransport: process.env.MAIL_TRANSPORT,
    jobQueueName: process.env.JOB_QUEUE_NAME,
    jobAttempts: process.env.JOB_ATTEMPTS,
    jobBackoffBaseMs: process.env.JOB_BACKOFF_BASE_MS,
  });
}

export const CONFIG_TOKEN = Symbol('CONFIG');
