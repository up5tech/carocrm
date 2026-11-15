/**
 * Normalized inbound message pipeline (PLAN §28.2, Phase 24.6).
 *
 * §28.2 lists IMAP/POP3/Graph/Gmail as "later" — what exists now is the seam they plug into: a
 * provider-agnostic message shape and a provider port. Phase 24.6 fills two of those slots —
 * IMAP (`./imap.js`) and Microsoft Graph (`./graph.js`) — plus a filesystem fixture provider
 * (`./fixture.js`) that parses checked-in `.eml` files so ingestion is testable without a real
 * mailbox. `NullInboundProvider` remains the explicit unconfigured default: polling it fails
 * with {@link InboundMailError} instead of pretending success.
 *
 * Idempotency rule (Phase 24.6 task 3): a provider-stable id is meaningless on its own — the
 * same UID exists in two mailboxes. Callers always dedupe by the pair
 * `(connectionId, providerMessageId)` via {@link inboundDedupeKey}, never by provider id alone.
 */
import type { MailAddress } from '../message/index.js';
import { FixtureInboundProvider, parseFixtureSettings } from './fixture.js';
import { GraphInboundProvider, parseGraphSettings } from './graph.js';
import { ImapInboundProvider, parseImapSettings } from './imap.js';

/** Classification of an inbound message for suppression decisions. */
export type InboundMessageKind = 'standard' | 'bounce' | 'auto-reply';

/** One attachment carried by an inbound message, normalized from the raw MIME part. */
export interface InboundMailAttachment {
  /** Original filename, or `attachment-<n>` when the part has none. */
  filename: string;
  contentType: string;
  /** Content id for inline parts (`cid:` in the HTML body). */
  cid: string | null;
  /** Decoded bytes; the API stores them through the attachment ACL/malware path. */
  data: Buffer;
}

/** One fetched message, normalized across providers (PLAN §28.2 "normalized inbound message pipeline"). */
export interface InboundMailMessage {
  /** Provider-stable id (IMAP UIDVALIDITY+UID, Graph id, fixture content hash, …); used to dedupe across polls. */
  providerMessageId: string;
  /** Conversation key, when the provider exposes one; falls back to `inReplyTo`. */
  threadId: string | null;
  from: MailAddress;
  to: MailAddress[];
  cc: MailAddress[];
  subject: string;
  text: string;
  html: string | null;
  /** RFC 5322 Date or the provider's receive time; the record's `dateReceived`. */
  receivedAt: Date;
  inReplyTo: string | null;
  headers: Record<string, string>;
  /** Attachments decoded from the MIME parts (added Phase 24.6). */
  attachments?: readonly InboundMailAttachment[] | undefined;
  /** `bounce`/`auto-reply` classification; absent means `standard`. */
  messageKind?: InboundMessageKind | undefined;
  /** True when the raw message could not be parsed and this is a best-effort fallback. */
  isMalformed?: boolean | undefined;
  /** Present only when `isMalformed` is true: why parsing failed, without stack traces. */
  parseError?: string | null | undefined;
}

export interface InboundPollOptions {
  /** Only messages newer than this; a provider without cursors filters client-side. */
  since?: Date | undefined;
  /** Ceiling per poll, so one run cannot load a whole mailbox into memory. */
  maxMessages?: number | undefined;
  /**
   * Opaque per-connection cursor persisted by the caller (see
   * {@link InboundMailProvider.nextCursor}). Each provider encodes its own state here (IMAP
   * UIDINVALIDITY+last UID, Graph deltaLink/watermark, fixture file watermark).
   */
  cursor?: string | null | undefined;
}

/** The port an IMAP/Graph/Gmail adapter implements (PLAN §28.2, Phase 24.6). */
export interface InboundMailProvider {
  readonly name: string;
  /** Stable identity of the mailbox/connection this provider polls (mailbox-specific cursor + dedupe). */
  readonly connectionId?: string | undefined;
  /** False for the explicit unconfigured default; callers must fail clearly instead of polling. */
  readonly configured?: boolean | undefined;
  /** Fetches new messages; empty array when there is nothing new. */
  poll(options?: InboundPollOptions): Promise<InboundMailMessage[]>;
  /** The cursor to persist after a successful poll, when the provider tracks one. */
  nextCursor?(): string | null;
}

