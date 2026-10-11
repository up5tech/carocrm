import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';

import type { FileRef, FileStorage, PutFileInput, StorageDriver } from '../storage/index.js';
import { assertSafeStorageKey } from '../storage/index.js';

export interface LocalFsStorageOptions {
  /** Directory modes passed to mkdir (default 0o775). */
  dirMode?: number;
}

/**
 * {@link FileStorage} on the local filesystem under one root directory.
 *
 * Every operation resolves the key against the root and asserts the final path stays inside it —
 * defence in depth on top of key validation. There is no public read path, so signed URLs are not
 * offered and downloads keep going through the authenticated API route (PLAN §25).
 */
export class LocalFsStorage implements FileStorage {
  readonly driver: StorageDriver = 'local';
  readonly supportsSignedUrls = false;
  readonly root: string;
  private readonly dirMode: number;

  constructor(rootDir: string, options: LocalFsStorageOptions = {}) {
    if (rootDir === '') {
      throw new Error('LocalFsStorage requires a non-empty root directory.');
    }
    this.root = resolve(rootDir);
    this.dirMode = options.dirMode ?? 0o775;
  }

  /** Absolute path for a validated key, guaranteed to stay under {@link root}. */
  pathFor(key: string): string {
    const segments = assertSafeStorageKey(key);
    const target = resolve(this.root, ...segments);
    if (target !== this.root && !target.startsWith(this.root + sep)) {
      throw new Error(`Storage key escapes the root directory: "${key}"`);
    }
    return target;
  }

  async put(input: PutFileInput): Promise<FileRef> {
    const target = this.pathFor(input.key);
    await mkdir(dirname(target), { recursive: true, mode: this.dirMode });
    if (Buffer.isBuffer(input.body)) {
      await writeFile(target, input.body);
      return { key: input.key, size: input.body.byteLength, driver: this.driver };
    }
    const size = await pipeAndCount(input.body, target);
    return { key: input.key, size, driver: this.driver };
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.pathFor(key));
  }

  async openRead(key: string): Promise<Readable> {
    const path = this.pathFor(key);
    await access(path);
    return createReadStream(path);
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  async exists(key: string): Promise<boolean> {
    try {
      await access(this.pathFor(key));
      return true;
    } catch {
      return false;
    }
  }
}

async function pipeAndCount(body: Readable, target: string): Promise<number> {
  let size = 0;
  await new Promise<void>((fulfill, reject) => {
    const out = createWriteStream(target);
    body.on('data', (chunk: Buffer) => {
      size += chunk.byteLength;
    });
    body.on('error', reject);
    out.on('error', reject);
    out.on('close', fulfill);
    body.pipe(out);
  });
  return size;
}
