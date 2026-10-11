/**
 * Attachment module barrel — integrator entry point.
 *
 * Wire into AppModule:
 *   controllers: [...ATTACHMENT_CONTROLLERS]
 *   providers:   [...ATTACHMENT_PROVIDERS]
 *
 * Requires CONFIG_TOKEN + DatabaseService + REQUEST_SCOPE_TOKEN to be
 * provided by the host module (AppModule already exports them). The
 * `@fastify/multipart` plugin must be registered on the underlying Fastify
 * instance (bootstrap.ts already does).
 *
 * Swap the default permissive PARENT_ACL_CHECK_TOKEN provider for a real
 * ACL-aware ParentAclChecker once the entity/ACL modules are available.
 */
import { resolve } from 'node:path';

import { LocalFsStorage } from '@carocrm/files';
import type { Provider, Type } from '@nestjs/common';

import type { AppConfig } from '../config.js';
import { CONFIG_TOKEN } from '../config.js';
import { FILE_STORAGE_TOKEN, PARENT_ACL_CHECK_TOKEN, PERMISSIVE_PARENT_ACL_CHECKER } from './attachment.constants.js';
import { AttachmentController } from './attachment.controller.js';
import { AttachmentService } from './attachment.service.js';

export type { ParentAclChecker } from './attachment.constants.js';
export {
  ALLOWED_MIME_TYPES,
  BLOCKED_EXTENSIONS,
  FILE_STORAGE_TOKEN,
  MAX_UPLOAD_BYTES,
  PARENT_ACL_CHECK_TOKEN,
  PERMISSIVE_PARENT_ACL_CHECKER,
} from './attachment.constants.js';
export { AttachmentController } from './attachment.controller.js';
export type { AttachmentDownload, AttachmentDto, UploadAttachmentInput } from './attachment.service.js';
export { AttachmentService, buildStorageKey } from './attachment.service.js';

export const ATTACHMENT_PROVIDERS: Provider[] = [
  {
    provide: FILE_STORAGE_TOKEN,
    inject: [CONFIG_TOKEN],
    useFactory: (config: AppConfig) => new LocalFsStorage(resolve(config.storageRoot)),
  },
  { provide: PARENT_ACL_CHECK_TOKEN, useValue: PERMISSIVE_PARENT_ACL_CHECKER },
  AttachmentService,
];

export const ATTACHMENT_CONTROLLERS: Type<unknown>[] = [AttachmentController];