/** A failure from an inbound provider: stable `code`, operator-readable message, no stack/stack-adjacent data. */
export class InboundMailError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'InboundMailError';
    this.code = code;
  }
}

/**
 * Totally-scoped dedupe key. A provider-local id (`12345`) collides across mailboxes, so the
 * connection/mailbox that produced it is always part of the key (Phase 24.6 task 3).
 */
export function inboundDedupeKey(connectionId: string, providerMessageId: string): string {
  return `${connectionId}:${providerMessageId}`;
}

/** Default provider: nothing is configured, so polling fails clearly rather than silently succeeding. */
export class NullInboundProvider implements InboundMailProvider {
  readonly name = 'none';
  readonly configured = false;
  readonly connectionId = 'none';

  async poll(): Promise<InboundMailMessage[]> {
    throw new InboundMailError(
      'not_configured',
      'No inbound mail provider is configured. Set MAIL_INBOUND_PROVIDER to "imap", "graph" or "fixture" (or add a Mail Inbound Connection) before polling.',
    );
  }

  nextCursor(): string | null {
    return null;
  }
}

/** `MAIL_INBOUND_PROVIDER` values (Phase 24.6). `none` is the default: an unconfigured install fails clearly. */
export const MAIL_INBOUND_PROVIDER_MODES = ['none', 'imap', 'graph', 'fixture'] as const;
export type MailInboundProviderMode = (typeof MAIL_INBOUND_PROVIDER_MODES)[number];

/**
 * Builds the configured inbound provider from `MAIL_INBOUND_PROVIDER` plus the `IMAP_*` /
 * `GRAPH_*` / `MAIL_INBOUND_FIXTURE_DIR` settings. Settings are parsed eagerly, so a bad
 * configuration fails at boot instead of on the first poll — the same rule as outbound SMTP.
 * Credentials in env are the operator's secret store; database-configured connections use the
 * encrypted credential vault instead (see `EmailService.pollInbound`).
 */
export function createInboundProvider(
  mode: MailInboundProviderMode,
  raw: Record<string, string | undefined>,
  options: { connectionId?: string | undefined } = {},
): InboundMailProvider {
  switch (mode) {
    case 'none':
      return new NullInboundProvider();
    case 'imap':
      return new ImapInboundProvider(parseImapSettings(raw), options);
    case 'graph':
      return new GraphInboundProvider(parseGraphSettings(raw), options);
    case 'fixture':
      return new FixtureInboundProvider(parseFixtureSettings(raw), options);
    default:
      throw new InboundMailError(
        'invalid_config',
        `Unknown MAIL_INBOUND_PROVIDER "${String(mode)}"; expected one of ${MAIL_INBOUND_PROVIDER_MODES.join(', ')}.`,
      );
  }
}

/** Maps a normalized inbound message onto Email record fields (PLAN §28.3 "Email records"). */
export function inboundToEmailRecord(
  message: InboundMailMessage,
  options: { connectionId?: string | undefined; emailAccountId?: string | undefined } = {},
): Record<string, unknown> {
  const connectionId = options.connectionId ?? 'none';
  const kindWord = message.messageKind === 'bounce' ? 'Bounce' : message.messageKind === 'auto-reply' ? 'AutoReply' : 'Standard';
  return {
    name: message.subject === '' ? '(no subject)' : message.subject,
    status: 'Inbound',
    direction: 'Inbound',
    fromAddress: formatAddress(message.from),
    toAddressList: message.to.map(formatAddress).join(', '),
    ccAddressList: message.cc.map(formatAddress).join(', '),
    body: message.text,
    ...(message.html === null ? {} : { bodyHtml: message.html }),
    headers: JSON.stringify(message.headers),
    messageId: message.providerMessageId,
    threadId: message.threadId ?? message.providerMessageId,
    ...(message.inReplyTo === null ? {} : { inReplyTo: message.inReplyTo }),
    dateSent: message.receivedAt.toISOString(),
    inboundConnectionId: connectionId,
    ...(options.emailAccountId === undefined ? {} : { emailAccountId: options.emailAccountId }),
    messageKind: kindWord,
    ...(message.isMalformed === true ? { inboundParsed: false, inboundError: message.parseError ?? 'malformed message' } : {}),
  };
}

function formatAddress(address: MailAddress): string {
  return address.name === null || address.name === '' ? address.address : `${address.name} <${address.address}>`;
}
