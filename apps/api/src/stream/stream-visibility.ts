/**
 * Phase 19-SD.6 — the shared conversation visibility model
 * (PLAN_Phase_19_ServiceDesk.md §5.4, §10.3).
 *
 * Every conversation entry and every attachment carries an *explicit* visibility classification, and
 * the rule that decides who may see it lives here — one pure function, imported by the Stream
 * service (entry filtering) and the Attachment service (download gating) — rather than being
 * re-derived from the UI, the author, or the item type. That is the whole point of §5.4: portal and
 * customer-facing paths must never guess.
 *
 *  - `public`   — permitted for the customer/requester and authorised portal users.
 *  - `internal` — staff-only; never returned to a portal principal or a customer-bound message.
 *  - `system`   — a generated audit/event entry; internal-only, rendered as a safe summary.
 *
 * The client may only ever *ask* for `public` or `internal`; `system` items are generated from
 * record changes. A portal principal may only create customer-visible (`public`) content.
 */

export const STREAM_VISIBILITIES = ['public', 'internal', 'system'] as const;
export type StreamVisibility = (typeof STREAM_VISIBILITIES)[number];

/** The values a request may name explicitly; `system` is generated, never sent by a client. */
export const CLIENT_STREAM_VISIBILITIES = ['public', 'internal'] as const;
export type ClientStreamVisibility = (typeof CLIENT_STREAM_VISIBILITIES)[number];

export function isStreamVisibility(value: unknown): value is StreamVisibility {
  return typeof value === 'string' && (STREAM_VISIBILITIES as readonly string[]).includes(value);
}

export function isClientStreamVisibility(value: unknown): value is ClientStreamVisibility {
  return typeof value === 'string' && (CLIENT_STREAM_VISIBILITIES as readonly string[]).includes(value);
}

/**
 * Reads a stored visibility value. An unexpected value falls back rather than being trusted: the
 * stream defaults to `internal` (hidden), the attachment caller chooses its own fallback.
 */
export function toStreamVisibility(value: unknown, fallback: StreamVisibility = 'internal'): StreamVisibility {
  return isStreamVisibility(value) ? value : fallback;
}

/** `internal` and `system` are the same to a customer: neither may cross the portal boundary. */
export function isInternalOnlyVisibility(value: StreamVisibility): boolean {
  return value !== 'public';
}

export interface VisibilityPrincipal {
  readonly userType: string;
}

/**
 * The one visibility decision. An internal principal (admin/regular/api/system) sees every entry;
 * a portal principal sees only customer-visible entries. Kept trivial on purpose so it can be unit-
 * tested and reused by the attachment gate.
 */
export function canViewStreamVisibility(visibility: StreamVisibility, principal: VisibilityPrincipal): boolean {
  return visibility === 'public' || principal.userType !== 'portal';
}
