import type { MailTransport } from '@carocrm/mail';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMailTransportFromConfig,MAIL_TRANSPORT_TOKEN } from '../src/email/index.js';
import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, createTestRole, createTestUser, purgeEntityEvents, shutdownApi } from './support/boot-api.js';

// The API must never reach a real mail server from a test (AGENTS.md §5.5); `memory` keeps messages
// in the process instead. It has to be set before `bootApi()` builds the config.
process.env.MAIL_TRANSPORT = 'memory';

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

interface CallResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

const runId = `em${Date.now().toString(36)}`;
const fromAddress = `sales-${runId}@crm.example`;

let ctx: ApiContext;
let adminToken = '';
let queue: Queue | undefined;
const emailIds: string[] = [];
const jobIds: string[] = [];

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

function codeOf(result: CallResult): string {
  return String(((result.body['error'] ?? {}) as { code?: string }).code ?? '');
}

function messageOf(result: CallResult): string {
  return String(((result.body['error'] ?? {}) as { message?: string }).message ?? '');
}

/** Draft an Email record through the generic entity API — the kernel owns Email CRUD. */
async function draft(data: Record<string, unknown>, token?: string): Promise<CallResult> {
  const res = await call('POST', '/api/v1/Email', token ?? adminToken, { name: `AGENT_TEST ${runId}`, ...data });
  const id = res.body['id'];
  if (typeof id === 'string') emailIds.push(id);
  return res;
}

const baseDraft = {
  fromAddress: `Sales <${fromAddress}>`,
  toAddressList: `alice-${runId}@example.com, bob-${runId}@example.com`,
  ccAddressList: `carol-${runId}@example.com`,
  body: 'The numbers are in.',
  bodyHtml: `<p>The numbers are in.</p><p>${runId}</p>`,
};

beforeAll(async () => {
  ctx = await bootApi();
  adminToken = ctx.adminToken;
  queue = new Queue(ctx.config.jobQueueName, { connection: new Redis(ctx.config.redisUrl, { maxRetriesPerRequest: null }) });
});

afterAll(async () => {
  // Only rows this run created, by their own ids (AGENTS.md §3.3).
  if (queue) {
    for (const id of jobIds) {
      const entry = await queue.getJob(id).catch(() => undefined);
      await entry?.remove().catch(() => undefined);
    }
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close().catch(() => undefined);
  }
  if (jobIds.length > 0) {
    await ctx.database.db.deleteFrom('jobs').where('id', 'in', jobIds).execute();
  }
  if (emailIds.length > 0) {
    await ctx.database.db.deleteFrom('email_deliveries').where('email_id', 'in', emailIds).execute();
    await ctx.database.db.deleteFrom('entity_records').where('id', 'in', emailIds).execute();
  }
  await purgeEntityEvents(ctx.database, ['Email']);
  await shutdownApi();
});

describe('transport settings (PLAN §28.1)', () => {
  it('publishes what the transport will do, without secrets', async () => {
    const res = await call('GET', '/api/v1/Email/action/transport', adminToken);
    expect(res.status).toBe(200);
    expect(res.body['name']).toBe('memory');
    expect(res.body['mode']).toBe('disabled');
    expect(res.body['holdsMessages']).toBe(true);
    expect(res.body['maxRecipients']).toBeGreaterThan(0);
    // No credential material ever reaches the response.
    expect(JSON.stringify(res.body)).not.toMatch(/password|secret/i);
  });

  it('requires authentication', async () => {
    const res = await call('GET', '/api/v1/Email/action/transport');
    expect(codeOf(res)).toBe('AUTHENTICATION_REQUIRED');
  });

  it('lets an admin verify the connection and refuses a regular user', async () => {
    const admin = await call('POST', '/api/v1/Email/action/verify', adminToken);
    expect(admin.status).toBe(200);
    expect(admin.body['verified']).toBe(true);

    await createTestRole(ctx, { id: `role-${runId}`, name: `Email reader ${runId}`, permissions: { Email: { read: 'yes', create: 'yes', edit: 'own' } } });
    const user = await createTestUser(ctx, { userName: `email-${runId}`, roleIds: [`role-${runId}`] });
    const denied = await call('POST', '/api/v1/Email/action/verify', user.token);
    expect(denied.status).toBe(403);
  });

  it('selects the disabled transport when MAIL_TRANSPORT is unset', () => {
    // This is the configuration `scripts/e2e-smoke.sh` runs, where a send must be refused outright.
    const transport = createMailTransportFromConfig({ ...ctx.config, mailTransport: 'none' }, {});
    expect(transport.info.name).toBe('none');
    expect(transport.info.mode).toBe('disabled');
  });
});

