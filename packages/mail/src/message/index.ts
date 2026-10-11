/**
 * Mail message model (PLAN §28.1 "Provider interface").
 *
 * The API and the worker never hand a raw provider object around: an outbound message is normalized
 * here first, so address parsing, recipient limits and header-injection defenses have exactly one
 * implementation shared by every transport. `MailTransport` is the port; SMTP, a generic SMTP relay
 * and the disabled/memory transports implement it.
 */
import { ValidationError } from '@carocrm/core/errors/index.js';

/** A single address, optionally with a display name. */
export interface MailAddress {
  name: string | null;
  address: string;
}

/** An attachment reference; `content` is read from the configured FileStorage by the caller. */
export interface MailAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
  /** Content id for inline parts (images inside an HTML body). */
  cid?: string | undefined;
}

export interface MailMessage {
  from: MailAddress;
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  replyTo: MailAddress | null;
  subject: string;
  text: string;
  html: string;
  headers: Record<string, string>;
  /** RFC 5322 Message-Id, generated when the caller did not supply one. */
  messageId: string;
  /** Conversation key: this message's id for a new thread, or the root it replies to. */
  threadId: string;
  inReplyTo: string | null;
  references: string[];
  attachments: MailAttachment[];
}

export interface RecipientResult {
  address: string;
  /**
   * What the transport reported for this single recipient. `skipped` means the transport is
   * deliberately not delivering (MAIL_TRANSPORT=none), so a dev install never looks like it sent mail.
   */
  status: 'accepted' | 'rejected' | 'skipped';
  reason: string | null;
}

export interface SendResult {
  transport: string;
  /** False for a transport that is configured but deliberately not delivering (PLAN §28 safety). */
  delivered: boolean;
  messageId: string;
  recipients: RecipientResult[];
  /** Provider response text, kept for the delivery log. */
  response: string | null;
}

/** What a transport advertises to `GET /Email/action/transport` and to the worker startup log. */
export interface MailTransportInfo {
  name: string;
  mode: 'live' | 'disabled';
  /** The sending mailbox, when the transport has one. */
  fromAddress: string | null;
  maxRecipients: number;
  /** True when a From address other than `fromAddress` is refused (anti-spoofing). */
  strictFrom: boolean;
  /** True when messages are kept in memory instead of dropped (test/dev transports). */
  holdsMessages: boolean;
}

export interface MailTransport {
  readonly name: string;
  /** 'live' sends to the network; 'disabled' records without delivering. */
  readonly mode: 'live' | 'disabled';
  readonly info: MailTransportInfo;
  /**
   * Validate and complete a message with this transport's own limits, without sending it. The API
   * calls it before queueing so a bad draft is a clear 422 instead of a failed job later.
   */
  prepare(message: MailMessageInput): MailMessage;
  /**
   * PLAN §28.1 declares `send(message: MailMessage)`. A normalized `MailMessage` satisfies
   * `MailMessageInput`, and taking the input shape lets each transport apply its own recipient and
   * From-address rules instead of trusting the caller to have normalized.
   */
  send(message: MailMessageInput): Promise<SendResult>;
  /** Handshake check for an admin "verify settings" action. */
  verify(): Promise<void>;
}

/**
 * Accepted shape before normalization: addresses may arrive as strings, lists or single values, and
 * every optional field also accepts `null` because an Email record stores absent values that way.
 */
export interface MailMessageInput {
  from: string | MailAddress;
  to?: string | readonly (string | MailAddress)[] | null | undefined;
  cc?: string | readonly (string | MailAddress)[] | null | undefined;
  bcc?: string | readonly (string | MailAddress)[] | null | undefined;
  replyTo?: string | MailAddress | null | undefined;
  subject?: string | null | undefined;
  text?: string | null | undefined;
  html?: string | null | undefined;
  headers?: Record<string, unknown> | null | undefined;
  inReplyTo?: string | null | undefined;
  references?: readonly string[] | null | undefined;
  attachments?: readonly MailAttachment[] | null | undefined;
  messageId?: string | null | undefined;
  threadId?: string | null | undefined;
}

export interface NormalizeOptions {
  /** Ceiling over to+cc+bcc combined. */
  maxRecipients: number;
  /** Domain used when a Message-Id has to be generated. */
  messageIdDomain: string;
  maxSubjectLength?: number | undefined;
}

