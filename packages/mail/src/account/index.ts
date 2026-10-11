/**
 * Per-mailbox SMTP transport built from an EmailAccount row (PLAN Phase 11 "Email accounts").
 *
 * The account is the source of truth for how one mailbox sends: host, port, security mode and the
 * decrypted credentials. `createAccountSmtpTransport` turns that into the same `SmtpTransport` the
 * config-driven path uses, so every validation, limit and error classification stays in one place.
 * The password arrives already decrypted by the caller (only the API and the worker hold the key).
 */
import { ValidationError } from '@carocrm/core/errors/index.js';

import { createSmtpRelayTransport, createSmtpTransport, type SmtpSettings } from '../smtp/index.js';

export interface AccountSmtpConfig {
  emailAddress: string;
  fromName: string | null;
  smtpHost: string;
  smtpPort: number;
  /** 'starttls' (opportunistic), 'ssl' (implicit TLS) or 'none' (trusted network). */
  smtpSecurity: string;
  smtpUsername: string | null;
  /** Already decrypted; never persisted or logged by this module. */
  smtpPassword: string | null;
  signature?: string | null | undefined;
}

const MAX_RECIPIENTS_DEFAULT = 50;

/** Builds the SmtpSettings for one account; throws ValidationError for an unusable security mode. */
export function accountSmtpSettings(config: AccountSmtpConfig, maxRecipients = MAX_RECIPIENTS_DEFAULT): SmtpSettings {
  const security = config.smtpSecurity.trim().toLowerCase();
  if (security !== 'starttls' && security !== 'ssl' && security !== 'none') {
    throw new ValidationError(`Unknown SMTP security mode "${config.smtpSecurity}"; expected starttls, ssl or none.`, {
      smtpSecurity: config.smtpSecurity,
    });
  }
  const domain = config.emailAddress.split('@')[1] ?? 'localhost';
  const auth =
    config.smtpUsername !== null && config.smtpUsername !== ''
      ? { user: config.smtpUsername, password: config.smtpPassword ?? '' }
      : null;
  const settings: SmtpSettings = {
    kind: auth === null ? 'relay' : 'smtp',
    host: config.smtpHost,
    port: config.smtpPort,
    secure: security === 'ssl',
    fromAddress: config.emailAddress,
    fromName: config.fromName,
    replyToAddress: null,
    auth,
    poolSize: 2,
    maxMessagesPerConnection: 50,
    maxRecipients,
    messageIdDomain: domain,
    connectionTimeoutMs: 10_000,
    greetingTimeoutMs: 10_000,
    socketTimeoutMs: 20_000,
    // An account mailbox may legitimately send on behalf of the team; do not pin the From header.
    strictFrom: false,
    name: domain,
  };
  return settings;
}

/** SMTP transport for one EmailAccount. A credential-less account becomes a relay transport. */
export function createAccountSmtpTransport(config: AccountSmtpConfig, maxRecipients?: number) {
  const settings = accountSmtpSettings(config, maxRecipients);
  return settings.auth === null ? createSmtpRelayTransport(settings) : createSmtpTransport(settings);
}