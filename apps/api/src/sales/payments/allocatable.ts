import { compare, parseDecimal, zero } from "../money/decimal.js";
import type { SalesRecords, SalesRow } from "../sales-records.js";
import type { BalanceExecutor, SalesBalanceService } from "./balance.service.js";

/**
 * Reading the documents an allocation editor offers (§4.8, §4.9, §4.12).
 *
 * Three commands need the same read: a payment's invoices or bills, a credit note's invoices, and a
 * bill credit's bills. Two rules live here so the three cannot drift apart:
 *
 *  - the picker must be able to reach *every* eligible document, so it pages chronologically through
 *    `SalesRecords.findPage` instead of taking an arbitrary sample that depends on UUID order;
 *  - one balance lookup must not become four queries per row, so each scanned page is priced in a
 *    single `outstandingOfMany` call.
 *
 * Only documents with something still owed are returned: a list of fully settled documents would
 * invite an allocation that cannot succeed.
 */

/** Documents priced per balance batch. */
const SCAN_CHUNK = 200;

/**
 * Documents examined for one response before the read gives up and reports `hasMore`.
 *
 * A page can only be filled by documents that still owe money, so a run of settled documents must be
 * walked through. The ceiling keeps that walk bounded; reaching it reports `hasMore` rather than
 * pretending the list ended.
 */
const SCAN_CEILING = 5_000;

export const ALLOCATABLE_DEFAULT_LIMIT = 100;
export const ALLOCATABLE_MAX_LIMIT = 500;

export const DEFAULT_ALLOCATABLE_PAGE: AllocatablePage = { limit: ALLOCATABLE_DEFAULT_LIMIT, offset: 0 };

export interface AllocatablePage {
  readonly limit: number;
  readonly offset: number;
}

export interface AllocatableResult {
  readonly list: readonly Record<string, unknown>[];
  readonly hasMore: boolean;
  readonly limit: number;
  readonly offset: number;
}

export interface AllocatableSlice {
  readonly rows: readonly SalesRow[];
  readonly outstanding: ReadonlyMap<string, string>;
  readonly hasMore: boolean;
}

/** A query-string `limit`/`offset`, clamped to something a page can actually serve. */
export function parseAllocatablePage(
  limit?: string,
  offset?: string,
): AllocatablePage {
  return {
    limit: clampWhole(limit, ALLOCATABLE_DEFAULT_LIMIT, 1, ALLOCATABLE_MAX_LIMIT),
    offset: clampWhole(offset, 0, 0, Number.MAX_SAFE_INTEGER),
  };
}

function clampWhole(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

/**
 * Collect one page of issued documents that still owe money, newest first.
 *
 * `offset` counts *eligible* documents, not scanned ones, so paging through the picker never skips a
 * row that a previous page already showed. The look-ahead row is what answers `hasMore` without a
 * second pass.
 */
export async function collectAllocatable(
  records: SalesRecords,
  balances: SalesBalanceService,
  tx: BalanceExecutor,
  entity: "Invoice" | "Bill",
  filters: Readonly<Record<string, string>>,
  page: AllocatablePage,
): Promise<AllocatableSlice> {
  /** One row beyond the page proves there is another page. */
  const wanted = page.offset + page.limit + 1;
  const rows: SalesRow[] = [];
  const outstanding = new Map<string, string>();
  let skipped = 0;
  let scanned = 0;
  let ceiling = false;

  while (rows.length < wanted) {
    const chunk = await records.findPage(entity, filters, {
      limit: SCAN_CHUNK,
      offset: scanned,
    });
    if (chunk.length === 0) break;

    const balancesForChunk = await balances.outstandingOfMany(tx, chunk);
    for (const row of chunk) {
      const amount = balancesForChunk.get(row.id) ?? "0";
      const parsed = parseDecimal(amount);
      if (compare(parsed, zero(parsed.scale)) <= 0) continue;
      if (skipped < page.offset) {
        skipped += 1;
        continue;
      }
      rows.push(row);
      outstanding.set(row.id, amount);
      if (rows.length === wanted) break;
    }

    scanned += chunk.length;
    if (chunk.length < SCAN_CHUNK) break;
    if (scanned >= SCAN_CEILING) {
      ceiling = true;
      break;
    }
  }

  const hasMore = rows.length === wanted || ceiling;
  if (rows.length === wanted) {
    const extra = rows.pop();
    if (extra !== undefined) outstanding.delete(extra.id);
  }
  return { rows, outstanding, hasMore };
}
