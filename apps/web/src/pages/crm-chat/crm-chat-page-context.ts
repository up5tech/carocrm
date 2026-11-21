/**
 * Phase 25.9 — the page context of a chat turn.
 *
 * The client never describes a record. It carries the record's **identifiers** — the entity type
 * and the record id — and the server decides whether the answer may use it, under the caller's own
 * ACL. These two helpers are the whole client-side half of that rule: one parses a reference out of
 * the URL, the other names the reference type the composer and the API speak.
 */

/** The identifiers of the record the user was looking at. */
export interface CRMChatPageContextRef {
  readonly entity: string;
  readonly id: string;
}

/** The resolved state of a page context, as the server answered it. */
export interface CRMChatPageContextState {
  readonly entity: string;
  readonly id: string;
  /** The record's own name, as resolved by the server. `null` while it is unknown or withheld. */
  readonly label: string | null;
  /** `applied` — usable as context; `dropped` — the caller may not read it any more. */
  readonly status: 'applied' | 'dropped';
}

/**
 * The page context reference from a URL (`?ctx=Contact:<id>`).
 *
 * The shapes are the ones the server accepts: an entity name and a record id. Anything else is
 * ignored rather than guessed — a malformed reference is not a context, and the server decides
 * whether a well-formed one may be read.
 */
export function parsePageContextRef(value: string | null): CRMChatPageContextRef | undefined {
  if (value === null) return undefined;
  const separator = value.lastIndexOf(':');
  if (separator <= 0) return undefined;
  const entity = value.slice(0, separator);
  const id = value.slice(separator + 1);
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,119}$/.test(entity)) return undefined;
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(id)) return undefined;
  return { entity, id };
}

/** The reference as it travels in a URL. */
export function formatPageContextRef(ref: CRMChatPageContextRef): string {
  return `${ref.entity}:${ref.id}`;
}
