/**
 * Extension SDK errors (PLAN §38, §12.4).
 *
 * Every failure the loader, the resolver or the installer can produce carries a stable machine
 * code so the API can render an actionable message instead of an opaque exception. The class is
 * deliberately framework-free: the API maps it onto its own error envelope, the CLI maps it onto
 * `stderr`, and an extension author can throw it from a backend module.
 */

export type ExtensionErrorCode =
  | 'EXTENSION_MANIFEST_INVALID'
  | 'EXTENSION_NOT_FOUND'
  | 'EXTENSION_ALREADY_INSTALLED'
  | 'EXTENSION_NOT_INSTALLED'
  | 'EXTENSION_DEPENDENCY_MISSING'
  | 'EXTENSION_DEPENDENCY_CYCLE'
  | 'EXTENSION_VERSION_INCOMPATIBLE'
  | 'EXTENSION_BACKEND_INVALID'
  | 'EXTENSION_BACKEND_LOAD_FAILED'
  | 'EXTENSION_METADATA_INVALID'
  | 'EXTENSION_MIGRATION_FAILED'
  | 'EXTENSION_PATH_ESCAPE'
  | 'EXTENSION_DISABLED';

export class ExtensionError extends Error {
  readonly code: ExtensionErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: ExtensionErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ExtensionError';
    this.code = code;
    this.details = details;
  }

  toJSON(): { code: ExtensionErrorCode; message: string; details: Record<string, unknown> } {
    return { code: this.code, message: this.message, details: this.details };
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function extensionErrorDetails(error: unknown): Record<string, unknown> {
  if (error instanceof ExtensionError) return error.toJSON();
  return { message: errorMessage(error) };
}