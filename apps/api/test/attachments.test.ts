import { createHash } from 'node:crypto';

import type { FileStorage } from '@carocrm/files';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AttachmentDto } from '../src/attachment/index.js';
import { ATTACHMENT_CONTROLLERS, ATTACHMENT_PROVIDERS, FILE_STORAGE_TOKEN } from '../src/attachment/index.js';
import type { ModuleTestContext } from './module-test-app.js';
import { authHeader, bootModuleTestApp, buildMultipart } from './module-test-app.js';

let ctx: ModuleTestContext;
let app: NestFastifyApplication;

const CONTENT = 'hello attachment world';
const SHA256_OF_CONTENT = createHash('sha256').update(CONTENT).digest('hex');

beforeAll(async () => {
  ctx = await bootModuleTestApp({ providers: ATTACHMENT_PROVIDERS, controllers: ATTACHMENT_CONTROLLERS });
  app = ctx.app;
});

afterAll(async () => {
  await app?.close();
});

function uploadHeaders(token: string, headers: Record<string, string>): Record<string, string> {
  return { ...authHeader(token), ...headers };
}

async function upload(
  token: string,
  opts: { filename: string; contentType: string; data: string; fields?: Record<string, string> },
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const textParts = Object.entries(opts.fields ?? {}).map(([name, data]) => ({ name, data }));
  const multipart = buildMultipart([
    ...textParts,
    { name: 'file', filename: opts.filename, contentType: opts.contentType, data: opts.data },
  ]);
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/Attachment/upload',
    headers: uploadHeaders(token, multipart.headers),
    payload: multipart.payload,
  });
  return { statusCode: res.statusCode, body: res.json() as Record<string, unknown> };
}

describe('attachment upload', () => {
  it('rejects unauthenticated uploads', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/Attachment/upload',
      ...(() => {
        const m = buildMultipart([{ name: 'file', filename: 'a.txt', contentType: 'text/plain', data: 'x' }]);
        return { payload: m.payload, headers: m.headers };
      })(),
    });
    expect(res.statusCode).toBe(401);
    expect((res.json() as { error: { code: string } }).error.code).toBe('AUTHENTICATION_REQUIRED');
  });

  it('uploads a text file and returns metadata with sha256 checksum', async () => {
    const res = await upload(ctx.adminToken, { filename: 'hello.txt', contentType: 'text/plain', data: CONTENT });
    expect(res.statusCode).toBe(201);
    const dto = res.body as unknown as AttachmentDto;
    expect(dto.name).toBe('hello.txt');
    expect(dto.mimeType).toBe('text/plain');
    expect(dto.size).toBe(CONTENT.length);
    expect(dto.checksum).toBe(SHA256_OF_CONTENT);
    expect(dto.createdById).toBe('adminUserId');
    expect(dto.parentId).toBeNull();
  });

  it('accepts parentId/parentType as multipart text fields', async () => {
    const res = await upload(ctx.adminToken, {
      filename: 'note.txt',
      contentType: 'text/plain',
      data: 'note body',
      fields: { parentId: 'parent-1', parentType: 'Account', field: 'description', role: 'note' },
    });
    expect(res.statusCode).toBe(201);
    const dto = res.body as unknown as AttachmentDto;
    expect(dto.parentId).toBe('parent-1');
    expect(dto.parentType).toBe('Account');
    expect(dto.field).toBe('description');
    expect(dto.role).toBe('note');
  });

  it('rejects blocked extensions (.exe, .js)', async () => {
    for (const filename of ['payload.exe', 'script.js']) {
      const res = await upload(ctx.adminToken, { filename, contentType: 'text/plain', data: 'whatever' });
      expect(res.statusCode).toBe(422);
      expect((res.body as { error?: { code?: string } }).error?.code).toBe('VALIDATION_FAILED');
    }
  });

  it('rejects disallowed MIME types', async () => {
    const res = await upload(ctx.adminToken, {
      filename: 'mystery.bin',
      contentType: 'application/octet-stream',
      data: 'bytes',
    });
    expect(res.statusCode).toBe(422);
    expect((res.body as { error?: { code?: string } }).error?.code).toBe('VALIDATION_FAILED');
  });

  it('rejects empty uploads', async () => {
    const res = await upload(ctx.adminToken, { filename: 'empty.txt', contentType: 'text/plain', data: '' });
    expect(res.statusCode).toBe(422);
  });
});

