/**
 * Email jobs (PLAN §28.1) — the only place that talks to a mail server.
 *
 * `system.sendEmail` takes an Email record id, rebuilds the message from the record plus its §25
 * attachments, hands it to the configured transport and writes the per-recipient outcome into
 * `email_deliveries`. Retries come from the queue (§24): a connection or 4xx problem is re-thrown so
 * BullMQ backs off and tries again, while a 5xx or a rejected envelope is final and marks the record
 * failed instead of burning every attempt.
 */
import { randomUUID } from 'node:crypto';

import type { Logger } from '@carocrm/core/logger/index.js';
import type { FileStorage } from '@carocrm/files';
import type { JobContext, JobHandler, JobRegistry } from '@carocrm/jobs';
import type { MailAttachment, MailMessage, MailTransport, SendResult } from '@carocrm/mail';
import { classifySmtpError, emailRecordToMessageInput, sentRecordPatch } from '@carocrm/mail';

import type { Queryable } from '../db.js';

export const SEND_EMAIL_JOB = 'system.sendEmail';

export interface MailJobDeps {
  db: Queryable;
  log: Logger;
  transport: MailTransport;
  /** Attachment bytes live in the same storage the API writes to; without it, attachments fail. */
  storage?: FileStorage;
}

export const EMAIL_RECORD_SQL = `
  SELECT attrs
    FROM entity_records
   WHERE id = $1
     AND entity_type = 'Email'
     AND deleted_at IS NULL
`;

export const EMAIL_PATCH_SQL = `
  UPDATE entity_records
     SET attrs = attrs || $2::jsonb,
         modified_at = now(),
         version = version + 1
   WHERE id = $1
     AND entity_type = 'Email'
   RETURNING id
`;

export const EMAIL_ATTACHMENTS_SQL = `
  SELECT name, mime_type, storage_key
    FROM attachments
   WHERE parent_type = 'Email'
     AND parent_id = $1
   ORDER BY created_at
`;

/**
 * One row per recipient, keyed by (email_id, recipient). A retry updates the same row and bumps
 * `attempts`, so the ledger shows what happened to an address rather than one row per attempt.
 */
export const DELIVERY_UPSERT_SQL = `
  INSERT INTO email_deliveries
    (id, email_id, recipient, recipient_type, status, transport, provider_message_id, error,
     attempts, created_at, modified_at, sent_at)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, now(), now(), $9)
  ON CONFLICT (email_id, recipient) DO UPDATE
     SET recipient_type = EXCLUDED.recipient_type,
         status = EXCLUDED.status,
         transport = EXCLUDED.transport,
         provider_message_id = EXCLUDED.provider_message_id,
         error = EXCLUDED.error,
         attempts = email_deliveries.attempts + 1,
         modified_at = now(),
         sent_at = EXCLUDED.sent_at
  RETURNING id
`;

type Row = Record<string, unknown>;

function column(row: Row | undefined, key: string): string | null {
  const value = row?.[key];
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : String(value);
}

