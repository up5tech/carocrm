import type { DashboardRow } from '../api/client.js';

/**
 * Which dashboard a user lands on (PLAN_Phase_20_Settings_UX.md §5.6, §20.19).
 *
 * Both the Dashboards page and the home page need this answer, and they must never disagree, so
 * the priority lives here instead of in either page:
 *
 * 1. the dashboard the user starred (`defaultDashboard` preference),
 * 2. the dashboard scoped to one of the user's roles (`roleScoped`),
 * 3. the first dashboard in the list the server returned.
 *
 * `source` is part of the answer because a page may treat the fallback differently: Dashboards keeps
 * the board the user already has open unless a stated default replaces it.
 */
export interface DefaultDashboardChoice {
  id: string;
  source: 'preferred' | 'role' | 'first';
}

export function pickDefaultDashboard(
  dashboards: readonly DashboardRow[],
  preferredId: string | null | undefined,
  roles: readonly string[],
): DefaultDashboardChoice | null {
  const first = dashboards[0];
  if (first === undefined) return null;

  if (preferredId !== null && preferredId !== undefined) {
    const starred = dashboards.find((dashboard) => dashboard.id === preferredId);
    // A starred dashboard that was deleted (or no longer visible) falls through to the next rule.
    if (starred) return { id: starred.id, source: 'preferred' };
  }

  const roleScoped = dashboards.find(
    (dashboard) => dashboard.roleScoped !== null && dashboard.roleScoped !== undefined && roles.includes(dashboard.roleScoped),
  );
  if (roleScoped) return { id: roleScoped.id, source: 'role' };

  return { id: first.id, source: 'first' };
}
