import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiContext, TestUser } from './support/boot-api.js';
import { ADMIN_LOGIN, ADMIN_PASSWORD, authHeader, bootApi, createTestRole, createTestUser, loginAs, shutdownApi } from './support/boot-api.js';

/**
 * Phase 20 §5.3 — row actions and bulk writes (PLAN_Phase_20_Settings_UX.md).
 *
 * The list view used to offer Edit and Delete to everybody and could only delete in bulk. The rules
 * this suite protects: the **action catalog is decided on the server** (`POST /:entity/action/rowActions`)
 * so a rep never sees an action their role forbids, and a bulk write **reports outcomes** — how many
 * records changed and how many were skipped — instead of an intention.
 */
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

interface CallResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

interface RowActionSet {
  readonly open: boolean;
  readonly edit: boolean;
  readonly assign: boolean;
  readonly follow: boolean;
  readonly delete: boolean;
}

const runId = Date.now().toString(36);
const EDIT_ROLE = `AGENT_TEST-p20-rowedit-${runId}`;
const READ_ROLE = `AGENT_TEST-p20-rowread-${runId}`;
const RUN_MARKER = `AGENT_TEST-row-actions-${runId}`;

let ctx: ApiContext;
let adminToken = '';
let editor: TestUser;
const accountIds: string[] = [];

async function call(method: Method, url: string, token?: string, payload?: unknown): Promise<CallResult> {
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

async function rowActions(token: string): Promise<RowActionSet> {
  const result = await call('POST', '/api/v1/Account/action/rowActions', token);
  expect(result.status).toBe(200);
  return result.body as unknown as RowActionSet;
}

beforeAll(async () => {
  ctx = await bootApi();
  adminToken = await loginAs(ctx, ADMIN_LOGIN, ADMIN_PASSWORD);

  await createTestRole(ctx, {
    id: EDIT_ROLE,
    name: `AGENT_TEST phase20 row edit ${runId}`,
    permissions: { Account: { read: 'all', create: 'no', edit: 'own', delete: 'no', stream: 'all' } },
  });
  await createTestRole(ctx, {
    id: READ_ROLE,
    name: `AGENT_TEST phase20 row read ${runId}`,
    permissions: { Account: { read: 'all', create: 'no', edit: 'no', delete: 'no', stream: 'no' } },
  });
  editor = await createTestUser(ctx, { userName: `AGENT_TEST-p20-editor-${runId}`, roleIds: [EDIT_ROLE] });

  for (const suffix of ['A', 'B']) {
    const created = await call('POST', '/api/v1/Account', adminToken, {
      name: `${RUN_MARKER}-${suffix}`,
      industry: 'before',
    });
    expect(created.status).toBe(201);
    accountIds.push(String(created.body['id']));
  }
});

afterAll(async () => {
  // Only the records this run created: two accounts, deleted through the API like any other.
  if (accountIds.length > 0) {
    await call('POST', '/api/v1/Account/action/massDelete', adminToken, { ids: accountIds });
  }
  await shutdownApi();
});

describe('row actions are decided by the server', () => {
  it('offers an administrator every action the entity supports', async () => {
    expect(await rowActions(adminToken)).toEqual({ open: true, edit: true, assign: true, follow: true, delete: true });
  });

  it('offers a reader nothing that writes', async () => {
    const reader = await createTestUser(ctx, { userName: `AGENT_TEST-p20-reader-${runId}`, roleIds: [READ_ROLE] });
    expect(await rowActions(reader.token)).toEqual({ open: true, edit: false, assign: false, follow: false, delete: false });
  });

  it('keeps edit for an own-level role but not delete or follow where the role says no', async () => {
    const actions = await rowActions(editor.token);
    expect(actions.edit).toBe(true);
    expect(actions.assign).toBe(true);
    expect(actions.delete).toBe(false);
    // The role sets stream to `all`, so following is allowed even though deleting is not.
    expect(actions.follow).toBe(true);
  });

  it('refuses a write the role forbids with 403', async () => {
    const reader = await createTestUser(ctx, { userName: `AGENT_TEST-p20-reader2-${runId}`, roleIds: [READ_ROLE] });
    const result = await call('POST', '/api/v1/Account/action/massUpdate', reader.token, {
      ids: accountIds,
      data: { industry: 'reader-write' },
    });
    expect(result.status).toBe(403);
  });
});

describe('bulk writes report outcomes', () => {
  it('reports how many records changed, so a missing id is a skip and not an error', async () => {
    const result = await call('POST', '/api/v1/Account/action/massUpdate', adminToken, {
      ids: [...accountIds, `missing-${runId}`],
      data: { industry: RUN_MARKER },
    });
    expect(result.status).toBe(200);
    expect(result.body['count']).toBe(accountIds.length);
    expect((result.body['ids'] as string[]).sort()).toEqual([...accountIds].sort());

    for (const id of accountIds) {
      const record = await call('GET', `/api/v1/Account/${id}`, adminToken);
      expect(record.body['industry']).toBe(RUN_MARKER);
    }
  });

  it('assigns the owner through the same route', async () => {
    const result = await call('POST', '/api/v1/Account/action/massUpdate', adminToken, {
      ids: accountIds,
      data: { assignedUserId: editor.id },
    });
    expect(result.status).toBe(200);
    expect(result.body['count']).toBe(accountIds.length);

    const first = accountIds[0] as string;
    const record = await call('GET', `/api/v1/Account/${first}`, adminToken);
    expect(record.body['assignedUserId']).toBe(editor.id);
  });

  it('lets a role follow a record it may read', async () => {
    const first = accountIds[0] as string;
    const result = await call('PUT', `/api/v1/Account/${first}/subscription`, editor.token);
    expect(result.status).toBe(200);
  });

  it('lists assignees for an internal caller without exposing the user record', async () => {
    // The lookup is capped and ordered, so the test asks for its own account by name — which is
    // also the way the picker narrows a long list.
    const result = await call('GET', `/api/v1/User/assignable?q=${encodeURIComponent(editor.userName)}`, editor.token);
    expect(result.status).toBe(200);
    const list = result.body['list'] as { id: string; name: string }[];
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBe(1);
    const entry = list.find((candidate) => candidate.id === editor.id);
    expect(entry).toBeDefined();
    // An id and a display name only: no roles, teams, flags or email.
    expect(Object.keys(entry ?? {}).sort()).toEqual(['id', 'name']);
  });
});
