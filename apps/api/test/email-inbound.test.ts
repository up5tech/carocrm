import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiContext } from './support/boot-api.js';
import { authHeader, bootApi, shutdownApi } from './support/boot-api.js';

// The API must never reach a real mail server from a test (AGENTS.md §5.5). This file saves and
// restores any env it overrides so its boot-time config never leaks into other test files.

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

interface CallResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

const runId = `ib${Date.now().toString(36)}`;
const fixtureDir = join(tmpdir(), `carocrm-inbound-fixtures-${process.pid}`);
const savedEnv: Record<string, string | undefined> = {};
function setEnv(key: string, value: string): void {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  process.env[key] = value;
}
let ctx: ApiContext;
let adminToken = '';
const emailIds: string[] = [];
const connectionIds: string[] = [];
/** Provider ids of the fixture messages this run created — the only records the cleanup removes. */
const fixtureMessageIds: string[] = [];

async function call(method: Method, url: string, token?: string | undefined, payload?: unknown): Promise<CallResult> {
  const res = await ctx.app.inject({
    method,
    url,
    ...(token === undefined || token === '' ? {} : { headers: authHeader(token) }),
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

const eml = (lines: string[]) => lines.join('\r\n');

function fixtureId(fileName: string): string {
  const bytes = readFileSync(join(fixtureDir, fileName));
  return `fixture:${fileName}:${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}`;
}

/** The persisted cursor of one connection (`null` when the connection was never polled). */
async function readCursor(connectionId: string): Promise<string | null> {
  const row = await ctx.database.db
    .selectFrom('inbound_mail_cursors')
    .select('cursor')
    .where('connection_id', '=', connectionId)
    .executeTakeFirst();
  return row?.cursor ?? null;
}

/** How many Email records the fixture connection has stored so far. */
async function countFixtureRecords(): Promise<number> {
  const rows: Array<{ count: string }> = await ctx.database.db
    .selectFrom('entity_records')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('entity_type', '=', 'Email')
    .where('deleted_at', 'is', null)
    .where(sql`attrs ->> 'inboundConnectionId'`, '=', `fixture:${fixtureDir}`)
    .execute();
  return Number(rows[0]?.count ?? '0');
}

beforeAll(async () => {
  setEnv('MAIL_TRANSPORT', 'memory');
  setEnv('MAIL_INBOUND_PROVIDER', 'fixture');
  setEnv('ENCRYPTION_KEY', 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90');
  setEnv('MAIL_INBOUND_FIXTURE_DIR', fixtureDir);
  rmSync(fixtureDir, { recursive: true, force: true });
  mkdirSync(fixtureDir, { recursive: true });

  const write = (name: string, content: string) => writeFileSync(join(fixtureDir, name), content);
  write(
    '01-normal.eml',
    eml([
      `From: Customer One <customer-one@example.com>`,
      `To: support@crm.example`,
      `Subject: AGENT_TEST ${runId} normal`,
      `Message-ID: <${runId}-normal@fixture.example>`,
      `Date: Mon, 10 Nov 2026 08:00:00 +0000`,
      `Content-Type: text/plain; charset=utf-8`,
      ``,
      `Hello from a customer.`,
    ]),
  );
  write(
    '02-reply.eml',
    eml([
      `From: Customer One <customer-one@example.com>`,
      `To: support@crm.example`,
      `Subject: Re: AGENT_TEST ${runId} normal`,
      `Message-ID: <${runId}-reply@fixture.example>`,
      `In-Reply-To: <${runId}-normal@fixture.example>`,
      `Date: Mon, 10 Nov 2026 09:00:00 +0000`,
      `Content-Type: text/plain; charset=utf-8`,
      ``,
      `Following up on my own message.`,
    ]),
  );
  write(
    `03-bounce.eml`,
    eml([
      `From: MAILER-DAEMON <mailer-daemon@mx.example.com>`,
      `To: support@crm.example`,
      `Subject: AGENT_TEST ${runId} Delivery Status Notification`,
      `Message-ID: <${runId}-bounce@fixture.example>`,
      `Date: Mon, 10 Nov 2026 09:10:00 +0000`,
      `Content-Type: multipart/report; report-type=delivery-status; boundary="DSN"`,
      ``,
      `--DSN`,
      `Content-Type: text/plain`,
      ``,
      `Delivery failed.`,
      `--DSN--`,
      ``,
    ]),
  );
  write(
    '04-autoreply.eml',
    eml([
      `From: Away <away@example.com>`,
      `To: support@crm.example`,
      `Subject: AGENT_TEST ${runId} Automatic reply`,
      `Message-ID: <${runId}-auto@fixture.example>`,
      `Auto-Submitted: auto-replied`,
      `Date: Mon, 10 Nov 2026 09:20:00 +0000`,
      `Content-Type: text/plain; charset=utf-8`,
      ``,
      `I am out of office.`,
    ]),
  );
  write('05-malformed.eml', eml([`This is not a valid RFC 5322 message at all`, `second line without headers`]));
  write(
    '06-attachment.eml',
    eml([
      `From: Customer Two <customer-two@example.com>`,
      `To: support@crm.example`,
      `Subject: AGENT_TEST ${runId} with attachment`,
      `Message-ID: <${runId}-attach@fixture.example>`,
      `Date: Mon, 10 Nov 2026 09:30:00 +0000`,
      `Content-Type: multipart/mixed; boundary="MIX"`,
      ``,
      `--MIX`,
      `Content-Type: text/plain; charset=utf-8`,
      ``,
      `Please find the report attached.`,
      `--MIX`,
      `Content-Type: application/pdf; name="report.pdf"`,
      `Content-Disposition: attachment; filename="report.pdf"`,
      `Content-Transfer-Encoding: base64`,
      ``,
      Buffer.from('%PDF-1.4 fake-id\n%%EOF', 'utf8').toString('base64'),
      `--MIX--`,
      ``,
    ]),
  );

  ctx = await bootApi();
  adminToken = ctx.adminToken;

  for (const name of ['01-normal.eml', '02-reply.eml', '03-bounce.eml', '04-autoreply.eml', '05-malformed.eml', '06-attachment.eml']) {
    fixtureMessageIds.push(fixtureId(name));
  }

  // A pre-existing record with the normal fixture's provider id, but under a DIFFERENT connection,
  // must not block the fixture connection's copy (Phase 24.6: dedupe is scoped, not global).
  const foreign = await call('POST', '/api/v1/Email', adminToken, {
    name: `AGENT_TEST ${runId} foreign look-alike`,
    status: 'Inbound',
    direction: 'Inbound',
    messageId: fixtureId('01-normal.eml'),
    inboundConnectionId: `other-connection:${runId}`,
  });
  expect(foreign.status, JSON.stringify(foreign.body)).toBeLessThan(300);
  emailIds.push(String(foreign.body['id']));
});

afterAll(async () => {
  if (connectionIds.length > 0) {
    await ctx.database.db.deleteFrom('inbound_mail_cursors').where('connection_id', 'in', connectionIds).execute();
    await ctx.database.db.deleteFrom('inbound_mail_connections').where('id', 'in', connectionIds).execute();
  }
  // Only rows this run created: fixture records are found by the run-keyed foreign connection
  // plus the fixture message ids captured when the files were written.
  for (const messageId of fixtureMessageIds) {
    const rows: Array<{ id: string }> = await ctx.database.db
      .selectFrom('entity_records')
      .select('id')
      .where('entity_type', '=', 'Email')
      .where('deleted_at', 'is', null)
      .where(sql`attrs ->> 'messageId'`, '=', messageId)
      .execute();
    for (const row of rows) {
      if (emailIds.includes(row.id)) continue;
      await ctx.database.db.deleteFrom('attachments').where('parent_id', '=', row.id).where('parent_type', '=', 'Email').execute();
      await ctx.database.db.deleteFrom('entity_records').where('id', '=', row.id).execute();
    }
  }
  if (emailIds.length > 0) {
    for (const id of emailIds) {
      await ctx.database.db.deleteFrom('attachments').where('parent_id', '=', id).where('parent_type', '=', 'Email').execute();
    }
    await ctx.database.db.deleteFrom('email_deliveries').where('email_id', 'in', emailIds).execute();
    await ctx.database.db.deleteFrom('entity_records').where('id', 'in', emailIds).execute();
  }
  await ctx.database.db.deleteFrom('inbound_mail_cursors').where('connection_id', 'like', 'fixture:%').execute();
  rmSync(fixtureDir, { recursive: true, force: true });
  await shutdownApi();
  // Restore any env this file overrode so later files boot with the default (none) inbound provider.
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('inbound fixture ingestion (Phase 24.6)', () => {
  it('ingests the fixture mailbox exactly once and flags bounce/auto-reply/malformed records', async () => {
    const first = await call('POST', '/api/v1/Email/action/pollInbound', adminToken);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    // Six fixture files: normal, reply, bounce, auto-reply, malformed, attachment.
    expect(first.body).toEqual({ fetched: 6, stored: 6, skipped: 0, failed: 0 });

    // A second poll of the same connection is a no-op: every message is already stored.
    const again = await call('POST', '/api/v1/Email/action/pollInbound', adminToken);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body).toEqual({ fetched: 6, stored: 0, skipped: 6, failed: 0 });

    const rows: Array<{ id: string; attrs: unknown }> = await ctx.database.db
      .selectFrom('entity_records')
      .select(['id', 'attrs'])
      .where('entity_type', '=', 'Email')
      .where('deleted_at', 'is', null)
      .execute();
    const byMessageId = new Map<string, { id: string; attrs: Record<string, unknown> }>();
    for (const row of rows) {
      const attrs = (row.attrs ?? {}) as Record<string, unknown>;
      if (typeof attrs['inboundConnectionId'] === 'string' && String(attrs['inboundConnectionId']).startsWith('fixture:')) {
        byMessageId.set(String(attrs['messageId']), { id: row.id, attrs });
      }
    }
    expect(byMessageId.size).toBe(6);

    const normal = byMessageId.get(fixtureId('01-normal.eml'));
    expect(normal?.attrs['messageKind']).toBe('Standard');
    expect(normal?.attrs['status']).toBe('Inbound');

    // Both the foreign look-alike and the fixture copy exist with the same provider id.
    const sameId = rows.filter((row) => ((row.attrs ?? {}) as Record<string, unknown>)['messageId'] === fixtureId('01-normal.eml'));
    expect(sameId).toHaveLength(2);

    // The reply joins the normal message's thread.
    const reply = byMessageId.get(fixtureId('02-reply.eml'));
    expect(reply?.attrs['threadId']).toBe(normal?.attrs['threadId']);

    // Bounce / auto-reply are stored with a classification (never auto-create cases downstream).
    expect(byMessageId.get(fixtureId('03-bounce.eml'))?.attrs['messageKind']).toBe('Bounce');
    expect(byMessageId.get(fixtureId('04-autoreply.eml'))?.attrs['messageKind']).toBe('AutoReply');

    // Malformed yields a flagged record instead of failing the whole batch (the other five
    // fixture messages parsed fine).
    const malformed = byMessageId.get(fixtureId('05-malformed.eml'));
    expect(malformed?.attrs['inboundParsed']).toBe(false);
    expect(typeof malformed?.attrs['inboundError']).toBe('string');

    // Attachment lands through the attachment ACL/malware path with the Email record as parent.
    const attach = byMessageId.get(fixtureId('06-attachment.eml'));
    expect(attach).not.toBeUndefined();
    const attachmentRows = await ctx.database.db
      .selectFrom('attachments')
      .selectAll()
      .where('parent_id', '=', attach?.id ?? '')
      .where('parent_type', '=', 'Email')
      .execute();
    expect(attachmentRows).toHaveLength(1);
    expect(attachmentRows[0]?.name).toBe('report.pdf');
  });

  it('keeps the batch alive when one message cannot be stored, and retries it on the next poll', async () => {
    const connectionId = `fixture:${fixtureDir}`;
    const cursorBefore = await readCursor(connectionId);
    expect(cursorBefore).not.toBeNull();

    // A subject longer than the Email `name` limit (998 characters) cannot be stored: the record
    // fails validation. Only that message is affected — the other six are already stored.
    const unstoreableSubject = `AGENT_TEST ${runId} ${'x'.repeat(1_200)}`;
    writeFileSync(
      join(fixtureDir, '07-unstorable.eml'),
      eml([
        `From: Customer Three <customer-three@example.com>`,
        `To: support@crm.example`,
        `Subject: ${unstoreableSubject}`,
        `Message-ID: <${runId}-unstorable@fixture.example>`,
        `Date: Mon, 10 Nov 2026 10:00:00 +0000`,
        `Content-Type: text/plain; charset=utf-8`,
        ``,
        `This message cannot be stored.`,
      ]),
    );

    const res = await call('POST', '/api/v1/Email/action/pollInbound', adminToken);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ fetched: 7, stored: 0, skipped: 6, failed: 1 });

    // The failed message is retried on the next poll, so the cursor must not have moved.
    expect(await readCursor(connectionId)).toBe(cursorBefore);

    rmSync(join(fixtureDir, '07-unstorable.eml'));
  });

  it('fails clearly when a database connection provider fails', async () => {
    const created = await call('POST', '/api/v1/EmailAccount/action/inbound-connections', adminToken, {
      name: `AGENT_TEST Imap ${runId}`,
      provider: 'imap',
      mailbox: 'nobody@example.com',
      host: '127.0.0.1',
      port: 1,
      secure: false,
      folder: 'INBOX',
      credential: 'irrelevant',
      isActive: true,
    });
    expect(created.status, JSON.stringify(created.body)).toBeLessThan(300);
    const view = created.body as Record<string, unknown>;
    // The credential is write-only and encrypted at rest: responses never carry it.
    expect(view['hasCredential']).toBe(true);
    expect(view).not.toHaveProperty('credential');
    connectionIds.push(String(view['id']));

    const res = await call('POST', '/api/v1/Email/action/pollInbound', adminToken);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(codeOf(res)).toBe('VALIDATION_FAILED');
    expect(String(JSON.stringify(res.body))).toContain('Inbound poll failed');

    const after = await call('GET', `/api/v1/EmailAccount/action/inbound-connections/${String(view['id'])}`, adminToken);
    expect(after.status).toBe(200);
    expect(after.body['lastError']).toBeTruthy();
  });

  it('collects the other mailboxes even when one connection fails', async () => {
    // The broken IMAP connection from the previous test is still active, so this poll fails as a
    // whole — but the fixture mailbox must still be collected (one broken mailbox never blocks
    // the others).
    writeFileSync(
      join(fixtureDir, '08-isolation.eml'),
      eml([
        `From: Customer Four <customer-four@example.com>`,
        `To: support@crm.example`,
        `Subject: AGENT_TEST ${runId} isolation`,
        `Message-ID: <${runId}-isolation@fixture.example>`,
        `Date: Mon, 10 Nov 2026 11:00:00 +0000`,
        `Content-Type: text/plain; charset=utf-8`,
        ``,
        `Collected while another mailbox is broken.`,
      ]),
    );
    const messageId = fixtureId('08-isolation.eml');
    fixtureMessageIds.push(messageId);

    const res = await call('POST', '/api/v1/Email/action/pollInbound', adminToken);
    expect(res.status, JSON.stringify(res.body)).toBeGreaterThanOrEqual(400);
    expect(codeOf(res)).toBe('VALIDATION_FAILED');

    const rows: Array<{ id: string }> = await ctx.database.db
      .selectFrom('entity_records')
      .select('id')
      .where('entity_type', '=', 'Email')
      .where('deleted_at', 'is', null)
      .where(sql`attrs ->> 'messageId'`, '=', messageId)
      .execute();
    expect(rows).toHaveLength(1);

    rmSync(join(fixtureDir, '08-isolation.eml'));
  });

  it('stays idempotent across a restart', async () => {
    // The deliberately broken connection would fail every poll; remove it so the poll can run.
    for (const id of connectionIds) {
      const removed = await call('DELETE', `/api/v1/EmailAccount/action/inbound-connections/${id}`, adminToken);
      expect(removed.status, JSON.stringify(removed.body)).toBeLessThan(300);
    }

    // A restart: a new application, a new provider instance, the same database and the same
    // persisted cursor. Nothing may be stored twice.
    const countBefore = await countFixtureRecords();
    await shutdownApi();
    ctx = await bootApi();
    adminToken = ctx.adminToken;

    const res = await call('POST', '/api/v1/Email/action/pollInbound', adminToken);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ fetched: 6, stored: 0, skipped: 6, failed: 0 });
    expect(await countFixtureRecords()).toBe(countBefore);
  });

  it('refuses unauthenticated polling and connection reads', async () => {
    expect((await call('POST', '/api/v1/Email/action/pollInbound')).status).toBe(401);
    expect((await call('GET', '/api/v1/EmailAccount/action/inbound-connections')).status).toBeGreaterThanOrEqual(400);
  });
});
