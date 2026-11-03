import type { ReactNode } from 'react';

import type { AdminPanelTab } from '../api/types.js';
import { ErrorState } from '../components/ErrorState.js';
import { LoadingSkeleton } from '../components/LoadingSkeleton.js';
import { PermissionDenied } from '../components/PermissionDenied.js';
import { useAdminPanel } from '../state/admin.js';
import { t } from '../state/i18n.js';

/**
 * Phase 22 G63 — the administration route guard.
 *
 * The router used to gate on "is there a session" and "is this a portal user" only, so a signed-in
 * non-admin who typed `/admin/jobs` reached the page, which then rendered its own chrome and reported
 * the refusal inside it. §14 task 8 asks the route guard and the API authorization to *agree*; they
 * agreed on the outcome and disagreed on the moment.
 *
 * The rule is not invented here. `GET /AdminPanel` is the server's own answer to "which administration
 * entries may this caller open", filtered by each entry's level (`admin-panel.service.ts`), and it is
 * the same data the menu is built from — so the guard and the navigation cannot drift apart, and a new
 * admin page needs no second map to maintain.
 */

/** Whether the server offered this administration route to the caller. */
export function isAdministrationRouteAllowed(tabs: readonly AdminPanelTab[], route: string): boolean {
  return tabs.some((tab) => tab.route === route);
}

export interface RequireAdministrationProps {
  /** The route as the admin panel publishes it — the base path, without any `:param` suffix. */
  readonly route: string;
  readonly children: ReactNode;
}

export function RequireAdministration({ route, children }: RequireAdministrationProps) {
  const panel = useAdminPanel();

  if (panel.isPending) return <LoadingSkeleton rows={6} />;
  // A panel that could not be read cannot answer "may this caller be here", and guessing "yes" is the
  // unsafe answer. The retry is offered because this is a read the page needs before it can render.
  if (panel.isError) {
    return <ErrorState onRetry={() => void panel.refetch()} />;
  }

  const tabs = panel.data?.groups.flatMap((group) => [...group.tabs]) ?? [];
  if (!isAdministrationRouteAllowed(tabs, route)) {
    return <PermissionDenied hint={t('web.adminShell.noAccessHint')} />;
  }

  return <>{children}</>;
}
