import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { canViewStreamVisibility, toStreamVisibility } from '../src/stream/stream-visibility.js';
import {
  type ApiContext,
  authHeader,
  bootApi,
  createTestRole,
  createTestUser,
  loginAs,
  shutdownApi,
  type TestUser,
} from './support/boot-api.js';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

let ctx: ApiContext;
let runId: string;
let priorFeatures: Record<string, unknown> = {};
const created: { entity: string; id: string }[] = [];
const caseIds: string[] = [];
const userIds: string[] = [];
const roleIds: string[] = [];
const attachmentIds: string[] = [];

let responder!: TestUser;
let assignee!: TestUser;
let readOnly!: TestUser;

let portalToken = '';
let portalId = '';
let portalRoleId = '';
let portalUserId = '';
let portalAccountId = '';
let portalContactId = '';

const marker = (suffix: string) => `AGENT_TEST_${runId} ${suffix}`;

async function call(method: Method, url: string, payload?: Record<string, unknown>, token = ctx.adminToken) {
  const res = await ctx.app.inject({
    method,
    url,
    headers: authHeader(token),
    ...(payload === undefined ? {} : { payload }),
  });
  let body: Record<string, unknown> = {};
  try {
    body = res.json() as Record<string, unknown>;
  } catch {
    body = {};
  }
  return { status: res.statusCode, body };
}

async function createCase(extra: Record<string, unknown> = {}): Promise<string> {
  const res = await call('POST', '/api/v1/Case', { name: marker('subject'), requesterName: marker('Requester'), ...extra });
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  const id = String(res.body['id']);
  caseIds.push(id);
  return id;
}

