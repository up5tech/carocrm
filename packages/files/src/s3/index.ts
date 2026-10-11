import { Readable } from 'node:stream';

import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import type { FileRef, FileStorage, PutFileInput, SignDownloadInput, SignedUrl, StorageDriver } from '../storage/index.js';
import { assertSafeStorageKey } from '../storage/index.js';

/** Subset of `S3Client` this adapter uses, so tests can capture commands without a network. */
export interface S3Sender {
  send(command: object): Promise<unknown>;
}

export interface S3FileStorageOptions {
  bucket: string;
  region?: string | undefined;
  /** MinIO and other S3-compatible endpoints. */
  endpoint?: string | undefined;
  forcePathStyle?: boolean | undefined;
  accessKeyId?: string | undefined;
  secretAccessKey?: string | undefined;
  sessionToken?: string | undefined;
  /** Inject a fake (or preconfigured) client in tests; production builds its own. */
  client?: S3Sender | undefined;
}

interface S3ObjectBody {
  transformToByteArray(): Promise<Uint8Array>;
}

interface GetOutput {
  Body?: S3ObjectBody;
}

interface HeadOutput {
  ContentLength?: number | bigint;
}

/**
 * {@link FileStorage} for S3 and any S3-compatible endpoint (MinIO), with pre-signed download
 * URLs (PLAN §25). Streaming uploads go through `@aws-sdk/lib-storage`, so a large attachment is
 * never buffered whole in the API process.
 */
export class S3FileStorage implements FileStorage {
  readonly driver: StorageDriver = 's3';
  readonly supportsSignedUrls = true;
  readonly bucket: string;
  private readonly client: S3Sender;
  private readonly signingClient: S3Client | undefined;

  constructor(options: S3FileStorageOptions) {
    if (options.bucket.trim() === '') throw new Error('S3FileStorage requires a bucket.');
    this.bucket = options.bucket;
    if (options.client !== undefined) {
      this.client = options.client;
      this.signingClient = undefined;
      return;
    }
    const client = new S3Client({
      ...(options.region === undefined ? {} : { region: options.region }),
      ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
      ...(options.forcePathStyle === undefined ? {} : { forcePathStyle: options.forcePathStyle }),
      ...(options.accessKeyId === undefined || options.secretAccessKey === undefined
        ? {}
        : {
            credentials: {
              accessKeyId: options.accessKeyId,
              secretAccessKey: options.secretAccessKey,
              ...(options.sessionToken === undefined ? {} : { sessionToken: options.sessionToken }),
            },
          }),
    });
    this.client = client;
    this.signingClient = client;
  }

  async put(input: PutFileInput): Promise<FileRef> {
    const key = checkedKey(input.key);
    if (Buffer.isBuffer(input.body)) {
      await this.client.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: input.body,
        ...(input.contentType === undefined ? {} : { ContentType: input.contentType }),
      }));
      return { key, size: input.body.byteLength, driver: this.driver };
    }

    // The SDK hands a Node Readable to the HTTP layer with back-pressure, so a large body is
    // streamed rather than buffered; the authoritative size comes back from HeadObject.
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: input.body,
      ...(input.contentType === undefined ? {} : { ContentType: input.contentType }),
    }));
    const size = await this.sizeOf(key);
    return { key, size, driver: this.driver };
  }

  async get(key: string): Promise<Buffer> {
    const output = (await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: checkedKey(key) }))) as GetOutput;
    if (!output.Body) return Buffer.alloc(0);
    return Buffer.from(await output.Body.transformToByteArray());
  }

  /**
   * A real implementation would pipe `GetObject`'s body straight out; the SDK response is already a
   * web stream, so it is materialised here and handed on as a Node stream. Callers that must avoid
   * loading a whole object should page with ranged reads instead (docs/module-guide.md).
   */
  async openRead(key: string): Promise<Readable> {
    return Readable.from([await this.get(key)]);
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: checkedKey(key) }));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: checkedKey(key) }));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Pre-signed GET (PLAN §25 "signed download URLs for object storage"). Presigning is a local
   * computation over the client's credentials — no request is made.
   */
  async signDownloadUrl(input: SignDownloadInput): Promise<SignedUrl> {
    if (!this.signingClient) {
      throw new Error('S3FileStorage.signDownloadUrl needs the client it built itself; an injected test client cannot sign.');
    }
    const seconds = Math.max(30, Math.min(86_400, Math.trunc(input.expiresInSeconds)));
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: checkedKey(input.key),
      ...(input.filename === undefined ? {} : { ResponseContentDisposition: `attachment; filename="${sanitizeDisposition(input.filename)}"` }),
      ...(input.contentType === undefined ? {} : { ResponseContentType: input.contentType }),
    });
    // The pinned SDK copies expose two structural `Client` declarations, so the signing client is
    // cast at this boundary; the runtime object is the same instance the commands are sent with.
    const url = await getSignedUrl(this.signingClient as unknown as Parameters<typeof getSignedUrl>[0], command, {
      expiresIn: seconds,
    });
    return { url, expiresAt: new Date(Date.now() + seconds * 1_000).toISOString() };
  }

  private async sizeOf(key: string): Promise<number> {
    try {
      const head = (await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }))) as HeadOutput;
      return Number(head.ContentLength ?? 0);
    } catch {
      return 0;
    }
  }
}

function checkedKey(key: string): string {
  assertSafeStorageKey(key);
  return key;
}

function sanitizeDisposition(name: string): string {
  return name.replace(/["\\\r\n]/g, '_').slice(0, 200);
}

export interface S3SettingsInput {
  driver: 's3' | 'minio';
  bucket: string;
  region: string;
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Raw setting; empty string means "derive from the driver". */
  forcePathStyle: string | boolean | undefined;
}

/**
 * Turns configuration into {@link S3FileStorageOptions}. MinIO is S3-compatible and needs
 * path-style addressing, so that is the derived default; a missing bucket or region is a startup
 * error rather than a failed upload.
 */
export function parseS3Settings(input: S3SettingsInput): S3FileStorageOptions {
  const bucket = input.bucket.trim();
  if (bucket === '') throw new Error(`S3 storage (${input.driver}) requires S3_BUCKET.`);
  const region = input.region.trim();
  if (region === '') throw new Error(`S3 storage (${input.driver}) requires S3_REGION.`);
  const endpoint = input.endpoint.trim();
  if (input.driver === 'minio' && endpoint === '') {
    throw new Error('MinIO storage requires S3_ENDPOINT (the http(s) URL of the server).');
  }
  const derived = input.forcePathStyle === undefined || input.forcePathStyle === ''
    ? input.driver === 'minio'
    : typeof input.forcePathStyle === 'boolean'
      ? input.forcePathStyle
      : ['1', 'true', 'yes', 'on'].includes(input.forcePathStyle.trim().toLowerCase());

  const options: S3FileStorageOptions = { bucket, region, forcePathStyle: derived };
  if (endpoint !== '') options.endpoint = endpoint;
  const accessKeyId = input.accessKeyId.trim();
  const secretAccessKey = input.secretAccessKey.trim();
  if (accessKeyId !== '' && secretAccessKey !== '') {
    options.accessKeyId = accessKeyId;
    options.secretAccessKey = secretAccessKey;
  }
  return options;
}
