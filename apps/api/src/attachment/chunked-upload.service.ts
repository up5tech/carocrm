import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

import { AuthorizationDeniedError, FileTooLargeError, RecordNotFoundError, ValidationError } from '@carocrm/core/errors/index.js';
import type { FileStorage } from '@carocrm/files';
import { SNIFF_BYTES } from '@carocrm/files';
import { Inject, Injectable } from '@nestjs/common';
import type { Selectable } from 'kysely';

import type { RequestScope } from '../common/request-scope.js';
import { REQUEST_SCOPE_TOKEN } from '../common/request-scope.js';
import type { AppConfig } from '../config.js';
import { CONFIG_TOKEN } from '../config.js';
import type { FileUploadsTable } from '../database/database.service.js';
import { DatabaseService } from '../database/database.service.js';
import { FILE_STORAGE_TOKEN, UPLOAD_EXPIRY_HOURS } from './attachment.constants.js';
import { StreamProbe } from './attachment.probe.js';
import type { AttachmentDto } from './attachment.service.js';
import { AttachmentService } from './attachment.service.js';

export interface ChunkedUploadDto {
  id: string;
  name: string;
  mimeType: string;
  totalSize: number;
  received: number;
  partCount: number;
  parts: number[];
  status: string;
  chunkMaxSize: number;
  expiresAt: string;
  parentId: string | null;
  parentType: string | null;
}

interface PartInfo {
  size: number;
}

type UploadRow = Selectable<FileUploadsTable>;

/**
 * Chunked upload for large files (PLAN §25).
 *
 * A client reserves an upload, sends parts in any order, then completes: the parts are replayed in
 * index order as one stream through the normal attachment path (probe → size limit → malware scan →
 * `attachments` row), so a chunked upload is subject to exactly the same checks as a single request.
 * Nothing is buffered whole; an interrupted upload leaves only part files under `uploads/<id>/`,
 * which `system.cleanupUploads` removes after the expiry window.
 */
