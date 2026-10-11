import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, createTestRole, createTestUser, purgeEntityEvents, shutdownApi } from './support/boot-api.js';

// The API must never reach a real mail server from a test (AGENTS.md §5.5).
process.env.MAIL_TRANSPORT = 'memory';
// Accounts store credentials encrypted at rest (PLAN §28.3); the key must exist before bootApi()
// builds the config. Any 32-byte hex value works; this one is obviously a test key.
process.env.ENCRYPTION_KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

interface CallResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

const runId = `ea${Date.now().toString(36)}`;

let ctx: ApiContext;
let adminToken = '';
const emailIds: string[] = [];
const templateIds: string[] = [];
const accountIds: string[] = [];
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

beforeAll(async () => {
  ctx = await bootApi();
  adminToken = ctx.adminToken;
});

afterAll(async () => {
  // Only rows this run created, by their own ids (AGENTS.md §3.3).
  if (jobIds.length > 0) {
    await ctx.database.db.deleteFrom('jobs').where('id', 'in', jobIds).execute();
  }
  if (emailIds.length > 0) {
    await ctx.database.db.deleteFrom('email_deliveries').where('email_id', 'in', emailIds).execute();
    await ctx.database.db.deleteFrom('entity_records').where('id', 'in', emailIds).execute();
  }
  if (templateIds.length > 0) {
    await ctx.database.db.deleteFrom('entity_records').where('id', 'in', templateIds).execute();
  }
  if (accountIds.length > 0) {
    await purgeEntityEvents(ctx.database, ['Email', 'EmailTemplate']);
    await ctx.database.db.deleteFrom('email_accounts').where('id', 'in', accountIds).execute();
  }
  await shutdownApi();
});

