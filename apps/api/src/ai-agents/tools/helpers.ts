/**
 * Pure result-shaping helpers shared by the read and write tool handlers (19-AI.25 split).
 */

import { ValidationError } from '@carocrm/core/errors/index.js';

/** A record read is data, never a command; the marker travels with it into the prompt. */
export function boundRecord(record: Record<string, unknown>, requested: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const keys = requested.length > 0 ? requested : Object.keys(record).slice(0, 25);
  for (const key of keys) {
    const value = record[key];
    out[key] = typeof value === 'string' && value.length > 2_000 ? `${value.slice(0, 2_000)}…` : value;
  }
  out['untrusted'] = true;
  return out;
}

export function displayName(record: Record<string, unknown>): string {
  const name = record['name'];
  return typeof name === 'string' && name !== '' ? name : String(record['id'] ?? 'record');
}

/** The metric name an aggregate returns; one name, so the shape never depends on the operation. */
export const METRIC_NAME = 'value';

/** A `scope: "record"` activity list never asks SQL for more ids than this. */
export const MAX_LINKED_ACTIVITIES = 500;

/**
 * Normalise a caller-supplied date bound to an ISO instant.
 *
 * The Query Engine compares dates as instants, so a value it cannot parse would either compare
 * wrongly or fail deep in SQL with a driver message. Failing here names the argument instead.
 */
export function asInstant(value: string, field: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ValidationError(`"${field}" is not a date: ${value}. Use an ISO date such as 2026-10-01.`, { field });
  }
  return new Date(parsed).toISOString();
}

/** Metadata types that carry money; the aggregate also reports a formatted `display`. */
export function isMoneyType(type: string): boolean {
  return type === 'currency' || type === 'decimal';
}

/** `1234567.5` → `1,234,567.50`. Fixed decimals, no locale lookup, no currency symbol. */
export function formatAmount(value: number): string {
  const [whole = '0', fraction = ''] = Math.abs(value).toFixed(2).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${value < 0 ? '-' : ''}${grouped}.${fraction}`;
}

/** The detail fields a summary may include: bounded, and never internal bookkeeping columns. */
export function summaryFields(fields: Record<string, { readonly inDetail?: boolean | undefined }>): string[] {
  const skip = new Set(['createdById', 'modifiedById', 'deletedAt', 'teams', 'description']);
  const out = ['name', 'description'];
  for (const [name, definition] of Object.entries(fields)) {
    if (out.length >= 12) break;
    if (skip.has(name) || out.includes(name)) continue;
    if (definition.inDetail === true) out.push(name);
  }
  return out;
}
