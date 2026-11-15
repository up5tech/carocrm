/**
 * Filesystem fixture inbound provider (Phase 24.6).
 *
 * Reads `*.eml` files from `MAIL_INBOUND_FIXTURE_DIR` (sorted, deterministic) and parses each
 * one with the shared MIME parser. It exists so a configured installation can prove end-to-end
 * ingestion in CI — "a configured adapter ingests a fixture mailbox exactly once" — without a
 * real mailbox ever being contacted. The provider-stable id is a content hash, so a re-poll of
 * the same files dedupes exactly, and a rename does not duplicate a message.
 *
 * A missing directory fails with `not_configured`-style clarity (`provider_error`): pointing
 * at a fixture dir that does not exist is a deployment mistake, not an empty mailbox.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { InboundMailError, type InboundMailMessage, type InboundMailProvider, type InboundPollOptions } from './index.js';
import { parseMimeMessage } from './mime.js';

export interface FixtureSettings {
  directory: string;
}

export function parseFixtureSettings(raw: Record<string, string | undefined>): FixtureSettings {
  const directory = (raw['MAIL_INBOUND_FIXTURE_DIR'] ?? '').trim();
  if (directory === '') {
    throw new InboundMailError('invalid_config', 'MAIL_INBOUND_FIXTURE_DIR is required when MAIL_INBOUND_PROVIDER=fixture.');
  }
  return { directory };
}

export class FixtureInboundProvider implements InboundMailProvider {
  readonly name = 'fixture';
  readonly configured = true;
  readonly connectionId: string;
  private cursorOut: string | null = null;

  constructor(
    private readonly settings: FixtureSettings,
    options: { connectionId?: string | undefined; seedMessages?: InboundMailMessage[] | undefined } = {},
  ) {
    this.connectionId = options.connectionId ?? `fixture:${settings.directory}`;
    this.seedMessages = options.seedMessages;
  }

  private seedMessages: InboundMailMessage[] | undefined;

  nextCursor(): string | null {
    return this.cursorOut;
  }

  async poll(options: InboundPollOptions = {}): Promise<InboundMailMessage[]> {
    const maxMessages = Math.max(1, Math.min(options.maxMessages ?? 50, 500));
    const raw = this.seedMessages === undefined ? await this.readFiles() : this.seedMessages;
    const sorted = [...raw].sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime() || a.providerMessageId.localeCompare(b.providerMessageId));
    const sliced = sorted.slice(0, maxMessages);
    const last = sliced[sliced.length - 1];
    if (last !== undefined) this.cursorOut = last.receivedAt.toISOString();
    return sliced;
  }

  private async readFiles(): Promise<InboundMailMessage[]> {
    let names: string[];
    try {
      names = await readdir(this.settings.directory);
    } catch {
      throw new InboundMailError('provider_error', `Inbound fixture directory "${this.settings.directory}" could not be read.`);
    }
    const files = names.filter((name) => name.toLowerCase().endsWith('.eml')).sort();
    const messages: InboundMailMessage[] = [];
    for (const file of files) {
      const bytes = await readFile(join(this.settings.directory, file));
      messages.push(normalizeFixture(file, bytes));
    }
    return messages;
  }
}

function normalizeFixture(fileName: string, bytes: Buffer): InboundMailMessage {
  const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  const providerMessageId = `fixture:${fileName}:${digest}`;
  const { parsed, malformed, parseError } = parseMimeMessage(bytes);
  const unidentifiable = parsed.messageId === null || parsed.from.address === 'unknown';
  const reason = parseError ?? (parsed.messageId === null ? 'missing Message-Id' : 'missing From address');
  if (malformed || unidentifiable) {
    // A parse failure (or a message without an identity) still produces one ingested record,
    // clearly flagged, rather than failing the whole batch (Phase 24.6 partial-batch rule).
    return {
      providerMessageId,
      threadId: parsed.messageId,
      from: parsed.from,
      to: parsed.to,
      cc: parsed.cc,
      subject: parsed.subject === '' ? '(no subject)' : parsed.subject,
      text: parsed.text === '' ? `(message could not be parsed: ${reason.slice(0, 200)})` : parsed.text,
      html: parsed.html,
      receivedAt: parsed.receivedAt ?? new Date(),
      inReplyTo: parsed.inReplyTo,
      headers: parsed.headers,
      attachments: parsed.attachments,
      messageKind: parsed.messageKind,
      isMalformed: true,
      parseError: reason,
    };
  }
  return {
    providerMessageId,
    threadId: parsed.messageId ?? parsed.references[parsed.references.length - 1] ?? null,
    from: parsed.from,
    to: parsed.to,
    cc: parsed.cc,
    subject: parsed.subject === '' ? '(no subject)' : parsed.subject,
    text: parsed.text,
    html: parsed.html,
    receivedAt: parsed.receivedAt ?? new Date(),
    inReplyTo: parsed.inReplyTo,
    headers: parsed.headers,
    attachments: parsed.attachments,
    messageKind: parsed.messageKind,
  };
}
