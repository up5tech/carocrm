/**
 * @carocrm/files — storage abstraction for attachments (CRM Kernel Alpha).
 *
 * Only the local filesystem implementation is active in Alpha. The S3
 * dependencies in package.json are intentionally unused here; an S3-backed
 * FileStorage implementation can be added later behind FILE_STORAGE_TOKEN
 * without touching the attachment module.
 */
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';

/** Anything callers may hand to {@link FileStorage.put}. */
export type StorageBody = Buffer | Readable;

/**
 * Minimal key/value blob storage contract.
 * Keys are POSIX-style relative paths whose segments are restricted to
 * {@link STORAGE_KEY_SEGMENT_PATTERN}; implementations MUST reject traversal
 * attempts (`..`, absolute paths, stray separators).
 */
export interface FileStorage {
  put(key: string, body: StorageBody): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

/** Allowed characters for a single storage key segment. */
export const STORAGE_KEY_SEGMENT_PATTERN = /^[A-Za-z0-9_.-]+$/;

/**
 * Validate a storage key and return its segments.
 * Throws on absolute paths, empty segments, segments outside
 * {@link STORAGE_KEY_SEGMENT_PATTERN} and any `..` traversal.
 */
export function assertSafeStorageKey(key: string): string[] {
  if (key === '' || key.startsWith('/') || key.includes('\\')) {
    throw new Error(`Invalid storage key: "${key}"`);
  }
  const segments = key.split('/');
  for (const segment of segments) {
    if (!STORAGE_KEY_SEGMENT_PATTERN.test(segment) || segment.includes('..')) {
      throw new Error(`Invalid storage key segment in "${key}"`);
    }
  }
  return segments;
}

/** sha256 hex digest of a buffer. */
export function checksum(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** sha256 hex digest of a readable stream (consumes the stream). */
export async function checksumStream(stream: Readable): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

export interface LocalFsStorageOptions {
  /** Directory modes passed to mkdir (default 0o775). */
  dirMode?: number;
}

/**
 * {@link FileStorage} backed by the local filesystem under a single root dir.
 * Every operation resolves the key against the root and asserts the final
 * path stays inside it (defence in depth on top of key validation).
 */
export class LocalFsStorage implements FileStorage {
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

  async put(key: string, body: StorageBody): Promise<void> {
    const target = this.pathFor(key);
    await mkdir(dirname(target), { recursive: true, mode: this.dirMode });
    if (Buffer.isBuffer(body)) {
      await writeFile(target, body);
      return;
    }
    await new Promise<void>((fulfill, reject) => {
      const out = createWriteStream(target);
      out.on('error', reject);
      out.on('close', fulfill);
      body.pipe(out);
      body.on('error', reject);
    });
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.pathFor(key));
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
