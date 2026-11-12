import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiContext, TestUser } from './support/boot-api.js';
import { authHeader, bootApi, createTestRole, createTestUser, shutdownApi } from './support/boot-api.js';

/**
 * Phase 23.4 (F3) — an explicit authorization refusal is audited.
 *
 * Runs against the configured primary database (AGENTS.md §3.1). The row is created by the API's
 * own exception filter and deleted by its exact id at the end; nothing else is cleaned.
 */
const runId = `deny${Date.now().toString(36)}`;

let ctx: ApiContext;
let user: TestUser;

beforeAll(async () => {
  ctx = await bootApi();
  await createTestRole(ctx, {
    id: `aclDeny${runId}`,
    name: `ACL Deny ${runId}`,
    permissions: { Account: { read: 'no', create: 'no', edit: 'no', delete: 'no' } },
  });
  user = await createTestUser(ctx, { userName: `acl_deny_${runId}`, roleIds: [`aclDeny${runId}`] });
});

afterAll(async () => {
  await shutdownApi();
});

describe('Phase 23.4 — denied access is written to audit_log', () => {
  it('records actor, target, action and path for an explicit 403', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/Account',
      headers: authHeader(user.token),
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: { code: string } }).error.code).toBe('AUTHORIZATION_DENIED');

    // The audit write is off the response path; poll briefly rather than sleeping a fixed time.
    let row: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 40 && row === undefined; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      row = await ctx.database.db
        .selectFrom('audit_log')
        .selectAll()
        .where('action', '=', 'denied')
        .where('user_id', '=', user.id)
        .executeTakeFirst() as Record<string, unknown> | undefined;
    }

    expect(row).toBeDefined();
    expect(row?.['entity_type']).toBe('Account');
    expect(row?.['username']).toBe(user.userName);
    const data = typeof row?.['data'] === 'string'
      ? (JSON.parse(row['data']) as Record<string, unknown>)
      : (row?.['data'] as Record<string, unknown>);
    expect(data['code']).toBe('AUTHORIZATION_DENIED');
    expect(data['path']).toBe('/api/v1/Account');

    // Clean up exactly the row this run created.
    if (row !== undefined) {
      await ctx.database.db.deleteFrom('audit_log').where('id', '=', String(row['id'])).execute();
    }
  });
});
