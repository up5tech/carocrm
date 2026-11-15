/**
 * RFC 5322 / MIME parser (Phase 24.6).
 *
 * Converts one raw message (IMAP `BODY[]`, fixture `.eml`, Graph fallback content) into the
 * {@link InboundMailMessage} every inbound adapter returns. It is deliberately small but
 * standards-shaped: folded headers, RFC 2047 encoded-words, `multipart/*` nesting with
 * boundaries, `message/rfc822` embedding, base64 / quoted-printable decoding, RFC 5987
 * filenames, and bounce/auto-reply classification.
 *
 * A message that cannot be parsed still yields a best-effort fallback (`isMalformed: true`)
 * instead of throwing, so one poisoned message cannot poison a whole batch ("partially
 * processed batch" acceptance case). Only a structurally empty/undecodable input yields the
 * fallback; transports never synthesize a record from it.
 */
import type { MailAddress } from '../message/index.js';
import type { InboundMailAttachment, InboundMessageKind } from './index.js';

export interface ParsedMimeMessage {
  from: MailAddress;
  to: MailAddress[];
  cc: MailAddress[];
  subject: string;
  text: string;
  html: string | null;
  receivedAt: Date | null;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  headers: Record<string, string>;
  attachments: InboundMailAttachment[];
  messageKind: InboundMessageKind;
}

/** Classification from headers + Content-Type: delivery-status reports and daemon senders are bounces. */
export function classifyMessage(headers: Record<string, string>, contentType: string): InboundMessageKind {
  const autoSubmitted = (headers['auto-submitted'] ?? '').trim().toLowerCase();
  const autoSuppress = (headers['x-auto-response-suppress'] ?? '').trim().toLowerCase();
  const from = (headers['from'] ?? '').toLowerCase();
  if (contentType.startsWith('multipart/report')) return 'bounce';
  if (from.includes('mailer-daemon') || from.includes('postmaster@')) return 'bounce';
  if (autoSubmitted !== '' && autoSubmitted !== 'no') return 'auto-reply';
  if (autoSuppress !== '' && autoSuppress !== 'none') return 'auto-reply';
  if (/auto-?reply|out of office|out-of-office|autoreply/i.test(headers['subject'] ?? '')) return 'auto-reply';
  return 'standard';
}

/** Decodes one RFC 2047 encoded word (`=?charset?B?...?=` / Q). Non-conforming text passes through. */
export function decodeEncodedWord(word: string): string {
  const match = /^=\?([^?]+)\?([BbQq])\?([^?]*)\?=$/.exec(word.trim());
  if (match === null) return word;
  const [, charsetRaw, encoding, payload] = match as unknown as [unknown, string, string, string];
  const charset = String(charsetRaw).toLowerCase();
  try {
    let bytes: Buffer;
    if (encoding.toUpperCase() === 'B') bytes = Buffer.from(payload.replace(/\s+/g, ''), 'base64');
    else bytes = decodeQuotedPrintable(payload.replace(/_/g, ' '));
    return decodeCharset(bytes, charset);
  } catch {
    return word;
  }
}