describe('queueing an outbound email (PLAN §28.1, §28.3)', () => {
  it('stores the draft as an ordinary entity record', async () => {
    const res = await draft(baseDraft);
    expect(res.status).toBe(201);
    expect(res.body['status']).toBe('Draft');
    expect(res.body['name']).toBe(`AGENT_TEST ${runId}`);
  });

  it('validates the draft, writes one ledger row per recipient and queues the send job', async () => {
    const created = await draft(baseDraft);
    const id = String(created.body['id']);

    const res = await call('POST', `/api/v1/Email/${id}/action/send`, adminToken);
    expect(res.status).toBe(200);
    expect((res.body['email'] as Record<string, unknown>)['status']).toBe('Queued');
    const job = res.body['job'] as { id: string; name: string; status: string };
    expect(job.name).toBe('system.sendEmail');
    expect(job.status).toBe('pending');
    jobIds.push(job.id);

    const deliveries = res.body['deliveries'] as { recipient: string; recipientType: string; status: string }[];
    expect(deliveries).toHaveLength(3);
    expect(deliveries.map((entry) => entry.recipientType)).toEqual(['cc', 'to', 'to']);
    expect(deliveries.every((entry) => entry.status === 'pending')).toBe(true);
    expect(deliveries.every((entry) => entry.recipient.includes(runId))).toBe(true);

    const viaEndpoint = await call('GET', `/api/v1/Email/${id}/deliveries`, adminToken);
    expect(viaEndpoint.status).toBe(200);
    expect((viaEndpoint.body as unknown[]).length).toBe(3);
  });

  it('refuses to queue the same email twice', async () => {
    const created = await draft(baseDraft);
    const id = String(created.body['id']);
    const first = await call('POST', `/api/v1/Email/${id}/action/send`, adminToken);
    expect(first.status).toBe(200);
    const job = first.body['job'] as { id: string };
    jobIds.push(job.id);

    const second = await call('POST', `/api/v1/Email/${id}/action/send`, adminToken);
    expect(second.status).toBe(422);
    expect(messageOf(second)).toMatch(/Queued/);
  });

  it('rejects a draft with no recipient, a bad address, a bad header and an unknown id', async () => {
    const noRecipient = await draft({ body: 'hello', fromAddress: `Sales <${fromAddress}>` });
    expect((await call('POST', `/api/v1/Email/${String(noRecipient.body['id'])}/action/send`, adminToken)).status).toBe(422);

    const noSender = await draft({ body: 'hello', toAddressList: `a-${runId}@example.com` });
    const noSenderSend = await call('POST', `/api/v1/Email/${String(noSender.body['id'])}/action/send`, adminToken);
    expect(noSenderSend.status).toBe(422);
    expect(messageOf(noSenderSend)).toMatch(/fromAddress/);

    const badAddress = await draft({ body: 'hello', fromAddress: `Sales <${fromAddress}>`, toAddressList: 'not-an-address' });
    const rejected = await call('POST', `/api/v1/Email/${String(badAddress.body['id'])}/action/send`, adminToken);
    expect(rejected.status).toBe(422);
    expect(messageOf(rejected)).toMatch(/Invalid email address/);

    const forgedHeader = await draft({
      body: 'hello',
      fromAddress: `Sales <${fromAddress}>`,
      toAddressList: `a-${runId}@example.com`,
      headers: '{"From":"someone@example.com"}',
    });
    const forged = await call('POST', `/api/v1/Email/${String(forgedHeader.body['id'])}/action/send`, adminToken);
    expect(forged.status).toBe(422);
    expect(messageOf(forged)).toMatch(/set by the mail message/);

    const brokenHeaders = await draft({
      body: 'hello',
      fromAddress: `Sales <${fromAddress}>`,
      toAddressList: `a-${runId}@example.com`,
      headers: '{"unclosed":',
    });
    expect((await call('POST', `/api/v1/Email/${String(brokenHeaders.body['id'])}/action/send`, adminToken)).status).toBe(422);

    const emptyBody = await draft({ fromAddress: `Sales <${fromAddress}>`, toAddressList: `a-${runId}@example.com` });
    expect((await call('POST', `/api/v1/Email/${String(emptyBody.body['id'])}/action/send`, adminToken)).status).toBe(422);

    expect((await call('POST', `/api/v1/Email/no-such-${runId}/action/send`, adminToken)).status).toBe(404);
    expect((await call('GET', `/api/v1/Email/no-such-${runId}/deliveries`, adminToken)).status).toBe(404);
  });

  it('leaves no trace when validation fails: the record stays a Draft with an empty ledger', async () => {
    const created = await draft({ body: 'x', fromAddress: `Sales <${fromAddress}>`, toAddressList: 'broken-address' });
    const id = String(created.body['id']);
    await call('POST', `/api/v1/Email/${id}/action/send`, adminToken);

    const record = await call('GET', `/api/v1/Email/${id}`, adminToken);
    expect(record.body['status']).toBe('Draft');
    expect(((await call('GET', `/api/v1/Email/${id}/deliveries`, adminToken)).body as unknown[]).length).toBe(0);
  });

  it('enforces the transport recipient ceiling', async () => {
    const info = (await call('GET', '/api/v1/Email/action/transport', adminToken)).body as { maxRecipients: number };
    const many = Array.from({ length: info.maxRecipients + 1 }, (_unused, index) => `r${String(index)}-${runId}@example.com`);
    const created = await draft({ body: 'blast', fromAddress: `Sales <${fromAddress}>`, toAddressList: many.join(', ') });
    const res = await call('POST', `/api/v1/Email/${String(created.body['id'])}/action/send`, adminToken);
    expect(res.status).toBe(422);
    expect(messageOf(res)).toMatch(/at most/);
  });

  it('lets a non-owner read an email it may see, and not queue somebody else\'s', async () => {
    const created = await draft(baseDraft);
    const id = String(created.body['id']);
    const ownerJob = await call('POST', `/api/v1/Email/${id}/action/send`, adminToken);
    jobIds.push((ownerJob.body['job'] as { id: string }).id);

    await createTestRole(ctx, { id: `role-read-${runId}`, name: `Email all-read ${runId}`, permissions: { Email: { read: 'all', edit: 'own' } } });
    const other = await createTestUser(ctx, { userName: `reader-${runId}`, roleIds: [`role-read-${runId}`] });

    const readable = await call('GET', `/api/v1/Email/${id}`, other.token);
    expect(readable.status).toBe(200);
    expect((await call('GET', `/api/v1/Email/${id}/deliveries`, other.token)).status).toBe(200);

    const denied = await call('POST', `/api/v1/Email/${id}/action/send`, other.token);
    expect(denied.status).toBe(403);
    expect(codeOf(denied)).toBe('AUTHORIZATION_DENIED');
    // The denial happened before any write, so the record is still queued once from the owner.
    expect(((await call('GET', `/api/v1/Email/${id}`, adminToken)).body as Record<string, unknown>)['status']).toBe('Queued');
  });
});

describe('transport wiring', () => {
  it('binds MAIL_TRANSPORT_TOKEN to the configured transport', () => {
    const transport = ctx.app.get<MailTransport>(MAIL_TRANSPORT_TOKEN);
    expect(transport.name).toBe('memory');
    expect(transport.mode).toBe('disabled');
    // The API process never calls send(); queueing only writes the ledger and hands work to the worker.
    expect(transport.messages).toHaveLength(0);
  });
});
