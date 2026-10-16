import { ValidationError } from "@carocrm/core/errors/index.js";

import {
  compare,
  type Decimal,
  format,
  parseDecimal,
  pow10,
  subtract,
} from "../money/decimal.js";

/** Whether a quantity counts whole physical units — what a serialised product moves. */
function isWholeUnits(value: Decimal): boolean {
  return value.units % pow10(value.scale) === 0n;
}

/** The whole-unit count of a quantity that is already known to be whole. */
function unitCount(value: Decimal): number {
  return Number(value.units / pow10(value.scale));
}

/**
 * Phase 19-S.15 — the pure half of stock identity and removal: which unit of a product a movement
 * consumes, and what a lot/serial line must look like before it may be recorded.
 *
 * `PLAN_Phase_19_Sales.md` §4.15 asks for FIFO/FEFO/LIFO "as configurable options … with
 * deterministic ordering" and §19-S.15 asks that "expired/invalid lots are not selected when the
 * configured policy forbids them". Both live here as functions of their arguments — no clock, no
 * database — so `apps/api/test/sales-picking.test.ts` can pin the exact ordering, the expiry gate
 * and every refusal without a running install.
 *
 * Identity rules this module owns:
 *
 *  - a **batch** is identified by its number within one product (§4.2 "stock must attach to the
 *    exact product/variant identity"); inbound movements must name the lot they add stock to,
 *    because there is nothing honest to pick *from* when goods arrive;
 *  - a **serial** is one unit; inbound movements must name the units they create, and a serial
 *    moves whole units only — a half unit of a serialised product is not a serial.
 */

// -----------------------------------------------------------------------------------------------
// Removal policy
// -----------------------------------------------------------------------------------------------

/** The configured picking/removal strategies (§4.15 "FIFO, FEFO, and LIFO removal policies"). */
export const REMOVAL_POLICIES = ["fifo", "fefo", "lifo"] as const;
export type RemovalPolicy = (typeof REMOVAL_POLICIES)[number];

/** One lot of one product in one warehouse, with everything the ordering needs. */
export interface BatchCandidate {
  readonly batchNumber: string;
  /** On-hand attributed to this lot — the pool an outbound movement may consume. */
  readonly onHand: string;
  /** `YYYY-MM-DD`, or null when the lot has no expiry. */
  readonly expiryDate?: string | null | undefined;
  /** ISO instant the lot was first received, or null when unknown. */
  readonly receivedAt?: string | null | undefined;
}

/** One serialised unit, with what the ordering needs. */
export interface SerialCandidate {
  readonly serialNumber: string;
  /** ISO instant the unit was first received, or null when unknown. */
  readonly receivedAt?: string | null | undefined;
}

export interface PickOptions {
  /** The day the selection is made (`YYYY-MM-DD`) — injected so tests pin the expiry gate. */
  readonly today: string;
  /** Whether an expired lot may be selected at all (settings `inventory.excludeExpiredStock`). */
  readonly excludeExpired: boolean;
}

/**
 * Whether a lot may not be picked because its expiry date has passed.
 *
 * A lot expiring *today* is still eligible: the expiry date is the last day the goods are good,
 * and silently refusing stock on its final day would strand it without an operator ever seeing why.
 */
export function isExpired(expiryDate: string | null | undefined, today: string): boolean {
  if (expiryDate === null || expiryDate === undefined || expiryDate === "") return false;
  return expiryDate < today;
}

/** Eligible candidates after the expiry gate; expired lots only survive when the policy allows them. */
function eligibleBatches(
  candidates: readonly BatchCandidate[],
  options: PickOptions,
): BatchCandidate[] {
  if (!options.excludeExpired) return [...candidates];
  return candidates.filter((candidate) => !isExpired(candidate.expiryDate, options.today));
}

/**
 * Order the candidates the configured policy consumes, deterministically.
 *
 * Every policy ends in the batch number (ascending for FIFO/FEFO, descending for LIFO), so two
 * warehouses holding the same picture always suggest the same units — a tie is never a coin toss.
 * A candidate missing its date sorts *last* under every policy: unknown age is not evidence of age.
 */
