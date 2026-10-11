/**
 * Attachment module constants and cross-module tokens.
 *
 * Contract with the integrator (docs/module-guide.md):
 * - `FILE_STORAGE_TOKEN`     → `FileStorage` from `@carocrm/files` (local | s3 | minio).
 * - `MALWARE_SCANNER_TOKEN`  → `MalwareScanner`; runs every upload (PLAN §25 scanning hook).
 * - `PARENT_ACL_CHECK_TOKEN` → `ParentAclChecker`; gates uploads, downloads and metadata reads.
 */
import type { RequestScope } from '../common/request-scope.js';

export const FILE_STORAGE_TOKEN = Symbol('FILE_STORAGE');
export const PARENT_ACL_CHECK_TOKEN = Symbol('PARENT_ACL_CHECK');
export const MALWARE_SCANNER_TOKEN = Symbol('MALWARE_SCANNER');

/** Open chunked uploads older than this are abandoned by `system.cleanupUploads`. */
export const UPLOAD_EXPIRY_HOURS = 24;
/** Part files of an abandoned/expired upload are deleted this long after expiry. */
export const UPLOAD_GRACE_HOURS = 2;

/** Extensions that are always rejected, regardless of MIME type. */
export const BLOCKED_EXTENSIONS: readonly string[] = [
  '.exe',
  '.sh',
  '.bat',
  '.cmd',
  '.js',
  '.jar',
  '.msi',
  '.apk',
  '.dll',
  '.so',
];

/** MIME types allowed by exact match (prefix-based ones are handled separately). */
export const ALLOWED_MIME_TYPES: readonly string[] = [
  'application/pdf',
  'application/json',
  'application/zip',
  'application/x-zip-compressed',
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-word',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
];

/** MIME prefixes allowed (images, plain text incl. csv/html/log). */
export const ALLOWED_MIME_PREFIXES: readonly string[] = ['image/', 'text/'];

export function isBlockedExtension(filename: string): boolean {
  const lower = filename.toLowerCase();
  return BLOCKED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function isAllowedMimeType(mimeType: string): boolean {
  const lower = mimeType.toLowerCase();
  if (ALLOWED_MIME_PREFIXES.some((prefix) => lower.startsWith(prefix))) return true;
  return ALLOWED_MIME_TYPES.includes(lower);
}

/**
 * Parent-record gate for uploads, downloads and metadata reads. The default provider always
 * allows; the integrator registers an ACL-aware checker (see AppModule).
 */
export interface ParentAclChecker {
  canReadParent(entityType: string, recordId: string, scope: RequestScope): Promise<boolean> | boolean;
}

export const PERMISSIVE_PARENT_ACL_CHECKER: ParentAclChecker = {
  canReadParent: () => true,
};
