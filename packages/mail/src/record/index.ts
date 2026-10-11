/**
 * Mapping between an Email record and a `MailMessageInput` (PLAN §28.3 "Email records").
 *
 * The record field names are the metadata contract in `database/seed-metadata.ts`; both the API
 * (which validates a draft before queueing) and the worker (which actually sends) build the message
 * through this one function, so a stored email means the same thing to both sides.
 *
 * `headers` is stored as JSON text because the kernel has no object field type; anything that is not
 * a flat string map is rejected here rather than at SMTP time.
 */
import { ValidationError } from '@carocrm/core/errors/index.js';

import type { MailAddress, MailMessageInput } from '../message/index.js';

/** Email record fields this mapper reads (the rest of the record is CRM data, not envelope data). */
export interface EmailRecordLike {
  id: string;
  data: Record<string, unknown>;
}

export function stringField(record: EmailRecordLike, key: string): string | null {
  const value = record.data[key];
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value === '' ? null : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw new ValidationError(`Field "${key}" of email "${record.id}" must be text.`, { field: key });
}

export function requiredField(record: EmailRecordLike, key: string): string {
  const value = stringField(record, key);
  if (value === null) throw new ValidationError(`Email "${record.id}" has no "${key}".`, { field: key });
  return value;
}

/** Accepts a stored JSON object of string values, or a list of `Name: value` lines. */
export function parseStoredHeaders(value: string | null, emailId: string): Record<string, string> {
  if (value === null) return {};
  const trimmed = value.trim();
  if (trimmed === '' || trimmed === '{}') return {};
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new ValidationError(`Email "${emailId}" stores headers that are not valid JSON.`, { emailId });
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new ValidationError(`Email "${emailId}" headers must be a JSON object.`, { emailId });
    }
    const out: Record<string, string> = {};
    for (const [key, entry] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof entry !== 'string' && typeof entry !== 'number' && typeof entry !== 'boolean') {
        throw new ValidationError(`Header "${key}" must be a single value.`, { emailId });
      }
      out[key] = String(entry);
    }
    return out;
  }
  // Plain "X-Header: value" lines, one per header.
  const out: Record<string, string> = {};
  for (const line of trimmed.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    const colon = line.indexOf(':');
    if (colon <= 0) throw new ValidationError(`Email "${emailId}" has a malformed header line: "${line}".`, { emailId });
    out[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return out;
}

/** The From account of an email record, falling back to the configured transport address. */
export function recordFromAddress(record: EmailRecordLike, fallback: MailAddress | string | null): string {
  const stored = stringField(record, 'fromAddress');
  if (stored !== null) return stored;
  if (typeof fallback === 'string') return fallback;
  if (fallback !== null) return fallback.address;
  throw new ValidationError(`Email "${record.id}" has no "fromAddress" and no sending account is configured.`, {
    emailId: record.id,
  });
}

/**
 * Build the transport input for an Email record. `attachments` are supplied by the caller (only the
 * worker can read them from storage), everything else comes from the record's own fields.
 */
export function emailRecordToMessageInput(
  record: EmailRecordLike,
  options: { fallbackFrom?: MailAddress | string | null; attachments?: MailMessageInput['attachments'] } = {},
): MailMessageInput {
  const emailId = record.id;
  return {
    from: recordFromAddress(record, options.fallbackFrom ?? null),
    to: stringField(record, 'toAddressList'),
    cc: stringField(record, 'ccAddressList'),
    bcc: stringField(record, 'bccAddressList'),
    replyTo: stringField(record, 'replyToAddress'),
    subject: stringField(record, 'name') ?? '',
    text: stringField(record, 'body'),
    html: stringField(record, 'bodyHtml'),
    headers: parseStoredHeaders(stringField(record, 'headers'), emailId),
    messageId: stringField(record, 'messageId'),
    threadId: stringField(record, 'threadId'),
    inReplyTo: stringField(record, 'inReplyTo'),
    ...(options.attachments === undefined ? {} : { attachments: options.attachments }),
  };
}

/** Fields an email record gains after a send, so a thread survives a page reload. */
export function sentRecordPatch(message: {
  messageId: string;
  threadId: string;
  from: MailAddress;
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
}): Record<string, string> {
  return {
    messageId: message.messageId,
    threadId: message.threadId,
    fromAddress: formatAddresses([message.from])[0] ?? message.from.address,
    toAddressList: formatAddresses(message.to).join(', '),
    ccAddressList: formatAddresses(message.cc).join(', '),
    bccAddressList: formatAddresses(message.bcc).join(', '),
  };
}

function formatAddresses(values: readonly MailAddress[]): string[] {
  return values.map((entry) => (entry.name === null || entry.name === '' ? entry.address : `${entry.name} <${entry.address}>`));
}
