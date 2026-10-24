import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, createTestUser, shutdownApi } from './support/boot-api.js';

const runId = Date.now().toString(36);
const USER_NAME = `AGENT_TEST-preview-${runId}`;

let ctx: ApiContext;
let userToken = '';
let userId = '';

beforeAll(async () => {
  ctx = await bootApi();
  const created = await createTestUser(ctx, { userName: USER_NAME, password: 'secret-password' });
  userId = created.id;
  userToken = created.token;
});

afterAll(async () => {
  await ctx.database.db.deleteFrom('users').where('id', '=', userId).execute();
  await shutdownApi();
});

describe('menu preview as another user', () => {
  it('lets an administrator resolve another user menu', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/Navigation?previewAs=${encodeURIComponent(userId)}`,
      headers: authHeader(ctx.adminToken),
    });
    expect(res.statusCode).toBe(200);
    const keys = new Set<string>();
    const walk = (nodes: readonly { key: string; children?: readonly unknown[] }[]): void => {
      for (const node of nodes) {
        keys.add(node.key);
        if (node.children) walk(node.children);
      }
    };
    walk(res.json().items);
    // A user with no roles has no record groups and no administration container.
    expect(keys.has('group:administration')).toBe(false);
    expect(keys.has('entity:Account')).toBe(false);
  });

  it('refuses a non-administrator', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/Navigation?previewAs=${encodeURIComponent(userId)}`,
      headers: authHeader(userToken),
    });
    expect(res.statusCode).toBe(403);
  });
});