/**
 * Attachment module constants and cross-module tokens.
 *
 * Contract with the integrator (docs/module-guide.md):
 * - `FILE_STORAGE_TOKEN`   → `FileStorage` from `@carocrm/files`.
 * - `PARENT_ACL_CHECK_TOKEN` → `ParentAclChecker`; a permissive default is
 *   registered by the barrel so the module compiles standalone. Replace it
 *   with a real ACL-aware checker once the entity/acl modules are wired.
 */
import type { RequestScope } from '../common/request-scope.js';

export const FILE_STORAGE_TOKEN = Symbol('FILE_STORAGE');
export const PARENT_ACL_CHECK_TOKEN = Symbol('PARENT_ACL_CHECK');

/** Maximum accepted upload size (25 MB). */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

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
 * Optional parent-read gate. The default provider always allows; the
 * integrator swaps in a checker that consults the entity ACL once the
 * entity module exposes read-permission checks.
 */
export interface ParentAclChecker {
  canReadParent(entityType: string, recordId: string, scope: RequestScope): Promise<boolean> | boolean;
}

export const PERMISSIVE_PARENT_ACL_CHECKER: ParentAclChecker = {
  canReadParent: () => true,
};
