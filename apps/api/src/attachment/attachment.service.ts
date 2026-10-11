import { basename } from 'node:path';
import type { Readable } from 'node:stream';

import {
  AuthorizationDeniedError,
  FeatureDisabledError,
  FileTooLargeError,
  RecordNotFoundError,
  ValidationError,
} from '@carocrm/core/errors/index.js';
import { generateId } from '@carocrm/core/utils/id.js';
import {
  checksum,
  type FileStorage,
  type MalwareScanner,
  SNIFF_BYTES,
  type StorageBody,
} from '@carocrm/files';
import { Inject, Injectable } from '@nestjs/common';
import type { Selectable } from 'kysely';

import type { RequestScope } from '../common/request-scope.js';
import { REQUEST_SCOPE_TOKEN } from '../common/request-scope.js';
import type { AppConfig } from '../config.js';
import { CONFIG_TOKEN } from '../config.js';
import type { AttachmentsTable } from '../database/database.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { ParentAclChecker } from './attachment.constants.js';
import {
  FILE_STORAGE_TOKEN,
  isAllowedMimeType,
  isBlockedExtension,
  MALWARE_SCANNER_TOKEN,
  PARENT_ACL_CHECK_TOKEN,
} from './attachment.constants.js';
import { StreamProbe } from './attachment.probe.js';

export interface UploadAttachmentInput {
  filename: string;
  mimeType: string;
  /** A stream is preferred; a buffer is accepted for internal callers (chunked assembly). */
  body: StorageBody;
  declaredSize?: number | undefined;
  /**
   * Evaluated after the body is consumed: the transport stops a stream at its own ceiling instead of
   * letting it grow, so without this a cut-off file would look like a complete one of exactly the
   * maximum size.
   */
  isTruncated?: (() => boolean) | undefined;
  parentId?: string | undefined;
  parentType?: string | undefined;
  field?: string | undefined;
  role?: string | undefined;
  /** Chunked uploads validate the parent at init; completion must not re-require it. */
  parentChecked?: boolean | undefined;
  /** Set by the chunked path so an assembled file is not scanned twice. */
  scanned?: boolean | undefined;
}

export interface AttachmentDto {
  id: string;
  name: string;
  type: string;
  size: number;
  mimeType: string;
  checksum: string | null;
  parentId: string | null;
  parentType: string | null;
  field: string | null;
  role: string | null;
  createdById: string | null;
  createdAt: string;
}

export interface AttachmentDownload {
  metadata: AttachmentDto;
  stream: Readable;
  size: number;
}

export interface SignedDownload {
  url: string;
  expiresAt: string;
  driver: string;
}

export interface StorageInfo {
  driver: string;
  supportsSignedUrls: boolean;
  maxUploadBytes: number;
  scanProvider: string;
}

/**
 * Attachments (PLAN §25): uploads stream into the configured storage (never buffered whole), every
 * file is checked for name/MIME/extension/size and scanned through the malware hook before it is
 * visible, and reads enforce the parent record's ACL — including the download itself.
 */
@Injectable()
export class AttachmentService {
  readonly maxUploadBytes: number;
  readonly signedUrlTtlSeconds: number;

  constructor(
    @Inject(FILE_STORAGE_TOKEN) private readonly storage: FileStorage,
    @Inject(MALWARE_SCANNER_TOKEN) private readonly scanner: MalwareScanner,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
    @Inject(PARENT_ACL_CHECK_TOKEN) private readonly parentAcl: ParentAclChecker,
    @Inject(CONFIG_TOKEN) config: AppConfig,
  ) {
    this.maxUploadBytes = config.uploadMaxMb * 1024 * 1024;
    this.signedUrlTtlSeconds = config.signedUrlTtlSeconds;
  }

  info(): StorageInfo {
    return {
      driver: this.storage.driver,
      supportsSignedUrls: this.storage.supportsSignedUrls,
      maxUploadBytes: this.maxUploadBytes,
      scanProvider: this.scanner.name,
    };
  }

