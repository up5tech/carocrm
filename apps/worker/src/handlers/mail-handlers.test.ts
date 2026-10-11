import type { FileStorage } from '@carocrm/files';
import { JobRegistry } from '@carocrm/jobs';
import type { MailMessageInput, MailTransport, MailTransportInfo, SendResult } from '@carocrm/mail';
import { MemoryTransport, normalizeMailMessage } from '@carocrm/mail';
import { describe, expect, it } from 'vitest';

import { FakeDb, result } from '../testing/fake-db.js';
import { jobContext } from '../testing/job-context.js';
import { createTestLogger } from '../testing/test-logger.js';
import {
  DELIVERY_UPSERT_SQL,
  EMAIL_ATTACHMENTS_SQL,
  EMAIL_PATCH_SQL,
  EMAIL_RECORD_SQL,
  recordStatusFor,
  registerMailJobs,
  SEND_EMAIL_JOB,
} from './mail-handlers.js';

const RECORD_FRAGMENT = 'from entity_records';
const PATCH_FRAGMENT = 'update entity_records';
const DELIVERY_FRAGMENT = 'into email_deliveries';
const ATTACHMENT_FRAGMENT = 'from attachments';

function attrs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'Draft',
    name: 'Quarterly report',
    fromAddress: 'Sales <sales@crm.example>',
    toAddressList: 'a@example.com, b@example.com',
    ccAddressList: 'c@example.com',
    body: 'Numbers attached.',
    ...overrides,
  };
}

function recordRow(overrides: Record<string, unknown> = {}) {
  return { attrs: attrs(overrides) };
}

class RecordingTransport implements MailTransport {
  readonly name = 'test-smtp';
  readonly mode = 'live';
  readonly info: MailTransportInfo = {
    name: 'test-smtp',
    mode: 'live',
    fromAddress: 'sales@crm.example',
    maxRecipients: 50,
    strictFrom: false,
    holdsMessages: false,
  };
  sent: unknown[] = [];

  constructor(private readonly outcome: SendResult | Error = acceptedResult()) {}

  prepare(input: MailMessageInput) {
    return normalizeMailMessage(input, { maxRecipients: 50, messageIdDomain: 'crm.example' });
  }

  async send(message: MailMessageInput): Promise<SendResult> {
    this.sent.push(message);
    if (this.outcome instanceof Error) throw this.outcome;
    return this.outcome;
  }

  async verify(): Promise<void> {}
}

function acceptedResult(overrides: Partial<SendResult> = {}): SendResult {
  return {
    transport: 'test-smtp',
    delivered: true,
    messageId: 'provider-9@crm.example',
    recipients: [
      { address: 'a@example.com', status: 'accepted', reason: null },
      { address: 'b@example.com', status: 'accepted', reason: null },
      { address: 'c@example.com', status: 'accepted', reason: null },
    ],
    response: '250 OK',
    ...overrides,
  };
}

class FakeStorage implements FileStorage {
  readonly driver = 'local';
  readonly supportsSignedUrls = false;
  readonly files = new Map<string, Buffer>();

  async put(input: { key: string; body: Buffer | NodeJS.ReadableStream }): Promise<{ key: string; size: number; driver: 'local' }> {
    const content = Buffer.isBuffer(input.body) ? input.body : Buffer.alloc(0);
    this.files.set(input.key, content);
    return { key: input.key, size: content.byteLength, driver: 'local' };
  }

  async get(key: string): Promise<Buffer> {
    const value = this.files.get(key);
    if (value === undefined) throw new Error(`missing ${key}`);
    return value;
  }

  async openRead(): Promise<Readable> {
    throw new Error('not used by these tests');
  }

  async delete(key: string): Promise<void> {
    this.files.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    return this.files.has(key);
  }

  /** Test-side seeding helper. */
  async seed(key: string, content: Buffer): Promise<void> {
    await this.put({ key, body: content });
  }
}

function harness(row: Record<string, unknown> | null = recordRow(), transport?: MailTransport, storage?: FileStorage) {
  const db = new FakeDb();
  const logger = createTestLogger();
  db.returns(RECORD_FRAGMENT, row === null ? [] : [row]);
  db.returns(PATCH_FRAGMENT, [{ id: 'email-1' }]);
  db.returns(DELIVERY_FRAGMENT, [{ id: 'delivery-1' }]);
  db.returns(ATTACHMENT_FRAGMENT, []);
  const registry = new JobRegistry();
  const usedTransport = transport ?? new RecordingTransport();
  registerMailJobs(registry, { db, log: logger.log, transport: usedTransport, ...(storage === undefined ? {} : { storage }) });
  return { db, logger, registry, transport: usedTransport };
}

