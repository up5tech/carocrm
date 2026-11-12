import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildMultipart } from './module-test-app.js';
import type { ApiContext, TestUser } from './support/boot-api.js';
import { authHeader, bootApi, createTestRole, createTestUser, shutdownApi } from './support/boot-api.js';

/**
 * Phase 23.4 (IDoA) — the file and the history are protected independently of the parent record.
 *
 * Each asserts the object's own access check, not the parent endpoint: a foreign attachment must not
 * stream and a foreign record's audit history must not be readable merely because the caller knows
 * its id. Runs against the configured primary database; every row is created by this run and the
 * attachment is deleted by its exact id.
 */
const runId = `idor${Date.now().toString(36)}`;

let ctx: ApiContext;
let stranger: TestUser;
let accountId = '';
let attachmentId = '';

beforeAll(async () => {
  ctx = await bootApi();
  await createTestRole(ctx, {
    id: `aclIdorNone${runId}`,
    name: `ACL IDoR None ${runId}`,
    permissions: { Account: { read: 'no', create: 'no', edit: 'no', delete: 'no' } },
  });
  stranger = await createTestUser(ctx, { userName: `acl_idor_${runId}`, roleIds: [`aclIdorNone${runId}`] });

  const account = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/Account',
    headers: authHeader(ctx.adminToken),
    payload: { name: `AGENT_TEST_IdoR ${runId}` },
  });
  expect(account.statusCode).toBe(201);
  accountId = String((account.json() as { id: string }).id);

  const multipart = buildMultipart([
    { name: 'file', filename: `agent-test-${runId}.txt`, contentType: 'text/plain', data: 'private bytes' },
  ]);
  const uploaded = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/Attachment/upload',
    headers: { ...authHeader(ctx.adminToken), ...multipart.headers },
    payload: multipart.payload,
  });
  expect(uploaded.statusCode).toBe(201);
  attachmentId = String((uploaded.json() as { id: string }).id);
});

afterAll(async () => {
  if (attachmentId !== '') {
    await ctx.app.inject({ method: 'DELETE', url: `/api/v1/Attachment/${attachmentId}`, headers: authHeader(ctx.adminToken) });
  }
  if (accountId !== '') {
    await ctx.app.inject({ method: 'DELETE', url: `/api/v1/Account/${accountId}`, headers: authHeader(ctx.adminToken) });
  }
  await shutdownApi();
});

describe('Phase 23.4 — independent object access', () => {
  it('refuses metadata, download and signed URL for a foreign attachment', async () => {
    const meta = await ctx.app.inject({ method: 'GET', url: `/api/v1/Attachment/${attachmentId}`, headers: authHeader(stranger.token) });
    expect(meta.statusCode).toBe(403);
    expect((meta.json() as { error: { code: string } }).error.code).toBe('AUTHORIZATION_DENIED');

    const file = await ctx.app.inject({ method: 'GET', url: `/api/v1/Attachment/${attachmentId}/file`, headers: authHeader(stranger.token) });
    expect(file.statusCode).toBe(403);
    expect(file.rawPayload.includes('private bytes')).toBe(false);

    const url = await ctx.app.inject({ method: 'GET', url: `/api/v1/Attachment/${attachmentId}/url`, headers: authHeader(stranger.token) });
    expect(url.statusCode).toBe(403);
  });

  it('refuses the audit history of a record the caller cannot read', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/AuditLog?entityId=${encodeURIComponent(accountId)}&entityType=Account`,
      headers: authHeader(stranger.token),
    });
    expect(res.statusCode).toBe(403);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('AUTHORIZATION_DENIED');
    expect(JSON.stringify(body)).not.toContain('AGENT_TEST_IdoR');
  });
});
