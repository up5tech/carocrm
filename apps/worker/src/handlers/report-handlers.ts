import type { Logger } from '@carocrm/core/logger/index.js';
import type { JobContext, JobHandler, JobRegistry } from '@carocrm/jobs';
import type { MailTransport } from '@carocrm/mail';

import type { Queryable } from '../db.js';

export const DELIVER_REPORT_JOB = 'reports.deliver';

export interface ScheduledReportPayload {
  readonly reportId: string;
  readonly reportName: string;
  readonly recipient: string;
  readonly filename: string;
  readonly csv: string;
}

export interface ReportJobDeps {
  readonly db: Queryable;
  readonly apiBaseUrl: string;
  readonly secret: string;
  readonly transport: MailTransport;
  readonly log: Logger;
  readonly fetcher?: typeof fetch;
}

const MAX_REPORT_CSV_BYTES = 5 * 1024 * 1024;

export const CLAIM_REPORT_DELIVERY_SQL = `
  INSERT INTO report_deliveries (schedule_id, scheduled_for_ms, status, attempts)
  VALUES ($1, $2, 'claimed', 1)
  ON CONFLICT (schedule_id, scheduled_for_ms) DO UPDATE
     SET status = 'claimed', attempts = report_deliveries.attempts + 1, modified_at = now()
   WHERE report_deliveries.status = 'retryable'
  RETURNING status
`;

export const REPORT_DELIVERY_STATUS_SQL = `
  SELECT status FROM report_deliveries WHERE schedule_id = $1 AND scheduled_for_ms = $2
`;

export const UPDATE_REPORT_DELIVERY_SQL = `
  UPDATE report_deliveries SET status = $3, modified_at = now(), sent_at = CASE WHEN $3 = 'delivered' THEN now() ELSE sent_at END
   WHERE schedule_id = $1 AND scheduled_for_ms = $2
`;

function parsePayload(raw: unknown): ScheduledReportPayload {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('Report delivery response must be an object.');
  const value = raw as Record<string, unknown>;
  for (const key of ['reportId', 'reportName', 'recipient', 'filename', 'csv'] as const) {
    if (typeof value[key] !== 'string' || value[key] === '') throw new Error(`Report delivery response is missing "${key}".`);
  }
  const csv = value['csv'] as string;
  if (Buffer.byteLength(csv, 'utf8') > MAX_REPORT_CSV_BYTES) throw new Error('Report CSV exceeds the 5 MiB delivery limit.');
  return {
    reportId: value['reportId'] as string,
    reportName: value['reportName'] as string,
    recipient: value['recipient'] as string,
    filename: safeFilename(value['filename'] as string),
    csv,
  };
}

function safeFilename(value: string): string {
  const name = value.replace(/[\\/\r\n\0]/g, '').trim().slice(0, 120);
  if (name === '' || name === '.' || name === '..') throw new Error('Report attachment filename is invalid.');
  return name.endsWith('.csv') ? name : `${name}.csv`;
}

