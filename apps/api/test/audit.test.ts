import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AfterSaveHookLike } from '../src/audit/index.js';
import {
  AUDIT_CONTROLLERS,
  AUDIT_METADATA_LOOKUP,
  AUDIT_PROVIDERS,
  AUDIT_SINK_TOKEN,
  AuditHookService,
  AuditSinkService,
  registerAuditHook,
} from '../src/audit/index.js';
import type { RequestScope } from '../src/common/request-scope.js';
import { REQUEST_SCOPE_TOKEN } from '../src/common/request-scope.js';
import { DatabaseService } from '../src/database/database.service.js';
import type { ModuleTestContext } from './module-test-app.js';
import { authHeader, bootModuleTestApp } from './module-test-app.js';

let ctx: ModuleTestContext;
let sink: AuditSinkService;

const RECORD_ID = `audit-rec-${Date.now()}`;
const ENTITY = 'Account';

beforeAll(async () => {
  ctx = await bootModuleTestApp({ providers: AUDIT_PROVIDERS, controllers: AUDIT_CONTROLLERS });
  sink = ctx.app.get(AUDIT_SINK_TOKEN) as AuditSinkService;
  const scope = ctx.app.get(REQUEST_SCOPE_TOKEN) as RequestScope;
  scope.principal = {
    userId: 'adminUserId',
    userName: 'admin',
    userType: 'admin',
    roles: ['sysAdmin'],
    teams: [],
  };
});

afterAll(async () => {
  await ctx.app?.close();
});

async function auditRows(where: { record_id: string }): Promise<Array<Record<string, unknown>>> {
  const rows = await ctx.app
    .get(DatabaseService)
    .db.selectFrom('audit_log')
    .selectAll()
    .where('record_id', '=', where.record_id)
    .orderBy('action', 'desc')
    .orderBy('order', 'asc')
    .execute();
  return rows as unknown as Array<Record<string, unknown>>;
}

describe('AuditSinkService.recordChanges', () => {
  it('writes a single create row with the audited field names', async () => {
    const written = await sink.recordChanges({
      entityType: ENTITY,
      record: { id: `${RECORD_ID}-create`, attrs: { name: 'Acme', website: 'acme.test' }, assignedUserId: 'adminUserId' },
      userId: 'adminUserId',
    });
    expect(written).toBe(1);
    const rows = await auditRows({ record_id: `${RECORD_ID}-create` });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe('create');
    expect(rows[0]?.username).toBe('admin');
    const data = rows[0]?.data as { fields: string[] };
    expect(data.fields).toEqual(expect.arrayContaining(['name', 'website', 'assignedUserId']));
  });

  it('writes one update row per changed field with old/new values', async () => {
    const written = await sink.recordChanges({
      entityType: ENTITY,
      record: { id: `${RECORD_ID}-update`, attrs: { description: 'new value', industry: 'Tech' } },
      previous: { description: 'old value', industry: 'Tech' },
      userId: 'adminUserId',
    });
    expect(written).toBe(1);
    const rows = await auditRows({ record_id: `${RECORD_ID}-update` });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe('update');
    const data = rows[0]?.data as { field: string; oldValue: unknown; newValue: unknown };
    expect(data.field).toBe('description');
    expect(data.oldValue).toBe('old value');
    expect(data.newValue).toBe('new value');
    expect(rows[0]?.order).toBe(0);
  });

  it('redacts sensitive values (password/secret/token/apiKey)', async () => {
    await sink.recordChanges({
      entityType: ENTITY,
      record: { id: `${RECORD_ID}-redact`, attrs: { password: 'new-secret', apiKey: 'key-new' } },
      previous: { password: 'old-secret', apiKey: 'key-old' },
      userId: 'adminUserId',
    });
    const rows = await auditRows({ record_id: `${RECORD_ID}-redact` });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const data = row.data as { field: string; oldValue: unknown; newValue: unknown };
      expect(data.oldValue).toBe('[REDACTED]');
      expect(data.newValue).toBe('[REDACTED]');
    }
  });

  it('writes nothing when no audited field changed', async () => {
    const written = await sink.recordChanges({
      entityType: ENTITY,
      record: { id: `${RECORD_ID}-noop`, attrs: { name: 'Same' } },
      previous: { name: 'Same' },
      userId: 'adminUserId',
    });
    expect(written).toBe(0);
    expect(await auditRows({ record_id: `${RECORD_ID}-noop` })).toHaveLength(0);
  });

  it('honours metadata audited flags when a lookup is provided', async () => {
    const directSink = new AuditSinkService(
      ctx.app.get(DatabaseService),
      ctx.app.get(REQUEST_SCOPE_TOKEN) as RequestScope,
      (entity: string) => (entity === ENTITY ? { name: { audited: true }, description: { audited: false } } : undefined),
    );
    const written = await directSink.recordChanges({
      entityType: ENTITY,
      record: { id: `${RECORD_ID}-meta`, attrs: { name: 'n2', description: 'd2' } },
      previous: { name: 'n1', description: 'd1' },
      userId: 'adminUserId',
    });
    expect(written).toBe(1);
    const rows = await auditRows({ record_id: `${RECORD_ID}-meta` });
    expect((rows[0]?.data as { field: string }).field).toBe('name');
  });

  it('always audits physical assignedUserId diffs', async () => {
    const written = await sink.recordChanges({
      entityType: ENTITY,
      record: { id: `${RECORD_ID}-assigned`, attrs: {}, assignedUserId: 'someoneElse' },
      previous: { assignedUserId: 'adminUserId' },
      userId: 'adminUserId',
    });
    expect(written).toBe(1);
    const rows = await auditRows({ record_id: `${RECORD_ID}-assigned` });
    const data = rows[0]?.data as { field: string; newValue: unknown };
    expect(data.field).toBe('assignedUserId');
    expect(data.newValue).toBe('someoneElse');
  });

  it('recordDelete writes a delete row', async () => {
    await sink.recordDelete({ entityType: ENTITY, recordId: `${RECORD_ID}-delete`, userId: 'adminUserId' });
    const rows = await auditRows({ record_id: `${RECORD_ID}-delete` });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe('delete');
  });
});

