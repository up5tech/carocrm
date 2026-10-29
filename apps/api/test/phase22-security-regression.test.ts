import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiContext } from './support/boot-api.js';
import { bootApi, shutdownApi } from './support/boot-api.js';

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
});
