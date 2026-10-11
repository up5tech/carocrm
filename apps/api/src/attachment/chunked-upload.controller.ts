import { ValidationError } from '@carocrm/core/errors/index.js';
import type { MultipartFile, MultipartValue } from '@fastify/multipart';
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';

import type { AttachmentDto } from './attachment.service.js';
import type { ChunkedUploadDto } from './chunked-upload.service.js';
import { ChunkedUploadService } from './chunked-upload.service.js';

type MultipartPart = MultipartFile | MultipartValue | (MultipartFile | MultipartValue)[];

function fieldValue(value: MultipartPart | undefined): string | undefined {
  const single = Array.isArray(value) ? value[0] : value;
  if (!single || single.type !== 'field') return undefined;
  const raw = single.value;
  return typeof raw === 'string' ? raw : typeof raw === 'number' || typeof raw === 'boolean' ? String(raw) : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Chunked upload endpoints (PLAN §25), used for files too large for one request:
 *
 * ```text
 * POST /api/v1/AttachmentUpload/init          {name,mimeType,totalSize,chunkSize?,parentType?,parentId?,field?,role?}
 * POST /api/v1/AttachmentUpload/{id}/part     multipart field `file` + `index` (any order)
 * GET  /api/v1/AttachmentUpload/{id}          progress: received bytes, accepted chunk indexes
 * POST /api/v1/AttachmentUpload/{id}/complete assembles, scans and returns the attachment
 * POST /api/v1/AttachmentUpload/{id}/abort    deletes the part files
 * ```
 */
@ApiTags('attachments')
@Controller('api/v1/AttachmentUpload')
export class ChunkedUploadController {
  constructor(@Inject(ChunkedUploadService) private readonly uploads: ChunkedUploadService) {}

  @HttpCode(200)
  @Post('init')
  async init(@Body() body: unknown): Promise<ChunkedUploadDto> {
    const request = asObject(body);
    const name = text(request['name']);
    const mimeType = text(request['mimeType']);
    const totalSize = Number(request['totalSize']);
    if (name === undefined || mimeType === undefined) throw new ValidationError('"name" and "mimeType" are required.');
    const chunkSize = Number(request['chunkSize']);
    return this.uploads.init({
      name,
      mimeType,
      totalSize,
      ...(Number.isFinite(chunkSize) && chunkSize > 0 ? { chunkSize } : {}),
      ...(text(request['parentId']) !== undefined ? { parentId: String(request['parentId']) } : {}),
      ...(text(request['parentType']) !== undefined ? { parentType: String(request['parentType']) } : {}),
      ...(text(request['field']) !== undefined ? { field: String(request['field']) } : {}),
      ...(text(request['role']) !== undefined ? { role: String(request['role']) } : {}),
    });
  }

  @HttpCode(200)
  @Post(':id/part')
  async part(
    @Param('id') id: string,
    @Req() request: FastifyRequest,
    @Query('index') indexParam: string | undefined,
  ): Promise<ChunkedUploadDto> {
    const limit = await this.uploads.partByteLimit(id);
    const part = await request.file({ limits: { fileSize: limit } });
    if (!part || part.type !== 'file') throw new ValidationError('Multipart field "file" is required.');
    const raw = fieldValue(part.fields['index']) ?? indexParam;
    if (raw === undefined) throw new ValidationError('Multipart field "index" is required.');
    const index = Number(raw);
    if (!Number.isInteger(index) || index < 0) throw new ValidationError('"index" must be a non-negative integer.', { index: raw });
    return this.uploads.addPart(id, index, part.file, () => part.file.truncated === true);
  }

  @Get(':id')
  async status(@Param('id') id: string): Promise<ChunkedUploadDto> {
    return this.uploads.status(id);
  }

  /** Completing creates the `attachments` row, so it answers with 201 like a direct upload. */
  @Post(':id/complete')
  async complete(@Param('id') id: string): Promise<AttachmentDto> {
    return this.uploads.complete(id);
  }

  @HttpCode(200)
  @Post(':id/abort')
  async abort(@Param('id') id: string): Promise<ChunkedUploadDto> {
    return this.uploads.abort(id);
  }
}

function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationError('Request body must be a JSON object.');
  }
  return body as Record<string, unknown>;
}
