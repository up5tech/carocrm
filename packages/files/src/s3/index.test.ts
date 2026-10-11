import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { S3FileStorage, type S3Sender } from './index.js';

interface Sent {
  name: string;
  input: Record<string, unknown>;
}

class FakeS3 implements S3Sender {
  readonly sent: Sent[] = [];
  headFails = false;

  async send(command: object): Promise<unknown> {
    const name = (command as { constructor: { name: string } }).constructor.name;
    const input = (command as { input: Record<string, unknown> }).input;
    this.sent.push({ name, input });
    if (name === 'HeadObjectCommand' && this.headFails) throw new Error('NotFound');
    if (name === 'GetObjectCommand') {
      return { Body: { transformToByteArray: async () => new Uint8Array(Buffer.from('stored bytes')) } };
    }
    if (name === 'HeadObjectCommand') return { ContentLength: 12 };
    return {};
  }

  commands(): string[] {
    return this.sent.map((entry) => entry.name);
  }
}

function withFake(): { client: FakeS3; store: S3FileStorage } {
  const client = new FakeS3();
  const store = new S3FileStorage({ bucket: 'crm-files', region: 'us-east-1', client });
  return { client, store };
}

describe('S3FileStorage', () => {
  it('puts buffers as PutObject with the declared content type', async () => {
    const { client, store } = withFake();
    const ref = await store.put({ key: 'Account/1/photo.png', body: Buffer.from('abc'), contentType: 'image/png' });

    expect(ref).toEqual({ key: 'Account/1/photo.png', size: 3, driver: 's3' });
    expect(client.commands()).toContain('PutObjectCommand');
    expect(client.sent[0]?.input).toMatchObject({ Bucket: 'crm-files', Key: 'Account/1/photo.png', ContentType: 'image/png' });
  });

  it('reads, heads and deletes through the client', async () => {
    const { client, store } = withFake();
    expect((await store.get('a/b.txt')).toString()).toBe('stored bytes');
    expect(await store.exists('a/b.txt')).toBe(true);
    await store.delete('a/b.txt');
    expect(client.commands()).toEqual(['GetObjectCommand', 'HeadObjectCommand', 'DeleteObjectCommand']);

    client.headFails = true;
    expect(await store.exists('missing')).toBe(false);
  });

  it('rejects unsafe keys before touching the network', async () => {
    const { client, store } = withFake();
    await expect(store.get('../etc/passwd')).rejects.toThrow(/Invalid storage key/);
    await expect(store.put({ key: 'a\\b', body: Buffer.from('x') })).rejects.toThrow(/Invalid storage key/);
    expect(client.sent).toHaveLength(0);
  });

  it('requires a bucket', () => {
    expect(() => new S3FileStorage({ bucket: '  ' })).toThrow(/bucket/);
  });

  it('presigns a download for the configured expiry (S3 and MinIO)', async () => {
    const store = new S3FileStorage({
      bucket: 'crm-files',
      region: 'us-east-1',
      accessKeyId: 'AKIATESTTESTTEST',
      secretAccessKey: 'secret-secret',
    });
    const signed = await store.signDownloadUrl({ key: 'Account/1/doc.pdf', expiresInSeconds: 120, filename: 'weird "name".pdf' });

    const url = new URL(signed.url);
    // Default (virtual-host style) addressing puts the bucket in the hostname.
    expect(url.hostname).toContain('crm-files');
    expect(url.pathname).toBe('/Account/1/doc.pdf');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('120');
    expect(url.searchParams.get('X-Amz-Credential')).toContain('AKIATESTTESTTEST');
    expect(url.searchParams.has('X-Amz-Signature')).toBe(true);
    expect(url.searchParams.get('response-content-disposition')).toContain('attachment');
    expect(new Date(signed.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('presigns against a MinIO endpoint with path-style addressing', async () => {
    const store = new S3FileStorage({
      bucket: 'crm',
      region: 'us-east-1',
      endpoint: 'http://minio.internal:9000',
      forcePathStyle: true,
      accessKeyId: 'minio',
      secretAccessKey: 'minio-secret',
    });
    const signed = await store.signDownloadUrl({ key: 'Lead/2/note.txt', expiresInSeconds: 60 });
    const url = new URL(signed.url);
    expect(url.origin).toBe('http://minio.internal:9000');
    expect(url.pathname).toBe('/crm/Lead/2/note.txt');
  });

  it('refuses to sign with an injected test client', async () => {
    const { store } = withFake();
    await expect(store.signDownloadUrl({ key: 'a', expiresInSeconds: 60 })).rejects.toThrow(/test client/);
  });

  it('streams a body through lib-storage and resolves the size by head', async () => {
    const { client, store } = withFake();
    const ref = await store.put({ key: 'big.bin', body: Readable.from([Buffer.from('chunk')]) });
    expect(ref.size).toBe(12);
    expect(client.commands().some((name) => name === 'PutObjectCommand' || name.includes('CreateMultipartUpload'))).toBe(true);
  });
});
