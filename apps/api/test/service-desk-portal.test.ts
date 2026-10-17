import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, loginAs, shutdownApi } from './support/boot-api.js';

let ctx: ApiContext;
let runId: string;
let portalToken = '';
let accountA = '';
let accountB = '';
let contactA = '';
let contactB = '';
let portalUserId = '';
let caseA1 = '';
let caseA2 = '';
let caseB = '';
let internalNoteId = '';
let publicReplyId = '';
let portalCreatedCaseId = '';
let priorFeatures: Record<string, unknown> = {};
const userIds: string[] = [];

const marker = (suffix: string) => `AGENT_TEST_${runId} ${suffix}`;

async function call(method: 'GET' | 'POST' | 'DELETE', url: string, payload?: Record<string, unknown>, token = ctx.adminToken) {
  const res = await ctx.app.inject({ method, url, headers: authHeader(token), ...(payload === undefined ? {} : { payload }) });
  let body: Record<string, unknown> = {};
  try { body = res.json() as Record<string, unknown>; } catch { body = {}; }
  return { status: res.statusCode, body };
}

async function create(entity: string, payload: Record<string, unknown>): Promise<string> {
  const res = await call('POST', `/api/v1/${entity}`, payload);
  expect(res.status, `${entity}: ${JSON.stringify(res.body)}`).toBeLessThan(300);
  return String(res.body['id']);
}

