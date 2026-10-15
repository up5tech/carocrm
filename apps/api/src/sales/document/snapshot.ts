import { createHash } from "node:crypto";

import { ValidationError } from "@carocrm/core/errors/index.js";

/**
 * Phase 19-S.2 — immutable commercial snapshots.
 *
 * An issued document must stay renderable and reproducible after the product catalog, price books,
 * tax rules, accounts, exchange rates or templates change (PLAN_Phase_19_Sales.md §5.8). The rule
 * this module implements is simple and testable: at issuance the document's commercial facts are
 * **copied by value** into a snapshot envelope, the envelope is frozen, and it carries a digest of
 * exactly the bytes that were captured. Rendering reads the envelope — never the live catalog.
 */

export interface DocumentSnapshot<T> {
  /** Envelope format version; a future format change must not silently reinterpret old rows. */
  readonly version: 1;
  /** Which document/entity the snapshot belongs to (`Invoice:inv_123`, `Quote:q_9`). */
  readonly source: string;
  /** ISO timestamp of capture. */
  readonly capturedAt: string;
  /** SHA-256 over {@link canonicalJson} of `data`, so any later edit is detectable. */
  readonly digest: string;
  readonly data: T;
}

/** Deterministic JSON: object keys sorted at every depth, no whitespace. Arrays keep their order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new ValidationError(
        "A snapshot cannot contain a non-finite number.",
      );
    return JSON.stringify(value);
  }
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  throw new ValidationError(
    `A snapshot cannot contain a ${typeof value} value.`,
  );
}

export function snapshotDigest(data: unknown): string {
  return createHash("sha256").update(canonicalJson(data)).digest("hex");
}

/**
 * Capture a snapshot of `data`. The returned structure is deep-frozen and deep-copied, so mutating
 * the source object afterwards cannot change what the snapshot says — that is the invariant the
 * tests pin down.
 */
export function buildDocumentSnapshot<T>(
  source: string,
  data: T,
  capturedAt: string = new Date().toISOString(),
): DocumentSnapshot<T> {
  if (source.trim() === "")
    throw new ValidationError("A document snapshot needs a source identifier.");
  const copy = deepClone(data) as T;
  deepFreeze(copy);
  return Object.freeze({
    version: 1 as const,
    source,
    capturedAt,
    digest: snapshotDigest(copy),
    data: copy,
  });
}

/** Read a snapshot, verifying its digest before handing the data to a renderer. */
export function readDocumentSnapshot<T>(envelope: DocumentSnapshot<T>): T {
  if (envelope.version !== 1) {
    throw new ValidationError(
      `Unsupported document snapshot version ${String(envelope.version)}.`,
      { source: envelope.source },
    );
  }
  const actual = snapshotDigest(envelope.data);
  if (actual !== envelope.digest) {
    throw new ValidationError(
      "This document snapshot has been modified since it was captured.",
      { source: envelope.source },
    );
  }
  return deepClone(envelope.data) as T;
}

/** Parse a stored snapshot (JSON text or already-decoded object) and verify it. */
export function parseDocumentSnapshot<T>(
  stored: string | DocumentSnapshot<T>,
): DocumentSnapshot<T> {
  const envelope =
    typeof stored === "string"
      ? (JSON.parse(stored) as DocumentSnapshot<T>)
      : stored;
  readDocumentSnapshot(envelope);
  return envelope;
}

function deepClone(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => deepClone(item));
  if (value instanceof Date) return new Date(value.getTime());
  const clone: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>))
    clone[key] = deepClone(item);
  return clone;
}

function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  if (Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const item of Object.values(value as Record<string, unknown>))
    deepFreeze(item);
}
