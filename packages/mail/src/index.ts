/**
 * `@carocrm/mail` — the email platform service (PLAN §28).
 *
 * Two layers live here: the message model (`MailMessage`, normalization) and the transports behind
 * the `MailTransport` port. Nothing in this package knows about Nest, the database or HTTP: the API
 * and the worker each build a transport from their own configuration through `createMailTransport`.
 *
 * Inbound (PLAN §28.2) is a normalized pipeline plus the `InboundMailProvider` port; IMAP/Graph/Gmail
 * adapters are "later" per §28.2 and plug into that port without changes here.
 */
import { ValidationError } from '@carocrm/core/errors/index.js';

import type { MailTransport } from './message/index.js';
import { DisabledTransport, MemoryTransport, type OfflineTransportOptions } from './offline/index.js';
import { createSmtpRelayTransport, createSmtpTransport, parseSmtpRelaySettings, parseSmtpSettings, type SmtpSettings } from './smtp/index.js';

export {
  type AccountSmtpConfig,
  accountSmtpSettings,
  createAccountSmtpTransport,
} from './account/index.js';
export {
  type InboundMailMessage,
  type InboundMailProvider,
  type InboundPollOptions,
  inboundToEmailRecord,
  NullInboundProvider,
} from './inbound/index.js';
export type {
  MailAddress,
  MailAttachment,
  MailMessage,
  MailMessageInput,
  MailTransport,
  MailTransportInfo,
  NormalizeOptions,
  RecipientResult,
  SendResult,
} from './message/index.js';
export {
  bareMessageId,
  buildMessageId,
  formatAddressList,
  normalizeMailMessage,
  parseAddress,
  splitAddressList,
} from './message/index.js';
export { DisabledTransport, MemoryTransport, type OfflineTransportOptions } from './offline/index.js';
export {
  type EmailRecordLike,
  emailRecordToMessageInput,
  parseStoredHeaders,
  recordFromAddress,
  requiredField,
  sentRecordPatch,
  stringField,
} from './record/index.js';
export {
  classifySmtpError,
  createSmtpRelayTransport,
  createSmtpSender,
  createSmtpTransport,
  parseSmtpRelaySettings,
  parseSmtpSettings,
  type SmtpMailOptions,
  type SmtpSender,
  type SmtpSendInfo,
  type SmtpSettings,
  SmtpTransport,
} from './smtp/index.js';
export { renderTemplate, renderTemplateParts,type TemplateVariables } from './template/index.js';

/** `MAIL_TRANSPORT` values. `none` is the default so an unconfigured install cannot send mail. */
export const MAIL_TRANSPORT_MODES = ['none', 'memory', 'smtp', 'relay'] as const;
export type MailTransportMode = (typeof MAIL_TRANSPORT_MODES)[number];

function offlineOptions(raw: Record<string, string | undefined>, settings?: SmtpSettings): OfflineTransportOptions {
  const from = (settings?.fromAddress ?? (raw['SMTP_FROM'] ?? '')).trim();
  const domain = settings?.messageIdDomain ?? from.split('@')[1] ?? 'localhost';
  return {
    maxRecipients: settings?.maxRecipients ?? Number(raw['MAIL_MAX_RECIPIENTS'] ?? 50),
    messageIdDomain: domain,
    // Same anti-spoofing rule as SMTP: the From address must be the configured account.
    strictFrom: from === '' ? undefined : from,
  };
}

/**
 * Build the configured transport. SMTP settings are parsed eagerly, so a wrong `MAIL_TRANSPORT=smtp`
 * without a host fails at boot instead of on the first message.
 */
export function createMailTransport(mode: MailTransportMode, raw: Record<string, string | undefined>): MailTransport {
  switch (mode) {
    case 'smtp':
      return createSmtpTransport(parseSmtpSettings(raw));
    case 'relay':
      return createSmtpRelayTransport(parseSmtpRelaySettings(raw));
    case 'memory':
      return new MemoryTransport(offlineOptions(raw));
    case 'none':
      return new DisabledTransport(offlineOptions(raw));
    default:
      throw new ValidationError(`Unknown MAIL_TRANSPORT "${String(mode)}"; expected one of ${MAIL_TRANSPORT_MODES.join(', ')}.`);
  }
}
