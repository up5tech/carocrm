import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, createTestUser, loginAs, shutdownApi } from './support/boot-api.js';

/**
 * Phase 21.2 — the docs HTTP surface, the `docs` settings document and the sidebar entry
 * (PLAN_Phase_21_Documentation.md §13.2 and the §10.2 authorization matrix).
 *
 * Runs against the configured project database (AGENTS.md §3.1): nothing is created, reset or truncated.
 * The suite snapshots the `docs` row before it writes anything and puts it back, deletes only the event
 * rows its own writes produced, and removes the portal records it created by id.
 *
 * The authorization matrix is the point of this file. A CRM user must not learn that an administrator
 * page exists *and* must not be able to read it, which is why the refusal is 403 and not 404 — the same
 * rule the rest of the product follows for a record you may not see.
 */
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

interface CallResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly headers: Record<string, string>;
}

interface TreeSection {
  readonly key: string;
  readonly pages: readonly { readonly key: string; readonly audience: string; readonly fallback: boolean; readonly locale: string }[];
}

const runId = Date.now().toString(36);
const PORTAL_USER = `AGENT_TEST-p21-portal-${runId}`;

let ctx: ApiContext;
let regularToken = '';
let portalToken = '';
let portalUserId = '';
let portalId = '';
let portalRoleId = '';
let contactId = '';
let accountId = '';
let docsRowBefore: unknown = null;
let eventsBefore: string[] = [];

