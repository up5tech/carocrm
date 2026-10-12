import { asRecord, isRecord } from '../shape.js';

/**
 * `{{field}}` interpolation for action parameters (PLAN §35).
 *
 * Two rules, and the difference matters:
 *
 *  - a value that is **exactly** one placeholder (`"{{field('emailAddress')}}"`) is replaced by the
 *    raw value, so an id stays an id and a number stays a number;
 *  - a placeholder **inside** a longer string is replaced by its text form, so
 *    `"Hello {{name}}"` reads naturally.
 *
 * Unknown paths resolve to an empty string rather than throwing: an automation that stops because a
 * contact has no phone number is worse than one that sends a shorter message. A missing *required*
 * field is a different matter and is caught by the action implementations.
 */

const PLACEHOLDER = /\{\{\s*([^}]+?)\s*\}\}/g;

export function interpolate(value: unknown, context: Record<string, unknown>): unknown {
  if (typeof value === 'string') return interpolateString(value, context);
  if (Array.isArray(value)) return value.map((entry) => interpolate(entry, context));
  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) result[key] = interpolate(entry, context);
    return result;
  }
  return value;
}

export function interpolateString(value: string, context: Record<string, unknown>): unknown {
  const exact = /^\{\{\s*([^}]+?)\s*\}\}$/.exec(value);
  if (exact?.[1] !== undefined) return resolvePath(exact[1], context);
  return value.replace(PLACEHOLDER, (_match, path: string) => stringify(resolvePath(path, context)));
}

/** Resolves a dotted path (`emailAddress`, `account.name`, `items.0`) against the context. */
export function resolvePath(path: string, context: Record<string, unknown>): unknown {
  const segments = path.split('.').map((segment) => segment.trim()).filter((segment) => segment !== '');
  let current: unknown = context;
  for (const segment of segments) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/** The formula record: record attributes plus the run's own identifiers. */
export function formulaContextOf(input: {
  readonly record: Record<string, unknown>;
  readonly entityType: string;
  readonly entityId: string;
  readonly userId?: string | undefined;
}): Record<string, unknown> {
  return { ...asRecord(input.record), id: input.entityId, entityType: input.entityType, entityId: input.entityId, userId: input.userId ?? null };
}