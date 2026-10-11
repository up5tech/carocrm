import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { sql } from 'kysely';

import { seed } from '../../../../database/seed.js';
import { ACL_PROVIDERS } from '../../src/acl/acl.module.js';
import { AppModule } from '../../src/app.module.js';
import { AuthService } from '../../src/auth/auth.service.js';
import { createApp, migrateDb } from '../../src/bootstrap.js';
import type { AppConfig } from '../../src/config.js';
import { buildConfig } from '../../src/config.js';
import { DatabaseService } from '../../src/database/database.service.js';
import { ENTITY_CONTROLLERS, ENTITY_PROVIDERS } from '../../src/entity/entity.module.js';

export const ADMIN_LOGIN = 'admin';
export const ADMIN_PASSWORD = 'admin';

const MODULE_CONTROLLERS_KEY = 'controllers';
const MODULE_PROVIDERS_KEY = 'providers';

export interface ApiContext {
  readonly app: NestFastifyApplication;
  readonly config: AppConfig;
  readonly adminToken: string;
  readonly database: DatabaseService;
  readonly auth: AuthService;
}

let cached: ApiContext | undefined;

/**
 * Boots the API for the generic-entity / ACL / metadata tests.
 *
 * `apps/api/src/app.module.ts` is owned by the integrator and must not be edited by
 * this module, and `test/helper.ts` boots exactly that AppModule. So the module
 * barrels (`ENTITY_PROVIDERS`, `ENTITY_CONTROLLERS`, `ACL_PROVIDERS`) are installed
 * onto AppModule's own module metadata before the application is created — a no-op
 * once the integrator has added them to AppModule directly.
 *
 * Tests run against the configured project database (AGENTS.md §3.1): no extra
 * database is created. Every test record carries a unique run marker (§3.3).
 */
export async function bootApi(): Promise<ApiContext> {
  if (cached) return cached;

  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'error';
  // Jobs are enqueued to a scratch queue so a test run never leaves work on the real one (AGENTS.md §3.3).
  process.env.JOB_QUEUE_NAME = process.env.JOB_QUEUE_NAME ?? 'crm-jobs-test';

  const config = buildConfig();
  await migrateDb(config.databaseUrl);
  await seed(config.databaseUrl, { adminLogin: ADMIN_LOGIN, adminPassword: ADMIN_PASSWORD });

  installBarrelsOnAppModule();

  const app = await createApp(config, { skipMigrations: true });
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/Authentication',
    payload: { userName: ADMIN_LOGIN, password: ADMIN_PASSWORD },
  });
  if (login.statusCode !== 200 && login.statusCode !== 201) {
    throw new Error(`admin login failed: ${login.statusCode} ${login.body}`);
  }
  const adminToken = (login.json() as { accessToken: string }).accessToken;

  cached = {
    app,
    config,
    adminToken,
    database: app.get(DatabaseService),
    auth: app.get(AuthService),
  };
  return cached;
}

/**
 * Deletes the `outbox_events` rows a suite produced for its own entity types (AGENTS.md §3.3:
 * only rows this run can positively identify). Without it, a development database accumulates
 * unconsumed events whenever tests run without a worker attached.
 */
export async function purgeEntityEvents(database: DatabaseService, entityTypes: readonly string[]): Promise<number> {
  if (entityTypes.length === 0) return 0;
  const deleted = await database.db
    .deleteFrom('outbox_events')
    .where(sql`payload ->> 'entityType'`, 'in', entityTypes)
    .returning('id')
    .execute();
  return deleted.length;
}

export async function shutdownApi(): Promise<void> {
  if (!cached) return;
  await cached.app.close();
  cached = undefined;
}

export function authHeader(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

export async function loginAs(ctx: ApiContext, userName: string, password: string): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/Authentication',
    payload: { userName, password },
  });
  if (res.statusCode !== 200 && res.statusCode !== 201) {
    throw new Error(`login for "${userName}" failed: ${res.statusCode} ${res.body}`);
  }
  return (res.json() as { accessToken: string }).accessToken;
}

