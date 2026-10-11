import { createHash } from 'node:crypto';

import type { FileStorage } from '@carocrm/files';
import { EICAR_SIGNATURE } from '@carocrm/files';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ATTACHMENT_CONTROLLERS, ATTACHMENT_PROVIDERS, FILE_STORAGE_TOKEN } from '../src/attachment/index.js';
import { DatabaseService } from '../src/database/database.service.js';
import type { ModuleTestContext } from './module-test-app.js';
import { authHeader, bootModuleTestApp, buildMultipart } from './module-test-app.js';

let ctx: ModuleTestContext;
let app: NestFastifyApplication;
const runId = `s${Date.now().toString(36)}`;
/** Reservations this run made, deleted again in afterAll (AGENTS.md §3.3: clean only own records). */
const reservedIds: string[] = [];

interface Reply {
  statusCode: number;
  body: Record<string, unknown>;
}

function bodyOf(res: { statusCode: number; json(): unknown }): Reply {
  return { statusCode: res.statusCode, body: res.json() as Record<string, unknown> };
}

function codeOf(reply: Reply): string {
  return String(((reply.body['error'] ?? {}) as { code?: string }).code ?? '');
}

function messageOf(reply: Reply): string {
  return String(((reply.body['error'] ?? {}) as { message?: string }).message ?? '');
}

async function upload(opts: {
  filename: string;
  contentType: string;
  data: string | Buffer;
  token?: string;
  fields?: Record<string, string>;
}): Promise<Reply> {
  const parts = Object.entries(opts.fields ?? {}).map(([name, data]) => ({ name, data }));
  const multipart = buildMultipart([
    ...parts,
    { name: 'file', filename: opts.filename, contentType: opts.contentType, data: opts.data },
  ]);
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/Attachment/upload',
    headers: { ...authHeader(opts.token ?? ctx.adminToken), ...multipart.headers },
    payload: multipart.payload,
  });
  return bodyOf(res);
}

