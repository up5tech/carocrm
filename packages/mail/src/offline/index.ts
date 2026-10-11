/**
 * Transports that never touch the network (PLAN §28 safety, AGENTS.md §3.3: a test must not send
 * real mail).
 *
 * `MAIL_TRANSPORT=none` is the default in every environment, so an installation that has not
 * deliberately configured SMTP cannot mail by accident; the delivery rows say `skipped` instead of
 * pretending the message went out. `MemoryTransport` is the same contract with the messages kept,
 * which is what the API tests and the smoke scripts assert against.
 */
import { ValidationError } from '@carocrm/core/errors/index.js';

import {
  type MailMessage,
  type MailMessageInput,
  type MailTransport,
  type MailTransportInfo,
  normalizeMailMessage,
  type NormalizeOptions,
  type RecipientResult,
  type SendResult,
} from '../message/index.js';

export interface OfflineTransportOptions {
  maxRecipients?: number | undefined;
  messageIdDomain?: string | undefined;
  /** Rejects a From address outside this mailbox, exactly like the SMTP transport. */
  strictFrom?: string | undefined;
}

function optionsFor(options: OfflineTransportOptions): NormalizeOptions {
  return {
    maxRecipients: options.maxRecipients ?? 50,
    messageIdDomain: options.messageIdDomain ?? 'localhost',
  };
}

function skipped(message: MailMessage, transport: string, response: string | null): SendResult {
  const recipients: RecipientResult[] = [...message.to, ...message.cc, ...message.bcc].map((entry) => ({
    address: entry.address,
    status: 'skipped',
    reason: response,
  }));
  return { transport, delivered: false, messageId: message.messageId, recipients, response };
}

function checkFrom(message: MailMessage, strictFrom: string | undefined): void {
  if (strictFrom === undefined || strictFrom === '') return;
  if (message.from.address.toLowerCase() !== strictFrom.toLowerCase()) {
    throw new ValidationError(`The From address must be the configured mail account: "${strictFrom}".`, {
      from: message.from.address,
    });
  }
}

export class DisabledTransport implements MailTransport {
  readonly name = 'none';
  readonly mode = 'disabled';

  constructor(private readonly options: OfflineTransportOptions = {}) {}

  get info(): MailTransportInfo {
    return {
      name: this.name,
      mode: this.mode,
      fromAddress: this.options.strictFrom ?? null,
      maxRecipients: this.options.maxRecipients ?? 50,
      strictFrom: this.options.strictFrom !== undefined,
      holdsMessages: false,
    };
  }

  prepare(input: MailMessageInput): MailMessage {
    const message = normalizeMailMessage(input, optionsFor(this.options));
    checkFrom(message, this.options.strictFrom);
    return message;
  }

  /** Normalized and validated, then dropped: an invalid message still fails exactly as it would live. */
  async send(input: MailMessageInput): Promise<SendResult> {
    return skipped(this.prepare(input), this.name, 'Mail delivery is disabled (MAIL_TRANSPORT=none).');
  }

  async verify(): Promise<void> {
    // Nothing to prove: a disabled transport has no server to reach.
  }
}

export class MemoryTransport implements MailTransport {
  readonly name = 'memory';
  readonly mode = 'disabled';
  readonly sent: MailMessage[] = [];

  constructor(private readonly options: OfflineTransportOptions = {}) {}

  get messages(): readonly MailMessage[] {
    return this.sent;
  }

  get info(): MailTransportInfo {
    return {
      name: this.name,
      mode: this.mode,
      fromAddress: this.options.strictFrom ?? null,
      maxRecipients: this.options.maxRecipients ?? 50,
      strictFrom: this.options.strictFrom !== undefined,
      holdsMessages: true,
    };
  }

  prepare(input: MailMessageInput): MailMessage {
    const message = normalizeMailMessage(input, optionsFor(this.options));
    checkFrom(message, this.options.strictFrom);
    return message;
  }

  async send(input: MailMessageInput): Promise<SendResult> {
    const message = this.prepare(input);
    this.sent.push(message);
    return skipped(message, this.name, `held in memory (#${String(this.sent.length)})`);
  }

  async verify(): Promise<void> {
    // as `DisabledTransport`: there is no server behind this transport
  }

  reset(): void {
    this.sent.length = 0;
  }
}
