import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, createTestRole, createTestUser, shutdownApi } from './support/boot-api.js';

/**
 * Phase 20.4, 20.5 and 20.6 — the resolved menu (PLAN_Phase_20_Settings_UX.md §4.4, §4.5, §13.2).
 *
 * The rules this suite exists to protect: the document is presentation only, the ACL decides last,
 * and with no document written the tree is the menu the sidebar used to build in code.
 */
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

interface CallResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

interface Node {
  readonly key: string;
  readonly route: string;
  readonly label: string;
  readonly children?: readonly Node[];
}

interface Tree {
  readonly version: number;
  readonly items: readonly Node[];
  readonly warnings: readonly { code: string; message: string }[];
}

const runId = Date.now().toString(36);
const ROLE_ACCOUNT_ONLY = `AGENT_TEST-p20-role-${runId}`;

let ctx: ApiContext;
let repToken = '';
let nobodyToken = '';
let navigationRow: unknown = null;

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

async function navigation(token: string): Promise<Tree> {
  return (await call('GET', '/api/v1/Navigation', token)).body as unknown as Tree;
}

/** Depth-first keys, so a nested submenu entry is found without walking the tree by hand. */
function keys(tree: Tree): Set<string> {
  const out = new Set<string>();
  const walk = (nodes: readonly Node[]): void => {
    for (const node of nodes) {
      out.add(node.key);
      if (node.children) walk(node.children);
    }
  };
  walk(tree.items);
  return out;
}

function find(tree: Tree, key: string): Node | undefined {
  const walk = (nodes: readonly Node[]): Node | undefined => {
    for (const node of nodes) {
      if (node.key === key) return node;
      const nested = node.children === undefined ? undefined : walk(node.children);
      if (nested) return nested;
    }
    return undefined;
  };
  return walk(tree.items);
}

async function writeNavigation(items: readonly unknown[]): Promise<CallResult> {
  const current = await call('GET', '/api/v1/Settings/documents/navigation', ctx.adminToken);
  return call('POST', '/api/v1/Settings/documents/navigation', ctx.adminToken, {
    value: { items },
    version: (current.body['version'] as number) ?? 0,
  });
}

beforeAll(async () => {
  ctx = await bootApi();
  const rows = await ctx.database.db.selectFrom('app_settings').select('data').where('name', '=', 'navigation').execute();
  navigationRow = rows[0]?.data ?? null;
  await createTestRole(ctx, { id: ROLE_ACCOUNT_ONLY, name: `AGENT_TEST P20 ${runId}`, permissions: { Account: { read: 'all' } } });
  repToken = (await createTestUser(ctx, { userName: `AGENT_TEST p20-rep-${runId}`, roleIds: [ROLE_ACCOUNT_ONLY] })).token;
  nobodyToken = (await createTestUser(ctx, { userName: `AGENT_TEST p20-none-${runId}` })).token;
});

afterAll(async () => {
  const db = ctx.database.db;
  if (navigationRow === null) await db.deleteFrom('app_settings').where('name', '=', 'navigation').execute();
  else {
    const serialized = JSON.stringify(navigationRow);
    await db
      .insertInto('app_settings')
      .values({ name: 'navigation', data: serialized, modified_at: new Date() })
      .onConflict((oc) => oc.column('name').doUpdateSet({ data: serialized, modified_at: new Date() }))
      .execute();
  }
  await db.deleteFrom('roles').where('id', '=', ROLE_ACCOUNT_ONLY).execute();
  const events = await db.selectFrom('outbox_events').select('id').where('event_type', '=', 'settings.document.updated').execute();
  if (events.length > 0) await db.deleteFrom('outbox_events').where('id', 'in', events.map((row) => row.id)).execute();
  await shutdownApi();
});

