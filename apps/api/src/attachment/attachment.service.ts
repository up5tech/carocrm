import { basename } from 'node:path';

import {
  AuthorizationDeniedError,
  FileTooLargeError,
  RecordNotFoundError,
  ValidationError,
} from '@carocrm/core/errors/index.js';
import { generateId } from '@carocrm/core/utils/id.js';
import type { FileStorage } from '@carocrm/files';
import { checksum } from '@carocrm/files';
import { Inject, Injectable } from '@nestjs/common';
import type { Selectable } from 'kysely';

import type { RequestScope } from '../common/request-scope.js';
import { REQUEST_SCOPE_TOKEN } from '../common/request-scope.js';
import type { AttachmentsTable } from '../database/database.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { ParentAclChecker } from './attachment.constants.js';
import {
  FILE_STORAGE_TOKEN,
  isAllowedMimeType,
  isBlockedExtension,
  MAX_UPLOAD_BYTES,
  PARENT_ACL_CHECK_TOKEN,
} from './attachment.constants.js';

export interface UploadAttachmentInput {
  filename: string;
  mimeType: string;
  data: Buffer;
  parentId?: string | undefined;
  parentType?: string | undefined;
  field?: string | undefined;
  role?: string | undefined;
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
  data: Buffer;
}

/** Row shape helper: optional-string fields under exactOptionalPropertyTypes. */
function optionalText(value: string | undefined): string | null {
  return value === undefined || value === '' ? null : value;
}

@Injectable()
export class AttachmentService {
  constructor(
    @Inject(FILE_STORAGE_TOKEN) private readonly storage: FileStorage,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(REQUEST_SCOPE_TOKEN) private readonly scope: RequestScope,
    @Inject(PARENT_ACL_CHECK_TOKEN) private readonly parentAcl: ParentAclChecker,
  ) {}

  async upload(input: UploadAttachmentInput): Promise<AttachmentDto> {
    const principal = this.scope.requirePrincipal();

    const safeName = basename((input.filename ?? '').replace(/\\/g, '/')).trim();
    if (safeName === '' || safeName === '.' || safeName === '..') {
      throw new ValidationError('A non-empty filename is required.');
    }
    if (isBlockedExtension(safeName)) {
      throw new ValidationError(`Files with that extension are not allowed: "${safeName}".`, {
        filename: safeName,
      });
    }
    if (!isAllowedMimeType(input.mimeType)) {
      throw new ValidationError(`MIME type "${input.mimeType}" is not allowed.`, {
        mimeType: input.mimeType,
      });
    }
    if (input.data.length === 0) {
      throw new ValidationError('Uploaded file is empty.');
    }
    if (input.data.length > MAX_UPLOAD_BYTES) {
      throw new FileTooLargeError(MAX_UPLOAD_BYTES);
    }

    const parentId = optionalText(input.parentId);
    const parentType = optionalText(input.parentType);
    if ((parentId === null) !== (parentType === null)) {
      throw new ValidationError('parentId and parentType must be provided together.');
    }
    if (parentId !== null && parentType !== null) {
      const allowed = await this.parentAcl.canReadParent(parentType, parentId, this.scope);
      if (!allowed) {
        throw new AuthorizationDeniedError('No read access to the attachment parent record.', {
          parentType,
          parentId,
        });
      }
    }

    const id = generateId();
    const storageKey = buildStorageKey(parentType, id, safeName);
    const digest = checksum(input.data);

    await this.storage.put(storageKey, input.data);

    const now = new Date();
    const row: Selectable<AttachmentsTable> = {
      id,
      name: safeName,
      type: 'Attachment',
      size: BigInt(input.data.length),
      mime_type: input.mimeType,
      storage_key: storageKey,
      checksum: digest,
      parent_id: parentId,
      parent_type: parentType,
      field: optionalText(input.field),
      role: optionalText(input.role),
      created_by_id: principal.userId,
      created_at: now,
    };
    await this.database.db
      .insertInto('attachments')
      .values(row)
      .execute();

    return toDto(row);
  }

  async getById(id: string): Promise<AttachmentDto> {
    return toDto(await this.loadRow(id));
  }

  async download(id: string): Promise<AttachmentDownload> {
    const row = await this.loadRow(id);
    const data = await this.storage.get(row.storage_key);
    return { metadata: toDto(row), data };
  }

  /** Delete a file + its row. Allowed for admins and the uploader only. */
  async remove(id: string): Promise<AttachmentDto> {
    const row = await this.loadRow(id);
    const principal = this.scope.requirePrincipal();
    const isCreator = row.created_by_id !== null && row.created_by_id === principal.userId;
    if (!this.scope.isAdmin && !isCreator) {
      throw new AuthorizationDeniedError('Only the uploader or an administrator may delete this attachment.', {
        id,
      });
    }
    await this.storage.delete(row.storage_key);
    await this.database.db.deleteFrom('attachments').where('id', '=', id).execute();
    return toDto(row);
  }

  private async loadRow(id: string) {
    const row = await this.database.db
      .selectFrom('attachments')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) {
      throw new RecordNotFoundError('Attachment', id);
    }
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
  return cleaned === '' || cleaned.includes('..') ? 'attachment' : cleaned;
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
