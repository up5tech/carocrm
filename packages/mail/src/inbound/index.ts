/**
 * Normalized inbound message pipeline (PLAN §28.2).
 *
 * §28.2 lists IMAP/POP3/Graph/Gmail as "later" — what exists now is the seam they plug into: a
 * provider-agnostic message shape and a provider port. Nothing here speaks a wire protocol; a future
 * IMAP adapter returns `InboundMailMessage[]` and the API stores them as Email records through
 * `inboundToEmailRecord`, so every provider lands in the same CRM data regardless of source.
 */
import type { MailAddress } from '../message/index.js';

/** One fetched message, normalized across providers (PLAN §28.2 "normalized inbound message pipeline"). */
export interface InboundMailMessage {
  /** Provider-stable id (IMAP UIDVALIDITY+UID, Graph id, …); used to dedupe across polls. */
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
}

export interface InboundPollOptions {
  /** Only messages newer than this; a provider without cursors filters client-side. */
  since?: Date | undefined;
  /** Ceiling per poll, so one run cannot load a whole mailbox into memory. */
  maxMessages?: number | undefined;
}

/** The port an IMAP/Graph/Gmail adapter implements later (PLAN §28.2). */
export interface InboundMailProvider {
  readonly name: string;
  /** Fetches new messages; empty array when the provider is not configured. */
  poll(options?: InboundPollOptions): Promise<InboundMailMessage[]>;
}

/** Default provider: nothing is configured, so polling is a safe no-op. */
export class NullInboundProvider implements InboundMailProvider {
  readonly name = 'none';

  async poll(): Promise<InboundMailMessage[]> {
    return [];
  }
}

/** Maps a normalized inbound message onto Email record fields (PLAN §28.3 "Email records"). */
export function inboundToEmailRecord(message: InboundMailMessage): Record<string, unknown> {
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
  };
}

function formatAddress(address: MailAddress): string {
  return address.name === null || address.name === '' ? address.address : `${address.name} <${address.address}>`;
}