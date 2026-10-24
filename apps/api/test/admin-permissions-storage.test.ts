import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiContext, TestUser } from './support/boot-api.js';
import { ADMIN_LOGIN, ADMIN_PASSWORD, authHeader, bootApi, createTestRole, createTestUser, loginAs, shutdownApi } from './support/boot-api.js';

/**
 * Phase 20 §4.8 — the Permissions tab's explain helper and the Attachments tab's storage figures.
 *
 * The rule the explanation must never break: it answers with **the same evaluation the request path
 * runs**, because an explainer that disagrees with the enforcement is worse than no explainer. It is
 * also administration data about another account, so it stays administrator-only.
 */
interface Explanation {
  readonly userId: string;
  readonly userName: string;
  readonly entity: string;
  readonly action: string;
  readonly level: string;
  readonly administrator: boolean;
  readonly roles: readonly { id: string; name: string; level: string }[];
}

const runId = Date.now().toString(36);
const ROLE_ID = `AGENT_TEST-p20-explain-${runId}`;

let ctx: ApiContext;
let adminToken = '';
let rep: TestUser;

async function call(
  method: 'GET' | 'POST',
  url: string,
  token: string | undefined,
  payload?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await ctx.app.inject({
    method,
    url,
    ...(token === undefined ? {} : { headers: authHeader(token) }),
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

beforeAll(async () => {
  ctx = await bootApi();
  adminToken = await loginAs(ctx, ADMIN_LOGIN, ADMIN_PASSWORD);
  await createTestRole(ctx, {
    id: ROLE_ID,
    name: `AGENT_TEST phase20 explain ${runId}`,
    permissions: { Account: { read: 'all', create: 'no', edit: 'own', delete: 'no', stream: 'no' } },
  });
  rep = await createTestUser(ctx, { userName: `AGENT_TEST-p20-explain-${runId}`, roleIds: [ROLE_ID] });
});

afterAll(async () => {
  await shutdownApi();
});

describe('POST /AdminPanel/action/acl-explain', () => {
  it('reports the level the role states, not a client-side guess', async () => {
    const read = await call('POST', '/api/v1/AdminPanel/action/acl-explain', adminToken, {
      userId: rep.id,
      entity: 'Account',
      action: 'read',
    });
    expect(read.status).toBe(200);
    const explanation = read.body as unknown as Explanation;
    expect(explanation.level).toBe('all');
    expect(explanation.administrator).toBe(false);
    expect(explanation.userName).toBe(rep.userName);
    expect(explanation.roles).toHaveLength(1);
    expect(explanation.roles[0]?.id).toBe(ROLE_ID);
    expect(explanation.roles[0]?.level).toBe('all');
  });

  it('reports "no" where the role states no', async () => {
    const remove = await call('POST', '/api/v1/AdminPanel/action/acl-explain', adminToken, {
      userId: rep.id,
      entity: 'Account',
      action: 'delete',
    });
    expect(remove.status).toBe(200);
    expect((remove.body as unknown as Explanation).level).toBe('no');
  });

  it('short-circuits an administrator account, exactly like the request path', async () => {
    const me = await call('GET', '/api/v1/User/assignable?q=admin', adminToken);
    const adminId = (me.body['list'] as { id: string }[])[0]?.id;
    expect(adminId).toBeDefined();
    const result = await call('POST', '/api/v1/AdminPanel/action/acl-explain', adminToken, {
      userId: adminId,
      entity: 'Account',
      action: 'delete',
    });
    expect(result.status).toBe(200);
    const explanation = result.body as unknown as Explanation;
    expect(explanation.administrator).toBe(true);
    expect(explanation.level).toBe('all');
  });

  it('refuses a non-administrator', async () => {
    const result = await call('POST', '/api/v1/AdminPanel/action/acl-explain', rep.token, {
      userId: rep.id,
      entity: 'Account',
      action: 'read',
    });
    expect(result.status).toBe(403);
  });

  it('validates the request body', async () => {
    const result = await call('POST', '/api/v1/AdminPanel/action/acl-explain', adminToken, {
      userId: rep.id,
      entity: 'Account',
      action: 'share',
    });
    expect(result.status).toBe(422);
  });
});

describe('GET /StorageUsage', () => {
  it('reports counts and bytes for an administrator', async () => {
    const result = await call('GET', '/api/v1/StorageUsage', adminToken);
    expect(result.status).toBe(200);
    expect(typeof result.body['attachments']).toBe('number');
    expect(typeof result.body['bytes']).toBe('number');
    expect(result.body['bytes'] as number).toBeGreaterThanOrEqual(0);
    const largest = result.body['largest'];
    expect(largest === null || (typeof largest === 'object' && largest !== null)).toBe(true);
  });

  it('refuses a non-administrator', async () => {
    const result = await call('GET', '/api/v1/StorageUsage', rep.token);
    expect(result.status).toBe(403);
  });
});