export function orderBatches(
  policy: RemovalPolicy,
  candidates: readonly BatchCandidate[],
  options: PickOptions,
): BatchCandidate[] {
  const pool = eligibleBatches(candidates, options);
  const dateOf = (candidate: BatchCandidate): string =>
    policy === "fefo"
      ? candidate.expiryDate ?? ""
      : candidate.receivedAt ?? "";
  return [...pool].sort((left, right) => {
    if (policy === "lifo") {
      const l = left.receivedAt ?? "";
      const r = right.receivedAt ?? "";
      if (l !== r) {
        // Unknown age last, newest first among the known.
        if (l === "") return 1;
        if (r === "") return -1;
        return l > r ? -1 : 1;
      }
      return right.batchNumber.localeCompare(left.batchNumber);
    }
    const l = dateOf(left);
    const r = dateOf(right);
    // FEFO without an expiry (or FIFO/LIFO without a date) falls back to the same rule: the
    // empty date is "no evidence", so it sorts last rather than first.
    if (l !== r) {
      if (l === "") return 1;
      if (r === "") return -1;
      return l < r ? -1 : 1;
    }
    return left.batchNumber.localeCompare(right.batchNumber);
  });
}

/** Order serialised units the policy consumes; serials carry no expiry, so FEFO is receipt order. */
export function orderSerials(
  policy: RemovalPolicy,
  candidates: readonly SerialCandidate[],
): SerialCandidate[] {
  return [...candidates].sort((left, right) => {
    const l = left.receivedAt ?? "";
    const r = right.receivedAt ?? "";
    if (l !== r) {
      if (l === "") return 1;
      if (r === "") return -1;
      const newestFirst = policy === "lifo";
      if (newestFirst) return l > r ? -1 : 1;
      return l < r ? -1 : 1;
    }
    return policy === "lifo"
      ? right.serialNumber.localeCompare(left.serialNumber)
      : left.serialNumber.localeCompare(right.serialNumber);
  });
}

/** One slice of a movement that a single lot supplies. Quantities are canonical decimals. */
export interface BatchAllocation {
  readonly batchNumber: string;
  readonly quantity: string;
}

export interface AllocationResult {
  readonly allocations: readonly BatchAllocation[];
  /** What the eligible candidates could not supply; `"0"` when the allocation is complete. */
  readonly shortage: string;
}

/**
 * Split `quantity` across batches in policy order, taking each lot's whole on-hand down as far as
 * it goes. The caller decides what a shortage *means* (a refusal for a document, an unattributed
 * remainder for a reviewed adjustment) — the allocation only reports it.
 */
export function allocateBatches(
  policy: RemovalPolicy,
  candidates: readonly BatchCandidate[],
  quantity: string,
  options: PickOptions,
): AllocationResult {
  let remaining = parseDecimal(quantity);
  const allocations: BatchAllocation[] = [];
  if (compare(remaining, parseDecimal("0")) <= 0) {
    throw new ValidationError("An allocation takes a positive quantity.", { quantity });
  }
  for (const candidate of orderBatches(policy, candidates, options)) {
    if (compare(remaining, parseDecimal("0")) <= 0) break;
    const held = parseDecimal(candidate.onHand);
    if (compare(held, parseDecimal("0")) <= 0) continue;
    const take = compare(held, remaining) <= 0 ? held : remaining;
    allocations.push({
      batchNumber: candidate.batchNumber,
      quantity: format(take, take.scale),
    });
    remaining = subtract(remaining, take);
  }
  return {
    allocations,
    shortage: format(remaining, remaining.scale),
  };
}

/**
 * Choose the serials a movement consumes, in policy order. The caller has already required a whole
 * unit count, so this either finds exactly that many units or reports the shortfall.
 */
export function allocateSerials(
  policy: RemovalPolicy,
  candidates: readonly SerialCandidate[],
  quantity: string,
): { readonly serialNumbers: readonly string[]; readonly shortage: string } {
  const units = parseDecimal(quantity);
  if (compare(units, parseDecimal("0")) <= 0) {
    throw new ValidationError("An allocation takes a positive quantity.", { quantity });
  }
  if (!isWholeUnits(units)) {
    throw new ValidationError(
      "A serialised product moves whole units: the quantity must be a whole number.",
      { quantity },
    );
  }
  const wanted = unitCount(units);
  const ordered = orderSerials(policy, candidates);
  const serialNumbers = ordered.slice(0, wanted).map((each) => each.serialNumber);
  const shortage = String(wanted - serialNumbers.length);
  return { serialNumbers, shortage };
}

