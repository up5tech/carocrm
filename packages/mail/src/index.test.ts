import { describe, expect, it } from 'vitest';

import { createMailTransport, MAIL_TRANSPORT_MODES } from './index.js';

const SMTP_ENV = { SMTP_HOST: 'smtp.example.com', SMTP_FROM: 'crm@example.com' };

describe('createMailTransport', () => {
  it('selects the transport by MAIL_TRANSPORT', () => {
    expect(createMailTransport('none', {}).name).toBe('none');
    expect(createMailTransport('memory', {}).name).toBe('memory');
    expect(createMailTransport('smtp', SMTP_ENV).name).toBe('smtp');
    expect(createMailTransport('relay', SMTP_ENV).name).toBe('smtp-relay');
  });

  it('refuses an unknown mode instead of silently not sending', () => {
    expect(() => createMailTransport('gmail' as (typeof MAIL_TRANSPORT_MODES)[number], {})).toThrow(/Unknown MAIL_TRANSPORT/);
  });

  it('fails at boot when smtp is selected without a host', () => {
    expect(() => createMailTransport('smtp', {})).toThrow(/SMTP_HOST is required/);
  });

  it('carries the shared limits into the disabled transport', async () => {
    const transport = createMailTransport('none', { SMTP_FROM: 'crm@example.com', MAIL_MAX_RECIPIENTS: '1' });
    await expect(transport.send({ from: 'crm@example.com', to: ['a@example.com', 'b@example.com'], text: 'x' })).rejects.toThrow(
      /at most 1 recipients/,
    );
    await expect(transport.send({ from: 'other@example.org', to: ['a@example.com'], text: 'x' })).rejects.toThrow(/configured mail account/);
  });

  it('sends nothing over the network for the default mode', async () => {
    const transport = createMailTransport('none', {});
    expect(transport.mode).toBe('disabled');
    const result = await transport.send({ from: 'a@example.com', to: ['b@example.com'], subject: 's', text: 't' });
    expect(result.delivered).toBe(false);
  });
});