beforeAll(async () => {
  ctx = await bootApi();
  runId = `sdportal${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  const settings = await call('GET', '/api/v1/ServiceDesk/action/settings');
  priorFeatures = (settings.body['settings'] as Record<string, unknown>)['features'] as Record<string, unknown>;
  await call('POST', '/api/v1/ServiceDesk/action/settings', { features: { caseManagement: true, notifications: false, portal: true } });

  accountA = await create('Account', { name: marker('Account A') });
  accountB = await create('Account', { name: marker('Account B') });
  contactA = await create('Contact', { firstName: marker('Contact A'), lastName: `A_${runId}`, accountId: accountA, emailAddress: `a_${runId}@example.test` });
  contactB = await create('Contact', { firstName: marker('Contact B'), lastName: `B_${runId}`, accountId: accountB, emailAddress: `b_${runId}@example.test` });

  caseA1 = await create('Case', { name: marker('A1 visible by contact'), requesterName: marker('A'), contactId: contactA, accountId: accountA });
  caseA2 = await create('Case', { name: marker('A2 visible by account'), requesterName: marker('A'), accountId: accountA });
  caseB = await create('Case', { name: marker('B private'), requesterName: marker('B'), contactId: contactB, accountId: accountB });

  const note = await call('POST', `/api/v1/ServiceDesk/action/case/${caseA1}/note`, { text: marker('INTERNAL_SECRET') });
  expect(note.status, JSON.stringify(note.body)).toBe(200);
  internalNoteId = String(note.body['messageId']);
  const reply = await call('POST', `/api/v1/ServiceDesk/action/case/${caseA1}/reply`, { text: marker('PUBLIC_REPLY') });
  expect(reply.status, JSON.stringify(reply.body)).toBe(200);
  publicReplyId = String(reply.body['messageId']);

  const userName = `sd_portal_${runId}`;
  const user = await call('POST', '/api/v1/User', {
    userName,
    password: 'portal-pass-123',
    type: 'portal',
    portalId: 'portalCustomer',
    contactId: contactA,
    portalRoleIds: ['portalCustomerRole'],
  });
  expect(user.status, JSON.stringify(user.body)).toBeLessThan(300);
  portalUserId = String(user.body['id']);
  userIds.push(portalUserId);
  portalToken = await loginAs(ctx, userName, 'portal-pass-123');
});

afterAll(async () => {
  await call('POST', '/api/v1/ServiceDesk/action/settings', { features: priorFeatures }).catch(() => undefined);
  const exact: { entity: string; id: string }[] = [
    ...(portalCreatedCaseId !== '' ? [{ entity: 'Case', id: portalCreatedCaseId }] : []),
    { entity: 'Case', id: caseB },
    { entity: 'Case', id: caseA2 },
    { entity: 'Case', id: caseA1 },
    { entity: 'Contact', id: contactB },
    { entity: 'Contact', id: contactA },
    { entity: 'Account', id: accountB },
    { entity: 'Account', id: accountA },
  ];
  if (caseA1 !== '') {
    await ctx.database.db.deleteFrom('stream_items').where('entity_type', '=', 'Case').where('entity_id', 'in', [caseA1, caseA2, caseB, portalCreatedCaseId].filter(Boolean)).execute();
  }
  for (const entry of exact) {
    if (entry.id !== '') await call('DELETE', `/api/v1/${entry.entity}/${entry.id}`).catch(() => undefined);
  }
  for (const id of userIds) await ctx.database.db.deleteFrom('users').where('id', '=', id).execute();
  await shutdownApi();
});

describe('phase 19-SD.11 — portal case lifecycle and isolation', () => {
  it('lists only the customer’s cases and strips internal fields', async () => {
    const list = await call('GET', '/api/v1/Case?maxSize=200', undefined, portalToken);
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    const ids = (list.body['list'] as { id: string }[]).map((row) => row.id);
    expect(ids).toContain(caseA1);
    expect(ids).toContain(caseA2);
    expect(ids).not.toContain(caseB);

    const visible = (list.body['list'] as Record<string, unknown>[]).find((row) => row['id'] === caseA1);
    expect(visible).toBeDefined();
    for (const field of ['assignedUserId', 'slaState', 'isEscalated', 'queueId', 'teamId', 'routingRuleId', 'mergedIntoCaseId']) {
      expect(visible?.[field]).toBeUndefined();
    }
    expect(visible?.['caseNumber']).toBeTruthy();
  });

  it('cannot read another customer’s case (cross-account IDOR)', async () => {
    const read = await call('GET', `/api/v1/Case/${caseB}`, undefined, portalToken);
    expect([403, 404]).toContain(read.status);
  });

  it('sees only public conversation entries', async () => {
    const stream = await call('GET', `/api/v1/Case/${caseA1}/stream?order=asc&maxSize=100`, undefined, portalToken);
    expect(stream.status, JSON.stringify(stream.body)).toBe(200);
    const list = stream.body['list'] as { id: string; post: string | null; visibility: string }[];
    const ids = list.map((item) => item.id);
    expect(ids).toContain(publicReplyId);
    expect(ids).not.toContain(internalNoteId);
    expect(list.every((item) => item.visibility === 'public')).toBe(true);
    expect(JSON.stringify(stream.body)).not.toContain('INTERNAL_SECRET');
  });

  it('posts a public reply through the generic Note endpoint and cannot forge internal visibility', async () => {
    const posted = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/Note',
      headers: authHeader(portalToken),
      payload: { type: 'Post', parentType: 'Case', parentId: caseA1, post: marker('PORTAL_MESSAGE') },
    });
    expect(posted.statusCode, posted.body).toBeLessThan(300);
    const streamItem = await ctx.database.db
      .selectFrom('stream_items')
      .select('visibility')
      .where('id', '=', (posted.json() as { id: string }).id)
      .executeTakeFirstOrThrow();
    expect(streamItem.visibility).toBe('public');

    const forged = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/Note',
      headers: authHeader(portalToken),
      payload: { type: 'Note', parentType: 'Case', parentId: caseA1, notes: marker('FORGED'), visibility: 'internal' },
    });
    expect(forged.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('creates a case with source Portal and server-derived requester fields', async () => {
    const created = await call('POST', '/api/v1/Case', {
      name: marker('Portal created'),
      description: 'Raised from the portal',
    }, portalToken);
    expect(created.status, JSON.stringify(created.body)).toBeLessThan(300);
    const id = String(created.body['id']);
    portalCreatedCaseId = id;
    // Cleanup is bounded to this record.
    const row = await ctx.database.db.selectFrom('entity_records').select('attrs').where('id', '=', id).executeTakeFirstOrThrow();
    const attrs = row.attrs as Record<string, unknown>;
    expect(attrs['source']).toBe('Portal');
    expect(attrs['status']).toBe('New');
    expect(attrs['contactId']).toBe(contactA);
    expect(attrs['assignedUserId'] ?? null).toBeNull();
    expect(attrs['isEscalated'] ?? false).toBe(false);
    await call('DELETE', `/api/v1/Case/${id}`);
  });

  it('refuses privileged fields a portal client tries to set', async () => {
    for (const payload of [
      { name: marker('Privileged status'), description: 'x', status: 'Closed' },
      { name: marker('Privileged owner'), description: 'x', assignedUserId: portalUserId },
      { name: marker('Privileged source'), description: 'x', source: 'Email' },
      { name: marker('Privileged number'), description: 'x', caseNumber: 'FORGED-PORTAL' },
    ]) {
      const res = await call('POST', '/api/v1/Case', payload, portalToken);
      expect(res.status, JSON.stringify(res.body)).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    }
  });

  it('denies all portal case access while the portal feature is off', async () => {
    await call('POST', '/api/v1/ServiceDesk/action/settings', { features: { portal: false } });
    const list = await call('GET', '/api/v1/Case?maxSize=10', undefined, portalToken);
    expect(list.status).toBe(403);
    await call('POST', '/api/v1/ServiceDesk/action/settings', { features: { portal: true } });
  });
});
