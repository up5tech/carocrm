import { describe, expect, it } from 'vitest';

import {
  classifySmtpError,
  createSmtpRelayTransport,
  createSmtpTransport,
  parseSmtpRelaySettings,
  parseSmtpSettings,
  type SmtpMailOptions,
  type SmtpSender,
  type SmtpSendInfo,
  SmtpTransport,
} from './index.js';

const BASE_ENV: Record<string, string | undefined> = {
  SMTP_HOST: 'smtp.example.com',
  SMTP_USER: 'crm@example.com',
  SMTP_PASSWORD: 'secret',
  SMTP_FROM_NAME: 'CaroCRM',
};

class FakeSender implements SmtpSender {
  sent: SmtpMailOptions[] = [];
  info: SmtpSendInfo = { messageId: '<provider-1@example.com>', accepted: ['a@example.com'], rejected: [], response: '250 OK' };

  async sendMail(options: SmtpMailOptions): Promise<SmtpSendInfo> {
    this.sent.push(options);
    return this.info;
  }

  verified = 0;

  async verify(): Promise<unknown> {
    this.verified += 1;
    return true;
  }
}

function settings(overrides: Record<string, string | undefined> = {}) {
  return parseSmtpSettings({ ...BASE_ENV, ...overrides });
}

const messageInput = {
  from: 'CaroCRM <crm@example.com>',
  to: ['a@example.com', 'b@example.com'],
  cc: ['c@example.com'],
  subject: 'Status',
  text: 'plain',
  html: '<p>rich</p>',
};

describe('parseSmtpSettings', () => {
  it('defaults to port 587 with STARTTLS and an implicit-TLS 465', () => {
    const plain = settings();
    expect(plain.port).toBe(587);
    expect(plain.secure).toBe(false);
    expect(settings({ SMTP_PORT: '465' }).secure).toBe(true);
    expect(settings({ SMTP_PORT: '465', SMTP_SECURE: 'false' }).secure).toBe(false);
  });

  it('falls back to the authenticated user as the sending mailbox', () => {
    expect(settings().fromAddress).toBe('crm@example.com');
    expect(settings({ SMTP_FROM: 'noreply@example.com' }).fromAddress).toBe('noreply@example.com');
    expect(settings().messageIdDomain).toBe('example.com');
    expect(settings({ SMTP_MESSAGE_DOMAIN: 'mail.example.com' }).messageIdDomain).toBe('mail.example.com');
  });

  it('refuses a half-configured credential pair', () => {
    expect(() => settings({ SMTP_PASSWORD: undefined })).toThrow(/provided together/);
    expect(() => settings({ SMTP_USER: undefined, SMTP_PASSWORD: undefined })).toThrow(/SMTP_FROM/);
  });

  it('needs a host before anything else', () => {
    expect(() => parseSmtpSettings({})).toThrow(/SMTP_HOST is required/);
  });

  it('rejects junk ports and out-of-range limits at boot', () => {
    for (const port of ['0', '70000', 'not-a-port']) {
      expect(() => settings({ SMTP_PORT: port })).toThrow(/SMTP_PORT/);
    }
    expect(() => settings({ MAIL_MAX_RECIPIENTS: '0' })).toThrow(/MAIL_MAX_RECIPIENTS/);
    expect(() => settings({ SMTP_POOL_SIZE: '99' })).toThrow(/SMTP_POOL_SIZE/);
  });

  it('keeps a pool with sane timeouts and no plaintext fallback', () => {
    const value = settings({ SMTP_POOL_SIZE: '5', SMTP_CONNECTION_TIMEOUT_MS: '5000' });
    expect(value.poolSize).toBe(5);
    expect(value.connectionTimeoutMs).toBe(5_000);
    expect(value.auth).toEqual({ user: 'crm@example.com', password: 'secret' });
    expect(value.strictFrom).toBe(true);
    expect(settings({ SMTP_STRICT_FROM: 'false' }).strictFrom).toBe(false);
  });

  it('treats a relay as a credential-free configuration', () => {
    const relay = { SMTP_HOST: 'relay.internal', SMTP_FROM: 'crm@example.com' };
    expect(parseSmtpRelaySettings(relay).kind).toBe('relay');
    expect(() => parseSmtpRelaySettings({ ...relay, SMTP_USER: 'x', SMTP_PASSWORD: 'y' })).toThrow(/MAIL_TRANSPORT=relay/);
    expect(() => parseSmtpRelaySettings({ ...relay, SMTP_USER: 'x' })).toThrow(/provided together/);
  });
});

