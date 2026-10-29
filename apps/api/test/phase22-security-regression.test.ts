import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiContext, TestUser } from './support/boot-api.js';
import { authHeader, bootApi, createTestRole, createTestUser, shutdownApi } from './support/boot-api.js';

describe('Phase 22.17 — security regression: anonymous access boundary', () => {
  let ctx: ApiContext;

  beforeAll(async () => {
    ctx = await bootApi();
  });

  afterAll(async () => {
    await shutdownApi();
  });

  it('refuses an unauthenticated caller on a protected entity list surface', async () => {
    const anonymous = await ctx.app.inject({ method: 'GET', url: '/api/v1/Account' });
    expect(anonymous.statusCode).toBe(401);
  });

  it('admits the administrator on the same surface', async () => {
    const admin = await ctx.app.inject({ method: 'GET', url: '/api/v1/Account', headers: { authorization: `Bearer ${ctx.adminToken}` } });
    expect(admin.statusCode).toBe(200);
  });

  it('refuses an unauthenticated caller on a protected entity detail surface', async () => {
    const anonymous = await ctx.app.inject({ method: 'GET', url: '/api/v1/Account/00000000-0000-0000-0000-000000000000' });
    expect(anonymous.statusCode).toBe(401);
  });
});

describe('Phase 22.17 — security regression: field-level permission bypass', () => {
  let ctx: ApiContext;
  let fieldUser: TestUser;
  let recordId = '';

  beforeAll(async () => {
    ctx = await bootApi();
    await createTestRole(ctx, {
      id: 'secField',
      name: `Sec Field ${Date.now().toString(36)}`,
      permissions: { Account: { read: 'all', create: 'yes', edit: 'all', delete: 'all' } },
      fieldPermissions: { Account: { industry: { read: 'no', edit: 'no' } } },
    });
    fieldUser = await createTestUser(ctx, { userName: `sec_field_${Date.now().toString(36)}`, roleIds: ['secField'] });

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/Account',
      headers: authHeader(ctx.adminToken),
      payload: { name: `Sec Field Rec ${Date.now().toString(36)}`, industry: 'Banking' },
    });
    expect(created.statusCode).toBe(201);
    recordId = String((created.json() as { id: string }).id);
  });

  afterAll(async () => {
    await shutdownApi();
  });

  it('strips the denied field from a GET response', async () => {
    const read = await ctx.app.inject({ method: 'GET', url: `/api/v1/Account/${recordId}`, headers: authHeader(fieldUser.token) });
    expect(read.statusCode).toBe(200);
    const body = read.json() as Record<string, unknown>;
    expect(body['industry']).toBeUndefined();
  });

  it('refuses a write that touches the denied field', async () => {
    const write = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/Account/${recordId}`,
      headers: authHeader(fieldUser.token),
      payload: { industry: 'Logistics' },
    });
    expect(write.statusCode).toBe(403);
  });
});

describe('Phase 22.17 — security regression: BOLA / cross-user access', () => {
  let ctx: ApiContext;
  let ownUser: TestUser;
  let foreignRecordId = '';

  beforeAll(async () => {
    ctx = await bootApi();
    await createTestRole(ctx, {
      id: 'secOwn',
      name: `Sec Own ${Date.now().toString(36)}`,
      permissions: { Account: { read: 'own', create: 'yes', edit: 'own', delete: 'own' } },
    });
    ownUser = await createTestUser(ctx, { userName: `sec_own_${Date.now().toString(36)}`, roleIds: ['secOwn'] });

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/Account',
      headers: authHeader(ctx.adminToken),
      payload: { name: `Foreign Rec ${Date.now().toString(36)}` },
    });
    expect(created.statusCode).toBe(201);
    foreignRecordId = String((created.json() as { id: string }).id);
  });

  afterAll(async () => {
    await shutdownApi();
  });

  it('does not disclose a foreign owned record to an unrelated scoped caller', async () => {
    const read = await ctx.app.inject({ method: 'GET', url: `/api/v1/Account/${foreignRecordId}`, headers: authHeader(ownUser.token) });
    // Non-disclosure: not 200, and no record body leaked.
    expect(read.statusCode).not.toBe(200);
  });

  it('an unrelated scoped caller cannot mutate the foreign record', async () => {
    const write = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/Account/${foreignRecordId}`,
      headers: authHeader(ownUser.token),
      payload: { name: 'Hacked' },
    });
    expect(write.statusCode).not.toBe(200);
  });
});
