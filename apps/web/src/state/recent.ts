import { useEffect, useRef } from 'react';

import { usePreference } from './preferences.js';

/**
 * Recently visited routes (PLAN_Phase_20_Settings_UX.md §5.1, §5.2).
 *
 * The list is the `lastVisited` preference, so it is the account's — not this browser's. It used to
 * live in `localStorage`, which meant a second device forgot everything and a shared machine leaked
 * one person's browsing to the next. One route per screen: `/Account/42` is recorded as `/Account`.
 */
export const MAX_RECENT = 20;

/** Record the current route when it changes. Writes only when the head of the list differs. */
export function useRecordVisit(route: string): void {
  const preference = usePreference<string[]>('lastVisited');
  const routes = preference.value;
  // Guards the write loop: the save invalidates the query, which re-renders with the new head.
  const lastWritten = useRef<string | null>(null);

  useEffect(() => {
    if (routes === undefined) return;
    if (routes !== null && routes[0] === route) return;
    if (lastWritten.current === route) return;
    // A short settle keeps flipping through screens from writing (and refetching) on every click;
    // the visit that sticks is the page the user actually stayed on.
    const timer = window.setTimeout(() => {
      lastWritten.current = route;
      preference.save([route, ...(routes ?? []).filter((candidate) => candidate !== route)].slice(0, MAX_RECENT));
    }, 800);
    return () => window.clearTimeout(timer);
  }, [route, routes]);
}

/** The stored recent routes, newest first, with the route the user is on left out. */
export function useRecentRoutes(current: string): string[] {
  const preference = usePreference<string[]>('lastVisited');
  return (preference.value ?? []).filter((route) => route !== current).slice(0, MAX_RECENT);
}
