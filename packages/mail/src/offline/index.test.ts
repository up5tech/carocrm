import { describe, expect, it } from 'vitest';

import { DisabledTransport, MemoryTransport } from './index.js';

const input = {
  from: 'crm@example.com',
  to: ['a@example.com'],
  bcc: ['hidden@example.com'],
  subject: 'Hi',
  text: 'body',
};

describe('DisabledTransport (MAIL_TRANSPORT=none)', () => {
  it('reports every recipient as skipped instead of pretending it sent', async () => {
    const result = await new DisabledTransport().send(input);
    expect(result.delivered).toBe(false);
    expect(result.transport).toBe('none');
    expect(result.recipients.map((entry) => entry.status)).toEqual(['skipped', 'skipped']);
    expect(result.recipients.map((entry) => entry.reason)).toEqual([
      'Mail delivery is disabled (MAIL_TRANSPORT=none).',
      'Mail delivery is disabled (MAIL_TRANSPORT=none).',
    ]);
    expect(result.messageId).toMatch(/@localhost$/);
  });

  it('still validates the message, so a bad draft fails the same way it would live', async () => {
    const transport = new DisabledTransport();
    await expect(transport.send({ ...input, to: [], bcc: [] })).rejects.toThrow(/at least one recipient/);
    await expect(transport.send({ ...input, to: ['not-an-address'] })).rejects.toThrow(/Invalid email address/);
  });

  it('applies the configured recipient ceiling and From account', async () => {
    const transport = new DisabledTransport({ maxRecipients: 1, strictFrom: 'crm@example.com' });
    await expect(transport.send({ ...input, bcc: [], to: ['a@example.com', 'b@example.com'] })).rejects.toThrow(/at most 1 recipients/);
    await expect(transport.send({ ...input, bcc: [], from: 'mallory@example.com' })).rejects.toThrow(/configured mail account/);
  });

  it('has nothing to verify', async () => {
    await expect(new DisabledTransport().verify()).resolves.toBeUndefined();
  });
});

describe('MemoryTransport', () => {
  it('keeps the normalized messages in send order', async () => {
    const transport = new MemoryTransport();
    await transport.send(input);
    await transport.send({ ...input, subject: 'Second' });
    expect(transport.messages).toHaveLength(2);
    expect(transport.messages[0]?.to[0]?.address).toBe('a@example.com');
    expect(transport.messages[1]?.subject).toBe('Second');
    expect(transport.messages[0]?.messageId).not.toBe(transport.messages[1]?.messageId);
    expect(transport.messages[0]?.bcc).toEqual([{ name: null, address: 'hidden@example.com' }]);
    expect(transport.messages[0]?.to).toEqual([{ name: null, address: 'a@example.com' }]);
    expect(transport.name).toBe('memory');
    expect(transport.mode).toBe('disabled');

    transport.reset();
    expect(transport.messages).toHaveLength(0);
  });
});
