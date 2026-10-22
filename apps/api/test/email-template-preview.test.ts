import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, createTestRole, createTestUser, purgeEntityEvents, shutdownApi } from './support/boot-api.js';

// Nothing here sends mail; the transport is pinned to memory before the app boots (AGENTS.md §3.3).
process.env.MAIL_TRANSPORT = 'memory';

const runId = `etp${Date.now().toString(36)}`;

let ctx: ApiContext;
let adminToken = '';
const contactIds: string[] = [];
const templateIds: string[] = [];

async function call(method: 'GET' | 'POST', url: string, token: string | undefined, payload?: unknown) {
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

function codeOf(result: { body: Record<string, unknown> }): string {
  return String(((result.body['error'] ?? {}) as { code?: string }).code ?? '');
}

/** A contact the preview can personalise from; the name is unmistakably test data (§3.3). */
async function createContact(data: Record<string, unknown>): Promise<string> {
  const res = await call('POST', '/api/v1/Contact', adminToken, { name: `AGENT_TEST ${runId}`, ...data });
  const id = res.body['id'];
  if (typeof id === 'string') contactIds.push(id);
  return id;
}

async function preview(payload: unknown, token: string | null = adminToken) {
  return call('POST', '/api/v1/EmailTemplate/action/preview', token ?? undefined, payload);
}

let sampleContactId = '';

beforeAll(async () => {
  ctx = await bootApi();
  adminToken = ctx.adminToken;
  sampleContactId = await createContact({ firstName: `Nora ${runId}`, lastName: 'Nguyen', emailAddress: `nora-${runId}@example.com` });
});

afterAll(async () => {
  // Only the rows this run created are removed (AGENTS.md §3.3).
  for (const id of templateIds) await ctx.app.inject({ method: 'DELETE', url: `/api/v1/EmailTemplate/${id}`, headers: authHeader(adminToken) });
  for (const id of contactIds) await ctx.app.inject({ method: 'DELETE', url: `/api/v1/Contact/${id}`, headers: authHeader(adminToken) });
  await purgeEntityEvents(ctx.database, ['EmailTemplate', 'Contact']);
  await shutdownApi(ctx);
});

describe('EmailTemplate preview', () => {
  it('refuses an unauthenticated caller', async () => {
    const result = await preview({ subject: 'Hi' }, null);
    expect(result.status).toBe(401);
  });

  it('refuses a principal with no EmailTemplate read permission', async () => {
    await createTestRole(ctx, { id: `role-${runId}`, name: `No templates ${runId}`, permissions: { EmailTemplate: { read: 'no' }, Contact: { read: 'all' } } });
    const user = await createTestUser(ctx, { userName: `etp-${runId}`, roleIds: [`role-${runId}`] });
    const denied = await preview({ subject: 'Hi {{firstName}}', sampleEntityType: 'Contact', sampleEntityId: sampleContactId }, user.token);
    expect(denied.status).toBe(403);
    expect(codeOf(denied)).toBe('AUTHORIZATION_DENIED');
  });

  it('substitutes the sample record into every part', async () => {
    const result = await preview({
      subject: 'Hello {{firstName}}',
      body: 'Write to {{emailAddress}}.',
      bodyHtml: '<p>Hello {{firstName}} {{lastName}}</p>',
      sampleEntityType: 'Contact',
      sampleEntityId: sampleContactId,
    });
    expect(result.status).toBe(200);
    expect(result.body['subject']).toBe(`Hello Nora ${runId}`);
    expect(result.body['body']).toBe(`Write to nora-${runId}@example.com.`);
    expect(result.body['bodyHtml']).toBe(`<p>Hello Nora ${runId} Nguyen</p>`);
    expect(result.body['unresolved']).toEqual([]);
    expect((result.body['placeholders'] as string[]).sort()).toEqual(['emailAddress', 'firstName', 'lastName']);
    expect(result.body['sample']).toMatchObject({ type: 'Contact', id: sampleContactId });
  });

  it('reports a token the sample has no value for instead of losing it silently', async () => {
    const result = await preview({ bodyHtml: '<p>{{firstName}} {{accountName}}</p>', sampleEntityType: 'Contact', sampleEntityId: sampleContactId });
    expect(result.status).toBe(200);
    expect(result.body['bodyHtml']).toBe('<p>' + `Nora ${runId}` + ' </p>');
    expect(result.body['unresolved']).toEqual(['accountName']);
  });

  it('keeps the tokens as written when no sample is chosen', async () => {
    const result = await preview({ subject: 'Hello {{firstName}}', bodyHtml: '<p>{{unknownToken}}</p>' });
    expect(result.status).toBe(200);
    expect(result.body['subject']).toBe('Hello {{firstName}}');
    expect(result.body['bodyHtml']).toBe('<p>{{unknownToken}}</p>');
    expect(result.body['unresolved']).toEqual([]);
    expect(result.body['sample']).toBeNull();
  });

  it('escapes a field value that carries markup, so a record cannot script the preview pane', async () => {
    const hostileId = await createContact({ firstName: `<img src=x onerror=alert(1)>`, lastName: `& "quoted"` });
    const result = await preview({ bodyHtml: '<p>{{firstName}}-{{lastName}}</p>', sampleEntityType: 'Contact', sampleEntityId: hostileId });
    expect(result.status).toBe(200);
    const html = String(result.body['bodyHtml']);
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&amp; &quot;quoted&quot;');
  });

  it('takes only an allowlisted sample entity, and both or neither of its pair', async () => {
    expect(codeOf(await preview({ subject: 'x', sampleEntityType: 'EmailTemplate', sampleEntityId: sampleContactId }))).toBe('VALIDATION_FAILED');
    expect(codeOf(await preview({ subject: 'x', sampleEntityId: sampleContactId }))).toBe('VALIDATION_FAILED');
  });

  it('refuses to personalise with a record the caller may not read', async () => {
    const ownId = await createContact({ firstName: `Hidden ${runId}` });
    await createTestRole(ctx, { id: `role-own-${runId}`, name: `Own contacts ${runId}`, permissions: { EmailTemplate: { read: 'yes' }, Contact: { read: 'own' } } });
    const user = await createTestUser(ctx, { userName: `etp-reader-${runId}`, roleIds: [`role-own-${runId}`] });
    const result = await preview({ subject: 'Hi {{firstName}}', sampleEntityType: 'Contact', sampleEntityId: ownId }, user.token);
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(result.status).toBeLessThan(500);
  });

  it('previews a stored template the same way as a draft', async () => {
    const created = await call('POST', '/api/v1/EmailTemplate', adminToken, {
      name: `AGENT_TEST ${runId}`,
      subject: 'Hello {{firstName}}',
      bodyHtml: '<p>{{firstName}}</p>',
    });
    const templateId = created.body['id'];
    expect(typeof templateId).toBe('string');
    if (typeof templateId === 'string') templateIds.push(templateId);
    const stored = await call('GET', `/api/v1/EmailTemplate/${templateId}`, adminToken);
    const result = await preview({
      subject: stored.body['subject'],
      bodyHtml: stored.body['bodyHtml'],
      sampleEntityType: 'Contact',
      sampleEntityId: sampleContactId,
    });
    expect(result.body['bodyHtml']).toBe(`<p>Nora ${runId}</p>`);
  });
});
