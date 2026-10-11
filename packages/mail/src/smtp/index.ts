/**
 * SMTP transports (PLAN §28.1: "SMTP" and "Generic SMTP relay").
 *
 * Both are the same protocol, so one class implements them and the settings say which: a plain SMTP
 * submission mailbox authenticates, a generic relay on a trusted network must not carry credentials.
 * nodemailer is reached through the `SmtpSender` port so tests and smoke runs never open a socket.
 */
import { ValidationError } from '@carocrm/core/errors/index.js';
import { createTransport, type Transporter } from 'nodemailer';

import {
  bareMessageId,
  type MailMessage,
  type MailMessageInput,
  type MailTransport,
  type MailTransportInfo,
  normalizeMailMessage,
  type NormalizeOptions,
  type RecipientResult,
  type SendResult,
} from '../message/index.js';

export interface SmtpSettings {
  /** 'smtp' authenticates; 'relay' trusts the network and must not send credentials. */
  kind: 'smtp' | 'relay';
  host: string;
  port: number;
  /** TLS for the whole connection (implicit TLS). StartTLS is used whenever the server offers it. */
  secure: boolean;
  fromAddress: string;
  fromName: string | null;
  replyToAddress: string | null;
  auth: { user: string; password: string } | null;
  poolSize: number;
  maxMessagesPerConnection: number;
  maxRecipients: number;
  messageIdDomain: string;
  connectionTimeoutMs: number;
  greetingTimeoutMs: number;
  socketTimeoutMs: number;
  /** Rejects a message whose From address is not the configured mailbox (anti-spoofing). */
  strictFrom: boolean;
  /** Presented HELO name; empty lets nodemailer derive it. */
  name: string;
}

export interface SmtpMailOptions {
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  replyTo?: string;
  subject: string;
  text?: string;
  html?: string;
  headers: Record<string, string>;
  messageId: string;
  inReplyTo?: string;
  references?: string[];
  attachments: { filename: string; content: Buffer; contentType: string; cid?: string }[];
}

export interface SmtpSendInfo {
  messageId?: string | null;
  accepted?: (string | { address?: string })[] | null;
  rejected?: (string | { address?: string; rejectionReason?: string })[] | null;
  response?: string | null;
}

/** The nodemailer surface we actually use; a test can pass a fake instead. */
export interface SmtpSender {
  sendMail(options: SmtpMailOptions): Promise<SmtpSendInfo>;
  verify(): Promise<unknown>;
}

const DEFAULT_PORT = 587;
const TRANSIENT_CODES: ReadonlySet<string> = new Set([
  'EAUTH',
  'ESOCKET',
  'ECONNCLOSED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EMFY',
  'EGEN',
  'EINIT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'ESMTPTEMPFAIL',
  'ETOOCONN',
  'ECONNAUTH',
]);

function text(value: string | undefined, fallback = ''): string {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? fallback : trimmed;
}

function port(value: string | undefined): number {
  const raw = text(value);
  if (raw === '') return DEFAULT_PORT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`SMTP_PORT must be a port number, got "${raw}".`);
  }
  return parsed;
}

