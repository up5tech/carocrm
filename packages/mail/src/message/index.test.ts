import { describe, expect, it } from 'vitest';

import {
  bareMessageId,
  buildMessageId,
  formatAddressList,
  type MailMessageInput,
  normalizeMailMessage,
  type NormalizeOptions,
  parseAddress,
  splitAddressList,
} from './index.js';

const options: NormalizeOptions = { maxRecipients: 5, messageIdDomain: 'crm.example' };

function base(overrides: Partial<MailMessageInput> = {}): MailMessageInput {
  return {
    from: 'Sales <sales@crm.example>',
    to: ['alice@example.com'],
    subject: 'Hello',
    text: 'Body text',
    ...overrides,
  };
}

describe('address parsing', () => {
  it('reads a display name and lowercases the address', () => {
    expect(parseAddress('Alice Example <Alice@Example.COM>')).toEqual({ name: 'Alice Example', address: 'alice@example.com' });
  });

  it('accepts a bare address', () => {
    expect(parseAddress('bob@example.org').name).toBeNull();
  });

  it('splits on commas that sit outside the angle brackets', () => {
    const list = splitAddressList('"Doe, John" <j@example.com>, ann@example.com');
    expect(list).toHaveLength(2);
    expect(list[0]).toContain('Doe, John');
  });

  it('refuses an empty token', () => {
    expect(() => parseAddress('   ')).toThrow(/email address is required/);
  });

  it('refuses anything that is not an address', () => {
    for (const value of ['no-at-sign', 'a b@example.com', 'user@', '@domain.com', 'user@domain']) {
      expect(() => parseAddress(value)).toThrow(/Invalid email address/);
    }
  });

  it('caps the length before touching the regex', () => {
    expect(() => parseAddress(`${'a'.repeat(320)}@example.com`)).toThrow(/longer than/);
  });

  it('formats a list back into header text', () => {
    const message = normalizeMailMessage(base({ to: ['"Doe, John" <j@example.com>', 'ann@example.com'] }), options);
    expect(formatAddressList(message.to)).toBe('"Doe, John" <j@example.com>, ann@example.com');
  });
});

describe('normalizeMailMessage', () => {
  it('dedupes recipients across the lists, case-insensitively', () => {
    const message = normalizeMailMessage(
      base({ to: ['a@example.com', 'A@example.com'], cc: ['a@example.com', 'b@example.com'] }),
      options,
    );
    expect(message.to.map((entry) => entry.address)).toEqual(['a@example.com']);
    expect(message.cc.map((entry) => entry.address)).toEqual(['b@example.com']);
  });

  it('splits a comma-separated string just like an array', () => {
    const message = normalizeMailMessage(base({ to: 'a@example.com, b@example.com' }), options);
    expect(message.to).toHaveLength(2);
  });

  it('requires at least one recipient', () => {
    expect(() => normalizeMailMessage(base({ to: undefined }), options)).toThrow(/at least one recipient/);
    expect(() => normalizeMailMessage(base({ to: [], cc: [], bcc: [] }), options)).toThrow(/at least one recipient/);
  });

  it('counts every list against the recipient ceiling', () => {
    const many = ['1@e.com', '2@e.com', '3@e.com', '4@e.com', '5@e.com'];
    expect(() => normalizeMailMessage(base({ to: many, cc: ['6@e.com'] }), options)).toThrow(/at most 5 recipients/);
  });

  it('requires a body in one of the two forms', () => {
    expect(() => normalizeMailMessage(base({ text: '', html: '' }), options)).toThrow(/needs a body/);
    expect(normalizeMailMessage(base({ text: '', html: '<p>hi</p>' }), options).html).toBe('<p>hi</p>');
  });

  it('drops control characters from the subject and truncates it', () => {
    expect(() => normalizeMailMessage(base({ subject: 'a\r\nb' }), options)).toThrow(/control character/);
    expect(normalizeMailMessage(base({ subject: 'x'.repeat(1200) }), options).subject).toHaveLength(998);
  });

  it('generates a Message-Id and keeps the thread rooted on replies', () => {
    const fresh = normalizeMailMessage(base(), options);
    expect(bareMessageId(fresh.messageId)).toBe(fresh.messageId);
    expect(fresh.messageId).toMatch(/^[^@]+@crm\.example$/);
    expect(fresh.threadId).toBe(fresh.messageId);

    const reply = normalizeMailMessage(base({ inReplyTo: '<root@other.example>', references: ['<root@other.example>'] }), options);
    expect(reply.inReplyTo).toBe('root@other.example');
    expect(reply.threadId).toBe('root@other.example');
    expect(reply.references).toEqual(['root@other.example']);
  });

  it('re-normalizing an already normalized message is stable', () => {
    const once = normalizeMailMessage(base(), options);
    const twice = normalizeMailMessage(once, options);
    expect(twice.messageId).toBe(once.messageId);
    expect(twice.threadId).toBe(once.threadId);
    expect(twice.to).toEqual(once.to);
  });

  it('builds a safe Message-Id from a rough local part', () => {
    expect(buildMessageId('crm.example', 'ab/../cd ef')).toBe('<ab..cdef@crm.example>');
    expect(buildMessageId('', '')).toBe('<mail@localhost>');
  });

  describe('headers', () => {
    it('passes an allowed header through', () => {
      const message = normalizeMailMessage(base({ headers: { 'X-Campaign': 'spring' } }), options);
      expect(message.headers['X-Campaign']).toBe('spring');
    });

    it('refuses headers the transport owns', () => {
      for (const key of ['From', 'to', 'Subject', 'Content-Type', 'Message-Id', 'Received']) {
        expect(() => normalizeMailMessage(base({ headers: { [key]: 'x' } }), options)).toThrow(/set by the mail message/);
      }
    });

    it('refuses SMTP header injection through a value', () => {
      expect(() => normalizeMailMessage(base({ headers: { 'X-Note': 'a\r\nBcc: spam@e.com' } }), options)).toThrow(/line break/);
    });

    it('refuses a weird name or a non-string value', () => {
      expect(() => normalizeMailMessage(base({ headers: { 'X Bad': 'x' } }), options)).toThrow(/Invalid email header name/);
      expect(() => normalizeMailMessage(base({ headers: { 'X-Nested': { a: 1 } } }), options)).toThrow(/must be a string/);
    });
  });

  describe('attachments', () => {
    const file = { filename: 'report.pdf', contentType: 'application/pdf', content: Buffer.from('x') };

    it('keeps only the basename', () => {
      const message = normalizeMailMessage(base({ attachments: [{ ...file, filename: '/etc/passwd' }] }), options);
      expect(message.attachments[0]?.filename).toBe('passwd');
    });

    it('rejects an empty or control-character name', () => {
      expect(() => normalizeMailMessage(base({ attachments: [{ ...file, filename: '  ' }] }), options)).toThrow(/needs a filename/);
      expect(() => normalizeMailMessage(base({ attachments: [{ ...file, contentType: 'a\r\nb' }] }), options)).toThrow(
        /invalid name or content type/,
      );
    });

    it('keeps a cid only when it was supplied', () => {
      const message = normalizeMailMessage(base({ attachments: [{ ...file, cid: 'logo' }] }), options);
      expect(message.attachments[0]?.cid).toBe('logo');
      expect('cid' in (normalizeMailMessage(base({ attachments: [file] }), options).attachments[0] ?? {})).toBe(false);
    });
  });
});
