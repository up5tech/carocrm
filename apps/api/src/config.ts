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
  /** Global API rate limit per minute; the SPA spends many small calls per screen. */
  rateLimitMax: z.coerce.number().int().positive().default(300),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

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
  });
}

export const CONFIG_TOKEN = Symbol('CONFIG');