/** "" means "derive", anything else must parse as a boolean (see config.parseBooleanSetting). */
function flag(value: string | undefined, fallback: boolean): boolean {
  const raw = text(value);
  if (raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function positiveInt(value: string | undefined, fallback: number, ceiling: number, label: string): number {
  const raw = text(value);
  if (raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > ceiling) {
    throw new Error(`${label} must be an integer between 1 and ${String(ceiling)}, got "${raw}".`);
  }
  return parsed;
}

/**
 * Read SMTP settings from environment-style strings. Called at boot, so a broken configuration is a
 * startup error rather than a failure on the first send.
 */
export function parseSmtpSettings(raw: Record<string, string | undefined>): SmtpSettings {
  const host = text(raw['SMTP_HOST']);
  if (host === '') throw new Error('SMTP_HOST is required when a mail transport is enabled.');
  const configuredPort = port(raw['SMTP_PORT']);
  const user = text(raw['SMTP_USER']);
  const password = text(raw['SMTP_PASSWORD']);
  if ((user === '') !== (password === '')) {
    throw new Error('SMTP_USER and SMTP_PASSWORD must be provided together.');
  }
  const fromAddress = text(raw['SMTP_FROM'], user);
  if (fromAddress === '') throw new Error('SMTP_FROM (or SMTP_USER as the sending mailbox) is required.');
  const fromParts = fromAddress.split('@');
  const domain = text(raw['SMTP_MESSAGE_DOMAIN'], fromParts[1] ?? 'localhost');

  return {
    kind: 'smtp',
    host,
    port: configuredPort,
    // 465 is implicit TLS; everything else upgrades with STARTTLS unless forced.
    secure: flag(raw['SMTP_SECURE'], configuredPort === 465),
    fromAddress,
    fromName: text(raw['SMTP_FROM_NAME']) === '' ? null : text(raw['SMTP_FROM_NAME']),
    replyToAddress: text(raw['SMTP_REPLY_TO']) === '' ? null : text(raw['SMTP_REPLY_TO']),
    auth: user === '' ? null : { user, password },
    poolSize: positiveInt(raw['SMTP_POOL_SIZE'], 2, 20, 'SMTP_POOL_SIZE'),
    maxMessagesPerConnection: positiveInt(raw['SMTP_MAX_MESSAGES'], 10, 1000, 'SMTP_MAX_MESSAGES'),
    maxRecipients: positiveInt(raw['MAIL_MAX_RECIPIENTS'], 50, 500, 'MAIL_MAX_RECIPIENTS'),
    messageIdDomain: domain,
    connectionTimeoutMs: positiveInt(raw['SMTP_CONNECTION_TIMEOUT_MS'], 20_000, 300_000, 'SMTP_CONNECTION_TIMEOUT_MS'),
    greetingTimeoutMs: positiveInt(raw['SMTP_GREETING_TIMEOUT_MS'], 20_000, 300_000, 'SMTP_GREETING_TIMEOUT_MS'),
    socketTimeoutMs: positiveInt(raw['SMTP_SOCKET_TIMEOUT_MS'], 60_000, 600_000, 'SMTP_SOCKET_TIMEOUT_MS'),
    strictFrom: flag(raw['SMTP_STRICT_FROM'], true),
    name: text(raw['SMTP_NAME']),
  };
}

/** A generic relay trusts the network: credentials here mean the deployment is misconfigured. */
export function parseSmtpRelaySettings(raw: Record<string, string | undefined>): SmtpSettings {
  const settings = parseSmtpSettings(raw);
  if (settings.auth !== null) {
    throw new Error('MAIL_TRANSPORT=relay must not carry SMTP_USER/SMTP_PASSWORD; use MAIL_TRANSPORT=smtp for an authenticated submission mailbox.');
  }
  return { ...settings, kind: 'relay' };
}

/** Builds the real nodemailer connection pool. */
export function createSmtpSender(settings: SmtpSettings): SmtpSender {
  const options: Record<string, unknown> = {
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    requireTLS: !settings.secure,
    pool: true,
    poolSize: settings.poolSize,
    maxMessages: settings.maxMessagesPerConnection,
    connectionTimeout: settings.connectionTimeoutMs,
    greetingTimeout: settings.greetingTimeoutMs,
    socketTimeout: settings.socketTimeoutMs,
    tls: { minVersion: 'TLSv1.2' },
  };
  if (settings.name !== '') options['name'] = settings.name;
  if (settings.auth !== null) options['auth'] = { user: settings.auth.user, pass: settings.auth.password };
  const transporter: Transporter = createTransport(options);
  return {
    async sendMail(mail: SmtpMailOptions): Promise<SmtpSendInfo> {
      return (await transporter.sendMail(mail)) as unknown as SmtpSendInfo;
    },
    async verify(): Promise<unknown> {
      return transporter.verify();
    },
  };
}

/**
 * 4xx / connection failures are worth another attempt; 5xx and an all-rejected envelope are permanent,
 * so the job consumer can retry the first and fail the second instead of burning every attempt.
 */
export function classifySmtpError(error: unknown): 'transient' | 'permanent' {
  const value = error as { code?: string; responseCode?: number; rejectionErrors?: unknown[] };
  const code = value.code ?? '';
  if (code === 'EENVELOPE') return 'permanent';
  const responseCode = Number(value.responseCode ?? 0);
  if (responseCode >= 500 && responseCode < 600) return 'permanent';
  if (responseCode >= 400 && responseCode < 500) return 'transient';
  return TRANSIENT_CODES.has(code) ? 'transient' : 'permanent';
}

function addressOf(value: string | { address?: string }): string {
  return typeof value === 'string' ? value : value.address ?? '';
}

function reasonOf(value: string | { address?: string; rejectionReason?: string }): string {
  if (typeof value === 'string') return 'Rejected by the server.';
  return value.rejectionReason ?? 'Rejected by the server.';
}

export class SmtpTransport implements MailTransport {
  readonly name: string;
  readonly mode = 'live';
  readonly settings: SmtpSettings;

  private readonly sender: SmtpSender;

  constructor(settings: SmtpSettings, sender?: SmtpSender) {
    this.settings = settings;
    this.name = settings.kind === 'relay' ? 'smtp-relay' : 'smtp';
    this.sender = sender ?? createSmtpSender(settings);
  }

  get fromAddress(): string {
    return this.settings.fromAddress;
  }

  get info(): MailTransportInfo {
    return {
      name: this.name,
      mode: this.mode,
      fromAddress: this.settings.fromAddress,
      maxRecipients: this.settings.maxRecipients,
      strictFrom: this.settings.strictFrom,
      holdsMessages: false,
    };
  }

  /** Normalize with this transport's own limits so callers cannot widen them per message. */
  prepare(input: MailMessageInput): MailMessage {
    const options: NormalizeOptions = {
      maxRecipients: this.settings.maxRecipients,
      messageIdDomain: this.settings.messageIdDomain,
    };
    const message = normalizeMailMessage(input, options);
    if (this.settings.strictFrom && message.from.address.toLowerCase() !== this.settings.fromAddress.toLowerCase()) {
      throw new ValidationError(`The From address must be the configured mail account: "${this.settings.fromAddress}".`, {
        from: message.from.address,
      });
    }
    return message;
  }

  async send(input: MailMessageInput): Promise<SendResult> {
    const message = this.prepare(input);
    const info = await this.sender.sendMail(this.toMailOptions(message));
    const messageId = bareMessageId(info.messageId ?? message.messageId);
    const accepted = new Set((info.accepted ?? []).map((entry) => addressOf(entry).toLowerCase()));
    const rejected = (info.rejected ?? []).map((entry) => ({ address: addressOf(entry), reason: reasonOf(entry) }));
    const rejectedAddresses = new Set(rejected.map((entry) => entry.address.toLowerCase()));

    const recipients: RecipientResult[] = [...message.to, ...message.cc, ...message.bcc].map((entry) => {
      const key = entry.address.toLowerCase();
      if (rejectedAddresses.has(key)) {
        const match = rejected.find((entry2) => entry2.address.toLowerCase() === key);
        return { address: entry.address, status: 'rejected', reason: match?.reason ?? 'Rejected by the server.' };
      }
      // A provider that reports nothing per recipient still told us the message was accepted.
      return {
        address: entry.address,
        status: accepted.size === 0 && rejected.length === 0 ? 'accepted' : accepted.has(key) ? 'accepted' : 'rejected',
        reason: accepted.size === 0 && rejected.length === 0 ? null : accepted.has(key) ? null : 'The provider did not accept this recipient.',
      };
    });

    return {
      transport: this.name,
      delivered: true,
      messageId,
      recipients,
      response: info.response === undefined || info.response === '' ? null : String(info.response).trim(),
    };
  }

  async verify(): Promise<void> {
    await this.sender.verify();
  }

  private toMailOptions(message: MailMessage): SmtpMailOptions {
    const headers: Record<string, string> = { ...message.headers };
    return {
      from: formatFrom(message),
      to: message.to.map((entry) => entry.address),
      cc: message.cc.map((entry) => entry.address),
      bcc: message.bcc.map((entry) => entry.address),
      ...(message.replyTo === null ? {} : { replyTo: message.replyTo.address }),
      subject: message.subject,
      ...(message.text === '' ? {} : { text: message.text }),
      ...(message.html === '' ? {} : { html: message.html }),
      headers,
      messageId: `<${message.messageId}>`,
      ...(message.inReplyTo === null ? {} : { inReplyTo: `<${message.inReplyTo}>` }),
      ...(message.references.length === 0 ? {} : { references: message.references.map((value) => `<${value}>`) }),
      attachments: message.attachments.map((attachment) => ({
        filename: attachment.filename,
        content: attachment.content,
        contentType: attachment.contentType,
        ...(attachment.cid === undefined ? {} : { cid: attachment.cid }),
      })),
    };
  }
}

function formatFrom(message: MailMessage): string {
  const { name, address } = message.from;
  return name === null || name === '' ? address : `${name.replace(/["\\]/g, '')} <${address}>`;
}

/** Plain SMTP submission over an authenticating mailbox. */
export function createSmtpTransport(settings: SmtpSettings, sender?: SmtpSender): SmtpTransport {
  return new SmtpTransport({ ...settings, kind: 'smtp' }, sender);
}

/** Generic SMTP relay: same protocol, no credentials, network-allowlist trust. */
export function createSmtpRelayTransport(settings: SmtpSettings, sender?: SmtpSender): SmtpTransport {
  return new SmtpTransport({ ...settings, kind: 'relay', auth: null }, sender);
}