describe('kernel hook seam (registerAuditHook)', () => {
  it('pushes a hook that writes create + update audit rows inside the caller tx', async () => {
    const hooks: AfterSaveHookLike[] = [];
    registerAuditHook(hooks, ctx.app.get(AuditHookService) as AuditHookService);
    expect(hooks).toHaveLength(1);

    const db = ctx.app.get(DatabaseService).db;
    const hook = hooks[0];
    if (!hook) throw new Error('hook not registered');

    await db.transaction().execute(async (tx) => {
      await hook({
        entityType: 'Contact',
        record: { id: `${RECORD_ID}-hook`, attrs: { firstName: 'Ada' } },
        userId: 'adminUserId',
        tx,
      });
      await hook({
        entityType: 'Contact',
        record: { id: `${RECORD_ID}-hook`, attrs: { firstName: 'Grace' } },
        previous: { firstName: 'Ada' },
        userId: 'adminUserId',
        tx,
      });
    });

    const rows = await auditRows({ record_id: `${RECORD_ID}-hook` });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.action).sort()).toEqual(['create', 'update']);
  });
});

describe('AuditLog REST endpoints', () => {
  it('admin can list the full log with pagination envelope', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/AuditLog?entityType=${ENTITY}&limit=50&offset=0`,
      headers: authHeader(ctx.adminToken),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { list: unknown[]; total: number; offset: number; count: number };
    expect(Array.isArray(body.list)).toBe(true);
    expect(body).toHaveProperty('total');
    expect(body.offset).toBe(0);
    expect(body.count).toBeLessThanOrEqual(body.list.length);
    expect(body.total).toBeGreaterThanOrEqual(5);
    expect(body.list.every((entry) => (entry as { entityType: string }).entityType === ENTITY)).toBe(true);
  });

  it('admin can filter by entityId and read one entry by id', async () => {
    const list = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/AuditLog?entityId=${RECORD_ID}-update`,
      headers: authHeader(ctx.adminToken),
    });
    expect(list.statusCode).toBe(200);
    const body = list.json() as { list: Array<{ id: string; entityId: string; action: string }> };
    expect(body.total).toBe(1);
    const entry = body.list[0];
    if (!entry) throw new Error('expected one audit row');
    expect(entry.entityId).toBe(`${RECORD_ID}-update`);
    expect(entry.action).toBe('update');

    const single = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/AuditLog/${entry.id}`,
      headers: authHeader(ctx.adminToken),
    });
    expect(single.statusCode).toBe(200);
    expect(single.json().id).toBe(entry.id);
  });

  it('non-admin without entityId is denied', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/AuditLog', headers: authHeader(ctx.regularToken) });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: { code: string } }).error.code).toBe('AUTHORIZATION_DENIED');
  });

  it('non-admin with entityId sees only that record', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/AuditLog?entityId=${RECORD_ID}-redact`,
      headers: authHeader(ctx.regularToken),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { list: Array<{ entityId: string }>; total: number };
    expect(body.total).toBe(2);
    expect(body.list.every((entry) => entry.entityId === `${RECORD_ID}-redact`)).toBe(true);
  });

  it('rejects invalid timestamps', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/AuditLog?createdFrom=not-a-date',
      headers: authHeader(ctx.adminToken),
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('INVALID_QUERY');
  });

  it('keeps the default AUDIT_METADATA_LOOKUP provider permissive (audit-all)', () => {
    const lookup = ctx.app.get(AUDIT_METADATA_LOOKUP) as (entity: string) => unknown;
    expect(lookup('Anything')).toBeUndefined();
  });
});