function patches(db: FakeDb): Record<string, string>[] {
  return db
    .callsFor(PATCH_FRAGMENT)
    .map((call) => JSON.parse(String(call.params[1])) as Record<string, string>);
}

function deliveryWrites(db: FakeDb): Record<string, unknown>[] {
  return db.callsFor(DELIVERY_FRAGMENT).map((call) => ({
    recipient: call.params[2],
    recipientType: call.params[3],
    status: call.params[4],
    transport: call.params[5],
    providerMessageId: call.params[6],
    error: call.params[7],
    sentAt: call.params[8],
  }));
}

describe('system.sendEmail', () => {
  it('is registered under the kernel name', () => {
    expect(harness().registry.list()).toEqual([SEND_EMAIL_JOB]);
  });

  it('needs an emailId and says so', async () => {
    const { registry } = harness();
    const outcome = await registry.get(SEND_EMAIL_JOB)?.(jobContext({}));
    expect(outcome?.status).toBe('failed');
    expect(outcome?.message).toMatch(/emailId/);
  });

  it('sends the record and writes the ledger per recipient', async () => {
    const { db, registry } = harness();
    const outcome = await registry.get(SEND_EMAIL_JOB)?.(jobContext({ emailId: 'email-1' }));

    expect(outcome?.status).toBe('completed');
    expect(outcome?.message).toMatch(/Delivered to 3 of 3/);
    expect((db.lastCall(RECORD_FRAGMENT)?.params ?? [])[0]).toBe('email-1');
    expect((db.lastCall(EMAIL_ATTACHMENTS_SQL)?.params ?? [])[0]).toBe('email-1');

    const writes = deliveryWrites(db);
    expect(writes).toHaveLength(3);
    expect(writes.map((entry) => entry.recipient)).toEqual(['a@example.com', 'b@example.com', 'c@example.com']);
    expect(writes.map((entry) => entry.recipientType)).toEqual(['to', 'to', 'cc']);
    expect(writes.every((entry) => entry.status === 'accepted')).toBe(true);
    expect(writes[0]?.transport).toBe('test-smtp');
    expect(writes[0]?.providerMessageId).toBe('provider-9@crm.example');
    expect(writes[0]?.sentAt).toBeInstanceOf(Date);

    const [sending, finished] = patches(db);
    expect(sending?.status).toBe('Sending');
    expect(finished?.status).toBe('Sent');
    expect(finished?.messageId).toMatch(/@crm\.example$/);
    expect(finished?.threadId).toBe(finished?.messageId);
    expect(finished?.dateSent).toMatch(/T.*Z/);
    // The normalized envelope is written back, so a re-read shows exactly what went out.
    expect(finished?.toAddressList).toBe('a@example.com, b@example.com');
    expect(finished?.ccAddressList).toBe('c@example.com');
    expect(finished?.fromAddress).toBe('Sales <sales@crm.example>');
  });

  it('leaves an already sent record alone', async () => {
    const { db, registry } = harness(recordRow({ status: 'Sent' }));
    const outcome = await registry.get(SEND_EMAIL_JOB)?.(jobContext({ emailId: 'email-1' }));
    expect(outcome?.result).toMatchObject({ skipped: 'sent' });
    expect(db.callsFor(DELIVERY_FRAGMENT)).toHaveLength(0);
    expect(db.callsFor(PATCH_FRAGMENT)).toHaveLength(0);
  });

  it('completes without a trace when the record is gone', async () => {
    const { db, registry } = harness(null);
    const outcome = await registry.get(SEND_EMAIL_JOB)?.(jobContext({ emailId: 'email-1' }));
    expect(outcome?.status).toBe('completed');
    expect(outcome?.result).toMatchObject({ skipped: 'missing' });
    expect(db.callsFor(PATCH_FRAGMENT)).toHaveLength(0);
  });

  it('marks a partially rejected send as Sent with the rejected row explained', async () => {
    const transport = new RecordingTransport(
      acceptedResult({
        recipients: [
          { address: 'a@example.com', status: 'accepted', reason: null },
          { address: 'b@example.com', status: 'rejected', reason: '550 no such user' },
          { address: 'c@example.com', status: 'accepted', reason: null },
        ],
      }),
    );
    const { db, registry } = harness(recordRow(), transport);
    const outcome = await registry.get(SEND_EMAIL_JOB)?.(jobContext({ emailId: 'email-1' }));

    expect(outcome?.result).toMatchObject({ accepted: 2, notDelivered: 1, status: 'Sent' });
    const rejected = deliveryWrites(db).find((entry) => entry.recipient === 'b@example.com');
    expect(rejected).toMatchObject({ status: 'rejected', error: '550 no such user' });
  });

  it('fails the record when every recipient is refused', async () => {
    const transport = new RecordingTransport(
      acceptedResult({
        recipients: [
          { address: 'a@example.com', status: 'rejected', reason: '550 blocked' },
          { address: 'b@example.com', status: 'rejected', reason: '550 blocked' },
          { address: 'c@example.com', status: 'rejected', reason: '550 blocked' },
        ],
      }),
    );
    const { registry } = harness(recordRow(), transport);
    const outcome = await registry.get(SEND_EMAIL_JOB)?.(jobContext({ emailId: 'email-1' }));
    expect(outcome?.result).toMatchObject({ accepted: 0, status: 'Failed' });
  });

  it('reports a disabled transport as not delivered', async () => {
    const { db, registry } = harness(recordRow(), new MemoryTransport({ strictFrom: 'sales@crm.example' }));
    const outcome = await registry.get(SEND_EMAIL_JOB)?.(jobContext({ emailId: 'email-1' }));

    expect(outcome?.status).toBe('completed');
    expect(outcome?.message).toMatch(/Not delivered/);
    expect(deliveryWrites(db).every((entry) => entry.status === 'skipped')).toBe(true);
    expect(deliveryWrites(db)[0]?.sentAt).toBeNull();
    const finished = patches(db)[1];
    expect(finished?.status).toBe('Failed');
    // Whatever the transport said why it did not deliver is kept on the record.
    expect(finished?.deliveryError).toBe('held in memory (#1)');
  });

  it('rethrows a transient failure and puts the record back in the queue', async () => {
    const transport = new RecordingTransport(Object.assign(new Error('connection reset'), { code: 'ESOCKET' }));
    const { db, registry } = harness(recordRow(), transport);

    await expect(registry.get(SEND_EMAIL_JOB)?.(jobContext({ emailId: 'email-1' }))).rejects.toThrow(/connection reset/);
    expect(patches(db).map((patch) => patch.status)).toEqual(['Sending', 'Queued']);
    expect(db.callsFor(DELIVERY_FRAGMENT)).toHaveLength(0);
  });

  it('treats a 5xx answer as final and records it against every recipient', async () => {
    const transport = new RecordingTransport(Object.assign(new Error('550 relay denied'), { responseCode: 550 }));
    const { db, registry } = harness(recordRow(), transport);

    const outcome = await registry.get(SEND_EMAIL_JOB)?.(jobContext({ emailId: 'email-1' }));
    expect(outcome?.status).toBe('failed');
    expect(outcome?.message).toMatch(/relay denied/);
    expect(deliveryWrites(db).map((entry) => entry.status)).toEqual(['failed', 'failed', 'failed']);
    expect(patches(db)[1]).toMatchObject({ status: 'Failed', deliveryError: '550 relay denied' });
  });

  it('fails a draft that cannot be built, without touching the transport', async () => {
    const transport = new RecordingTransport();
    const { db, registry } = harness(recordRow({ toAddressList: 'not-an-address' }), transport);

    const outcome = await registry.get(SEND_EMAIL_JOB)?.(jobContext({ emailId: 'email-1' }));
    expect(outcome?.status).toBe('failed');
    expect(outcome?.message).toMatch(/Invalid email address/);
    expect(transport.sent).toHaveLength(0);
    expect(patches(db)[1]).toMatchObject({ status: 'Failed' });
    expect(patches(db)[1]?.deliveryError).toMatch(/Invalid email address/);
  });

  it('refuses a record with no recipients at all', async () => {
    const { registry } = harness(recordRow({ toAddressList: null, ccAddressList: null }));
    const outcome = await registry.get(SEND_EMAIL_JOB)?.(jobContext({ emailId: 'email-1' }));
    expect(outcome?.message).toMatch(/at least one recipient/);
  });

  it('reads the §25 attachment bytes from storage and sends them', async () => {
    const storage = new FakeStorage();
    await storage.seed('emails/email-1/report.pdf', Buffer.from('pdf-bytes'));
    const db = new FakeDb();
    db.returns(RECORD_FRAGMENT, [recordRow()]);
    db.returns(PATCH_FRAGMENT, [{ id: 'email-1' }]);
    db.returns(DELIVERY_FRAGMENT, [{ id: 'd' }]);
    db.returns(ATTACHMENT_FRAGMENT, [{ name: 'report.pdf', mime_type: 'application/pdf', storage_key: 'emails/email-1/report.pdf' }]);
    const transport = new RecordingTransport();
    const registry = new JobRegistry();
    registerMailJobs(registry, { db, log: createTestLogger().log, transport, storage });

    const outcome = await registry.get(SEND_EMAIL_JOB)?.(jobContext({ emailId: 'email-1' }));
    expect(outcome?.status).toBe('completed');
    const sentMessage = transport.sent[0] as { attachments?: { filename: string; content: Buffer }[] };
    expect(sentMessage.attachments?.[0]?.filename).toBe('report.pdf');
    expect(sentMessage.attachments?.[0]?.content.toString()).toBe('pdf-bytes');
  });

  it('fails instead of silently dropping attachments when there is no storage', async () => {
    const db = new FakeDb();
    db.returns(RECORD_FRAGMENT, [recordRow()]);
    db.returns(PATCH_FRAGMENT, [{ id: 'email-1' }]);
    db.on(ATTACHMENT_FRAGMENT, () => result([{ name: 'a.pdf', mime_type: 'application/pdf', storage_key: 'k' }]));
    const registry = new JobRegistry();
    registerMailJobs(registry, { db, log: createTestLogger().log, transport: new RecordingTransport() });

    const outcome = await registry.get(SEND_EMAIL_JOB)?.(jobContext({ emailId: 'email-1' }));
    expect(outcome?.status).toBe('failed');
    expect(outcome?.message).toMatch(/no attachment storage/);
  });

  it('stops before the transport when the job was cancelled', async () => {
    const transport = new RecordingTransport();
    const { db, registry } = harness(recordRow(), transport);
    const outcome = await registry.get(SEND_EMAIL_JOB)?.(jobContext({ emailId: 'email-1' }, { cancelRequested: true }));

    expect(outcome?.status).toBe('cancelled');
    expect(transport.sent).toHaveLength(0);
    expect(db.callsFor(PATCH_FRAGMENT)).toHaveLength(0);
  });

  it('accepts attrs stored as JSON text', async () => {
    const { registry, db } = harness({ attrs: JSON.stringify(attrs()) });
    const outcome = await registry.get(SEND_EMAIL_JOB)?.(jobContext({ emailId: 'email-1' }));
    expect(outcome?.status).toBe('completed');
    expect(deliveryWrites(db)).toHaveLength(3);
  });

  it('reports progress and a log line for the job row', async () => {
    const { registry } = harness();
    const context = jobContext({ emailId: 'email-1' });
    await registry.get(SEND_EMAIL_JOB)?.(context);
    expect(context.progressLines).toEqual([10, 100]);
    expect(context.logLines.map(([message]) => message)).toContain('test-smtp: 3 of 3 recipients');
  });
});

describe('recordStatusFor', () => {
  it('is Failed when nothing was delivered', () => {
    expect(recordStatusFor(acceptedResult({ delivered: false }))).toBe('Failed');
    expect(recordStatusFor(acceptedResult({ recipients: [] }))).toBe('Sent');
  });

  it('is Failed only when every recipient failed', () => {
    expect(recordStatusFor(acceptedResult({ recipients: [{ address: 'a', status: 'rejected', reason: 'x' }] }))).toBe('Failed');
    expect(recordStatusFor(acceptedResult({ recipients: [{ address: 'a', status: 'rejected', reason: 'x' }, { address: 'b', status: 'accepted', reason: null }] }))).toBe('Sent');
  });

  it('documents the ledger key it relies on', () => {
    expect(DELIVERY_UPSERT_SQL).toMatch(/on conflict \(email_id, recipient\) do update/i);
    expect(EMAIL_PATCH_SQL).toMatch(/attrs = attrs \|\|/);
    expect(EMAIL_RECORD_SQL).toMatch(/deleted_at is null/i);
  });
});
