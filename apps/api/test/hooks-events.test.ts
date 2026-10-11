import { ValidationError } from '@carocrm/core/errors/index.js';
import type { HookContext } from '@carocrm/entity-engine/types/index.js';
import { HOOK_PHASES } from '@carocrm/entity-engine/types/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AfterSaveHook } from '../src/entity/hooks.js';
import { KERNEL_HOOKS_TOKEN } from '../src/entity/hooks.js';
import { HookRegistry } from '../src/hooks/hook.registry.js';
import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, createTestUser, shutdownApi } from './support/boot-api.js';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

interface CallResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

const runId = `h${Date.now().toString(36)}`;
const entity = `AgentHook${runId.replace(/[^A-Za-z0-9]/g, '')}`;

let ctx: ApiContext;
let adminToken = '';
const createdIds: string[] = [];
const hookNames: string[] = [];

async function call(method: Method, url: string, payload?: unknown): Promise<CallResult> {
  const res = await ctx.app.inject({
    method,
    url,
    headers: authHeader(adminToken),
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  let body: Record<string, unknown> = {};
  try {
    body = res.json() as Record<string, unknown>;
  } catch {
    body = {};
  }
  return { status: res.statusCode, body };
}

function errorOf(body: Record<string, unknown>): { code: string; message: string; details: Record<string, unknown> } {
  const error = (body['error'] ?? {}) as { code?: string; message?: string; details?: Record<string, unknown> };
  return { code: error.code ?? '', message: error.message ?? '', details: error.details ?? {} };
}

async function createRecord(payload: Record<string, unknown>): Promise<CallResult> {
  const res = await call('POST', `/api/v1/${entity}`, { name: `Hook ${runId}`, ...payload });
  const id = res.body['id'];
  if (typeof id === 'string') createdIds.push(id);
  return res;
}

/** Outbox rows this suite produced for one record, oldest first. */
async function eventsFor(entityId: string): Promise<{ eventType: string; payload: Record<string, unknown> }[]> {
  const rows = await ctx.database.db
    .selectFrom('outbox_events')
    .select(['event_type', 'payload'])
    .where('event_type', 'like', 'entity.%')
    .execute();
  return rows
    .map((row) => ({ eventType: row.event_type, payload: (typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload) as Record<string, unknown> }))
    .filter((row) => row.payload.entityId === entityId && row.payload.entityType === entity)
    .sort((a, b) => String(a.payload.version).localeCompare(String(b.payload.version)));
}

async function countOutboxRows(): Promise<number> {
  const row = await ctx.database.db
    .selectFrom('outbox_events')
    .select((eb) => eb.fn.countAll<number>().as('total'))
    .executeTakeFirst();
  return Number(row?.total ?? 0);
}

function addHook(hook: { name: string; phase: string; handler: (context: HookContext) => Promise<void> | void }): void {
  ctx.app.get(HookRegistry).register({ ...hook, entity });
  hookNames.push(hook.name);
}

beforeAll(async () => {
  ctx = await bootApi();
  adminToken = ctx.adminToken;

  const created = await call('POST', `/api/v1/Metadata/${entity}`, {
    label: 'Agent Hook Probe',
    fields: {
      industry: { type: 'varchar', inEdit: true, inDetail: true },
      stage: { type: 'varchar', inEdit: true, inDetail: true },
    },
  });
  expect(created.status).toBe(200);
});

afterAll(async () => {
  const registry = ctx.app.get(HookRegistry);
  for (const name of hookNames) registry.unregister(name);
  for (const id of createdIds) {
    await call('DELETE', `/api/v1/${entity}/${id}`);
  }
  await call('POST', `/api/v1/Metadata/${entity}`, { isEntity: false });
  await shutdownApi();
});

describe('hook registry API (PLAN §23.1)', () => {
  it('reports the documented phases to an admin', async () => {
    const res = await call('GET', '/api/v1/Hook');
    expect(res.status).toBe(200);
    const phases = res.body['phases'] as string[];
    expect(phases).toEqual(expect.arrayContaining([...HOOK_PHASES]));
    expect(res.body['recommended']).toEqual([...HOOK_PHASES]);
    expect(Array.isArray(res.body['handlers'])).toBe(true);
  });

  it('lists a registered handler and hides hooks from non-admins', async () => {
    addHook({ name: `probe-listed-${runId}`, phase: 'afterSave', handler: () => undefined });

    const res = await call('GET', '/api/v1/Hook');
    const handlers = res.body['handlers'] as { name: string; phase: string; entity: string }[];
    expect(handlers.some((handler) => handler.name === `probe-listed-${runId}` && handler.phase === 'afterSave' && handler.entity === entity)).toBe(true);

    const user = await createTestUser(ctx, { userName: `nohooks${runId}` });
    const denied = await ctx.app.inject({ method: 'GET', url: '/api/v1/Hook', headers: authHeader(user.token) });
    expect(denied.statusCode).toBe(403);
    expect(errorOf(denied.json() as Record<string, unknown>).code).toBe('AUTHORIZATION_DENIED');
  });

  it('refuses a duplicate hook name', () => {
    const registry = ctx.app.get(HookRegistry);
    registry.register({ name: `dup-${runId}`, phase: 'beforeSave', handler: () => undefined });
    expect(() => registry.register({ name: `dup-${runId}`, phase: 'beforeSave', handler: () => undefined })).toThrowError(ValidationError);
    registry.unregister(`dup-${runId}`);
  });

  it('runs the phases of the documented order for a create', async () => {
    const trace: string[] = [];
    for (const phase of ['beforeValidate', 'beforeCreate', 'beforeSave', 'afterCreate', 'whenCreated', 'afterSave', 'beforeUpdate', 'whenUpdated']) {
      addHook({
        name: `trace-${phase}-${runId}`,
        phase,
        handler: (context) => {
          trace.push(`${context.phase}:${context.operation}`);
        },
      });
    }

    const res = await createRecord({ industry: 'Software' });
    expect(res.status).toBe(201);
    expect(trace).toEqual([
      'beforeValidate:create',
      'beforeCreate:create',
      'beforeSave:create',
      'afterCreate:create',
      'whenCreated:create',
      'afterSave:create',
    ]);

    trace.length = 0;
    const updated = await call('PATCH', `/api/v1/${entity}/${res.body['id']}`, { industry: 'Logistics' });
    expect(updated.status).toBe(200);
    expect(trace).toEqual(['beforeValidate:update', 'beforeUpdate:update', 'beforeSave:update', 'whenUpdated:update', 'afterSave:update']);
  });

  it('lets a beforeSave hook change what gets stored', async () => {
    addHook({
      name: `stamp-${runId}`,
      phase: 'beforeSave',
      handler: (context) => {
        if (context.operation !== 'create' || !context.data) return;
        context.data['stage'] = 'qualified';
      },
    });

    const res = await createRecord({ industry: 'Banking' });
    expect(res.status).toBe(201);
    expect(res.body['stage']).toBe('qualified');
  });

  it('aborts the write when a hook throws', async () => {
    addHook({
      name: `blocker-${runId}`,
      phase: 'beforeSave',
      handler: (context) => {
        if (context.data?.['industry'] === 'Forbidden') throw new ValidationError('A hook rejected this industry.', { field: 'industry' });
      },
    });

    const before = await call('GET', `/api/v1/${entity}?maxSize=100`);
    const res = await createRecord({ industry: 'Forbidden' });
    expect(res.status).toBe(422);
    expect(errorOf(res.body).details['field']).toBe('industry');

    const after = await call('GET', `/api/v1/${entity}?maxSize=100`);
    expect(after.body['total']).toBe(before.body['total']);
  });

  it('sees the previous state on update hooks', async () => {
    const seen: unknown[] = [];
    addHook({
      name: `previous-${runId}`,
      phase: 'beforeSave',
      handler: (context) => {
        if (context.operation !== 'update') return;
        seen.push(context.previous?.['industry'] ?? null);
      },
    });

    const created = await createRecord({ industry: 'Mining' });
    expect(created.status).toBe(201);
    seen.length = 0;
    await call('PATCH', `/api/v1/${entity}/${created.body['id']}`, { industry: 'Energy' });
    expect(seen).toEqual(['Mining']);
  });

  it('runs delete phases', async () => {
    const trace: string[] = [];
    addHook({ name: `del-${runId}`, phase: 'beforeDelete', handler: (context) => void trace.push(`${context.phase}:${context.operation}`) });
    addHook({ name: `deleted-${runId}`, phase: 'whenDeleted', handler: (context) => void trace.push(`${context.phase}:${context.operation}`) });

    const created = await createRecord({ industry: 'Retail' });
    expect(created.status).toBe(201);
    const res = await call('DELETE', `/api/v1/${entity}/${created.body['id']}`);
    expect(res.status).toBe(200);
    expect(trace).toEqual(['beforeDelete:delete', 'whenDeleted:delete']);
  });

  it('scopes a hook to its entity type', async () => {
    let calls = 0;
    ctx.app.get(HookRegistry).register({
      name: `scoped-${runId}`,
      phase: 'beforeSave',
      entity,
      handler: () => {
        calls += 1;
      },
    });
    hookNames.push(`scoped-${runId}`);

    await createRecord({ industry: 'Software' });
    expect(calls).toBe(1);
    await call('POST', '/api/v1/Account', { name: `Hook other ${runId}` });
    expect(calls).toBe(1);
  });
});

describe('domain events through the transactional outbox (PLAN §23.2)', () => {
  it('writes one event per mutation, inside the transaction', async () => {
    const created = await createRecord({ industry: 'Software' });
    expect(created.status).toBe(201);
    const id = String(created.body['id']);

    const afterCreate = await eventsFor(id);
    expect(afterCreate.map((event) => event.eventType)).toEqual(['entity.created']);
    const payload = afterCreate[0]?.payload as { entityType: string; entityId: string; changed: string[]; userId: string; version: number };
    expect(payload.entityType).toBe(entity);
    expect(payload.changed).toEqual(expect.arrayContaining(['name', 'industry']));
    expect(payload.userId).toBe('adminUserId');

    const updated = await call('PATCH', `/api/v1/${entity}/${id}`, { industry: 'Logistics' });
    expect(updated.status).toBe(200);
    const afterUpdate = await eventsFor(id);
    expect(afterUpdate.map((event) => event.eventType)).toEqual(['entity.created', 'entity.updated']);
    expect((afterUpdate[1]?.payload as { changed: string[] }).changed).toEqual(['industry']);

    const deleted = await call('DELETE', `/api/v1/${entity}/${id}`);
    expect(deleted.status).toBe(200);
    expect((await eventsFor(id)).map((event) => event.eventType)).toEqual(['entity.created', 'entity.updated', 'entity.deleted']);
  });

  it('publishes entity.restored for a restore', async () => {
    const created = await createRecord({ industry: 'Health' });
    const id = String(created.body['id']);
    expect(created.status).toBe(201);

    await call('DELETE', `/api/v1/${entity}/${id}`);
    const restored = await call('POST', `/api/v1/${entity}/${id}/restore`);
    expect(restored.status).toBe(200);

    expect((await eventsFor(id)).map((event) => event.eventType)).toEqual(['entity.created', 'entity.deleted', 'entity.restored']);
  });

  it('rolls the event back when the transaction fails, leaving no orphan row', async () => {
    const before = await countOutboxRows();
    const hooks = ctx.app.get<AfterSaveHook[]>(KERNEL_HOOKS_TOKEN);
    const failing: AfterSaveHook = async (args) => {
      if (args.record.entityType !== entity) return;
      throw new ValidationError('A transaction hook failed after the record write.');
    };
    hooks.push(failing);
    let status = 0;
    try {
      status = (await createRecord({ industry: 'Volatile' })).status;
    } finally {
      hooks.splice(hooks.indexOf(failing), 1);
    }

    expect(status).toBe(422);
    // Nothing committed: neither the record nor its domain event.
    const records = await ctx.database.db
      .selectFrom('entity_records')
      .select('id')
      .where('entity_type', '=', entity)
      .where('attrs', '@>', JSON.stringify({ industry: 'Volatile' }))
      .execute();
    expect(records).toHaveLength(0);
    expect(await countOutboxRows()).toBe(before);
  });

  it('exposes outbox rows to admins through GET /api/v1/DomainEvent', async () => {
    const created = await createRecord({ industry: 'Utilities' });
    const id = String(created.body['id']);

    const res = await call('GET', '/api/v1/DomainEvent?eventType=entity.created&limit=100');
    expect(res.status).toBe(200);
    const list = res.body['list'] as { id: string; eventType: string; status: string; payload: Record<string, unknown> }[];
    expect(Array.isArray(list)).toBe(true);
    expect(list.every((row) => row.eventType === 'entity.created')).toBe(true);
    expect(list.some((row) => row.payload.entityId === id)).toBe(true);
    expect(list[0]).toHaveProperty('createdAt');

    const bad = await call('GET', '/api/v1/DomainEvent?status=nope');
    expect(bad.status).toBe(422);

    const user = await createTestUser(ctx, { userName: `noevents${runId}` });
    const denied = await ctx.app.inject({ method: 'GET', url: '/api/v1/DomainEvent', headers: authHeader(user.token) });
    expect(denied.statusCode).toBe(403);
  });
});