export interface TestUser {
  readonly id: string;
  readonly userName: string;
  readonly token: string;
}

/** Creates a regular (non-admin) user with the given direct roles and optional teams. */
export async function createTestUser(
  ctx: ApiContext,
  input: { userName: string; password?: string; roleIds?: string[]; teamIds?: string[] },
): Promise<TestUser> {
  const password = input.password ?? 'secret-password';
  const db = ctx.database.db;
  await db
    .insertInto('users')
    .values({
      id: `u_${input.userName}`,
      user_name: input.userName,
      is_admin: false,
      is_active: true,
      type: 'regular',
      auth_method: 'password',
      password: null,
      assigned_role_ids: JSON.stringify(input.roleIds ?? []),
      portal_types: JSON.stringify([]),
      is_deleted: false,
      created_at: new Date(),
      modified_at: new Date(),
      first_name: input.userName,
      last_name: 'Tester',
      email_address: `${input.userName}@example.com`,
      account_name: null,
      title: null,
      phone: null,
      created_by_id: null,
      modified_by_id: null,
    })
    .onConflict((oc) => oc.column('user_name').doUpdateSet({ assigned_role_ids: JSON.stringify(input.roleIds ?? []) }))
    .execute();

  for (const teamId of input.teamIds ?? []) {
    await db
      .insertInto('users_teams')
      .values({ user_id: `u_${input.userName}`, team_id: teamId })
      .onConflict((oc) => oc.doNothing())
      .execute();
  }

  await ctx.auth.setPassword(`u_${input.userName}`, password);
  return { id: `u_${input.userName}`, userName: input.userName, token: await loginAs(ctx, input.userName, password) };
}

/** Inserts a role with entity/field permissions ( EspoCRM levels: yes|all|team|own|no ). */
export async function createTestRole(
  ctx: ApiContext,
  input: {
    id: string;
    name: string;
    permissions: Record<string, Record<string, string>>;
    fieldPermissions?: Record<string, Record<string, Record<string, string>>>;
  },
): Promise<void> {
  await ctx.database.db
    .insertInto('roles')
    .values({
      id: input.id,
      name: input.name,
      permissions: JSON.stringify(input.permissions),
      field_permissions: JSON.stringify(input.fieldPermissions ?? {}),
      entity_type: 'Role',
      is_deleted: false,
      created_at: new Date(),
      modified_at: new Date(),
    })
    .onConflict((oc) =>
      oc.column('id').doUpdateSet({
        permissions: JSON.stringify(input.permissions),
        field_permissions: JSON.stringify(input.fieldPermissions ?? {}),
        is_deleted: false,
        modified_at: new Date(),
      }),
    )
    .execute();
}

export async function createTestTeam(ctx: ApiContext, id: string, name: string): Promise<void> {
  await ctx.database.db
    .insertInto('teams')
    .values({ id, name, user_id: JSON.stringify([]), role_ids: JSON.stringify([]), is_private: false, is_deleted: false, created_at: new Date(), modified_at: new Date() })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();
}

function installBarrelsOnAppModule(): void {
  // Nest stores module metadata under these Reflect keys (see @nestjs/common
  // MODULE_METADATA); they are stable across Nest 8–11.
  const controllers = (Reflect.getMetadata(MODULE_CONTROLLERS_KEY, AppModule) ?? []) as unknown[];
  const providers = (Reflect.getMetadata(MODULE_PROVIDERS_KEY, AppModule) ?? []) as unknown[];
  const alreadyInstalled = controllers.some((controller) => ENTITY_CONTROLLERS.includes(controller as never));
  if (alreadyInstalled) return;

  Reflect.defineMetadata(MODULE_CONTROLLERS_KEY, [...controllers, ...ENTITY_CONTROLLERS], AppModule);
  Reflect.defineMetadata(MODULE_PROVIDERS_KEY, [...providers, ...ACL_PROVIDERS, ...ENTITY_PROVIDERS], AppModule);
}
