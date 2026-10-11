import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';

/** Anything callers may hand to {@link FileStorage.put}. */
export type StorageBody = Buffer | Readable;

export type StorageDriver = 'local' | 's3';

/** PLAN §25 `put(input)` — the key is chosen by the caller, the storage reports what it stored. */
export interface PutFileInput {
  key: string;
  body: StorageBody;
  contentType?: string | undefined;
  /** Lets a streaming implementation report progress/limits without a second stat. */
  sizeHint?: number | undefined;
}

export interface FileRef {
  key: string;
  size: number;
  driver: StorageDriver;
}

export interface SignedUrl {
  url: string;
  expiresAt: string;
}

export interface SignDownloadInput {
  key: string;
  expiresInSeconds: number;
  filename?: string | undefined;
  contentType?: string | undefined;
}

/**
 * Key/value blob storage behind `FILE_STORAGE_TOKEN`.
 *
 * Keys are POSIX-style relative paths whose segments are restricted to
 * {@link STORAGE_KEY_SEGMENT_PATTERN}; every implementation MUST reject traversal attempts
 * (`..`, absolute paths, stray separators). `get`/`openRead` are both required so a caller can
 * choose between a small buffer and a stream — large files must never be buffered in the API.
 */
export interface FileStorage {
  readonly driver: StorageDriver;
  /** False for storage without a public read path (local disk): downloads stay authenticated. */
  readonly supportsSignedUrls: boolean;
  put(input: PutFileInput): Promise<FileRef>;
  get(key: string): Promise<Buffer>;
  openRead(key: string): Promise<Readable>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  /** Only present when {@link supportsSignedUrls} is true (PLAN §25 signed download URLs). */
  signDownloadUrl?(input: SignDownloadInput): Promise<SignedUrl>;
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
    if (!STORAGE_KEY_SEGMENT_PATTERN.test(segment) || segment === '.' || segment === '..') {
      throw new Error(`Invalid storage key segment in "${key}"`);
    }
  }
  return segments;
}

/** True for any key the storage port would accept. */
export function isSafeStorageKey(key: string): boolean {
  try {
    assertSafeStorageKey(key);
    return true;
  } catch {
    return false;
  }
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

/** Streaming tee: hashes and counts a source stream without buffering it, for upload validation. */
export function createHashingCounter(): {
  transform: (chunk: Buffer) => void;
  readonly size: number;
  digest(): string;
} {
  const hash = createHash('sha256');
  let size = 0;
  return {
    transform(chunk: Buffer): void {
      hash.update(chunk);
      size += chunk.byteLength;
    },
    get size(): number {
      return size;
    },
    digest(): string {
      return hash.digest('hex');
    },
  };
}