const ADDRESS_PATTERN = /^[^\s@<>(),:;]+@[^\s@<>(),:;]+\.[A-Za-z]{2,}$/;
const MAX_ADDRESS_LENGTH = 320;
const HEADER_NAME_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

/** Headers the transport owns: letting a caller set them would corrupt or forge the envelope. */
const FORBIDDEN_HEADERS: ReadonlySet<string> = new Set([
  'from',
  'to',
  'cc',
  'bcc',
  'reply-to',
  'subject',
  'date',
  'message-id',
  'mime-version',
  'content-type',
  'content-transfer-encoding',
  'received',
  'sender',
]);

function stripAngle(value: string): string {
  const start = value.indexOf('<');
  const end = value.lastIndexOf('>');
  return start >= 0 && end > start ? value.slice(start + 1, end) : value;
}

/**
 * Split a header-style address list on commas that are outside quotes and outside `<...>`,
 * so `Doe, John <j@example.com>` stays one address.
 */
export function splitAddressList(value: string): string[] {
  const out: string[] = [];
  let current = '';
  let quoted = false;
  let angle = 0;
  for (const character of value) {
    if (character === '"') quoted = !quoted;
    if (!quoted) {
      if (character === '<') angle += 1;
      else if (character === '>' && angle > 0) angle -= 1;
      else if (character === ',' && angle === 0) {
        if (current.trim() !== '') out.push(current.trim());
        current = '';
        continue;
      }
    }
    current += character;
  }
  if (current.trim() !== '') out.push(current.trim());
  return out;
}

/** Parse one `Name <address>` / bare address token. Throws a ValidationError when unusable. */
export function parseAddress(value: string): MailAddress {
  const raw = value.trim();
  if (raw === '') throw new ValidationError('An email address is required.');
  if (raw.length > MAX_ADDRESS_LENGTH) {
    throw new ValidationError(`Email address is longer than ${String(MAX_ADDRESS_LENGTH)} characters.`, { length: raw.length });
  }
  const start = raw.indexOf('<');
  const end = raw.lastIndexOf('>');
  const hasAngle = start >= 0 && end > start;
  const address = stripAngle(raw).trim().toLowerCase();
  const namePart = hasAngle ? raw.slice(0, start).trim() : '';
  const name = namePart.replace(/^"|"$/g, '').trim();
  if (!ADDRESS_PATTERN.test(address)) throw new ValidationError(`Invalid email address: "${raw}".`, { address: raw });
  return { name: name === '' ? null : name, address };
}

/** A single optional address: `null` (a blank record field) means "not set". */
function toAddress(value: string | MailAddress | null | undefined): MailAddress | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? (value.trim() === '' ? null : parseAddress(value)) : parseAddress(formatAddress(value));
}

function expandAddressEntry(entry: string | MailAddress): MailAddress[] {
  if (typeof entry === 'string') return splitAddressList(entry).map(parseAddress);
  // Round-tripping through the text form means a hand-built address is validated the same way.
  return [parseAddress(formatAddress(entry))];
}

function toList(value: string | readonly (string | MailAddress)[] | null | undefined, seen: Set<string>): MailAddress[] {
  if (value === null || value === undefined) return [];
  const entries: readonly (string | MailAddress)[] = typeof value === 'string' ? splitAddressList(value) : value;
  const parsed: MailAddress[] = [];
  for (const entry of entries) {
    for (const address of expandAddressEntry(entry)) {
      const key = address.address.toLowerCase();
      // One address may only appear once across to/cc/bcc, or the server counts it twice.
      if (seen.has(key)) continue;
      seen.add(key);
      parsed.push(address);
    }
  }
  return parsed;
}