describe('email accounts (Phase 11)', () => {
  it('stores the password encrypted at rest and never returns it', async () => {
    const created = await call('POST', '/api/v1/EmailAccount', adminToken, {
      name: `AGENT_TEST Sales ${runId}`,
      emailAddress: `sales-${runId}@crm.example`,
      fromName: 'Sales',
      smtpHost: 'smtp.crm.example',
      smtpPort: 587,
      smtpSecurity: 'starttls',
      smtpUsername: `sales-${runId}`,
      smtpPassword: `super-secret-${runId}`,
      signature: `Best regards,\nSales team (${runId})`,
    });
    expect(created.status).toBe(201);
    const id = String(created.body['id']);
    accountIds.push(id);

    // Read shape: a boolean, never the secret.
    expect(created.body['smtpPassword']).toBeUndefined();
    expect(created.body['hasPassword']).toBe(true);
    expect(JSON.stringify(created.body)).not.toContain(`super-secret-${runId}`);

    // The row itself holds an AES-GCM payload, not the plaintext.
    const row = await ctx.database.db
      .selectFrom('email_accounts')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row.smtp_password_encrypted).toMatch(/^v1:/);
    expect(row.smtp_password_encrypted).not.toContain(`super-secret-${runId}`);

    const listed = await call('GET', '/api/v1/EmailAccount', adminToken);
    expect(listed.status).toBe(200);
    const found = (listed.body as unknown as Record<string, unknown>[]).find((entry) => entry['id'] === id);
    expect(found?.['hasPassword']).toBe(true);
    expect(JSON.stringify(listed.body)).not.toContain(`super-secret-${runId}`);
  });

  it('keeps the stored password when an update omits it, and replaces it when one is sent', async () => {
    const created = await call('POST', '/api/v1/EmailAccount', adminToken, {
      name: `AGENT_TEST Support ${runId}`,
      emailAddress: `support-${runId}@crm.example`,
      smtpHost: 'smtp.crm.example',
      smtpPassword: `first-password-${runId}`,
    });
    const id = String(created.body['id']);
    accountIds.push(id);

    const before = await ctx.database.db
      .selectFrom('email_accounts')
      .select('smtp_password_encrypted')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();

    // An update without smtpPassword must not wipe the credential.
    const renamed = await call('PATCH', `/api/v1/EmailAccount/${id}`, adminToken, { name: `AGENT_TEST Support II ${runId}` });
    expect(renamed.status).toBe(200);
    const kept = await ctx.database.db
      .selectFrom('email_accounts')
      .select('smtp_password_encrypted')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(kept.smtp_password_encrypted).toBe(before.smtp_password_encrypted);

    // A new password replaces it (still encrypted).
    const replaced = await call('PATCH', `/api/v1/EmailAccount/${id}`, adminToken, { smtpPassword: `second-password-${runId}` });
    expect(replaced.status).toBe(200);
    const after = await ctx.database.db
      .selectFrom('email_accounts')
      .select('smtp_password_encrypted')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(after.smtp_password_encrypted).not.toBe(kept.smtp_password_encrypted);
    expect(after.smtp_password_encrypted).toMatch(/^v1:/);
    expect(after.smtp_password_encrypted).not.toContain(`second-password-${runId}`);
  });

  it('marks only one account as the default', async () => {
    const first = await call('POST', '/api/v1/EmailAccount', adminToken, {
      name: `AGENT_TEST Default A ${runId}`,
      emailAddress: `default-a-${runId}@crm.example`,
      smtpHost: 'smtp.crm.example',
      isDefault: true,
    });
    accountIds.push(String(first.body['id']));
    const second = await call('POST', '/api/v1/EmailAccount', adminToken, {
      name: `AGENT_TEST Default B ${runId}`,
      emailAddress: `default-b-${runId}@crm.example`,
      smtpHost: 'smtp.crm.example',
      isDefault: true,
    });
    accountIds.push(String(second.body['id']));

    const defaults = await ctx.database.db
      .selectFrom('email_accounts')
      .select('id')
      .where('is_default', '=', true)
      .where('is_deleted', '=', false)
      .execute();
    expect(defaults.map((row) => row.id)).toEqual([String(second.body['id'])]);

    // Drop the default flag so later suites never inherit an account-backed send.
    await call('PATCH', `/api/v1/EmailAccount/${String(second.body['id'])}`, adminToken, { isDefault: false });
  });

  it('soft-deletes an account so it disappears from reads', async () => {
    const created = await call('POST', '/api/v1/EmailAccount', adminToken, {
      name: `AGENT_TEST Gone ${runId}`,
      emailAddress: `gone-${runId}@crm.example`,
      smtpHost: 'smtp.crm.example',
    });
    const id = String(created.body['id']);
    accountIds.push(id);

    const removed = await call('DELETE', `/api/v1/EmailAccount/${id}`, adminToken);
    expect(removed.status).toBe(200);

    const read = await call('GET', `/api/v1/EmailAccount/${id}`, adminToken);
    expect(read.status).toBe(404);
    expect(codeOf(read)).toBe('RECORD_NOT_FOUND');
  });


  it('rejects account management for non-admin users', async () => {
    await createTestRole(ctx, { id: `role-plain-${runId}`, name: `Plain ${runId}`, permissions: { Email: { read: 'all', create: 'yes', edit: 'own' } } });
    const plain = await createTestUser(ctx, { userName: `ea_plain_${runId}`, roleIds: [`role-plain-${runId}`] });

    const list = await call('GET', '/api/v1/EmailAccount', plain.token);
    expect(list.status).toBe(403);
    expect(codeOf(list)).toBe('AUTHORIZATION_DENIED');

    const create = await call('POST', '/api/v1/EmailAccount', plain.token, {
      name: 'Sneaky',
      emailAddress: `sneaky-${runId}@crm.example`,
      smtpHost: 'smtp.example',
    });
    expect(create.status).toBe(403);

    // The generic Email API stays open to the same user (read-level access).
    const emails = await call('GET', '/api/v1/Email?maxSize=1', plain.token);
    expect(emails.status).toBe(200);
  });

  it('verify on an inactive account fails fast without opening a connection', async () => {
    const created = await call('POST', '/api/v1/EmailAccount', adminToken, {
      name: `AGENT_TEST Inactive ${runId}`,
      emailAddress: `inactive-${runId}@crm.example`,
      smtpHost: 'smtp.crm.example',
      isActive: false,
    });
    const id = String(created.body['id']);
    accountIds.push(id);

    const verified = await call('POST', `/api/v1/EmailAccount/${id}/action/verify`, adminToken);
    expect(verified.status).toBe(422);
  });
});

