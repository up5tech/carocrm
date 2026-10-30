import { InvalidQueryError } from "@carocrm/core/errors/index.js";

/**
 * The page contract the Sales read endpoints share.
 *
 * A page is `limit` rows long and starts either at an **offset** — a position in the result — or at
 * a **cursor** — the row the previous page ended on. The cursor is the one that survives movement:
 * an offset is a live window (G71), so a row written before the window shifts it and the reader
 * sees a row twice, or misses one; a cursor names the row itself, so a row written meanwhile joins
 * the list at its own place and the walk continues exactly where it stopped.
 *
 * The cursor is opaque to the caller: a base64url token, not a query a client may assemble.
 */

/**
 * Where a page ended: the sort key of its last row.
 *
 * `createdAt` is the row's physical timestamp — when it was written — in UTC with microsecond
 * precision. The precision is load-bearing: `now()` is the *transaction* clock, so the two halves of
 * a transfer are written in the same microsecond, and a cursor rounded to milliseconds would drop
 * one of them between two pages.
 */
export interface PageCursor {
  readonly createdAt: string;
  readonly id: string;
}

/** The only shape a cursor timestamp may have: `2026-10-30T09:00:00.123456Z`. */
const CURSOR_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/;

/** The token as it travels: base64url of `<timestamp>|<id>`. */
export function encodePageCursor(cursor: PageCursor): string {
  return Buffer.from(`${cursor.createdAt}|${cursor.id}`, "utf8").toString("base64url");
}

/**
 * Read a cursor back.
 *
 * A token this module did not issue is refused with a clear message rather than quietly treated as
 * "the first page": a client that mangles its cursor is told, not handed a page it believes it has
 * already read.
 */
export function decodePageCursor(value: string): PageCursor {
  const trimmed = value.trim();
  if (trimmed === "") {
    throw new InvalidQueryError("The page cursor is empty.", { parameter: "cursor" });
  }
  const decoded = Buffer.from(trimmed, "base64url").toString("utf8");
  const separator = decoded.indexOf("|");
  const createdAt = separator === -1 ? "" : decoded.slice(0, separator);
  const id = separator === -1 ? "" : decoded.slice(separator + 1);
  if (id === "" || !isRealTimestamp(createdAt)) {
    throw new InvalidQueryError("The page cursor is not a cursor this endpoint issued.", {
      parameter: "cursor",
    });
  }
  return { createdAt, id };
}

/**
 * Whether the timestamp is a moment that exists — not merely one that matches the shape.
 *
 * A shape check alone would let `2026-02-30T00:00:00.000000Z` through, and the database would
 * then refuse the cast — a 500 for a bad token. Comparing the parsed moment back to its own parts
 * rejects it here, where the answer is a 400.
 */
function isRealTimestamp(value: string): boolean {
  const match = CURSOR_TIMESTAMP.exec(value);
  if (match === null) return false;
  const year = Number(match[1] ?? "");
  const month = Number(match[2] ?? "");
  const day = Number(match[3] ?? "");
  const hour = Number(match[4] ?? "");
  const minute = Number(match[5] ?? "");
  const second = Number(match[6] ?? "");
  const millis = Number((match[7] ?? "").slice(0, 3));
  const parsed = new Date(
    Date.UTC(year, month - 1, day, hour, minute, second, millis),
  );
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day &&
    parsed.getUTCHours() === hour &&
    parsed.getUTCMinutes() === minute &&
    parsed.getUTCSeconds() === second
  );
}
