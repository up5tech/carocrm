import type { MailTransport } from '@carocrm/mail';
import { createMailTransport } from '@carocrm/mail';

import type { WorkerConfig } from './env.js';

/**
 * Mail transport for worker jobs (`system.sendEmail`).
 *
 * The same `MAIL_TRANSPORT`/`SMTP_*` environment drives the API and the worker, so an email queued
 * by one is delivered with the other's settings. `none` (the default) builds a transport that reports
 * every recipient as skipped: a development worker can therefore run the whole pipeline without a
 * server, and cannot send real mail by accident (AGENTS.md §5.5).
 */
export function createMailTransportForWorker(
  config: WorkerConfig,
  env: Record<string, string | undefined> = process.env,
): MailTransport {
  return createMailTransport(config.mailTransport, env);
}
