import { ApiError } from '../api/client.js';

/**
 * The per-field refusals a save came back with
 * (`PLAN_Phase_22_Integration_E2E_Hardening.md` §14 tasks 2 and 4).
 *
 * The API answers a rejected record with the refused field names in the error's `details` — the Entity
 * Engine writes `{ emailAddress: 'Value must be a valid email address.', reason: '…' }`, and a module
 * that validates its own document shape writes them under `details.errors`. Before this helper, the
 * shared edit page showed one toast with the first sentence and left every field looking accepted, so
 * the user re-submitted the same form. This turns the response into the field-level messages antd can
 * put under the inputs, and it keeps to the fields that actually exist on this form: an unexpected key
 * is a detail, not a field, and a stray error line under the wrong input is worse than none.
 */
const NON_FIELD_KEYS = new Set(['reason', 'field', 'code', 'details', 'message', 'retryAfterSeconds']);

export function serverFieldErrors(error: unknown, fieldNames: readonly string[]): Record<string, string> {
  if (!(error instanceof ApiError)) return {};
  // Only "the values you sent were refused" carries field truth: 400 and 422. A 5xx by construction says
  // nothing about this form, a 403/404 is not a typing problem, and a 409 (a record that changed
  // underneath the user, a duplicate name) is a decision to make, not a field to mark red.
  if (error.status !== 400 && error.status !== 422) return {};
  const details = error.details;
  if (details === undefined) return {};

  const candidates: Record<string, unknown>[] = [];
  const nested = details['errors'];
  if (nested !== null && typeof nested === 'object' && !Array.isArray(nested)) {
    candidates.push(nested as Record<string, unknown>);
  }
  candidates.push(details);

  const known = new Set(fieldNames);
  const found: Record<string, string> = {};
  for (const source of candidates) {
    for (const [key, value] of Object.entries(source)) {
      if (found[key] !== undefined) continue;
      if (NON_FIELD_KEYS.has(key) || !known.has(key)) continue;
      if (typeof value !== 'string' || value.trim() === '') continue;
      found[key] = value;
    }
  }
  return found;
}
