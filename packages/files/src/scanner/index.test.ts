import { describe, expect, it } from 'vitest';

import { CompositeScanner, EICAR_SIGNATURE, type MalwareScanner, NoopScanner, type ScanInput,SignatureScanner, SNIFF_BYTES } from './index.js';

function input(overrides: Partial<ScanInput>): ScanInput {
  return { key: 'Account/1/file', name: 'file.bin', mimeType: 'application/octet-stream', head: Buffer.alloc(0), size: 0, ...overrides };
}

describe('SignatureScanner', () => {
  const scanner = new SignatureScanner();

  it('flags the EICAR test signature', async () => {
    const head = Buffer.concat([Buffer.from('prefix'), Buffer.from(EICAR_SIGNATURE)]);
    const result = await scanner.scan(input({ head, name: 'report.pdf', mimeType: 'application/pdf' }));
    expect(result.clean).toBe(false);
    expect(result.reason).toContain('EICAR');
  });

  it('flags an executable smuggled under a benign type', async () => {
    const pe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64, 0)]);
    expect((await scanner.scan(input({ head: pe, name: 'invoice.docx', mimeType: 'image/png' }))).clean).toBe(false);

    const elf = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(64)]);
    expect((await scanner.scan(input({ head: elf, mimeType: 'text/plain' }))).reason).toContain('ELF');

    const shebang = Buffer.from('#!/bin/sh\nrm -rf /\n');
    expect((await scanner.scan(input({ head: shebang, mimeType: 'text/plain' }))).clean).toBe(false);
  });

  it('allows genuine containers and real images', async () => {
    const zip = Buffer.concat([Buffer.from('PK\u0003\u0004'), Buffer.alloc(32)]);
    expect((await scanner.scan(input({ head: zip, mimeType: 'application/zip' }))).clean).toBe(true);
    expect((await scanner.scan(input({ head: zip, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }))).clean).toBe(true);

    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
    expect((await scanner.scan(input({ head: png, mimeType: 'image/png' }))).clean).toBe(true);

    const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(32)]);
    expect((await scanner.scan(input({ head: pdf, mimeType: 'application/pdf' }))).clean).toBe(true);
  });

  it('flags text files with binary content and images that are not images', async () => {
    expect((await scanner.scan(input({ head: Buffer.from('abc\u0000def'), mimeType: 'text/csv' }))).reason).toContain('NUL');
    const notAnImage = Buffer.concat([Buffer.from('%PDF-1.7'), Buffer.alloc(16)]);
    expect((await scanner.scan(input({ head: notAnImage, mimeType: 'image/jpeg' }))).reason).toContain('not an image');
  });

  it('only inspects the head it is given', () => {
    expect(SNIFF_BYTES).toBeGreaterThan(128);
  });
});

describe('CompositeScanner', () => {
  it('stops at the first rejection and fails closed on a broken scanner', async () => {
    const ok: MalwareScanner = { name: 'ok', scan: async () => ({ clean: true, provider: 'ok' }) };
    const bad: MalwareScanner = { name: 'bad', scan: async () => ({ clean: false, provider: 'bad', reason: 'hit' }) };
    const broken: MalwareScanner = {
      name: 'broken',
      scan: async () => {
        throw new Error('daemon offline');
      },
    };

    expect((await new CompositeScanner([ok, bad]).scan(input({}))).reason).toBe('hit');
    const failed = await new CompositeScanner([ok, broken]).scan(input({}));
    expect(failed.clean).toBe(false);
    expect(failed.reason).toContain('daemon offline');
    expect((await new CompositeScanner([ok]).scan(input({}))).clean).toBe(true);
    expect((await new NoopScanner().scan(input({}))).clean).toBe(true);
  });
});