@Injectable()
export class ChunkedUploadService {
  readonly chunkMaxBytes: number;
  readonly maxUploadBytes: number;

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(FILE_STORAGE_TOKEN) private readonly storage: FileStorage,
    @Inject(AttachmentService) private readonly attachments: AttachmentService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
    @Inject(CONFIG_TOKEN) config: AppConfig,
  ) {
    this.chunkMaxBytes = config.uploadChunkMaxMb * 1024 * 1024;
    this.maxUploadBytes = config.uploadMaxMb * 1024 * 1024;
  }

  async init(input: {
    name: string;
    mimeType: string;
    totalSize: number;
    chunkSize?: number | undefined;
    parentId?: string | undefined;
    parentType?: string | undefined;
    field?: string | undefined;
    role?: string | undefined;
  }): Promise<ChunkedUploadDto> {
    const principal = this.scope.requirePrincipal();
    const name = this.attachments.validateName(input.name);
    const mimeType = this.attachments.normalizeMimeType(input.mimeType);
    const totalSize = Math.trunc(input.totalSize);
    if (!Number.isFinite(totalSize) || totalSize <= 0) throw new ValidationError('"totalSize" must be a positive number of bytes.');
    if (totalSize > this.maxUploadBytes) throw new FileTooLargeError(this.maxUploadBytes);

    const parentId = nonEmpty(input.parentId);
    const parentType = nonEmpty(input.parentType);
    if ((parentId === undefined) !== (parentType === undefined)) {
      throw new ValidationError('parentId and parentType must be provided together.');
    }
    if (parentId !== undefined && parentType !== undefined) {
      await this.attachments.assertParentReadable(parentType, parentId);
    }

    const id = randomUUID();
    const chunkSize = Math.max(1, Math.min(Math.trunc(input.chunkSize ?? this.chunkMaxBytes), this.chunkMaxBytes));
    await this.database.db
      .insertInto('file_uploads')
      .values({
        id,
        created_by_id: principal.userId,
        name,
        mime_type: mimeType,
        total_size: BigInt(totalSize),
        chunk_max_size: chunkSize,
        received: 0n,
        part_count: 0,
        parts: JSON.stringify({}),
        status: 'open',
        parent_type: parentType ?? null,
        parent_id: parentId ?? null,
        field: nonEmpty(input.field) ?? null,
        role: nonEmpty(input.role) ?? null,
        storage_prefix: `uploads/${id}`,
        expires_at: new Date(Date.now() + UPLOAD_EXPIRY_HOURS * 3_600_000),
        created_at: new Date(),
        modified_at: new Date(),
      })
      .execute();

    return toDto(await this.loadRow(id));
  }

  /**
   * Chunk ceiling of one upload. The controller hands it to the multipart parser as the transport
   * limit, so an oversized part is cut off by the parser instead of leaving the request half-read.
   */
  async partByteLimit(id: string): Promise<number> {
    return (await this.loadOwned(id)).chunk_max_size;
  }

  async addPart(
    id: string,
    index: number,
    body: Readable,
    isTruncated?: (() => boolean) | undefined,
  ): Promise<ChunkedUploadDto> {
    const row = await this.loadOwned(id);
    if (row.status !== 'open') throw new ValidationError(`Upload "${id}" is ${row.status}.`);
    const partIndex = Math.trunc(index);
    if (!Number.isInteger(partIndex) || partIndex < 0) {
      throw new ValidationError('"index" must be a non-negative integer.', { index });
    }
    if (partIndex > MAX_PARTS - 1) throw new ValidationError(`An upload accepts at most ${String(MAX_PARTS)} chunks.`, { index });

    const probe = new StreamProbe(SNIFF_BYTES, row.chunk_max_size);
    const key = partKey(row.storage_prefix, partIndex);
    body.once('error', (error: Error) => probe.destroy(error));
    body.pipe(probe);
    try {
      await this.storage.put({ key, body: probe, contentType: 'application/octet-stream' });
    } catch (error: unknown) {
      await this.storage.delete(key).catch(() => undefined);
      if (probe.size > row.chunk_max_size || nameOf(error) === 'OversizedUploadError') {
        throw new FileTooLargeError(row.chunk_max_size);
      }
      throw error;
    }
    if (isTruncated?.() === true || probe.size > row.chunk_max_size) {
      await this.storage.delete(key).catch(() => undefined);
      throw new FileTooLargeError(row.chunk_max_size);
    }
    if (probe.size === 0) {
      await this.storage.delete(key).catch(() => undefined);
      throw new ValidationError('Chunk data is empty.', { index: partIndex });
    }

    const parts = { ...partsOf(row) };
    const known = parts[partIndex] ?? null;
    parts[partIndex] = { size: probe.size };
    const received = Object.values(parts).reduce<number>((sum, part) => sum + part.size, 0);
    if (known === null && received > row.total_size) {
      await this.storage.delete(key).catch(() => undefined);
      throw new FileTooLargeError(Number(row.total_size));
    }

    await this.database.db
      .updateTable('file_uploads')
      .set({
        parts: JSON.stringify(parts),
        received: BigInt(received),
        part_count: Object.keys(parts).length,
        modified_at: new Date(),
      })
      .where('id', '=', row.id)
      .execute();

    return toDto(await this.loadRow(id));
  }

  async status(id: string): Promise<ChunkedUploadDto> {
    return toDto(await this.loadOwned(id));
  }

  async complete(id: string): Promise<AttachmentDto> {
    const row = await this.loadOwned(id);
    if (row.status === 'completed') throw new ValidationError(`Upload "${id}" was already completed.`);
    if (row.status !== 'open') throw new ValidationError(`Upload "${id}" is ${row.status}.`);

    const parts = partsOf(row);
    const indexes = Object.keys(parts).map(Number).sort((a, b) => a - b);
    if (indexes.length === 0) throw new ValidationError('No chunks were uploaded.');
    const missing = indexes.filter((value, position) => value !== position);
    if (missing.length > 0) {
      throw new ValidationError(`Chunk indexes must be contiguous from 0; missing ${missing.join(', ')}.`, { received: indexes });
    }
    if (Number(row.received) !== Number(row.total_size)) {
      throw new ValidationError(
        `Received ${String(row.received)} of ${row.total_size.toString()} reserved bytes; upload the remaining chunks.`,
        { received: Number(row.received), totalSize: Number(row.total_size) },
      );
    }

    const attachment = await this.attachments.upload({
      filename: row.name,
      mimeType: row.mime_type,
      body: this.partStream(row.storage_prefix, indexes),
      declaredSize: Number(row.total_size),
      ...(row.parent_type === null ? {} : { parentType: row.parent_type }),
      ...(row.parent_id === null ? {} : { parentId: row.parent_id }),
      ...(row.field === null ? {} : { field: row.field }),
      ...(row.role === null ? {} : { role: row.role }),
      parentChecked: true,
    });

    await this.removeParts(row.storage_prefix, indexes);
    await this.database.db
      .updateTable('file_uploads')
      .set({ status: 'completed', modified_at: new Date() })
      .where('id', '=', id)
      .execute();
    return attachment;
  }

  async abort(id: string): Promise<ChunkedUploadDto> {
    const row = await this.loadOwned(id);
    const indexes = Object.keys(partsOf(row)).map(Number).sort((a, b) => a - b);
    await this.removeParts(row.storage_prefix, indexes);
    await this.database.db
      .updateTable('file_uploads')
      .set({ status: 'aborted', modified_at: new Date() })
      .where('id', '=', id)
      .execute();
    return toDto(await this.loadRow(id));
  }

  private partStream(prefix: string, indexes: number[]): Readable {
    const storage = this.storage;
    const source = async function* read(): AsyncGenerator<Buffer> {
      for (const index of indexes) {
        const chunk = await storage.get(partKey(prefix, index));
        let offset = 0;
        while (offset < chunk.byteLength) {
          const next = Math.min(offset + 64 * 1024, chunk.byteLength);
          yield chunk.subarray(offset, next);
          offset = next;
        }
      }
    };
    return Readable.from(source());
  }

  private async removeParts(prefix: string, indexes: number[]): Promise<void> {
    for (const index of indexes) {
      await this.storage.delete(partKey(prefix, index)).catch(() => undefined);
    }
  }

  private async loadRow(id: string): Promise<UploadRow> {
    const row = await this.database.db.selectFrom('file_uploads').selectAll().where('id', '=', id).executeTakeFirst();
    if (!row) throw new RecordNotFoundError('FileUpload', id);
    return row;
  }

  private async loadOwned(id: string): Promise<UploadRow> {
    const row = await this.loadRow(id);
    const principal = this.scope.requirePrincipal();
    if (this.scope.isAdmin || (row.created_by_id !== null && row.created_by_id === principal.userId)) return row;
    throw new AuthorizationDeniedError('Only the uploader or an administrator may use this upload.', { id });
  }
}

