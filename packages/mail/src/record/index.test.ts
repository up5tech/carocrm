import { describe, expect, it } from 'vitest';

import { emailRecordToMessageInput, parseStoredHeaders, recordFromAddress, sentRecordPatch, stringField } from './index.js';

function record(data: Record<string, unknown>, id = 'email-1') {
  return { id, data };
}

describe('stringField', () => {
  it('treats blank and missing as null and coerces scalars', () => {
    expect(stringField(record({ a: null }), 'a')).toBeNull();
    expect(stringField(record({ a: '' }), 'a')).toBeNull();
    expect(stringField(record({}), 'a')).toBeNull();
    expect(stringField(record({ a: 42 }), 'a')).toBe('42');
    expect(stringField(record({ a: true }), 'a')).toBe('true');
  });

  it('refuses a structured value instead of stringifying an object', () => {
    expect(() => stringField(record({ a: { b: 1 } }), 'a')).toThrow(/must be text/);
    expect(() => stringField(record({ a: ['x'] }), 'a')).toThrow(/must be text/);
  });
});

describe('parseStoredHeaders', () => {
  it('accepts a JSON object and a scalar map', () => {
    expect(parseStoredHeaders(null, 'e')).toEqual({});
    expect(parseStoredHeaders('', 'e')).toEqual({});
    expect(parseStoredHeaders('{"X-Campaign":"spring"}', 'e')).toEqual({ 'X-Campaign': 'spring' });
    expect(parseStoredHeaders('{"X-N":5,"X-B":true}', 'e')).toEqual({ 'X-N': '5', 'X-B': 'true' });
  });

  it('accepts plain header lines', () => {
    expect(parseStoredHeaders('X-Campaign: spring\r\nList-Unsubscribe: <https://e.example/u>', 'e')).toEqual({
      'X-Campaign': 'spring',
      'List-Unsubscribe': '<https://e.example/u>',
    });
  });

  it('rejects malformed JSON, non-objects, nested values and nameless lines', () => {
    expect(() => parseStoredHeaders('{"broken":', 'e')).toThrow(/not valid JSON/);
    expect(() => parseStoredHeaders('[1,2]', 'e')).toThrow(/must be a JSON object/);
    expect(() => parseStoredHeaders('{"X-Deep":{"a":1}}', 'e')).toThrow(/single value/);
    expect(() => parseStoredHeaders('no colon here', 'e')).toThrow(/malformed header line/);
  });
});

describe('recordFromAddress', () => {
  it('prefers the record and falls back to the account', () => {
    expect(recordFromAddress(record({ fromAddress: 'me@example.com' }), 'acct@example.com')).toBe('me@example.com');
    expect(recordFromAddress(record({}), 'acct@example.com')).toBe('acct@example.com');
    expect(recordFromAddress(record({}), { name: 'Acct', address: 'acct@example.com' })).toBe('acct@example.com');
    expect(() => recordFromAddress(record({}), null)).toThrow(/no "fromAddress"/);
  });
});

describe('emailRecordToMessageInput', () => {
  const full = record({
    name: 'Quarterly report',
    fromAddress: 'Sales <sales@example.com>',
    toAddressList: 'a@example.com, b@example.com',
    ccAddressList: 'c@example.com',
    bccAddressList: null,
    replyToAddress: 'bounce@example.com',
    body: 'text part',
    bodyHtml: '<p>html part</p>',
    headers: '{"X-Campaign":"spring"}',
    messageId: '<stored@example.com>',
    threadId: 'root@example.com',
    inReplyTo: '<root@example.com>',
  });

  it('maps every envelope field of PLAN §28.3', () => {
    const input = emailRecordToMessageInput(full);
    expect(input.from).toBe('Sales <sales@example.com>');
    expect(input.to).toBe('a@example.com, b@example.com');
    expect(input.cc).toBe('c@example.com');
    expect(input.bcc).toBeNull();
    expect(input.subject).toBe('Quarterly report');
    expect(input.text).toBe('text part');
    expect(input.html).toBe('<p>html part</p>');
    expect(input.headers).toEqual({ 'X-Campaign': 'spring' });
    expect(input.messageId).toBe('<stored@example.com>');
    expect(input.inReplyTo).toBe('<root@example.com>');
  });

  it('attaches what the caller resolved from storage', () => {
    const file = { filename: 'report.pdf', contentType: 'application/pdf', content: Buffer.from('x') };
    const input = emailRecordToMessageInput(record({ fromAddress: 'a@example.com', toAddressList: 'b@example.com', body: 'x' }), {
      attachments: [file],
    });
    expect(input.attachments).toEqual([file]);
  });

  it('produces a message the normalizer accepts end to end', async () => {
    const { normalizeMailMessage } = await import('../message/index.js');
    const message = normalizeMailMessage(emailRecordToMessageInput(full), { maxRecipients: 10, messageIdDomain: 'example.com' });
    expect(message.to.map((entry) => entry.address)).toEqual(['a@example.com', 'b@example.com']);
    expect(message.messageId).toBe('stored@example.com');
    expect(message.threadId).toBe('root@example.com');
  });
});

describe('sentRecordPatch', () => {
  it('writes back the display names and ids the transport used', () => {
    const address = (value: string, name: string | null = null) => ({ name, address: value });
    const patch = sentRecordPatch({
      messageId: 'm@example.com',
      threadId: 't@example.com',
      from: address('sales@example.com', 'Sales Desk'),
      to: [address('a@example.com'), address('b@example.com', 'Bee')],
      cc: [],
      bcc: [address('secret@example.com')],
    });
    expect(patch.messageId).toBe('m@example.com');
    expect(patch.fromAddress).toBe('Sales Desk <sales@example.com>');
    expect(patch.toAddressList).toBe('a@example.com, Bee <b@example.com>');
    expect(patch.ccAddressList).toBe('');
    expect(patch.bccAddressList).toBe('secret@example.com');
  });
});
