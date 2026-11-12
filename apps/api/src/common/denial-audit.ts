import { log } from '@carocrm/core/logger/index.js';

/**
 * Phase 23.4 (F3) — the denial-audit seam.
 *
 * `GlobalExceptionFilter` is constructed by hand (`new GlobalExceptionFilter()`), both in
 * `bootstrap.ts` and in the test harnesses, so it cannot inject `AuditSinkService` or open a
 * database connection of its own. It therefore emits a plain event through this module-level sink;
 * `bootstrap.ts` registers the sink after the application is initialised and the sink writes the
 * row outside the response path.
 *
 * A missing sink is not an error: a DB-free unit test boots the filter without a database, and an
 * audit write must never turn a 403 into a 500.
 */
export interface DenialAuditEvent {
  /** The entity named by the denial, when the error carried one. */
  readonly entityType: string | null;
  /** The record id named by the denial, when the error carried one. */
  readonly recordId: string | null;
  /** The attempted action (`read`, `edit`, `delete`, the capability key, …). */
  readonly action: string | null;
  /** The stable platform error code (`AUTHORIZATION_DENIED`). */
  readonly code: string;
  /** The denial sentence. Already a safe, fixed sentence; never a payload. */
  readonly reason: string;
  /** The request path with sensitive query parameters already redacted. */
  readonly path: string;
  readonly method: string;
}

export type DenialAuditSink = (event: DenialAuditEvent) => Promise<void> | void;

let sink: DenialAuditSink | undefined;

export function setDenialAuditSink(next: DenialAuditSink | undefined): void {
  sink = next;
}

/**
 * Emit one denial event without blocking the response.
 *
 * The write is deliberately fire-and-forget: the caller has already been refused, and a slow or
 * broken audit store must not change that answer. A failure is logged with the request id, never
 * rethrown.
 */
export function emitDenialAudit(event: DenialAuditEvent): void {
  const current = sink;
  if (current === undefined) return;
  try {
    const result = current(event);
    if (result !== undefined) {
      void result.catch((error: unknown) => {
        log.warn({ err: error, code: event.code, path: event.path }, 'denial audit write failed');
      });
    }
  } catch (error: unknown) {
    log.warn({ err: error, code: event.code, path: event.path }, 'denial audit write failed');
  }
}
