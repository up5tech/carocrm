import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type ApiContext, authHeader, bootApi, createTestRole, createTestUser, shutdownApi, type TestUser } from './support/boot-api.js';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

let ctx: ApiContext;
let runId: string;
let priorFeatures: Record<string, unknown> = {};
const created: { entity: string; id: string }[] = [];
const caseIds: string[] = [];
const userIds: string[] = [];
const roleIds: string[] = [];
const emailIds: string[] = [];

let agent!: TestUser;

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

async function createEmail(extra: Record<string, unknown>): Promise<string> {
  const res = await call('POST', '/api/v1/Email', { name: marker('subject'), status: 'Inbound', direction: 'Inbound', ...extra });
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  const id = String(res.body['id']);
  emailIds.push(id);
  return id;
}

beforeAll(async () => {
  process.env.MAIL_TRANSPORT = 'memory';
  ctx = await bootApi();
  runId = `sde${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

  const settings = await call('GET', '/api/v1/ServiceDesk/action/settings');
  priorFeatures = (settings.body['settings'] as Record<string, unknown>)['features'] as Record<string, unknown>;
  const enabled = await call('POST', '/api/v1/ServiceDesk/action/settings', {
    features: { caseManagement: true, emailToCase: true },
    email: { replyFromAddress: 'support@example.com' },
  });
  expect(enabled.status, JSON.stringify(enabled.body)).toBe(200);

  const roleId = `sdEmail${runId}`;
  roleIds.push(roleId);
  await createTestRole(ctx, {
    id: roleId,
    name: `SD email ${runId}`,
    permissions: { Case: { read: 'all', create: 'all', edit: 'all', delete: 'no', stream: 'yes' }, Email: { read: 'all', create: 'all', edit: 'all', delete: 'all', stream: 'no' } },
  });
  agent = await createTestUser(ctx, { userName: `sd_email_${runId}`, roleIds: [roleId] });
  userIds.push(agent.id);
});


afterAll(async () => {
  await call('POST', '/api/v1/ServiceDesk/action/settings', { features: priorFeatures, email: { replyFromAddress: '' } }).catch(() => undefined);

  // Module-written rows keyed by this run's case ids.
  if (caseIds.length > 0) {
    const streamRows = await ctx.database.db.selectFrom('stream_items').select('id').where('entity_type', '=', 'Case').where('entity_id', 'in', caseIds).execute().catch(() => []);
    const streamIds = streamRows.map((r) => r.id);
    if (streamIds.length > 0) {
      await ctx.database.db.deleteFrom('stream_mentions').where('stream_item_id', 'in', streamIds).execute().catch(() => undefined);
      await ctx.database.db.deleteFrom('stream_attachments').where('stream_item_id', 'in', streamIds).execute().catch(() => undefined);
      await ctx.database.db.deleteFrom('stream_items').where('id', 'in', streamIds).execute().catch(() => undefined);
    }
    await ctx.database.db.deleteFrom('entity_records').where('entity_type', 'in', ['CaseTransition', 'CaseAssignment']).where(sql`attrs ->> 'caseId'`, 'in', caseIds).execute().catch(() => undefined);
    await ctx.database.db.deleteFrom('notifications').where(sql`data ->> 'caseId'`, 'in', caseIds).execute().catch(() => undefined);
    await ctx.database.db.deleteFrom('outbox_events').where(sql`payload ->> 'caseId'`, 'in', caseIds).execute().catch(() => undefined);
  }

  for (const eid of emailIds) {
    await call('DELETE', `/api/v1/Email/${eid}`).catch(() => undefined);
  }
  for (const id of caseIds) {
    await call('DELETE', `/api/v1/Case/${id}`).catch(() => undefined);
  }
  for (const entry of [...created].reverse()) {
    await call('DELETE', `/api/v1/${entry.entity}/${entry.id}`).catch(() => undefined);
  }
  for (const uid of userIds) {
    await ctx.database.db.deleteFrom('users').where('id', '=', uid).execute().catch(() => undefined);
  }
  for (const rid of roleIds) {
    await ctx.database.db.deleteFrom('roles').where('id', '=', rid).execute().catch(() => undefined);
  }
  await shutdownApi();
});

describe('phase 19-SD.7 — email-to-case (§5.5)', () => {
  it('processes an inbound email into a new case and is idempotent', async () => {
    const emailId = await createEmail({
      fromAddress: 'customer@example.com',
      toAddressList: 'support@example.com',
      threadId: `thread-${runId}-1`,
      messageId: `<msg-${runId}-1@example.com>`,
      body: 'My widget is broken.',
    });

    const first = await call('POST', '/api/v1/ServiceDesk/action/emailToCase', { emailId }, agent.token);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body['created']).toBe(true);
    const caseId = String(first.body['caseId']);
    caseIds.push(caseId);

    const c = await call('GET', `/api/v1/Case/${caseId}`);
    expect(c.status).toBe(200);
    expect(c.body['source']).toBe('Email');
    expect(c.body['requesterEmail']).toBe('customer@example.com');

    // Idempotent re-process.
    const second = await call('POST', '/api/v1/ServiceDesk/action/emailToCase', { emailId }, agent.token);
    expect(second.status).toBe(200);
    expect(second.body['created']).toBe(false);
    expect(second.body['caseId']).toBe(caseId);
  });

  it('appends a reply to an existing thread instead of creating a new case', async () => {
    const thread = `thread-${runId}-2`;
    const firstEmail = await createEmail({
      fromAddress: 'customer@example.com',
      threadId: thread,
      messageId: `<msg-${runId}-2a@example.com>`,
      body: 'First message.',
    });
    const first = await call('POST', '/api/v1/ServiceDesk/action/emailToCase', { emailId: firstEmail }, agent.token);
    expect(first.status).toBe(200);
    const caseId = String(first.body['caseId']);
    caseIds.push(caseId);

    const secondEmail = await createEmail({
      fromAddress: 'customer@example.com',
      threadId: thread,
      messageId: `<msg-${runId}-2b@example.com>`,
      body: 'Follow-up message.',
    });
    const second = await call('POST', '/api/v1/ServiceDesk/action/emailToCase', { emailId: secondEmail }, agent.token);
    expect(second.status).toBe(200);
    expect(second.body['created']).toBe(false);
    expect(second.body['caseId']).toBe(caseId);

    const tl = await call('GET', `/api/v1/ServiceDesk/action/case/${caseId}/conversation`, undefined, agent.token);
    expect(tl.status).toBe(200);
    const posts = (tl.body['list'] as Record<string, unknown>[]).map((i) => String(i['post'] ?? ''));
    expect(posts.some((p) => p.includes('Follow-up message.'))).toBe(true);
  });

  it('skips auto-reply messages (mail loop prevention)', async () => {
    const emailId = await createEmail({
      fromAddress: 'mailer-daemon@example.com',
      name: 'Auto: out of office',
      threadId: `thread-${runId}-3`,
      messageId: `<msg-${runId}-3@example.com>`,
      body: 'I am away.',
    });
    const res = await call('POST', '/api/v1/ServiceDesk/action/emailToCase', { emailId }, agent.token);
    expect(res.status).toBe(200);
    expect(res.body['skipped']).toBe(true);
  });

  it('sends an outbound email reply to a case', async () => {
    const id = await (async () => {
      const c = await call('POST', '/api/v1/Case', { name: marker('subject'), requesterName: marker('Requester'), requesterEmail: 'customer@example.com' });
      expect(c.status).toBeLessThan(300);
      const cid = String(c.body['id']);
      caseIds.push(cid);
      return cid;
    })();

    const r = await call('POST', `/api/v1/ServiceDesk/action/case/${id}/emailReply`, { text: 'Here is the fix.' }, agent.token);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body['queued']).toBe(true);
    const emailId = String(r.body['emailId']);
    emailIds.push(emailId);

    const email = await call('GET', `/api/v1/Email/${emailId}`);
    expect(email.status).toBe(200);
    expect(email.body['toAddressList']).toBe('customer@example.com');
  });

  it('refuses processing when the feature is disabled', async () => {
    await call('POST', '/api/v1/ServiceDesk/action/settings', { features: { emailToCase: false } });
    const emailId = await createEmail({ fromAddress: 'x@example.com', threadId: `t-${runId}`, body: 'hi' });
    const res = await call('POST', '/api/v1/ServiceDesk/action/emailToCase', { emailId }, agent.token);
    expect(res.status).toBe(403);
    await call('POST', '/api/v1/ServiceDesk/action/settings', { features: { emailToCase: true } });
  });
});
