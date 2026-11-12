import 'reflect-metadata';

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname,resolve } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { RateLimitError } from '@carocrm/core/errors/index.js';
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
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Pool } from 'pg';

import { ADVANCED_INTEGRATIONS_WEBHOOK_PREFIX } from './advanced-integrations/webhook-prefix.js';
import { AuditSinkService } from './audit/index.js';
import { setDenialAuditSink } from './common/denial-audit.js';
import { GlobalExceptionFilter } from './common/global-exception.filter.js';
import { resolveRequestId } from './common/request-id.js';
import { RequestTimeoutInterceptor } from './common/request-timeout.interceptor.js';
import type { AppConfig } from './config.js';
import { buildConfig } from './config.js';
import { ESIGNATURE_WEBHOOK_PREFIX } from './esignature/esignature-module.js';
import type { ExtensionHost as ExtensionHostType } from './extensions/extension-host.js';
import { setExtensionHost } from './extensions/extension-host.js';
import { createExtensionHostModule } from './extensions/extension-host.module.js';
import { readInstalledExtensions } from './extensions/extension-store.js';
import { OMNICHANNEL_WEBHOOK_PREFIX } from './omnichannel/omnichannel-module.js';

/** Phase 23.5 (G33) — the marketing provider door and its documented alias. */
const MARKETING_WEBHOOK_PREFIX = '/api/v1/MarketingAutomation/webhook/';
const MARKETING_WEBHOOK_ALIAS_PREFIX = '/api/v1/MarketingAutomation/webhooks/';

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

/**
 * Turns `TRUST_PROXY` into what Fastify expects: `false`/`true`, a hop count, or a list of ranges.
 *
 * Kept out of `config.ts` because the schema only validates that the value is a string; the meaning
 * of `"2"` versus `"10.0.0.0/8"` is Fastify's, not the config's.
 */
function trustProxySetting(raw: string): boolean | string[] {
  const value = raw.trim();
  if (value === '' || value.toLowerCase() === 'false') return false;
  if (value.toLowerCase() === 'true') return true;
  if (/^\d+$/.test(value)) {
    // Fastify 5.12 disables hop-count trust: it cannot validate the immediate peer, so a directly
    // reachable API would let a client spoof X-Forwarded-*. Name the proxy addresses instead.
    throw new Error('TRUST_PROXY must be false, true, or an IP/CIDR list; a hop count is not accepted.');
  }
  return value.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '');
}

export interface CreateAppOptions {
  skipMigrations?: boolean;
  /** Pre-built extension host (tests inject one); otherwise it is loaded from `EXTENSIONS_DIR`. */
  extensions?: ExtensionHostType | undefined;
}

/**
 * Phase 23.1 (C6): turn the raw `CORS_ORIGINS` setting into the value `@fastify/cors` expects.
 *
 * - An empty/unset allowlist fails closed (`false`): no CORS headers are emitted, so a browser
 *   cannot read a cross-origin response and no origin is reflected. `credentials: true` is still
 *   configured, but it is inert without an allowed origin.
 * - Entries are trimmed and empties dropped, so `"http://a, http://b"` no longer produces a
 *   never-matching `' http://b'`.
 */
export function resolveCorsOrigins(raw: string): string[] | false {
  const origins = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  return origins.length === 0 ? false : origins;
}

/**
 * Phase 23.2 (PLAN §8 task 1): the credential endpoints that carry the stricter per-source auth
 * attempt budget. Sub-path aware so `/api/v1/Authentication/challenge` matches the prefix without
 * leaking into unrelated routes.
 */
