import type { DashboardRow } from '../api/client.js';

/**
 * Which dashboard a user lands on (plans/PLAN_Phase_20_Settings_UX.md §5.6, §20.19).
 *
 * Both the Dashboards page and the home page need this answer, and they must never disagree, so
 * the priority lives here instead of in either page:
 *
 * 1. the dashboard the user starred (`defaultDashboard` preference),
 * 2. the first dashboard in the list the server returned.
 *
 * Phase 23.4 (G65): there is no client-side role rule any more. The server already returns only
 * the dashboards the caller may see, and it never returns a `roleScoped` field, so comparing
 * `principal.roles` here was dead code that claimed a server rule the client could not make.
 *
 * `source` is part of the answer because a page may treat the fallback differently: Dashboards keeps
 * the board the user already has open unless a stated default replaces it.
 */
export interface DefaultDashboardChoice {
  id: string;
  source: 'preferred' | 'first';
}

export function pickDefaultDashboard(
  dashboards: readonly DashboardRow[],
  preferredId: string | null | undefined,
): DefaultDashboardChoice | null {
  const first = dashboards[0];
  if (first === undefined) return null;

  if (preferredId !== null && preferredId !== undefined) {
    const starred = dashboards.find((dashboard) => dashboard.id === preferredId);
    // A starred dashboard that was deleted (or no longer visible) falls through to the next rule.
    if (starred) return { id: starred.id, source: 'preferred' };
  }

  return { id: first.id, source: 'first' };
}