describe('navigation resolution', () => {
  it('serves the shipped menu to an administrator when no document is configured', async () => {
    await writeNavigation([]);
    const tree = await navigation(ctx.adminToken);
    const seen = keys(tree);

    for (const key of ['home', 'search', 'dashboards', 'reports', 'stream', 'calendar', 'myTasks']) expect(seen.has(key)).toBe(true);
    expect(seen.has('group:records')).toBe(true);
    expect(seen.has('group:administration')).toBe(true);
    // The module submenus the sidebar hard-coded are now resolved entries.
    for (const key of ['group:customers', 'group:activities', 'group:serviceDesk', 'group:knowledge', 'group:customerSuccess', 'group:project', 'group:sales', 'group:marketing']) {
      expect(seen.has(key)).toBe(true);
    }
    expect(seen.has('entity:Contact')).toBe(true);
    expect(find(tree, 'admin:settings')?.route).toBe('/admin/settings');
  });

  it('orders the top level deterministically and honours a reordering', async () => {
    await writeNavigation([]);
    const before = await navigation(ctx.adminToken);
    expect(before.items[0]?.key).toBe('home');

    await writeNavigation([{ key: 'dashboards', enabled: true, order: 5 }]);
    const after = await navigation(ctx.adminToken);
    expect(after.items[0]?.key).toBe('dashboards');
    expect(keys(after).has('home')).toBe(true);
  });

  it('hides a disabled entry and shows it again when the override is removed', async () => {
    await writeNavigation([{ key: 'home', enabled: false }]);
    expect(keys(await navigation(ctx.adminToken)).has('home')).toBe(false);

    await writeNavigation([]);
    expect(keys(await navigation(ctx.adminToken)).has('home')).toBe(true);
  });

  it('never lets the document widen access: an unreadable entity stays out whatever it says', async () => {
    await writeNavigation([{ key: 'entity:Contact', enabled: true, labelKey: 'core.app.home' }]);
    const rep = await navigation(repToken);
    const seen = keys(rep);
    expect(seen.has('entity:Account')).toBe(true);
    expect(seen.has('entity:Contact')).toBe(false);
    // The record API is unchanged by any of this: hiding is presentation, enforcement is the ACL.
    expect((await call('GET', '/api/v1/Contact', repToken)).status).toBe(403);
    expect((await call('GET', '/api/v1/Account', repToken)).status).toBe(200);

    await writeNavigation([]);
  });

  it('drops a group whose members the caller cannot read', async () => {
    const rep = await navigation(repToken);
    expect(keys(rep).has('group:activities')).toBe(false);
    expect(keys(rep).has('group:customers')).toBe(true);
  });

  it('gives a user with no roles no record groups and no administration', async () => {
    const nobody = await navigation(nobodyToken);
    expect(keys(nobody).has('group:administration')).toBe(false);
    expect(keys(nobody).has('entity:Account')).toBe(false);
    expect(keys(nobody).has('group:records')).toBe(false);
    expect(keys(nobody).has('home')).toBe(true);
  });

  it('ignores an unknown key and warns about it instead of failing', async () => {
    const res = await writeNavigation([{ key: 'entity:NoSuchRecord', enabled: true }, { key: 'group:notAThing', enabled: false }]);
    expect(res.status).toBe(200);
    const tree = await navigation(ctx.adminToken);
    expect(keys(tree).has('entity:NoSuchRecord')).toBe(false);
    expect(tree.warnings.some((warning) => warning.code === 'unknownKey')).toBe(true);

    await writeNavigation([]);
  });

  it('applies an icon and accent override from the allowlist', async () => {
    await writeNavigation([{ key: 'home', enabled: true, order: 10, icon: 'StarOutlined', accent: 'green' }]);
    const home = find(await navigation(ctx.adminToken), 'home');
    expect(home?.label).toBeTypeOf('string');
    const res = await call('GET', '/api/v1/Settings/documents/navigation', ctx.adminToken);
    expect(JSON.stringify(res.body['value'])).toContain('StarOutlined');

    await writeNavigation([]);
  });

  it('honours per-entity nav metadata and keeps the record API working', async () => {
    const stored = await ctx.database.db.selectFrom('app_settings').select('data').where('name', '=', 'entity').executeTakeFirst();
    const entityOverrides = stored?.data ?? {};
    try {
      const patch = await call('POST', '/api/v1/Metadata/Contact', ctx.adminToken, { nav: { hidden: true } });
      expect(patch.status).toBe(200);
      const tree = await navigation(ctx.adminToken);
      expect(keys(tree).has('entity:Contact')).toBe(false);
      // Hiding is navigation only — the record and its URL stay usable (§4.5).
      expect((await call('GET', '/api/v1/Metadata/Contact', ctx.adminToken)).status).toBe(200);

      const badGroup = await call('POST', '/api/v1/Metadata/Contact', ctx.adminToken, { nav: { group: 'notAGroup' } });
      expect(badGroup.status).toBe(422);

      const reveal = await call('POST', '/api/v1/Metadata/Contact', ctx.adminToken, { nav: { hidden: false } });
      expect(reveal.status).toBe(200);
      expect(keys(await navigation(ctx.adminToken)).has('entity:Contact')).toBe(true);
    } finally {
      const serialized = JSON.stringify(entityOverrides);
      await ctx.database.db
        .insertInto('app_settings')
        .values({ name: 'entity', data: serialized, modified_at: new Date() })
        .onConflict((oc) => oc.column('name').doUpdateSet({ data: serialized, modified_at: new Date() }))
        .execute();
    }
  });

  it('answers the admin panel with the tabs this caller may open', async () => {
    const admin = await call('GET', '/api/v1/AdminPanel', ctx.adminToken);
    expect(admin.status).toBe(200);
    const groups = admin.body['groups'] as { key: string; tabs: { key: string; kind: string }[] }[];
    expect(admin.body['defaultTab']).toBe('general');
    expect(groups.some((group) => group.key === 'system' && group.tabs.some((tab) => tab.key === 'menu'))).toBe(true);
    expect(groups.some((group) => group.tabs.some((tab) => tab.kind === 'tab' && tab.key === 'sales'))).toBe(true);

    const rep = await call('GET', '/api/v1/AdminPanel', repToken);
    expect(rep.status).toBe(200);
    expect((rep.body['groups'] as unknown[]).length).toBe(0);
    expect(rep.body['defaultTab']).toBeNull();
  });
});