describe('SmtpTransport.send', () => {
  it('maps a normalized message onto the nodemailer options', async () => {
    const sender = new FakeSender();
    const transport = new SmtpTransport(settings(), sender);
    const message = transport.prepare(messageInput);
    const result = await transport.send(message);

    const mail = sender.sent[0] as SmtpMailOptions;
    expect(mail.from).toBe('CaroCRM <crm@example.com>');
    expect(mail.to).toEqual(['a@example.com', 'b@example.com']);
    expect(mail.cc).toEqual(['c@example.com']);
    expect(mail.bcc).toEqual([]);
    expect(mail.subject).toBe('Status');
    expect(mail.text).toBe('plain');
    expect(mail.html).toBe('<p>rich</p>');
    expect(mail.messageId).toBe(`<${message.messageId}>`);
    expect(result.transport).toBe('smtp');
    expect(result.delivered).toBe(true);
    expect(result.response).toBe('250 OK');
  });

  it('starts TLS only when the settings say so, and keeps reply headers', async () => {
    const sender = new FakeSender();
    const transport = createSmtpTransport(settings(), sender);
    const reply = transport.prepare({
      ...messageInput,
      inReplyTo: '<root@other.example>',
      references: ['<root@other.example>'],
      headers: { 'X-Campaign': 'spring' },
      replyTo: 'bounce@example.com',
    });
    await transport.send(reply);

    const mail = sender.sent[0] as SmtpMailOptions;
    expect(mail.inReplyTo).toBe('<root@other.example>');
    expect(mail.references).toEqual(['<root@other.example>']);
    expect(mail.headers).toEqual({ 'X-Campaign': 'spring' });
    expect(mail.replyTo).toBe('bounce@example.com');
  });

  it('carries attachment content through', async () => {
    const sender = new FakeSender();
    const transport = new SmtpTransport(settings(), sender);
    const prepared = transport.prepare({
      ...messageInput,
      attachments: [{ filename: 'quote.pdf', contentType: 'application/pdf', content: Buffer.from('data'), cid: 'q1' }],
    });
    await transport.send(prepared);
    const mail = sender.sent[0] as SmtpMailOptions;
    expect(mail.attachments[0]?.filename).toBe('quote.pdf');
    expect(mail.attachments[0]?.cid).toBe('q1');
    expect(mail.attachments[0]?.content.toString()).toBe('data');
  });

  it('reports the provider id when it differs from ours', async () => {
    const sender = new FakeSender();
    sender.info = { messageId: '<provider-1@example.com>', accepted: ['a@example.com', 'b@example.com', 'c@example.com'], rejected: [] };
    const transport = new SmtpTransport(settings(), sender);
    const result = await transport.send(transport.prepare(messageInput));
    expect(result.messageId).toBe('provider-1@example.com');
    expect(result.recipients.every((entry) => entry.status === 'accepted')).toBe(true);
  });

  it('marks only the recipients the server rejected', async () => {
    const sender = new FakeSender();
    sender.info = {
      messageId: null,
      accepted: ['a@example.com'],
      rejected: [{ address: 'b@example.com', rejectionReason: '550 no such user' }],
      response: '250 partly accepted',
    };
    const transport = new SmtpTransport(settings(), sender);
    const result = await transport.send(transport.prepare(messageInput));

    const byAddress = new Map(result.recipients.map((entry) => [entry.address, entry]));
    expect(byAddress.get('a@example.com')?.status).toBe('accepted');
    expect(byAddress.get('b@example.com')).toMatchObject({ status: 'rejected', reason: '550 no such user' });
    expect(byAddress.get('c@example.com')?.status).toBe('rejected');
    expect(byAddress.get('c@example.com')?.reason).toMatch(/did not accept/);
    // The thread stays ours when the provider gives no id back.
    expect(result.messageId).toMatch(/@example\.com$/);
  });

  it('trusts a provider that reports nothing per recipient', async () => {
    const sender = new FakeSender();
    sender.info = { messageId: '<x@example.com>', accepted: [], rejected: [] };
    const transport = new SmtpTransport(settings(), sender);
    const result = await transport.send(transport.prepare(messageInput));
    expect(result.recipients.map((entry) => entry.status)).toEqual(['accepted', 'accepted', 'accepted']);
  });

  it('refuses a From address that is not the configured account', () => {
    const transport = new SmtpTransport(settings(), new FakeSender());
    expect(() => transport.prepare({ ...messageInput, from: 'someone@example.org' })).toThrow(/must be the configured mail account/);
    // Same account, different display name: still ours.
    expect(transport.prepare({ ...messageInput, from: '"Other Name" <CRM@example.com>' }).from.address).toBe('crm@example.com');
  });

  it('applies the recipient ceiling of the settings', () => {
    const transport = new SmtpTransport(settings({ MAIL_MAX_RECIPIENTS: '2' }), new FakeSender());
    expect(() => transport.prepare(messageInput)).toThrow(/at most 2 recipients/);
  });

  it('can relax the From rule for a relay that rewrites the sender', () => {
    const transport = createSmtpRelayTransport(
      parseSmtpRelaySettings({ SMTP_HOST: 'relay.internal', SMTP_FROM: 'crm@example.com', SMTP_STRICT_FROM: 'false' }),
      new FakeSender(),
    );
    expect(transport.name).toBe('smtp-relay');
    expect(() => transport.prepare({ ...messageInput, from: 'anyone@example.org' })).not.toThrow();
    // Left at the default, a relay is just as strict about its mailbox as SMTP submission.
    const strict = createSmtpRelayTransport(parseSmtpRelaySettings({ SMTP_HOST: 'relay.internal', SMTP_FROM: 'crm@example.com' }), new FakeSender());
    expect(() => strict.prepare({ ...messageInput, from: 'anyone@example.org' })).toThrow(/configured mail account/);
  });

  it('exposes verify for the admin settings check', async () => {
    const sender = new FakeSender();
    const transport = new SmtpTransport(settings(), sender);
    await transport.verify();
    expect(sender.verified).toBe(1);
  });
});

describe('classifySmtpError', () => {
  it('treats connection and 4xx problems as retryable', () => {
    expect(classifySmtpError({ code: 'ESOCKET' })).toBe('transient');
    expect(classifySmtpError({ code: 'EAUTH' })).toBe('transient');
    expect(classifySmtpError({ responseCode: 421 })).toBe('transient');
    expect(classifySmtpError({ responseCode: 450 })).toBe('transient');
  });

  it('treats 5xx and a fully rejected envelope as permanent', () => {
    expect(classifySmtpError({ responseCode: 550 })).toBe('permanent');
    expect(classifySmtpError({ code: 'EENVELOPE' })).toBe('permanent');
    expect(classifySmtpError(new Error('whatever'))).toBe('permanent');
  });

  it('reads the numeric code off a real nodemailer error object', () => {
    const error = Object.assign(new Error('550 user unknown'), { responseCode: '550' });
    expect(classifySmtpError(error)).toBe('permanent');
  });
});