/** Decodes a header value, collapsing RFC 2047 encoded words (including adjacent pairs). */
export function decodeHeaderValue(value: string): string {
  const unfolded = value.replace(/\r?\n[ \t]+/g, ' ');
  return unfolded
    .split(/(\=\?[^?]+\?[BbQq]\?[^?]*\?=)/g)
    .map((part) => (part.startsWith('=?') ? decodeEncodedWord(part) : part))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeCharset(bytes: Buffer, charset: string): string {
  if (charset === 'utf-8' || charset === 'utf8') return bytes.toString('utf8');
  if (charset === 'iso-8859-1' || charset === 'latin1' || charset === 'latin-1') return bytes.toString('latin1');
  if (charset === 'windows-1252') return bytes.toString('latin1');
  if (charset.startsWith('utf-16')) return bytes.toString('utf16le');
  return bytes.toString('utf8');
}

/** Quoted-printable decoding over bytes (softmax line endings, `=XX` and `=` soft breaks). */
export function decodeQuotedPrintable(text: string): Buffer {
  const cleaned = text.replace(/=\r?\n/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < cleaned.length; i++) {
    const chunk = cleaned.slice(i, i + 3);
    if (/^=[0-9A-Fa-f]{2}$/.test(chunk)) {
      bytes.push(parseInt(chunk.slice(1), 16));
      i += 2;
    } else {
      bytes.push(cleaned.charCodeAt(i) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

/** Parses one address (`Name <a@b>` or bare `a@b`); returns null for unparseable entries. */
export function parseSingleAddress(value: string): MailAddress | null {
  const angle = /^(.+?)\s*<([^>]+)>\s*$/.exec(value.trim());
  if (angle !== null) {
    return { name: decodeHeaderValue(String(angle[1]).replace(/^"|"$/g, '')) || null, address: String(angle[2]).trim() };
  }
  const bare = /^[^\s,<>]+@[^\s,<>]+$/.exec(value.trim());
  if (bare !== null) return { name: null, address: value.trim() };
  return null;
}

/** Parses an address list header, splitting on top-level commas. */
export function parseAddressList(value: string): MailAddress[] {
  if (value.trim() === '') return [];
  const parts: string[] = [];
  let current = '';
  let inQuotes = false;
  let angleDepth = 0;
  for (const char of value) {
    if (char === '"') inQuotes = !inQuotes;
    else if (char === '<') angleDepth += 1;
    else if (char === '>') angleDepth = Math.max(0, angleDepth - 1);
    if (char === ',' && !inQuotes && angleDepth === 0) {
      parts.push(current);
      current = '';
    } else current += char;
  }
  if (current.trim() !== '') parts.push(current);
  return parts.map(parseSingleAddress).filter((entry): entry is MailAddress => entry !== null);
}

function splitHeaderBlock(raw: Buffer): { headerText: string; body: Buffer } {
  const separator = raw.indexOf(Buffer.from('\r\n\r\n'));
  if (separator >= 0) {
    return { headerText: raw.subarray(0, separator).toString('latin1'), body: raw.subarray(separator + 4) };
  }
  const lfSeparator = raw.indexOf(Buffer.from('\n\n'));
  if (lfSeparator >= 0) {
    return { headerText: raw.subarray(0, lfSeparator).toString('latin1'), body: raw.subarray(lfSeparator + 2) };
  }
  // No body separator: header-only message (or one giant header). Treat the whole payload as headers.
  return { headerText: raw.toString('latin1'), body: Buffer.alloc(0) };
}

interface RawEntity {
  headers: Record<string, string>;
  contentType: string;
  charset: string;
  disposition: string;
  dispositionFilename: string | null;
  transferEncoding: string;
  body: Buffer;
  isMultipart: boolean;
  boundary: string | null;
}

function parseEntity(raw: Buffer): RawEntity {
  const { headerText, body } = splitHeaderBlock(raw);
  const headers: Record<string, string> = {};
  for (const rawLine of headerText.split(/\r?\n/)) {
    // A leading space/tab is a folded continuation of the previous header, not a new one.
    if (rawLine.startsWith(' ') || rawLine.startsWith('\t')) {
      const last = Object.keys(headers).pop();
      if (last !== undefined) headers[last] += ` ${rawLine.trim()}`;
      continue;
    }
    const colon = rawLine.indexOf(':');
    if (colon <= 0) continue;
    const name = rawLine.slice(0, colon).trim().toLowerCase();
    const value = rawLine.slice(colon + 1).trim();
    headers[name] = value;
  }
  const [contentTypeMain, ...contentTypeParams] = (headers['content-type'] ?? 'text/plain').split(';');
  const contentType = (contentTypeMain ?? 'text/plain').trim().toLowerCase();
  const params = new Map<string, string>();
  for (const segment of contentTypeParams) {
    const equals = segment.indexOf('=');
    if (equals <= 0) continue;
    params.set(segment.slice(0, equals).trim().toLowerCase(), segment.slice(equals + 1).trim().replace(/^"|"$/g, ''));
  }
  const dispositionRaw = headers['content-disposition'] ?? '';
  const [dispositionMain, ...dispositionParams] = dispositionRaw.split(';');
  const disposition = (dispositionMain ?? '').trim().toLowerCase();
  let dispositionFilename: string | null = null;
  for (const segment of dispositionParams) {
    const equals = segment.indexOf('=');
    if (equals <= 0) continue;
    const key = segment.slice(0, equals).trim().toLowerCase();
    const rawValue = segment.slice(equals + 1).trim().replace(/^"|"$/g, '');
    if (key === 'filename*') dispositionFilename = decodeRfc5987(rawValue) ?? rawValue;
    else if (key === 'filename' && dispositionFilename === null) dispositionFilename = rawValue;
  }
  return {
    headers,
    contentType,
    charset: (params.get('charset') ?? 'utf-8').toLowerCase(),
    disposition,
    dispositionFilename,
    transferEncoding: (headers['content-transfer-encoding'] ?? '').trim().toLowerCase(),
    body,
    isMultipart: contentType.startsWith('multipart/'),
    boundary: params.get('boundary') ?? null,
  };
}

function decodeRfc5987(value: string): string | null {
  const match = /^([^']*)'[^']*'(.*)$/.exec(value);
  if (match === null) return null;
  try {
    return decodeURIComponent(String(match[2]).replace(/\+/g, '%20'));
  } catch {
    return null;
  }
}

function decodeBodyBytes(entity: RawEntity): Buffer {
  const body = entity.body;
  if (entity.transferEncoding === 'base64') {
    return Buffer.from(body.toString('latin1').replace(/\s+/g, ''), 'base64');
  }
  if (entity.transferEncoding === 'quoted-printable') {
    return decodeQuotedPrintable(body.toString('latin1'));
  }
  return Buffer.from(body);
}

function splitMultipart(entity: RawEntity): Buffer[] {
  if (entity.boundary === null || entity.boundary === '') return [];
  const delimiter = Buffer.from(`--${entity.boundary}`, 'latin1');
  const chunks: Buffer[] = [];
  let position = entity.body.indexOf(delimiter);
  if (position < 0) return [];
  position += delimiter.length;
  // The first delimiter is followed by CRLF; subsequent parts start after it.
  while (position >= 0) {
    const next = entity.body.indexOf(delimiter, position);
    const segment = next < 0 ? entity.body.subarray(position) : entity.body.subarray(position, next);
    // Strip the leading line-break after the delimiter (but not the closing `--\r\n` tail).
    let trimmed = segment;
    if (trimmed[0] === 13 && trimmed[1] === 10) trimmed = trimmed.subarray(2);
    else if (trimmed[0] === 10) trimmed = trimmed.subarray(1);
    if (trimmed[0] === 45 && trimmed[1] === 45) break; // closing delimiter `--boundary--`
    if (trimmed.length > 0) {
      // The delimiter is defined as CRLF + `--boundary`, so one trailing line-break belongs
      // to the boundary, not to the part body.
      let end = trimmed.length;
      if (end >= 2 && trimmed[end - 2] === 13 && trimmed[end - 1] === 10) end -= 2;
      else if (end >= 1 && trimmed[end - 1] === 10) end -= 1;
      chunks.push(Buffer.from(trimmed.subarray(0, end)));
    }
    if (next < 0) break;
    position = next + delimiter.length;
  }
  return chunks;
}

interface CollectedParts {
  text: string;
  html: string | null;
  attachments: InboundMailAttachment[];
}

function collect(entity: RawEntity, collected: CollectedParts, allowText: boolean): void {
  if (entity.isMultipart) {
    for (const chunk of splitMultipart(entity)) {
      collect(parseEntity(chunk), collected, allowText);
    }
    return;
  }
  if (entity.contentType === 'message/rfc822') {
    collect(parseEntity(entity.body), collected, allowText);
    return;
  }
  const isAttachment =
    entity.disposition === 'attachment' ||
    entity.dispositionFilename !== null ||
    (entity.headers['content-id'] !== undefined && !entity.contentType.startsWith('text/'));
  if (entity.contentType === 'text/plain' && !isAttachment && allowText) {
    const decoded = decodeCharset(decodeBodyBytes(entity), entity.charset);
    if (collected.text === '') collected.text = decoded;
    return;
  }
  if (entity.contentType === 'text/html' && !isAttachment) {
    const decoded = decodeCharset(decodeBodyBytes(entity), entity.charset);
    if (collected.html === null) collected.html = decoded;
    return;
  }
  if (entity.contentType === 'text/plain' && isAttachment) {
    // Attachment that happens to be text/plain (e.g. a log file): store it, don't append to the body.
  }
  if (entity.contentType.startsWith('text/') && !isAttachment) {
    if (allowText && collected.text === '') {
      collected.text = decodeCharset(decodeBodyBytes(entity), entity.charset);
    }
    return;
  }
  collected.attachments.push({
    filename: entity.dispositionFilename ?? `attachment-${collected.attachments.length + 1}`,
    contentType: entity.contentType === '' ? 'application/octet-stream' : entity.contentType,
    cid: entity.headers['content-id']?.replace(/^<|>$/g, '') ?? null,
    data: decodeBodyBytes(entity),
  });
}

/** Parses one raw RFC 5322 message into normalized parts; a malformed input yields a fallback, never a throw. */
export function parseMimeMessage(raw: Buffer | string): { parsed: ParsedMimeMessage; malformed: boolean; parseError: string | null } {
  const buffer = typeof raw === 'string' ? Buffer.from(raw, 'latin1') : raw;
  try {
    const entity = parseEntity(buffer);
    if (Object.keys(entity.headers).length === 0 && buffer.length === 0) {
      return { parsed: emptyParsed(), malformed: true, parseError: 'empty message' };
    }
    const collected: CollectedParts = { text: '', html: null, attachments: [] };
    collect(entity, collected, true);
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(entity.headers)) headers[name] = decodeHeaderValue(value);
    const subject = headers['subject'] ?? '';
    const dateValue = headers['date'];
    const receivedAt = dateValue !== undefined ? new Date(dateValue) : null;
    const messageId = headers['message-id']?.replace(/^<|>$/g, '') ?? null;
    const inReplyTo = headers['in-reply-to']?.replace(/^<|>$/g, '') ?? null;
    const references = (headers['references'] ?? '')
      .split(/\s+/)
      .map((entry) => entry.replace(/^<|>$/g, ''))
      .filter((entry) => entry !== '');
    const parsed: ParsedMimeMessage = {
      from: parseSingleAddress(headers['from'] ?? '') ?? { name: null, address: 'unknown' },
      to: parseAddressList(headers['to'] ?? ''),
      cc: parseAddressList(headers['cc'] ?? ''),
      subject,
      text: collected.text,
      html: collected.html,
      receivedAt: receivedAt !== null && !Number.isNaN(receivedAt.getTime()) ? receivedAt : null,
      messageId,
      inReplyTo,
      references,
      headers,
      attachments: collected.attachments,
      messageKind: classifyMessage(headers, entity.contentType),
    };
    return { parsed, malformed: false, parseError: null };
  } catch (error: unknown) {
    return {
      parsed: emptyParsed(),
      malformed: true,
      parseError: error instanceof Error ? error.message.slice(0, 200) : 'unparseable message',
    };
  }
}

function emptyParsed(): ParsedMimeMessage {
  return {
    from: { name: null, address: 'unknown' },
    to: [],
    cc: [],
    subject: '',
    text: '',
    html: null,
    receivedAt: null,
    messageId: null,
    inReplyTo: null,
    references: [],
    headers: {},
    attachments: [],
    messageKind: 'standard',
  };
}