// -----------------------------------------------------------------------------------------------
// Lot identity and dates
// -----------------------------------------------------------------------------------------------

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
/** A lot/serial number: trimmed, 1–64 characters, no control characters (identity, not a name). */
const IDENTITY_MAX = 64;

/**
 * Normalize a batch/serial number as stored: trimmed, upper-cased, bounded, control characters
 * refused. Case-insensitive uniqueness (migration 029) is made canonical here — "lot-1" and
 * "LOT-1" are one lot, so the stored key is always the same one.
 */
export function normalizeIdentity(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new ValidationError(`"${field}" must be a string.`, { field });
  }
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > IDENTITY_MAX) {
    throw new ValidationError(
      `"${field}" must be 1–${String(IDENTITY_MAX)} characters.`,
      { field, value: trimmed },
    );
  }
  // eslint-disable-next-line no-control-regex -- refusing control characters is the point
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new ValidationError(`"${field}" must not contain control characters.`, {
      field,
    });
  }
  return trimmed.toUpperCase();
}

/**
 * §4.15 expiry validation: both dates are optional, but a lot cannot be made before it expires.
 * A manufacturing date in the future is refused too — it is a recording error, not a forecast.
 */
export function validateLotDates(input: {
  readonly manufacturingDate?: string | null | undefined;
  readonly expiryDate?: string | null | undefined;
  readonly today?: string | undefined;
}): void {
  const manufacturing = emptyToNull(input.manufacturingDate);
  const expiry = emptyToNull(input.expiryDate);
  for (const [field, value] of [
    ["manufacturingDate", manufacturing],
    ["expiryDate", expiry],
  ] as const) {
    if (value !== null && !DATE_ONLY.test(value)) {
      throw new ValidationError(`"${field}" must be a YYYY-MM-DD date.`, {
        [field]: value,
      });
    }
  }
  if (manufacturing !== null && expiry !== null && manufacturing > expiry) {
    throw new ValidationError(
      '"manufacturingDate" must not be after "expiryDate".',
      { manufacturingDate: manufacturing, expiryDate: expiry },
    );
  }
  if (manufacturing !== null && input.today !== undefined && manufacturing > input.today) {
    throw new ValidationError(
      '"manufacturingDate" must not be in the future.',
      { manufacturingDate: manufacturing },
    );
  }
}

function emptyToNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

// -----------------------------------------------------------------------------------------------
// Serial lines
// -----------------------------------------------------------------------------------------------

/**
 * The serials a line names, normalized and de-duplicated *within the line*.
 *
 * Accepts the array the API sends or the JSON string a stored `serialNumbers` attribute holds, so
 * the same function reads a request and a stored item. A repeated serial in one line is a
 * double-count of one physical unit, so it is refused rather than quietly collapsed.
 */
export function parseSerialNumbers(value: unknown): string[] {
  let raw: unknown = value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return [];
    try {
      raw = JSON.parse(trimmed);
    } catch {
      throw new ValidationError(
        '"serialNumbers" must be an array of serial numbers.',
        { serialNumbers: value },
      );
    }
  }
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new ValidationError('"serialNumbers" must be an array of serial numbers.', {
      serialNumbers: value,
    });
  }
  const seen = new Set<string>();
  const serials: string[] = [];
  for (const entry of raw) {
    const serial = normalizeIdentity(entry, "serialNumber");
    const key = serial.toLowerCase();
    if (seen.has(key)) {
      throw new ValidationError(`Serial number "${serial}" appears twice on the same line.`, {
        serialNumber: serial,
      });
    }
    seen.add(key);
    serials.push(serial);
  }
  return serials;
}

/**
 * A serialised line moves exactly as many units as it names serials — the identity *is* the
 * quantity, so a mismatch would either invent stock or strand units that physically left.
 */
export function assertSerialCountMatch(
  quantity: string,
  serialNumbers: readonly string[],
): void {
  const units = parseDecimal(quantity);
  if (!isWholeUnits(units)) {
    throw new ValidationError(
      "A serialised product moves whole units: the quantity must be a whole number.",
      { quantity },
    );
  }
  if (unitCount(units) !== serialNumbers.length) {
    throw new ValidationError(
      `The line moves ${format(units, units.scale)} unit(s) but names ${String(serialNumbers.length)} serial number(s).`,
      { quantity, serials: serialNumbers.length },
    );
  }
}
