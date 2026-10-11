import 'reflect-metadata';

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { log } from '@carocrm/core/logger/index.js';
import * as cookie from '@fastify/cookie';
import * as cors from '@fastify/cors';
import * as helmet from '@fastify/helmet';
import * as multipart from '@fastify/multipart';
import * as rateLimit from '@fastify/rate-limit';
import * as swagger from '@fastify/swagger';
import { NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';

import { AppModule } from './app.module.js';
import { GlobalExceptionFilter } from './common/global-exception.filter.js';
import type { AppConfig } from './config.js';
import { buildConfig } from './config.js';

function migrationsDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth++) {
    const candidate = resolve(dir, 'database', 'migrations');
    if (existsSync(candidate)) return candidate;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('database/migrations directory not found.');
}

export async function migrateDb(connectionString: string): Promise<void> {
  const pool = new Pool({ connectionString, max: 1 });
  try {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name TEXT PRIMARY KEY,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    );
    const files = readdirSync(migrationsDir()).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      const done = await pool.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
      if ((done.rowCount ?? 0) > 0) continue;
      const sql = readFileSync(resolve(migrationsDir(), file), 'utf8');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
  } finally {
    await pool.end();
  }
}

type FastifyPluginLike = Parameters<NestFastifyApplication['register']>[0];

function asPlugin(mod: unknown): FastifyPluginLike {
  const candidate = mod as Record<string, unknown>;
  const fn = (candidate.default ?? candidate) as FastifyPluginLike;
  return fn;
}

export interface CreateAppOptions {
  skipMigrations?: boolean;
}

export async function createApp(
  config: AppConfig = buildConfig(),
  options: CreateAppOptions = {},
): Promise<NestFastifyApplication> {
  if (!options.skipMigrations) {
    await migrateDb(config.databaseUrl);
  }

  const adapter = new FastifyAdapter({ logger: false, bodyLimit: 32 * 1024 * 1024 });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, { abortOnError: true });

  await app.register(asPlugin(swagger), {
    routePrefix: 'docs',
    exposeRoute: true,
    openapi: {
      info: { title: 'CaroCRM API', version: '1.0.0' },
      servers: [{ url: `http://${config.host}:${config.port}` }],
    },
  });
  await app.register(asPlugin(cookie));
  await app.register(asPlugin(cors), {
    origin: config.corsOrigins === '' ? true : config.corsOrigins.split(','),
    credentials: true,
  });
  await app.register(asPlugin(helmet), { global: true });
  await app.register(asPlugin(rateLimit), { max: config.rateLimitMax, timeWindow: '1 minute', global: true });
  await app.register(asPlugin(multipart), {
    limits: { fileSize: 25 * 1024 * 1024, files: 10 },
  });

  app.useGlobalFilters(new GlobalExceptionFilter());
  app.enableShutdownHooks();

  const instance = app.getHttpAdapter().getInstance() as unknown as FastifyInstance;
  instance.get('/api/v1/OpenApi', async () => instance.swagger());

  await app.init();
  return app;
}

export async function listen(config: AppConfig = buildConfig()): Promise<NestFastifyApplication> {
  const app = await createApp(config);
  await app.listen(config.port, config.host);
  log.info({ port: config.port, host: config.host }, 'CaroCRM API listening');
  return app;
}
