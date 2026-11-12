import { log } from '@carocrm/core/logger/index.js';

/**
 * Phase 23.8 — one bounded vocabulary for security events.
 *
 * The platform has no metrics exporter (G77), so this module is deliberately two things at once:
 *
 *  1. a structured log line per event. The logger's hook attaches the request correlation id, so a
 *     denial, a failed sign-in or a rejected webhook can be joined to the request that caused it;
 *  2. an in-process counter exposed through the administrator operations snapshot. It is
 *     process-local and resets on restart — a diagnostic aid, not a durable metrics store.
 *
 * No caller may pass a payload. The only details accepted are short, allowlisted labels (provider
 * key and a fixed reason code), so a future caller cannot accidentally put a token, address or body
 * into a security log by adding an object field.
 */
export type SecurityEventName =
  | 'access.denied'
  | 'auth.login.failed'
  | 'auth.lockout'
  | 'auth.refresh.reuse'
  | 'csrf.rejected'
  | 'webhook.signature.rejected'
  | 'webhook.replay'
  | 'secret.rotated';

export type SecurityEventOutcome = 'denied' | 'failed' | 'detected' | 'rotated';

export interface SecurityEventDetails {
  /** A provider module key, never a credential or URL. */
  readonly provider?: string | undefined;
  /** A fixed reason code; anything else is dropped rather than logged. */
  readonly reason?: string | undefined;
}

const LABEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const counters = new Map<string, number>();
let since = new Date();

function label(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return LABEL.test(value) ? value : undefined;
}

/**
 * Record one security event. Fire-and-forget by design: a diagnostic must never turn a refusal into
 * a 500 or a successful request into a failure.
 */
export function recordSecurityEvent(
  name: SecurityEventName,
  outcome: SecurityEventOutcome,
  details: SecurityEventDetails = {},
): void {
  const key = `${name}:${outcome}`;
  counters.set(key, (counters.get(key) ?? 0) + 1);
  try {
    const provider = label(details.provider);
    const reason = label(details.reason);
    log.warn(
      {
        securityEvent: name,
        outcome,
        ...(provider === undefined ? {} : { provider }),
        ...(reason === undefined ? {} : { reason }),
      },
      'security event',
    );
  } catch {
    // Logging is best effort; the counter above is still the local evidence.
  }
}

/** The in-process counters the operations snapshot shows. Contains labels and counts, never actors. */
export function securityEventSnapshot(): { readonly since: string; readonly events: Readonly<Record<string, number>> } {
  return {
    since: since.toISOString(),
    events: Object.fromEntries([...counters.entries()].sort(([a], [b]) => a.localeCompare(b))),
  };
}

/** Test seam only: a unit test must not inherit another test file's counts in the same process. */
export function resetSecurityEventCounters(): void {
  counters.clear();
  since = new Date();
}
