import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type ApiContext, authHeader, bootApi, createTestRole, createTestUser, shutdownApi, type TestUser } from './support/boot-api.js';

let ctx: ApiContext;
let runId: string;
let editor!: TestUser;
let viewer!: TestUser;
const caseIds: string[] = [];
const roleIds: string[] = [];
const userIds: string[] = [];

const marker = (suffix: string) => `AGENT_TEST_${runId} ${suffix}`;

async function call(method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>, token = ctx.adminToken) {
  const res = await ctx.app.inject({ method, url, headers: authHeader(token), ...(payload === undefined ? {} : { payload }) });
  let body: Record<string, unknown> = {};
  try { body = res.json() as Record<string, unknown>; } catch { body = {}; }
  return { status: res.statusCode, body };
}

async function createCase(payload: Record<string, unknown> = {}): Promise<string> {
  const res = await call('POST', '/api/v1/Case', { name: marker('subject'), requesterName: marker('Requester'), ...payload });
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  const id = String(res.body['id']);
  caseIds.push(id);
  return id;
}

beforeAll(async () => {
  ctx = await bootApi();
  runId = `sdmerge${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  await call('POST', '/api/v1/ServiceDesk/action/settings', { features: { caseManagement: true } });

  const editorRole = `sdMergeEdit${runId}`;
  const viewerRole = `sdMergeView${runId}`;
  roleIds.push(editorRole, viewerRole);
  await createTestRole(ctx, {
    id: editorRole,
    name: `merge editor ${runId}`,
    permissions: { Case: { read: 'all', create: 'all', edit: 'all', delete: 'no', stream: 'no' } },
  });
  await createTestRole(ctx, {
    id: viewerRole,
    name: `merge viewer ${runId}`,
    permissions: { Case: { read: 'all', create: 'no', edit: 'no', delete: 'no', stream: 'no' } },
  });
  editor = await createTestUser(ctx, { userName: `sd_merge_edit_${runId}`, roleIds: [editorRole] });
  viewer = await createTestUser(ctx, { userName: `sd_merge_view_${runId}`, roleIds: [viewerRole] });
  userIds.push(editor.id, viewer.id);
});

afterAll(async () => {
  await call('POST', '/api/v1/ServiceDesk/action/settings', { features: { caseManagement: true } });
  if (caseIds.length > 0) {
    await ctx.database.db.deleteFrom('entity_records').where('entity_type', '=', 'CaseTransition').where(sql`attrs ->> 'caseId'`, 'in', caseIds).execute();
    await ctx.database.db.deleteFrom('outbox_events').where(sql`payload ->> 'sourceCaseId'`, 'in', caseIds).execute();
  }
  for (const id of [...caseIds].reverse()) {
    await call('DELETE', `/api/v1/Case/${id}`);
  }
  for (const id of userIds) await ctx.database.db.deleteFrom('users').where('id', '=', id).execute();
  for (const id of roleIds) await ctx.database.db.deleteFrom('roles').where('id', '=', id).execute();
  await shutdownApi();
});

describe('phase 19-SD.14 — duplicate detection and merge', () => {
  it('finds candidates through ACL and merges with an auditable transition', async () => {
    const account = await call('POST', '/api/v1/Account', { name: marker('Merge Account') });
    const accountId = String(account.body['id']);
    const source = await createCase({ name: marker('Printer jam in office'), accountId });
    const target = await createCase({ name: marker('Printer jam in office floor 2'), accountId });
    await createCase({ name: marker('Unrelated billing question') });

    const candidates = await call('GET', `/api/v1/ServiceDesk/action/case/${source}/duplicateCandidates`, undefined, editor.token);
    expect(candidates.status, JSON.stringify(candidates.body)).toBe(200);
    expect(candidates.body['candidates']).toContain(target);

    const merged = await call('POST', `/api/v1/ServiceDesk/action/case/${source}/merge`, { intoCaseId: target }, editor.token);
    expect(merged.status, JSON.stringify(merged.body)).toBe(200);
    expect(merged.body['merged']).toBe(true);
    expect(merged.body['transitionId']).toBeTruthy();

    const sourceRow = await ctx.database.db.selectFrom('entity_records').select('attrs').where('id', '=', source).executeTakeFirstOrThrow();
    const sourceAttrs = sourceRow.attrs as Record<string, unknown>;
    expect(sourceAttrs['status']).toBe('Cancelled');
    expect(sourceAttrs['mergedIntoCaseId']).toBe(target);

    const history = await call('GET', `/api/v1/ServiceDesk/action/case/${source}/history`, undefined, editor.token);
    const commands = (history.body['list'] as { command: string; toStatus: string }[]).map((entry) => `${entry.command}:${entry.toStatus}`);
    expect(commands).toContain('merge:Cancelled');

    const again = await call('POST', `/api/v1/ServiceDesk/action/case/${source}/merge`, { intoCaseId: target }, editor.token);
    expect(again.status).toBe(422);

    await call('DELETE', `/api/v1/Account/${accountId}`);
  });

  it('refuses a merge by an actor without edit permission', async () => {
    const source = await createCase({ name: marker('Viewer source') });
    const target = await createCase({ name: marker('Viewer target') });
    const refused = await call('POST', `/api/v1/ServiceDesk/action/case/${source}/merge`, { intoCaseId: target }, viewer.token);
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.status).toBeLessThan(500);
    const row = await ctx.database.db.selectFrom('entity_records').select('attrs').where('id', '=', source).executeTakeFirstOrThrow();
    expect((row.attrs as Record<string, unknown>)['status']).not.toBe('Cancelled');
  });

  it('refuses to merge a cancelled case', async () => {
    const source = await createCase({ name: marker('Cancelled source') });
    const target = await createCase({ name: marker('Cancelled target') });
    await call('POST', `/api/v1/ServiceDesk/action/case/${source}/transition`, { command: 'cancel' }, editor.token);
    const refused = await call('POST', `/api/v1/ServiceDesk/action/case/${source}/merge`, { intoCaseId: target }, editor.token);
    expect(refused.status).toBe(422);
    expect(JSON.stringify(refused.body)).toContain('CASE_MERGE_NOT_ALLOWED');
  });

  it('refuses a client write to the merge target field', async () => {
    const source = await createCase({ name: marker('Guarded source') });
    const target = await createCase({ name: marker('Guarded target') });
    const direct = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/Case/${source}`,
      headers: authHeader(editor.token),
      payload: { mergedIntoCaseId: target },
    });
    expect(direct.statusCode).toBe(422);
  });
});