describe('attachment read + download', () => {
  it('fetches metadata and streams the file with content-type + content-disposition', async () => {
    const uploaded = await upload(ctx.adminToken, { filename: 'report.txt', contentType: 'text/plain', data: CONTENT });
    expect(uploaded.statusCode).toBe(201);
    const dto = uploaded.body as unknown as AttachmentDto;

    const meta = await app.inject({ method: 'GET', url: `/api/v1/Attachment/${dto.id}`, headers: authHeader(ctx.adminToken) });
    expect(meta.statusCode).toBe(200);
    expect(meta.json().checksum).toBe(SHA256_OF_CONTENT);

    const file = await app.inject({ method: 'GET', url: `/api/v1/Attachment/${dto.id}/file`, headers: authHeader(ctx.adminToken) });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toContain('text/plain');
    expect(String(file.headers['content-disposition'])).toContain('attachment; filename="report.txt"');
    expect(String(file.headers['x-checksum-sha256'])).toBe(SHA256_OF_CONTENT);
    expect(file.rawPayload.toString('utf8')).toBe(CONTENT);
    expect(createHash('sha256').update(file.rawPayload).digest('hex')).toBe(dto.checksum);
  });

  it('returns 404 for unknown attachment ids', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/Attachment/does-not-exist', headers: authHeader(ctx.adminToken) });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: { code: string } }).error.code).toBe('RECORD_NOT_FOUND');
  });
});

describe('attachment delete', () => {
  it('lets the creator delete and removes blob + row', async () => {
    const uploaded = await upload(ctx.regularToken, { filename: 'mine.txt', contentType: 'text/plain', data: 'mine' });
    expect(uploaded.statusCode).toBe(201);
    const dto = uploaded.body as unknown as AttachmentDto;

    const deleted = await app.inject({ method: 'DELETE', url: `/api/v1/Attachment/${dto.id}`, headers: authHeader(ctx.regularToken) });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ status: true, id: dto.id });

    const gone = await app.inject({ method: 'GET', url: `/api/v1/Attachment/${dto.id}`, headers: authHeader(ctx.adminToken) });
    expect(gone.statusCode).toBe(404);

    const storage = app.get(FILE_STORAGE_TOKEN) as FileStorage;
    expect(await storage.exists(`attachment/${dto.id}.txt`)).toBe(false);
  });

  it('lets an admin delete another user\'s attachment', async () => {
    const uploaded = await upload(ctx.regularToken, { filename: 'theirs.txt', contentType: 'text/plain', data: 'theirs' });
    const dto = uploaded.body as unknown as AttachmentDto;
    const deleted = await app.inject({ method: 'DELETE', url: `/api/v1/Attachment/${dto.id}`, headers: authHeader(ctx.adminToken) });
    expect(deleted.statusCode).toBe(200);
  });

  it('rejects delete by non-creator non-admin', async () => {
    const uploaded = await upload(ctx.adminToken, { filename: 'adminfile.txt', contentType: 'text/plain', data: 'admin' });
    const dto = uploaded.body as unknown as AttachmentDto;
    const denied = await app.inject({ method: 'DELETE', url: `/api/v1/Attachment/${dto.id}`, headers: authHeader(ctx.regularToken) });
    expect(denied.statusCode).toBe(403);
    expect((denied.json() as { error: { code: string } }).error.code).toBe('AUTHORIZATION_DENIED');

    // cleanup so the row does not linger
    const cleanup = await app.inject({ method: 'DELETE', url: `/api/v1/Attachment/${dto.id}`, headers: authHeader(ctx.adminToken) });
    expect(cleanup.statusCode).toBe(200);
  });
});