  async upload(input: UploadAttachmentInput): Promise<AttachmentDto> {
    const principal = this.scope.requirePrincipal();
    const safeName = this.validateName(input.filename);
    const mimeType = this.normalizeMimeType(input.mimeType);
    const declared = input.declaredSize ?? (Buffer.isBuffer(input.body) ? input.body.byteLength : undefined);
    if (declared !== undefined && declared > this.maxUploadBytes) throw new FileTooLargeError(this.maxUploadBytes);

    const parentId = optionalText(input.parentId);
    const parentType = optionalText(input.parentType);
    if ((parentId === null) !== (parentType === null)) {
      throw new ValidationError('parentId and parentType must be provided together.');
    }
    if (parentId !== null && parentType !== null && input.parentChecked !== true) {
      await this.assertParentReadable(parentType, parentId);
    }

    const id = generateId();
    const storageKey = buildStorageKey(parentType, id, safeName);
    const probe = new StreamProbe(SNIFF_BYTES, this.maxUploadBytes);
    const body = input.body;
    const putOptions = { contentType: mimeType, ...(declared === undefined ? {} : { sizeHint: declared }) };

    let size = 0;
    let digest = '';
    let head: Buffer = Buffer.alloc(0);
    try {
      if (Buffer.isBuffer(body)) {
        await this.storage.put({ key: storageKey, body, ...putOptions });
        size = body.byteLength;
        digest = checksum(body);
        head = Buffer.from(body.subarray(0, SNIFF_BYTES));
      } else {
        // Forward source failures into the probe so a broken upload never lands as a complete file.
        body.once('error', (error: Error) => probe.destroy(error));
        body.pipe(probe);
        await this.storage.put({ key: storageKey, body: probe, ...putOptions });
        size = probe.size;
        digest = probe.digest();
        head = probe.headBytes;
      }
    } catch (error: unknown) {
      await this.storage.delete(storageKey).catch(() => undefined);
      if (error instanceof FileTooLargeError) throw error;
      if (probe.size > this.maxUploadBytes || nameOf(error) === 'OversizedUploadError') {
        throw new FileTooLargeError(this.maxUploadBytes);
      }
      throw error;
    }

    if (size === 0) {
      await this.storage.delete(storageKey).catch(() => undefined);
      throw new ValidationError('Uploaded file is empty.');
    }
    if (size > this.maxUploadBytes || input.isTruncated?.() === true) {
      await this.storage.delete(storageKey).catch(() => undefined);
      throw new FileTooLargeError(this.maxUploadBytes);
    }

    if (input.scanned !== true) {
      await this.assertScannedClean({ key: storageKey, name: safeName, mimeType, head, size });
    }

    const now = new Date();
    const row: Selectable<AttachmentsTable> = {
      id,
      name: safeName,
      type: 'Attachment',
      size: BigInt(size),
      mime_type: mimeType,
      storage_key: storageKey,
      checksum: digest,
      parent_id: parentId,
      parent_type: parentType,
      field: optionalText(input.field),
      role: optionalText(input.role),
      created_by_id: principal.userId,
      created_at: now,
    };
    await this.database.db.insertInto('attachments').values(row).execute();
    return toDto(row);
  }

  async getById(id: string): Promise<AttachmentDto> {
    const row = await this.loadRow(id);
    await this.assertRowReadable(row);
    return toDto(row);
  }

  /** Streams the stored bytes to the caller after the access check (PLAN §25). */
  async download(id: string): Promise<AttachmentDownload> {
    const row = await this.loadRow(id);
    await this.assertRowReadable(row);
    const stream = await this.storage.openRead(row.storage_key);
    return { metadata: toDto(row), stream, size: Number(row.size) };
  }

  /** Pre-signed link, when the driver has a public read path (S3/MinIO). */
  async signedUrl(id: string, expiresInSeconds?: number): Promise<SignedDownload> {
    const row = await this.loadRow(id);
    await this.assertRowReadable(row);
    if (!this.storage.supportsSignedUrls || this.storage.signDownloadUrl === undefined) {
      throw new FeatureDisabledError(`${this.storage.driver}-signed-download-urls`);
    }
    const signed = await this.storage.signDownloadUrl({
      key: row.storage_key,
      expiresInSeconds: expiresInSeconds ?? this.signedUrlTtlSeconds,
      filename: row.name,
      contentType: row.mime_type,
    });
    return { url: signed.url, expiresAt: signed.expiresAt, driver: this.storage.driver };
  }

