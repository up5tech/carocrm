import { ValidationError } from '@carocrm/core/errors/index.js';
import type { MultipartFile, MultipartValue } from '@fastify/multipart';
import { Controller, Delete, Get, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { AttachmentDto, SignedDownload, StorageInfo } from './attachment.service.js';
import { AttachmentService } from './attachment.service.js';

type MultipartPart = MultipartFile | MultipartValue | (MultipartFile | MultipartValue)[];

function fieldValue(value: MultipartPart | undefined): string | undefined {
  const single = Array.isArray(value) ? value[0] : value;
  if (!single || single.type !== 'field') return undefined;
  const raw = single.value;
  if (typeof raw === 'string') return raw;
  return typeof raw === 'number' || typeof raw === 'boolean' ? String(raw) : undefined;
}

function queryValue(query: unknown, key: string): string | undefined {
  if (typeof query !== 'object' || query === null) return undefined;
  const entry = (query as Record<string, unknown>)[key];
  return typeof entry === 'string' && entry !== '' ? entry : undefined;
}

function escapeFilename(name: string): string {
  return name.replace(/["\\]/g, '_');
}

/**
 * Attachment API (PLAN §25). Uploads are streamed straight into the configured storage — the body is
 * never buffered in the API process — and downloads are streamed back after an access check.
 */
@ApiTags('attachments')
@Controller('api/v1/Attachment')
export class AttachmentController {
  constructor(@Inject(AttachmentService) private readonly attachments: AttachmentService) {}

  /** Storage capabilities for the UI: driver, signed-URL support and the size limit. */
  @Get('action/info')
  info(): StorageInfo {
    return this.attachments.info();
  }

  /**
   * Multipart upload. The file part must use field name `file`; `parentId`, `parentType`, `field`,
   * `role` and an optional declared `size` may arrive as multipart text fields (recommended: before
   * the file part) or as query-string parameters.
   */
  @Post('upload')
  async upload(@Req() request: FastifyRequest): Promise<AttachmentDto> {
    const part = await request.file({ limits: { fileSize: this.attachments.maxUploadBytes } });
    if (!part || part.type !== 'file') {
      throw new ValidationError('Multipart field "file" is required.');
    }
    if (part.fieldname !== 'file') {
      throw new ValidationError(`Multipart field must be named "file", got "${part.fieldname}".`);
    }
    const pick = (key: string): string | undefined => fieldValue(part.fields[key]) ?? queryValue(request.query, key);
    const declared = pick('size');
    const parentId = pick('parentId');
    const parentType = pick('parentType');
    const field = pick('field');
    const role = pick('role');

    return this.attachments.upload({
      filename: part.filename,
      mimeType: part.mimetype,
      body: part.file,
      isTruncated: () => part.file.truncated === true,
      ...(declared === undefined || Number.isNaN(Number(declared)) ? {} : { declaredSize: Number(declared) }),
      ...(parentId !== undefined ? { parentId } : {}),
      ...(parentType !== undefined ? { parentType } : {}),
      ...(field !== undefined ? { field } : {}),
      ...(role !== undefined ? { role } : {}),
    });
  }

  @Get(':id/file')
  async download(
    @Param('id') id: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<NodeJS.ReadableStream> {
    const { metadata, stream, size } = await this.attachments.download(id);
    reply.header('content-type', metadata.mimeType);
    reply.header('content-disposition', `attachment; filename="${escapeFilename(metadata.name)}"`);
    reply.header('content-length', String(size));
    reply.header('cache-control', 'private, no-store');
    reply.header('x-content-type-options', 'nosniff');
    if (metadata.checksum !== null) reply.header('x-checksum-sha256', metadata.checksum);
    return stream;
  }

  /** Pre-signed link for object storage; local storage keeps downloads authenticated. */
  @Get(':id/url')
  async url(@Param('id') id: string, @Query('expires') expires: string | undefined): Promise<SignedDownload> {
    const seconds = expires === undefined ? undefined : Number(expires);
    if (seconds !== undefined && (!Number.isFinite(seconds) || seconds <= 0)) {
      throw new ValidationError('"expires" must be a positive number of seconds.', { expires });
    }
    return this.attachments.signedUrl(id, seconds === undefined ? undefined : Math.trunc(seconds));
  }

  @Get(':id')
  async metadata(@Param('id') id: string): Promise<AttachmentDto> {
    return this.attachments.getById(id);
  }

  @Delete(':id')
  async remove(@Param('id') id: string): Promise<{ status: boolean; id: string }> {
    await this.attachments.remove(id);
    return { status: true, id };
  }
}
