import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { LocalFsStorage } from '../local/index.js';
import { assertSafeStorageKey, checksum, createHashingCounter, isSafeStorageKey } from "./index.js";

async function storage(): Promise<LocalFsStorage> {
  return new LocalFsStorage(await mkdtemp(join(tmpdir(), 'carocrm-files-')));
}

describe('storage keys', () => {
  it('accepts nested relative keys', () => {
    expect(assertSafeStorageKey('Account/abc-123/report.pdf')).toEqual(['Account', 'abc-123', 'report.pdf']);
    expect(isSafeStorageKey('uploads/x/part-0')).toBe(true);
  });

  it('rejects traversal, absolute paths and odd separators', () => {
    for (const key of ['../escape', 'a/../../b', '/root', 'a\\b', '', 'a//b', 'a/./b', 'a/$(id).txt']) {
      expect(isSafeStorageKey(key), key).toBe(false);
    }
  });
});

describe('LocalFsStorage', () => {
  it('stores buffers and reports the size', async () => {
    const store = await storage();
    const ref = await store.put({ key: 'a/b.txt', body: Buffer.from('hello'), contentType: 'text/plain' });
    expect(ref).toEqual({ key: 'a/b.txt', size: 5, driver: 'local' });
    expect((await store.get('a/b.txt')).toString()).toBe('hello');
    expect(await store.exists('a/b.txt')).toBe(true);
    expect(checksum(Buffer.from('hello'))).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });

  it('streams a body to disk without buffering it', async () => {
    const store = await storage();
    const body = Readable.from([Buffer.alloc(1024, 'x'), Buffer.alloc(1024, 'y')]);
    const ref = await store.put({ key: 'big.bin', body });
    expect(ref.size).toBe(2_048);
    const read = await store.openRead('big.bin');
    const chunks: Buffer[] = [];
    for await (const chunk of read) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).byteLength).toBe(2_048);
  });

  it('deletes and refuses keys outside the root', async () => {
    const store = await storage();
    await store.put({ key: 'gone.txt', body: Buffer.from('x') });
    await store.delete('gone.txt');
    expect(await store.exists('gone.txt')).toBe(false);
    await expect(store.get('../outside.txt')).rejects.toThrow(/Invalid storage key/);
    await expect(store.openRead('missing.txt')).rejects.toThrow();
  });

  it('never escapes the root even when the key looks valid', async () => {
    const store = await storage();
    const escaped = join(store.root, '..', 'victim.bin');
    await writeFile(escaped, 'keep me');
    await expect(store.put({ key: 'ok.bin', body: Buffer.from('fine') })).resolves.toBeTruthy();
    expect((await readFile(escaped)).toString()).toBe('keep me');
  });

  it('surfaces a download failure as a rejection instead of an empty file', async () => {
    const store = await storage();
    await expect(store.get('never-written.bin')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(store.openRead('never-written.bin')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('surfaces an upload failure when the destination cannot be created (22.18)', async () => {
    const store = await storage();
    // The parent of the key is a regular file, so the storage layer cannot create the directory it
    // needs. This is the local-driver equivalent of an object-store write failing mid-upload.
    await writeFile(join(store.root, 'blocked'), 'not a directory');
    await expect(store.put({ key: 'blocked/file.bin', body: Buffer.from('x') })).rejects.toThrow(/EEXIST|ENOTDIR/);
    expect(await store.exists('blocked/file.bin')).toBe(false);
  });
});

describe('upload hashing helper', () => {
  it('counts and hashes chunks as they stream', () => {
    const counter = createHashingCounter();
    counter.transform(Buffer.from('ab'));
    counter.transform(Buffer.from('cd'));
    expect(counter.size).toBe(4);
    expect(counter.digest()).toBe(checksum(Buffer.from('abcd')));
  });
});
