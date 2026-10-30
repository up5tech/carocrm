import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PLATFORM_VERSION } from '@carocrm/extension-sdk';
import { z } from 'zod';

const ConfigSchema = z.object({
  port: z.coerce.number().int().default(3030),
  host: z.string().default('127.0.0.1'),
  databaseUrl: z.string().default('postgres://postgres:postgres@127.0.0.1:5432/carocrm_dev'),
  databaseAdminUrl: z.string().default('postgres://postgres:postgres@127.0.0.1:5432/postgres'),
  /**
   * Server-side ceiling on a single statement (G74). A query that waits on a lock, or a plan that
   * degrades, is cancelled by PostgreSQL instead of holding a request and one of the pool's ten
   * connections indefinitely. `0` disables the ceiling for a deployment whose exports/DDL legitimately
   * run longer; migrations, `pg_dump` and the seed scripts open their own connections and are
   * unaffected either way.
   */
  databaseStatementTimeoutMs: z.coerce.number().int().min(0).max(3_600_000).default(15_000),
  /** How long a statement may wait for a lock before PostgreSQL cancels it (G74); `0` disables it. */
  databaseLockTimeoutMs: z.coerce.number().int().min(0).max(3_600_000).default(5_000),
  /**
   * HTTP request deadline (G74). The rate limiter bounds how *often* a client calls, never how long
   * one call may take; without a deadline a pathological handler holds a client, a connection and a
   * slot in the pool for as long as it wants. Multipart uploads are exempt (the body streams for as
   * long as the upload lasts) and `0` disables the deadline.
   */
  requestTimeoutMs: z.coerce.number().int().min(0).max(600_000).default(30_000),
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
  /**
   * Global API rate limit per minute **per client**. The SPA spends many small calls per screen
   * (metadata, layout, preferences, the list itself), and a user clicking through pages can reach a
   * few hundred a minute without doing anything abusive — 300 turned ordinary paging into a 429
   * that blocked the whole session for the rest of the window.
   */
  rateLimitMax: z.coerce.number().int().positive().default(600),
  /**
   * Fastify `trustProxy`. Behind nginx/Traefik every request arrives from the proxy's address, so
   * without this the limiter puts **all** users into one bucket. `false` (default) keeps the socket
   * address, which is the safe choice when the API is exposed directly; `true` trusts the left-most
   * `X-Forwarded-For` hop, a number is the hop count, and a comma-separated list is a set of trusted
   * CIDR ranges.
   */
  trustProxy: z.string().default('false'),
  /** BullMQ queue the API produces into; must match the worker's WORKER_QUEUE_NAME. */
  jobQueueName: z.string().min(1).default('crm-jobs'),
  jobAttempts: z.coerce.number().int().min(1).max(10).default(3),
  jobBackoffBaseMs: z.coerce.number().int().min(100).default(2_000),
  /** Shared worker-to-API capability key; blank disables scheduled report delivery. */
  reportWorkerSecret: z.string().default(''),
  /**
   * Shared secret a marketing provider signs its webhook calls with (Phase 19-MA.10). Blank is the
   * default and means **no provider event is accepted**: a public constant would let anyone forge a
   * signature, so the ingestion path fails closed instead of falling back to one.
   */
  marketingWebhookSecret: z.string().default(''),
  /**
   * 32-byte hex key for secrets stored encrypted at rest (PLAN §28.3: mail account passwords).
   * Empty disables encrypted storage: saving a credential then fails with a clear message instead
   * of silently writing plaintext. Generate with `openssl rand -hex 32`.
   */
  encryptionKey: z.string().default(''),
  /**
   * Directory holding extension packages (PLAN §38). Every direct child with a `manifest.json` is
   * a package; only the ones an administrator installed (`installed_extensions`) are loaded. The
   * directory is deployment-owned, so there is no upload path at runtime.
   */
  extensionsDir: z.string().default('extensions'),
  /**
   * The OAuth **client ids** of the installed connectors, as a JSON object keyed by provider key,
   * e.g. `{"google-workspace":"1234.apps.googleusercontent.com"}`.
   *
   * A client id is not a secret, so it lives in the deployment configuration rather than in the
   * credential vault. The matching **client secret** is per connection and lives in the vault, so
   * two installations — or two connections of one installation — never share a secret.
   */
  integrationOauthClientIds: z.string().default('{}'),
  /** Version extensions are checked against; mirrors the platform release. */
  platformVersion: z.string().default(PLATFORM_VERSION),
});

/** The development default. MUST never be accepted in production (Phase 22.4 / PLAN §9). */
export const DEFAULT_JWT_SECRET = 'dev-only-secret-change-me';

/**
 * Phase 22.4 (PLAN §9, task 1/3) — the development default JWT secret must never be accepted in
 * production. A known, guessable secret lets anyone forge session tokens, which is a full
 * authentication bypass. We fail closed at boot so the misconfiguration surfaces immediately
 * instead of silently shipping an insecure deployment.
 *
 * The e2e smoke run sets an explicit (non-default) secret with `NODE_ENV=production`, so it does
 * not trip this guard. Only the *literal* development default is rejected; any operator-supplied
 * secret (including one that merely meets the `min(8)` length) is accepted.
 */
export const ConfigSchemaRefined = ConfigSchema.superRefine((value, ctx) => {
  if ((process.env.NODE_ENV ?? '').toLowerCase() === 'production' && value.jwtSecret === DEFAULT_JWT_SECRET) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['jwtSecret'],
      message:
        'JWT_SECRET must be set to a strong, unique secret in production; the development default ("dev-only-secret-change-me") is not allowed.',
    });
  }
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
  return ConfigSchemaRefined.parse({
    port: process.env.APP_PORT,
    host: process.env.APP_HOST,
    databaseUrl: process.env.DATABASE_URL,
    databaseAdminUrl: process.env.DATABASE_ADMIN_URL,
    databaseStatementTimeoutMs: process.env.DATABASE_STATEMENT_TIMEOUT_MS,
    databaseLockTimeoutMs: process.env.DATABASE_LOCK_TIMEOUT_MS,
    requestTimeoutMs: process.env.REQUEST_TIMEOUT_MS,
    redisUrl: process.env.REDIS_URL,
    jwtSecret: process.env.JWT_SECRET,
    accessTokenTtlSeconds: process.env.ACCESS_TOKEN_TTL,
    refreshTokenTtlSeconds: process.env.REFRESH_TOKEN_TTL,
    storageRoot: process.env.STORAGE_ROOT,
    logLevel: process.env.LOG_LEVEL,
    corsOrigins: process.env.CORS_ORIGINS,
    rateLimitMax: process.env.RATE_LIMIT_MAX,
    trustProxy: process.env.TRUST_PROXY,
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
    reportWorkerSecret: process.env.REPORT_WORKER_SECRET,
    marketingWebhookSecret: process.env.MARKETING_WEBHOOK_SECRET,
    encryptionKey: process.env.ENCRYPTION_KEY,
    extensionsDir: process.env.EXTENSIONS_DIR,
    integrationOauthClientIds: process.env.INTEGRATION_OAUTH_CLIENT_IDS,
    platformVersion: process.env.PLATFORM_VERSION,
  });
}

export const CONFIG_TOKEN = Symbol('CONFIG');