/** `attrs` arrives as an object from pg's JSONB, but a text column must be parsed. */
function attrsOf(row: Row | undefined): Record<string, unknown> {
  const attrs = row?.['attrs'];
  if (typeof attrs === 'string') {
    try {
      return JSON.parse(attrs) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return typeof attrs === 'object' && attrs !== null ? (attrs as Record<string, unknown>) : {};
}

function emailIdOf(data: Record<string, unknown> | undefined): string | null {
  const value = data?.['emailId'] ?? data?.['id'];
  if (typeof value !== 'string' || value.trim() === '') return null;
  return value.trim();
}

/** Which header list an address came from, for the ledger. */
export function recipientTypesOf(message: MailMessage): Map<string, string> {
  const map = new Map<string, string>();
  const lists: readonly ['to' | 'cc' | 'bcc', MailMessage['to']][] = [
    ['to', message.to],
    ['cc', message.cc],
    ['bcc', message.bcc],
  ];
  for (const [kind, entries] of lists) {
    for (const entry of entries) map.set(entry.address.toLowerCase(), kind);
  }
  return map;
}

/** Resolve the §25 attachment rows of an email into message attachments. */
async function loadAttachments(deps: MailJobDeps, emailId: string): Promise<MailAttachment[]> {
  const found = await deps.db.query(EMAIL_ATTACHMENTS_SQL, [emailId]);
  const rows = found.rows ?? [];
  if (rows.length === 0) return [];
  if (deps.storage === undefined) {
    throw new Error(`This email carries ${String(rows.length)} attachment(s) but this worker has no attachment storage.`);
  }
  const out: MailAttachment[] = [];
  for (const row of rows) {
    const key = column(row, 'storage_key');
    if (key === null) continue;
    out.push({
      filename: column(row, 'name') ?? 'attachment',
      contentType: column(row, 'mime_type') ?? 'application/octet-stream',
      content: await deps.storage.get(key),
    });
  }
  return out;
}

async function patchRecord(deps: MailJobDeps, emailId: string, patch: Record<string, string>): Promise<void> {
  await deps.db.query(EMAIL_PATCH_SQL, [emailId, JSON.stringify(patch)]);
}

interface DeliveryWrite {
  address: string;
  status: string;
  reason: string | null;
}

async function writeDeliveries(
  deps: MailJobDeps,
  emailId: string,
  types: Map<string, string>,
  transport: string,
  providerMessageId: string | null,
  writes: readonly DeliveryWrite[],
  sentAt: Date | null,
): Promise<void> {
  for (const write of writes) {
    await deps.db.query(DELIVERY_UPSERT_SQL, [
      randomUUID(),
      emailId,
      write.address,
      types.get(write.address.toLowerCase()) ?? 'to',
      write.status,
      transport,
      providerMessageId,
      write.reason,
      sentAt,
    ]);
  }
}

/**
 * Status the record carries once an attempt is over. Nothing delivered (a disabled transport) or every
 * recipient refused is a failure; a partial delivery stays 'Sent' with the rejected rows to prove it.
 */
export function recordStatusFor(result: SendResult): 'Sent' | 'Failed' {
  if (!result.delivered) return 'Failed';
  const delivered = result.recipients.filter((entry) => entry.status === 'accepted');
  return delivered.length === 0 && result.recipients.length > 0 ? 'Failed' : 'Sent';
}

export function sendEmailJob(deps: MailJobDeps): JobHandler {
  return async (context: JobContext) => {
    const emailId = emailIdOf(context.data);
    if (emailId === null) {
      return { status: 'failed', message: 'system.sendEmail needs a non-empty "emailId" in its payload.' };
    }

    const found = await deps.db.query(EMAIL_RECORD_SQL, [emailId]);
    const record = (found.rows ?? [])[0];
    if (record === undefined) {
      context.log(`email ${emailId} no longer exists; nothing to send`, 'warn');
      return { status: 'completed', message: 'Email record is missing.', result: { emailId, skipped: 'missing' } };
    }
    const attrs = attrsOf(record);
    if ((column(attrs, 'status') ?? 'Draft') === 'Sent') {
      context.log(`email ${emailId} is already sent`, 'info');
      return { status: 'completed', message: 'Already sent.', result: { emailId, skipped: 'sent' } };
    }
    if (await context.shouldStop()) {
      return { status: 'cancelled', message: 'Cancelled before the transport was called.' };
    }

    context.progress(10, `sending via ${deps.transport.name}`);
    await patchRecord(deps, emailId, { status: 'Sending' });

    let message: MailMessage;
    try {
      message = deps.transport.prepare(
        emailRecordToMessageInput(
          { id: emailId, data: attrs },
          { attachments: await loadAttachments(deps, emailId), fallbackFrom: deps.transport.info.fromAddress },
        ),
      );
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      await patchRecord(deps, emailId, { status: 'Failed', deliveryError: reason });
      deps.log.warn({ emailId, error: reason }, 'email could not be built');
      return { status: 'failed', message: reason };
    }

    const types = recipientTypesOf(message);
    const addresses = [...message.to, ...message.cc, ...message.bcc].map((entry) => entry.address);

    let result: SendResult;
    try {
      result = await deps.transport.send(message);
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      if (classifySmtpError(error) === 'transient') {
        // Put the record back in the queue state and let BullMQ retry with backoff (§24).
        await patchRecord(deps, emailId, { status: 'Queued' });
        deps.log.warn({ emailId, error: reason }, 'smtp attempt failed, retrying');
        throw error;
      }
      await writeDeliveries(deps, emailId, types, deps.transport.name, null,
        addresses.map((address) => ({ address, status: 'failed', reason })), null);
      await patchRecord(deps, emailId, { ...sentRecordPatch(message), status: 'Failed', deliveryError: reason });
      deps.log.error({ emailId, error: reason }, 'email delivery failed permanently');
      return { status: 'failed', message: reason };
    }

    const sentAt = result.delivered ? new Date() : null;
    await writeDeliveries(
      deps,
      emailId,
      types,
      result.transport,
      result.messageId,
      result.recipients.map((entry) => ({ address: entry.address, status: entry.status, reason: entry.reason })),
      sentAt,
    );

    const status = recordStatusFor(result);
    await patchRecord(deps, emailId, {
      ...sentRecordPatch(message),
      status,
      ...(sentAt === null ? {} : { dateSent: sentAt.toISOString() }),
      ...(result.delivered ? {} : { deliveryError: result.response ?? `transport "${result.transport}" did not deliver` }),
    });

    const accepted = result.recipients.filter((entry) => entry.status === 'accepted').length;
    const notDelivered = result.recipients.length - accepted;
    context.progress(100, `${String(accepted)} accepted, ${String(notDelivered)} not delivered`);
    context.log(`${result.transport}: ${String(accepted)} of ${String(result.recipients.length)} recipients`, 'info');
    deps.log.info({ emailId, transport: result.transport, accepted, notDelivered, messageId: result.messageId }, 'email attempt finished');

    return {
      status: 'completed',
      message: result.delivered
        ? `Delivered to ${String(accepted)} of ${String(result.recipients.length)} recipients.`
        : `Not delivered: ${result.response ?? 'the transport does not deliver'}`,
      result: { emailId, transport: result.transport, accepted, notDelivered, messageId: result.messageId, status },
    };
  };
}

export function registerMailJobs(registry: JobRegistry, deps: MailJobDeps): void {
  registry.register(SEND_EMAIL_JOB, sendEmailJob(deps));
}
