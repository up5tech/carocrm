import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { seed } from '../../../database/seed.js';
import type { LoginResult } from '../src/auth/auth.controller.js';
import { createApp, migrateDb } from '../src/bootstrap.js';
import { type AppConfig,buildConfig } from '../src/config.js';

export interface TestContext {
  app: NestFastifyApplication;
  config: AppConfig;
  adminToken: string;
}

let cached: TestContext | undefined;

export const ADMIN_LOGIN = 'admin';
export const ADMIN_PASSWORD = 'admin';

/**
 * Boots the AppModule against the configured project database (AGENTS.md §3.1).
 * No database is created, reset or truncated; test records carry unique run markers.
 */
export async function bootTestApp(): Promise<TestContext> {
  if (cached) return cached;
  process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'error';

  const config = buildConfig();
  await migrateDb(config.databaseUrl);
  await seed(config.databaseUrl, { adminLogin: ADMIN_LOGIN, adminPassword: ADMIN_PASSWORD });

  const app = await createApp(config, { skipMigrations: true });
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/Authentication',
    payload: { userName: ADMIN_LOGIN, password: ADMIN_PASSWORD },
  });
  if (res.statusCode !== 201 && res.statusCode !== 200) {
    throw new Error(`test login failed: ${res.statusCode} ${res.body}`);
  }
  const login = res.json() as LoginResult;
  cached = { app, config, adminToken: login.accessToken };
  return cached;
}

/** A fresh session per call: one test logging out cannot break the shared app instance. */
export async function getAdminToken(): Promise<string> {
  const ctx = await bootTestApp();
  const { AuthService } = await import('../src/auth/auth.service.js');
  const { DatabaseService } = await import('../src/database/database.service.js');
  const admin = await ctx.app
    .get(DatabaseService)
    .db.selectFrom('users').select('id').where('user_name', '=', ADMIN_LOGIN).executeTakeFirst();
  if (!admin) throw new Error(`configured admin user "${ADMIN_LOGIN}" not found`);
  const fresh = await ctx.app.get(AuthService).createSession(admin.id, 'admin');
  return fresh.accessToken;
}

export async function closeTestApp(): Promise<void> {
  if (cached) {
    await cached.app.close();
    cached = undefined;
  }
}

export function authHeader(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}