async function json(
  method: 'GET' | 'POST',
  url: string,
  payload?: unknown,
  token?: string,
): Promise<Reply> {
  const res = await app.inject({
    method,
    url,
    headers: authHeader(token ?? ctx.adminToken),
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  const reply = bodyOf(res);
  // Track every reservation this suite made so afterAll can delete exactly its own rows.
  if (url === '/api/v1/AttachmentUpload/init' && typeof reply.body['id'] === 'string') reservedIds.push(reply.body['id']);
  return reply;
}

async function sendChunk(uploadId: string, index: number, data: string | Buffer, token?: string): Promise<Reply> {
  const multipart = buildMultipart([
    { name: 'index', data: String(index) },
    { name: 'file', filename: `part-${String(index)}.bin`, contentType: 'application/octet-stream', data },
  ]);
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/AttachmentUpload/${uploadId}/part`,
    headers: { ...authHeader(token ?? ctx.adminToken), ...multipart.headers },
    payload: multipart.payload,
  });
  return bodyOf(res);
}

beforeAll(async () => {
  // A small ceiling lets the suite send a genuinely oversized body; the limit comes from config, so
  // the assertions below read it back instead of hard-coding 2 MB.
  process.env.UPLOAD_MAX_MB = '2';
  ctx = await bootModuleTestApp({ providers: ATTACHMENT_PROVIDERS, controllers: ATTACHMENT_CONTROLLERS });
  app = ctx.app;
});

afterAll(async () => {
  // Remove the reservations this run created; an aborted/completed upload's parts are already gone,
  // but its row would otherwise pile up in the shared development database (AGENTS.md §3.3).
  if (app && reservedIds.length > 0) {
    await app
      .get(DatabaseService)
      .db.deleteFrom('file_uploads')
      .where('id', 'in', reservedIds)
      .execute();
  }
  await app?.close();
  delete process.env.UPLOAD_MAX_MB;
});

describe('storage info and limits (PLAN §25)', () => {
  it('reports the active driver and its capabilities', async () => {
    const info = await json('GET', '/api/v1/Attachment/action/info');
    expect(info.statusCode).toBe(200);
    expect(info.body['driver']).toBe('local');
    expect(info.body['supportsSignedUrls']).toBe(false);
    expect(info.body['scanProvider']).toBe('signature');
    expect(info.body['maxUploadBytes']).toBe(ctx.config.uploadMaxMb * 1024 * 1024);
  });

  it('refuses a pre-signed URL on a driver without a public read path', async () => {
    const uploaded = await upload({ filename: 'note.txt', contentType: 'text/plain', data: `signed ${runId}` });
    expect(uploaded.statusCode).toBe(201);

    const url = await json('GET', `/api/v1/Attachment/${String(uploaded.body['id'])}/url`);
    expect(url.statusCode).toBe(403);
    expect(codeOf(url)).toBe('FEATURE_DISABLED');

    const bad = await json('GET', `/api/v1/Attachment/${String(uploaded.body['id'])}/url?expires=0`);
    expect(bad.statusCode).toBe(422);
  });

  it('rejects an upload that declares more than the ceiling', async () => {
    const res = await upload({
      filename: 'big.txt',
      contentType: 'text/plain',
      data: 'small',
      fields: { size: String(ctx.config.uploadMaxMb * 1024 * 1024 + 1) },
    });
    expect(res.statusCode).toBe(413);
  });

  it('stops a stream that exceeds the ceiling even without a declared size', async () => {
    const max = ctx.config.uploadMaxMb * 1024 * 1024;
    const res = await upload({
      filename: 'stream.txt',
      contentType: 'text/plain',
      data: Buffer.alloc(max + 1024, 0x61),
    });
    expect(res.statusCode).toBe(413);
    expect(codeOf(res)).toBe('FILE_TOO_LARGE');

    // The rejected body must not leave a file behind: only the earlier uploads are still readable.
    const info = await json('GET', '/api/v1/Attachment/action/info');
    expect(info.body['maxUploadBytes']).toBe(max);
  });
});

describe('malware scanning hook (PLAN §25)', () => {
  it('rejects the EICAR test signature and stores nothing', async () => {
    const res = await upload({
      filename: 'invoice.txt',
      contentType: 'text/plain',
      data: `prefix ${EICAR_SIGNATURE} suffix`,
    });
    expect(res.statusCode).toBe(422);
    expect(messageOf(res)).toContain('malware scan');

    const listed = await json('GET', '/api/v1/Attachment/no-such-id');
    expect(listed.statusCode).toBe(404);
  });

  it('rejects an executable disguised as an image', async () => {
    const pe = Buffer.concat([Buffer.from([0x4d, 0x5a]), Buffer.alloc(64, 1)]);
    const res = await upload({ filename: 'photo.png', contentType: 'image/png', data: pe });
    expect(res.statusCode).toBe(422);
    expect(messageOf(res)).toContain('malware scan');
  });

  it('rejects content that is not really an image', async () => {
    const res = await upload({ filename: 'pic.jpg', contentType: 'image/jpeg', data: '<?php echo 1;' });
    expect(res.statusCode).toBe(422);
  });

  it('accepts a genuine PNG header', async () => {
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(48, 7),
    ]);
    const res = await upload({ filename: 'real.png', contentType: 'image/png', data: png });
    expect(res.statusCode).toBe(201);
    expect(res.body['size']).toBe(56);
    expect(res.body['checksum']).toBe(createHash('sha256').update(png).digest('hex'));
  });
});

describe('download access checks (PLAN §25)', () => {
  it('lets the uploader and an admin read it, and nobody else', async () => {
    const mine = await upload({ filename: `own-${runId}.txt`, contentType: 'text/plain', data: 'mine', token: ctx.regularToken });
    expect(mine.statusCode).toBe(201);
    const theirs = await upload({ filename: `theirs-${runId}.txt`, contentType: 'text/plain', data: 'theirs' });
    expect(theirs.statusCode).toBe(201);

    const ownDownload = await app.inject({
      method: 'GET',
      url: `/api/v1/Attachment/${String(mine.body['id'])}/file`,
      headers: authHeader(ctx.regularToken),
    });
    expect(ownDownload.statusCode).toBe(200);
    expect(ownDownload.headers['content-type']).toBe('text/plain');
    expect(ownDownload.headers['x-content-type-options']).toBe('nosniff');
    expect(ownDownload.headers['content-disposition']).toContain(`own-${runId}.txt`);

    const otherDownload = await app.inject({
      method: 'GET',
      url: `/api/v1/Attachment/${String(theirs.body['id'])}/file`,
      headers: authHeader(ctx.regularToken),
    });
    expect(otherDownload.statusCode).toBe(403);
    expect(codeOf({ statusCode: otherDownload.statusCode, body: otherDownload.json() as Record<string, unknown> })).toBe('AUTHORIZATION_DENIED');

    const adminSeesAll = await app.inject({
      method: 'GET',
      url: `/api/v1/Attachment/${String(theirs.body['id'])}/file`,
      headers: authHeader(ctx.adminToken),
    });
    expect(adminSeesAll.statusCode).toBe(200);
    expect(adminSeesAll.payload).toBe('theirs');
  });

  it('streams the exact stored bytes and checksum', async () => {
    const data = `streamed ${runId}`.repeat(400);
    const uploaded = await upload({ filename: 'stream.txt', contentType: 'text/plain', data });
    expect(uploaded.statusCode).toBe(201);
    expect(uploaded.body['checksum']).toBe(createHash('sha256').update(data).digest('hex'));

    const file = await app.inject({
      method: 'GET',
      url: `/api/v1/Attachment/${String(uploaded.body['id'])}/file`,
      headers: authHeader(ctx.adminToken),
    });
    expect(file.payload).toBe(data);
    expect(file.headers['content-length']).toBe(String(Buffer.byteLength(data)));
  });
});

describe('chunked upload (PLAN §25)', () => {
  const first = 'A'.repeat(300);
  const second = 'B'.repeat(300);
  const third = 'C'.repeat(200);

  it('reserves, accepts chunks out of order and assembles one attachment', async () => {
    const init = await json('POST', '/api/v1/AttachmentUpload/init', {
      name: 'chunked.txt',
      mimeType: 'text/plain',
      totalSize: first.length + second.length + third.length,
    });
    expect(init.statusCode).toBe(200);
    const uploadId = String(init.body['id']);
    expect(init.body['status']).toBe('open');
    expect(init.body['chunkMaxSize']).toBeGreaterThan(0);

    expect((await sendChunk(uploadId, 2, third)).statusCode).toBe(200);
    const afterSecond = await sendChunk(uploadId, 0, first);
    expect(afterSecond.body['partCount']).toBe(2);

    // Re-sending a chunk replaces it instead of double counting.
    const resend = await sendChunk(uploadId, 0, first);
    expect(resend.body['received']).toBe(first.length + third.length);

    expect((await sendChunk(uploadId, 1, second)).statusCode).toBe(200);
    const status = await json('GET', `/api/v1/AttachmentUpload/${uploadId}`);
    expect(status.body['parts']).toEqual([0, 1, 2]);

    const completed = await json('POST', `/api/v1/AttachmentUpload/${uploadId}/complete`);
    expect(completed.statusCode).toBe(201);
    const attachmentId = String(completed.body['id']);
    expect(completed.body['size']).toBe(first.length + second.length + third.length);
    expect(completed.body['checksum']).toBe(createHash('sha256').update(first + second + third).digest('hex'));

    const file = await app.inject({
      method: 'GET',
      url: `/api/v1/Attachment/${attachmentId}/file`,
      headers: authHeader(ctx.adminToken),
    });
    expect(file.payload).toBe(first + second + third);

    const storage = app.get<FileStorage>(FILE_STORAGE_TOKEN);
    expect(await storage.exists(`uploads/${uploadId}/part-000000`)).toBe(false);
    const after = await json('GET', `/api/v1/AttachmentUpload/${uploadId}`);
    expect(after.body['status']).toBe('completed');
  });

  it('refuses to complete with a gap or the wrong total', async () => {
    const init = await json('POST', '/api/v1/AttachmentUpload/init', { name: 'gaps.txt', mimeType: 'text/plain', totalSize: 600 });
    const uploadId = String(init.body['id']);
    await sendChunk(uploadId, 1, 'B'.repeat(300));
    const gap = await json('POST', `/api/v1/AttachmentUpload/${uploadId}/complete`);
    expect(gap.statusCode).toBe(422);
    expect(messageOf(gap)).toContain('contiguous');

    const filled = await sendChunk(uploadId, 0, 'A'.repeat(10));
    expect(filled.statusCode).toBe(200);
    const short = await json('POST', `/api/v1/AttachmentUpload/${uploadId}/complete`);
    expect(short.statusCode).toBe(422);
    expect(messageOf(short)).toContain('Received 310 of 600');

    await json('POST', `/api/v1/AttachmentUpload/${uploadId}/abort`);
  });

  it('enforces the chunk ceiling', async () => {
    const init = await json('POST', '/api/v1/AttachmentUpload/init', {
      name: 'caps.txt',
      mimeType: 'text/plain',
      totalSize: 1_000,
      chunkSize: 32,
    });
    const uploadId = String(init.body['id']);
    expect(init.body['chunkMaxSize']).toBe(32);

    const tooBig = await sendChunk(uploadId, 0, 'z'.repeat(40));
    expect(tooBig.statusCode).toBe(413);

    await json('POST', `/api/v1/AttachmentUpload/${uploadId}/abort`);
  });

  it('rejects an empty chunk', async () => {
    const init = await json('POST', '/api/v1/AttachmentUpload/init', {
      name: 'empty.txt',
      mimeType: 'text/plain',
      totalSize: 100,
      chunkSize: 32,
    });
    const uploadId = String(init.body['id']);

    const empty = await sendChunk(uploadId, 1, '');
    expect(empty.statusCode).toBe(422);

    await json('POST', `/api/v1/AttachmentUpload/${uploadId}/abort`);
  });

  it('rejects a negative chunk index', async () => {
    const init = await json('POST', '/api/v1/AttachmentUpload/init', {
      name: 'index.txt',
      mimeType: 'text/plain',
      totalSize: 100,
      chunkSize: 32,
    });
    const uploadId = String(init.body['id']);

    const negative = await sendChunk(uploadId, -1, 'x');
    expect([400, 422]).toContain(negative.statusCode);

    await json('POST', `/api/v1/AttachmentUpload/${uploadId}/abort`);
  });

  it('rejects bad reservations and keeps uploads private to their owner', async () => {
    const noSize = await json('POST', '/api/v1/AttachmentUpload/init', { name: 'x.txt', mimeType: 'text/plain', totalSize: 0 });
    expect(noSize.statusCode).toBe(422);

    const tooLarge = await json('POST', '/api/v1/AttachmentUpload/init', {
      name: 'x.txt',
      mimeType: 'text/plain',
      totalSize: ctx.config.uploadMaxMb * 1024 * 1024 + 1,
    });
    expect(tooLarge.statusCode).toBe(413);

    const badName = await json('POST', '/api/v1/AttachmentUpload/init', { name: 'evil.exe', mimeType: 'text/plain', totalSize: 10 });
    expect(badName.statusCode).toBe(422);

    const init = await json('POST', '/api/v1/AttachmentUpload/init', { name: 'private.txt', mimeType: 'text/plain', totalSize: 10 }, ctx.regularToken);
    expect(init.statusCode).toBe(200);
    const forbidden = await json('GET', `/api/v1/AttachmentUpload/${String(init.body['id'])}`, undefined, ctx.adminToken);
    expect(forbidden.statusCode).toBe(200);
    const missing = await json('GET', '/api/v1/AttachmentUpload/does-not-exist');
    expect(missing.statusCode).toBe(404);
  });

  it('aborts and deletes the parts that were uploaded', async () => {
    const init = await json('POST', '/api/v1/AttachmentUpload/init', { name: 'gone.txt', mimeType: 'text/plain', totalSize: 20 });
    const uploadId = String(init.body['id']);
    await sendChunk(uploadId, 0, 'part zero bytes');
    const storage = app.get<FileStorage>(FILE_STORAGE_TOKEN);
    expect(await storage.exists(`uploads/${uploadId}/part-000000`)).toBe(true);

    const aborted = await json('POST', `/api/v1/AttachmentUpload/${uploadId}/abort`);
    expect(aborted.body['status']).toBe('aborted');
    expect(await storage.exists(`uploads/${uploadId}/part-000000`)).toBe(false);

    const lateComplete = await json('POST', `/api/v1/AttachmentUpload/${uploadId}/complete`);
    expect(lateComplete.statusCode).toBe(422);
    expect(messageOf(lateComplete)).toContain('aborted');
  });
});
