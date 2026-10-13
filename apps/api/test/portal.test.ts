import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, loginAs, purgeEntityEvents, shutdownApi } from './support/boot-api.js';

/** Phase 18 portals (PLAN 37): own record visibility, no internal access, separate role space. */
type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
interface CallResult { status: number; body: Record<string, unknown> }
const runId = `pt${Date.now().toString(36)}`;
let ctx: ApiContext;
let adminToken = '';
let portalId = '';
let roleId = '';
let accountId = '';
let strangerAccountId = '';
let contactId = '';
let portalUserId = '';
let portalToken = '';
const userName = `portal_${runId}`;
async function call(method: Method, url: string, token: string, payload?: unknown): Promise<CallResult> {
  const res = await ctx.app.inject({ method, url, headers: authHeader(token), ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
  let body: Record<string, unknown> = {};
  try { body = res.json(); } catch { body = {}; }
  return { status: res.statusCode, body };
}
function codeOf(body: Record<string, unknown>): string {
  const error = body['error'] as { code?: string } | undefined;
  return String(error?.code ?? '');
}
beforeAll(async () => {
  ctx = await bootApi();
  adminToken = ctx.adminToken;
  const portal = await call('POST', '/api/v1/Portal', adminToken, { name: `AGENT_TEST Portal ${runId}` });
  expect(portal.status).toBe(201);
  portalId = String(portal.body['id']);
  const role = await call('POST', '/api/v1/PortalRole', adminToken, { name: `AGENT_TEST PortalRole ${runId}`,
    permissions: { Account: { read: 'all', create: 'no', edit: 'no', delete: 'no', stream: 'no' }, Contact: { read: 'all', create: 'no', edit: 'no', delete: 'no', stream: 'no' } } });
  expect(role.status).toBe(201);
  roleId = String(role.body['id']);
  const linked = await call('POST', `/api/v1/Portal/${portalId}/roles`, adminToken, { portalRoleIds: [roleId] });
  expect(linked.status).toBe(201);
  const account = await call('POST', '/api/v1/Account', adminToken, { name: `AGENT_TEST PortalAcc ${runId}` });
  expect(account.status).toBe(201);
  accountId = String(account.body['id']);
  const stranger = await call('POST', '/api/v1/Account', adminToken, { name: `AGENT_TEST StrangerAcc ${runId}` });
  expect(stranger.status).toBe(201);
  strangerAccountId = String(stranger.body['id']);
  const contact = await call('POST', '/api/v1/Contact', adminToken, { firstName: 'Portal', lastName: `User ${runId}`, accountId, status: 'Active' });
  expect(contact.status).toBe(201);
  contactId = String(contact.body['id']);
  const user = await call('POST', '/api/v1/User', adminToken, { userName, password: 'portalpass123', type: 'portal', portalId, contactId, portalRoleIds: [roleId] });
  expect(user.status).toBe(201);
  portalUserId = String(user.body['id']);
  expect(user.body['type']).toBe('portal');
  portalToken = await loginAs(ctx, userName, 'portalpass123');
});
afterAll(async () => {
  if (portalUserId) await ctx.database.db.deleteFrom('users').where('id', '=', portalUserId).execute().catch(() => undefined);
  await ctx.database.db.deleteFrom('entity_records').where('id', 'in', [accountId, strangerAccountId, contactId].filter(Boolean) as string[]).execute().catch(() => undefined);
  if (portalId) await ctx.database.db.deleteFrom('portals').where('id', '=', portalId).execute().catch(() => undefined);
  if (roleId) await ctx.database.db.deleteFrom('portal_roles').where('id', '=', roleId).execute().catch(() => undefined);
  await purgeEntityEvents(ctx.database, ['Account', 'Contact']);
  await shutdownApi();
});
describe('phase 18 - portal user surface', () => {
  it('sees its portal context with contact, roles, nav and dashboard', async () => {
    const me = await call('GET', '/api/v1/Portal/me', portalToken);
    expect(me.status).toBe(200);
    expect(me.body['portal']['id']).toBe(portalId);
    expect(me.body['contact']['id']).toBe(contactId);
    expect((me.body['roles'] as { id: string }[]).some((r) => r.id === roleId)).toBe(true);
  });
  it('reads its own contact and account', async () => {
    const contact = await call('GET', `/api/v1/Contact/${contactId}`, portalToken);
    expect(contact.status).toBe(200);
    const account = await call('GET', `/api/v1/Account/${accountId}`, portalToken);
    expect(account.status).toBe(200);
    expect(account.body['id']).toBe(accountId);
  });
  it('cannot read an unrelated account (404, no existence leak)', async () => {
    const res = await call('GET', `/api/v1/Account/${strangerAccountId}`, portalToken);
    expect(res.status).toBe(404);
    expect(codeOf(res.body)).toBe('RECORD_NOT_FOUND');
  });
  it('lists only records in its contact/account neighbourhood', async () => {
    const list = await call('GET', `/api/v1/Account?where=${encodeURIComponent(JSON.stringify([{ field: 'name', operator: 'like', value: 'AGENT_TEST' }]))}&maxSize=50`, portalToken);
    expect(list.status).toBe(200);
    const ids = (list.body['list'] as Record<string, unknown>[]).map((r) => r['id']);
    expect(ids).toContain(accountId);
    expect(ids).not.toContain(strangerAccountId);
  });
  it('is denied writes the portal role does not grant', async () => {
    const created = await call('POST', '/api/v1/Account', portalToken, { name: `AGENT_TEST Nope ${runId}` });
    expect(created.status).toBe(403);
    expect(codeOf(created.body)).toBe('AUTHORIZATION_DENIED');
  });
});
describe('phase 18 - portal isolation', () => {
  it('cannot use admin portal management', async () => {
    const list = await call('GET', '/api/v1/Portal', portalToken);
    expect(list.status).toBe(403);
    const roles = await call('GET', '/api/v1/PortalRole', portalToken);
    expect(roles.status).toBe(403);
  });
  it('cannot manage users or internal roles', async () => {
    const users = await call('GET', '/api/v1/User', portalToken);
    expect(users.status).toBe(403);
    const roles = await call('GET', '/api/v1/Role', portalToken);
    expect(roles.status).toBe(403);
  });
  it('portal users cannot hold internal roles', async () => {
    const res = await call('POST', '/api/v1/User', adminToken, { userName: `portal_bad_${runId}`, password: 'portalpass123', type: 'portal', portalId, contactId, assignedRoleIds: ['noAccess'] });
    expect(res.status).toBe(422);
    expect(codeOf(res.body)).toBe('VALIDATION_FAILED');
  });
});
