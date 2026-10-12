import type { JobContext } from '@carocrm/jobs';
import type { MailTransport } from '@carocrm/mail';
import { describe, expect, it, vi } from 'vitest';

import type { Queryable, QueryResultLike } from '../db.js';
import { REPORT_DELIVERY_STATUS_SQL, scheduledReportJob } from './report-handlers.js';

function context(data: Record<string, unknown> = {}, boundary = 1_800_000_000_000): JobContext {
  return { data, scheduledForMs: boundary, scheduleId: 'scheduled-job-1', progress: vi.fn(), log: vi.fn(), shouldStop: vi.fn().mockResolvedValue(false) };
}

function transport(overrides: Partial<MailTransport> = {}): MailTransport {
  const message = {
    from: { name: null, address: 'crm@example.test' }, to: [{ name: null, address: 'owner@example.test' }], cc: [], bcc: [],
    replyTo: null, subject: 'Scheduled report', text: 'Attached', html: '', headers: {}, messageId: 'id', threadId: 'id', inReplyTo: null, references: [],
    attachments: [{ filename: 'accounts.csv', contentType: 'text/csv; charset=utf-8', content: Buffer.from('safe\r\n') }],
  };
  return {
    name: 'smtp', mode: 'live', info: { name: 'smtp', mode: 'live', fromAddress: 'crm@example.test', maxRecipients: 20, strictFrom: true, holdsMessages: false },
    prepare: vi.fn().mockReturnValue(message),
    send: vi.fn().mockResolvedValue({ transport: 'smtp', delivered: true, messageId: 'msg-1', recipients: [{ address: 'owner@example.test', status: 'accepted', reason: null }], response: null }),
    verify: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as MailTransport;
}

const delivery = {
  reportId: 'report-1', reportName: 'Accounts', recipient: 'owner@example.test', filename: 'accounts.csv', csv: 'name\r\nAcme\r\n',
};

function deps(mail: MailTransport, fetcher: typeof fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(delivery), { status: 200 })), options: { claim?: boolean; existingStatus?: string } = {}) {
  const query = vi.fn(async (sql: string): Promise<QueryResultLike> => {
    if (sql === REPORT_DELIVERY_STATUS_SQL) return { rows: [{ status: options.existingStatus ?? 'claimed' }], rowCount: 1 };
    return { rows: [], rowCount: options.claim === false ? 0 : 1 };
  });
  const db: Queryable = { query: async (sql, params) => query(sql, params) };
  return { deps: { db, apiBaseUrl: 'http://api.local/', secret: 'test-secret', transport: mail, log: { info: vi.fn(), warn: vi.fn() } as never, fetcher }, query };
}

describe('scheduledReportJob', () => {
  it('fetches owner-authorized report output and sends only to the owner with CSV attachment', async () => {
    const mail = transport();
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(delivery), { status: 200 }));
    const { deps: jobDeps, query } = deps(mail, fetcher);
    const result = await scheduledReportJob(jobDeps)(context({ scheduleId: 'schedule-1' }));
    expect(result.status).toBe('completed');
    expect(fetcher).toHaveBeenCalledWith('http://api.local/api/v1/Report/action/deliver-scheduled', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ scheduleId: 'schedule-1' }),
      headers: expect.objectContaining({ 'x-report-worker-secret': 'test-secret' }),
    }));
    expect(mail.prepare).toHaveBeenCalledWith(expect.objectContaining({ to: 'owner@example.test', attachments: [expect.objectContaining({ filename: 'accounts.csv' })] }));
    expect(mail.send).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[1]).toEqual(['schedule-1', 1_800_000_000_000]);
    expect(query.mock.calls.at(-1)?.[1]).toEqual(['schedule-1', 1_800_000_000_000, 'delivered']);
  });

  it('fails closed when the secret, job data, live transport, or cron metadata is missing', async () => {
    const mail = transport();
    expect((await scheduledReportJob(deps(mail).deps)(context())).status).toBe('failed');
    expect((await scheduledReportJob({ ...deps(mail).deps, secret: '' })(context({ scheduleId: 'schedule-1' }))).status).toBe('failed');
    expect((await scheduledReportJob(deps(transport({ mode: 'disabled' })).deps)(context({ scheduleId: 'schedule-1' }))).status).toBe('failed');
    const noBoundary = context({ scheduleId: 'schedule-1' });
    delete (noBoundary as { scheduledForMs?: number }).scheduledForMs;
    expect((await scheduledReportJob(deps(mail).deps)(noBoundary)).status).toBe('failed');
  });

  it('does not send if generation fails or owner was not accepted', async () => {
    const mail = transport();
    const badResponse = vi.fn().mockResolvedValue(new Response('denied', { status: 403 }));
    await expect(scheduledReportJob(deps(mail, badResponse).deps)(context({ scheduleId: 'schedule-1' }))).rejects.toThrow(/HTTP 403/);
    expect(mail.send).not.toHaveBeenCalled();

    const skipped = transport({ send: vi.fn().mockResolvedValue({ transport: 'smtp', delivered: false, messageId: 'msg-1', recipients: [{ address: 'owner@example.test', status: 'skipped', reason: 'disabled' }], response: null }) });
    await expect(scheduledReportJob(deps(skipped).deps)(context({ scheduleId: 'schedule-1' }))).rejects.toThrow(/not delivered/);
  });

  it('suppresses duplicate deliveries and records ambiguous SMTP outcomes', async () => {
    const fetcher = vi.fn();
    const { deps: duplicateDeps } = deps(transport(), fetcher, { claim: false, existingStatus: 'delivered' });
    const duplicate = await scheduledReportJob(duplicateDeps)(context({ scheduleId: 'schedule-1' }));
    expect(duplicate.status).toBe('completed');
    expect(fetcher).not.toHaveBeenCalled();

    const mail = transport({ send: vi.fn().mockRejectedValue(new Error('connection lost after DATA')) });
    const { deps: ambiguousDeps, query } = deps(mail);
    const result = await scheduledReportJob(ambiguousDeps)(context({ scheduleId: 'schedule-1' }));
    expect(result.status).toBe('completed');
    expect(result.result).toEqual({ delivery: 'ambiguous' });
    expect(query.mock.calls.at(-1)?.[1]).toEqual(['schedule-1', 1_800_000_000_000, 'ambiguous']);
  });

  it('cancels before claiming a delivery', async () => {
    const { deps: jobDeps, query } = deps(transport(), vi.fn());
    const jobContext = context({ scheduleId: 'schedule-1' });
    jobContext.shouldStop = vi.fn().mockResolvedValue(true);
    const result = await scheduledReportJob(jobDeps)(jobContext);
    expect(result.status).toBe('cancelled');
    expect(query).not.toHaveBeenCalled();
  });
});
