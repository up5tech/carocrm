/**
 * Attachment module barrel — integrator entry point.
 *
 * Wire into AppModule:
 *   controllers: [...ATTACHMENT_CONTROLLERS]
 *   providers:   [...ATTACHMENT_PROVIDERS]
 *
 * Needs CONFIG_TOKEN, DatabaseService and REQUEST_SCOPE_TOKEN from the host module, plus
 * `@fastify/multipart` on the Fastify instance (bootstrap.ts registers both).
 *
 * `FILE_STORAGE_TOKEN` is built from `STORAGE_DRIVER` (local | s3 | minio) and
 * `MALWARE_SCANNER_TOKEN` from `MALWARE_SCAN_MODE`; an extension can replace either with its own
 * implementation without touching this module.
 */
import { resolve } from 'node:path';

import type { FileStorage, MalwareScanner } from '@carocrm/files';
import { LocalFsStorage, NoopScanner, parseS3Settings,S3FileStorage, SignatureScanner } from '@carocrm/files';
import type { Provider, Type } from '@nestjs/common';

import type { AppConfig } from '../config.js';
import { CONFIG_TOKEN } from '../config.js';
import {
  FILE_STORAGE_TOKEN,
  MALWARE_SCANNER_TOKEN,
  PARENT_ACL_CHECK_TOKEN,
  PERMISSIVE_PARENT_ACL_CHECKER,
} from './attachment.constants.js';
import { AttachmentController } from './attachment.controller.js';
import { AttachmentService } from './attachment.service.js';
import { ChunkedUploadController } from './chunked-upload.controller.js';
import { ChunkedUploadService } from './chunked-upload.service.js';

export type { ParentAclChecker } from './attachment.constants.js';
export {
  ALLOWED_MIME_TYPES,
  BLOCKED_EXTENSIONS,
  FILE_STORAGE_TOKEN,
  isAllowedMimeType,
  isBlockedExtension,
  MALWARE_SCANNER_TOKEN,
  PARENT_ACL_CHECK_TOKEN,
  PERMISSIVE_PARENT_ACL_CHECKER,
  UPLOAD_EXPIRY_HOURS,
} from './attachment.constants.js';
export { AttachmentController } from './attachment.controller.js';
export { OversizedUploadError,StreamProbe } from './attachment.probe.js';
export type { AttachmentDownload, AttachmentDto, SignedDownload, StorageInfo, UploadAttachmentInput } from './attachment.service.js';
export { AttachmentService, buildStorageKey } from './attachment.service.js';
export { ChunkedUploadController } from './chunked-upload.controller.js';
export type { ChunkedUploadDto } from './chunked-upload.service.js';
export { ChunkedUploadService } from './chunked-upload.service.js';

/** Selects the configured driver; a misconfigured object store fails at boot, not on first upload. */
export function createFileStorage(config: AppConfig): FileStorage {
  if (config.storageDriver === 'local') {
    return new LocalFsStorage(resolve(config.storageRoot));
  }
  const settings = parseS3Settings({
    driver: config.storageDriver,
    bucket: config.s3Bucket,
    region: config.s3Region,
    endpoint: config.s3Endpoint,
    accessKeyId: config.s3AccessKeyId,
    secretAccessKey: config.s3SecretAccessKey,
    forcePathStyle: config.s3ForcePathStyle,
  });
  return new S3FileStorage(settings);
}

export function createMalwareScanner(config: AppConfig): MalwareScanner {
  return config.malwareScanMode === 'none' ? new NoopScanner() : new SignatureScanner();
}

export const ATTACHMENT_PROVIDERS: Provider[] = [
  {
    provide: FILE_STORAGE_TOKEN,
    inject: [CONFIG_TOKEN],
    useFactory: (config: AppConfig) => createFileStorage(config),
  },
  {
    provide: MALWARE_SCANNER_TOKEN,
    inject: [CONFIG_TOKEN],
    useFactory: (config: AppConfig) => createMalwareScanner(config),
  },
  { provide: PARENT_ACL_CHECK_TOKEN, useValue: PERMISSIVE_PARENT_ACL_CHECKER },
  AttachmentService,
  ChunkedUploadService,
];

export const ATTACHMENT_CONTROLLERS: Type<unknown>[] = [AttachmentController, ChunkedUploadController];