function formatAddress(value: MailAddress): string {
  if (value.name === null || value.name === '') return value.address;
  const safe = value.name.replace(/["\\]/g, '');
  return safe.includes(',') || safe.includes(':') ? `"${safe}" <${value.address}>` : `${safe} <${value.address}>`;
}

export function formatAddressList(values: readonly MailAddress[]): string {
  return values.map(formatAddress).join(', ');
}

/** RFC 5322 Message-Id, wrapped in angle brackets. */
export function buildMessageId(domain: string, local: string): string {
  const clean = local.replace(/[^A-Za-z0-9._+-]/g, '').slice(0, 64);
  const host = domain.replace(/[^A-Za-z0-9.-]/g, '').replace(/^\.+|\.+$/g, '');
  return `<${clean === '' ? 'mail' : clean}@${host === '' ? 'localhost' : host}>`;
}

/** Strips the angle brackets a stored id may carry; null (a blank record field) means "none". */
export function bareMessageId(value: string | null | undefined): string {
  return (value ?? '').trim().replace(/^<|>$/g, '');
}

function emptyToNull(value: string): string | null {
  return value === '' ? null : value;
}

function normalizeHeaders(headers: Record<string, unknown> | null | undefined): Record<string, string> {
  if (headers === undefined || headers === null) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!HEADER_NAME_PATTERN.test(key)) {
      throw new ValidationError(`Invalid email header name: "${key}".`, { header: key });
    }
    if (FORBIDDEN_HEADERS.has(key.toLowerCase())) {
      throw new ValidationError(`The "${key}" header is set by the mail message itself, not by headers.`, { header: key });
    }
    if (typeof value !== 'string') {
      throw new ValidationError(`Header "${key}" must be a string.`, { header: key });
    }
    // CR/LF inside a header value is SMTP header injection; CRLF folding is not supported here.
    if (/[\r\n\0]/.test(value)) {
      throw new ValidationError(`Header "${key}" contains a line break.`, { header: key });
    }
    out[key] = value.trim();
  }
  return out;
}

/**
 * Validate and complete an outbound message: parse and dedupe addresses, enforce the recipient
 * ceiling, reject header injection, and fill in Message-Id / thread metadata so replies group.
 */
export function normalizeMailMessage(input: MailMessageInput, options: NormalizeOptions): MailMessage {
  const from = typeof input.from === 'string' ? parseAddress(input.from) : input.from;
  const seen = new Set<string>();
  const to = toList(input.to, seen);
  const cc = toList(input.cc, seen);
  const bcc = toList(input.bcc, seen);
  const replyTo = toAddress(input.replyTo);

  if (to.length + cc.length + bcc.length === 0) {
    throw new ValidationError('An email needs at least one recipient in to, cc or bcc.');
  }
  const maxRecipients = Math.max(1, Math.trunc(options.maxRecipients));
  if (to.length + cc.length + bcc.length > maxRecipients) {
    throw new ValidationError(`An email accepts at most ${String(maxRecipients)} recipients.`, {
      recipients: to.length + cc.length + bcc.length,
    });
  }

  const subjectRaw = input.subject ?? '';
  if (/\p{Cc}/u.test(subjectRaw)) throw new ValidationError('Subject contains a control character.');
  const limit = options.maxSubjectLength ?? 998;
  const subject = subjectRaw.slice(0, limit);

  const text = input.text ?? '';
  const html = input.html ?? '';
  if (text === '' && html === '') {
    throw new ValidationError('An email needs a body: set text or html.');
  }

  const attachments = (input.attachments ?? []).map((attachment) => {
    const filename = attachment.filename.replace(/^.*[\\/]/, '').trim();
    if (filename === '') throw new ValidationError('An attachment needs a filename.');
    if (/\p{Cc}/u.test(filename) || /\p{Cc}/u.test(attachment.contentType)) {
      throw new ValidationError(`Attachment "${filename}" has an invalid name or content type.`);
    }
    return {
      filename,
      contentType: attachment.contentType,
      content: attachment.content,
      ...(attachment.cid === undefined ? {} : { cid: attachment.cid }),
    };
  });

  const inReplyTo = emptyToNull(bareMessageId(input.inReplyTo));
  const references = (input.references ?? []).map(bareMessageId).filter((value) => value !== '');
  const messageId = bareMessageId(input.messageId);
  const own = messageId === '' ? buildMessageId(options.messageIdDomain, `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`) : `<${messageId}>`;
  // A stored thread id wins, so re-sending a record keeps it in the same conversation; otherwise the
  // reply chain roots the thread, and otherwise this message starts one.
  const thread = emptyToNull(bareMessageId(input.threadId)) ?? inReplyTo ?? emptyToNull(references[0] ?? '');

  return {
    from,
    to,
    cc,
    bcc,
    replyTo,
    subject,
    text,
    html,
    headers: normalizeHeaders(input.headers),
    messageId: bareMessageId(own),
    threadId: bareMessageId(thread ?? own),
    inReplyTo,
    references: inReplyTo !== null && !references.includes(inReplyTo) ? [...references, inReplyTo] : references,
    attachments,
  };
}
