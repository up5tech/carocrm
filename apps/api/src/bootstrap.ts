import 'reflect-metadata';

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { log } from '@carocrm/core/logger/index.js';
import { ExtensionHost as ExtensionHostClass, loadExtensions } from '@carocrm/extension-sdk';
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

import { GlobalExceptionFilter } from './common/global-exception.filter.js';
import type { AppConfig } from './config.js';
import { buildConfig } from './config.js';
import type { ExtensionHost as ExtensionHostType } from './extensions/extension-host.js';
import { setExtensionHost } from './extensions/extension-host.js';
import { createExtensionHostModule } from './extensions/extension-host.module.js';
import { readInstalledExtensions } from './extensions/extension-store.js';

/**
 * Reads the installed extensions and assembles the host for this process (PLAN §38.3).
 * Failures are never swallowed: a broken package graph must stop the boot instead of silently
 * changing metadata precedence.
 */
export async function loadExtensionHost(config: AppConfig): Promise<ExtensionHostType> {
  const state = await readInstalledExtensions(config.databaseUrl);
  if (state.enabled.size === 0) return new ExtensionHostClass([]);
  return loadExtensions({
    directory: config.extensionsDir,
    platformVersion: config.platformVersion,
    enabledIds: state.enabled,
    disabledIds: state.disabled,
  });
}

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
  /** Pre-built extension host (tests inject one); otherwise it is loaded from `EXTENSIONS_DIR`. */
  extensions?: ExtensionHostType | undefined;
}

export async function createApp(
  config: AppConfig = buildConfig(),
  options: CreateAppOptions = {},
): Promise<NestFastifyApplication> {
  if (!options.skipMigrations) {
    await migrateDb(config.databaseUrl);
  }

  // Extensions are assembled before Nest exists: providers, controllers and metadata precedence
  // are fixed when the container is created, and the packages themselves come from disk
  // (PLAN §38.3). An installation with no packages gets an empty host and behaves exactly as before.
  const host = options.extensions ?? (await loadExtensionHost(config));
  setExtensionHost(host);

  const adapter = new FastifyAdapter({ logger: false, bodyLimit: 32 * 1024 * 1024 });
  const app = await NestFactory.create<NestFastifyApplication>(createExtensionHostModule(host), adapter, { abortOnError: true });

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
  // One file per request; the attachment service enforces the same ceiling while streaming, so a
  // larger body fails with 413 instead of filling the disk (PLAN §25 size limits).
  await app.register(asPlugin(multipart), {
    limits: { fileSize: config.uploadMaxMb * 1024 * 1024, files: 1 },
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