export function scheduledReportJob(deps: ReportJobDeps): JobHandler {
  return async (context: JobContext) => {
    const scheduleId = context.data?.['scheduleId'];
    if (typeof scheduleId !== 'string' || scheduleId === '') {
      return { status: 'failed', message: 'reports.deliver needs a report schedule id.' };
    }
    const boundary = context.scheduledForMs;
    if (boundary === undefined || !Number.isSafeInteger(boundary)) {
      return { status: 'failed', message: 'reports.deliver must be fired by the cron scheduler.' };
    }
    if (deps.secret.trim() === '') return { status: 'failed', message: 'Scheduled reports are disabled: worker capability is not configured.' };
    if (deps.transport.mode !== 'live') return { status: 'failed', message: 'Scheduled report delivery requires a live mail transport.' };
    if (await context.shouldStop()) return { status: 'cancelled', message: 'Cancelled before report execution.' };

    const claim = await deps.db.query(CLAIM_REPORT_DELIVERY_SQL, [scheduleId, boundary]);
    if ((claim.rowCount ?? 0) === 0) {
      const existing = await deps.db.query(REPORT_DELIVERY_STATUS_SQL, [scheduleId, boundary]);
      const status = existing.rows[0]?.['status'];
      if (status === 'delivered') return { status: 'completed', message: 'Report was already delivered for this cron boundary.', result: { delivery: 'delivered', duplicateSuppressed: true } };
      if (status === 'ambiguous') return { status: 'completed', message: 'Previous mail attempt had an uncertain outcome; duplicate delivery was suppressed.', result: { delivery: 'ambiguous', duplicateSuppressed: true } };
      if (status === 'claimed') return { status: 'completed', message: 'Another worker owns this report delivery attempt.', result: { delivery: 'claimed', duplicateSuppressed: true } };
      throw new Error('Report delivery could not be claimed.');
    }

    const setStatus = async (status: 'delivered' | 'ambiguous' | 'retryable'): Promise<void> => {
      await deps.db.query(UPDATE_REPORT_DELIVERY_SQL, [scheduleId, boundary, status]);
    };
    let payload: ScheduledReportPayload;
    let message: ReturnType<MailTransport['prepare']>;
    try {
      const fetcher = deps.fetcher ?? fetch;
      const response = await fetcher(`${deps.apiBaseUrl.replace(/\/$/, '')}/api/v1/Report/action/deliver-scheduled`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-report-worker-secret': deps.secret },
        body: JSON.stringify({ scheduleId }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`Authorized report generation failed with HTTP ${String(response.status)}.`);
      payload = parsePayload(await response.json() as unknown);
      if (await context.shouldStop()) {
        await setStatus('retryable');
        return { status: 'cancelled', message: 'Cancelled before email delivery.' };
      }
      const from = deps.transport.info.fromAddress;
      if (!from) throw new Error('The configured mail transport has no sender address.');
      message = deps.transport.prepare({
        from,
        to: payload.recipient,
        subject: `Scheduled report: ${payload.reportName}`,
        text: `Your scheduled report "${payload.reportName}" is attached as a CSV file.`,
        attachments: [{ filename: payload.filename, contentType: 'text/csv; charset=utf-8', content: Buffer.from(payload.csv, 'utf8') }],
      });
    } catch (error: unknown) {
      await setStatus('retryable');
      throw error;
    }

    let sent;
    try {
      sent = await deps.transport.send(message);
    } catch (error: unknown) {
      // SMTP and Postgres cannot commit atomically: after a transport exception the provider may
      // already have accepted the message. Mark it ambiguous and suppress automatic duplicate sends.
      await setStatus('ambiguous');
      deps.log.warn({ scheduleId, error: error instanceof Error ? error.message : String(error) }, 'scheduled report email outcome is ambiguous; retry suppressed');
      context.log('mail outcome uncertain; duplicate delivery suppressed', 'warn');
      return { status: 'completed', message: 'Mail outcome is uncertain; automatic duplicate delivery was suppressed.', result: { delivery: 'ambiguous' } };
    }
    const accepted = sent.recipients.some((recipient) => recipient.address.toLowerCase() === payload.recipient.toLowerCase() && recipient.status === 'accepted');
    if (!sent.delivered || !accepted) {
      await setStatus('retryable');
      const reason = sent.response ?? sent.recipients.find((recipient) => recipient.status !== 'accepted')?.reason ?? 'mail transport did not accept the owner recipient';
      throw new Error(`Scheduled report email was not delivered: ${reason}`);
    }
    await setStatus('delivered');

    context.progress(100, 'scheduled report delivered');
    context.log(`delivered report ${payload.reportId} to its owner`, 'info');
    deps.log.info({ reportId: payload.reportId, scheduleId, scheduledForMs: boundary }, 'scheduled report delivered');
    return { status: 'completed', message: 'Scheduled report delivered to its owner.', result: { reportId: payload.reportId, delivery: 'delivered' } };
  };
}

export function registerReportJobs(registry: JobRegistry, deps: ReportJobDeps): void {
  registry.register(DELIVER_REPORT_JOB, scheduledReportJob(deps));
}