async function readCase(id: string, token = ctx.adminToken): Promise<Record<string, unknown>> {
  const res = await call('GET', `/api/v1/Case/${id}`, undefined, token);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

const reply = (id: string, body: Record<string, unknown>, token = ctx.adminToken) =>
  call('POST', `/api/v1/ServiceDesk/action/case/${id}/reply`, body, token);
const note = (id: string, body: Record<string, unknown>, token = ctx.adminToken) =>
  call('POST', `/api/v1/ServiceDesk/action/case/${id}/note`, body, token);
const timeline = (id: string, token = ctx.adminToken) =>
  call('GET', `/api/v1/ServiceDesk/action/case/${id}/conversation`, undefined, token);

function buildMultipart(
  parts: readonly { name: string; data: string | Buffer; filename?: string; contentType?: string }[],
  boundary = 'carocrmtestboundary',
): { payload: Buffer; headers: Record<string, string> } {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"`;
    if (part.filename !== undefined) head += `; filename="${part.filename}"`;
    head += '\r\n';
    if (part.contentType !== undefined) head += `Content-Type: ${part.contentType}\r\n\r\n`;
    else head += '\r\n';
    chunks.push(Buffer.from(head, 'utf8'), Buffer.isBuffer(part.data) ? part.data : Buffer.from(part.data, 'utf8'), Buffer.from('\r\n', 'utf8'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return { payload: Buffer.concat(chunks), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

async function uploadAttachment(token: string, filename: string, data: string, fields: Record<string, string>) {
  const textParts = Object.entries(fields).map(([name, value]) => ({ name, data: value }));
  const multipart = buildMultipart([...textParts, { name: 'file', filename, contentType: 'text/plain', data }]);
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/Attachment/upload',
    headers: { ...authHeader(token), ...multipart.headers },
    payload: multipart.payload,
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
  runId = `sdc${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

  const settings = await call('GET', '/api/v1/ServiceDesk/action/settings');
  priorFeatures = (settings.body['settings'] as Record<string, unknown>)['features'] as Record<string, unknown>;
  const enabled = await call('POST', '/api/v1/ServiceDesk/action/settings', {
    features: { caseManagement: true, notifications: true },
  });
  expect(enabled.status, JSON.stringify(enabled.body)).toBe(200);

  const responderRole = `sdConvResp${runId}`;
  const readRole = `sdConvRead${runId}`;
  roleIds.push(responderRole, readRole);
  await createTestRole(ctx, {
    id: responderRole,
    name: `SD conversation responder ${runId}`,
    permissions: { Case: { read: 'all', create: 'no', edit: 'all', delete: 'no', stream: 'yes' } },
  });
  await createTestRole(ctx, {
    id: readRole,
    name: `SD conversation reader ${runId}`,
    permissions: { Case: { read: 'all', create: 'no', edit: 'no', delete: 'no', stream: 'no' } },
  });

  responder = await createTestUser(ctx, { userName: `sd_conv_resp_${runId}`, roleIds: [responderRole] });
  assignee = await createTestUser(ctx, { userName: `sd_conv_asg_${runId}`, roleIds: [responderRole] });
  readOnly = await createTestUser(ctx, { userName: `sd_conv_ro_${runId}`, roleIds: [readRole] });
  userIds.push(responder.id, assignee.id, readOnly.id);

  // Portal user linked to an account, with Case read + stream on a portal role.
  const portal = await call('POST', '/api/v1/Portal', { name: marker('Portal') });
  expect(portal.status).toBe(201);
  portalId = String(portal.body['id']);
  const portalRole = await call('POST', '/api/v1/PortalRole', {
    name: marker('PortalRole'),
    permissions: { Case: { read: 'all', create: 'no', edit: 'no', delete: 'no', stream: 'yes' } },
  });
  expect(portalRole.status).toBe(201);
  portalRoleId = String(portalRole.body['id']);
  const link = await call('POST', `/api/v1/Portal/${portalId}/roles`, { portalRoleIds: [portalRoleId] });
  expect(link.status).toBe(201);
  const account = await call('POST', '/api/v1/Account', { name: marker('PortalAcc') });
  expect(account.status).toBe(201);
  portalAccountId = String(account.body['id']);
  created.push({ entity: 'Account', id: portalAccountId });
  const contact = await call('POST', '/api/v1/Contact', { firstName: 'Portal', lastName: `User ${runId}`, accountId: portalAccountId, status: 'Active' });
  expect(contact.status).toBe(201);
  portalContactId = String(contact.body['id']);
  created.push({ entity: 'Contact', id: portalContactId });
  const user = await call('POST', '/api/v1/User', {
    userName: `portal_${runId}`,
    password: 'portalpass123',
    type: 'portal',
    portalId,
    contactId: portalContactId,
    portalRoleIds: [portalRoleId],
  });
  expect(user.status).toBe(201);
  portalUserId = String(user.body['id']);
  userIds.push(portalUserId);
  portalToken = await loginAs(ctx, `portal_${runId}`, 'portalpass123');
});

afterAll(async () => {
  // Restore settings.
  await call('POST', '/api/v1/ServiceDesk/action/settings', { features: priorFeatures }).catch(() => undefined);

  // Module-written rows keyed by this run's case ids.
  if (caseIds.length > 0) {
    const streamRows = await ctx.database.db
      .selectFrom('stream_items')
      .select('id')
      .where('entity_type', '=', 'Case')
      .where('entity_id', 'in', caseIds)
      .execute()
      .catch(() => []);
    const streamIds = streamRows.map((r) => r.id);
    if (streamIds.length > 0) {
      await ctx.database.db.deleteFrom('stream_mentions').where('stream_item_id', 'in', streamIds).execute().catch(() => undefined);
      await ctx.database.db.deleteFrom('stream_attachments').where('stream_item_id', 'in', streamIds).execute().catch(() => undefined);
      await ctx.database.db.deleteFrom('stream_items').where('id', 'in', streamIds).execute().catch(() => undefined);
    }
    await ctx.database.db.deleteFrom('stream_followers').where('entity_type', '=', 'Case').where('entity_id', 'in', caseIds).execute().catch(() => undefined);
    await ctx.database.db.deleteFrom('entity_records').where('entity_type', 'in', ['CaseTransition', 'CaseAssignment']).where(sql`attrs ->> 'caseId'`, 'in', caseIds).execute().catch(() => undefined);
    await ctx.database.db.deleteFrom('notifications').where(sql`data ->> 'caseId'`, 'in', caseIds).execute().catch(() => undefined);
    await ctx.database.db.deleteFrom('outbox_events').where(sql`payload ->> 'caseId'`, 'in', caseIds).execute().catch(() => undefined);
  }

  // Attachments.
  for (const aid of attachmentIds) {
    await call('DELETE', `/api/v1/Attachment/${aid}`).catch(() => undefined);
  }

  // Generic records.
  for (const entry of [...created].reverse()) {
    await call('DELETE', `/api/v1/${entry.entity}/${entry.id}`).catch(() => undefined);
  }
  // Cases last, after module rows.
  for (const id of caseIds) {
    await call('DELETE', `/api/v1/Case/${id}`).catch(() => undefined);
  }

  // Internal users.
  for (const uid of userIds) {
    await ctx.database.db.deleteFrom('users').where('id', '=', uid).execute().catch(() => undefined);
  }
  // Portal + role.
  if (portalUserId) await ctx.database.db.deleteFrom('users').where('id', '=', portalUserId).execute().catch(() => undefined);
  if (portalId) await ctx.database.db.deleteFrom('portals').where('id', '=', portalId).execute().catch(() => undefined);
  if (portalRoleId) await ctx.database.db.deleteFrom('portal_roles').where('id', '=', portalRoleId).execute().catch(() => undefined);
  for (const rid of roleIds) {
    await ctx.database.db.deleteFrom('roles').where('id', '=', rid).execute().catch(() => undefined);
  }
  await shutdownApi();
});

describe('phase 19-SD.6 — conversation visibility (§5.4)', () => {
  it('unit: canViewStreamVisibility keeps internal content away from portal principals', () => {
    expect(canViewStreamVisibility('public', { userType: 'portal' })).toBe(true);
    expect(canViewStreamVisibility('internal', { userType: 'portal' })).toBe(false);
    expect(canViewStreamVisibility('system', { userType: 'portal' })).toBe(false);
    expect(canViewStreamVisibility('internal', { userType: 'regular' })).toBe(true);
    expect(canViewStreamVisibility('system', { userType: 'admin' })).toBe(true);
    expect(toStreamVisibility('bogus', 'internal')).toBe('internal');
    expect(toStreamVisibility('bogus', 'public')).toBe('public');
  });

  it('a public reply stamps the response clocks; an internal note does not', async () => {
    const id = await createCase();
    const before = await readCase(id);
    expect(before['firstResponseAt']).toBeUndefined();
    expect(before['lastAgentResponseAt']).toBeUndefined();

    const r = await reply(id, { text: 'hello customer' }, responder.token);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body['visibility']).toBe('public');
    expect(r.body['created']).toBe(true);

    const afterReply = await readCase(id);
    expect(afterReply['firstResponseAt']).toBeTruthy();
    expect(afterReply['lastAgentResponseAt']).toBeTruthy();
    expect(afterReply['lastActivityAt']).toBeTruthy();

    const n = await note(id, { text: 'internal only' }, responder.token);
    expect(n.status, JSON.stringify(n.body)).toBe(200);
    expect(n.body['visibility']).toBe('internal');

    const afterNote = await readCase(id);
    // The note must not move the public-response clock.
    expect(afterNote['lastAgentResponseAt']).toBe(afterReply['lastAgentResponseAt']);
    expect(afterNote['firstResponseAt']).toBe(afterReply['firstResponseAt']);
    // But activity still moves (the note is still case activity).
    expect(afterNote['lastActivityAt']).toBeTruthy();
  });

  it('the timeline badges visibility and the portal only sees public entries', async () => {
    const id = await createCase({ accountId: portalAccountId });
    await reply(id, { text: 'public reply' }, responder.token);
    await note(id, { text: 'secret note' }, responder.token);

    const agent = await timeline(id, responder.token);
    expect(agent.status, JSON.stringify(agent.body)).toBe(200);
    const agentVis = (agent.body['list'] as Record<string, unknown>[]).map((i) => i['visibility']);
    expect(agentVis).toContain('public');
    expect(agentVis).toContain('internal');

    const portal = await timeline(id, portalToken);
    expect(portal.status, JSON.stringify(portal.body)).toBe(200);
    const portalVis = (portal.body['list'] as Record<string, unknown>[]).map((i) => i['visibility']);
    expect(portalVis).toEqual(['public']);
    expect(portalVis).not.toContain('internal');
    // The public item body is present; the internal note text is absent.
    const portalTexts = (portal.body['list'] as Record<string, unknown>[]).map((i) => {
      const post = i['post'];
      const notes = (i['data'] as Record<string, unknown>)?.['notes'];
      return String(post ?? notes ?? '');
    });
    expect(portalTexts.join(' ')).toContain('public reply');
    expect(portalTexts.join(' ')).not.toContain('secret note');
  });

  it('a portal principal cannot post an internal note and cannot forge internal visibility', async () => {
    const id = await createCase({ accountId: portalAccountId });

    const internal = await note(id, { text: 'try internal' }, portalToken);
    expect(internal.status).toBe(403);

    const forged = await call('POST', '/api/v1/Note', { type: 'Post', parentType: 'Case', parentId: id, post: 'forged', visibility: 'internal' }, portalToken);
    expect(forged.status).toBe(403);

    // A portal post is forced to customer-visible.
    const posted = await call('POST', '/api/v1/Note', { type: 'Post', parentType: 'Case', parentId: id, post: 'portal msg' }, portalToken);
    expect(posted.status).toBeLessThan(300);
    expect(posted.body['visibility']).toBe('public');
  });

  it('an internal note attachment is invisible to the portal', async () => {
    const id = await createCase({ accountId: portalAccountId });

    const up = await uploadAttachment(responder.token, 'secret.txt', 'secret body', { parentType: 'Case', parentId: id });
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    const attId = String(up.body['id']);
    attachmentIds.push(attId);

    const n = await note(id, { text: 'note with file', attachmentIds: [attId] }, responder.token);
    expect(n.status, JSON.stringify(n.body)).toBe(200);

    // Agent can download.
    const agentDownload = await call('GET', `/api/v1/Attachment/${attId}/file`, undefined, responder.token);
    expect(agentDownload.status).toBe(200);

    // Portal is refused (the attachment inherited internal visibility).
    const portalDownload = await call('GET', `/api/v1/Attachment/${attId}/file`, undefined, portalToken);
    expect(portalDownload.status).toBe(403);
  });

  it('a read-only agent can read but not post', async () => {
    const id = await createCase();
    const caps = await call('GET', `/api/v1/ServiceDesk/action/case/${id}/capabilities`, undefined, readOnly.token);
    expect(caps.status).toBe(200);
    expect(caps.body['conversation']['canReply']).toBe(false);
    expect(caps.body['conversation']['canViewInternal']).toBe(true);

    const r = await reply(id, { text: 'nope' }, readOnly.token);
    expect(r.status).toBe(403);
  });

  it('a public reply notifies the assignee once and is idempotent', async () => {
    const id = await createCase();
    await call('POST', `/api/v1/ServiceDesk/action/case/${id}/assign`, { assignedUserId: assignee.id }, responder.token);

    const key = `idem-${runId}`;
    const first = await reply(id, { text: 'first reply', idempotencyKey: key }, responder.token);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body['created']).toBe(true);
    const messageId = String(first.body['messageId']);

    const rowsBefore = await ctx.database.db
      .selectFrom('notifications')
      .select('id')
      .where('user_id', '=', assignee.id)
      .where(sql`data ->> 'dedupKey'`, '=', messageId)
      .execute();
    expect(rowsBefore.length).toBe(1);

    // An internal note produces no notification.
    const noteCountBefore = await ctx.database.db
      .selectFrom('notifications')
      .select('id')
      .where('user_id', '=', assignee.id)
      .execute();
    const n = await note(id, { text: 'internal note' }, responder.token);
    expect(n.status).toBe(200);
    const noteCountAfter = await ctx.database.db
      .selectFrom('notifications')
      .select('id')
      .where('user_id', '=', assignee.id)
      .execute();
    expect(noteCountAfter.length).toBe(noteCountBefore.length);

    // Retry with the same key returns the existing entry and does not notify again.
    const retry = await reply(id, { text: 'duplicate', idempotencyKey: key }, responder.token);
    expect(retry.status).toBe(200);
    expect(retry.body['created']).toBe(false);
    expect(retry.body['messageId']).toBe(messageId);

    const rowsAfter = await ctx.database.db
      .selectFrom('notifications')
      .select('id')
      .where('user_id', '=', assignee.id)
      .where(sql`data ->> 'dedupKey'`, '=', messageId)
      .execute();
    expect(rowsAfter.length).toBe(1);
  });

  it('rejects an empty conversation entry', async () => {
    const id = await createCase();
    const r = await reply(id, {}, responder.token);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
  });

  it('a portal read of the timeline excludes internal notes and system updates', async () => {
    const id = await createCase({ accountId: portalAccountId });
    // Trigger a system update item via a status transition.
    await call('POST', `/api/v1/ServiceDesk/action/case/${id}/transition`, { command: 'start' }, responder.token);
    await reply(id, { text: 'pub' }, responder.token);
    await note(id, { text: 'priv' }, responder.token);

    const portal = await timeline(id, portalToken);
    expect(portal.status, JSON.stringify(portal.body)).toBe(200);
    const vis = (portal.body['list'] as Record<string, unknown>[]).map((i) => i['visibility']);
    for (const v of vis) expect(v).toBe('public');
    const texts = (portal.body['list'] as Record<string, unknown>[]).map((i) => JSON.stringify(i));
    expect(texts.join(' ')).not.toContain('priv');
  });
});
