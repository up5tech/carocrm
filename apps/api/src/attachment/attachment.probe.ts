import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';

/** Raised when a stream exceeds the configured ceiling; the caller deletes what was written. */
export class OversizedUploadError extends Error {
  readonly limitBytes: number;
  readonly seenBytes: number;

  constructor(limitBytes: number, seenBytes: number) {
    super(`Upload exceeded the ${String(limitBytes)} byte limit.`);
    this.name = 'OversizedUploadError';
    this.limitBytes = limitBytes;
    this.seenBytes = seenBytes;
  }
}

/**
 * Passes bytes through while capturing the head (for content sniffing), counting the total and
 * hashing the stream — so an upload is never buffered whole and an oversized one is stopped as soon
 * as the limit is crossed instead of after the file landed (PLAN §25 size limits).
 */
export class StreamProbe extends Transform {
  private readonly hash = createHash('sha256');
  private head: Buffer;
  private headFilled = false;
  private seen = 0;

  constructor(private readonly sniffBytes: number, private readonly maxBytes: number) {
    super();
    this.head = Buffer.alloc(0);
  }

  get size(): number {
    return this.seen;
  }

  /** A copy, so the caller cannot mutate what the scanner inspects. */
  get headBytes(): Buffer {
    return Buffer.from(this.head);
  }

  digest(): string {
    return this.hash.digest('hex');
  }

  _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    this.hash.update(buffer);
    this.seen += buffer.byteLength;
    if (this.seen > this.maxBytes) {
      callback(new OversizedUploadError(this.maxBytes, this.seen));
      return;
    }
    if (!this.headFilled) {
      this.head = Buffer.concat([this.head, buffer]).subarray(0, this.sniffBytes);
      if (this.head.byteLength >= this.sniffBytes) this.headFilled = true;
    }
    this.push(buffer);
    callback();
  }

  _flush(callback: (error?: Error | null) => void): void {
    this.head = Buffer.from(this.head);
    callback(null);
  }
}