  /** Delete a file + its row. Allowed for admins and the uploader only. */
  async remove(id: string): Promise<AttachmentDto> {
    const row = await this.loadRow(id);
    const principal = this.scope.requirePrincipal();
    const isCreator = row.created_by_id !== null && row.created_by_id === principal.userId;
    if (!this.scope.isAdmin && !isCreator) {
      throw new AuthorizationDeniedError('Only the uploader or an administrator may delete this attachment.', { id });
    }
    await this.storage.delete(row.storage_key);
    await this.database.db.deleteFrom('attachments').where('id', '=', id).execute();
    return toDto(row);
  }

  /** Used by the chunked upload flow, which reserves its own storage key. */
  async assertParentReadable(parentType: string, parentId: string): Promise<void> {
    const allowed = await this.parentAcl.canReadParent(parentType, parentId, this.scope);
    if (!allowed) {
      throw new AuthorizationDeniedError('No read access to the attachment parent record.', { parentType, parentId });
    }
  }

  async assertScannedClean(input: { key: string; name: string; mimeType: string; head: Buffer; size: number }): Promise<void> {
    const result = await this.scanner.scan({ key: input.key, name: input.name, mimeType: input.mimeType, head: input.head, size: input.size });
    if (result.clean) return;
    await this.storage.delete(input.key).catch(() => undefined);
    throw new ValidationError('The file was rejected by the malware scan.', {
      provider: result.provider,
      reason: result.reason ?? 'unspecified',
    });
  }

  validateName(filename: string): string {
    const safeName = basename((filename ?? '').replace(/\\/g, '/')).trim();
    if (safeName === '' || safeName === '.' || safeName === '..') {
      throw new ValidationError('A non-empty filename is required.');
    }
    if (isBlockedExtension(safeName)) {
      throw new ValidationError(`Files with that extension are not allowed: "${safeName}".`, { filename: safeName });
    }
    return safeName;
  }

  normalizeMimeType(mimeType: string): string {
    const lower = (mimeType ?? '').toLowerCase().trim();
    if (!isAllowedMimeType(lower)) {
      throw new ValidationError(`MIME type "${mimeType}" is not allowed.`, { mimeType });
    }
    return lower;
  }

  private async assertRowReadable(row: Selectable<AttachmentsTable>): Promise<void> {
    if (this.scope.isAdmin) return;
    const principal = this.scope.requirePrincipal();
    if (row.created_by_id !== null && row.created_by_id === principal.userId) return;
    if (row.parent_type !== null && row.parent_id !== null) {
      const allowed = await this.parentAcl.canReadParent(row.parent_type, row.parent_id, this.scope);
      if (allowed) return;
    }
    throw new AuthorizationDeniedError('No access to this attachment.', { id: row.id });
  }

  private async loadRow(id: string): Promise<Selectable<AttachmentsTable>> {
    const row = await this.database.db
      .selectFrom('attachments')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw new RecordNotFoundError('Attachment', id);
    return row;
  }
}

/** `{parentType-or-attachment}/{id}[.ext]`, all segments storage-safe. */
export function buildStorageKey(parentType: string | null, id: string, filename: string): string {
  const scope = parentType === null ? 'attachment' : sanitizeSegment(parentType);
  const dot = filename.lastIndexOf('.');
  const ext = dot > 0 ? sanitizeSegment(filename.slice(dot + 1)).toLowerCase() : '';
  const suffix = ext === '' ? '' : `.${ext}`;
  return `${scope}/${id}${suffix}`;
}

function sanitizeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_.-]/g, '');
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? 'attachment' : cleaned;
}

function optionalText(value: string | undefined): string | null {
  return value === undefined || value === '' ? null : value;
}

function nameOf(error: unknown): string {
  return error instanceof Error ? error.name : '';
}

function toDto(row: Selectable<AttachmentsTable>): AttachmentDto {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    size: Number(row.size),
    mimeType: row.mime_type,
    checksum: row.checksum,
    parentId: row.parent_id,
    parentType: row.parent_type,
    field: row.field,
    role: row.role,
    createdById: row.created_by_id,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}