const MAX_PARTS = 10_000;

function partKey(prefix: string, index: number): string {
  return `${prefix}/part-${String(index).padStart(6, '0')}`;
}

function parseParts(value: unknown): Record<string, PartInfo> {
  const raw = typeof value === 'string' ? safeParse(value) : value;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const result: Record<string, PartInfo> = {};
  for (const [key, entry] of Object.entries(raw as Record<string, unknown>)) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0) continue;
    const size = typeof entry === 'object' && entry !== null ? Number((entry as { size?: unknown }).size) : Number.NaN;
    if (!Number.isFinite(size) || size < 0) continue;
    result[String(index)] = { size };
  }
  return result;
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}

function partsOf(row: UploadRow): Record<string, PartInfo> {
  return parseParts(row.parts);
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

function nameOf(error: unknown): string {
  return error instanceof Error ? error.name : '';
}

function toDto(row: UploadRow): ChunkedUploadDto {
  const parts = partsOf(row);
  return {
    id: row.id,
    name: row.name,
    mimeType: row.mime_type,
    totalSize: Number(row.total_size),
    received: Number(row.received),
    partCount: row.part_count,
    parts: Object.keys(parts).map(Number).sort((a, b) => a - b),
    status: row.status,
    chunkMaxSize: row.chunk_max_size,
    expiresAt: row.expires_at.toISOString(),
    parentId: row.parent_id,
    parentType: row.parent_type,
  };
}