function isAuthRoute(request: FastifyRequest): boolean {
  const path = (request.url ?? '').split('?')[0] ?? '';
  return (
    path === '/api/v1/Authentication' ||
    path.startsWith('/api/v1/Authentication/') ||
    path === '/api/v1/Refresh' ||
    path === '/api/v1/PasswordReset' ||
    path.startsWith('/api/v1/PasswordReset/')
  );
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

  const adapter = new FastifyAdapter({
    logger: false,
    bodyLimit: 32 * 1024 * 1024,
    trustProxy: trustProxySetting(config.trustProxy),
  });
  const app = await NestFactory.create<NestFastifyApplication>(createExtensionHostModule(host), adapter, { abortOnError: true });

  // Phase 19-INT.12: preserve the exact bytes of a provider callback body.
  //
  // Almost every real provider signs the **exact bytes** it sent (Stripe, Google, Mailchimp,
  // Zoom, Meta, Shopify). A parsed body cannot be verified against such a signature, so the raw
  // body is kept.
  //
  // The hook is **scoped to the webhook prefix** on purpose: buffering every request body would
  // cost memory on every call, and it would interfere with the multipart streaming that the
  // attachment upload relies on. The default JSON parser is left untouched.
  const fastifyInstance = app.getHttpAdapter().getInstance() as unknown as FastifyInstance;
  // Every answer carries the request's correlation id. It is the handle a user gives support after
  // a failure ("the error said req-…"), and the same value is written to outbox/job work (22.21).
  fastifyInstance.addHook('onRequest', (request, reply, done) => {
    reply.header('x-request-id', resolveRequestId(request.headers['x-correlation-id'], request.id));
    done();
  });
  fastifyInstance.decorateRequest('rawBody', null);
  fastifyInstance.addHook('preParsing', (request, _reply, payload, done) => {
    const esignature = request.url.startsWith(ESIGNATURE_WEBHOOK_PREFIX);
    // Phase 19-OM.5 (E2): the Omnichannel ingress preserves the exact bytes like the other
    // provider prefixes, but still parses the body normally — its pipeline reads the parsed shape
    // today, and a future byte-signing adapter (19-OM.15) gets the raw bytes it needs.
    const omnichannel = request.url.startsWith(OMNICHANNEL_WEBHOOK_PREFIX);
    // Phase 23.5 (G33): the marketing webhook signature is an HMAC over the raw body, so the exact
    // bytes must be preserved for both its documented path and its alias.
    const marketing =
      request.url.startsWith(MARKETING_WEBHOOK_PREFIX) || request.url.startsWith(MARKETING_WEBHOOK_ALIAS_PREFIX);
    if (
      !esignature &&
      !omnichannel &&
      !marketing &&
      !request.url.startsWith(ADVANCED_INTEGRATIONS_WEBHOOK_PREFIX)
    ) {
      done(null, payload);
      return;
    }
    const chunks: Buffer[] = [];
    payload.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    payload.on('error', (error: Error) => done(error, undefined));
    payload.on('end', () => {
      const raw = Buffer.concat(chunks);
      (request as { rawBody?: string | null }).rawBody = raw.toString('utf8');
      // The ESignature handler reads only the preserved bytes. A tolerant parser would weaken every
      // JSON route, so the parsed body is replaced with an empty object of the same byte length for
      // this prefix alone (padding is valid JSON whitespace): a malformed delivery reaches the
      // adapter, is recorded as `malformed`, and changes nothing.
      const parsed = esignature ? Buffer.alloc(raw.byteLength, 0x20) : raw;
      if (esignature && parsed.byteLength > 0) {
        parsed[0] = 0x7b; // {
        if (parsed.byteLength > 1) parsed[1] = 0x7d; // }
      }
      done(null, Readable.from(parsed));
    });
  });

  await app.register(asPlugin(swagger), {
    routePrefix: 'docs',
    exposeRoute: true,
    openapi: {
      info: { title: 'CaroCRM API', version: '1.0.0' },
      servers: [{ url: `http://${config.host}:${config.port}` }],
      // Phase 23.5 (G1): the route-level document already existed; what it lacked was any way to
      // describe how a client authenticates. These schemes are the real session mechanisms from
      // `auth/session-cookies.ts` and the bearer token. DTO request/response schemas remain the open
      // half of G1 and are recorded as a deviation in `docs/quality/known-gaps.md`.
      components: {
        securitySchemes: {
          cookieAuth: { type: 'apiKey', in: 'cookie', name: 'CRM-SESSION' },
          bearerAuth: { type: 'http', scheme: 'bearer' },
        },
      },
    },
  });
  await app.register(asPlugin(cookie));
  // Phase 23.1: fail closed when no origin is configured. An unset allowlist used to reflect
  // any origin with credentials (C6), which is exploitable from a same-site sibling subdomain.
  const corsOrigins = resolveCorsOrigins(config.corsOrigins);
  await app.register(asPlugin(cors), {
    origin: corsOrigins,
    credentials: true,
    // The request id is the handle a user gives support after a failure. Without this the SPA
    // cannot read the header on a cross-origin deployment.
    exposedHeaders: ['x-request-id'],
  });
  await app.register(asPlugin(helmet), {
    global: true,
    // Phase 23.1: a deliberate CSP instead of helmet's default. `style-src 'unsafe-inline'`
    // is required by the GrapesJS designer and Ant Design's runtime style injection; every
    // other directive stays on 'self'. Dynamic code evaluation is not permitted.
    // `img-src data:/blob:` supports inline previews/avatars; `font-src data:` supports icon
    // fonts; `connect-src ws:/wss:` supports Vite HMR and live notification sockets.
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'", 'ws:', 'wss:'],
        frameSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
  });
  await app.register(asPlugin(rateLimit), {
    // Phase 23.2 (PLAN §8 task 1): the single global limiter now derives its ceiling and window from
    // the request, so the credential endpoints (`Authentication`, `Authentication/challenge`, `Refresh`,
    // `PasswordReset`, `PasswordReset/confirm`) get the stricter auth budget while everything else keeps
    // the global one. One registration, one
    // error contract (`RateLimitError` / 429 + retry hint) — the auth ceiling is a policy of the same
    // limiter, not a second one. The bucket key carries the normalized route so the stricter auth
    // ceiling can sit under the global one without either clobbering the other.
    keyGenerator: (request: FastifyRequest) => `${request.url.split('?')[0] ?? ''}::${request.ip}`,
    max: (request: FastifyRequest) => (isAuthRoute(request) ? config.authRateLimitMax : config.rateLimitMax),
    timeWindow: (request: FastifyRequest) => (isAuthRoute(request) ? config.authRateLimitWindowSeconds * 1000 : 60_000),
    global: true,
    // CORS preflights are browser bookkeeping, not API calls: counting them would halve the real
    // budget of every cross-origin deployment.
    allowList: (request: FastifyRequest) => request.method === 'OPTIONS',
    // Answer with the platform's own error so the envelope says `RATE_LIMITED` / 429 instead of a
    // bare `Error` that the exception filter could only treat as a crash. The plugin still writes
    // `Retry-After`, and `after` ("40 seconds") tells the caller how long the window has left.
    errorResponseBuilder: (_request: FastifyRequest, context: { after: string }) =>
      new RateLimitError(`Rate limit exceeded, retry in ${context.after}.`),
  });
  // One file per request; the attachment service enforces the same ceiling while streaming, so a
  // larger body fails with 413 instead of filling the disk (PLAN §25 size limits).
  await app.register(asPlugin(multipart), {
    limits: { fileSize: config.uploadMaxMb * 1024 * 1024, files: 1 },
  });

  app.useGlobalFilters(new GlobalExceptionFilter());
  // G74: the request deadline. Registered here, next to the filter that answers it, so the two halves
  // of the behaviour are read together.
  app.useGlobalInterceptors(new RequestTimeoutInterceptor(config.requestTimeoutMs));
  app.enableShutdownHooks();

  const instance = app.getHttpAdapter().getInstance() as unknown as FastifyInstance;
  instance.get('/api/v1/OpenApi', async () => instance.swagger());

  await app.init();
  // Phase 23.4 (F3): the filter is built by hand, so the denial audit is attached here, after the
  // container exists and before the first request. The sink reads the request scope at call time,
  // which is why the actor does not have to travel through the filter.
  setDenialAuditSink((event) => app.get(AuditSinkService).recordDenial(event));
  return app;
}

export async function listen(config: AppConfig = buildConfig()): Promise<NestFastifyApplication> {
  const app = await createApp(config);
  await app.listen(config.port, config.host);
  log.info({ port: config.port, host: config.host }, 'CaroCRM API listening');
  return app;
}
