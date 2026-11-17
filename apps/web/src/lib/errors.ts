import { ApiError } from '../api/client.js';

/**
 * One place that turns a caught value into the sentence a user should see.
 *
 * `ApiError` already carries the server's `code`, `message` and structured `details`; when the server
 * sent field-level `details.issues` (validation refusals, emitted either as strings or as
 * `{ path, message }` objects) they belong in the message, because the localized `message` alone is
 * often only a category ("Validation failed."). Every other `Error` keeps its own message, and
 * anything else falls back to the caller's text — the same contract the ad-hoc
 * `error instanceof Error ? error.message : fallback` ternaries encoded, minus the raw-message leaks
 * this helper exists to close (G64).
 */
export function errorMessage(error: unknown, fallback: string): string;
export function errorMessage(error: unknown, fallback?: undefined): string | undefined;
export function errorMessage(error: unknown, fallback?: string): string | undefined {
  if (error instanceof ApiError) {
    const issues = error.details?.['issues'];
    if (Array.isArray(issues)) {
      const parts = issues
        .map((issue) => {
          if (typeof issue === 'string') return issue;
          if (issue && typeof issue === 'object') {
            const record = issue as { path?: unknown; message?: unknown };
            return [record.path, record.message].filter((part) => typeof part === 'string' && part !== '').join(': ');
          }
          return '';
        })
        .filter((part) => part !== '');
      if (parts.length > 0) {
        const head = error.message !== '' ? error.message : (fallback ?? '');
        return `${head} (${parts.join(', ')})`;
      }
    }
    return error.message !== '' ? error.message : fallback;
  }
  if (error instanceof Error) return error.message !== '' ? error.message : fallback;
  return fallback;
}
