import { Pool } from 'pg';

/**
 * Minimal database port used by the worker.
 *
 * `pg.Pool` satisfies it structurally, and tests can pass an in-memory fake, which keeps
 * every worker unit (outbox poller, job runner, scheduler) testable without a database.
 */
export type Row = Record<string, unknown>;

export interface QueryResultLike {
  rows: Row[];
  rowCount: number | null;
}

export interface Queryable {
  query(sql: string, params?: readonly unknown[]): Promise<QueryResultLike>;
}

export function createPool(connectionString: string, max = 5): Pool {
  return new Pool({ connectionString, max });
}

export function rowString(row: Row, key: string): string {
  const value = row[key];
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) {
    throw new Error(`Column "${key}" is missing from the row.`);
  }
  return String(value);
}

export function rowNumber(row: Row, key: string): number {
  const value = row[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new Error(`Column "${key}" is not a number (got ${JSON.stringify(value)}).`);
}

export function rowDate(row: Row, key: string): Date | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

export function rowRecord(row: Row, key: string): Record<string, unknown> {
  const value = row[key];
  if (value === null || value === undefined) return {};
  if (isRecord(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (isRecord(parsed)) return parsed;
    } catch {
      return {};
    }
  }
  return {};
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Coerces an arbitrary JSON value into a `Record<string, unknown>` job payload. */
export function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  return String(error);
}

export function truncate(value: string, max = 2000): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
