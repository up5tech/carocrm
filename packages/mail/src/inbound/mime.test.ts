import { describe, expect, it } from 'vitest';

import { classifyMessage, decodeHeaderValue, parseAddressList, parseMimeMessage } from './mime.js';

const SIMPLE = Buffer.from(
  [
    'From: Sender One <sender@example.com>',
    'To: bob@example.com, carol@example.com',
    'Cc: Dan <dan@example.com>',
    'Subject: Hello =?UTF-8?B?V29ybGQ=?=',
    `Message-ID: <m1@example.com>`,
    'Date: Mon, 10 Nov 2026 08:00:00 +0000',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Plain body text.',
  ].join('\r\n'),
);

describe('mime parser', () => {
  it('parses headers, addresses and encoded-word subjects', () => {
    const { parsed, malformed } = parseMimeMessage(SIMPLE);
    expect(malformed).toBe(false);
    expect(parsed.from).toEqual({ name: 'Sender One', address: 'sender@example.com' });
    expect(parsed.to).toEqual([
      { name: null, address: 'bob@example.com' },
      { name: null, address: 'carol@example.com' },
    ]);
    expect(parsed.cc).toEqual([{ name: 'Dan', address: 'dan@example.com' }]);
    expect(parsed.subject).toBe('Hello World');
    expect(parsed.text).toContain('Plain body text.');
    expect(parsed.messageId).toBe('m1@example.com');
    expect(parsed.receivedAt?.getTime()).toBe(new Date('Mon, 10 Nov 2026 08:00:00 +0000').getTime());
    expect(parsed.attachments).toEqual([]);
    expect(parsed.messageKind).toBe('standard');
  });

  it('parses multipart alternative with an html part and an attachment', () => {
    const boundary = 'BOUND';
    const raw = Buffer.from(
      [
        'From: sender@example.com',
        'To: bob@example.com',
        'Subject: Multipart',
        'Message-ID: <multipart@example.com>',
        'Content-Type: multipart/mixed; boundary="BOUND"',
        '',
        '--BOUND',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'Text part.',
        '--BOUND',
        'Content-Type: application/pdf; name="report.pdf"',
        'Content-Disposition: attachment; filename="report.pdf"',
        'Content-Transfer-Encoding: base64',
        '',
        Buffer.from('PDFBYTES', 'utf8').toString('base64'),
        '--BOUND--',
        '',
      ].join('\r\n'),
    );
    void boundary;
    const { parsed } = parseMimeMessage(raw);
    expect(parsed.text).toContain('Text part.');
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0]?.filename).toBe('report.pdf');
    expect(parsed.attachments[0]?.data.toString('utf8')).toBe('PDFBYTES');
  });

  it('parses multipart alternative html without polluting the text part', () => {
    const raw = Buffer.from(
      [
        'From: a@example.com',
        'To: b@example.com',
        'Subject: alt',
        'Message-ID: <alt@example.com>',
        'Content-Type: multipart/alternative; boundary="ALT"',
        '',
        '--ALT',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'Plain',
        '--ALT',
        'Content-Type: text/html; charset=utf-8',
        '',
        '<p>Html</p>',
        '--ALT--',
        '',
      ].join('\r\n'),
    );
    const { parsed } = parseMimeMessage(raw);
    expect(parsed.text).toBe('Plain');
    expect(parsed.html).toBe('<p>Html</p>');
    expect(parsed.attachments).toEqual([]);
  });

  it('classifies bounces and auto-replies', () => {
    expect(classifyMessage({ from: 'MAILER-DAEMON@mx.example', 'content-type': 'text/plain' }, 'text/plain')).toBe('bounce');
    expect(classifyMessage({ 'auto-submitted': 'auto-replied' }, 'text/plain')).toBe('auto-reply');
    expect(classifyMessage({ 'x-auto-response-suppress': 'All' }, 'text/plain')).toBe('auto-reply');
    expect(classifyMessage({ from: 'sender@example.com' }, 'multipart/report')).toBe('bounce');
    expect(classifyMessage({ from: 'sender@example.com' }, 'text/plain')).toBe('standard');
  });

  it('never throws on garbage input; it yields a malformed fallback', () => {
    const { parsed, malformed } = parseMimeMessage(Buffer.alloc(0));
    expect(malformed).toBe(true);
    expect(parsed.from.address).toBe('unknown');
  });

  it('decodes quoted-printable bodies', () => {
    const raw = Buffer.from(
      [
        'From: a@example.com',
        'To: b@example.com',
        'Subject: qp',
        'Message-ID: <qp@example.com>',
        'Content-Type: text/plain; charset=utf-8',
        'Content-Transfer-Encoding: quoted-printable',
        '',
        'Caf=C3=A9 and =41=42',
      ].join('\r\n'),
    );
    const { parsed } = parseMimeMessage(raw);
    expect(parsed.text).toContain('Café');
    expect(parsed.text).toContain('AB');
  });

  it('unfolds continuation headers and keeps references', () => {
    const raw = Buffer.from(
      [
        'From: a@example.com',
        'To: b@example.com',
        'Subject: folded',
        '  subject continues',
        'Message-ID: <fold@example.com>',
        'References: <a@example.com> <b@example.com>',
        'In-Reply-To: <b@example.com>',
        '',
        'Body',
      ].join('\r\n'),
    );
    const { parsed } = parseMimeMessage(raw);
    expect(parsed.subject).toBe('folded subject continues');
    expect(parsed.references).toEqual(['a@example.com', 'b@example.com']);
    expect(parsed.inReplyTo).toBe('b@example.com');
  });
});

describe('mime helpers', () => {
  it('decodes address lists with quoted names', () => {
    expect(parseAddressList('"Doe, Jane" <jane@example.com>, bob@example.com')).toEqual([
      { name: 'Doe, Jane', address: 'jane@example.com' },
      { name: null, address: 'bob@example.com' },
    ]);
  });

  it('decodes encoded-word display names', () => {
    expect(decodeHeaderValue('=?UTF-8?Q?Jos=C3=A9?= <jose@example.com>')).toContain('José');
  });
});
