import { AuthenticationFailedError } from '@carocrm/core/errors/index.js';

import type { AuthService } from '../auth/auth.service.js';
import type { RequestScope } from './request-scope.js';

/**
 * Phase 23.4 (F1) — the user-scoped async principal.
 *
 * The reference implementation was `ReportService.scheduledDelivery`: a background run that belongs
 * to a person reloads that person from the database, refuses if the account is no longer active,
 * and executes under the **current** grant — not a snapshot taken when the job was enqueued,
 * and never a `sysAdmin` service identity.
 *
 * This helper is that rule in one place so a new background path cannot quietly copy the shape
 * and miss the active check. Jobs that are intentionally system-scoped (a scheduled SLA sweep, a
 * report delivery failure, a provider callback) must keep using their module authority and are
 * listed in `docs/quality/authorization-matrix.md` §3.
 */
export async function runAsUser<T>(
  auth: AuthService,
  scope: RequestScope,
  userId: string,
  requestId: string,
  work: () => Promise<T>,
): Promise<T> {
  // `principalFromUser` reloads roles and teams, and throws `AuthenticationFailedError` when the
  // user is inactive or deleted. That throw is the fail-closed half of F1: an account disabled
  // after the job was queued cannot keep acting through it.
  const principal = await auth.principalFromUser(userId);
  if (principal.userType === 'system') {
    throw new AuthenticationFailedError('A system principal cannot stand in for a user-scoped job.');
  }
  return scope.runAs(principal, work, requestId);
}