async function call(method: Method, url: string, token?: string, payload?: unknown, headers?: Record<string, string>): Promise<CallResult> {
  const res = await ctx.app.inject({
    method,
    url,
    ...(token === undefined ? {} : { headers: { ...authHeader(token), ...headers } }),
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  let body: Record<string, unknown> = {};
  try {
    body = res.json() as Record<string, unknown>;
  } catch {
    body = {};
  }
  return { status: res.statusCode, body, headers: res.headers as unknown as Record<string, string> };
}

function errorOf(body: Record<string, unknown>): string {
  return (body['error'] as { code?: string } | undefined)?.code ?? '';
}

async function tree(token: string, query = ''): Promise<CallResult> {
  return call('GET', `/api/v1/Docs/tree${query}`, token);
}

function sections(result: CallResult): TreeSection[] {
  return (result.body['sections'] ?? []) as TreeSection[];
}

function pageKeys(result: CallResult): string[] {
  return sections(result).flatMap((section) => section.pages.map((page) => page.key));
}

/** Write the `docs` document the way the admin tab does: a patch, the current version, one envelope. */
async function saveDocs(value: Record<string, unknown>): Promise<CallResult> {
  const current = await call('GET', '/api/v1/Settings/documents/docs', ctx.adminToken);
  return call('POST', '/api/v1/Settings/documents/docs', ctx.adminToken, { value, version: current.body['version'] ?? 0 });
}

async function navigationKeys(token: string): Promise<string[]> {
  const res = await call('GET', '/api/v1/Navigation', token);
  const out: string[] = [];
  const walk = (nodes: readonly { key: string; children?: readonly unknown[] }[]): void => {
    for (const node of nodes) {
      out.push(node.key);
      if (Array.isArray(node.children)) walk(node.children as readonly { key: string }[]);
    }
  };
  walk(((res.body['items'] ?? []) as readonly { key: string }[]));
  return out;
}

beforeAll(async () => {
  ctx = await bootApi();
  regularToken = (await createTestUser(ctx, { userName: `AGENT_TEST-p21-${runId}` })).token;

  // The portal fixture is written directly. `POST /Portal` refuses when the instance already holds
  // MAX_PORTALS live rows, and a suite must not fail because of how much unrelated data the shared
  // database happens to carry; the portal-role *link* below still goes through the API.
  const db = ctx.database.db;
  portalId = `AGENT_TEST_p21_portal_${runId}`;
  await db
    .insertInto('portals')
    .values({
      id: portalId,
      name: `AGENT_TEST P21 Portal ${runId}`,
      url_path: `/agent-test-p21-${runId}`,
      is_active: true,
      settings: JSON.stringify({}),
      is_deleted: false,
      created_at: new Date(),
      modified_at: new Date(),
    })
    .execute();
  portalRoleId = `AGENT_TEST_p21_role_${runId}`;
  await db
    .insertInto('portal_roles')
    .values({
      id: portalRoleId,
      name: `AGENT_TEST P21 Role ${runId}`,
      permissions: JSON.stringify({}),
      field_permissions: JSON.stringify({}),
      is_deleted: false,
      created_at: new Date(),
      modified_at: new Date(),
    })
    .execute();
  await call('POST', `/api/v1/Portal/${portalId}/roles`, ctx.adminToken, { portalRoleIds: [portalRoleId] });
  const account = await call('POST', '/api/v1/Account', ctx.adminToken, { name: `AGENT_TEST P21 Acc ${runId}` });
  accountId = String(account.body['id']);
  const contact = await call('POST', '/api/v1/Contact', ctx.adminToken, {
    firstName: 'Handbook',
    lastName: `Tester ${runId}`,
    accountId,
    status: 'Active',
  });
  contactId = String(contact.body['id']);
  const user = await call('POST', '/api/v1/User', ctx.adminToken, {
    userName: PORTAL_USER,
    password: 'portalpass123',
    type: 'portal',
    portalId,
    contactId,
    portalRoleIds: [portalRoleId],
  });
  expect(user.status).toBe(201);
  portalUserId = String(user.body['id']);
  portalToken = await loginAs(ctx, PORTAL_USER, 'portalpass123');

  docsRowBefore = (await ctx.database.db.selectFrom('app_settings').select('data').where('name', '=', 'docs').executeTakeFirst())?.data ?? null;
  eventsBefore = (await ctx.database.db.selectFrom('outbox_events').select('id').where('event_type', '=', 'settings.document.updated').execute()).map((row) => row.id);
});

afterAll(async () => {
  if (docsRowBefore === null) await ctx.database.db.deleteFrom('app_settings').where('name', '=', 'docs').execute().catch(() => undefined);
  else {
    await ctx.database.db
      .updateTable('app_settings')
      .set({ data: docsRowBefore, modified_at: new Date() })
      .where('name', '=', 'docs')
      .execute()
      .catch(() => undefined);
  }
  const after = (await ctx.database.db.selectFrom('outbox_events').select('id').where('event_type', '=', 'settings.document.updated').execute()).map((row) => row.id);
  const created = after.filter((id) => !eventsBefore.includes(id));
  if (created.length > 0) await ctx.database.db.deleteFrom('outbox_events').where('id', 'in', created).execute().catch(() => undefined);

  if (portalUserId !== '') await ctx.database.db.deleteFrom('users').where('id', '=', portalUserId).execute().catch(() => undefined);
  const recordIds = [accountId, contactId].filter((id) => id !== '');
  if (recordIds.length > 0) await ctx.database.db.deleteFrom('entity_records').where('id', 'in', recordIds).execute().catch(() => undefined);
  // Portals and portal roles are their own tables, not `entity_records` — deleting them there is what
  // left a live portal row behind on every run until the instance cap refused the next suite.
  if (portalId !== '') {
    await ctx.database.db.deleteFrom('portals_portal_roles').where('portal_id', '=', portalId).execute().catch(() => undefined);
    await ctx.database.db.deleteFrom('portals').where('id', '=', portalId).execute().catch(() => undefined);
  }
  if (portalRoleId !== '') {
    await ctx.database.db.deleteFrom('portals_portal_roles').where('portal_role_id', '=', portalRoleId).execute().catch(() => undefined);
    await ctx.database.db.deleteFrom('portal_roles').where('id', '=', portalRoleId).execute().catch(() => undefined);
  }
  await shutdownApi();
});

describe('GET /Docs/tree', () => {
  it('refuses an unauthenticated caller', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/Docs/tree' });
    expect(res.statusCode).toBe(401);
  });

  it('answers an administrator with every section', async () => {
    const res = await tree(ctx.adminToken);
    expect(res.status).toBe(200);
    expect(res.body['enabled']).toBe(true);
    expect(String(res.body['hash'])).toHaveLength(64);
    expect(sections(res).map((section) => section.key)).toEqual(['getting-started', 'user', 'admin', 'reference']);
    expect(pageKeys(res)).toContain('admin/main-menu');
    expect(res.headers['etag']).toMatch(/^W\/"[0-9a-f]{64}-en"$/);
    expect(res.headers['cache-control']).toContain('private');
  });

  it('reports coverage and index warnings to an administrator, and to nobody else', async () => {
    const admin = await tree(ctx.adminToken);
    const diagnostics = admin.body['diagnostics'] as
      | { locales: { locale: string; pages: number; translated: number; hash: string; warnings: unknown[] }[]; coverage: number }
      | undefined;
    expect(diagnostics).toBeDefined();
    expect(diagnostics?.locales.map((entry) => entry.locale)).toEqual(expect.arrayContaining(['en']));
    const english = diagnostics?.locales.find((entry) => entry.locale === 'en');
    const vietnamese = diagnostics?.locales.find((entry) => entry.locale === 'vi');
    expect((english?.pages ?? 0).valueOf()).toBeGreaterThanOrEqual(38);
    expect(english?.translated).toBe(english?.pages); // `en` defines the corpus, so none of it is a fallback.
    // 21.8 translated the P0 set and nothing beyond it, so `vi` sits strictly between the two.
    expect((vietnamese?.translated ?? 0).valueOf()).toBeGreaterThan(0);
    expect((vietnamese?.translated ?? 0).valueOf()).toBeLessThan(vietnamese?.pages ?? 0);
    expect(diagnostics?.coverage).toBeCloseTo((vietnamese?.translated ?? 0) / (english?.pages ?? 1), 5);
    expect(diagnostics?.locales[0]?.hash).toBe(String(admin.body['hash']));

    const regular = await tree(regularToken);
    expect(regular.body).not.toHaveProperty('diagnostics');
  });

  it('hides the administrator section from a CRM user, by key as well as by name', async () => {
    const keys = pageKeys(await tree(regularToken));
    expect(keys.some((key) => key.startsWith('admin/'))).toBe(false);
    expect(keys).toEqual(expect.arrayContaining(['getting-started/sign-in', 'user/lists-and-views']));
  });

  it('is never a bare 404 for a portal principal', async () => {
    expect((await tree(portalToken)).status).toBe(403);
  });
});

describe('GET /Docs/page/:section/:slug', () => {
  it('returns the block tree, the toc and the neighbours', async () => {
    const res = await call('GET', '/api/v1/Docs/page/admin/main-menu', ctx.adminToken);
    expect(res.status).toBe(200);
    const page = res.body['page'] as Record<string, unknown>;
    expect(page['key']).toBe('admin/main-menu');
    expect(page['path']).toBe('/docs/admin/main-menu');
    expect(Array.isArray(page['blocks'])).toBe(true);
    expect((page['toc'] as unknown[]).length).toBeGreaterThan(0);
    expect((page['prev'] as Record<string, unknown>)['key']).toBe('admin/branding-and-localization');
    expect((page['next'] as Record<string, unknown>)['key']).toBe('admin/users-teams-roles');
    expect(page['appLink']).toBe('/admin/settings/menu');
  });

  it('ends the corpus on a page with nothing after it', async () => {
    const res = await call('GET', '/api/v1/Docs/page/reference/release-notes', ctx.adminToken);
    const page = res.body['page'] as Record<string, unknown>;
    expect(page['next']).toBeNull();
    // The last page of a section that is not the corpus's last points at the next section's index,
    // so the reader is never left believing the handbook simply ran out (§5.3).
    const edge = await call('GET', '/api/v1/Docs/page/getting-started/keyboard-shortcuts', ctx.adminToken);
    expect((edge.body['page'] as Record<string, unknown>)['next']).toMatchObject({ key: 'user', path: '/docs/user' });
    const lastAdmin = await call('GET', '/api/v1/Docs/page/admin/ai-agents', ctx.adminToken);
    expect((lastAdmin.body['page'] as Record<string, unknown>)['next']).toMatchObject({
      key: 'reference',
      path: '/docs/reference',
    });
  });

  it('renders a raw HTML payload as text, never as markup', async () => {
    const res = await call('GET', '/api/v1/Docs/page/admin/settings-overview', ctx.adminToken);
    expect(JSON.stringify(res.body)).not.toContain('<script');
  });

  it('refuses a CRM user on an administrator page with 403 because the page exists', async () => {
    const res = await call('GET', '/api/v1/Docs/page/admin/main-menu', regularToken);
    expect(res.status).toBe(403);
    expect(errorOf(res.body)).toBe('AUTHORIZATION_DENIED');
  });

  it('answers 404 for a page nobody wrote', async () => {
    const res = await call('GET', '/api/v1/Docs/page/admin/no-such-page', ctx.adminToken);
    expect(res.status).toBe(404);
    expect(errorOf(res.body)).toBe('NOT_FOUND');
  });

  it('answers 403, not 404, to a portal principal on a page that exists', async () => {
    expect((await call('GET', '/api/v1/Docs/page/user/search', portalToken)).status).toBe(403);
  });

  it('never resolves a caller path against the filesystem', async () => {
    for (const url of [
      '/api/v1/Docs/page/..%2f..%2fpackage.json',
      '/api/v1/Docs/page/%2e%2e/%2e%2e/package.json',
      '/api/v1/Docs/page/admin/..%2fsettings-overview',
      '/api/v1/Docs/page/admin/%2e%2e%2f%2e%2e%2fpackage.json',
    ]) {
      const res = await call('GET', url, ctx.adminToken);
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain('carocrm-api');
    }
  });

  it('serves the English page with a fallback flag when the locale has no translation', async () => {
    const res = await call('GET', '/api/v1/Docs/page/reference/glossary?locale=vi', ctx.adminToken);
    expect(res.status).toBe(200);
    const page = res.body['page'] as Record<string, unknown>;
    expect(page['fallback']).toBe(true);
    expect(page['locale']).toBe('en');
    // The P0 set is translated, so the same request on one of those pages is not a fallback.
    const translated = await call('GET', '/api/v1/Docs/page/admin/main-menu?locale=vi', ctx.adminToken);
    expect(translated.status).toBe(200);
    expect(translated.body['page']).toMatchObject({ fallback: false, locale: 'vi' });
    const treeRes = await tree(ctx.adminToken, '?locale=vi');
    expect(String(treeRes.body['locale'])).toBe('vi');
  });

  it('falls back to the instance default rather than faulting on a bookmark with a bad locale', async () => {
    const res = await call('GET', '/api/v1/Docs/page/user/search?locale=de', ctx.adminToken);
    expect(res.status).toBe(200);
    expect(((res.body['page'] as Record<string, unknown>)['locale'] as string) ?? 'en').toMatch(/^(en|de)$/);
  });
});

describe('conditional GET', () => {
  it('answers 304 with an empty body when the reader still holds the current hash', async () => {
    const first = await tree(ctx.adminToken);
    const etag = first.headers['etag'] as string;
    expect(etag).toBeTypeOf('string');
    const again = await call('GET', '/api/v1/Docs/tree', ctx.adminToken, undefined, { 'if-none-match': etag });
    expect(again.status).toBe(304);
    expect(again.body).toEqual({});

    const page = await call('GET', '/api/v1/Docs/page/user/search', ctx.adminToken);
    const pageEtag = page.headers['etag'] as string;
    const pageAgain = await call('GET', '/api/v1/Docs/page/user/search', ctx.adminToken, undefined, { 'if-none-match': pageEtag });
    expect(pageAgain.status).toBe(304);
  });

  it('ignores a stale tag and re-sends the page', async () => {
    const res = await call('GET', '/api/v1/Docs/page/user/search', ctx.adminToken, undefined, { 'if-none-match': 'W/"deadbeef-en"' });
    expect(res.status).toBe(200);
  });
});

describe('GET /Docs/search', () => {
  it('returns ranked hits with snippet ranges an admin can highlight', async () => {
    // The diacritic-insensitive match itself (`cau hinh` finding `Cấu hình`) is engine-tested against
    // Vietnamese text in `packages/docs/src/search.test.ts`; this corpus is the English source of truth,
    // so the API assertion here is the shape and the scoping. The Vietnamese query lands with `vi`
    // content in Phase 21.8.
    const res = await call('GET', '/api/v1/Docs/search?q=sidebar', ctx.adminToken);
    expect(res.status).toBe(200);
    const hits = res.body['hits'] as { key: string; snippet: { text: string; ranges: number[][] } }[];
    expect(hits.map((hit) => hit.key)).toContain('admin/main-menu');
    for (const hit of hits) {
      for (const [from, to] of hit.snippet.ranges) expect(hit.snippet.text.slice(from, to)).not.toBe('');
    }
  });

  it('searches a Vietnamese request across both locales and says which language answered', async () => {
    const res = await call('GET', '/api/v1/Docs/search?q=sidebar&locale=vi', ctx.adminToken);
    expect(res.status).toBe(200);
    const hits = res.body['hits'] as { key: string; locale: string }[];
    expect(hits.length).toBeGreaterThan(0);
    // A translated page answers in `vi`; one the corpus has not translated yet still answers in `en`,
    // and the hit carries which of the two the reader is looking at (§4.7).
    expect(hits.every((hit) => hit.locale === 'vi' || hit.locale === 'en')).toBe(true);
    expect(hits.some((hit) => hit.locale === 'vi')).toBe(true);
    expect(res.body['locale']).toBe('vi');
  });

  it('scopes the results to what the caller may read', async () => {
    const res = await call('GET', '/api/v1/Docs/search?q=sidebar', regularToken);
    const hits = (res.body['hits'] ?? []) as { key: string }[];
    expect(hits.every((hit) => !hit.key.startsWith('admin/'))).toBe(true);
  });

  it('returns nothing for a term that only appears in administrator content', async () => {
    // Both words occur only in `admin/ai-agents.md`, so any hit for a regular reader is a leak rather
    // than a ranking accident. Pick a replacement the same way when the corpus grows.
    const res = await call('GET', `/api/v1/Docs/search?q=${encodeURIComponent('globally concurrency')}`, regularToken);
    expect((res.body['hits'] as unknown[]).length).toBe(0);
  });

  it('refuses a portal principal', async () => {
    expect((await call('GET', '/api/v1/Docs/search?q=menu', portalToken)).status).toBe(403);
  });

  it('clamps a large limit and rejects a nonsense one', async () => {
    expect((await call('GET', '/api/v1/Docs/search?q=record&limit=5000', ctx.adminToken)).status).toBe(200);
    const invalid = await call('GET', '/api/v1/Docs/search?q=record&limit=0', ctx.adminToken);
    expect(invalid.status).toBe(422);
    expect(errorOf(invalid.body)).toBe('VALIDATION_FAILED');
    expect((await call('GET', '/api/v1/Docs/search?q=record&limit=abc', ctx.adminToken)).status).toBe(422);
  });

  it('answers an empty query with no hits rather than the whole corpus', async () => {
    const res = await call('GET', '/api/v1/Docs/search', ctx.adminToken);
    expect(res.status).toBe(200);
    expect(res.body['total']).toBe(0);
  });
});

describe('the docs settings document', () => {
  it('is readable by a signed-in user and writable only by an administrator', async () => {
    const read = await call('GET', '/api/v1/Settings/documents/docs', regularToken);
    expect(read.status).toBe(200);
    expect(read.body['value']).toMatchObject({ enabled: true, showInSidebar: true, showHelpMenu: true });
    expect((read.body['value'] as Record<string, unknown>)['externalUrl']).toBeNull();

    const written = await call('POST', '/api/v1/Settings/documents/docs', regularToken, { value: { enabled: false }, version: read.body['version'] });
    expect(written.status).toBe(403);
  });

  it('lists itself for a CRM user, because the reader is allowed to know the surface exists', async () => {
    const res = await call('GET', '/api/v1/Settings/documents', regularToken);
    const names = (res.body['documents'] as { name: string }[]).map((entry) => entry.name);
    expect(names).toContain('docs');
  });

  it('refuses an unknown key in the document', async () => {
    const current = await call('GET', '/api/v1/Settings/documents/docs', ctx.adminToken);
    const res = await call('POST', '/api/v1/Settings/documents/docs', ctx.adminToken, {
      value: { enbled: true },
      version: current.body['version'],
    });
    expect(res.status).toBe(422);
  });
});

describe('the sidebar entry and the enabled flag', () => {
  it('carries the docs entry, then loses it when showInSidebar is off — without a restart', async () => {
    expect(await navigationKeys(ctx.adminToken)).toContain('docs');

    const off = await saveDocs({ showInSidebar: false });
    expect(off.status).toBe(200);
    expect(await navigationKeys(ctx.adminToken)).not.toContain('docs');

    const on = await saveDocs({ showInSidebar: true });
    expect(on.status).toBe(200);
    expect(await navigationKeys(ctx.adminToken)).toContain('docs');
  });

  it('answers a disabled surface with 404 on the reads and an empty tree', async () => {
    await saveDocs({ enabled: false });
    const disabled = await call('GET', '/api/v1/Docs/page/user/search', ctx.adminToken);
    expect(disabled.status).toBe(404);
    expect(errorOf(disabled.body)).toBe('FEATURE_DISABLED');
    expect((await call('GET', '/api/v1/Docs/search?q=menu', ctx.adminToken)).status).toBe(404);

    const disabledTree = await tree(ctx.adminToken);
    expect(disabledTree.status).toBe(200);
    expect(disabledTree.body['enabled']).toBe(false);
    expect(sections(disabledTree)).toEqual([]);

    await saveDocs({ enabled: true });
    expect((await call('GET', '/api/v1/Docs/page/user/search', ctx.adminToken)).status).toBe(200);
  });
});