describe('email templates (Phase 11)', () => {
  it('renders the template when the send is queued and stores the rendered content', async () => {
    const template = await call('POST', '/api/v1/EmailTemplate', adminToken, {
      name: `AGENT_TEST Welcome ${runId}`,
      subject: 'Welcome aboard, {{description}}!',
      body: 'Hello {{name}}, your status is {{status}}. Ref: {{replyToAddress}}',
    });
    expect(template.status).toBe(201);
    const templateId = String(template.body['id']);
    templateIds.push(templateId);

    const draft = await call('POST', '/api/v1/Email', adminToken, {
      name: `AGENT_TEST Draft ${runId}`,
      description: `Acme ${runId}`,
      replyToAddress: `ref-${runId}@example.com`,
      fromAddress: `Sales <sales-${runId}@crm.example>`,
      toAddressList: `tpl-${runId}@example.com`,
      body: 'placeholder body',
      templateId,
    });
    expect(draft.status).toBe(201);
    const emailId = String(draft.body['id']);
    emailIds.push(emailId);

    const queued = await call('POST', `/api/v1/Email/${emailId}/action/send`, adminToken);
    expect(queued.status).toBe(200);
    const job = queued.body['job'] as { id: string };
    jobIds.push(job.id);

    // The record now carries the rendered subject and body — what the worker will send.
    const record = await call('GET', `/api/v1/Email/${emailId}`, adminToken);
    expect(record.body['name']).toBe(`Welcome aboard, Acme ${runId}!`);
    expect(record.body['body']).toBe(`Hello AGENT_TEST Draft ${runId}, your status is Draft. Ref: ref-${runId}@example.com`);
    expect(record.body['status']).toBe('Queued');
  });

  it('rejects a send whose template does not exist and leaves the draft untouched', async () => {
    const draft = await call('POST', '/api/v1/Email', adminToken, {
      name: `AGENT_TEST Bad tpl ${runId}`,
      fromAddress: `Sales <sales-${runId}@crm.example>`,
      toAddressList: `bad-tpl-${runId}@example.com`,
      body: 'body',
      templateId: `no-such-template-${runId}`,
    });
    const emailId = String(draft.body['id']);
    emailIds.push(emailId);

    const queued = await call('POST', `/api/v1/Email/${emailId}/action/send`, adminToken);
    expect(queued.status).toBe(422);

    const record = await call('GET', `/api/v1/Email/${emailId}`, adminToken);
    expect(record.body['status']).toBe('Draft');
    expect(record.body['name']).toBe(`AGENT_TEST Bad tpl ${runId}`);
  });
});


describe('signature (Phase 11)', () => {
  it('appends the account signature once when the send is queued', async () => {
    const signature = `Kind regards,\nAGENT_TEST Signature ${runId}`;
    const account = await call('POST', '/api/v1/EmailAccount', adminToken, {
      name: `AGENT_TEST Signed ${runId}`,
      emailAddress: `signed-${runId}@crm.example`,
      smtpHost: 'smtp.crm.example',
      smtpPort: 465,
      smtpSecurity: 'ssl',
      smtpUsername: `signed-${runId}`,
      smtpPassword: `pw-${runId}`,
      signature,
    });
    const accountId = String(account.body['id']);
    accountIds.push(accountId);

    const draft = await call('POST', '/api/v1/Email', adminToken, {
      name: `AGENT_TEST Signed mail ${runId}`,
      fromAddress: `Sales <signed-${runId}@crm.example>`,
      toAddressList: `signed-to-${runId}@example.com`,
      body: 'Thanks for the call.',
      emailAccountId: accountId,
    });
    const emailId = String(draft.body['id']);
    emailIds.push(emailId);

    const queued = await call('POST', `/api/v1/Email/${emailId}/action/send`, adminToken);
    expect(queued.status).toBe(200);
    jobIds.push(String((queued.body['job'] as { id: string }).id));

    const record = await call('GET', `/api/v1/Email/${emailId}`, adminToken);
    const body = String(record.body['body']);
    expect(body.startsWith('Thanks for the call.')).toBe(true);
    expect(body).toContain(`--\n${signature}`);
    // Exactly one signature block.
    expect(body.split(signature).length - 1).toBe(1);
  });
});

describe('inbound pipeline (Phase 11, §28.2)', () => {
  it('polls the provider and stores nothing when none is configured', async () => {
    const res = await call('POST', '/api/v1/Email/action/pollInbound', adminToken);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ fetched: 0, stored: 0, skipped: 0 });
  });

  it('requires authentication', async () => {
    const res = await call('POST', '/api/v1/Email/action/pollInbound');
    expect(res.status).toBe(401);
  });
});

